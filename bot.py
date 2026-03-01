import os
import logging
import requests
import anthropic
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
POLAR_TOKEN = os.environ.get("POLAR_ACCESS_TOKEN", "")
CHAT_ID = int(os.environ.get("YOUR_TELEGRAM_ID", "0"))
POLAR_BASE = "https://www.polaraccesslink.com/v3"
PROMPT = "You are an expert running coach for ultra marathons and road marathons including London Marathon. Analyse training data and give practical coaching advice. Be concise and direct."

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bot")
ai = anthropic.Anthropic(api_key=API_KEY)
history = {}

def ask_claude(msg, uid):
    h = history.get(uid, [])
    h.append({"role": "user", "content": msg})
    r = ai.messages.create(model="claude-opus-4-6", max_tokens=500, system=PROMPT, messages=h)
    reply = r.content[0].text
    h.append({"role": "assistant", "content": reply})
    history[uid] = h[-20:]
    return reply

def polar_get(path):
    h = {"Authorization": "Bearer " + POLAR_TOKEN, "Accept": "application/json"}
    r = requests.get(POLAR_BASE + path, headers=h)
    return r.json() if r.ok else {}

def polar_post(path):
    h = {"Authorization": "Bearer " + POLAR_TOKEN, "Accept": "application/json", "Content-Type": "application/json"}
    r = requests.post(POLAR_BASE + path, headers=h)
    return r

def polar_put(path):
    h = {"Authorization": "Bearer " + POLAR_TOKEN}
    requests.put(POLAR_BASE + path, headers=h)

def get_runs():
    r = polar_post("/users/transaction")
    if r.status_code != 201:
        return None, []
    tid = r.json().get("transaction-id")
    data = polar_get("/users/transaction/" + str(tid) + "/exercises")
    runs = []
    for ex in data.get("exercises", []):
        eid = ex.get("id")
        if eid:
            detail = polar_get("/users/transaction/" + str(tid) + "/exercises/" + str(eid))
            if "running" in detail.get("sport", "").lower() or "trail" in detail.get("sport", "").lower():
                runs.append(detail)
            return tid, runs

def summarise(ex):
    sport = ex.get("sport", "Run")
    date = ex.get("start-time", "")[:10]
    secs = ex.get("duration", 0)
    mins = secs // 60
    dist = round(ex.get("distance", 0) / 1000, 2)
    cal = ex.get("calories", 0)
    hr = ex.get("heart-rate", {})
    avg = hr.get("average", "N/A")
    mx = hr.get("maximum", "N/A")
    pace = "N/A"
    if dist > 0 and secs > 0:
        ps = secs / dist
        pace = str(int(ps // 60)) + ":" + str(int(ps % 60)).zfill(2) + "/km"
    load = ex.get("training-load", {}).get("cardio-load", "N/A")
    asc = ex.get("ascent", "N/A")
    zones = ex.get("heart-rate-zones", [])
    znames = ["Z1", "Z2", "Z3", "Z4", "Z5"]
    ztext = ""
    for i, z in enumerate(zones):
        if i < 5:
            ztext += znames[i] + ": " + str(z.get("in-zone", 0) // 60) + "min  "
    return (sport + " on " + date + "\n" +
    "Distance: " + str(dist) + "km  Duration: " + str(mins) + "min\n" +
    "Pace: " + pace + "  Calories: " + str(cal) + "\n" +
    "HR avg: " + str(avg) + "  max: " + str(mx) + "\n" +
    "Load: " + str(load) + "  Ascent: " + str(asc) + "m\n" +
    "Zones: " + (ztext if ztext else "N/A"))

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Running coach bot active!\n\n/sync - check for new runs\n/plan - weekly focus\n/reset - clear history\n\nOr just chat with me!")

async def cmd_sync(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Checking Polar…")
tid, runs = get_runs()
        if not runs:
        await update.message.reply_text("No new runs found.")
        return
    for run in runs:
        s = summarise(run)
        await update.message.reply_text("New run:\n\n" + s)
        coaching = ask_claude("Analyse this run and give me coaching feedback:\n\n" + s, CHAT_ID)
        await update.message.reply_text("Coach:\n\n" + coaching)
    if tid:
        polar_put("/users/transaction/" + str(tid))

async def cmd_plan(update: Update, context: ContextTypes.DEFAULT_TYPE):
r = ask_claude("What should my training focus be this week for London Marathon and ultras? 3-4 key points.", CHAT_ID)
await update.message.reply_text(r)

async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    history[update.effective_user.id] = []
    await update.message.reply_text("History cleared.")

async def msg(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != CHAT_ID:
        return
    r = ask_claude(update.message.text, CHAT_ID)
    await update.message.reply_text(r)

def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("sync", cmd_sync))
    app.add_handler(CommandHandler("plan", cmd_plan))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, msg))
    log.info("Bot started")
    app.run_polling()

main()