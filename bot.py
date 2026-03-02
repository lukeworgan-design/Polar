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
POLAR_USER_ID = os.environ.get("POLAR_USER_ID", "39895876")
POLAR_BASE = "https://www.polaraccesslink.com/v3"

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bot")
ai = anthropic.Anthropic(api_key=API_KEY)
db = create_client(SUPABASE_URL, SUPABASE_KEY)


# ─────────────────────────────────────────────
# SUPABASE HELPERS
# ─────────────────────────────────────────────

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


def save_exercise(ex_id, ex_data, splits=None):
    """Save exercise session to exercises table"""
    try:
        hr = ex_data.get("heart-rate", {})
        dist = ex_data.get("distance", 0)
        secs = ex_data.get("duration", 0)

        row = {
            "id": str(ex_id),
            "start_time": ex_data.get("start-time"),
            "sport": ex_data.get("sport", "Unknown"),
            "distance": dist,
            "duration": str(timedelta(seconds=secs)) if secs else None,
            "calories": ex_data.get("calories"),
            "heart_rate_avg": hr.get("average"),
            "heart_rate_max": hr.get("maximum"),
            "training_load": ex_data.get("training-load", {}).get("cardio-load") if isinstance(ex_data.get("training-load"), dict) else None,
            "notes": None,
            "raw_data": ex_data
        }

        # Upsert - won't duplicate if already exists
        db.table("exercises").upsert(row).execute()
        log.info("Saved exercise " + str(ex_id) + " to Supabase")

        # Save splits if provided
        if splits:
            save_splits(str(ex_id), splits)

    except Exception as e:
        log.error("save_exercise error: " + str(e))


def save_splits(ex_id, splits_data):
    """Save km splits to exercise_splits table (creates if needed)"""
    try:
        rows = []
        for i, split in enumerate(splits_data):
            rows.append({
                "exercise_id": ex_id,
                "km": i + 1,
                "duration_secs": split.get("duration"),
                "heart_rate_avg": split.get("heart_rate_avg"),
                "heart_rate_max": split.get("heart_rate_max"),
                "pace_secs_per_km": split.get("pace_secs_per_km"),
                "ascent": split.get("ascent"),
                "descent": split.get("descent"),
            })
        if rows:
            db.table("exercise_splits").upsert(rows).execute()
            log.info("Saved " + str(len(rows)) + " splits for exercise " + ex_id)
    except Exception as e:
        log.error("save_splits error: " + str(e))


def get_recent_exercises_from_db(days=14):
    """Fetch recent exercises from Supabase exercises table"""
    try:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        r = db.table("exercises") \
            .select("*") \
            .gte("start_time", cutoff) \
            .order("start_time", desc=True) \
            .execute()
        return r.data or []
    except Exception as e:
        log.error("get_recent_exercises error: " + str(e))
        return []


def get_splits_from_db(exercise_id):
    """Fetch km splits for a specific exercise"""
    try:
        r = db.table("exercise_splits") \
            .select("*") \
            .eq("exercise_id", str(exercise_id)) \
            .order("km") \
            .execute()
        return r.data or []
    except Exception as e:
        log.error("get_splits error: " + str(e))
        return []


def format_exercises_for_claude(exercises):
    """Format exercises into Claude-readable context"""
    if not exercises:
        return "No training sessions in database yet. Use /sync to pull from Polar."

    lines = []
    for ex in exercises:
        dist_km = round((ex.get("distance") or 0) / 1000, 2)
        pace = "N/A"
        dist = ex.get("distance") or 0
        dur_str = ex.get("duration") or ""

        # Parse duration back to seconds for pace calc
        try:
            if dur_str:
                parts = dur_str.split(":")
                if len(parts) == 3:
                    secs = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    secs = int(parts[0]) * 60 + int(parts[1])
                else:
                    secs = 0
                if dist > 0 and secs > 0:
                    ps = secs / (dist / 1000)
                    pace = str(int(ps // 60)) + ":" + str(int(ps % 60)).zfill(2) + "/km"
        except Exception:
            pass

        date = (ex.get("start_time") or "")[:10]
        line = (
            "• " + date + " | " + ex.get("sport", "Run") +
            " | " + str(dist_km) + "km" +
            " | " + dur_str +
            " | pace=" + pace +
            " | HRavg=" + str(ex.get("heart_rate_avg") or "N/A") +
            " | HRmax=" + str(ex.get("heart_rate_max") or "N/A") +
            " | load=" + str(ex.get("training_load") or "N/A") +
            " | cal=" + str(ex.get("calories") or "N/A")
        )
        lines.append(line)

    return "\n".join(lines)


# ─────────────────────────────────────────────
# POLAR API HELPERS
# ─────────────────────────────────────────────

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
        data = polar_get("/users/" + POLAR_USER_ID)
    if not data:
        return "weight=N/A height=N/A maxHR=N/A restHR=N/A VO2max=N/A (use /setphysical to set)"
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
        total_secs = n.get("light_sleep", 0) + n.get("deep_sleep", 0) + n.get("rem_sleep", 0)
        hrs = round(total_secs / 3600, 1)
        score = n.get("sleep_score", "N/A")
        rem = round(n.get("rem_sleep", 0) / 3600, 1)
        deep = round(n.get("deep_sleep", 0) / 3600, 1)
        light = round(n.get("light_sleep", 0) / 3600, 1)
        interruptions = n.get("total_interruption_duration", 0) // 60
        result.append(date + " " + str(hrs) + "h score=" + str(score) +
                      " REM=" + str(rem) + "h deep=" + str(deep) + "h light=" + str(light) + "h" +
                      " interruptions=" + str(interruptions) + "min")
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
        status = n.get("nightly_recharge_status", "N/A")
        hrv = n.get("heart_rate_variability_avg", "N/A")
        ans = n.get("ans_charge", "N/A")
        ans_status = n.get("ans_charge_status", "N/A")
        hr_avg = n.get("heart_rate_avg", "N/A")
        breathing = n.get("breathing_rate_avg", "N/A")
        result.append(date + " recharge=" + str(status) + " HRV=" + str(hrv) + "ms" +
                      " ANS=" + str(ans) + " ANSstatus=" + str(ans_status) +
                      " HRavg=" + str(hr_avg) + " breathing=" + str(breathing) + "rpm")
    return result


def fetch_splits(exercise_url):
    """
    Fetch km splits from Polar samples endpoint.
    exercise_url is the full URL of the exercise, e.g. .../exercises/123456
    We append /samples to get the time-series data.
    """
    try:
        samples_url = exercise_url.rstrip("/") + "/samples"
        log.info("Fetching splits from: " + samples_url)
        r = requests.get(samples_url, headers=polar_headers())
        if not r.ok:
            log.warning("Splits fetch failed: " + str(r.status_code) + " " + r.text[:200])
            return []

        data = r.json()
        # Polar returns samples as a list of sample sets by type
        # We look for "SPEED", "HR", "ALTITUDE" etc and build per-km splits
        # The simplest approach: look for lap data if available
        laps = data.get("laps", [])
        if laps:
            splits = []
            for lap in laps:
                hr_data = lap.get("heart-rate", {})
                dur = lap.get("duration", 0)
                dist = lap.get("distance", 1000)
                pace_secs = dur / (dist / 1000) if dist > 0 else None
                splits.append({
                    "duration": dur,
                    "heart_rate_avg": hr_data.get("average"),
                    "heart_rate_max": hr_data.get("maximum"),
                    "pace_secs_per_km": round(pace_secs) if pace_secs else None,
                    "ascent": lap.get("ascent"),
                    "descent": lap.get("descent"),
                })
            return splits

        return []
    except Exception as e:
        log.error("fetch_splits error: " + str(e))
        return []


def get_exercises():
    """
    Polar Accesslink exercise transaction flow:
    1. POST to create transaction -> get transaction-id
    2. GET transaction to list exercise URLs
    3. GET each exercise URL for details + splits
    4. PUT to commit transaction
    """
    r = polar_post("/users/" + POLAR_USER_ID + "/exercise-transactions")

    if r.status_code == 204:
        log.info("No new exercises available (204)")
        return None, []

    if r.status_code != 201:
        log.error("Exercise transaction failed: " + str(r.status_code) + " " + r.text)
        return None, []

    tid = r.json().get("transaction-id")
    log.info("Transaction ID: " + str(tid))

    data = polar_get("/users/" + POLAR_USER_ID + "/exercise-transactions/" + str(tid))
    exercise_urls = data.get("exercises", [])
    log.info("Exercise URLs found: " + str(len(exercise_urls)))

    exercises = []
    for url in exercise_urls:
        log.info("Fetching exercise: " + url)
        ex_r = requests.get(url, headers=polar_headers())
        if ex_r.ok:
            ex_data = ex_r.json()
            # Fetch km splits
            splits = fetch_splits(url)
            ex_data["_splits"] = splits
            ex_data["_url"] = url
            exercises.append(ex_data)
        else:
            log.error("Exercise fetch error: " + str(ex_r.status_code) + " " + ex_r.text)

    return tid, exercises


def commit_transaction(tid):
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
    load = ex.get("training-load", {}).get("cardio-load", "N/A") if isinstance(ex.get("training-load"), dict) else "N/A"
    asc = ex.get("ascent", "N/A")
    zones = ex.get("heart-rate-zones", [])
    znames = ["Z1", "Z2", "Z3", "Z4", "Z5"]
    ztext = ""
    for i, z in enumerate(zones):
        if i < 5:
            ztext += znames[i] + "=" + str(z.get("in-zone", 0) // 60) + "min "

    # Add splits summary if available
    splits = ex.get("_splits", [])
    splits_text = ""
    if splits:
        splits_text = "\n  Km splits: "
        for i, s in enumerate(splits):
            p = s.get("pace_secs_per_km")
            hr_s = s.get("heart_rate_avg", "?")
            if p:
                splits_text += "km" + str(i + 1) + "=" + str(int(p // 60)) + ":" + str(int(p % 60)).zfill(2) + "@" + str(hr_s) + "bpm "

    return (sport + " " + date + " dist=" + str(dist) + "km dur=" + str(mins) +
            "min pace=" + pace + " HRavg=" + str(avg) + " HRmax=" + str(mx) +
            " load=" + str(load) + " ascent=" + str(asc) + "m zones:" + ztext + splits_text)


# ─────────────────────────────────────────────
# CONTEXT BUILDER
# ─────────────────────────────────────────────

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
    ctx += "\n=== PHYSICAL ===\n" + (phys if phys else "No physical data - use /setphysical") + "\n"

    sleep = get_sleep(week_ago, today)
    ctx += "\n=== SLEEP LAST 7 DAYS ===\n" + ("\n".join(sleep) if sleep else "Sleep data pending Polar API access") + "\n"

    recharge = get_recharge(week_ago, today)
    ctx += "\n=== RECOVERY LAST 7 DAYS ===\n" + ("\n".join(recharge) if recharge else "Nightly recharge data pending Polar API access") + "\n"

    # ✅ NEW: Pull training sessions from Supabase exercises table
    exercises = get_recent_exercises_from_db(days=14)
    ctx += "\n=== TRAINING SESSIONS (LAST 14 DAYS) ===\n"
    ctx += format_exercises_for_claude(exercises) + "\n"

    memories = get_memories()
    if memories:
        ctx += "\n=== ATHLETE NOTES & HISTORY ===\n"
        for m in memories:
            ctx += m.get("category", "") + ": " + m.get("content", "") + "\n"

    return ctx


def build_system(include_context=True):
    base = ("You are an expert personal running coach specialising in ultra marathons and road marathons. " +
            "Your athlete is Luke Worgan, training for the London Marathon and ultra marathons. " +
            "You have access to his Polar Grit X2 training data including sessions, pace, HR zones and km splits. " +
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


# ─────────────────────────────────────────────
# TELEGRAM COMMANDS
# ─────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "V2 Running Coach active! 🏃\n\n" +
        "/load - pull full Polar history\n" +
        "/sync - check for new runs\n" +
        "/week - weekly training summary\n" +
        "/recovery - today's recovery status\n" +
        "/plan - personalised weekly plan\n" +
        "/setphysical - set weight, HR, VO2max\n" +
        "/remember [text] - save something to memory\n" +
        "/debug - check Polar API connection\n" +
        "/showtraining - see what training data bot has\n" +
        "/reset - clear chat history\n\n" +
        "Just chat - I know your full history!"
    )


async def cmd_showtraining(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show what training data is in Supabase and visible to Claude"""
    exercises = get_recent_exercises_from_db(days=30)
    if not exercises:
        await update.message.reply_text(
            "❌ No exercises in database yet.\n\n"
            "Run /sync to pull from Polar.\n"
            "If you've done /sync and this is still empty, check Railway logs."
        )
        return

    lines = ["✅ " + str(len(exercises)) + " sessions in database (last 30 days):\n"]
    for ex in exercises:
        dist_km = round((ex.get("distance") or 0) / 1000, 2)
        date = (ex.get("start_time") or "")[:10]
        lines.append(
            date + " | " + ex.get("sport", "?") +
            " | " + str(dist_km) + "km" +
            " | HR " + str(ex.get("heart_rate_avg") or "N/A") + "/" + str(ex.get("heart_rate_max") or "N/A")
        )

    await update.message.reply_text("\n".join(lines))


async def cmd_showsleep(update: Update, context: ContextTypes.DEFAULT_TYPE):
    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    await update.message.reply_text("Fetching raw sleep data " + week_ago + " to " + today + "...")
    r = requests.get(POLAR_BASE + "/users/sleep", headers=polar_headers(), params={"from": week_ago, "to": today})
    await update.message.reply_text("Sleep API status: " + str(r.status_code) + "\nRaw:\n" + r.text[:2000])
    r2 = requests.get(POLAR_BASE + "/users/nightly-recharge", headers=polar_headers(), params={"from": week_ago, "to": today})
    await update.message.reply_text("Recharge API status: " + str(r2.status_code) + "\nRaw:\n" + r2.text[:2000])
    sleep = get_sleep(week_ago, today)
    recharge = get_recharge(week_ago, today)
    await update.message.reply_text(
        "What Claude sees:\n\nSLEEP:\n" + ("\n".join(sleep) if sleep else "EMPTY") +
        "\n\nRECHARGE:\n" + ("\n".join(recharge) if recharge else "EMPTY")
    )


async def cmd_debug(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🔍 Checking Polar API connection...")
    results = []
    phys = get_physical_info()
    results.append("Physical info: " + ("✅ " + phys if phys else "❌ Empty"))
    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    sleep = get_sleep(week_ago, today)
    results.append("Sleep (7 days): " + ("✅ " + str(len(sleep)) + " nights" if sleep else "❌ Empty"))
    recharge = get_recharge(week_ago, today)
    results.append("Nightly recharge: " + ("✅ " + str(len(recharge)) + " nights" if recharge else "❌ Empty"))
    exercises = get_recent_exercises_from_db(days=30)
    results.append("Exercises in DB: " + ("✅ " + str(len(exercises)) + " sessions" if exercises else "❌ Empty - run /sync"))
    r = requests.post(POLAR_BASE + "/users/" + POLAR_USER_ID + "/exercise-transactions", headers=polar_headers())
    if r.status_code == 201:
        tid = r.json().get("transaction-id")
        results.append("Polar API: ✅ Connected (new exercises available - run /sync)")
        polar_put("/users/" + POLAR_USER_ID + "/exercise-transactions/" + str(tid))
    elif r.status_code == 204:
        results.append("Polar API: ✅ Connected (no new exercises)")
    else:
        results.append("Polar API: ❌ Error " + str(r.status_code) + ": " + r.text[:100])
    await update.message.reply_text("Status:\n\n" + "\n".join(results))


async def cmd_load(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Loading your Polar exercise history...")
    tid, exercises = get_exercises()
    if not exercises:
        await update.message.reply_text(
            "No new exercises found in Polar.\n\n" +
            "All existing exercises may already be synced. Try /showtraining to see what's in the database."
        )
        return

    runs = [e for e in exercises if "running" in e.get("sport", "").lower() or "trail" in e.get("sport", "").lower()]
    total_dist = sum(e.get("distance", 0) for e in runs) / 1000

    # ✅ Save each exercise to Supabase
    for ex in exercises:
        ex_id = ex.get("id") or ex.get("_url", "").split("/")[-1]
        splits = ex.get("_splits", [])
        save_exercise(ex_id, ex, splits)

    summaries = [summarise(e) for e in runs]
    combined = "\n".join(summaries)
    save_memory("training_history", "Full run history loaded: " + str(len(runs)) + " runs, " + str(round(total_dist, 1)) + "km total\n" + combined[:3000])
    commit_transaction(tid)
    await update.message.reply_text(
        "✅ Loaded " + str(len(runs)) + " runs, " + str(round(total_dist, 1)) + "km total.\n\n" +
        "Saved to database — I now know your full training history. Ask me anything!"
    )


async def cmd_sync(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Checking Polar for new runs...")
    tid, exercises = get_exercises()
    if not exercises:
        await update.message.reply_text("No new runs to sync.")
        return

    runs = [e for e in exercises if "running" in e.get("sport", "").lower() or "trail" in e.get("sport", "").lower()]
    if not runs:
        await update.message.reply_text("No new runs found (other activities committed).")
        # Still save non-run exercises
        for ex in exercises:
            ex_id = ex.get("id") or ex.get("_url", "").split("/")[-1]
            save_exercise(ex_id, ex, ex.get("_splits", []))
        commit_transaction(tid)
        return

    for run in runs:
        # ✅ Save to exercises table
        ex_id = run.get("id") or run.get("_url", "").split("/")[-1]
        splits = run.get("_splits", [])
        save_exercise(ex_id, run, splits)

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


async def cmd_setphysical(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text:
        await update.message.reply_text(
            "Set your physical stats:\n\n"
            "/setphysical weight=XX height=XXX maxHR=XXX restHR=XX VO2max=XX\n\n"
            "Example: /setphysical weight=75 height=180 maxHR=185 restHR=48 VO2max=52"
        )
        return
    save_memory("physical_stats", text)
    await update.message.reply_text("✅ Physical stats saved: " + text)


async def cmd_remember(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text:
        await update.message.reply_text("Example: /remember left knee niggle when running over 25km")
        return
    save_memory("athlete_note", text)
    await update.message.reply_text("Got it, remembered: " + text)


async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        db.table("conversations").delete().neq("id", 0).execute()
        await update.message.reply_text("Conversation history cleared. Memories kept.")
    except Exception as e:
        await update.message.reply_text("Error: " + str(e))


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
            "1) My recovery status based on last night's sleep and HRV " +
            "2) Whether to train hard, easy or rest today and why " +
            "3) If training, the specific session I should do with target pace and HR zone " +
            "4) One motivational note about my London Marathon or ultra progress"
        )
        await bot.send_message(chat_id=CHAT_ID, text="Good morning Luke! 🌅\n\n" + briefing)
    except Exception as e:
        log.error("Morning briefing error: " + str(e))


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("load", cmd_load))
    app.add_handler(CommandHandler("sync", cmd_sync))
    app.add_handler(CommandHandler("week", cmd_week))
    app.add_handler(CommandHandler("recovery", cmd_recovery))
    app.add_handler(CommandHandler("plan", cmd_plan))
    app.add_handler(CommandHandler("setphysical", cmd_setphysical))
    app.add_handler(CommandHandler("remember", cmd_remember))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("showsleep", cmd_showsleep))
    app.add_handler(CommandHandler("showtraining", cmd_showtraining))
    app.add_handler(CommandHandler("debug", cmd_debug))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, msg))

    scheduler = AsyncIOScheduler()
    scheduler.add_job(morning_briefing, "cron", hour=7, minute=0, args=[app.bot])
    scheduler.start()

    log.info("V2 Bot started - Polar User ID: " + POLAR_USER_ID)
    app.run_polling()


main()