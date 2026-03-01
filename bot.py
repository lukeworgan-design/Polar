"""
Polar Running Coach Telegram Bot
Powered by Claude AI | Syncs with Polar AccessLink API
"""

import os
import json
import logging
import asyncio
from datetime import datetime, timedelta
from typing import Optional

import anthropic
import requests
from telegram import Update, Bot
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# ── Config ──────────────────────────────────────────────────────────────────

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
POLAR_CLIENT_ID = os.environ["POLAR_CLIENT_ID"]
POLAR_CLIENT_SECRET = os.environ["POLAR_CLIENT_SECRET"]
POLAR_ACCESS_TOKEN = os.environ.get("POLAR_ACCESS_TOKEN", "")  # Set after OAuth
YOUR_TELEGRAM_ID = int(os.environ["YOUR_TELEGRAM_ID"])

# Race goals — edit these!

ATHLETE_PROFILE = """
Athlete Profile:

- Events: London Marathon (target sub-3:30), Ultra marathons (50k+)
- Experience: 9 months structured training
- Uses Polar watch for all training data
- Key metrics: pace, HR zones, training load, recovery status
  """

SYSTEM_PROMPT = f"""You are an expert ultra and road marathon running coach with deep knowledge of:

- Polarised training methodology
- Heart rate zone training (Polar’s 5-zone system)
- Periodisation and training load management
- Race-specific preparation for marathons and ultras
- Recovery and injury prevention

{ATHLETE_PROFILE}

When given training data, provide:

1. Analysis of the session quality (pacing, HR zones, effort)
1. Recovery recommendation (easy day / rest / can train hard tomorrow)
1. How it fits the athlete’s current training block
1. One specific actionable tip for next session

Be direct, encouraging, and evidence-based. Use running coaching terminology naturally.
Keep responses conversational — this is a Telegram chat, not a report.
"""

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# ── Polar API ────────────────────────────────────────────────────────────────

POLAR_API_BASE = "https://www.polaraccesslink.com/v3"

def polar_headers():
return {
"Authorization": f"Bearer {POLAR_ACCESS_TOKEN}",
"Accept": "application/json",
"Content-Type": "application/json",
}

def create_transaction() -> Optional[str]:
"""Start a new exercise transaction to pull new workouts."""
r = requests.post(f"{POLAR_API_BASE}/users/transaction", headers=polar_headers())
if r.status_code == 201:
return r.json().get("transaction-id")
elif r.status_code == 204:
logger.info("No new exercises available")
return None
else:
logger.error(f"Transaction error: {r.status_code} {r.text}")
return None

def get_exercises(transaction_id: str) -> list:
"""Fetch all exercises in a transaction."""
r = requests.get(
f"{POLAR_API_BASE}/users/transaction/{transaction_id}/exercises",
headers=polar_headers()
)
if r.status_code == 200:
return r.json().get("exercises", [])
return []

def get_exercise_detail(transaction_id: str, exercise_id: str) -> dict:
"""Fetch full detail for one exercise including HR zones."""
r = requests.get(
f"{POLAR_API_BASE}/users/transaction/{transaction_id}/exercises/{exercise_id}",
headers=polar_headers()
)
return r.json() if r.status_code == 200 else {}

def commit_transaction(transaction_id: str):
"""Commit the transaction so data isn’t re-fetched."""
requests.put(
f"{POLAR_API_BASE}/users/transaction/{transaction_id}",
headers=polar_headers()
)

def get_daily_activity() -> dict:
"""Fetch today’s activity summary (steps, active time, recovery)."""
today = datetime.now().strftime("%Y-%m-%d")
r = requests.get(
f"{POLAR_API_BASE}/users/activity/date/{today}",
headers=polar_headers()
)
return r.json() if r.status_code == 200 else {}

def format_exercise_for_coach(exercise: dict) -> str:
"""Convert Polar exercise JSON into a readable coaching summary."""
sport = exercise.get("sport", "Unknown")
date = exercise.get("start-time", "")[:10]
duration_secs = exercise.get("duration", 0)
duration_min = duration_secs // 60
distance_m = exercise.get("distance", 0)
distance_km = distance_m / 1000 if distance_m else 0
calories = exercise.get("calories", 0)

```
# Pace
pace_str = "N/A"
if distance_km > 0 and duration_min > 0:
    pace_secs_per_km = (duration_secs / distance_km)
    pace_min = int(pace_secs_per_km // 60)
    pace_sec = int(pace_secs_per_km % 60)
    pace_str = f"{pace_min}:{pace_sec:02d}/km"

# Heart rate
hr = exercise.get("heart-rate", {})
avg_hr = hr.get("average", "N/A")
max_hr = hr.get("maximum", "N/A")

# HR zones
zones = exercise.get("heart-rate-zones", [])
zone_summary = ""
zone_names = ["Zone 1 (Recovery)", "Zone 2 (Aerobic)", "Zone 3 (Tempo)", 
              "Zone 4 (Threshold)", "Zone 5 (Max)"]
for i, zone in enumerate(zones):
    if i < len(zone_names):
        z_min = zone.get("in-zone", 0) // 60
        zone_summary += f"\n  {zone_names[i]}: {z_min} min"

# Training load
training_load = exercise.get("training-load", {})
load_score = training_load.get("cardio-load", "N/A")

# Ascent
ascent = exercise.get("ascent", "N/A")

return f"""
```

Session: {sport} | {date}
Duration: {duration_min} min
Distance: {distance_km:.2f} km
Avg Pace: {pace_str}
Avg HR: {avg_hr} bpm | Max HR: {max_hr} bpm
Calories: {calories} kcal
Elevation Gain: {ascent} m
Training Load: {load_score}

Heart Rate Zone Breakdown:{zone_summary if zone_summary else ’ Not available’}
""".strip()

# ── Claude AI ────────────────────────────────────────────────────────────────

# In-memory conversation history per user (persists for session)

conversation_history = {}

def get_coaching_analysis(exercise_summary: str, user_id: int) -> str:
"""Get Claude’s coaching analysis of a completed run."""
history = conversation_history.get(user_id, [])

```
message = f"I just completed a run. Here's the data:\n\n{exercise_summary}\n\nPlease analyse this session and give me your coaching feedback."
history.append({"role": "user", "content": message})

response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=800,
    system=SYSTEM_PROMPT,
    messages=history
)

reply = response.content[0].text
history.append({"role": "assistant", "content": reply})

# Keep last 20 messages for context
conversation_history[user_id] = history[-20:]

return reply
```

def get_chat_response(user_message: str, user_id: int) -> str:
"""Handle free-form coaching chat."""
history = conversation_history.get(user_id, [])
history.append({"role": "user", "content": user_message})

```
response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=600,
    system=SYSTEM_PROMPT,
    messages=history
)

reply = response.content[0].text
history.append({"role": "assistant", "content": reply})
conversation_history[user_id] = history[-20:]

return reply
```

# ── Telegram Handlers ────────────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
await update.message.reply_text(
"👋 Hey! I’m your AI running coach, powered by Claude.\n\n"
"I’ll automatically analyse your Polar runs and message you after each session.\n\n"
"You can also ask me anything:\n"
"• ‘Should I run easy today?’\n"
"• ‘How’s my training load looking?’\n"
"• ‘What pace should I target for London?’\n\n"
"Commands:\n"
"/sync — manually pull latest run\n"
"/status — today’s activity & recovery\n"
"/plan — weekly training overview\n"
"/reset — clear conversation history"
)

async def sync_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
"""Manually trigger a Polar sync."""
await update.message.reply_text("🔄 Checking Polar for new runs…")
new_runs = await check_and_analyse_new_runs(context.bot)
if not new_runs:
await update.message.reply_text("No new runs found since last sync. Go get some miles in! 🏃")

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
"""Show today’s activity summary."""
activity = get_daily_activity()
if not activity:
await update.message.reply_text("Couldn’t fetch today’s activity. Check your Polar connection.")
return

```
steps = activity.get("active-steps", 0)
active_cal = activity.get("active-calories", 0)

summary = f"📊 Today's Activity\nSteps: {steps:,}\nActive Calories: {active_cal} kcal"

coaching = get_chat_response(
    f"Here's my activity data for today: {json.dumps(activity)}. "
    "Give me a quick 2-sentence recovery/readiness assessment.",
    YOUR_TELEGRAM_ID
)

await update.message.reply_text(f"{summary}\n\n🧠 Coach: {coaching}")
```

async def plan_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
"""Ask Claude for a weekly training overview."""
response = get_chat_response(
"Based on our training history and my goals (London Marathon + ultras), "
"give me a brief overview of what this week’s training focus should be. "
"Keep it to 3-4 key points.",
YOUR_TELEGRAM_ID
)
await update.message.reply_text(f"📅 This Week’s Focus\n\n{response}")

async def reset_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
"""Clear conversation history."""
user_id = update.effective_user.id
conversation_history[user_id] = []
await update.message.reply_text("🔄 Conversation history cleared. Fresh start!")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
"""Handle free-form coaching questions."""
user_id = update.effective_user.id

```
# Only respond to your own messages (security)
if user_id != YOUR_TELEGRAM_ID:
    await update.message.reply_text("Sorry, I'm a private coach bot!")
    return

user_message = update.message.text
await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")

response = get_chat_response(user_message, user_id)
await update.message.reply_text(response)
```

# ── Polar Sync Logic ─────────────────────────────────────────────────────────

async def check_and_analyse_new_runs(bot: Bot) -> bool:
"""Pull new exercises from Polar, analyse with Claude, send to Telegram."""
if not POLAR_ACCESS_TOKEN:
logger.warning("No Polar access token set")
return False

```
transaction_id = create_transaction()
if not transaction_id:
    return False

exercises = get_exercises(transaction_id)
found_runs = False

for exercise in exercises:
    exercise_id = exercise.get("id")
    if not exercise_id:
        continue
    
    detail = get_exercise_detail(transaction_id, exercise_id)
    sport = detail.get("sport", "").lower()
    
    # Only analyse running activities
    if "running" not in sport and "trail" not in sport:
        continue
    
    found_runs = True
    summary = format_exercise_for_coach(detail)
    
    await bot.send_message(
        chat_id=YOUR_TELEGRAM_ID,
        text=f"🏃 New run synced from Polar!\n\n{summary}\n\n⏳ Analysing..."
    )
    
    coaching = get_coaching_analysis(summary, YOUR_TELEGRAM_ID)
    await bot.send_message(
        chat_id=YOUR_TELEGRAM_ID,
        text=f"🧠 Coach Analysis:\n\n{coaching}"
    )

commit_transaction(transaction_id)
return found_runs
```

async def scheduled_sync(bot: Bot):
"""Called by scheduler every 30 minutes."""
logger.info("Running scheduled Polar sync…")
try:
await check_and_analyse_new_runs(bot)
except Exception as e:
logger.error(f"Scheduled sync error: {e}")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
app = Application.builder().token(TELEGRAM_TOKEN).build()

```
app.add_handler(CommandHandler("start", start))
app.add_handler(CommandHandler("sync", sync_command))
app.add_handler(CommandHandler("status", status_command))
app.add_handler(CommandHandler("plan", plan_command))
app.add_handler(CommandHandler("reset", reset_command))
app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

# Schedule Polar sync every 30 minutes
scheduler = AsyncIOScheduler()
scheduler.add_job(
    scheduled_sync,
    "interval",
    minutes=30,
    args=[app.bot]
)
scheduler.start()

logger.info("🏃 Polar Coach Bot starting...")
app.run_polling(allowed_updates=Update.ALL_TYPES)
```

if __name__ == "__main__":
main()
