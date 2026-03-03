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
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}/km"

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

def recharge_emoji(status: str) -> str:
    if not status:
        return "⚪"
    s = status.upper()
    if "GOOD" in s or "HIGH" in s:    return "🟢"
    if "MODERATE" in s or "OK" in s:  return "🟡"
    if "LOW" in s or "POOR" in s:     return "🔴"
    return "⚪"

def sport_emoji(sport: str) -> str:
    if "TRAIL" in sport: return "🏔️"
    if "TREADMILL" in sport: return "⚙️"
    return "🏃"

def fmt_date(date_str: str) -> str:
    """2026-02-27T10:40:06 → Feb 27"""
    try:
        return datetime.fromisoformat(date_str[:10]).strftime("%-d %b")
    except:
        return date_str[:10]

def detect_history_request(text: str) -> int | None:
    """
    Detect if the user is asking for more history than the default 10.
    Returns number of runs/days requested, or None if not a history request.
    e.g. 'show last 30 runs' → 30, 'last month' → 30, 'last 3 months' → 90
    """
    text = text.lower()
    # Explicit number: "last 20 runs", "show me 50 runs"
    m = re.search(r"last\s+(\d+)\s+runs?", text)
    if m:
        return min(int(m.group(1)), 200)
    # Month references
    m = re.search(r"last\s+(\d+)\s+months?", text)
    if m:
        return min(int(m.group(1)) * 30, 365)
    if "last month" in text:
        return 30
    if "last 3 months" in text or "last three months" in text:
        return 90
    if "last 6 months" in text or "last six months" in text:
        return 180
    if "all" in text and ("run" in text or "history" in text):
        return 200
    return None

def detect_recovery_window(text: str) -> int:
    """Returns number of days of sleep/recovery to fetch. Default 7."""
    text = text.lower()
    m = re.search(r"last\s+(\d+)\s+(?:days?|nights?)", text)
    if m:
        return min(int(m.group(1)), 90)
    if "last month" in text:  return 30
    if "last week" in text:   return 7
    if "last 2 weeks" in text or "last two weeks" in text: return 14
    return 7

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

# ── Formatting ─────────────────────────────────────────────────────────────
def format_run_list(runs: list) -> str:
    """Format a list of runs into clean Telegram output."""
    if not runs:
        return "No runs found."
    lines = [f"🏃 *Last {len(runs)} Runs*\n"]
    for r in runs:
        dist_km = (r.get("distance_meters") or 0) / 1000
        dur_s   = r.get("duration_seconds") or 0
        pace_s  = dur_s / dist_km if dist_km else 0
        emoji   = sport_emoji(r.get("sport", ""))
        load    = r.get("training_load")
        load_str = f"  🔥 Load {load:.0f}" if load else ""

        lines.append(
            f"{emoji} *{fmt_date(r['date'])}*  •  {dist_km:.1f}km  •  {int(dur_s//60)}min\n"
            f"   💨 {seconds_to_pace(pace_s)}  ❤️ {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')}  "
            f"⚡ {r.get('avg_power','?')}W  👟 {r.get('avg_cadence','?')}spm{load_str}"
        )
    return "\n".join(lines)

def format_splits_table(splits: list, header: str) -> str:
    """Format km splits as a clean aligned table."""
    if not splits:
        return "No splits found."

    lines = [f"📊 *{header}*\n"]
    lines.append("`KM  │ Pace     │ HR      │  Power │ ↑`")
    lines.append("`────┼──────────┼─────────┼────────┼────`")

    for s in splits:
        km     = str(s.get("km_number", "?")).rjust(2)
        pace   = (s.get("pace_display") or "N/A").ljust(8)
        hr_avg = str(s.get("hr_avg") or "?")
        hr_max = str(s.get("hr_max") or "?")
        hr     = f"{hr_avg}/{hr_max}".ljust(7)
        power  = str(s.get("power_avg") or "?").rjust(4) + "W"
        asc    = f"{s.get('ascent_m', 0):.0f}m"
        lines.append(f"`{km}  │ {pace} │ {hr} │ {power:>6} │ {asc}`")

    return "\n".join(lines)

def format_recovery_dashboard(sleep_data: list, hrv_data: list) -> str:
    """Format sleep and HRV as a visual recovery dashboard."""
    lines = ["💤 *Recovery Dashboard*\n"]

    if hrv_data:
        h = hrv_data[0]
        emoji = recharge_emoji(h.get("recharge_status", ""))
        lines.append(
            f"{emoji} *Nightly Recharge — {h['date']}*\n"
            f"   ANS: {h.get('ans_charge','?')}  •  Sleep charge: {h.get('sleep_charge','?')}\n"
            f"   HRV avg: {h.get('hrv_avg','?')}  •  RMSSD: {h.get('hrv_rmssd','?')}\n"
        )

    if sleep_data:
        lines.append("😴 *Sleep History*\n")
        for s in sleep_data:
            total_s  = s.get("total_sleep_seconds") or 0
            score    = s.get("sleep_score") or 0
            hrv      = s.get("avg_hrv") or "?"
            hrs      = total_s // 3600
            mins     = (total_s % 3600) // 60
            rem_m    = (s.get("rem_seconds") or 0) // 60
            deep_m   = (s.get("deep_sleep_seconds") or 0) // 60
            # Score bar
            bar_fill = int(score / 10) if score else 0
            bar      = "█" * bar_fill + "░" * (10 - bar_fill)
            lines.append(
                f"*{s['date']}*  {hrs}h{mins:02d}m  Score: {score:.0f}\n"
                f"   `{bar}`\n"
                f"   REM {rem_m}min  •  Deep {deep_m}min  •  HRV {hrv}"
            )

    return "\n".join(lines)

def format_new_run_notification(session_json: dict, exercise_id: str, splits_count: int) -> str:
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
        emoji   = sport_emoji(sport)

        lines = [
            f"{emoji} *New {sport.replace('_',' ').title()} Synced!*",
            f"",
            f"📅 {fmt_date(ex.get('startTime',''))}  •  {dist_km:.2f}km  •  {int(dur_s//60)}min",
            f"💨 {seconds_to_pace(pace_s)}  ❤️ {hr.get('avg','?')}/{hr.get('max','?')}bpm",
            f"⚡ {power.get('avg','?')}W avg  •  👟 {cadence.get('avg','?')}spm",
            f"⬆️ {ex.get('ascent',0):.0f}m ascent  •  🔥 Load {load.get('cardioLoad','?')}",
            f"",
            f"📊 {splits_count} km splits saved",
        ]

        if splits_count > 0:
            split_data = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,power_avg")\
                .eq("exercise_id", exercise_id).order("lap_number").limit(5).execute()
            if split_data.data:
                lines.append("")
                lines.append("*First splits:*")
                lines.append("`KM  │ Pace     │  HR │ Power`")
                for s in split_data.data:
                    km    = str(s['km_number']).rjust(2)
                    pace  = (s.get('pace_display') or 'N/A').ljust(8)
                    hr    = str(s.get('hr_avg') or '?').rjust(3)
                    pwr   = str(s.get('power_avg') or '?').rjust(4) + "W"
                    lines.append(f"`{km}  │ {pace} │ {hr} │ {pwr}`")

        return "\n".join(lines)
    except Exception as e:
        log.error(f"Format notification error: {e}")
        return "✅ New run synced"

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

# ── Supabase context for Claude ────────────────────────────────────────────
def build_training_context(run_limit: int = 10, sleep_days: int = 7) -> str:
    """Build structured training context to inject into Claude's system prompt."""
    try:
        parts = []

        # Recent runs
        runs = supabase.table("polar_exercises")\
            .select("polar_exercise_id,date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,ascent,descent")\
            .order("date", desc=True).limit(run_limit).execute()

        if runs.data:
            parts.append(f"=== RECENT RUNS (last {len(runs.data)}) ===")
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

            # Splits for most recent run with splits
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
            .order("date", desc=True).limit(sleep_days).execute()

        if sleep.data:
            parts.append(f"\n=== SLEEP (last {len(sleep.data)} nights) ===")
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
- When referencing splits, describe them conversationally — the formatted table is shown separately
- Use min/km for pace, bpm for HR, watts for power"""

def build_system_prompt(run_limit: int = 10, sleep_days: int = 7) -> str:
    return f"{BASE_SYSTEM}\n\n{build_training_context(run_limit, sleep_days)}"

# ── Conversation history ───────────────────────────────────────────────────
conversation_history = {}

def get_history(chat_id):
    return conversation_history.get(chat_id, [])

def add_to_history(chat_id, role, content):
    if chat_id not in conversation_history:
        conversation_history[chat_id] = []
    conversation_history[chat_id].append({"role": role, "content": content})
    conversation_history[chat_id] = conversation_history[chat_id][-20:]

# ── Morning briefing ───────────────────────────────────────────────────────
def send_morning_briefing():
    try:
        # Pull fresh recovery data
        sleep = supabase.table("polar_sleep")\
            .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv")\
            .order("date", desc=True).limit(7).execute()
        hrv = supabase.table("polar_hrv")\
            .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
            .order("date", desc=True).limit(1).execute()

        # Recovery dashboard first
        recovery_msg = format_recovery_dashboard(sleep.data, hrv.data)
        bot.send_message(YOUR_TELEGRAM_ID, recovery_msg, parse_mode="Markdown")

        # Then Claude's coaching briefing
        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=500,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": (
                "Give Luke a concise morning coaching briefing: "
                "today's recommended session with effort level, "
                "one key flag from recent training or recovery, "
                "weekly load check. Max 4 short paragraphs."
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

# ── Background loops ───────────────────────────────────────────────────────
def polar_sync_loop():
    while True:
        try:
            new = sync_new_polar_exercises()
            for ex in new:
                msg = format_new_run_notification(ex["data"], ex["id"], ex["splits"])
                bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode="Markdown")
        except Exception as e:
            log.error(f"Sync loop error: {e}")
        time.sleep(300)

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

    # ── /start /help ──
    if user_text.lower() in ["/start", "/help"]:
        bot.reply_to(message, (
            "👋 *Hey Luke!* I'm your Polar running coach.\n\n"
            "I have your full training history, sleep, HRV and km splits.\n\n"
            "*Commands:*\n"
            "/sync — check for new runs\n"
            "/briefing — morning briefing now\n"
            "/splits — km splits for last run\n"
            "/runs — last 10 runs\n"
            "/recovery — sleep & HRV dashboard\n"
            "/load — weekly training load\n"
            "/clear — clear conversation\n\n"
            "Or just ask me anything — "
            "_\"show last 30 runs\"_, _\"how was my sleep last month\"_, "
            "_\"am I ready to race?\"_"
        ), parse_mode="Markdown")
        return

    # ── /sync ──
    if user_text.lower() == "/sync":
        bot.reply_to(message, "🔄 Checking Polar...")
        new = sync_new_polar_exercises()
        if new:
            for ex in new:
                bot.send_message(
                    chat_id,
                    format_new_run_notification(ex["data"], ex["id"], ex["splits"]),
                    parse_mode="Markdown"
                )
        else:
            bot.send_message(chat_id, "No new exercises found.")
        return

    # ── /briefing ──
    if user_text.lower() == "/briefing":
        bot.reply_to(message, "⏳ Generating briefing...")
        send_morning_briefing()
        return

    # ── /splits ──
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
            header  = f"{fmt_date(ex['date'])} — {dist_km:.1f}km {ex.get('sport','')}"
            bot.reply_to(message, format_splits_table(splits.data, header), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /runs ──
    if user_text.lower().startswith("/runs"):
        try:
            parts = user_text.split()
            limit = int(parts[1]) if len(parts) > 1 else 10
            limit = min(limit, 100)
            runs  = supabase.table("polar_exercises")\
                .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load")\
                .order("date", desc=True).limit(limit).execute()
            bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /recovery ──
    if user_text.lower() == "/recovery":
        try:
            sleep = supabase.table("polar_sleep")\
                .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv")\
                .order("date", desc=True).limit(7).execute()
            hrv = supabase.table("polar_hrv")\
                .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
                .order("date", desc=True).limit(1).execute()
            bot.reply_to(message, format_recovery_dashboard(sleep.data, hrv.data), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /load ──
    if user_text.lower() == "/load":
        try:
            now             = datetime.now(timezone.utc)
            week_start      = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
            last_week_start = (now - timedelta(days=now.weekday()+7)).strftime("%Y-%m-%d")
            this_week = supabase.table("polar_exercises").select("training_load,distance_meters,date,sport")\
                .gte("date", week_start).order("date", desc=True).execute()
            last_week = supabase.table("polar_exercises").select("training_load,distance_meters,date,sport")\
                .gte("date", last_week_start).lt("date", week_start).order("date", desc=True).execute()

            def sum_load(rows): return sum(r.get("training_load") or 0 for r in rows)
            def sum_km(rows):   return sum((r.get("distance_meters") or 0)/1000 for r in rows)

            lines = ["📈 *Weekly Training Load*\n"]
            lines.append(
                f"*This week:*  {sum_km(this_week.data):.1f}km  •  "
                f"Load {sum_load(this_week.data):.0f}  •  {len(this_week.data)} sessions"
            )
            for r in this_week.data:
                dist = (r.get("distance_meters") or 0)/1000
                lines.append(f"  {sport_emoji(r.get('sport',''))} {fmt_date(r['date'])}  {dist:.1f}km  Load {r.get('training_load','?'):.0f}" if r.get('training_load') else f"  {sport_emoji(r.get('sport',''))} {fmt_date(r['date'])}  {dist:.1f}km")

            lines.append(f"\n*Last week:*  {sum_km(last_week.data):.1f}km  •  Load {sum_load(last_week.data):.0f}  •  {len(last_week.data)} sessions")

            bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /clear ──
    if user_text.lower() == "/clear":
        conversation_history[chat_id] = []
        bot.reply_to(message, "Conversation cleared.")
        return

    # ── Natural language history detection ──
    run_limit   = detect_history_request(user_text) or 10
    sleep_days  = detect_recovery_window(user_text)

    # If asking explicitly for runs list (not just asking Claude to analyse)
    run_list_keywords = ["show", "list", "display", "give me", "last", "all my"]
    is_run_list_req   = any(kw in user_text.lower() for kw in run_list_keywords) and \
                        ("run" in user_text.lower() or "session" in user_text.lower())

    if is_run_list_req and run_limit > 10:
        try:
            runs = supabase.table("polar_exercises")\
                .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load")\
                .order("date", desc=True).limit(run_limit).execute()
            bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
            return
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
            return

    # Recovery dashboard request
    recovery_keywords = ["sleep", "recovery", "recharge", "hrv", "rest"]
    is_recovery_req   = any(kw in user_text.lower() for kw in recovery_keywords) and \
                        sleep_days > 7

    if is_recovery_req:
        try:
            sleep = supabase.table("polar_sleep")\
                .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv")\
                .order("date", desc=True).limit(sleep_days).execute()
            hrv = supabase.table("polar_hrv")\
                .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
                .order("date", desc=True).limit(1).execute()
            bot.reply_to(message, format_recovery_dashboard(sleep.data, hrv.data), parse_mode="Markdown")
            return
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
            return

    # ── Main Claude conversation ──
    try:
        bot.send_chat_action(chat_id, "typing")
        add_to_history(chat_id, "user", user_text)

        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=1000,
            system=build_system_prompt(run_limit=run_limit, sleep_days=sleep_days),
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