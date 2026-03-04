"""
bot.py - Polar Running Coach Telegram Bot v4
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

# ══════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════

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
    if not status: return "⚪"
    s = status.upper()
    if "GOOD" in s or "HIGH" in s:   return "🟢"
    if "MODERATE" in s or "OK" in s: return "🟡"
    if "LOW" in s or "POOR" in s:    return "🔴"
    return "⚪"

def sport_emoji(sport: str) -> str:
    if "TRAIL" in sport:     return "🏔️"
    if "TREADMILL" in sport: return "⚙️"
    return "🏃"

def fmt_date(date_str: str) -> str:
    try:
        return datetime.fromisoformat(date_str[:10]).strftime("%-d %b")
    except:
        return date_str[:10]

def get_latest_run_with_splits():
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

def detect_history_request(text: str):
    text = text.lower()
    m = re.search(r"last\s+(\d+)\s+runs?", text)
    if m: return min(int(m.group(1)), 200)
    m = re.search(r"last\s+(\d+)\s+months?", text)
    if m: return min(int(m.group(1)) * 30, 365)
    if "last month" in text:  return 30
    if "last 3 months" in text or "last three months" in text: return 90
    if "last 6 months" in text or "last six months" in text:   return 180
    if "all" in text and ("run" in text or "history" in text): return 200
    return None

def detect_recovery_window(text: str) -> int:
    text = text.lower()
    m = re.search(r"last\s+(\d+)\s+(?:days?|nights?)", text)
    if m: return min(int(m.group(1)), 90)
    if "last month" in text:  return 30
    if "last 2 weeks" in text or "last two weeks" in text: return 14
    if "last week" in text:   return 7
    return 7

# ══════════════════════════════════════════════════════════════════════════
# FORMATTING
# ══════════════════════════════════════════════════════════════════════════

def format_run_list(runs: list) -> str:
    if not runs:
        return "No runs found."
    lines = [f"🏃 *Last {len(runs)} Runs*\n"]
    for r in runs:
        dist_km  = (r.get("distance_meters") or 0) / 1000
        dur_s    = r.get("duration_seconds") or 0
        pace_s   = dur_s / dist_km if dist_km else 0
        load     = r.get("training_load")
        load_str = f"  🔥 {load:.0f}" if load else ""
        source   = " ✏️" if r.get("source") == "manual" else ""
        lines.append(
            f"{sport_emoji(r.get('sport',''))} *{fmt_date(r['date'])}*{source}  •  "
            f"{dist_km:.1f}km  •  {int(dur_s//60)}min\n"
            f"   💨 {seconds_to_pace(pace_s)}  ❤️ {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')}"
            f"  ⚡ {r.get('avg_power','?')}W  👟 {r.get('avg_cadence','?')}spm{load_str}"
        )
    return "\n".join(lines)

def format_splits_table(splits: list, header: str) -> str:
    if not splits:
        return "No splits found."
    lines = [f"📊 *{header}*\n"]
    lines.append("`KM  │ Pace     │ HR      │  Power │ ↑`")
    lines.append("`────┼──────────┼─────────┼────────┼────`")
    for s in splits:
        km    = str(s.get("km_number", "?")).rjust(2)
        pace  = (s.get("pace_display") or "N/A").ljust(8)
        hr    = f"{s.get('hr_avg','?')}/{s.get('hr_max','?')}".ljust(7)
        power = str(s.get("power_avg") or "?").rjust(4) + "W"
        asc   = f"{s.get('ascent_m', 0):.0f}m"
        lines.append(f"`{km}  │ {pace} │ {hr} │ {power:>6} │ {asc}`")
    return "\n".join(lines)

def format_recovery_dashboard(sleep_data: list, hrv_data: list) -> str:
    lines = ["💤 *Recovery Dashboard*\n"]
    if hrv_data:
        h     = hrv_data[0]
        emoji = recharge_emoji(h.get("recharge_status", ""))
        lines.append(
            f"{emoji} *Nightly Recharge — {h['date']}*\n"
            f"   ANS: {h.get('ans_charge','?')}  •  Sleep charge: {h.get('sleep_charge','?')}\n"
            f"   HRV avg: {h.get('hrv_avg','?')}  •  RMSSD: {h.get('hrv_rmssd','?')}\n"
        )
    if sleep_data:
        lines.append("😴 *Sleep History*\n")
        for s in sleep_data:
            total_s = s.get("total_sleep_seconds") or 0
            score   = s.get("sleep_score") or 0
            hrv     = s.get("avg_hrv") or "?"
            hrs     = total_s // 3600
            mins    = (total_s % 3600) // 60
            rem_m   = (s.get("rem_seconds") or 0) // 60
            deep_m  = (s.get("deep_sleep_seconds") or 0) // 60
            bar     = "█" * int(score / 10) + "░" * (10 - int(score / 10))
            lines.append(
                f"*{s['date']}*  {hrs}h{mins:02d}m  Score: {score:.0f}\n"
                f"   `{bar}`\n"
                f"   REM {rem_m}min  •  Deep {deep_m}min  •  HRV {hrv}"
            )
    return "\n".join(lines)

def format_goals(goals: list) -> str:
    if not goals:
        return "No goals set. Add one with:\n`goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`"
    lines = ["🎯 *Goals & Target Races*\n"]
    for g in goals:
        days_to = ""
        if g.get("race_date"):
            try:
                d = datetime.strptime(g["race_date"], "%Y-%m-%d").date()
                diff = (d - datetime.now().date()).days
                days_to = f"  •  {diff}d away" if diff > 0 else "  •  PAST"
            except:
                pass
        lines.append(
            f"{'⭐' if g.get('priority') == 1 else '🔹'} *{g.get('race_name','?')}*\n"
            f"   📅 {g.get('race_date','?')}{days_to}\n"
            f"   📏 {g.get('distance_km','?')}km  •  🎯 {g.get('target_time','?')}\n"
            f"   {g.get('notes','') or ''}"
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

        lines = [
            f"{sport_emoji(sport)} *New {sport.replace('_',' ').title()} Synced!*\n",
            f"📅 {fmt_date(ex.get('startTime',''))}  •  {dist_km:.2f}km  •  {int(dur_s//60)}min",
            f"💨 {seconds_to_pace(pace_s)}  ❤️ {hr.get('avg','?')}/{hr.get('max','?')}bpm",
            f"⚡ {power.get('avg','?')}W avg  •  👟 {cadence.get('avg','?')}spm",
            f"⬆️ {ex.get('ascent',0):.0f}m ascent  •  🔥 Load {load.get('cardioLoad','?')}",
            f"\n📊 {splits_count} km splits saved",
        ]
        if splits_count > 0:
            split_data = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,power_avg")\
                .eq("exercise_id", exercise_id).order("lap_number").limit(5).execute()
            if split_data.data:
                lines.append("\n*First splits:*")
                lines.append("`KM  │ Pace     │  HR │ Power`")
                for s in split_data.data:
                    km   = str(s['km_number']).rjust(2)
                    pace = (s.get('pace_display') or 'N/A').ljust(8)
                    hr   = str(s.get('hr_avg') or '?').rjust(3)
                    pwr  = str(s.get('power_avg') or '?').rjust(4) + "W"
                    lines.append(f"`{km}  │ {pace} │ {hr} │ {pwr}`")
        return "\n".join(lines)
    except Exception as e:
        log.error(f"Format notification error: {e}")
        return "✅ New run synced"

# ══════════════════════════════════════════════════════════════════════════
# WRITE TO SUPABASE
# ══════════════════════════════════════════════════════════════════════════

def save_coaching_note(topic: str, summary: str, full_response: str):
    """Save Claude's coaching insight to Supabase."""
    try:
        supabase.table("coaching_notes").insert({
            "date":          datetime.now().strftime("%Y-%m-%d"),
            "topic":         topic[:200],
            "summary":       summary[:500],
            "full_response": full_response[:5000],
        }).execute()
    except Exception as e:
        log.error(f"Save coaching note error: {e}")

def save_goal(text: str) -> str:
    """
    Parse and save a goal from natural language.
    Format: goal: <name>, <date>, <distance>km, <target time>
    e.g. goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30
    """
    try:
        # Strip trigger word
        text = re.sub(r"^(goal|race|target)\s*[:：]\s*", "", text.strip(), flags=re.IGNORECASE)
        parts = [p.strip() for p in text.split(",")]
        if len(parts) < 2:
            return "Format: `goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`"

        race_name   = parts[0]
        race_date   = None
        distance_km = None
        target_time = None
        notes       = None

        for p in parts[1:]:
            # Date
            date_match = re.search(r"(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})", p)
            if date_match and not race_date:
                try:
                    race_date = datetime.strptime(date_match.group(1), "%d %b %Y").strftime("%Y-%m-%d")
                except:
                    try:
                        race_date = datetime.strptime(date_match.group(1), "%Y-%m-%d").strftime("%Y-%m-%d")
                    except:
                        pass
                continue
            # Distance
            dist_match = re.search(r"([\d.]+)\s*km", p, re.IGNORECASE)
            if dist_match and not distance_km:
                distance_km = float(dist_match.group(1))
                continue
            # Target time
            if re.search(r"(sub|under|target|<|goal)?\s*\d+[:h]\d+", p, re.IGNORECASE) and not target_time:
                target_time = p.strip()
                continue
            notes = p.strip()

        supabase.table("goals").insert({
            "race_name":   race_name,
            "race_date":   race_date,
            "distance_km": distance_km,
            "target_time": target_time,
            "notes":       notes,
            "priority":    1,
            "active":      True,
        }).execute()

        return (
            f"🎯 *Goal saved!*\n\n"
            f"*{race_name}*\n"
            f"📅 {race_date or 'date TBC'}  •  📏 {distance_km or '?'}km\n"
            f"🎯 {target_time or 'time TBC'}"
        )
    except Exception as e:
        log.error(f"Save goal error: {e}")
        return f"Error saving goal: {e}"

def save_manual_run(text: str) -> str:
    """
    Use Claude to parse any Polar Flow paste or typed run stats and save
    full row + km splits to Supabase.
    Triggers: save run: / log run: / manual run:
    """
    try:
        # Strip trigger prefix
        raw = re.sub(
            r"^(save\s+run|log\s+run|manual\s+run|run\s+log)\s*[:：]\s*",
            "", text.strip(), flags=re.IGNORECASE
        )

        today = datetime.now().strftime("%Y-%m-%d")

        # Ask Claude to extract all fields as JSON
        parse_resp = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=800,
            system=(
                "You are a precise data parser for Polar running data. "
                "Extract all available fields from the text and return ONLY a valid JSON object — "
                "no markdown, no explanation, no code fences.\n\n"
                "Top-level fields (null if not present):\n"
                "  date (YYYY-MM-DD — infer from context like \'Tuesday\' or \'birthday\', default to today),\n"
                "  sport (RUNNING, TRAIL_RUNNING, or TREADMILL_RUNNING),\n"
                "  distance_meters (float),\n"
                "  duration_seconds (int — convert HH:MM:SS or MM:SS),\n"
                "  avg_heart_rate (int),\n"
                "  max_heart_rate (int),\n"
                "  avg_power (int, watts),\n"
                "  max_power (int, watts),\n"
                "  avg_cadence (int, steps/min),\n"
                "  max_cadence (int),\n"
                "  ascent (float, metres),\n"
                "  descent (float, metres),\n"
                "  calories (int),\n"
                "  training_load (float — cardio load),\n"
                "  muscle_load (float),\n"
                "  notes (string — e.g. \'birthday run\', \'easy effort\'),\n"
                "  splits (array of objects, one per km lap — extract if a splits table is present):\n"
                "    Each split object: {\n"
                "      km_number (int),\n"
                "      duration_seconds (float — lap duration, from HH:MM:SS.s),\n"
                "      split_time_seconds (float — cumulative time),\n"
                "      distance_m (float, usually 1000),\n"
                "      hr_avg (int), hr_max (int),\n"
                "      power_avg (int), power_max (int),\n"
                "      cadence_avg (int), cadence_max (int),\n"
                "      pace_display (string e.g. \'7:31/km\')\n"
                "    }\n"
                "In the splits table, values appear as \'lap / cumulative\' — use the LAP value (before /).\n"
                "For pace: format is MM:SS per km."
            ),
            messages=[{"role": "user", "content": f"Today is {today}.\n\n{raw}"}]
        )

        raw_json = parse_resp.content[0].text.strip()
        raw_json = re.sub(r"^```[a-z]*\s*|```$", "", raw_json, flags=re.MULTILINE).strip()
        fields   = json.loads(raw_json)

        # Build exercise row
        ex_id      = f"manual-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        run_date   = fields.get("date") or today
        dur_s      = fields.get("duration_seconds") or 0
        dist_m     = fields.get("distance_meters") or 0
        pace_s     = dur_s / (dist_m / 1000) if dist_m else 0
        sport      = fields.get("sport") or "RUNNING"

        supabase.table("polar_exercises").upsert({
            "polar_exercise_id": ex_id,
            "date":              f"{run_date}T00:00:00+00:00",
            "sport":             sport,
            "duration_seconds":  si(dur_s),
            "distance_meters":   sf(dist_m),
            "avg_heart_rate":    si(fields.get("avg_heart_rate")),
            "max_heart_rate":    si(fields.get("max_heart_rate")),
            "avg_power":         si(fields.get("avg_power")),
            "max_power":         si(fields.get("max_power")),
            "avg_cadence":       si(fields.get("avg_cadence")),
            "max_cadence":       si(fields.get("max_cadence")),
            "ascent":            sf(fields.get("ascent")),
            "descent":           sf(fields.get("descent")),
            "calories":          si(fields.get("calories")),
            "training_load":     sf(fields.get("training_load")),
            "muscle_load":       sf(fields.get("muscle_load")),
            "notes":             fields.get("notes"),
            "source":            "manual",
        }, on_conflict="polar_exercise_id").execute()

        # Save km splits if present
        splits     = fields.get("splits") or []
        split_rows = []
        for s in splits:
            lap_dur = s.get("duration_seconds") or 0
            split_rows.append({
                "exercise_id":        ex_id,
                "session_date":       run_date,
                "lap_number":         (s.get("km_number") or 1) - 1,
                "km_number":          s.get("km_number") or 1,
                "duration_seconds":   sf(lap_dur),
                "split_time_seconds": sf(s.get("split_time_seconds")),
                "distance_m":         sf(s.get("distance_m") or 1000),
                "pace_min_per_km":    sf(lap_dur / 60) if lap_dur else None,
                "pace_display":       s.get("pace_display") or seconds_to_pace(lap_dur),
                "hr_avg":             si(s.get("hr_avg")),
                "hr_max":             si(s.get("hr_max")),
                "power_avg":          si(s.get("power_avg")),
                "power_max":          si(s.get("power_max")),
                "cadence_avg":        si(s.get("cadence_avg")),
                "cadence_max":        si(s.get("cadence_max")),
                "ascent_m":           sf(s.get("ascent_m", 0)),
                "descent_m":          sf(s.get("descent_m", 0)),
            })
        if split_rows:
            supabase.table("polar_km_splits").upsert(
                split_rows, on_conflict="exercise_id,lap_number"
            ).execute()

        # Build confirmation message
        dist_km  = dist_m / 1000 if dist_m else 0
        lines = [
            f"✏️ *Run saved!*\n",
            f"{sport_emoji(sport)} {sport.replace('_',' ').title()}  •  {run_date}",
            f"📏 {dist_km:.2f}km  •  ⏱ {int(dur_s//60)}:{int(dur_s%60):02d}",
            f"💨 {seconds_to_pace(pace_s)}  ❤️ {fields.get('avg_heart_rate','?')}/{fields.get('max_heart_rate','?')}bpm",
            f"⚡ {fields.get('avg_power','?')}W  •  👟 {fields.get('avg_cadence','?')}spm",
            f"⬆️ {fields.get('ascent',0):.0f}m  •  🔥 Load {fields.get('training_load','?')}",
        ]
        if split_rows:
            lines.append(f"\n📊 {len(split_rows)} km splits saved")
            lines.append("\n`KM  │ Pace     │ HR      │ Power`")
            for s in split_rows:
                km   = str(s["km_number"]).rjust(2)
                pace = (s.get("pace_display") or "N/A").ljust(8)
                hr   = f"{s.get('hr_avg','?')}/{s.get('hr_max','?')}".ljust(7)
                pwr  = str(s.get("power_avg") or "?").rjust(4) + "W"
                lines.append(f"`{km}  │ {pace} │ {hr} │ {pwr}`")

        return "\n".join(lines)

    except Exception as e:
        log.error(f"Save manual run error: {e}")
        return f"Error saving run: {e}"

def save_wellness_checkin(text: str) -> str:
    """
    Parse and save a wellness check-in.
    Format: checkin: weight 77.5kg, fatigue 6/10, sleep 7/10, feeling good
    """
    try:
        text = re.sub(r"^(check.?in|wellness|feeling|mood)\s*[:：]\s*", "", text.strip(), flags=re.IGNORECASE)

        weight_kg    = None
        fatigue      = None
        sleep_score  = None
        mood         = None
        notes        = text  # default full text as notes

        # Weight
        m = re.search(r"([\d.]+)\s*kg", text, re.IGNORECASE)
        if m: weight_kg = float(m.group(1))

        # Fatigue score
        m = re.search(r"fatigue\s+(\d+)(?:/10)?", text, re.IGNORECASE)
        if m: fatigue = int(m.group(1))

        # Sleep score
        m = re.search(r"sleep\s+(\d+)(?:/10)?", text, re.IGNORECASE)
        if m: sleep_score = int(m.group(1))

        # Mood
        m = re.search(r"mood\s+(\d+)(?:/10)?", text, re.IGNORECASE)
        if m: mood = int(m.group(1))

        supabase.table("wellness_checkins").insert({
            "date":          datetime.now().strftime("%Y-%m-%d"),
            "weight_kg":     weight_kg,
            "fatigue_score": fatigue,
            "sleep_score":   sleep_score,
            "mood_score":    mood,
            "notes":         notes[:500],
        }).execute()

        parts = ["✅ *Check-in saved!*\n"]
        if weight_kg:   parts.append(f"⚖️ {weight_kg}kg")
        if fatigue:     parts.append(f"😓 Fatigue: {fatigue}/10")
        if sleep_score: parts.append(f"😴 Sleep: {sleep_score}/10")
        if mood:        parts.append(f"😊 Mood: {mood}/10")

        return "\n".join(parts)
    except Exception as e:
        log.error(f"Save wellness error: {e}")
        return f"Error saving check-in: {e}"

# ══════════════════════════════════════════════════════════════════════════
# POLAR SYNC
# ══════════════════════════════════════════════════════════════════════════

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
            "source":            "polar",
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

def sync_new_polar_exercises() -> list:
    try:
        r = requests.post(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/exercise-transactions",
            headers=polar_headers()
        )
        if r.status_code == 204:
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


# ── Sleep sync ─────────────────────────────────────────────────────────────
def _parse_pt_to_seconds(pt: str) -> int:
    """Parse ISO 8601 duration string PT1H13M30S to seconds."""
    if not pt:
        return 0
    import re as _re
    h = _re.search(r"(\d+)H", pt)
    m = _re.search(r"(\d+)M", pt)
    s = _re.search(r"(\d+)S", pt)
    total = 0
    if h: total += int(h.group(1)) * 3600
    if m: total += int(m.group(1)) * 60
    if s: total += int(s.group(1))
    return total

def sync_sleep() -> int:
    try:
        r = requests.post(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/sleep-transactions",
            headers=polar_headers()
        )
        if r.status_code == 204:
            return 0
        if not r.ok:
            log.error(f"Sleep transaction error: {r.status_code} {r.text}")
            return 0
        transaction    = r.json()
        transaction_id = transaction.get("transaction-id")
        urls           = transaction.get("resource-uri", [])
        count          = 0
        for url in urls:
            resp = requests.get(url, headers=polar_headers())
            if not resp.ok:
                continue
            s    = resp.json()

            # Handle both Sleep Plus Stages format (nested) and basic format
            date = s.get("night", s.get("date", ""))[:10]
            if not date:
                continue

            # Sleep Plus Stages: data nested under evaluation.phaseDurations
            evaluation  = s.get("evaluation", {})
            phases      = evaluation.get("phaseDurations", {})
            sleep_result = s.get("sleepResult", {})
            hypnogram   = sleep_result.get("hypnogram", {})

            # Parse phase durations (PT strings) or fall back to flat fields
            rem_s   = _parse_pt_to_seconds(phases.get("rem"))   or si(s.get("rem_sleep"))   or 0
            deep_s  = _parse_pt_to_seconds(phases.get("deep"))  or si(s.get("deep_sleep"))  or 0
            light_s = _parse_pt_to_seconds(phases.get("light")) or si(s.get("light_sleep")) or 0
            total_s = rem_s + deep_s + light_s or si(s.get("total_sleep_time")) or 0

            # Sleep score — nested under evaluation or flat
            score = sf(evaluation.get("analysis", {}).get("feedback")) or sf(s.get("sleep_score"))

            # Interruptions
            interruptions = s.get("interruptions", {})
            interruption_count = interruptions.get("totalCount") if isinstance(interruptions, dict) else si(s.get("interruptions"))

            # Avg HR from heart_rate_samples dict
            hr_samples = sleep_result.get("heart_rate_samples", s.get("heart_rate_samples", {}))
            avg_hr = si(round(sum(hr_samples.values()) / len(hr_samples))) if hr_samples else None

            supabase.table("polar_sleep").upsert({
                "date":                date,
                "total_sleep_seconds": total_s,
                "sleep_score":         score,
                "rem_seconds":         rem_s,
                "light_sleep_seconds": light_s,
                "deep_sleep_seconds":  deep_s,
                "interruptions":       interruption_count,
                "avg_hr":              avg_hr,
                "avg_hrv":             sf(s.get("hrv_avg")),
                "raw_json":            json.dumps(s),
            }, on_conflict="date").execute()
            count += 1
        requests.put(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/sleep-transactions/{transaction_id}",
            headers=polar_headers()
        )
        log.info(f"Sleep sync: {count} nights saved")
        return count
    except Exception as e:
        log.error(f"Sleep sync error: {e}")
        return 0

# ── Nightly recharge / HRV sync ────────────────────────────────────────────
def _recharge_status_label(status_int) -> str:
    """Convert Polar nightly_recharge_status int to readable label."""
    mapping = {1: "POOR", 2: "LOW", 3: "MODERATE", 4: "GOOD", 5: "EXCELLENT"}
    if status_int is None:
        return None
    return mapping.get(int(status_int), str(status_int))

def sync_nightly_recharge() -> int:
    try:
        r = requests.post(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/nightly-recharge-transactions",
            headers=polar_headers()
        )
        if r.status_code == 204:
            return 0
        if not r.ok:
            log.error(f"Recharge transaction error: {r.status_code} {r.text}")
            return 0
        transaction    = r.json()
        transaction_id = transaction.get("transaction-id")
        urls           = transaction.get("resource-uri", [])
        count          = 0
        for url in urls:
            resp = requests.get(url, headers=polar_headers())
            if not resp.ok:
                continue
            h    = resp.json()
            date = h.get("date", "")[:10]
            if not date:
                continue
            supabase.table("polar_hrv").upsert({
                "date":            date,
                # Polar API field mapping (from actual API response):
                # heart_rate_variability_avg = HRV avg
                # beat_to_beat_avg = RMSSD equivalent  
                # nightly_recharge_status = int 1-5 (1=poor, 5=excellent)
                # ans_charge_status = int, sleep_charge not returned directly
                "hrv_avg":         sf(
                    round(sum(h.get("hrv_samples", {}).values()) /
                    len(h.get("hrv_samples", {}))) if h.get("hrv_samples") else
                    h.get("heart_rate_variability_avg")
                ),
                "hrv_rmssd":       sf(h.get("beat_to_beat_avg")),
                "ans_charge":      sf(h.get("ans_charge")),
                "sleep_charge":    sf(h.get("ans_charge_status")),
                "recharge_status": _recharge_status_label(h.get("nightly_recharge_status")),
                "raw_json":        json.dumps(h),
            }, on_conflict="date").execute()
            count += 1
        requests.put(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/nightly-recharge-transactions/{transaction_id}",
            headers=polar_headers()
        )
        log.info(f"Recharge sync: {count} nights saved")
        return count
    except Exception as e:
        log.error(f"Recharge sync error: {e}")
        return 0

# ── Daily activity sync ────────────────────────────────────────────────────
def sync_daily_activity() -> int:
    try:
        r = requests.post(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/activity-transactions",
            headers=polar_headers()
        )
        if r.status_code == 204:
            return 0
        if not r.ok:
            log.error(f"Activity transaction error: {r.status_code} {r.text}")
            return 0
        transaction    = r.json()
        transaction_id = transaction.get("transaction-id")
        urls           = transaction.get("resource-uri", [])
        count          = 0
        for url in urls:
            resp = requests.get(url, headers=polar_headers())
            if not resp.ok:
                continue
            a    = resp.json()
            date = a.get("date", "")[:10]
            if not date:
                continue
            supabase.table("polar_daily_activity").upsert({
                "date":                date,
                "steps":               si(a.get("steps")),
                "calories_total":      sf(a.get("calories")),
                "active_calories":     sf(a.get("active_calories")),
                "active_time_seconds": si(a.get("active_time")),
                "raw_json":            json.dumps(a),
            }, on_conflict="date").execute()
            count += 1
        requests.put(
            f"{POLAR_BASE}/users/{POLAR_USER_ID}/activity-transactions/{transaction_id}",
            headers=polar_headers()
        )
        log.info(f"Activity sync: {count} days saved")
        return count
    except Exception as e:
        log.error(f"Activity sync error: {e}")
        return 0

# ══════════════════════════════════════════════════════════════════════════
# SUPABASE CONTEXT FOR CLAUDE
# ══════════════════════════════════════════════════════════════════════════

def build_training_context(run_limit: int = 10, sleep_days: int = 7) -> str:
    try:
        parts = []

        # Goals
        goals = supabase.table("goals")\
            .select("race_name,race_date,distance_km,target_time,priority,notes")\
            .eq("active", True).order("race_date").execute()

        if goals.data:
            parts.append("=== GOALS & TARGET RACES ===")
            for g in goals.data:
                parts.append(
                    f"  {g.get('race_name')} | {g.get('race_date')} | "
                    f"{g.get('distance_km')}km | Target: {g.get('target_time')} | "
                    f"{'A-race' if g.get('priority')==1 else 'B-race'}"
                )

        # Recent wellness
        wellness = supabase.table("wellness_checkins")\
            .select("date,weight_kg,fatigue_score,sleep_score,mood_score,notes")\
            .order("date", desc=True).limit(7).execute()

        if wellness.data:
            parts.append("\n=== RECENT WELLNESS CHECK-INS ===")
            for w in wellness.data:
                parts.append(
                    f"  {w['date']} | Weight: {w.get('weight_kg','?')}kg | "
                    f"Fatigue: {w.get('fatigue_score','?')}/10 | "
                    f"Sleep: {w.get('sleep_score','?')}/10 | "
                    f"Mood: {w.get('mood_score','?')}/10 | {w.get('notes','')}"
                )

        # Recent coaching notes
        notes = supabase.table("coaching_notes")\
            .select("date,topic,summary")\
            .order("date", desc=True).limit(5).execute()

        if notes.data:
            parts.append("\n=== RECENT COACHING NOTES ===")
            for n in notes.data:
                parts.append(f"  {n['date']} | {n.get('topic','?')} | {n.get('summary','')}")

        # Recent runs
        runs = supabase.table("polar_exercises")\
            .select("polar_exercise_id,date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,ascent,descent,source")\
            .order("date", desc=True).limit(run_limit).execute()

        if runs.data:
            parts.append(f"\n=== RECENT RUNS (last {len(runs.data)}) ===")
            for r in runs.data:
                dist_km = (r.get("distance_meters") or 0) / 1000
                dur_s   = r.get("duration_seconds") or 0
                pace_s  = dur_s / dist_km if dist_km else 0
                src     = " [manual]" if r.get("source") == "manual" else ""
                parts.append(
                    f"  {r['date'][:10]} | {r.get('sport','?')}{src} | {dist_km:.1f}km | "
                    f"{int(dur_s//60)}min | Pace: {seconds_to_pace(pace_s)} | "
                    f"HR: {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')} | "
                    f"Power: {r.get('avg_power','?')}W | Load: {r.get('training_load','?')} | "
                    f"Ascent: {r.get('ascent','?')}m"
                )

            # Splits for most recent run with splits
            latest = get_latest_run_with_splits()
            if latest:
                splits = supabase.table("polar_km_splits")\
                    .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg,ascent_m")\
                    .eq("exercise_id", latest["polar_exercise_id"])\
                    .order("lap_number").execute()
                if splits.data:
                    dist_km = (latest.get("distance_meters") or 0) / 1000
                    parts.append(f"\n=== KM SPLITS: {latest['date'][:10]} ({dist_km:.1f}km) ===")
                    for s in splits.data:
                        parts.append(
                            f"  KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | "
                            f"HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | "
                            f"Power {s.get('power_avg','?')}W | ↑{s.get('ascent_m',0):.0f}m"
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
        parts.append(f"\n=== WEEKLY LOAD ===")
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
                f"HRV: {h.get('hrv_avg','?')} | RMSSD: {h.get('hrv_rmssd','?')}"
            )

        return "\n".join(parts)

    except Exception as e:
        log.error(f"Context error: {e}")
        return "Training data temporarily unavailable."

# ══════════════════════════════════════════════════════════════════════════
# CLAUDE
# ══════════════════════════════════════════════════════════════════════════

BASE_SYSTEM = """You are an expert running coach for Luke Worgan, training for the London Marathon and ultra marathons. Luke uses a Polar Grit X2.

CRITICAL — YOUR DATA ACCESS:
You are a Telegram bot with a live Supabase database connection with FULL READ AND WRITE ACCESS. Every message you receive includes freshly queried data: runs, km splits, sleep, HRV, recharge, goals, wellness check-ins and past coaching notes. This is real live data — not a snapshot.

You CAN and DO write to Supabase. When Luke uses these triggers, the bot saves data directly:
- "save run: ..." → saves to polar_exercises + polar_km_splits with full splits
- "log run: ..." → same as above
- "goal: ..." → saves to goals table
- "checkin: ..." → saves to wellness_checkins table
- Every coaching response → auto-saves a note to coaching_notes

Never tell Luke you lack write access, memory, or database access — you have all of these. Never say you "can't insert runs or splits" — you can and do. If a run isn't showing after using "save run:", there may be a temporary error — tell him to try again or check /runs. If a run isn't listed at all, it hasn't synced from the watch yet — direct him to /sync or Polar Flow.

Luke's stats:
- DOB: 1989-03-03 | Height: 167cm | Weight: 78kg
- VO2max: 55 | Max HR: 198 | Resting HR: 47
- Aerobic threshold: 149bpm | Anaerobic threshold: 178bpm | FTP: 272W

Coaching style:
- Data-driven but conversational — always reference Luke's actual numbers
- Honest about fatigue — flag risks, don't just encourage
- Anchor every recommendation to his goals and race dates
- Describe splits conversationally — formatted tables are shown separately
- Use min/km for pace, bpm for HR, watts for power
- Never break character — you are his coach, not a generic AI

After giving a substantive coaching response, end with a one-line coaching note summary prefixed exactly with:
NOTE: <topic> | <one sentence summary>
This will be automatically saved to your memory."""

def build_system_prompt(run_limit: int = 10, sleep_days: int = 7) -> str:
    return f"{BASE_SYSTEM}\n\n{build_training_context(run_limit, sleep_days)}"

conversation_history = {}

def get_history(chat_id):
    return conversation_history.get(chat_id, [])

def add_to_history(chat_id, role, content):
    if chat_id not in conversation_history:
        conversation_history[chat_id] = []
    conversation_history[chat_id].append({"role": role, "content": content})
    conversation_history[chat_id] = conversation_history[chat_id][-20:]

def extract_and_save_note(reply: str, user_text: str):
    """Extract NOTE: line from Claude's response and save to coaching_notes."""
    try:
        m = re.search(r"NOTE:\s*(.+?)\s*\|\s*(.+?)$", reply, re.MULTILINE)
        if m:
            topic   = m.group(1).strip()
            summary = m.group(2).strip()
            save_coaching_note(topic, summary, reply)
            # Remove the NOTE line from the reply shown to Luke
            return re.sub(r"\nNOTE:.+$", "", reply, flags=re.MULTILINE).strip()
    except Exception as e:
        log.error(f"Extract note error: {e}")
    return reply

# ══════════════════════════════════════════════════════════════════════════
# MORNING BRIEFING
# ══════════════════════════════════════════════════════════════════════════

def send_morning_briefing():
    try:
        sleep = supabase.table("polar_sleep")\
            .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv")\
            .order("date", desc=True).limit(7).execute()
        hrv = supabase.table("polar_hrv")\
            .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
            .order("date", desc=True).limit(1).execute()

        bot.send_message(YOUR_TELEGRAM_ID,
            format_recovery_dashboard(sleep.data, hrv.data),
            parse_mode="Markdown")

        response = claude.messages.create(
            model="claude-opus-4-5",
            max_tokens=500,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": (
                "Give Luke a concise morning coaching briefing: "
                "today's recommended session with effort level, "
                "one key flag from recent training or recovery, "
                "weekly load check vs target. Max 4 short paragraphs."
            )}]
        )
        reply = extract_and_save_note(response.content[0].text, "morning briefing")
        bot.send_message(YOUR_TELEGRAM_ID,
            f"☀️ *Morning Briefing*\n\n{reply}",
            parse_mode="Markdown")

    except Exception as e:
        log.error(f"Briefing error: {e}")

# ══════════════════════════════════════════════════════════════════════════
# BACKGROUND LOOPS
# ══════════════════════════════════════════════════════════════════════════

def polar_sync_loop():
    while True:
        try:
            # Exercises
            new = sync_new_polar_exercises()
            for ex in new:
                msg = format_new_run_notification(ex["data"], ex["id"], ex["splits"])
                bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode="Markdown")
            # Sleep, recharge, activity
            sleep_n    = sync_sleep()
            recharge_n = sync_nightly_recharge()
            activity_n = sync_daily_activity()
            if sleep_n or recharge_n or activity_n:
                log.info(f"Passive sync: sleep={sleep_n} recharge={recharge_n} activity={activity_n}")
        except Exception as e:
            log.error(f"Sync loop error: {e}")
        time.sleep(300)

def scheduler_loop():
    while True:
        now    = datetime.now(timezone.utc)
        target = now.replace(hour=7, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        time.sleep((target - now).total_seconds())
        send_morning_briefing()

# ══════════════════════════════════════════════════════════════════════════
# TELEGRAM HANDLERS
# ══════════════════════════════════════════════════════════════════════════

@bot.message_handler(func=lambda m: True)
def handle_message(message):
    chat_id   = message.chat.id
    if chat_id != YOUR_TELEGRAM_ID:
        bot.reply_to(message, "Unauthorised.")
        return

    user_text = message.text.strip()
    lower     = user_text.lower()

    # ── /start /help ──
    if lower in ["/start", "/help"]:
        bot.reply_to(message, (
            "👋 *Hey Luke!* I'm your Polar running coach.\n\n"
            "*Commands:*\n"
            "/sync — check for new runs\n"
            "/briefing — morning briefing now\n"
            "/splits — km splits for last run\n"
            "/runs — last 10 runs  _(or /runs 30)_\n"
            "/recovery — sleep & HRV dashboard\n"
            "/load — weekly training load\n"
            "/goals — view target races\n"
            "/clear — clear conversation\n\n"
            "*Log data:*\n"
            "`goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`\n"
            "`save run: <paste Polar Flow stats or type key numbers>`\n"
            "`checkin: weight 77.5kg, fatigue 6/10, sleep 7/10`\n\n"
            "Or just ask me anything 💬"
        ), parse_mode="Markdown")
        return

    # ── /sync ──
    if lower == "/sync":
        bot.reply_to(message, "🔄 Checking Polar...")
        new = sync_new_polar_exercises()
        if new:
            for ex in new:
                bot.send_message(chat_id,
                    format_new_run_notification(ex["data"], ex["id"], ex["splits"]),
                    parse_mode="Markdown")
        else:
            bot.send_message(chat_id, "No new exercises found.")
        return

    # ── /briefing ──
    if lower == "/briefing":
        bot.reply_to(message, "⏳ Generating briefing...")
        send_morning_briefing()
        return

    # ── /splits ──
    if lower == "/splits":
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
    if lower.startswith("/runs"):
        try:
            parts = user_text.split()
            limit = int(parts[1]) if len(parts) > 1 else 10
            limit = min(limit, 100)
            runs  = supabase.table("polar_exercises")\
                .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,source")\
                .order("date", desc=True).limit(limit).execute()
            bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /recovery ──
    if lower == "/recovery":
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
    if lower == "/load":
        try:
            now             = datetime.now(timezone.utc)
            week_start      = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
            last_week_start = (now - timedelta(days=now.weekday()+7)).strftime("%Y-%m-%d")
            this_week = supabase.table("polar_exercises")\
                .select("training_load,distance_meters,date,sport")\
                .gte("date", week_start).order("date", desc=True).execute()
            last_week = supabase.table("polar_exercises")\
                .select("training_load,distance_meters,date,sport")\
                .gte("date", last_week_start).lt("date", week_start).execute()
            def sum_load(rows): return sum(r.get("training_load") or 0 for r in rows)
            def sum_km(rows):   return sum((r.get("distance_meters") or 0)/1000 for r in rows)
            lines = ["📈 *Weekly Training Load*\n"]
            lines.append(f"*This week:*  {sum_km(this_week.data):.1f}km  •  Load {sum_load(this_week.data):.0f}  •  {len(this_week.data)} sessions")
            for r in this_week.data:
                dist = (r.get("distance_meters") or 0)/1000
                load = f"  Load {r['training_load']:.0f}" if r.get("training_load") else ""
                lines.append(f"  {sport_emoji(r.get('sport',''))} {fmt_date(r['date'])}  {dist:.1f}km{load}")
            lines.append(f"\n*Last week:*  {sum_km(last_week.data):.1f}km  •  Load {sum_load(last_week.data):.0f}  •  {len(last_week.data)} sessions")
            bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /goals ──
    if lower == "/goals":
        try:
            goals = supabase.table("goals")\
                .select("race_name,race_date,distance_km,target_time,priority,notes")\
                .eq("active", True).order("race_date").execute()
            bot.reply_to(message, format_goals(goals.data), parse_mode="Markdown")
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
        return

    # ── /clear ──
    if lower == "/clear":
        conversation_history[chat_id] = []
        bot.reply_to(message, "Conversation cleared.")
        return

    # ── Write triggers ──
    if re.match(r"^(goal|race|target)\s*[:：]", lower):
        bot.reply_to(message, save_goal(user_text), parse_mode="Markdown")
        return

    if re.match(r"^(save\s+run|log\s+run|manual\s+run|run\s+log)\s*[:：]", lower):
        bot.reply_to(message, save_manual_run(user_text), parse_mode="Markdown")
        return

    if re.match(r"^(check.?in|checkin|wellness)\s*[:：]", lower):
        bot.reply_to(message, save_wellness_checkin(user_text), parse_mode="Markdown")
        return

    # ── Natural language history detection ──
    run_limit  = detect_history_request(user_text) or 10
    sleep_days = detect_recovery_window(user_text)

    run_list_keywords = ["show", "list", "display", "give me", "last", "all my"]
    is_run_list_req   = any(kw in lower for kw in run_list_keywords) and \
                        ("run" in lower or "session" in lower) and run_limit > 10

    if is_run_list_req:
        try:
            runs = supabase.table("polar_exercises")\
                .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,source")\
                .order("date", desc=True).limit(run_limit).execute()
            bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
            return
        except Exception as e:
            bot.reply_to(message, f"Error: {e}")
            return

    recovery_keywords = ["sleep", "recovery", "recharge", "hrv", "rest"]
    is_recovery_req   = any(kw in lower for kw in recovery_keywords) and sleep_days > 7

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

        reply = extract_and_save_note(response.content[0].text, user_text[:100])
        add_to_history(chat_id, "assistant", reply)

        if len(reply) > 4000:
            for i in range(0, len(reply), 4000):
                bot.send_message(chat_id, reply[i:i+4000], parse_mode="Markdown")
        else:
            bot.reply_to(message, reply, parse_mode="Markdown")

    except Exception as e:
        log.error(f"Claude error: {e}")
        bot.reply_to(message, f"Error: {e}")

# ══════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    log.info("🏃 Polar Running Coach Bot v4 starting...")
    threading.Thread(target=polar_sync_loop, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    bot.infinity_polling(interval=1, timeout=30)