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
import asyncio
import requests
from datetime import datetime, timedelta, timezone
from supabase import create_client
import anthropic
import telebot
from telebot.async_telebot import AsyncTeleBot

# ── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
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
bot       = AsyncTeleBot(TELEGRAM_TOKEN)
claude    = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
supabase  = create_client(SUPABASE_URL, SUPABASE_KEY)

ALLOWED_SPORTS = {"RUNNING", "TRAIL_RUNNING", "TREADMILL_RUNNING"}

# ── Polar API helpers ──────────────────────────────────────────────────────
POLAR_BASE = "https://www.polaraccesslink.com/v3"

def polar_headers():
    return {
        "Authorization": f"Bearer {POLAR_ACCESS_TOKEN}",
        "Accept": "application/json",
    }

# ── Data parsing helpers ───────────────────────────────────────────────────
def parse_pt_seconds(pt: str) -> float:
    """Convert PT7250.150S or PT1H30M10S to total seconds."""
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
    """414 seconds → '6:54 /km'"""
    if not seconds or seconds <= 0:
        return "N/A"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d} /km"

def sf(v):
    try: return float(v) if v not in (None, "", "N/A") else None
    except: return None

def si(v):
    try: return int(float(v)) if v not in (None, "", "N/A") else None
    except: return None

def parse_zones(zone_list: list) -> list:
    out = []
    for z in zone_list:
        out.append({
            "zone": z.get("zoneIndex"),
            "lower": z.get("lowerLimit"),
            "upper": z.get("higherLimit"),
            "seconds": parse_pt_seconds(z.get("inZone", "PT0S")),
        })
    return out

# ── Save exercise to Supabase ──────────────────────────────────────────────
def save_exercise_to_supabase(session_json: dict, exercise_id: str):
    """Parse Polar exercise JSON and upsert into polar_exercises + polar_km_splits."""
    try:
        exercises = session_json.get("exercises", [])
        if not exercises:
            return 0

        ex      = exercises[0]
        sport   = ex.get("sport", "")
        if isinstance(sport, dict):
            sport = sport.get("name", "").upper().replace(" ", "_")

        if sport not in ALLOWED_SPORTS:
            log.info(f"Skipping sport: {sport}")
            return 0

        start_time = ex.get("startTime", session_json.get("startTime", ""))

        hr       = ex.get("heartRate", {})
        speed    = ex.get("speed", {})
        cadence  = ex.get("cadence", {})
        power    = ex.get("power", {})
        altitude = ex.get("altitude", {})
        load     = ex.get("loadInformation", {})
        zones    = ex.get("zones", {})
        duration_s = parse_pt_seconds(ex.get("duration", ""))

        exercise_row = {
            "polar_exercise_id":  exercise_id,
            "date":               start_time,
            "sport":              sport,
            "duration_seconds":   si(duration_s),
            "distance_meters":    sf(ex.get("distance")),
            "calories":           si(ex.get("kiloCalories")),
            "avg_heart_rate":     si(hr.get("avg")),
            "max_heart_rate":     si(hr.get("max")),
            "min_heart_rate":     si(hr.get("min")),
            "avg_speed_ms":       sf(speed.get("avg")),
            "max_speed_ms":       sf(speed.get("max")),
            "avg_cadence":        si(cadence.get("avg")),
            "max_cadence":        si(cadence.get("max")),
            "avg_power":          si(power.get("avg")),
            "max_power":          si(power.get("max")),
            "ascent":             sf(ex.get("ascent")),
            "descent":            sf(ex.get("descent")),
            "altitude_min":       sf(altitude.get("min")),
            "altitude_avg":       sf(altitude.get("avg")),
            "altitude_max":       sf(altitude.get("max")),
            "training_load":      sf(load.get("cardioLoad")),
            "muscle_load":        sf(load.get("muscleLoad")),
            "hr_zones":           json.dumps(parse_zones(zones.get("heart_rate", []))),
            "power_zones":        json.dumps(parse_zones(zones.get("power", []))),
            "auto_laps":          json.dumps(ex.get("autoLaps", [])),
            "raw_json":           json.dumps(session_json),
        }

        supabase.table("polar_exercises").upsert(
            exercise_row, on_conflict="polar_exercise_id"
        ).execute()

        # ── KM Splits ──
        laps = ex.get("autoLaps", [])
        split_rows = []
        for lap in laps:
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

        log.info(f"Saved exercise {exercise_id}: {sport} {ex.get('distance',0)/1000:.1f}km, {len(split_rows)} splits")
        return len(split_rows)

    except Exception as e:
        log.error(f"Error saving exercise {exercise_id}: {e}")
        return 0

# ── Polar exercise sync ────────────────────────────────────────────────────
def sync_new_polar_exercises():
    """Check for new exercises via Polar AccessLink transaction API."""
    try:
        # Create transaction
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

        transaction = r.json()
        transaction_id = transaction.get("transaction-id")
        exercise_urls  = transaction.get("resource-uri", [])

        new_exercises = []
        for url in exercise_urls:
            resp = requests.get(url, headers=polar_headers())
            if resp.ok:
                ex_data = resp.json()
                ex_id   = str(url).split("/")[-1]
                splits  = save_exercise_to_supabase(ex_data, ex_id)
                new_exercises.append({
                    "id": ex_id,
                    "data": ex_data,
                    "splits": splits
                })

        # Commit transaction
        requests.put(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/exercise-transactions/{transaction_id}",
            headers=polar_headers()
        )

        return new_exercises

    except Exception as e:
        log.error(f"Polar sync error: {e}")
        return []

# ── Supabase context builder ───────────────────────────────────────────────
def build_training_context() -> str:
    """Query Supabase and build a training context string for Claude."""
    try:
        context_parts = []

        # ── Recent runs ──
        runs = supabase.table("polar_exercises")\
            .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,muscle_load,ascent,descent")\
            .order("date", desc=True)\
            .limit(10)\
            .execute()

        if runs.data:
            context_parts.append("=== RECENT RUNS (last 10) ===")
            for r in runs.data:
                dist_km  = f"{r['distance_meters']/1000:.1f}km" if r.get("distance_meters") else "?"
                dur_min  = f"{int(r['duration_seconds']//60)}min" if r.get("duration_seconds") else "?"
                pace_s   = r["duration_seconds"] / (r["distance_meters"] / 1000) if r.get("distance_meters") and r.get("duration_seconds") else 0
                pace_str = seconds_to_pace(pace_s) if pace_s else "?"
                date_str = r["date"][:10] if r.get("date") else "?"
                context_parts.append(
                    f"  {date_str} | {r.get('sport','?')} | {dist_km} | {dur_min} | "
                    f"Pace: {pace_str} | HR avg: {r.get('avg_heart_rate','?')} max: {r.get('max_heart_rate','?')} | "
                    f"Power: {r.get('avg_power','?')}W | Cadence: {r.get('avg_cadence','?')}spm | "
                    f"Load: {r.get('training_load','?')} | Ascent: {r.get('ascent','?')}m"
                )

        # ── Most recent run km splits ──
        if runs.data:
            latest_id = None
            # Get polar_exercise_id for most recent
            latest = supabase.table("polar_exercises")\
                .select("polar_exercise_id,date,distance_meters")\
                .order("date", desc=True)\
                .limit(1)\
                .execute()

            if latest.data:
                latest_id   = latest.data[0]["polar_exercise_id"]
                latest_date = latest.data[0]["date"][:10]
                latest_dist = latest.data[0].get("distance_meters", 0)

                splits = supabase.table("polar_km_splits")\
                    .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg,ascent_m,descent_m")\
                    .eq("exercise_id", latest_id)\
                    .order("lap_number")\
                    .execute()

                if splits.data:
                    context_parts.append(f"\n=== KM SPLITS: Most recent run ({latest_date}, {latest_dist/1000:.1f}km) ===")
                    for s in splits.data:
                        context_parts.append(
                            f"  KM {s['km_number']:2d} | {s.get('pace_display','?')} | "
                            f"HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | "
                            f"Power {s.get('power_avg','?')}W | "
                            f"Cadence {s.get('cadence_avg','?')} | "
                            f"↑{s.get('ascent_m',0):.0f}m ↓{s.get('descent_m',0):.0f}m"
                        )

        # ── Weekly load ──
        now   = datetime.now(timezone.utc)
        week_start      = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        last_week_start = (now - timedelta(days=now.weekday()+7)).strftime("%Y-%m-%d")

        this_week = supabase.table("polar_exercises")\
            .select("training_load,distance_meters")\
            .gte("date", week_start)\
            .execute()

        last_week = supabase.table("polar_exercises")\
            .select("training_load,distance_meters")\
            .gte("date", last_week_start)\
            .lt("date", week_start)\
            .execute()

        def sum_load(rows):
            return sum(r.get("training_load") or 0 for r in rows)
        def sum_km(rows):
            return sum((r.get("distance_meters") or 0) / 1000 for r in rows)

        context_parts.append(f"\n=== WEEKLY TRAINING LOAD ===")
        context_parts.append(f"  This week:  Load {sum_load(this_week.data):.0f} | {sum_km(this_week.data):.1f}km | {len(this_week.data)} sessions")
        context_parts.append(f"  Last week:  Load {sum_load(last_week.data):.0f} | {sum_km(last_week.data):.1f}km | {len(last_week.data)} sessions")

        # ── Sleep last 7 days ──
        sleep = supabase.table("polar_sleep")\
            .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv")\
            .order("date", desc=True)\
            .limit(7)\
            .execute()

        if sleep.data:
            context_parts.append("\n=== SLEEP (last 7 nights) ===")
            for s in sleep.data:
                total_hrs = f"{s['total_sleep_seconds']//3600}h{(s['total_sleep_seconds']%3600)//60}m" if s.get("total_sleep_seconds") else "?"
                context_parts.append(
                    f"  {s['date']} | {total_hrs} | Score: {s.get('sleep_score','?')} | "
                    f"REM: {(s.get('rem_seconds') or 0)//60}min | Deep: {(s.get('deep_sleep_seconds') or 0)//60}min | "
                    f"HRV: {s.get('avg_hrv','?')}"
                )

        # ── Latest HRV / Nightly Recharge ──
        hrv = supabase.table("polar_hrv")\
            .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
            .order("date", desc=True)\
            .limit(1)\
            .execute()

        if hrv.data:
            h = hrv.data[0]
            context_parts.append(f"\n=== NIGHTLY RECHARGE (latest: {h['date']}) ===")
            context_parts.append(
                f"  Status: {h.get('recharge_status','?')} | ANS charge: {h.get('ans_charge','?')} | "
                f"Sleep charge: {h.get('sleep_charge','?')} | HRV avg: {h.get('hrv_avg','?')} | "
                f"RMSSD: {h.get('hrv_rmssd','?')}"
            )

        return "\n".join(context_parts)

    except Exception as e:
        log.error(f"Context build error: {e}")
        return "Training data temporarily unavailable."

# ── Claude system prompt ───────────────────────────────────────────────────
BASE_SYSTEM_PROMPT = """You are an expert running coach for Luke Worgan, a dedicated runner training for the London Marathon and ultra marathons. Luke uses a Polar Grit X2 watch.

Luke's key stats:
- DOB: 1989-03-03 (age 36)
- Height: 167cm | Weight: 78kg
- VO2max: 55
- Max HR: 198 | Resting HR: 47
- Aerobic threshold: 149bpm | Anaerobic threshold: 178bpm
- Functional Threshold Power (FTP): 272W

Your coaching style:
- Data-driven but conversational — reference specific numbers from Luke's actual training
- Honest about fatigue and recovery — don't just encourage, flag risks
- Focus on the bigger picture: London Marathon time goal and ultra readiness
- When showing km splits, format them clearly as a table
- Use pace in min/km, HR in bpm, power in watts

Always use the live training data provided below to inform your responses."""

def build_system_prompt() -> str:
    training_context = build_training_context()
    return f"{BASE_SYSTEM_PROMPT}\n\n{training_context}"

# ── Conversation history (in-memory per session) ───────────────────────────
conversation_history = {}

def get_history(chat_id: int) -> list:
    return conversation_history.get(chat_id, [])

def add_to_history(chat_id: int, role: str, content: str):
    if chat_id not in conversation_history:
        conversation_history[chat_id] = []
    conversation_history[chat_id].append({"role": role, "content": content})
    # Keep last 20 messages
    if len(conversation_history[chat_id]) > 20:
        conversation_history[chat_id] = conversation_history[chat_id][-20:]

# ── Format new run notification ────────────────────────────────────────────
def format_run_notification(session_json: dict, exercise_id: str, splits_count: int) -> str:
    try:
        ex       = session_json.get("exercises", [{}])[0]
        sport    = ex.get("sport", "RUN")
        dist_km  = (ex.get("distance", 0) or 0) / 1000
        dur_s    = parse_pt_seconds(ex.get("duration", ""))
        dur_min  = int(dur_s // 60)
        hr       = ex.get("heartRate", {})
        power    = ex.get("power", {})
        cadence  = ex.get("cadence", {})
        load     = ex.get("loadInformation", {})
        pace_s   = dur_s / dist_km if dist_km else 0
        date_str = ex.get("startTime", "")[:10]

        emoji = "🏃" if sport == "RUNNING" else "🏔️" if sport == "TRAIL_RUNNING" else "🏃"

        lines = [
            f"{emoji} *New {sport.replace('_',' ').title()} Synced*",
            f"📅 {date_str}",
            f"📏 {dist_km:.2f}km | ⏱ {dur_min}min | 💨 {seconds_to_pace(pace_s)}",
            f"❤️ HR: {hr.get('avg','?')}/{hr.get('max','?')}bpm",
            f"⚡ Power: {power.get('avg','?')}W avg | 👟 Cadence: {cadence.get('avg','?')}spm",
            f"⬆️ Ascent: {ex.get('ascent',0):.0f}m | 🔥 Load: {load.get('cardioLoad','?')}",
            f"📊 {splits_count} km splits saved",
        ]

        # Add first few splits if available
        if splits_count > 0:
            split_data = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,power_avg")\
                .eq("exercise_id", exercise_id)\
                .order("lap_number")\
                .limit(5)\
                .execute()

            if split_data.data:
                lines.append("\n*First km splits:*")
                for s in split_data.data:
                    lines.append(
                        f"  KM {s['km_number']} | {s.get('pace_display','?')} | "
                        f"HR {s.get('hr_avg','?')} | {s.get('power_avg','?')}W"
                    )

        return "\n".join(lines)

    except Exception as e:
        log.error(f"Format run notification error: {e}")
        return "✅ New run synced to Supabase"

# ── Morning briefing ───────────────────────────────────────────────────────
async def send_morning_briefing():
    """Send daily 7am briefing to Luke."""
    try:
        context = build_training_context()
        prompt  = (
            "Give Luke his morning training briefing. Include: "
            "last night's sleep and recovery status, "
            "today's recommended training (type, duration, effort), "
            "weekly load so far vs last week, "
            "any patterns or flags from recent training. "
            "Be concise — this is a morning message, not an essay."
        )

        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=600,
            system=f"{BASE_SYSTEM_PROMPT}\n\n{context}",
            messages=[{"role": "user", "content": prompt}]
        )

        briefing = f"☀️ *Morning Briefing*\n\n{response.content[0].text}"
        await bot.send_message(YOUR_TELEGRAM_ID, briefing, parse_mode="Markdown")
        log.info("Morning briefing sent")

    except Exception as e:
        log.error(f"Morning briefing error: {e}")

# ── Polar sync check (runs periodically) ──────────────────────────────────
async def check_polar_sync():
    """Periodically check for new Polar exercises."""
    while True:
        try:
            new_exercises = sync_new_polar_exercises()
            for ex in new_exercises:
                msg = format_run_notification(ex["data"], ex["id"], ex["splits"])
                await bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode="Markdown")
        except Exception as e:
            log.error(f"Polar sync loop error: {e}")
        await asyncio.sleep(300)  # Check every 5 minutes

# ── Telegram message handler ───────────────────────────────────────────────
@bot.message_handler(func=lambda m: True)
async def handle_message(message):
    chat_id = message.chat.id

    # Security: only respond to Luke
    if chat_id != YOUR_TELEGRAM_ID:
        await bot.reply_to(message, "Unauthorised.")
        return

    user_text = message.text.strip()

    # Commands
    if user_text.lower() in ["/start", "/help"]:
        await bot.reply_to(message, (
            "👋 Hey Luke! I'm your Polar running coach.\n\n"
            "I have access to all your training data, sleep, HRV and km splits. "
            "Ask me anything about your training, or just chat.\n\n"
            "Commands:\n"
            "/sync — check for new runs\n"
            "/briefing — get your morning briefing now\n"
            "/splits — show km splits for last run\n"
            "/load — weekly training load summary\n"
            "/clear — clear conversation history"
        ))
        return

    if user_text.lower() == "/sync":
        await bot.reply_to(message, "🔄 Checking Polar for new exercises...")
        new = sync_new_polar_exercises()
        if new:
            for ex in new:
                msg = format_run_notification(ex["data"], ex["id"], ex["splits"])
                await bot.send_message(chat_id, msg, parse_mode="Markdown")
        else:
            await bot.send_message(chat_id, "No new exercises found.")
        return

    if user_text.lower() == "/briefing":
        await bot.reply_to(message, "⏳ Generating your briefing...")
        await send_morning_briefing()
        return

    if user_text.lower() == "/splits":
        try:
            latest = supabase.table("polar_exercises")\
                .select("polar_exercise_id,date,distance_meters,sport")\
                .order("date", desc=True).limit(1).execute()

            if not latest.data:
                await bot.reply_to(message, "No runs found.")
                return

            ex      = latest.data[0]
            ex_id   = ex["polar_exercise_id"]
            splits  = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg,ascent_m,descent_m")\
                .eq("exercise_id", ex_id).order("lap_number").execute()

            if not splits.data:
                await bot.reply_to(message, "No splits found for last run.")
                return

            dist_km = (ex.get("distance_meters") or 0) / 1000
            lines   = [f"📊 *Splits: {ex['date'][:10]} — {dist_km:.1f}km {ex.get('sport','')}*\n"]
            for s in splits.data:
                lines.append(
                    f"KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | "
                    f"HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | "
                    f"{s.get('power_avg','?')}W | "
                    f"↑{s.get('ascent_m',0):.0f}m"
                )

            await bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")
        except Exception as e:
            await bot.reply_to(message, f"Error fetching splits: {e}")
        return

    if user_text.lower() == "/load":
        try:
            context = build_training_context()
            # Extract just the weekly load section
            lines   = [l for l in context.split("\n") if "WEEKLY" in l or "week" in l.lower()]
            await bot.reply_to(message, "\n".join(lines) or "Load data unavailable.")
        except Exception as e:
            await bot.reply_to(message, f"Error: {e}")
        return

    if user_text.lower() == "/clear":
        conversation_history[chat_id] = []
        await bot.reply_to(message, "Conversation cleared.")
        return

    # ── Main Claude conversation ──
    try:
        await bot.send_chat_action(chat_id, "typing")

        add_to_history(chat_id, "user", user_text)

        system_prompt = build_system_prompt()
        history       = get_history(chat_id)

        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=1000,
            system=system_prompt,
            messages=history
        )

        reply = response.content[0].text
        add_to_history(chat_id, "assistant", reply)

        # Split long messages
        if len(reply) > 4000:
            for i in range(0, len(reply), 4000):
                await bot.send_message(chat_id, reply[i:i+4000], parse_mode="Markdown")
        else:
            await bot.reply_to(message, reply, parse_mode="Markdown")

    except Exception as e:
        log.error(f"Claude error: {e}")
        await bot.reply_to(message, f"Sorry, something went wrong: {e}")

# ── Scheduler ─────────────────────────────────────────────────────────────
async def scheduler():
    """Run daily morning briefing at 7am UTC."""
    while True:
        now = datetime.now(timezone.utc)
        # Calculate seconds until next 7am
        target = now.replace(hour=7, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        wait = (target - now).total_seconds()
        log.info(f"Next briefing in {wait/3600:.1f}h")
        await asyncio.sleep(wait)
        await send_morning_briefing()

# ── Main ───────────────────────────────────────────────────────────────────
async def main():
    log.info("🏃 Polar Running Coach Bot starting...")
    await asyncio.gather(
        bot.polling(non_stop=True, interval=1),
        check_polar_sync(),
        scheduler(),
    )

if __name__ == "__main__":
    asyncio.run(main())