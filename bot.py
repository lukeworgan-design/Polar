import os
import json
import logging
import requests
import anthropic
from telegram import Update, Bot
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from apscheduler.schedulers.asyncio import AsyncIOScheduler

TELEGRAM_TOKEN = os.environ.get(‘TELEGRAM_TOKEN’, ‘’)
ANTHROPIC_API_KEY = os.environ.get(‘ANTHROPIC_API_KEY’, ‘’)
POLAR_CLIENT_ID = os.environ.get(‘POLAR_CLIENT_ID’, ‘’)
POLAR_CLIENT_SECRET = os.environ.get(‘POLAR_CLIENT_SECRET’, ‘’)
POLAR_ACCESS_TOKEN = os.environ.get(‘POLAR_ACCESS_TOKEN’, ‘’)
YOUR_TELEGRAM_ID = int(os.environ.get(‘YOUR_TELEGRAM_ID’, ‘0’))

POLAR_API_BASE = ‘https://www.polaraccesslink.com/v3’

SYSTEM_PROMPT = ‘’‘You are an expert ultra and road marathon running coach.
The athlete is training for London Marathon and ultra marathons.
When given training data, analyse: pace, HR zones, training load, recovery needs.
Be direct, encouraging, and practical. This is a Telegram chat so keep responses conversational.
Always end with one specific tip for the next session.’’’

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(‘polar_coach’)

claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

chat_history = {}

def polar_headers():
return {
‘Authorization’: ’Bearer ’ + POLAR_ACCESS_TOKEN,
‘Accept’: ‘application/json’,
‘Content-Type’: ‘application/json’,
}

def create_transaction():
r = requests.post(POLAR_API_BASE + ‘/users/transaction’, headers=polar_headers())
if r.status_code == 201:
return r.json().get(‘transaction-id’)
return None

def get_exercises(transaction_id):
r = requests.get(
POLAR_API_BASE + ‘/users/transaction/’ + str(transaction_id) + ‘/exercises’,
headers=polar_headers()
)
if r.status_code == 200:
return r.json().get(‘exercises’, [])
return []

def get_exercise_detail(transaction_id, exercise_id):
r = requests.get(
POLAR_API_BASE + ‘/users/transaction/’ + str(transaction_id) + ‘/exercises/’ + str(exercise_id),
headers=polar_headers()
)
if r.status_code == 200:
return r.json()
return {}

def commit_transaction(transaction_id):
requests.put(
POLAR_API_BASE + ‘/users/transaction/’ + str(transaction_id),
headers=polar_headers()
)

def format_exercise(exercise):
sport = exercise.get(‘sport’, ‘Unknown’)
date = exercise.get(‘start-time’, ‘’)[:10]
duration_secs = exercise.get(‘duration’, 0)
duration_min = duration_secs // 60
distance_m = exercise.get(‘distance’, 0)
distance_km = round(distance_m / 1000, 2) if distance_m else 0
calories = exercise.get(‘calories’, 0)

```
pace_str = 'N/A'
if distance_km > 0 and duration_secs > 0:
    pace_secs_per_km = duration_secs / distance_km
    pace_min = int(pace_secs_per_km // 60)
    pace_sec = int(pace_secs_per_km % 60)
    pace_str = str(pace_min) + ':' + str(pace_sec).zfill(2) + '/km'

hr = exercise.get('heart-rate', {})
avg_hr = hr.get('average', 'N/A')
max_hr = hr.get('maximum', 'N/A')

zones = exercise.get('heart-rate-zones', [])
zone_names = ['Z1 Recovery', 'Z2 Aerobic', 'Z3 Tempo', 'Z4 Threshold', 'Z5 Max']
zone_lines = ''
for i, zone in enumerate(zones):
    if i < len(zone_names):
        z_min = zone.get('in-zone', 0) // 60
        zone_lines = zone_lines + '\n  ' + zone_names[i] + ': ' + str(z_min) + ' min'

training_load = exercise.get('training-load', {})
load_score = training_load.get('cardio-load', 'N/A')
ascent = exercise.get('ascent', 'N/A')

summary = (
    'Sport: ' + sport + ' | Date: ' + date + '\n'
    'Duration: ' + str(duration_min) + ' min\n'
    'Distance: ' + str(distance_km) + ' km\n'
    'Avg Pace: ' + pace_str + '\n'
    'Avg HR: ' + str(avg_hr) + ' bpm | Max HR: ' + str(max_hr) + ' bpm\n'
    'Calories: ' + str(calories) + ' kcal\n'
    'Elevation Gain: ' + str(ascent) + ' m\n'
    'Training Load: ' + str(load_score) + '\n'
    'HR Zones:' + (zone_lines if zone_lines else ' Not available')
)
return summary
```

def get_ai_response(user_message, user_id):
history = chat_history.get(user_id, [])
history.append({‘role’: ‘user’, ‘content’: user_message})

```
response = claude.messages.create(
    model='claude-opus-4-6',
    max_tokens=600,
    system=SYSTEM_PROMPT,
    messages=history
)

reply = response.content[0].text
history.append({'role': 'assistant', 'content': reply})
chat_history[user_id] = history[-20:]
return reply
```

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
await update.message.reply_text(
‘Hey! I am your AI running coach powered by Claude.\n\n’
‘I will automatically analyse your Polar runs every 30 minutes.\n\n’
‘Commands:\n’
‘/sync - check for new runs now\n’
‘/plan - this weeks training focus\n’
‘/reset - clear chat history\n\n’
‘Or just ask me anything about your training!’
)

async def sync_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
await update.message.reply_text(‘Checking Polar for new runs…’)
found = await pull_and_analyse(context.bot)
if not found:
await update.message.reply_text(‘No new runs found. Go get some miles in!’)

async def plan_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
response = get_ai_response(
‘Based on my goals of London Marathon and ultras, what should my training focus be this week? Keep it to 3-4 key points.’,
YOUR_TELEGRAM_ID
)
await update.message.reply_text(‘This Weeks Focus\n\n’ + response)

async def reset_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
user_id = update.effective_user.id
chat_history[user_id] = []
await update.message.reply_text(‘Chat history cleared. Fresh start!’)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
user_id = update.effective_user.id
if user_id != YOUR_TELEGRAM_ID:
await update.message.reply_text(‘Sorry, this is a private coaching bot!’)
return
await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=‘typing’)
response = get_ai_response(update.message.text, user_id)
await update.message.reply_text(response)

async def pull_and_analyse(bot: Bot):
if not POLAR_ACCESS_TOKEN:
logger.warning(‘No Polar access token’)
return False

```
transaction_id = create_transaction()
if not transaction_id:
    return False

exercises = get_exercises(transaction_id)
found_runs = False

for exercise in exercises:
    exercise_id = exercise.get('id')
    if not exercise_id:
        continue

    detail = get_exercise_detail(transaction_id, exercise_id)
    sport = detail.get('sport', '').lower()

    if 'running' not in sport and 'trail' not in sport:
        continue

    found_runs = True
    summary = format_exercise(detail)

    await bot.send_message(
        chat_id=YOUR_TELEGRAM_ID,
        text='New run synced from Polar!\n\n' + summary + '\n\nAnalysing...'
    )

    coaching = get_ai_response(
        'I just completed this run. Please analyse it and give me coaching feedback:\n\n' + summary,
        YOUR_TELEGRAM_ID
    )

    await bot.send_message(
        chat_id=YOUR_TELEGRAM_ID,
        text='Coach Analysis:\n\n' + coaching
    )

commit_transaction(transaction_id)
return found_runs
```

async def scheduled_sync(bot: Bot):
logger.info(‘Running scheduled Polar sync…’)
try:
await pull_and_analyse(bot)
except Exception as e:
logger.error(’Scheduled sync error: ’ + str(e))

def main():
app = Application.builder().token(TELEGRAM_TOKEN).build()

```
app.add_handler(CommandHandler('start', start))
app.add_handler(CommandHandler('sync', sync_command))
app.add_handler(CommandHandler('plan', plan_command))
app.add_handler(CommandHandler('reset', reset_command))
app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

scheduler = AsyncIOScheduler()
scheduler.add_job(
    scheduled_sync,
    'interval',
    minutes=30,
    args=[app.bot]
)
scheduler.start()

logger.info('Polar Coach Bot starting...')
app.run_polling(allowed_updates=Update.ALL_TYPES)
```

main()
