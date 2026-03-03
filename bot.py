"""
bot.py - Polar Running Coach Telegram Bot v3
Athlete: Luke Worgan | Goal: London Marathon + Ultra marathons
Watch: Polar Grit X2
Deployed on: Railway.app
"""

import os
import re
import json
import logging
import threading
import time
import requests
from datetime import datetime, timedelta, timezone
from supabase import create_client
import anthropic
import telebot

# ── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ── Environment variables ──────────────────────────────────────────────────
TELEGRAM_TOKEN      = os.environ["TELEGRAM_TOKEN"]
ANTHROPIC_API_KEY   = os.environ["ANTHROPIC_API_KEY"]
POLAR_ACCESS_TOKEN  = os.environ["POLAR_ACCESS_TOKEN"]
POLAR_CLIENT_ID     = os.environ["POLAR_CLIENT_ID"]
POLAR_CLIENT_SECRET = os.environ["POLAR_CLIENT_SECRET"]
POLAR_USER_ID       = os.environ["POLAR_USER_ID"]
YOUR_TELEGRAM_ID    = int(os.environ["YOUR_TELEGRAM_ID"])
SUPABASE_URL        = os.environ["SUPABASE_URL"]
SUPABASE_KEY        = os.environ["SUPABASE_KEY"]

# ── Clients ────────────────────────────────────────────────────────────────
bot      = telebot.TeleBot(TELEGRAM_TOKEN)
claude   = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

ALLOWED_SPORTS = {"RUNNING", "TRAIL_RUNNING", "TREADMILL_RUNNING"}
POLAR_BASE     = "https://www.polaraccesslink.com/v3"

# ── Helpers ────────────────────────────────────────────────────────────────
def polar_headers():
    return {"Authorization": f"Bearer {POLAR_ACCESS_TOKEN}", "Accept": "application/json"}

def parse_pt_seconds(pt: str) -> float:
    if not pt:
        return 0.0
    m = re.match(r"PT([\d.]+)S$", pt)
    if m:
        return float(m.group(1))
    hours = re.search(r"(\d+)H", pt)
    mins  = re.search(r"(\d+)M", pt)
    secs  = re.search(r"([\d.]+)S", pt)
    total = 0.0
    if hours: total += float(hours.group(1)) * 3600
    if mins:  total += float(mins.group(1)) * 60
    if secs:  total += float(secs.group(1))
    return total

def seconds_to_pace(seconds: float) -> str:
    if not seconds or seconds <= 0:
        return "N/A"
    return f"{int(seconds // 60)}:{int(seconds % 60):02d} /km"

def sf(v):
    try: return float(v) if v not in (None, "", "N/A") else None
    except: return None

def si(v):
    try: return int(float(v)) if v not in (None, "", "N/A") else None
    except: return None

def parse_zones(zone_list: list) -> list:
    return [{
        "zone":    z.get("zoneIndex"),
        "lower":   z.get("lowerLimit"),
        "upper":   z.get("higherLimit"),
        "seconds": parse_pt_seconds(z.get("inZone", "PT0S")),
    } for z in zone_list]

def get_latest_run_with_splits():
    """Find the most recent run that actually has km splits saved."""
    try:
        runs = supabase.table("polar_exercises")\
            .select("polar_exercise_id,date,distance_meters,sport")\
            .order("date", desc=True).limit(30).execute()
        for run in runs.data:
            check = supabase.table("polar_km_splits")\
                .select("id")\
                .eq("exercise_id", run["polar_exercise_id"])\
                .limit(1).execute()
            if check.data:
                return run
    except Exception as e:
        log.error(f"get_latest_run_with_splits error: {e}")
    return None

# ── Save exercise to Supabase ──────────────────────────────────────────────
def save_exercise_to_supabase(session_json: dict, exercise_id: str) -> int:
    try:
        exercises = session_json.get("exercises", [])
        if not exercises:
            return 0

        ex    = exercises[0]
        sport = ex.get("sport", "")
        if isinstance(sport, dict):
            sport = sport.get("name", "").upper().replace(" ", "_")
        if sport not in ALLOWED_SPORTS:
            return 0

        start_time = ex.get("startTime", session_json.get("startTime", ""))
        hr         = ex.get("heartRate", {})
        speed      = ex.get("speed", {})
        cadence    = ex.get("cadence", {})
        power      = ex.get("power", {})
        altitude   = ex.get("altitude", {})
        load       = ex.get("loadInformation", {})
        zones      = ex.get("zones", {})
        duration_s = parse_pt_seconds(ex.get("duration", ""))

        supabase.table("polar_exercises").upsert({
            "polar_exercise_id": exercise_id,
            "date":              start_time,
            "sport":             sport,
            "duration_seconds":  si(duration_s),
            "distance_meters":   sf(ex.get("distance")),
            "calories":          si(ex.get("kiloCalories")),
            "avg_heart_rate":    si(hr.get("avg")),
            "max_heart_rate":    si(hr.get("max")),
            "min_heart_rate":    si(hr.get("min")),
            "avg_speed_ms":      sf(speed.get("avg")),
            "max_speed_ms":      sf(speed.get("max")),
            "avg_cadence":       si(cadence.get("avg")),
            "max_cadence":       si(cadence.get("max")),
            "avg_power":         si(power.get("avg")),
            "max_power":         si(power.get("max")),
            "ascent":            sf(ex.get("ascent")),
            "descent":           sf(ex.get("descent")),
            "altitude_min":      sf(altitude.get("min")),
            "altitude_avg":      sf(altitude.get("avg")),
            "altitude_max":      sf(altitude.get("max")),
            "training_load":     sf(load.get("cardioLoad")),
            "muscle_load":       sf(load.get("muscleLoad")),
            "hr_zones":          json.dumps(parse_zones(zones.get("heart_rate", []))),
            "power_zones":       json.dumps(parse_zones(zones.get("power", []))),
            "auto_laps":         json.dumps(ex.get("autoLaps", [])),
            "raw_json":          json.dumps(session_json),
        }, on_conflict="polar_exercise_id").execute()

        # KM Splits
        split_rows = []
        for lap in ex.get("autoLaps", []):
            lap_dur = parse_pt_seconds(lap.get("duration", ""))
            lhr     = lap.get("heartRate", {})
            lspd    = lap.get("speed", {})
            lcad    = lap.get("cadence", {})
            lpwr    = lap.get("power", {})
            lap_num = lap.get("lapNumber", 0)
            split_rows.append({
                "exercise_id":        exercise_id,
                "session_date":       start_time[:10],
                "lap_number":         lap_num,
                "km_number":          lap_num + 1,
                "duration_seconds":   sf(lap_dur),
                "split_time_seconds": sf(parse_pt_seconds(lap.get("splitTime", ""))),
                "distance_m":         sf(lap.get("distance", 1000.0)),
                "pace_min_per_km":    sf(lap_dur / 60) if lap_dur else None,
                "pace_display":       seconds_to_pace(lap_dur),
                "hr_min":             si(lhr.get("min")),
                "hr_avg":             si(lhr.get("avg")),
                "hr_max":             si(lhr.get("max")),
                "speed_avg_ms":       sf(lspd.get("avg")),
                "speed_max_ms":       sf(lspd.get("max")),
                "cadence_avg":        si(lcad.get("avg")),
                "cadence_max":        si(lcad.get("max")),
                "ascent_m":           sf(lap.get("ascent", 0.0)),
                "descent_m":          sf(lap.get("descent", 0.0)),
                "power_avg":          si(lpwr.get("avg")),
                "power_max":          si(lpwr.get("max")),
            })

        if split_rows:
            supabase.table("polar_km_splits").upsert(
                split_rows, on_conflict="exercise_id,lap_number"
            ).execute()

        log.info(f"Saved {exercise_id}: {sport} {(ex.get('distance') or 0)/1000:.1f}km, {len(split_rows)} splits")
        return len(split_rows)

    except Exception as e:
        log.error(f"Save exercise error: {e}")
        return 0

# ── Polar sync ─────────────────────────────────────────────────────────────
def sync_new_polar_exercises() -> list:
    try:
        r = requests.post(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/exercise-transactions",
            headers=polar_headers()
        )
        if r.status_code == 204:
            log.info("No new Polar exercises")
            return []
        if not r.ok:
            log.error(f"Polar transaction error: {r.status_code} {r.text}")
            return []

        transaction    = r.json()
        transaction_id = transaction.get("transaction-id")
        exercise_urls  = transaction.get("resource-uri", [])

        new_exercises = []
        for url in exercise_urls:
            resp = requests.get(url, headers=polar_headers())
            if resp.ok:
                ex_data = resp.json()
                ex_id   = str(url).split("/")[-1]
                splits  = save_exercise_to_supabase(ex_data, ex_id)
                new_exercises.append({"id": ex_id, "data": ex_data, "splits": splits})

        requests.put(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/exercise-transactions/{transaction_id}",
            headers=polar_headers()
        )
        return new_exercises

    except Exception as e:
        log.error(f"Polar sync error: {e}")
        return []

# ── Supabase context ───────────────────────────────────────────────────────
def build_training_context() -> str:
    try:
        parts = []

        # Recent runs
        runs = supabase.table("polar_exercises")\
            .select("polar_exercise_id,date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,ascent,descent")\
            .order("date", desc=True).limit(10).execute()

        if runs.data:
            parts.append("=== RECENT RUNS (last 10) ===")
            for r in runs.data:
                dist_km = (r.get("distance_meters") or 0) / 1000
                dur_s   = r.get("duration_seconds") or 0
                pace_s  = dur_s / dist_km if dist_km else 0
                parts.append(
                    f"  {r['date'][:10]} | {r.get('sport','?')} | {dist_km:.1f}km | "
                    f"{int(dur_s//60)}min | Pace: {seconds_to_pace(pace_s)} | "
                    f"HR: {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')} | "
                    f"Power: {r.get('avg_power','?')}W | Cadence: {r.get('avg_cadence','?')} | "
                    f"Load: {r.get('training_load','?')} | Ascent: {r.get('ascent','?')}m"
                )

            # Splits for most recent run that HAS splits
            latest = get_latest_run_with_splits()
            if latest:
                splits = supabase.table("polar_km_splits")\
                    .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg,ascent_m,descent_m")\
                    .eq("exercise_id", latest["polar_exercise_id"])\
                    .order("lap_number").execute()

                if splits.data:
                    dist_km = (latest.get("distance_meters") or 0) / 1000
                    parts.append(f"\n=== KM SPLITS: {latest['date'][:10]} ({dist_km:.1f}km {latest.get('sport','')}) ===")
                    for s in splits.data:
                        parts.append(
                            f"  KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | "
                            f"HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | "
                            f"Power {s.get('power_avg','?')}W | Cadence {s.get('cadence_avg','?')} | "
                            f"↑{s.get('ascent_m',0):.0f}m ↓{s.get('descent_m',0):.0f}m"
                        )

        # Weekly load
        now             = datetime.now(timezone.utc)
        week_start      = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        last_week_start = (now - timedelta(days=now.weekday()+7)).strftime("%Y-%m-%d")

        this_week = supabase.table("polar_exercises").select("training_load,distance_meters")\
            .gte("date", week_start).execute()
        last_week = supabase.table("polar_exercises").select("training_load,distance_meters")\
            .gte("date", last_week_start).lt("date", week_start).execute()

        def sum_load(rows): return sum(r.get("training_load") or 0 for r in rows)
        def sum_km(rows):   return sum((r.get("distance_meters") or 0)/1000 for r in rows)

        parts.append(f"\n=== WEEKLY TRAINING LOAD ===")
        parts.append(f"  This week: Load {sum_load(this_week.data):.0f} | {sum_km(this_week.data):.1f}km | {len(this_week.data)} sessions")
        parts.append(f"  Last week: Load {sum_load(last_week.data):.0f} | {sum_km(last_week.data):.1f}km | {len(last_week.data)} sessions")

        # Sleep
        sleep = supabase.table("polar_sleep")\
            .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv")\
            .order("date", desc=True).limit(7).execute()

        if sleep.data:
            parts.append("\n=== SLEEP (last 7 nights) ===")
            for s in sleep.data:
                total_s = s.get("total_sleep_seconds") or 0
                parts.append(
                    f"  {s['date']} | {total_s//3600}h{(total_s%3600)//60}m | "
                    f"Score: {s.get('sleep_score','?')} | "
                    f"REM: {(s.get('rem_seconds') or 0)//60}min | "
                    f"Deep: {(s.get('deep_sleep_seconds') or 0)//60}min | "
                    f"HRV: {s.get('avg_hrv','?')}"
                )

        # HRV
        hrv = supabase.table("polar_hrv")\
            .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
            .order("date", desc=True).limit(1).execute()

        if hrv.data:
            h = hrv.data[0]
            parts.append(f"\n=== NIGHTLY RECHARGE ({h['date']}) ===")
            parts.append(
                f"  Status: {h.get('recharge_status','?')} | "
                f"ANS: {h.get('ans_charge','?')} | "
                f"Sleep charge: {h.get('sleep_charge','?')} | "
                f"HRV: {h.get('hrv_avg','?')} | RMSSD: {h.get('hrv_rmssd','?')}"
            )

        return "\n".join(parts)

    except Exception as e:
        log.error(f"Context error: {e}")
        return "Training data temporarily unavailable."

# ── Claude system prompt ───────────────────────────────────────────────────
BASE_SYSTEM = """You are an expert running coach for Luke Worgan, training for the London Marathon and ultra marathons. Luke uses a Polar Grit X2.

Luke's stats:
- DOB: 1989-03-03 | Height: 167cm | Weight: 78kg
- VO2max: 55 | Max HR: 198 | Resting HR: 47
- Aerobic threshold: 149bpm | Anaerobic threshold: 178bpm | FTP: 272W

Coaching style:
- Data-driven but conversational — reference Luke's actual numbers
- Honest about fatigue and recovery — flag risks, don't just encourage
- Focus on London Marathon time goal and ultra readiness
- Show km splits as a clear table when relevant
- Use min/km for pace, bpm for HR, watts for power"""

def build_system_prompt() -> str:
    return f"{BASE_SYSTEM}\n\n{build_training_context()}"

# ── Conversation history ───────────────────────────────────────────────────
conversation_history = {}

def get_history(chat_id):
    return conversation_history.get(chat_id, [])

def add_to_history(chat_id, role, content):
    if chat_id not in conversation_history:
        conversation_history[chat_id] = []
    conversation_history[chat_id].append({"role": role, "content": content})
    conversation_history[chat_id] = conversation_history[chat_id][-20:]

# ── Run notification formatter ─────────────────────────────────────────────
def format_run_notification(session_json: dict, exercise_id: str, splits_count: int) -> str:
    try:
        ex      = session_json.get("exercises", [{}])[0]
        sport   = ex.get("sport", "RUN")
        if isinstance(sport, dict):
            sport = sport.get("name", "RUN")
        dist_km = (ex.get("distance") or 0) / 1000
        dur_s   = parse_pt_seconds(ex.get("duration", ""))
        hr      = ex.get("heartRate", {})
        power   = ex.get("power", {})
        cadence = ex.get("cadence", {})
        load    = ex.get("loadInformation", {})
        pace_s  = dur_s / dist_km if dist_km else 0
        emoji   = "🏔️" if "TRAIL" in sport else "🏃"

        lines = [
            f"{emoji} *New {sport.replace('_',' ').title()} Synced*",
            f"📅 {ex.get('startTime','')[:10]}",
            f"📏 {dist_km:.2f}km | ⏱ {int(dur_s//60)}min | 💨 {seconds_to_pace(pace_s)}",
            f"❤️ HR: {hr.get('avg','?')}/{hr.get('max','?')}bpm",
            f"⚡ Power: {power.get('avg','?')}W | 👟 Cadence: {cadence.get('avg','?')}spm",
            f"⬆️ Ascent: {ex.get('ascent',0):.0f}m | 🔥 Load: {load.get('cardioLoad','?')}",
            f"📊 {splits_count} km splits saved",
        ]

        if splits_count > 0:
            split_data = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,power_avg")\
                .eq("exercise_id", exercise_id).order("lap_number").limit(5).execute()
            if split_data.data:
                lines.append("\n*First splits:*")
                for s in split_data.data:
                    lines.append(
                        f"  KM {s['km_number']} | {s.get('pace_display','?')} | "
                        f"HR {s.get('hr_avg','?')} | {s.get('power_avg','?')}W"
                    )

        return "\n".join(lines)
    except Exception as e:
        log.error(f"Format notification error: {e}")
        return "✅ New run synced"

# ── Morning briefing ───────────────────────────────────────────────────────
def send_morning_briefing():
    try:
        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=600,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": (
                "Give Luke his morning training briefing. Include: "
                "last night's sleep and recovery, today's recommended session, "
                "weekly load vs last week, any flags from recent training. "
                "Be concise — this is a morning message."
            )}]
        )
        bot.send_message(
            YOUR_TELEGRAM_ID,
            f"☀️ *Morning Briefing*\n\n{response.content[0].text}",
            parse_mode="Markdown"
        )
        log.info("Morning briefing sent")
    except Exception as e:
        log.error(f"Briefing error: {e}")

# ── Background: Polar sync every 5 min ────────────────────────────────────
def polar_sync_loop():
    while True:
        try:
            new = sync_new_polar_exercises()
            for ex in new:
                msg = format_run_notification(ex["data"], ex["id"], ex["splits"])
                bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode="Markdown")
        except Exception as e:
            log.error(f"Sync loop error: {e}")
        time.sleep(300)

# ── Background: 7am daily briefing ────────────────────────────────────────
def scheduler_loop():
    while True:
        now    = datetime.now(timezone.utc)
        target = now.replace(hour=7, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        wait = (target - now).total_seconds()
        log.info(f"Next briefing in {wait/3600:.1f}h")
        time.sleep(wait)
        send_morning_briefing()

# ── Telegram handlers ──────────────────────────────────────────────────────
@bot.message_handler(func=lambda m: True)
def handle_message(message):
    chat_id   = message.chat.id
    if chat_id != YOUR_TELEGRAM_ID:
        bot.reply_to(message, "Unauthorised.")
        return

    user_text = message.text.strip()

    if user_text.lower() in ["/start", "/help"]:
        bot.reply_to(message, (
            "👋 Hey Luke! I'm your Polar running coach.\n\n"
            "I have your full training history, sleep, HRV and km splits.\n\n"
            "/sync — check for new runs\n"
            "/briefing — morning briefing now\n"
            "/splits — km splits for last run\n"
            "/load — weekly training load\n"
            "/clear — clear conversation"
        ))
        return

    if user_text.lower() == "/sync":
        bot.reply_to(message, "🔄 Checking Polar...")
        new = sync_new_polar_exercises()
        if new:
            for ex in new:
                bot.send_message(
                    chat_id,
                    format_run_notification(ex["data"], ex["id"], ex["splits"]),
                    parse_mode="Markdown"
                )
        else:
            bot.send_message(chat_id, "No new exercises found.")
        return

    if user_text.lower() == "/briefing":
        bot.reply_to(message, "⏳ Generating briefing...")
        send_morning_briefing()
        return

    if user_text.lower() == "/splits":
        try:
            ex = get_latest_run_with_splits()
            if not ex:
                bot.reply_to(message, "No runs with splits found.")
                return

            splits = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg,ascent_m,descent_m")\
                .eq("exercise_id", ex["polar_exercise_id"])\
                .order("lap_number").execute()

            dist_km = (ex.get("distance_meters") or 0) / 1000
            lines   = [f"📊 *{ex['date'][:10]} — {dist_km:.1f}km {ex.get('sport','')}*\n"]
            for s in splits.data:
                lines.append(
                    f"KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | "
                    f"HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | "
                    f"{s.get('power_avg','?')}W | "
                    f"↑{s.get('ascent_m',0):.0f}m"
                )
            bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    if user_text.lower() == "/load":
        try:
            ctx   = build_training_context()
            lines = [l for l in ctx.split("\n") if "WEEKLY" in l or "week" in l.lower()]
            bot.reply_to(message, "\n".join(lines) or "Load data unavailable.")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    if user_text.lower() == "/clear":
        conversation_history[chat_id] = []
        bot.reply_to(message, "Conversation cleared.")
        return

    # Main Claude chat
    try:
        bot.send_chat_action(chat_id, "typing")
        add_to_history(chat_id, "user", user_text)

        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=1000,
            system=build_system_prompt(),
            messages=get_history(chat_id)
        )

        reply = response.content[0].text
        add_to_history(chat_id, "assistant", reply)

        if len(reply) > 4000:
            for i in range(0, len(reply), 4000):
                bot.send_message(chat_id, reply[i:i+4000], parse_mode="Markdown")
        else:
            bot.reply_to(message, reply, parse_mode="Markdown")

    except Exception as e:
        log.error(f"Claude error: {e}")
        bot.reply_to(message, f"Error: {e}")

# ── Main ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("🏃 Polar Running Coach Bot v3 starting...")
    threading.Thread(target=polar_sync_loop, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    bot.infinity_polling(interval=1, timeout=30)