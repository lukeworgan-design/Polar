import os
import json
import logging
import requests
import anthropic
from datetime import datetime, timedelta
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from supabase import create_client

TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
POLAR_TOKEN = os.environ.get("POLAR_ACCESS_TOKEN", "")
CHAT_ID = int(os.environ.get("YOUR_TELEGRAM_ID", "0"))
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
COACHING_BACKGROUND = os.environ.get("COACHING_BACKGROUND", "")
POLAR_USER_ID = os.environ.get("POLAR_USER_ID", "39895876")  # FIX: was missing entirely
POLAR_BASE = "https://www.polaraccesslink.com/v3"

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bot")
ai = anthropic.Anthropic(api_key=API_KEY)
db = create_client(SUPABASE_URL, SUPABASE_KEY)


def save_memory(category, content):
    try:
        db.table("memories").insert({"category": category, "content": content}).execute()
    except Exception as e:
        log.error("save_memory error: " + str(e))


def get_memories():
    try:
        r = db.table("memories").select("*").order("created_at", desc=True).limit(50).execute()
        return r.data or []
    except Exception as e:
        log.error("get_memories error: " + str(e))
        return []


def save_conversation(role, content):
    try:
        db.table("conversations").insert({"role": role, "content": content}).execute()
    except Exception as e:
        log.error("save_conversation error: " + str(e))


def get_recent_conversations(limit=30):
    try:
        r = db.table("conversations").select("*").order("created_at", desc=True).limit(limit).execute()
        data = r.data or []
        data.reverse()
        return [{"role": m["role"], "content": m["content"]} for m in data]
    except Exception as e:
        log.error("get_conversations error: " + str(e))
        return []


def polar_headers():
    return {
        "Authorization": "Bearer " + POLAR_TOKEN,
        "Accept": "application/json",
        "Content-Type": "application/json"
    }


def polar_get(path):
    url = POLAR_BASE + path
    log.info("Polar GET: " + url)
    r = requests.get(url, headers=polar_headers())
    log.info("Polar GET response: " + str(r.status_code))
    if r.ok:
        return r.json()
    log.error("Polar GET error: " + r.text)
    return {}


def polar_post(path):
    url = POLAR_BASE + path
    log.info("Polar POST: " + url)
    r = requests.post(url, headers=polar_headers())
    log.info("Polar POST response: " + str(r.status_code) + " " + r.text[:200])
    return r


def polar_put(path):
    url = POLAR_BASE + path
    log.info("Polar PUT (commit): " + url)
    r = requests.put(url, headers=polar_headers())
    log.info("Polar PUT response: " + str(r.status_code))


def get_physical_info():
    data = polar_get("/users/physical-information")
    if not data:
        return ""
    return ("weight=" + str(data.get("weight", "N/A")) + "kg" +
            " height=" + str(data.get("height", "N/A")) + "cm" +
            " maxHR=" + str(data.get("maximum-heart-rate", "N/A")) +
            " restHR=" + str(data.get("resting-heart-rate", "N/A")) +
            " VO2max=" + str(data.get("vo2-max", "N/A")))


def get_sleep(from_date, to_date):
    r = requests.get(
        POLAR_BASE + "/users/sleep",
        headers=polar_headers(),
        params={"from": from_date, "to": to_date}
    )
    log.info("Sleep API status: " + str(r.status_code))
    if not r.ok:
        log.error("Sleep API error: " + r.text)
        return []
    result = []
    for n in r.json().get("nights", []):
        date = n.get("date", "")
        hrs = n.get("sleep-time-seconds", 0) // 3600
        score = n.get("sleep-score", "N/A")
        rem = round(n.get("rem-sleep-seconds", 0) / 3600, 1)
        deep = round(n.get("deep-sleep-seconds", 0) / 3600, 1)
        result.append(date + " " + str(hrs) + "h score=" + str(score) + " REM=" + str(rem) + "h deep=" + str(deep) + "h")
    return result


def get_recharge(from_date, to_date):
    r = requests.get(
        POLAR_BASE + "/users/nightly-recharge",
        headers=polar_headers(),
        params={"from": from_date, "to": to_date}
    )
    log.info("Recharge API status: " + str(r.status_code))
    if not r.ok:
        log.error("Recharge API error: " + r.text)
        return []
    result = []
    for n in r.json().get("recharges", []):
        date = n.get("date", "")
        status = n.get("nightly-recharge-status", "N/A")
        hrv = n.get("heart-rate-variability-ms", "N/A")
        ans = n.get("ans-charge", "N/A")
        result.append(date + " recharge=" + str(status) + " HRV=" + str(hrv) + "ms ANS=" + str(ans))
    return result


def get_exercises():
    """
    Polar Accesslink exercise transaction flow:
    1. POST to create transaction -> get transaction-id
    2. GET transaction to list exercise URLs
    3. GET each exercise URL for details
    4. PUT to commit transaction (marks data as read)
    """
    # FIX: correct endpoint with user ID
    r = polar_post("/users/" + POLAR_USER_ID + "/exercise-transactions")

    if r.status_code == 204:
        log.info("No new exercises available (204)")
        return None, []

    if r.status_code != 201:
        log.error("Exercise transaction failed: " + str(r.status_code) + " " + r.text)
        return None, []

    tid = r.json().get("transaction-id")
    log.info("Transaction ID: " + str(tid))

    # FIX: correct endpoint to list exercises in transaction
    data = polar_get("/users/" + POLAR_USER_ID + "/exercise-transactions/" + str(tid))
    exercise_urls = data.get("exercises", [])
    log.info("Exercise URLs found: " + str(len(exercise_urls)))

    exercises = []
    for url in exercise_urls:
        # Exercise URLs are full URLs returned by Polar, fetch them directly
        log.info("Fetching exercise: " + url)
        ex_r = requests.get(url, headers=polar_headers())
        if ex_r.ok:
            exercises.append(ex_r.json())
        else:
            log.error("Exercise fetch error: " + str(ex_r.status_code) + " " + ex_r.text)

    return tid, exercises


def commit_transaction(tid):
    """Commit (mark as read) a Polar exercise transaction"""
    if tid:
        polar_put("/users/" + POLAR_USER_ID + "/exercise-transactions/" + str(tid))


def summarise(ex):
    sport = ex.get("sport", "Unknown")
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
            ztext += znames[i] + "=" + str(z.get("in-zone", 0) // 60) + "min "
    return (sport + " " + date + " dist=" + str(dist) + "km dur=" + str(mins) +
            "min pace=" + pace + " HRavg=" + str(avg) + " HRmax=" + str(mx) +
            " load=" + str(load) + " ascent=" + str(asc) + "m zones:" + ztext)


def build_context():
    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

    ctx = "=== ATHLETE PROFILE ===\n"
    ctx += "Name: Luke Worgan\n"
    ctx += "Goals: London Marathon + Ultra marathons\n"
    ctx += "Watch: Polar Grit X2\n"
    ctx += "Today: " + today + "\n"

    if COACHING_BACKGROUND:
        ctx += "\n=== COACHING BACKGROUND ===\n" + COACHING_BACKGROUND + "\n"

    phys = get_physical_info()
    if phys:
        ctx += "\n=== PHYSICAL ===\n" + phys + "\n"
    else:
        ctx += "\n=== PHYSICAL ===\nNo physical data available yet\n"

    sleep = get_sleep(week_ago, today)
    if sleep:
        ctx += "\n=== SLEEP LAST 7 DAYS ===\n" + "\n".join(sleep) + "\n"
    else:
        ctx += "\n=== SLEEP ===\nSleep data pending Polar API access (requested)\n"

    recharge = get_recharge(week_ago, today)
    if recharge:
        ctx += "\n=== RECOVERY LAST 7 DAYS ===\n" + "\n".join(recharge) + "\n"
    else:
        ctx += "\n=== RECOVERY ===\nNightly recharge data pending Polar API access (requested)\n"

    memories = get_memories()
    if memories:
        ctx += "\n=== ATHLETE NOTES & HISTORY ===\n"
        for m in memories:
            ctx += m.get("category", "") + ": " + m.get("content", "") + "\n"

    return ctx


def build_system(include_context=True):
    base = ("You are an expert personal running coach specialising in ultra marathons and road marathons. " +
            "Your athlete is Luke Worgan, training for the London Marathon and ultra marathons. " +
            "You have access to his Polar Grit X2 training data. " +
            "Give highly personalised, specific coaching advice based on his actual data. " +
            "Reference real numbers when available. Be direct, practical and encouraging. " +
            "If sleep/recovery data shows as pending, acknowledge it honestly and coach based on what you do have.")
    if include_context:
        return base + "\n\n" + build_context()
    return base


def ask_claude(user_msg, include_context=True):
    history = get_recent_conversations()
    history.append({"role": "user", "content": user_msg})
    save_conversation("user", user_msg)
    r = ai.messages.create(
        model="claude-opus-4-6",
        max_tokens=800,
        system=build_system(include_context),
        messages=history
    )
    reply = r.content[0].text
    save_conversation("assistant", reply)
    return reply


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "V2 Running Coach active! 🏃\n\n" +
        "/load - pull full Polar history\n" +
        "/sync - check for new runs\n" +
        "/week - weekly training summary\n" +
        "/recovery - today's recovery status\n" +
        "/plan - personalised weekly plan\n" +
        "/remember [text] - save something to memory\n" +
        "/debug - check Polar API connection\n" +
        "/reset - clear chat history\n\n" +
        "Just chat - I know your full history!"
    )


async def cmd_debug(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Debug command to check what Polar data is accessible"""
    await update.message.reply_text("🔍 Checking Polar API connection...")

    results = []

    # Check physical info
    phys = get_physical_info()
    results.append("Physical info: " + ("✅ " + phys if phys else "❌ Empty"))

    # Check sleep
    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    sleep = get_sleep(week_ago, today)
    results.append("Sleep (7 days): " + ("✅ " + str(len(sleep)) + " nights" if sleep else "❌ Empty (pending Polar B2B access)"))

    # Check recharge
    recharge = get_recharge(week_ago, today)
    results.append("Nightly recharge: " + ("✅ " + str(len(recharge)) + " nights" if recharge else "❌ Empty (pending Polar B2B access)"))

    # Check exercise transaction
    results.append("\nChecking exercise transaction...")
    r = requests.post(
        POLAR_BASE + "/users/" + POLAR_USER_ID + "/exercise-transactions",
        headers=polar_headers()
    )
    if r.status_code == 201:
        tid = r.json().get("transaction-id")
        results.append("Exercise transaction: ✅ Created (ID: " + str(tid) + ")")
        # Commit it immediately since this is just a debug check
        polar_put("/users/" + POLAR_USER_ID + "/exercise-transactions/" + str(tid))
        results.append("(Transaction committed - no exercises consumed)")
    elif r.status_code == 204:
        results.append("Exercise transaction: ✅ Connected (no new exercises)")
    else:
        results.append("Exercise transaction: ❌ Error " + str(r.status_code) + ": " + r.text[:100])

    await update.message.reply_text("Polar Data Check:\n\n" + "\n".join(results))


async def cmd_load(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Loading your Polar exercise history...")
    tid, exercises = get_exercises()
    if not exercises:
        if tid is None:
            await update.message.reply_text(
                "No new exercises found in Polar.\n\n" +
                "This means either:\n" +
                "• All existing exercises were already synced\n" +
                "• No exercises exist in your Polar account yet\n\n" +
                "Try /debug to check the connection."
            )
        else:
            await update.message.reply_text("No exercises in this transaction.")
        return

    runs = [e for e in exercises if "running" in e.get("sport", "").lower() or "trail" in e.get("sport", "").lower()]
    total_dist = sum(e.get("distance", 0) for e in runs) / 1000
    summaries = [summarise(e) for e in runs]
    combined = "\n".join(summaries)
    save_memory("training_history", "Full run history loaded: " + str(len(runs)) + " runs, " + str(round(total_dist, 1)) + "km total\n" + combined[:3000])
    commit_transaction(tid)
    await update.message.reply_text(
        "✅ Loaded " + str(len(runs)) + " runs, " + str(round(total_dist, 1)) + "km total.\n\n" +
        "I now know your full training history. Ask me anything!"
    )


async def cmd_sync(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Checking Polar for new runs...")
    tid, exercises = get_exercises()
    if not exercises:
        await update.message.reply_text("No new runs to sync.")
        return
    runs = [e for e in exercises if "running" in e.get("sport", "").lower() or "trail" in e.get("sport", "").lower()]
    if not runs:
        await update.message.reply_text("No new runs found (other activities may have been committed).")
        commit_transaction(tid)
        return
    for run in runs:
        s = summarise(run)
        save_memory("recent_run", s)
        await update.message.reply_text("✅ New run synced:\n\n" + s)
        coaching = ask_claude("I just completed this run. Analyse it and give me specific coaching feedback:\n\n" + s)
        await update.message.reply_text("🏃 Coach:\n\n" + coaching)
    commit_transaction(tid)


async def cmd_week(update: Update, context: ContextTypes.DEFAULT_TYPE):
    r = ask_claude("Give me a detailed summary of my training this week. Include total load, quality of sessions, how it fits my London Marathon and ultra goals, and what I should focus on next week.")
    await update.message.reply_text(r)


async def cmd_recovery(update: Update, context: ContextTypes.DEFAULT_TYPE):
    r = ask_claude("Based on my sleep and recovery data from the past few days, how recovered am I right now? Should I train hard, easy or rest today? Be specific.")
    await update.message.reply_text(r)


async def cmd_plan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    r = ask_claude("Based on my full training history, current fitness and goals, give me a specific training plan for this week. Include each session with target distance, pace zones and HR zones.")
    await update.message.reply_text(r)


async def cmd_remember(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text:
        await update.message.reply_text("Tell me what to remember.\nExample: /remember left knee niggle when running over 25km")
        return
    save_memory("athlete_note", text)
    await update.message.reply_text("Got it, remembered: " + text)


async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        db.table("conversations").delete().neq("id", 0).execute()
        await update.message.reply_text("Conversation history cleared. Memories kept.")
    except Exception as e:
        await update.message.reply_text("Error clearing history: " + str(e))


async def msg(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != CHAT_ID:
        return
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")
    r = ask_claude(update.message.text)
    await update.message.reply_text(r)


async def morning_briefing(bot):
    try:
        briefing = ask_claude(
            "Give me my morning coaching briefing. In 3-4 short paragraphs cover: " +
            "1) My recovery status based on last night's sleep and HRV (if data available, note if pending) " +
            "2) Whether to train hard, easy or rest today and why " +
            "3) If training, the specific session I should do with target pace and HR zone " +
            "4) One motivational note about my London Marathon or ultra progress"
        )
        await bot.send_message(chat_id=CHAT_ID, text="Good morning Luke! 🌅\n\n" + briefing)
    except Exception as e:
        log.error("Morning briefing error: " + str(e))


def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("load", cmd_load))
    app.add_handler(CommandHandler("sync", cmd_sync))
    app.add_handler(CommandHandler("week", cmd_week))
    app.add_handler(CommandHandler("recovery", cmd_recovery))
    app.add_handler(CommandHandler("plan", cmd_plan))
    app.add_handler(CommandHandler("remember", cmd_remember))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("debug", cmd_debug))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, msg))

    scheduler = AsyncIOScheduler()
    scheduler.add_job(morning_briefing, "cron", hour=7, minute=0, args=[app.bot])
    scheduler.start()

    log.info("V2 Bot started - Polar User ID: " + POLAR_USER_ID)
    app.run_polling()


main()