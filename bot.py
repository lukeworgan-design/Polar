"""
bot.py - Polar Running Coach Telegram Bot
Athlete: Luke Worgan | Watch: Polar Grit X2 | Deployed: Railway.app
"""

import os
import re
import io
import json
import logging
import threading
import time
import requests
from datetime import datetime, timedelta, timezone
from supabase import create_client
import anthropic
import telebot

try:
    import fitparse
except ImportError:
    fitparse = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

TELEGRAM_TOKEN      = os.environ["TELEGRAM_TOKEN"]
ANTHROPIC_API_KEY   = os.environ["ANTHROPIC_API_KEY"]
POLAR_ACCESS_TOKEN  = os.environ["POLAR_ACCESS_TOKEN"]
POLAR_CLIENT_ID     = os.environ["POLAR_CLIENT_ID"]
POLAR_CLIENT_SECRET = os.environ["POLAR_CLIENT_SECRET"]
POLAR_USER_ID       = os.environ["POLAR_USER_ID"]
YOUR_TELEGRAM_ID    = int(os.environ["YOUR_TELEGRAM_ID"])
GROUP_CHAT_ID       = -5260916370
SUPABASE_URL        = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY        = os.environ["SUPABASE_KEY"]

bot      = telebot.TeleBot(TELEGRAM_TOKEN)
claude   = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── ATHLETE CONTEXT — edit this block, nothing else ──────────────────────────
# All physiology, life constraints, kit, and goals live here.
# Every function and prompt reads from this dict.
ATHLETE = {
    # Identity
    "name":       "Luke",
    "dob":        "1989-03-03",    # age computed at runtime
    "height_cm":  167,
    # weight pulled live from wellness_checkins; this is a fallback only
    "weight_kg_fallback": 78,

    # Physiology — HR thresholds drive all training zone logic
    "vo2max":        55,
    "max_hr":        198,
    # resting_hr_baseline: 28-day rolling average computed at runtime;
    # this fallback is only used if no continuous HR data exists
    "resting_hr_fallback": 47,
    "aerobic_thr":   149,
    "anaerobic_thr": 178,
    # FTP removed — power zones not actively used in coaching

    # Kit
    "watch": "Polar Grit X2",
    "kit":   "1×20kg kettlebell, mat, ice bath, GOWOD subscription",

    # Recent form / identity
    "background": (
        "Experienced trail ultrarunner. Peer-level athlete — skip the basics. "
        "Cotswold Way Ultra 100km (13 Jun 2026, completed). Trailblazerz 100km (completed). "
        "Zone 2 base suits me. Fasted early-morning runs are normal."
    ),

    # Current phase
    "phase": (
        "Consistency, not fitness. NOT in a race block. "
        "Keep the engine ticking through a demanding life phase."
    ),

    # Long-horizon goal (hold lightly — no build pressure now)
    "horizon": "100-miler ~2027 (Centurion / Beacons Way candidates).",

    # Known patterns — never misread these
    "known_patterns": (
        "Sunday 2km = junior parkrun with son Billy (6yo). Family outing — debrief it warmly "
        "as a dad-and-kid run, celebrate it, but NEVER question the pace or treat it as "
        "training data. The slow pace is Billy's pace. That's the whole point."
    ),

    # Life constraints — respect absolutely
    "newborn_dob": "2026-08-10",   # youngest child's birthdate; age computed at runtime
    "constraints_static": (
        "Father of three. "
        "Training window: 5am Mon–Fri, ~1 hour. "
        "Weekends: protected family time — NO sessions, no long runs, no assumptions. "
        "Missed/shortened sessions are EXPECTED — adapt without guilt."
    ),

    # Voice
    "voice": (
        "Experienced peer, not a beginner's coach. "
        "Join the dots — always land: what the data says → why it matters → the call. "
        "Never dump raw metrics. Non-preachy. Concise (arrives at 5am on a phone). "
        "Value showing up over pace or load. A completed short session is a win."
    ),

    # Session menu (weekday 5am, ~1hr)
    "session_menu": "Run (easy Z2 / tempo / intervals) | Kettlebell | GOWOD mobility | Ice bath recovery | Rest",
}

def _live_resting_hr() -> int:
    """28-day rolling average of min_hr from continuous HR data, or fallback."""
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=28)).strftime("%Y-%m-%d")
        rows   = supabase.table("polar_continuous_hr").select("min_hr").gte("date", cutoff).execute()
        vals   = [r["min_hr"] for r in (rows.data or []) if r.get("min_hr")]
        if vals:
            return round(sum(vals) / len(vals))
    except Exception:
        pass
    return ATHLETE["resting_hr_fallback"]

def _live_weight_kg() -> float:
    """Latest weight: Polar Balance (physical_info) → manual check-in → fallback."""
    try:
        row = supabase.table("polar_physical_info").select("weight_kg").order("date", desc=True).limit(1).execute()
        if row.data and row.data[0].get("weight_kg"):
            return float(row.data[0]["weight_kg"])
    except Exception:
        pass
    try:
        row = supabase.table("wellness_checkins").select("weight_kg").order("date", desc=True).limit(1).execute()
        if row.data and row.data[0].get("weight_kg"):
            return float(row.data[0]["weight_kg"])
    except Exception:
        pass
    return ATHLETE["weight_kg_fallback"]

def _baby_age_weeks() -> int:
    dob = datetime.strptime(ATHLETE["newborn_dob"], "%Y-%m-%d").date()
    return (datetime.now(timezone.utc).date() - dob).days // 7

# Derived helpers — read from ATHLETE, never hardcode elsewhere
def athlete_age() -> int:
    dob = datetime.strptime(ATHLETE["dob"], "%Y-%m-%d").date()
    today = datetime.now(timezone.utc).date()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))

# ── MODULE CONSTANTS ──────────────────────────────────────────────────────────
RUNNING_SPORTS = {"RUNNING", "TRAIL_RUNNING", "TREADMILL_RUNNING"}
ALLOWED_SPORTS = RUNNING_SPORTS | {
    "STRENGTH_TRAINING", "FUNCTIONAL_TRAINING", "FLEXIBILITY_TRAINING",
    "YOGA", "STRETCHING", "CORE", "CROSS_TRAINING", "BOOTCAMP", "OTHER",
}
POLAR_BASE          = "https://www.polaraccesslink.com/v3"
RESTING_HR_BASELINE = ATHLETE["resting_hr_fallback"]
AEROBIC_THRESHOLD   = ATHLETE["aerobic_thr"]
ANAEROBIC_THRESHOLD = ATHLETE["anaerobic_thr"]
MAX_HR              = ATHLETE["max_hr"]

BRIEF_HOUR_UTC = int(os.environ.get("BRIEF_HOUR_UTC", "4"))  # 04:00 UTC = 05:00 BST

debriefed_today:    set = set()
alerts_fired_today: set = set()

# ── HELPERS ────────────────────────────────────────────────────────────────

def polar_headers():
    return {"Authorization": f"Bearer {POLAR_ACCESS_TOKEN}", "Accept": "application/json"}

def parse_pt_seconds(pt: str) -> float:
    if not pt: return 0.0
    m = re.match(r"PT([\d.]+)S$", pt)
    if m: return float(m.group(1))
    hours = re.search(r"(\d+)H", pt)
    mins  = re.search(r"(\d+)M", pt)
    secs  = re.search(r"([\d.]+)S", pt)
    total = 0.0
    if hours: total += float(hours.group(1)) * 3600
    if mins:  total += float(mins.group(1)) * 60
    if secs:  total += float(secs.group(1))
    return total

def _parse_pt_to_seconds(pt) -> int:
    if pt is None: return 0
    if isinstance(pt, (int, float)): return int(pt)
    pt = str(pt).strip()
    if not pt.startswith("PT"):
        try: return int(float(pt))
        except: return 0
    h = re.search(r"(\d+)H", pt)
    m = re.search(r"(\d+)M", pt)
    s = re.search(r"([\d.]+)S", pt)
    total = 0
    if h: total += int(h.group(1)) * 3600
    if m: total += int(m.group(1)) * 60
    if s: total += int(float(s.group(1)))
    return total

def seconds_to_pace(seconds: float) -> str:
    if not seconds or seconds <= 0: return "N/A"
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}/km"

def sf(v):
    try: return float(v) if v not in (None, "", "N/A") else None
    except: return None

def si(v):
    try: return int(float(v)) if v not in (None, "", "N/A") else None
    except: return None

def days_to_next_race() -> str:
    """Return a string like '42 days to Cheltenham Half' or 'No race scheduled'."""
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        goals = supabase.table("goals").select("race_name,race_date").eq("active", True).gte("race_date", today).order("race_date").limit(1).execute()
        if goals.data:
            g    = goals.data[0]
            d    = datetime.strptime(g["race_date"], "%Y-%m-%d").date()
            days = (d - datetime.now(timezone.utc).date()).days
            return f"{days} days to {g['race_name']}"
    except Exception:
        pass
    return "No race scheduled"

def recharge_emoji(status: str) -> str:
    if not status: return "⚪"
    s = status.upper()
    if "EXCELLENT" in s: return "🟢"
    if "GOOD" in s:      return "🟢"
    if "MODERATE" in s:  return "🟡"
    if "LOW" in s:       return "🔴"
    if "POOR" in s:      return "🔴"
    return "⚪"

def load_emoji(status: str) -> str:
    if not status: return "⚪"
    s = status.upper()
    if "PRODUCTIVE" in s:   return "🟢"
    if "MAINTAINING" in s:  return "🟡"
    if "OVERREACHING" in s: return "🔴"
    if "DETRAINING" in s:   return "⬇️"
    if "RECOVERY" in s:     return "🔵"
    return "⚪"

def grade_emoji(grade) -> str:
    if grade is None: return "⚪"
    g = float(grade) if grade else 0
    if g >= 8: return "🟢"
    if g >= 6: return "🟡"
    if g >= 4: return "🟠"
    return "🔴"

def readiness_emoji(score: float) -> str:
    if score >= 8: return "🟢"
    if score >= 6: return "🟡"
    if score >= 4: return "🟠"
    return "🔴"

def sport_emoji(sport: str) -> str:
    if not sport: return "🏃"
    if "TRAIL" in sport:     return "🏔️"
    if "TREADMILL" in sport: return "⚙️"
    return "🏃"

def fmt_date(date_str: str) -> str:
    try: return datetime.fromisoformat(date_str[:10]).strftime("%-d %b")
    except: return date_str[:10]

def get_latest_run_with_splits():
    try:
        runs = supabase.table("polar_exercises").select("polar_exercise_id,date,distance_meters,sport").order("date", desc=True).limit(30).execute()
        for run in runs.data:
            check = supabase.table("polar_km_splits").select("id").eq("exercise_id", run["polar_exercise_id"]).limit(1).execute()
            if check.data: return run
    except Exception as e:
        log.error(f"get_latest_run_with_splits error: {e}")
    return None

def detect_history_request(text: str):
    text = text.lower()
    m = re.search(r"last\s+(\d+)\s+runs?", text)
    if m: return min(int(m.group(1)), 200)
    m = re.search(r"last\s+(\d+)\s+months?", text)
    if m: return min(int(m.group(1)) * 30, 365)
    if "last month" in text: return 30
    if "last 3 months" in text or "last three months" in text: return 90
    if "last 6 months" in text or "last six months" in text: return 180
    if "all" in text and ("run" in text or "history" in text): return 200
    return None

def detect_recovery_window(text: str) -> int:
    text = text.lower()
    m = re.search(r"last\s+(\d+)\s+(?:days?|nights?)", text)
    if m: return min(int(m.group(1)), 90)
    if "last month" in text: return 30
    if "last 2 weeks" in text or "last two weeks" in text: return 14
    if "last week" in text: return 7
    return 7

# ── INTELLIGENCE ENGINE ────────────────────────────────────────────────────

def compute_readiness_score() -> dict:
    scores   = {}
    raw_data = {}
    try:
        sw = supabase.table("polar_sleepwise").select("date,grade,grade_classification").order("date", desc=True).limit(1).execute()
        if sw.data and sw.data[0].get("grade") is not None:
            grade = float(sw.data[0]["grade"])
            raw_data["sw_grade"] = grade
            scores["sleepwise"] = min(grade / 10.0, 1.0)
        else:
            scores["sleepwise"] = 0.6
    except:
        scores["sleepwise"] = 0.6

    try:
        cl = supabase.table("polar_cardio_load").select("date,cardio_load_ratio,cardio_load_status").order("date", desc=True).limit(1).execute()
        if cl.data and cl.data[0].get("cardio_load_ratio") is not None:
            ratio = float(cl.data[0]["cardio_load_ratio"])
            raw_data["load_ratio"]  = ratio
            raw_data["load_status"] = cl.data[0].get("cardio_load_status", "")
            if ratio < 0.6:    cl_score = 0.5
            elif ratio < 0.8:  cl_score = 0.7
            elif ratio <= 1.1: cl_score = 1.0
            elif ratio <= 1.3: cl_score = 0.6
            else:              cl_score = 0.2
            scores["cardio_load"] = cl_score
        else:
            scores["cardio_load"] = 0.6
    except:
        scores["cardio_load"] = 0.6

    try:
        chr_data = supabase.table("polar_continuous_hr").select("date,min_hr").order("date", desc=True).limit(3).execute()
        if chr_data.data:
            hr_vals = [r["min_hr"] for r in chr_data.data if r.get("min_hr")]
            if hr_vals:
                avg_resting = sum(hr_vals) / len(hr_vals)
                raw_data["avg_resting_hr"] = round(avg_resting, 1)
                elevation = avg_resting - RESTING_HR_BASELINE
                if elevation <= 0:    hr_score = 1.0
                elif elevation <= 3:  hr_score = 0.85
                elif elevation <= 6:  hr_score = 0.65
                elif elevation <= 10: hr_score = 0.4
                else:                 hr_score = 0.2
                scores["resting_hr"] = hr_score
            else:
                scores["resting_hr"] = 0.6
        else:
            scores["resting_hr"] = 0.6
    except:
        scores["resting_hr"] = 0.6

    try:
        hrv_data = supabase.table("polar_hrv").select("date,hrv_avg").order("date", desc=True).limit(14).execute()
        if hrv_data.data and len(hrv_data.data) >= 4:
            this_week_hrv = [r["hrv_avg"] for r in hrv_data.data[:7]  if r.get("hrv_avg")]
            last_week_hrv = [r["hrv_avg"] for r in hrv_data.data[7:14] if r.get("hrv_avg")]
            if this_week_hrv and last_week_hrv:
                this_avg = sum(this_week_hrv) / len(this_week_hrv)
                last_avg = sum(last_week_hrv) / len(last_week_hrv)
                raw_data["hrv_this_week"] = round(this_avg, 1)
                raw_data["hrv_last_week"] = round(last_avg, 1)
                pct_change = (this_avg - last_avg) / last_avg if last_avg else 0
                if pct_change >= 0.05:    hrv_score = 1.0
                elif pct_change >= -0.05: hrv_score = 0.8
                elif pct_change >= -0.10: hrv_score = 0.55
                else:                     hrv_score = 0.3
                scores["hrv"] = hrv_score
            else:
                scores["hrv"] = 0.6
        else:
            scores["hrv"] = 0.6
    except:
        scores["hrv"] = 0.6

    try:
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        well = supabase.table("wellness_checkins").select("date,fatigue_score,sleep_score,mood_score").order("date", desc=True).limit(1).execute()
        if well.data and well.data[0].get("date") == today_str:
            w        = well.data[0]
            fatigue  = w.get("fatigue_score") or 5
            sleep_sc = w.get("sleep_score")   or 5
            mood     = w.get("mood_score")    or 5
            well_mod = (10 - fatigue + sleep_sc + mood) / 30.0 - 0.5
            raw_data["wellness_mod"] = round(well_mod, 2)
        else:
            well_mod = 0
    except:
        well_mod = 0

    weighted = (
        scores.get("sleepwise",   0.6) * 0.30 +
        scores.get("cardio_load", 0.6) * 0.30 +
        scores.get("resting_hr",  0.6) * 0.20 +
        scores.get("hrv",         0.6) * 0.20
    )
    raw_score = weighted + well_mod
    final     = max(1.0, min(10.0, round(raw_score * 10, 1)))
    if final >= 8:   label = "Excellent — go hard"
    elif final >= 6: label = "Good — train as planned"
    elif final >= 5: label = "Moderate — reduce intensity"
    elif final >= 3: label = "Poor — easy only"
    else:            label = "Very poor — rest day"
    return {"score": final, "label": label, "components": scores, "raw_data": raw_data}


def recommend_session(readiness: dict) -> str:
    """Readiness-led recommendation for a ~1hr weekday 5am slot."""
    score = readiness["score"]
    ratio = readiness["raw_data"].get("load_ratio", 1.0)

    # Check days since last run to catch detraining
    try:
        last_run = supabase.table("polar_exercises").select("date").in_("sport", list(RUNNING_SPORTS)).order("date", desc=True).limit(1).execute()
        if last_run.data:
            last_run_days = (datetime.now(timezone.utc).date() - datetime.strptime(last_run.data[0]["date"][:10], "%Y-%m-%d").date()).days
        else:
            last_run_days = 99
    except Exception:
        last_run_days = 0

    if score >= 7.5:
        if last_run_days >= 5:
            return "RUN — easy 40–50min Z2, HR <149bpm. Body's recovered; just move."
        if ratio > 1.15:
            return "KETTLEBELL — load already elevated. Swings / goblet squats / Turkish get-ups, 30–35min."
        return "RUN — quality session: 35min easy then 10min at aerobic threshold (149–165bpm), or 4×5min efforts with 3min float."
    elif score >= 6:
        return "RUN — easy 35–45min Z2, HR <149bpm. Conversational pace, no heroics."
    elif score >= 4.5:
        return "KETTLEBELL or GOWOD — readiness moderate. If moving, 30min kettlebell (swings, goblet squats, core). Otherwise GOWOD mobility."
    elif score >= 3:
        return "GOWOD or ICE BATH — body asking for recovery. Mobility session or cold exposure, not a run."
    else:
        return "REST — readiness low. Sleep in, eat well, move only if it feels good."


def check_and_push_alerts():
    global alerts_fired_today
    alerts = []
    try:
        cl = supabase.table("polar_cardio_load").select("date,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(1).execute()
        if cl.data:
            ratio = cl.data[0].get("cardio_load_ratio")
            if ratio and float(ratio) > 1.3 and "overreaching_alert" not in alerts_fired_today:
                alerts_fired_today.add("overreaching_alert")
                alerts.append(f"🔴 *OVERREACHING ALERT*\nCardio load ratio: {float(ratio):.2f} (threshold: 1.30)\nStrain {cl.data[0].get('strain','?')} vs Tolerance {cl.data[0].get('tolerance','?')}\nMandatory easy day or rest. No quality sessions until ratio drops below 1.1.")
            if ratio and float(ratio) < 0.7 and "detraining_alert" not in alerts_fired_today:
                five_days_ago = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%d")
                recent = supabase.table("polar_exercises").select("date").gte("date", five_days_ago).limit(1).execute()
                if not recent.data:
                    alerts_fired_today.add("detraining_alert")
                    alerts.append(f"⬇️ *DETRAINING RISK*\nNo sessions in 5+ days. Load ratio: {float(ratio):.2f}\nEven 20–30min easy keeps the engine ticking.")
    except Exception as e:
        log.error(f"Alert check cardio load: {e}")

    try:
        if "elevated_hr_alert" not in alerts_fired_today:
            chr_data = supabase.table("polar_continuous_hr").select("date,min_hr").order("date", desc=True).limit(3).execute()
            if chr_data.data and len(chr_data.data) >= 3:
                elevated = [r for r in chr_data.data if r.get("min_hr") and float(r["min_hr"]) > RESTING_HR_BASELINE + 5]
                if len(elevated) >= 3:
                    alerts_fired_today.add("elevated_hr_alert")
                    avg_hr = round(sum(float(r["min_hr"]) for r in elevated) / len(elevated), 1)
                    alerts.append(f"❤️ *ELEVATED RESTING HR — 3 DAYS*\nAvg resting HR: {avg_hr}bpm (baseline: {RESTING_HR_BASELINE}bpm)\nSystemic fatigue signal. Prioritise sleep and reduce load.")
    except Exception as e:
        log.error(f"Alert check HR: {e}")

    try:
        if "hrv_decline_alert" not in alerts_fired_today:
            hrv_data = supabase.table("polar_hrv").select("date,hrv_avg").order("date", desc=True).limit(14).execute()
            if hrv_data.data and len(hrv_data.data) >= 8:
                this_w = [r["hrv_avg"] for r in hrv_data.data[:7]  if r.get("hrv_avg")]
                last_w = [r["hrv_avg"] for r in hrv_data.data[7:14] if r.get("hrv_avg")]
                if this_w and last_w:
                    this_avg = sum(this_w) / len(this_w)
                    last_avg = sum(last_w) / len(last_w)
                    pct      = (this_avg - last_avg) / last_avg if last_avg else 0
                    if pct < -0.10:
                        alerts_fired_today.add("hrv_decline_alert")
                        alerts.append(f"📉 *HRV DECLINING*\nThis week: {this_avg:.1f} vs last week: {last_avg:.1f} ({pct*100:.1f}%)\nRecovery debt building. Reduce intensity and increase sleep.")
    except Exception as e:
        log.error(f"Alert check HRV: {e}")

    try:
        if "sleepwise_poor_alert" not in alerts_fired_today:
            sw = supabase.table("polar_sleepwise").select("date,grade,grade_classification").order("date", desc=True).limit(1).execute()
            if sw.data and sw.data[0].get("grade") is not None:
                grade     = float(sw.data[0]["grade"])
                sw_date   = sw.data[0].get("date", "")
                today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                if grade < 5 and sw_date == today_str:
                    alerts_fired_today.add("sleepwise_poor_alert")
                    gc = (sw.data[0].get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
                    alerts.append(f"🧠 *POOR SLEEPWISE GRADE*\nToday's alertness: {grade}/10 ({gc})\nDowngrade today's session — easy run or rest.")
    except Exception as e:
        log.error(f"Alert check SleepWise: {e}")

    for alert in alerts:
        try:
            bot.send_message(YOUR_TELEGRAM_ID, alert, parse_mode="Markdown")
            time.sleep(1)
        except Exception as e:
            log.error(f"Alert send error: {e}")
    return len(alerts)


def format_status_dashboard() -> str:
    readiness  = compute_readiness_score()
    session    = recommend_session(readiness)
    score      = readiness["score"]
    rd         = readiness["raw_data"]
    comp       = readiness["components"]
    race_str   = days_to_next_race()
    sw_grade   = rd.get("sw_grade", "?")
    sw_emoji   = grade_emoji(sw_grade) if sw_grade != "?" else "⚪"
    sw_score   = round(comp.get("sleepwise", 0.6) * 10, 1)
    ratio      = rd.get("load_ratio", "?")
    status_str = (rd.get("load_status") or "").replace("_", " ").title()
    cl_emoji   = load_emoji(rd.get("load_status", ""))
    cl_score   = round(comp.get("cardio_load", 0.6) * 10, 1)
    avg_rhr    = rd.get("avg_resting_hr", "?")
    hr_emoji   = "🟢" if comp.get("resting_hr", 0.6) >= 0.8 else "🟡" if comp.get("resting_hr", 0.6) >= 0.6 else "🔴"
    hr_score   = round(comp.get("resting_hr", 0.6) * 10, 1)
    hrv_this   = rd.get("hrv_this_week", "?")
    hrv_last   = rd.get("hrv_last_week", "?")
    hrv_emoji  = "🟢" if comp.get("hrv", 0.6) >= 0.8 else "🟡" if comp.get("hrv", 0.6) >= 0.6 else "🔴"
    hrv_score  = round(comp.get("hrv", 0.6) * 10, 1)
    lines = [
        f"{readiness_emoji(score)} *Readiness: {score}/10* — _{readiness['label']}_", "",
        f"{sw_emoji} 🧠 SleepWise {sw_grade}/10 · {sw_score}/10 _(30%)_",
        f"{cl_emoji} 🔥 Load ratio {ratio} · {status_str} · {cl_score}/10 _(30%)_",
        f"{hr_emoji} ❤️ Resting HR {avg_rhr}bpm · {hr_score}/10 _(20%)_",
        f"{hrv_emoji} 📉 HRV {hrv_this} vs {hrv_last}wk · {hrv_score}/10 _(20%)_",
        "", f"🎯 *{race_str}*",
        f"💡 _{session}_",
    ]
    return "\n".join(lines)
# ── FIT FILE PARSING ───────────────────────────────────────────────────────

def parse_fit_laps(fit_bytes: bytes, exercise_id: str, session_date: str, total_distance_m: float = None) -> list:
    if not fitparse: return []
    try:
        fitfile       = fitparse.FitFile(io.BytesIO(fit_bytes))
        split_rows    = []
        lap_num       = 0
        expected_laps = int((total_distance_m or 0) / 1000) if total_distance_m else None
        for record in fitfile.get_messages("lap"):
            data = {d.name: d.value for d in record}
            if expected_laps is not None and lap_num >= expected_laps: continue
            lap_dur   = sf(data.get("total_elapsed_time") or data.get("total_timer_time"))
            dist_m    = sf(data.get("total_distance"))
            pace_s    = None
            avg_speed = sf(data.get("avg_speed") or data.get("enhanced_avg_speed"))
            if avg_speed and avg_speed > 0: pace_s = 1000 / avg_speed
            elif lap_dur and dist_m and dist_m > 0: pace_s = lap_dur / (dist_m / 1000)
            hr_avg          = si(data.get("avg_heart_rate"))
            hr_max          = si(data.get("max_heart_rate"))
            power_avg       = si(data.get("avg_power"))
            power_max       = si(data.get("max_power"))
            cadence_raw     = sf(data.get("avg_running_cadence") or data.get("avg_cadence"))
            cadence_max_raw = sf(data.get("max_running_cadence") or data.get("max_cadence"))
            cadence_avg     = si(cadence_raw * 2)     if cadence_raw     else None
            cadence_max     = si(cadence_max_raw * 2) if cadence_max_raw else None
            split_rows.append({
                "exercise_id": exercise_id, "session_date": session_date,
                "lap_number": lap_num, "km_number": lap_num + 1,
                "duration_seconds": lap_dur, "split_time_seconds": sf(data.get("total_elapsed_time")),
                "distance_m": dist_m, "pace_min_per_km": sf(pace_s / 60) if pace_s else None,
                "pace_display": seconds_to_pace(pace_s) if pace_s else "N/A",
                "hr_avg": hr_avg, "hr_max": hr_max, "power_avg": power_avg, "power_max": power_max,
                "cadence_avg": cadence_avg, "cadence_max": cadence_max, "ascent_m": None, "descent_m": None,
            })
            lap_num += 1
        return split_rows
    except Exception as e:
        log.error(f"FIT parse error {exercise_id}: {e}")
        return []

def fetch_fit_and_parse(exercise_id: str, session_date: str, total_distance_m: float = None) -> list:
    try:
        r = requests.get(f"{POLAR_BASE}/exercises/{exercise_id}/fit", headers={"Authorization": f"Bearer {POLAR_ACCESS_TOKEN}", "Accept": "application/octet-stream"})
        if not r.ok: return []
        return parse_fit_laps(r.content, exercise_id, session_date, total_distance_m)
    except Exception as e:
        log.error(f"FIT fetch error {exercise_id}: {e}")
        return []

# ── FORMATTING ─────────────────────────────────────────────────────────────

def format_run_list(runs: list) -> str:
    if not runs: return "No runs found."
    lines = [f"🏃 *Last {len(runs)} Runs*\n"]
    for r in runs:
        dist_km  = (r.get("distance_meters") or 0) / 1000
        dur_s    = r.get("duration_seconds") or 0
        pace_s   = dur_s / dist_km if dist_km else 0
        load     = r.get("training_load")
        load_str = f"  🔥 {load:.0f}" if load else ""
        source   = " ✏️" if r.get("source") == "manual" else ""
        pwr_str  = f"{r.get('avg_power')}W" if r.get("avg_power") else "?"
        cad_str  = f"{r.get('avg_cadence')}spm" if r.get("avg_cadence") else "?"
        lines.append(f"{sport_emoji(r.get('sport',''))} *{fmt_date(r['date'])}*{source}  •  {dist_km:.1f}km  •  {int(dur_s//60)}min\n   💨 {seconds_to_pace(pace_s)}  ❤️ {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')}  ⚡ {pwr_str}  👟 {cad_str}{load_str}")
    return "\n".join(lines)

def format_splits_table(splits: list, header: str) -> str:
    if not splits: return "No splits found."
    lines = [f"📊 *{header}*\n", "`KM  │ Pace     │ HR      │  Power │ Cad`", "`────┼──────────┼─────────┼────────┼────`"]
    for s in splits:
        km    = str(s.get("km_number", "?")).rjust(2)
        pace  = (s.get("pace_display") or "N/A").ljust(8)
        hr    = f"{s.get('hr_avg','?')}/{s.get('hr_max','?')}".ljust(7)
        power = str(s.get("power_avg") or "?").rjust(4) + "W"
        cad   = str(s.get("cadence_avg") or "?").rjust(3)
        lines.append(f"`{km}  │ {pace} │ {hr} │ {power:>6} │ {cad}`")
    return "\n".join(lines)

def format_recovery_dashboard(sleep_data: list, hrv_data: list) -> str:
    lines = ["💤 *Recovery*\n"]
    if hrv_data:
        h = hrv_data[0]
        hrv_avg  = h.get('hrv_avg')  or '—'
        hrv_rms  = h.get('hrv_rmssd') or '—'
        ans      = h.get('ans_charge') or '—'
        lines.append(f"{recharge_emoji(h.get('recharge_status',''))} *Recharge {h['date']}*\nANS {ans} · HRV {hrv_avg} · RMSSD {hrv_rms}\n")
    if sleep_data:
        lines.append("😴 *Sleep — last 7 nights*\n")
        for s in sleep_data:
            total_s = s.get("total_sleep_seconds") or 0
            score   = s.get("sleep_score") or 0
            hrs     = total_s // 3600
            mins    = (total_s % 3600) // 60
            rem_m   = (s.get("rem_seconds") or 0) // 60
            deep_m  = (s.get("deep_sleep_seconds") or 0) // 60
            hrv_val = s.get("avg_hrv") or '—'
            filled  = int(score / 10)
            bar     = "█" * filled + "░" * (10 - filled)
            sg      = "🟢" if score >= 70 else "🟡" if score >= 50 else "🔴"
            lines.append(f"{sg} *{s['date']}*  {hrs}h{mins:02d}m  Score {score:.0f}  HRV {hrv_val}\n{bar}  REM {rem_m}m · Deep {deep_m}m")
    return "\n".join(lines)

def format_hr_dashboard(hr_data: list) -> str:
    if not hr_data: return "No continuous HR data."
    lines = ["❤️ *Continuous HR*\n"]
    for h in hr_data:
        avg = h.get('avg_hr','?')
        rhr = h.get('min_hr','?')
        hi  = h.get('max_hr','?')
        flag = "🔴" if isinstance(rhr, (int,float)) and rhr > RESTING_HR_BASELINE + 5 else "🟢"
        lines.append(f"{flag} *{h['date']}* · ❤️ {avg} · ↓{rhr} · ↑{hi}bpm")
    return "\n".join(lines)

def format_cardio_load_dashboard(load_data: list) -> str:
    if not load_data: return "No cardio load data."
    lines = ["🔥 *Cardio Load*\n"]
    for c in load_data:
        status = (c.get("cardio_load_status") or "").replace("_", " ").title()
        strain = c.get("strain");  tol = c.get("tolerance");  ratio = c.get("cardio_load_ratio")
        s_str  = f" · 💪 {strain:.0f}" if strain else ""
        t_str  = f" / {tol:.0f}"       if tol    else ""
        r_str  = f" · ×{ratio:.2f}"    if ratio  else ""
        lines.append(f"{load_emoji(c.get('cardio_load_status',''))} *{c['date']}* {status}{s_str}{t_str}{r_str}")
    return "\n".join(lines)

def format_sleepwise_dashboard(sw_data: list) -> str:
    if not sw_data: return "No SleepWise data."
    lines = ["🧠 *SleepWise*\n"]
    for s in sw_data:
        grade   = s.get("grade")
        gc      = (s.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_"," ").title()
        inertia = (s.get("sleep_inertia") or "").replace("SLEEP_INERTIA_","").replace("_"," ").title()
        bed_str = f" · 🛏 {s.get('circadian_bedtime_start','')}–{s.get('circadian_bedtime_end','')}" if s.get("circadian_bedtime_start") else ""
        lines.append(f"{grade_emoji(grade)} *{s['date']}* {grade or '?'}/10 · {gc} · 💤 {inertia}{bed_str}")
    return "\n".join(lines)

def format_goals(goals: list) -> str:
    if not goals: return "No goals set. Add one with:\n`goal: Cheltenham Half, 21 Sep 2026, 21.1km, sub 2:00`"
    lines = ["🎯 *Goals & Target Races*\n"]
    for g in goals:
        days_to = ""
        if g.get("race_date"):
            try:
                d       = datetime.strptime(g["race_date"], "%Y-%m-%d").date()
                diff    = (d - datetime.now().date()).days
                days_to = f"  •  {diff}d away" if diff > 0 else "  •  PAST"
            except: pass
        lines.append(f"{'⭐' if g.get('priority')==1 else '🔹'} *{g.get('race_name','?')}*\n   📅 {g.get('race_date','?')}{days_to}\n   📏 {g.get('distance_km','?')}km  •  🎯 {g.get('target_time','?')}\n   {g.get('notes','') or ''}")
    return "\n".join(lines)

def format_new_run_notification(ex: dict, exercise_id: str, splits_count: int) -> str:
    try:
        sport   = ex.get("sport", "RUN")
        dist_km = (ex.get("distance") or ex.get("distance_meters") or 0) / 1000
        dur_s   = parse_pt_seconds(ex.get("duration", "")) or (ex.get("duration_seconds") or 0)
        hr      = ex.get("heart_rate", {}) or {}
        avg_hr  = hr.get("average") or hr.get("avg") or ex.get("avg_heart_rate", "?")
        max_hr  = hr.get("maximum") or hr.get("max") or ex.get("max_heart_rate", "?")
        load    = ex.get("training_load") or ex.get("training_load_pro", {}).get("cardio-load", "?")
        pace_s  = dur_s / dist_km if dist_km else 0
        lines   = [f"{sport_emoji(sport)} *New {sport.replace('_',' ').title()} Synced!*\n", f"📅 {fmt_date(ex.get('start_time') or ex.get('date',''))}  •  {dist_km:.2f}km  •  {int(dur_s//60)}min", f"💨 {seconds_to_pace(pace_s)}  ❤️ {avg_hr}/{max_hr}bpm", f"🔥 Load {load}", f"📊 {splits_count} km splits saved"]
        if splits_count > 0:
            split_data = supabase.table("polar_km_splits").select("km_number,pace_display,hr_avg,power_avg,cadence_avg").eq("exercise_id", exercise_id).order("lap_number").limit(5).execute()
            if split_data.data:
                lines.append("\n*First splits:*")
                lines.append("`KM  │ Pace     │  HR │ Power │ Cad`")
                for s in split_data.data:
                    lines.append(f"`{str(s['km_number']).rjust(2)}  │ {(s.get('pace_display') or 'N/A').ljust(8)} │ {str(s.get('hr_avg') or '?').rjust(3)} │ {str(s.get('power_avg') or '?').rjust(4)}W │ {str(s.get('cadence_avg') or '?').rjust(3)}`")
        return "\n".join(lines)
    except Exception as e:
        log.error(f"Format notification error: {e}")
        return "✅ New run synced"

# ── WRITE TO SUPABASE ──────────────────────────────────────────────────────

def save_coaching_note(topic: str, summary: str, full_response: str):
    try:
        supabase.table("coaching_notes").insert({"date": datetime.now().strftime("%Y-%m-%d"), "topic": topic[:200], "summary": summary[:500], "full_response": full_response[:5000]}).execute()
    except Exception as e:
        log.error(f"Save coaching note error: {e}")

def save_goal(text: str) -> str:
    try:
        text  = re.sub(r"^(goal|race|target)\s*[:：]\s*", "", text.strip(), flags=re.IGNORECASE)
        parts = [p.strip() for p in text.split(",")]
        if len(parts) < 2: return "Format: `goal: Cheltenham Half, 21 Sep 2026, 21.1km, sub 2:00`"
        race_name = parts[0]; race_date = None; distance_km = None; target_time = None; notes = None
        for p in parts[1:]:
            date_match = re.search(r"(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})", p)
            if date_match and not race_date:
                try: race_date = datetime.strptime(date_match.group(1), "%d %b %Y").strftime("%Y-%m-%d")
                except:
                    try: race_date = datetime.strptime(date_match.group(1), "%Y-%m-%d").strftime("%Y-%m-%d")
                    except: pass
                continue
            dist_match = re.search(r"([\d.]+)\s*km", p, re.IGNORECASE)
            if dist_match and not distance_km: distance_km = float(dist_match.group(1)); continue
            if re.search(r"(sub|under|target|<|goal)?\s*\d+[:h]\d+", p, re.IGNORECASE) and not target_time: target_time = p.strip(); continue
            notes = p.strip()
        supabase.table("goals").insert({"race_name": race_name, "race_date": race_date, "distance_km": distance_km, "target_time": target_time, "notes": notes, "priority": 1, "active": True}).execute()
        return f"🎯 *Goal saved!*\n\n*{race_name}*\n📅 {race_date or 'date TBC'}  •  📏 {distance_km or '?'}km\n🎯 {target_time or 'time TBC'}"
    except Exception as e:
        log.error(f"Save goal error: {e}")
        return f"Error saving goal: {e}"

def save_manual_run(text: str) -> str:
    raw_json = None
    try:
        raw   = re.sub(r"^(save\s+run|log\s+run|manual\s+run|run\s+log)\s*[:：]\s*", "", text.strip(), flags=re.IGNORECASE)
        today = datetime.now().strftime("%Y-%m-%d")
        parse_resp = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=1000,
            system="You are a precise data parser for running data. Extract all fields and return ONLY a valid JSON object. No markdown, no backticks, no explanation. All string values must use double quotes. Use null for missing fields. All numeric values must be plain numbers.\n\nRequired fields: date (YYYY-MM-DD), sport (RUNNING/TRAIL_RUNNING/TREADMILL_RUNNING), distance_meters, duration_seconds, avg_heart_rate, max_heart_rate, avg_power, max_power, avg_cadence, max_cadence, ascent, descent, calories, training_load, muscle_load, notes, splits (array).\n\nEach split: km_number, duration_seconds, split_time_seconds, distance_m, hr_avg, hr_max, power_avg, power_max, cadence_avg, cadence_max, pace_display (MM:SS/km).",
            messages=[{"role": "user", "content": f"Today is {today}. Parse this run:\n\n{raw}"}]
        )
        raw_json = re.sub(r"^```[a-zA-Z]*\s*", "", parse_resp.content[0].text.strip(), flags=re.MULTILINE)
        raw_json = re.sub(r"```\s*$", "", raw_json, flags=re.MULTILINE).strip()
        fields   = json.loads(raw_json)
        ex_id    = f"manual-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        run_date = fields.get("date") or today
        dur_s    = fields.get("duration_seconds") or 0
        dist_m   = fields.get("distance_meters") or 0
        pace_s   = dur_s / (dist_m / 1000) if dist_m else 0
        sport    = fields.get("sport") or "RUNNING"
        supabase.table("polar_exercises").upsert({
            "polar_exercise_id": ex_id, "date": f"{run_date}T00:00:00+00:00", "sport": sport,
            "duration_seconds": si(dur_s), "distance_meters": sf(dist_m),
            "avg_heart_rate": si(fields.get("avg_heart_rate")), "max_heart_rate": si(fields.get("max_heart_rate")),
            "avg_power": si(fields.get("avg_power")), "max_power": si(fields.get("max_power")),
            "avg_cadence": si(fields.get("avg_cadence")), "max_cadence": si(fields.get("max_cadence")),
            "ascent": sf(fields.get("ascent")), "descent": sf(fields.get("descent")),
            "calories": si(fields.get("calories")), "training_load": sf(fields.get("training_load")),
            "muscle_load": sf(fields.get("muscle_load")), "notes": fields.get("notes"), "source": "manual",
        }, on_conflict="polar_exercise_id").execute()
        split_rows = []
        for s in (fields.get("splits") or []):
            lap_dur = s.get("duration_seconds") or 0
            split_rows.append({
                "exercise_id": ex_id, "session_date": run_date,
                "lap_number": (s.get("km_number") or 1) - 1, "km_number": s.get("km_number") or 1,
                "duration_seconds": sf(lap_dur), "split_time_seconds": sf(s.get("split_time_seconds")),
                "distance_m": sf(s.get("distance_m") or 1000),
                "pace_min_per_km": sf(lap_dur / 60) if lap_dur else None,
                "pace_display": s.get("pace_display") or seconds_to_pace(lap_dur),
                "hr_avg": si(s.get("hr_avg")), "hr_max": si(s.get("hr_max")),
                "power_avg": si(s.get("power_avg")), "power_max": si(s.get("power_max")),
                "cadence_avg": si(s.get("cadence_avg")), "cadence_max": si(s.get("cadence_max")),
                "ascent_m": sf(s.get("ascent_m", 0)), "descent_m": sf(s.get("descent_m", 0)),
            })
        if split_rows:
            supabase.table("polar_km_splits").upsert(split_rows, on_conflict="exercise_id,lap_number").execute()
        dist_km = dist_m / 1000 if dist_m else 0
        lines   = [f"✏️ *Run saved!*\n", f"{sport_emoji(sport)} {sport.replace('_',' ').title()}  •  {run_date}", f"📏 {dist_km:.2f}km  •  ⏱ {int(dur_s//60)}:{int(dur_s%60):02d}", f"💨 {seconds_to_pace(pace_s)}  ❤️ {fields.get('avg_heart_rate','?')}/{fields.get('max_heart_rate','?')}bpm", f"⚡ {fields.get('avg_power','?')}W  •  👟 {fields.get('avg_cadence','?')}spm", f"⬆️ {fields.get('ascent') or 0:.0f}m  •  🔥 Load {fields.get('training_load','?')}"]
        if split_rows:
            lines.append(f"\n📊 {len(split_rows)} km splits saved")
            lines.append("`KM  │ Pace     │ HR      │ Power │ Cad`")
            for s in split_rows:
                lines.append(f"`{str(s['km_number']).rjust(2)}  │ {(s.get('pace_display') or 'N/A').ljust(8)} │ {str(s.get('hr_avg','?')).ljust(3)}/{str(s.get('hr_max','?')).ljust(3)} │ {str(s.get('power_avg') or '?').rjust(4)}W │ {str(s.get('cadence_avg') or '?').rjust(3)}`")
        return "\n".join(lines)
    except json.JSONDecodeError as e:
        log.error(f"JSON decode error: {e}")
        return "Error parsing run data — check Railway logs."
    except Exception as e:
        log.error(f"Save manual run error: {e}")
        return f"Error saving run: {e}"

def save_wellness_checkin(text: str) -> str:
    try:
        text        = re.sub(r"^(check.?in|wellness|feeling|mood)\s*[:：]\s*", "", text.strip(), flags=re.IGNORECASE)
        weight_kg   = None; fatigue = None; sleep_score = None; mood = None
        m = re.search(r"([\d.]+)\s*kg", text, re.IGNORECASE)
        if m: weight_kg = float(m.group(1))
        m = re.search(r"fatigue\s+(\d+)(?:/10)?", text, re.IGNORECASE)
        if m: fatigue = int(m.group(1))
        m = re.search(r"sleep\s+(\d+)(?:/10)?", text, re.IGNORECASE)
        if m: sleep_score = int(m.group(1))
        m = re.search(r"mood\s+(\d+)(?:/10)?", text, re.IGNORECASE)
        if m: mood = int(m.group(1))
        supabase.table("wellness_checkins").insert({"date": datetime.now().strftime("%Y-%m-%d"), "weight_kg": weight_kg, "fatigue_score": fatigue, "sleep_score": sleep_score, "mood_score": mood, "notes": text[:500]}).execute()
        parts = ["✅ *Check-in saved!*\n"]
        if weight_kg:   parts.append(f"⚖️ {weight_kg}kg")
        if fatigue:     parts.append(f"😓 Fatigue: {fatigue}/10")
        if sleep_score: parts.append(f"😴 Sleep: {sleep_score}/10")
        if mood:        parts.append(f"😊 Mood: {mood}/10")
        return "\n".join(parts)
    except Exception as e:
        log.error(f"Save wellness error: {e}")
        return f"Error saving check-in: {e}"

# ── POLAR SYNC ─────────────────────────────────────────────────────────────

def save_exercise_from_api(ex_data: dict, exercise_id: str, split_rows: list) -> int:
    try:
        sport       = ex_data.get("sport", "")
        hr          = ex_data.get("heart_rate", {}) or {}
        load        = ex_data.get("training_load_pro", {}) or {}
        zones       = ex_data.get("heart_rate_zones", []) or []
        start       = ex_data.get("start_time", "")
        dur_s       = parse_pt_seconds(ex_data.get("duration", ""))
        dist_m      = sf(ex_data.get("distance"))
        cadence_obj = ex_data.get("cadence", {}) or {}
        power_obj   = ex_data.get("power", {}) or {}
        avg_cadence = si(cadence_obj.get("avg") or ex_data.get("avg_cadence"))
        max_cadence = si(cadence_obj.get("max") or ex_data.get("max_cadence"))
        avg_power   = si(power_obj.get("avg")   or ex_data.get("avg_power"))
        max_power   = si(power_obj.get("max")   or ex_data.get("max_power"))
        if avg_cadence is None and split_rows:
            cad_vals = [s["cadence_avg"] for s in split_rows if s.get("cadence_avg")]
            if cad_vals: avg_cadence = si(sum(cad_vals) / len(cad_vals))
        if avg_power is None and split_rows:
            pwr_vals = [s["power_avg"] for s in split_rows if s.get("power_avg")]
            if pwr_vals: avg_power = si(sum(pwr_vals) / len(pwr_vals))
        hr_zones_parsed = [{"zone": z.get("index"), "lower": z.get("lower-limit"), "upper": z.get("upper-limit"), "seconds": parse_pt_seconds(z.get("in-zone", "PT0S"))} for z in zones]
        load_info   = ex_data.get("loadInformation") or {}
        cardio_load = sf(ex_data.get("training_load") or load.get("cardio-load") or load_info.get("cardioLoad"))
        muscle_load = sf(load.get("muscle-load") or load_info.get("muscleLoad"))
        supabase.table("polar_exercises").upsert({
            "polar_exercise_id": exercise_id, "date": start, "sport": sport,
            "duration_seconds": si(dur_s), "distance_meters": dist_m, "calories": si(ex_data.get("calories")),
            "avg_heart_rate": si(hr.get("average")), "max_heart_rate": si(hr.get("maximum")),
            "avg_cadence": avg_cadence, "max_cadence": max_cadence, "avg_power": avg_power, "max_power": max_power,
            "training_load": cardio_load, "muscle_load": muscle_load,
            "ascent": sf(ex_data.get("ascent")), "descent": sf(ex_data.get("descent")),
            "hr_zones": json.dumps(hr_zones_parsed), "raw_json": json.dumps(ex_data), "source": "polar",
        }, on_conflict="polar_exercise_id").execute()
        if split_rows:
            supabase.table("polar_km_splits").upsert(split_rows, on_conflict="exercise_id,lap_number").execute()
        return len(split_rows)
    except Exception as e:
        log.error(f"Save exercise error {exercise_id}: {e}")
        return 0

def sync_new_polar_exercises() -> list:
    try:
        r = requests.get(f"{POLAR_BASE}/exercises", headers=polar_headers())
        if r.status_code == 204 or not r.ok: return []
        exercises = r.json()
        if not isinstance(exercises, list): exercises = exercises.get("exercises", [])
        new_exercises = []
        for ex in exercises:
            ex_id = str(ex.get("id", ""))
            if not ex_id or ex.get("sport", "") not in ALLOWED_SPORTS: continue
            existing = supabase.table("polar_exercises").select("polar_exercise_id").eq("polar_exercise_id", ex_id).limit(1).execute()
            if existing.data: continue
            detail_r = requests.get(f"{POLAR_BASE}/exercises/{ex_id}?zones=true", headers=polar_headers())
            if not detail_r.ok: continue
            ex_data    = detail_r.json()
            dist_m     = sf(ex_data.get("distance"))
            split_rows = fetch_fit_and_parse(ex_id, ex_data.get("start_time", "")[:10], dist_m)
            splits     = save_exercise_from_api(ex_data, ex_id, split_rows)
            new_exercises.append({"id": ex_id, "data": ex_data, "splits": splits})
        return new_exercises
    except Exception as e:
        log.error(f"Exercises sync error: {e}")
        return []

def sync_sleep() -> int:
    try:
        r = requests.get(f"{POLAR_BASE}/users/sleep", headers=polar_headers())
        if r.status_code == 204 or not r.ok: return 0
        data   = r.json()
        nights = data.get("nights", data if isinstance(data, list) else [data])
        count  = 0
        for s in nights:
            date = (s.get("date") or s.get("night", ""))[:10]
            if not date: continue
            light = s.get("light_sleep") or 0
            deep  = s.get("deep_sleep")  or 0
            rem   = s.get("rem_sleep")   or 0
            supabase.table("polar_sleep").upsert({
                "date":                date,
                "total_sleep_seconds": si(light + deep + rem) or None,
                "sleep_score":         sf(s.get("sleep_score")),
                "rem_seconds":         si(rem),
                "light_sleep_seconds": si(light),
                "deep_sleep_seconds":  si(deep),
                "interruptions":       si(s.get("total_interruption_duration")),
                "avg_hrv":             sf(s.get("avg_hrv")),
                "raw_json":            json.dumps(s),
            }, on_conflict="date").execute()
            count += 1
        return count
    except Exception as e:
        log.error(f"Sleep sync error: {e}")
        return 0

def _recharge_status_label(status_int) -> str:
    mapping = {1: "POOR", 2: "LOW", 3: "MODERATE", 4: "GOOD", 5: "EXCELLENT"}
    if status_int is None: return None
    try: return mapping.get(int(status_int), str(status_int))
    except: return str(status_int)

def sync_nightly_recharge() -> int:
    try:
        r = requests.get(f"{POLAR_BASE}/users/nightly-recharge", headers=polar_headers())
        if r.status_code == 204 or not r.ok: return 0
        data   = r.json()
        nights = data.get("recharges", data if isinstance(data, list) else [data])
        count  = 0
        for h in nights:
            date = (h.get("date") or "")[:10]
            if not date: continue
            supabase.table("polar_hrv").upsert({
                "date":            date,
                "hrv_avg":         sf(h.get("heart_rate_variability_avg")),
                "hrv_rmssd":       sf(h.get("beat_to_beat_avg")),
                "ans_charge":      sf(h.get("ans_charge")),
                "sleep_charge":    si(h.get("ans_charge_status")),
                "recharge_status": _recharge_status_label(h.get("nightly_recharge_status")),
                "raw_json":        json.dumps(h),
            }, on_conflict="date").execute()
            count += 1
        return count
    except Exception as e:
        log.error(f"Recharge sync error: {e}")
        return 0

def sync_daily_activity() -> int:
    try:
        r = requests.get(f"{POLAR_BASE}/users/activities", headers=polar_headers())
        if r.status_code == 204 or not r.ok: return 0
        data       = r.json()
        activities = data if isinstance(data, list) else data.get("activities", [data])
        count      = 0
        for a in activities:
            date = (a.get("start_time") or a.get("date") or "")[:10]
            if not date: continue
            supabase.table("polar_daily_activity").upsert({
                "date":                date,
                "steps":               si(a.get("steps")),
                "calories_total":      sf(a.get("calories")),
                "active_calories":     sf(a.get("active_calories") or a.get("activeCalories")),
                "active_time_seconds": si(_parse_pt_to_seconds(a.get("active_duration") or 0)),
                "raw_json":            json.dumps(a),
            }, on_conflict="date").execute()
            count += 1
        return count
    except Exception as e:
        log.error(f"Activity sync error: {e}")
        return 0

def sync_continuous_hr() -> int:
    try:
        count = 0
        for delta in range(7):
            date = (datetime.now(timezone.utc) - timedelta(days=delta)).strftime("%Y-%m-%d")
            r    = requests.get(f"{POLAR_BASE}/users/continuous-heart-rate/{date}", headers=polar_headers())
            if r.status_code == 404 or not r.ok: continue
            data    = r.json()
            samples = data.get("heart_rate_samples", [])
            hr_vals = [s.get("heart_rate") for s in samples if s.get("heart_rate")]
            supabase.table("polar_continuous_hr").upsert({
                "date":     date,
                "avg_hr":   round(sum(hr_vals) / len(hr_vals)) if hr_vals else None,
                "min_hr":   min(hr_vals) if hr_vals else None,
                "max_hr":   max(hr_vals) if hr_vals else None,
                "raw_json": json.dumps(data),
            }, on_conflict="date").execute()
            count += 1
        return count
    except Exception as e:
        log.error(f"Continuous HR sync error: {e}")
        return 0

def sync_cardio_load() -> int:
    try:
        r = requests.get(f"{POLAR_BASE}/users/cardio-load/", headers=polar_headers())
        if r.status_code == 204 or not r.ok: return 0
        data    = r.json()
        entries = data if isinstance(data, list) else data.get("cardio_load", [data])
        count   = 0
        for c in entries:
            date_str = (c.get("date") or "")[:10]
            if not date_str: continue
            levels = c.get("cardio_load_level") or {}
            supabase.table("polar_cardio_load").upsert({
                "date":               date_str,
                "cardio_load":        sf(c.get("cardio_load")),
                "cardio_load_status": c.get("cardio_load_status"),
                "cardio_load_ratio":  sf(c.get("cardio_load_ratio")),
                "strain":             sf(c.get("strain")),
                "tolerance":          sf(c.get("tolerance")),
                "load_very_low":      sf(levels.get("very_low")),
                "load_low":           sf(levels.get("low")),
                "load_medium":        sf(levels.get("medium")),
                "load_high":          sf(levels.get("high")),
                "load_very_high":     sf(levels.get("very_high")),
                "raw_json":           json.dumps(c),
            }, on_conflict="date").execute()
            count += 1
        return count
    except Exception as e:
        log.error(f"Cardio load sync error: {e}")
        return 0

def sync_physical_info() -> bool:
    """Pull latest physical information from Polar (includes Polar Balance weight)."""
    try:
        r = requests.get(f"{POLAR_BASE}/users/{POLAR_USER_ID}/physical-information", headers=polar_headers())
        if not r.ok:
            return False
        d = r.json()
        weight = sf(d.get("weight"))
        if not weight:
            return False
        supabase.table("polar_physical_info").upsert({
            "date":       datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "weight_kg":  weight,
            "height_cm":  sf(d.get("height")),
            "resting_hr": si(d.get("resting-heart-rate") or d.get("resting_heart_rate")),
            "vo2max":     sf(d.get("maximum-oxygen-uptake") or d.get("vo2max")),
            "raw_json":   json.dumps(d),
        }, on_conflict="date").execute()
        return True
    except Exception as e:
        log.error(f"Physical info sync error: {e}")
        return False


def sync_sleepwise() -> int:
    try:
        r = requests.get(f"{POLAR_BASE}/users/sleepwise/alertness", headers=polar_headers())
        if r.status_code == 204 or not r.ok: return 0
        data    = r.json()
        entries = data if isinstance(data, list) else data.get("alertness", [data])
        count   = 0
        for s in entries:
            period_start = s.get("period_start_time") or s.get("sleep_period_start_time") or ""
            date_str     = period_start[:10] if period_start else ""
            if not date_str: continue
            supabase.table("polar_sleepwise").upsert({
                "date":                    date_str,
                "grade":                   sf(s.get("grade")),
                "grade_classification":    s.get("grade_classification"),
                "sleep_inertia":           s.get("sleep_inertia"),
                "sleep_type":              s.get("sleep_type"),
                "period_start_time":       s.get("period_start_time"),
                "period_end_time":         s.get("period_end_time"),
                "sleep_period_start_time": s.get("sleep_period_start_time"),
                "sleep_period_end_time":   s.get("sleep_period_end_time"),
                "raw_json":                json.dumps(s),
            }, on_conflict="date").execute()
            count += 1
        r2 = requests.get(f"{POLAR_BASE}/users/sleepwise/circadian-bedtime", headers=polar_headers())
        if r2.ok:
            cb      = r2.json()
            today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            start_t = cb.get("start") or cb.get("bedtime_start") or cb.get("circadian_start")
            end_t   = cb.get("end")   or cb.get("bedtime_end")   or cb.get("circadian_end")
            if start_t or end_t:
                supabase.table("polar_sleepwise").upsert({"date": today, "circadian_bedtime_start": str(start_t) if start_t else None, "circadian_bedtime_end": str(end_t) if end_t else None}, on_conflict="date").execute()
        return count
    except Exception as e:
        log.error(f"SleepWise sync error: {e}")
        return 0

# ── CONTEXT FOR CLAUDE ─────────────────────────────────────────────────────

def build_training_context(run_limit: int = 10, sleep_days: int = 7) -> str:
    try:
        parts = []
        goals = supabase.table("goals").select("race_name,race_date,distance_km,target_time,priority,notes").eq("active", True).order("race_date").execute()
        if goals.data:
            parts.append("=== GOALS & TARGET RACES ===")
            for g in goals.data:
                try:
                    d        = datetime.strptime(g["race_date"], "%Y-%m-%d").date()
                    days_str = f" ({(d - datetime.now().date()).days} days away)"
                except: days_str = ""
                parts.append(f"  {g.get('race_name')} | {g.get('race_date')}{days_str} | {g.get('distance_km')}km | Target: {g.get('target_time')} | {'A-race' if g.get('priority')==1 else 'B-race'}")

        wellness = supabase.table("wellness_checkins").select("date,weight_kg,fatigue_score,sleep_score,mood_score,notes").order("date", desc=True).limit(7).execute()
        if wellness.data:
            parts.append("\n=== RECENT WELLNESS CHECK-INS ===")
            for w in wellness.data:
                parts.append(f"  {w['date']} | Weight: {w.get('weight_kg','?')}kg | Fatigue: {w.get('fatigue_score','?')}/10 | Sleep: {w.get('sleep_score','?')}/10 | Mood: {w.get('mood_score','?')}/10")

        notes = supabase.table("coaching_notes").select("date,topic,summary").order("date", desc=True).limit(15).execute()
        if notes.data:
            parts.append("\n=== RECENT COACHING NOTES ===")
            for n in notes.data:
                parts.append(f"  {n['date']} | {n.get('topic','?')} | {n.get('summary','')}")

        # ── Two-layer session history ──────────────────────────────────────────
        # Layer 1: last 21 days in full detail (exact recency labels)
        # Layer 2: weekly summaries for the prior 12 weeks (longitudinal pattern)
        now_dt     = datetime.now(timezone.utc)
        today_date = now_dt.date()
        detail_cutoff  = (now_dt - timedelta(days=21)).strftime("%Y-%m-%d")
        summary_cutoff = (now_dt - timedelta(days=21 + 84)).strftime("%Y-%m-%d")  # 12 weeks back

        def recency_label(date_str: str) -> str:
            try:
                d     = datetime.strptime(date_str[:10], "%Y-%m-%d").date()
                delta = (today_date - d).days
                day   = d.strftime("%A")
                if delta == 0: return f"TODAY ({day} {date_str[:10]})"
                if delta == 1: return f"YESTERDAY ({day} {date_str[:10]})"
                return f"{delta} days ago ({day} {date_str[:10]})"
            except Exception:
                return date_str[:10]

        recent_runs = supabase.table("polar_exercises").select(
            "polar_exercise_id,date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,ascent,descent,source"
        ).gte("date", detail_cutoff).order("date", desc=True).execute()

        if recent_runs.data:
            parts.append(f"\n=== SESSIONS — LAST 21 DAYS (most-recent first) ===")
            for r in recent_runs.data:
                dist_km = (r.get("distance_meters") or 0) / 1000
                dur_s   = r.get("duration_seconds") or 0
                pace_s  = dur_s / dist_km if dist_km else 0
                src     = " [manual]" if r.get("source") == "manual" else ""
                parts.append(f"  {recency_label(r['date'])} | {r.get('sport','?')}{src} | {dist_km:.1f}km | {int(dur_s//60)}min | Pace: {seconds_to_pace(pace_s)} | HR: {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')} | Load: {r.get('training_load','?')} | Ascent: {r.get('ascent','?')}m")
        else:
            parts.append("\n=== SESSIONS — LAST 21 DAYS === No sessions.")

        # KM splits for most recent run
        latest = get_latest_run_with_splits()
        if latest:
            splits = supabase.table("polar_km_splits").select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg").eq("exercise_id", latest["polar_exercise_id"]).order("lap_number").execute()
            if splits.data:
                parts.append(f"\n=== KM SPLITS: {recency_label(latest['date'])} ({(latest.get('distance_meters') or 0)/1000:.1f}km) ===")
                for s in splits.data:
                    parts.append(f"  KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | Power {s.get('power_avg','?')}W | Cadence {s.get('cadence_avg','?')}spm")

        # Layer 2: weekly summaries, 12 weeks prior to the detail window
        hist_runs = supabase.table("polar_exercises").select(
            "date,sport,distance_meters,training_load"
        ).gte("date", summary_cutoff).lt("date", detail_cutoff).order("date").execute()

        if hist_runs.data:
            # Group by ISO week
            from collections import defaultdict
            week_buckets: dict = defaultdict(lambda: {"km": 0.0, "load": 0.0, "sessions": 0})
            for r in hist_runs.data:
                try:
                    d   = datetime.strptime(r["date"][:10], "%Y-%m-%d")
                    wk  = d.strftime("%Y-W%V")  # ISO week key
                    wb  = week_buckets[wk]
                    wb["km"]       += (r.get("distance_meters") or 0) / 1000
                    wb["load"]     += r.get("training_load") or 0
                    wb["sessions"] += 1
                except Exception:
                    pass
            if week_buckets:
                parts.append("\n=== TRAINING HISTORY — WEEKLY SUMMARY (oldest→newest) ===")
                for wk in sorted(week_buckets):
                    wb = week_buckets[wk]
                    gap = " ⚠️ LOW" if wb["sessions"] <= 1 else ""
                    parts.append(f"  {wk}: {round(wb['km'],1)}km | load {round(wb['load'],0):.0f} | {wb['sessions']} sessions{gap}")

        # This week vs last week totals
        week_start      = (now_dt - timedelta(days=now_dt.weekday())).strftime("%Y-%m-%d")
        last_week_start = (now_dt - timedelta(days=now_dt.weekday()+7)).strftime("%Y-%m-%d")
        this_week = supabase.table("polar_exercises").select("training_load,distance_meters").gte("date", week_start).execute()
        last_week = supabase.table("polar_exercises").select("training_load,distance_meters").gte("date", last_week_start).lt("date", week_start).execute()
        def sum_load(rows): return sum(r.get("training_load") or 0 for r in rows)
        def sum_km(rows):   return sum((r.get("distance_meters") or 0)/1000 for r in rows)
        parts.append(f"\n=== WEEKLY LOAD ===")
        parts.append(f"  This week: Load {sum_load(this_week.data):.0f} | {sum_km(this_week.data):.1f}km | {len(this_week.data)} sessions")
        parts.append(f"  Last week: Load {sum_load(last_week.data):.0f} | {sum_km(last_week.data):.1f}km | {len(last_week.data)} sessions")

        sleep = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,light_sleep_seconds,avg_hrv,interruptions").order("date", desc=True).limit(sleep_days).execute()
        if sleep.data:
            parts.append(f"\n=== SLEEP (last {len(sleep.data)} nights) ===")
            for s in sleep.data:
                total_s = s.get("total_sleep_seconds") or 0
                parts.append(f"  {s['date']} | {total_s//3600}h{(total_s%3600)//60}m | Score: {s.get('sleep_score','?')} | REM: {(s.get('rem_seconds') or 0)//60}min | Deep: {(s.get('deep_sleep_seconds') or 0)//60}min | HRV: {s.get('avg_hrv','?')}")

        hrv = supabase.table("polar_hrv").select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd").order("date", desc=True).limit(7).execute()
        if hrv.data:
            parts.append(f"\n=== NIGHTLY RECHARGE (last {len(hrv.data)} nights) ===")
            for h in hrv.data:
                parts.append(f"  {h['date']} | Status: {h.get('recharge_status','?')} | ANS: {h.get('ans_charge','?')} | HRV: {h.get('hrv_avg','?')} | RMSSD: {h.get('hrv_rmssd','?')}")

        try:
            chr_data = supabase.table("polar_continuous_hr").select("date,avg_hr,min_hr,max_hr").order("date", desc=True).limit(7).execute()
            if chr_data.data:
                parts.append(f"\n=== CONTINUOUS HEART RATE ===")
                for h in chr_data.data:
                    parts.append(f"  {h['date']} | Avg: {h.get('avg_hr','?')}bpm | Min: {h.get('min_hr','?')} | Max: {h.get('max_hr','?')}")
        except: pass

        try:
            cl_data = supabase.table("polar_cardio_load").select("date,cardio_load,cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(14).execute()
            if cl_data.data:
                parts.append(f"\n=== CARDIO LOAD ===")
                for c in cl_data.data:
                    parts.append(f"  {c['date']} | Status: {c.get('cardio_load_status','?')} | Strain: {c.get('strain','?')} | Tolerance: {c.get('tolerance','?')} | Ratio: {c.get('cardio_load_ratio','?')}")
        except: pass

        try:
            sw_data = supabase.table("polar_sleepwise").select("date,grade,grade_classification,sleep_inertia,circadian_bedtime_start,circadian_bedtime_end").order("date", desc=True).limit(7).execute()
            if sw_data.data:
                parts.append(f"\n=== SLEEPWISE ALERTNESS ===")
                for s in sw_data.data:
                    gc      = (s.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
                    inertia = (s.get("sleep_inertia") or "").replace("SLEEP_INERTIA_", "").replace("_", " ").title()
                    bedtime = f"Bedtime: {s.get('circadian_bedtime_start','?')}–{s.get('circadian_bedtime_end','?')}" if s.get("circadian_bedtime_start") else ""
                    parts.append(f"  {s['date']} | Grade: {s.get('grade','?')} | {gc} | Inertia: {inertia} | {bedtime}")
        except: pass

        activity = supabase.table("polar_daily_activity").select("date,steps,calories_total,active_calories,active_time_seconds").order("date", desc=True).limit(7).execute()
        if activity.data:
            parts.append(f"\n=== DAILY ACTIVITY ===")
            for a in activity.data:
                parts.append(f"  {a['date']} | Steps: {a.get('steps','?')} | Calories: {a.get('calories_total','?')} | Active: {(a.get('active_time_seconds') or 0)//60}min")

        return "\n".join(parts)
    except Exception as e:
        log.error(f"Context error: {e}")
        return "Training data temporarily unavailable."


def _base_system() -> str:
    """Build system prompt string from ATHLETE dict — called at runtime so all values are current."""
    age         = athlete_age()
    rhr         = _live_resting_hr()
    weight      = _live_weight_kg()
    baby_weeks  = _baby_age_weeks()
    constraints = (
        f"Father of three, youngest {baby_weeks} weeks old. Broken sleep is the norm right now. "
        + ATHLETE["constraints_static"]
    )
    return f"""You are {ATHLETE['name']}'s running coach. Treat him as a peer — experienced trail ultrarunner, not a beginner.

DATA INTEGRITY — non-negotiable:
- NEVER say "this morning / today / yesterday" for a session unless the training context labels it TODAY or YESTERDAY.
- NEVER invent details not in the data (wake times, routes, feelings). If it's not in the numbers, say so.
- Every session in context is labelled with exact recency. Use those labels.

ATHLETE:
- {ATHLETE['name']}, {age}yo | {ATHLETE['height_cm']}cm | ~{weight}kg (latest logged)
- VO2max {ATHLETE['vo2max']} | Max HR {ATHLETE['max_hr']}bpm | Resting HR {rhr}bpm (28-day avg)
- Aerobic threshold {ATHLETE['aerobic_thr']}bpm | Anaerobic threshold {ATHLETE['anaerobic_thr']}bpm
- Watch: {ATHLETE['watch']} | Kit: {ATHLETE['kit']}
- Background: {ATHLETE['background']}

CURRENT PHASE: {ATHLETE['phase']}
HORIZON: {ATHLETE['horizon']}

LIFE CONSTRAINTS (respect absolutely):
{constraints}

KNOWN PATTERNS (never misread these):
{ATHLETE['known_patterns']}

SESSION MENU (weekday 5am, ~1hr): {ATHLETE['session_menu']}

KETTLEBELL SESSIONS (1×20kg only — reference these when KB is the call):
- A: Power base — 5×10 swings, 5×5 goblet squat, 3×3 Turkish get-up, 2×10 dead bug
- B: Strength circuit — 4×8 single-leg deadlift, 4×6 clean+press, 3×12 renegade row, 3×15 hollow hold
- C: Conditioning — 20min AMRAP: 15 swings / 10 goblet squats / 5 halos / 10 step-ups

GOWOD: Use as run prep or as a standalone recovery session when load is high or body needs it.
ICE BATH: Use post hard-session for acute recovery, or as a standalone when fatigue is high.

HOW TO COACH:
{ATHLETE['voice']}
Always land the chain: what the data says → why it matters for Luke today → the call.
Concise — this arrives on a phone at 5am. No bullet walls. Short paragraphs.

SIGNALS:
- Cardio load ratio: 0.8–1.1 = MAINTAINING | 1.1–1.3 = PRODUCTIVE | >1.3 = OVERREACHING | <0.8 = DETRAINING
- SleepWise grade: 8+ strong | 5–8 moderate | <5 weak — downgrade or skip
- Resting HR elevated >5bpm for 3 days = accumulated fatigue signal
- HRV declining week-on-week = recovery debt building

DATA: 7 live streams — polar_exercises, polar_sleep, polar_hrv, polar_continuous_hr, polar_cardio_load, polar_sleepwise, polar_daily_activity

WRITE TRIGGERS:
- "save run: ..." → saves to database
- "goal: ..." → saves race goal
- "checkin: weight Xkg, fatigue Y/10, sleep Z/10, mood N/10" → logs wellness

End every substantive response with:
NOTE: <topic> | <one sentence summary>"""

def build_system_prompt(run_limit: int = 10, sleep_days: int = 7) -> str:
    today_date = datetime.now(timezone.utc)
    datestr    = today_date.strftime("%A %-d %B %Y")
    race_info  = days_to_next_race()
    return f"TODAY: {datestr} | RACE HORIZON: {race_info}\n\n{_base_system()}\n\n{build_training_context(run_limit, sleep_days)}"

conversation_history = {}

def get_history(chat_id): return conversation_history.get(chat_id, [])

def add_to_history(chat_id, role, content):
    if chat_id not in conversation_history: conversation_history[chat_id] = []
    conversation_history[chat_id].append({"role": role, "content": content})
    conversation_history[chat_id] = conversation_history[chat_id][-20:]

def extract_and_save_note(reply: str, user_text: str):
    try:
        m = re.search(r"NOTE:\s*(.+?)\s*\|\s*(.+?)$", reply, re.MULTILINE)
        if m:
            save_coaching_note(m.group(1).strip(), m.group(2).strip(), reply)
            return re.sub(r"\nNOTE:.+$", "", reply, flags=re.MULTILINE).strip()
    except Exception as e:
        log.error(f"Extract note error: {e}")
    return reply

def format_full_summary() -> str:
    lines = [f"📊 *Full Summary — {datetime.now(timezone.utc).strftime('%-d %b %Y')}*",
             f"🎯 {days_to_next_race()}\n"]

    # ── Training ──
    try:
        runs = supabase.table("polar_exercises").select(
            "date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load"
        ).order("date", desc=True).limit(1).execute()
        now        = datetime.now(timezone.utc)
        week_start = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        wk         = supabase.table("polar_exercises").select("training_load,distance_meters").gte("date", week_start).execute()
        if runs.data:
            r        = runs.data[0]
            dist_km  = (r.get("distance_meters") or 0) / 1000
            dur_s    = r.get("duration_seconds") or 0
            pace_s   = dur_s / dist_km if dist_km else 0
            wk_km    = sum((x.get("distance_meters") or 0) for x in wk.data) / 1000
            wk_load  = sum((x.get("training_load") or 0) for x in wk.data)
            lines.append(f"🏃 *Training*")
            lines.append(f"  Last: {fmt_date(r['date'])} · {sport_emoji(r.get('sport',''))} {dist_km:.1f}km · 💨 {seconds_to_pace(pace_s)} · ❤️ {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')} · 🔥 {r.get('training_load') or '?'}")
            lines.append(f"  Week: 📏 {wk_km:.1f}km · {len(wk.data)} sessions · Load {wk_load:.0f}\n")
    except: pass

    # ── Sleep ──
    try:
        sleep = supabase.table("polar_sleep").select(
            "date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,light_sleep_seconds,avg_hrv,interruptions"
        ).order("date", desc=True).limit(3).execute()
        if sleep.data:
            lines.append(f"💤 *Sleep*")
            for s in sleep.data:
                total_s = s.get("total_sleep_seconds") or 0
                score   = s.get("sleep_score") or 0
                hrs     = total_s // 3600; mins = (total_s % 3600) // 60
                rem_m   = (s.get("rem_seconds") or 0) // 60
                deep_m  = (s.get("deep_sleep_seconds") or 0) // 60
                sg      = "🟢" if score >= 70 else "🟡" if score >= 50 else "🔴"
                lines.append(f"  {sg} {s['date']} · {hrs}h{mins:02d}m · 📊{score:.0f} · 💤{rem_m}m · 🔵{deep_m}m · 💓{s.get('avg_hrv','?')}")
            lines.append("")
    except: pass

    # ── Recharge / HRV ──
    try:
        hrv = supabase.table("polar_hrv").select(
            "date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd"
        ).order("date", desc=True).limit(3).execute()
        if hrv.data:
            lines.append(f"⚡ *Recharge*")
            for h in hrv.data:
                lines.append(f"  {recharge_emoji(h.get('recharge_status',''))} {h['date']} · {h.get('recharge_status','?')} · ANS {h.get('ans_charge','?')} · 💓 {h.get('hrv_avg','?')} · RMSSD {h.get('hrv_rmssd','?')}")
            lines.append("")
    except: pass

    # ── Resting HR ──
    try:
        chr_data = supabase.table("polar_continuous_hr").select("date,avg_hr,min_hr,max_hr").order("date", desc=True).limit(3).execute()
        if chr_data.data:
            hr_vals  = [r["min_hr"] for r in chr_data.data if r.get("min_hr")]
            avg_rhr  = round(sum(hr_vals) / len(hr_vals), 1) if hr_vals else "?"
            hr_flag  = "🟢" if isinstance(avg_rhr, float) and avg_rhr <= RESTING_HR_BASELINE + 3 else "🟡" if isinstance(avg_rhr, float) and avg_rhr <= RESTING_HR_BASELINE + 6 else "🔴"
            lines.append(f"❤️ *Resting HR* (3d avg)")
            lines.append(f"  {hr_flag} {avg_rhr}bpm (baseline {RESTING_HR_BASELINE}bpm)")
            for h in chr_data.data:
                lines.append(f"  · {h['date']} ❤️ {h.get('avg_hr','?')} ↓{h.get('min_hr','?')} ↑{h.get('max_hr','?')}")
            lines.append("")
    except: pass

    # ── Cardio Load ──
    try:
        cl = supabase.table("polar_cardio_load").select(
            "date,cardio_load,cardio_load_status,cardio_load_ratio,strain,tolerance"
        ).order("date", desc=True).limit(3).execute()
        if cl.data:
            lines.append(f"🔥 *Cardio Load*")
            for c in cl.data:
                status = (c.get("cardio_load_status") or "").replace("_"," ").title()
                ratio  = c.get("cardio_load_ratio")
                r_str  = f" · ×{ratio:.2f}" if ratio else ""
                lines.append(f"  {load_emoji(c.get('cardio_load_status',''))} {c['date']} · {status} · 💪{c.get('strain','?')}/{c.get('tolerance','?')}{r_str}")
            lines.append("")
    except: pass

    # ── SleepWise ──
    try:
        sw = supabase.table("polar_sleepwise").select(
            "date,grade,grade_classification,sleep_inertia,circadian_bedtime_start,circadian_bedtime_end"
        ).order("date", desc=True).limit(3).execute()
        if sw.data:
            lines.append(f"🧠 *SleepWise*")
            for s in sw.data:
                grade   = s.get("grade")
                gc      = (s.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_","").replace("_"," ").title()
                bed_str = f" · 🛏 {s.get('circadian_bedtime_start','')}–{s.get('circadian_bedtime_end','')}" if s.get("circadian_bedtime_start") else ""
                lines.append(f"  {grade_emoji(grade)} {s['date']} · {grade or '?'}/10 · {gc}{bed_str}")
            lines.append("")
    except: pass

    # ── Daily Activity ──
    try:
        act = supabase.table("polar_daily_activity").select(
            "date,steps,calories_total,active_calories,active_time_seconds"
        ).order("date", desc=True).limit(3).execute()
        if act.data:
            lines.append(f"👟 *Activity*")
            for a in act.data:
                active_min = round((a.get("active_time_seconds") or 0) / 60)
                lines.append(f"  · {a['date']} · 👣 {a.get('steps','?')} · 🔥 {a.get('calories_total','?')}kcal · ⏱ {active_min}min")
            lines.append("")
    except: pass

    # ── Wellness ──
    try:
        well = supabase.table("wellness_checkins").select(
            "date,weight_kg,fatigue_score,sleep_score,mood_score"
        ).order("date", desc=True).limit(1).execute()
        if well.data:
            w     = well.data[0]
            parts = []
            if w.get("weight_kg"):    parts.append(f"⚖️ {w['weight_kg']}kg")
            if w.get("fatigue_score"): parts.append(f"😓 {w['fatigue_score']}/10")
            if w.get("sleep_score"):  parts.append(f"😴 {w['sleep_score']}/10")
            if w.get("mood_score"):   parts.append(f"😊 {w['mood_score']}/10")
            lines.append(f"💊 *Wellness* — {w['date']}")
            lines.append(f"  {' · '.join(parts)}\n")
    except: pass

    # ── Readiness ──
    readiness = compute_readiness_score()
    session   = recommend_session(readiness)
    lines.append("─" * 28)
    lines.append(f"{readiness_emoji(readiness['score'])} *Readiness: {readiness['score']}/10* — _{readiness['label']}_")
    lines.append(f"💡 _{session}_")
    return "\n".join(lines)


# ── BRIEFINGS ──────────────────────────────────────────────────────────────

def send_morning_briefing():
    try:
        now_dt      = datetime.now(timezone.utc)
        today_str   = now_dt.strftime("%Y-%m-%d")
        is_monday   = now_dt.weekday() == 0

        readiness   = compute_readiness_score()
        session     = recommend_session(readiness)

        # Sleep — note data currency so Luke knows if last night hasn't synced yet
        sleep_rows  = supabase.table("polar_sleep").select(
            "date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds"
        ).order("date", desc=True).limit(3).execute().data or []
        latest_sleep_date = sleep_rows[0]["date"][:10] if sleep_rows else "?"
        sleep_age   = (now_dt.date() - datetime.strptime(latest_sleep_date, "%Y-%m-%d").date()).days if latest_sleep_date != "?" else 99
        sleep_note  = (
            f"Last night's sleep ({latest_sleep_date})"  if sleep_age == 0 else
            f"Sleep data from {sleep_age} day(s) ago ({latest_sleep_date}) — watch may not have synced yet"
        )
        sleep_lines = []
        for s in sleep_rows:
            h, m = divmod((s.get("total_sleep_seconds") or 0) // 60, 60)
            sleep_lines.append(f"  {s['date'][:10]}: {h}h{m:02d}m score {s.get('sleep_score','?')} | REM {(s.get('rem_seconds') or 0)//60}m · Deep {(s.get('deep_sleep_seconds') or 0)//60}m")
        sleep_context = f"{sleep_note}\n" + "\n".join(sleep_lines)

        hrv_resp    = supabase.table("polar_hrv").select("date,recharge_status,hrv_avg,ans_charge").order("date", desc=True).limit(1).execute()
        hrv         = hrv_resp.data[0] if hrv_resp.data else {}
        hrv_context = (f"Recharge: {hrv.get('recharge_status','?')} | HRV {hrv.get('hrv_avg','?')} | ANS {hrv.get('ans_charge','?')}"
                       if hrv else "No HRV data.")

        sw_resp     = supabase.table("polar_sleepwise").select("date,grade,grade_classification,sleep_inertia").order("date", desc=True).limit(1).execute()
        sw          = sw_resp.data[0] if sw_resp.data else {}
        sw_context  = ""
        if sw:
            gc         = (sw.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_","").replace("_"," ").title()
            sw_context = f"SleepWise {sw.get('grade','?')}/10 ({gc}), inertia {sw.get('sleep_inertia','?')}."

        cl_resp     = supabase.table("polar_cardio_load").select("date,cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(1).execute()
        cl          = cl_resp.data[0] if cl_resp.data else {}
        cl_context  = (f"Load ratio {cl.get('cardio_load_ratio','?')} ({cl.get('cardio_load_status','?').replace('_',' ').title() if cl.get('cardio_load_status') else '?'}) | Strain {cl.get('strain','?')} / Tolerance {cl.get('tolerance','?')}"
                       if cl else "No cardio load data.")

        # Monday: pull last week's summary for the recap section
        monday_recap = ""
        if is_monday:
            prev_start  = (now_dt - timedelta(days=7)).strftime("%Y-%m-%d")
            prev_end    = today_str
            prev_runs   = supabase.table("polar_exercises").select("date,sport,distance_meters,training_load,duration_seconds,avg_heart_rate").gte("date", prev_start).lt("date", prev_end).order("date").execute().data or []
            if prev_runs:
                pw_km   = sum((r.get("distance_meters") or 0) for r in prev_runs) / 1000
                pw_load = sum((r.get("training_load") or 0) for r in prev_runs)
                lines   = [f"  {r['date'][5:]}: {sport_emoji(r.get('sport',''))} {r.get('sport','?')} {round((r.get('distance_meters') or 0)/1000,1)}km HR {r.get('avg_heart_rate','?')}" for r in prev_runs]
                monday_recap = f"\nLAST WEEK: {round(pw_km,1)}km | load {round(pw_load,0):.0f} | {len(prev_runs)} sessions\n" + "\n".join(lines)

        sections = (
            """📅 LAST WEEK — one-line verdict on the week just gone (load, adherence, body signal)
💡 TODAY'S CALL — one clear recommendation for the 5am slot with specific rationale
📍 THIS WEEK — Mon–Fri skeleton plan, one line per day (Sat/Sun = family time, never suggest)
⚑ WATCH — one data point worth tracking this week"""
            if is_monday else
            """💡 TODAY'S CALL — one clear recommendation for the ~1hr slot with specific rationale from the signals
📍 REST OF WEEK — remaining weekdays only, one line per day
⚑ WATCH — one signal worth keeping an eye on"""
        )

        prompt = f"""Morning brief for Luke's 5am slot.

SLEEP: {sleep_context}
HRV / RECHARGE: {hrv_context}
{sw_context}
LOAD: {cl_context}
READINESS: {readiness['score']}/10 ({readiness['label']})
SUGGESTED SESSION: {session}
{monday_recap}

Join the dots — interpret signals, don't list them. Land ONE clear call for the slot.
Emoji-led sections only (no markdown headers like ##). Scannable on a phone at 5am.
{sections}

Brief was already correct not to expect a run — it fires BEFORE the session, never after.
Newborn context: broken sleep is normal, missed sessions are fine."""

        response = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=500,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": prompt}]
        )
        reply     = extract_and_save_note(response.content[0].text, "morning briefing")
        day_label = now_dt.strftime("%A %-d %b")
        header    = f"🌅 *{day_label}*\n\n{readiness_emoji(readiness['score'])} *Readiness {readiness['score']}/10* — _{readiness['label']}_\n\n"
        bot.send_message(YOUR_TELEGRAM_ID, (header + reply)[:4000], parse_mode="Markdown")
        check_and_push_alerts()
    except Exception as e:
        log.error(f"Briefing error: {e}")
        bot.send_message(YOUR_TELEGRAM_ID, f"⚠️ Briefing error: {e}")


def send_post_run_debrief(exercise_id: str):
    if exercise_id in debriefed_today:
        return
    debriefed_today.add(exercise_id)
    time.sleep(240)
    try:
        run_resp = supabase.table("polar_exercises").select("*").eq("polar_exercise_id", exercise_id).limit(1).execute()
        if not run_resp.data: return
        run         = run_resp.data[0]
        splits      = supabase.table("polar_km_splits").select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg").eq("exercise_id", exercise_id).order("lap_number").execute().data or []
        sleep_rows  = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds").order("date", desc=True).limit(3).execute().data or []
        hrv_resp    = supabase.table("polar_hrv").select("date,hrv_avg,ans_charge,recharge_status").order("date", desc=True).limit(1).execute()
        hrv         = hrv_resp.data[0] if hrv_resp.data else {}
        cl_resp     = supabase.table("polar_cardio_load").select("date,cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(1).execute()
        cl          = cl_resp.data[0] if cl_resp.data else {}
        now         = datetime.now(timezone.utc)
        week_start  = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        week_runs   = supabase.table("polar_exercises").select("date,distance_meters,training_load,duration_seconds").gte("date", week_start).order("date").execute().data or []
        goals_resp  = supabase.table("goals").select("race_name,race_date,distance_km,target_time").eq("active", True).execute()
        goals_text  = "\n".join([f"- {g['race_name']} on {g['race_date']}: {g['distance_km']}km target {g['target_time']}" for g in (goals_resp.data or [])]) or "No active goals."
        dist_km     = round((run.get("distance_meters") or 0) / 1000, 2)
        dur_s       = run.get("duration_seconds") or 0
        dur_str     = f"{dur_s // 3600}h {(dur_s % 3600) // 60}m" if dur_s >= 3600 else f"{dur_s // 60}m {dur_s % 60}s"
        pace_s      = (dur_s / dist_km) if dist_km > 0 else 0
        splits_text = ("KM SPLITS:\n" + "\n".join([f"  km {s['km_number']}: {s.get('pace_display','?')} | HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | Power {s.get('power_avg','?')}W | Cad {s.get('cadence_avg','?')}spm" for s in splits[:20]])) if splits else ""
        weekly_km   = sum((r.get("distance_meters") or 0) for r in week_runs) / 1000
        weekly_load = sum((r.get("training_load") or 0) for r in week_runs)
        sleep_text  = "\n".join([f"  - {s['date']}: {round((s.get('total_sleep_seconds') or 0)/3600,1)}h, score {s.get('sleep_score','?')}, deep {(s.get('deep_sleep_seconds') or 0)//60}min" for s in sleep_rows]) or "No recent sleep data."
        hrv_text    = f"Recharge: {hrv.get('recharge_status','?')}, ANS {hrv.get('ans_charge','?')}, HRV {hrv.get('hrv_avg','?')}" if hrv else "No HRV data."
        cl_text     = f"Cardio load: {cl.get('cardio_load_status','?')} | Strain {cl.get('strain','?')} / Tolerance {cl.get('tolerance','?')} | Ratio {cl.get('cardio_load_ratio','?')}" if cl else "No cardio load data."
        prompt = f"""Luke just finished a run. Give him the debrief.

RUN: {dist_km}km in {dur_str} @ {seconds_to_pace(pace_s)} avg | HR {run.get('avg_heart_rate','?')}/{run.get('max_heart_rate','?')}bpm | Power {run.get('avg_power','?')}W | Cadence {run.get('avg_cadence','?')}spm | Load {run.get('training_load','?')} | Ascent {run.get('ascent','?')}m
{splits_text}

RECOVERY: {sleep_text} | {hrv_text} | {cl_text}
WEEK SO FAR: {round(weekly_km,1)}km | load {round(weekly_load,0)} | {len(week_runs)} sessions
GOALS: {goals_text}

3 short paragraphs — join the dots, don't dump numbers:
1. What the run actually was (effort quality, HR vs zones, split story)
2. What it means in context of the week and recovery
3. One specific call for the rest of the day

End with: NOTE: post-run debrief | <10-word summary>"""
        response = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=450,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": prompt}]
        )
        reply    = extract_and_save_note(response.content[0].text, "post-run debrief")
        msg      = f"🏃 *Post-run debrief* — {dist_km}km in {dur_str} @ {seconds_to_pace(pace_s)}\n\n{reply}"
        bot.send_message(YOUR_TELEGRAM_ID, msg[:4000], parse_mode="Markdown")
    except Exception as e:
        log.error(f"Post-run debrief error {exercise_id}: {e}")


def send_evening_debrief():
    """Evening set-up: short today read + clear call on tomorrow's 5am slot."""
    try:
        now           = datetime.now(timezone.utc)
        today_str     = now.strftime("%Y-%m-%d")
        tomorrow_str  = (now + timedelta(days=1)).strftime("%Y-%m-%d")
        week_start    = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")

        activity_resp = supabase.table("polar_daily_activity").select("steps,active_calories,active_time_seconds").eq("date", today_str).execute()
        activity      = activity_resp.data[0] if activity_resp.data else None

        runs_today    = supabase.table("polar_exercises").select("distance_meters,duration_seconds,avg_heart_rate,training_load,sport").gte("date", today_str).lt("date", tomorrow_str).execute().data or []

        week_runs     = supabase.table("polar_exercises").select("date,distance_meters,training_load").gte("date", week_start).execute().data or []
        weekly_km     = sum((r.get("distance_meters") or 0) for r in week_runs) / 1000
        weekly_load   = sum((r.get("training_load") or 0) for r in week_runs)

        cl_resp = supabase.table("polar_cardio_load").select("cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(1).execute()
        cl      = cl_resp.data[0] if cl_resp.data else {}

        sw_resp = supabase.table("polar_sleepwise").select("grade,grade_classification,circadian_bedtime_start,circadian_bedtime_end").order("date", desc=True).limit(1).execute()
        sw      = sw_resp.data[0] if sw_resp.data else {}

        checkin_resp  = supabase.table("wellness_checkins").select("date,fatigue_score,mood_score").order("date", desc=True).limit(1).execute()
        last_checkin  = checkin_resp.data[0] if checkin_resp.data else None
        checkin_today = last_checkin and last_checkin.get("date") == today_str

        # Compute tomorrow's readiness to drive the session call
        readiness    = compute_readiness_score()
        session_call = recommend_session(readiness)

        # ── Format data blocks ──
        today_block = ""
        if activity:
            steps      = activity.get("steps", "?")
            active_min = round((activity.get("active_time_seconds") or 0) / 60)
            today_block = f"Steps {steps} | Active {active_min}min"
        if runs_today:
            run_lines = []
            for r in runs_today:
                d   = round((r.get("distance_meters") or 0) / 1000, 2)
                dur = r.get("duration_seconds") or 0
                run_lines.append(f"{sport_emoji(r.get('sport',''))} {d}km in {dur//60}min | HR {r.get('avg_heart_rate','?')} | load {r.get('training_load','?')}")
            today_block += ("\n" if today_block else "") + "Sessions: " + " / ".join(run_lines)

        load_block = ""
        if cl:
            load_block = (
                f"Load status: {cl.get('cardio_load_status','?')} | ratio {cl.get('cardio_load_ratio','?')} "
                f"| strain {cl.get('strain','?')} / tolerance {cl.get('tolerance','?')}"
            )

        bedtime_block = ""
        if sw:
            gc = (sw.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
            bed_start = sw.get("circadian_bedtime_start", "")
            bed_end   = sw.get("circadian_bedtime_end", "")
            bedtime_block = f"SleepWise: grade {sw.get('grade','?')} ({gc})"
            if bed_start:
                bedtime_block += f" | optimal bedtime {bed_start}–{bed_end}"

        checkin_context = ""
        if last_checkin and not checkin_today:
            checkin_context = f"Last check-in ({last_checkin['date']}): fatigue {last_checkin.get('fatigue_score','?')}/10, mood {last_checkin.get('mood_score','?')}/10"
        checkin_nudge = "" if checkin_today else "\nIf there's an opening, nudge Luke to log a quick check-in (fatigue / sleep / mood out of 10)."

        tomorrow      = now + timedelta(days=1)
        tomorrow_dow  = tomorrow.strftime("%A")
        tomorrow_wday = tomorrow.weekday()  # 0=Mon … 6=Sun
        is_weekend_tomorrow = tomorrow_wday >= 5  # Saturday or Sunday

        if is_weekend_tomorrow:
            tomorrow_section = (
                f"🗓️ TOMORROW ({tomorrow_dow}) — weekend, no 5am slot. "
                "Acknowledge this briefly and pivot: protected family time. "
                "Maybe one line on what a good weekend looks like from a recovery angle "
                "(get outside, keep active naturally, don't force anything)."
            )
        else:
            tomorrow_section = (
                f"🗓️ TOMORROW ({tomorrow_dow}) — commit to the session call above; "
                "tell Luke exactly what tomorrow's 5am slot is and why. No hedging."
            )

        prompt = f"""Evening set-up message for Luke. Fires at 20:00 BST. Short — this is a phone read.
Purpose: quick read of today, then commit to tomorrow's plan so the 5am decision is already made.

TODAY ({now.strftime('%A')}):
{today_block or "No activity data yet — may not have synced."}

LOAD:
{load_block or "No cardio load data."}

WEEK SO FAR: {round(weekly_km,1)}km | load {round(weekly_load,0)} | {len(week_runs)} sessions

READINESS: {readiness['score']}/10 — {readiness['label']}

{"TOMORROW'S SESSION CALL: " + session_call if not is_weekend_tomorrow else "TOMORROW: weekend — no 5am session. Family time."}

SLEEP TONIGHT:
{bedtime_block or "No SleepWise data."}

{checkin_context}

Write 3 emoji-led sections, 1–3 sentences each. Interpret, never list raw numbers.
Peer voice — concise, direct, no fluff.

📊 TODAY — one-sentence read of today's load and recovery picture
{tomorrow_section}
🌙 TONIGHT — one concrete sleep call (bedtime target if available, otherwise a recovery action)
{checkin_nudge}
End with: NOTE: evening set-up | <10-word summary>"""

        response = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=400,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": prompt}]
        )
        reply = extract_and_save_note(response.content[0].text, "evening set-up")
        msg   = f"🌙 *Evening Set-Up — {now.strftime('%-d %b')}*\n\n{reply}"
        bot.send_message(YOUR_TELEGRAM_ID, msg[:4000], parse_mode="Markdown")
    except Exception as e:
        log.error(f"Evening debrief error: {e}")
        bot.send_message(YOUR_TELEGRAM_ID, f"⚠️ Evening debrief error: {e}")

def send_weekly_review():
    """Sunday evening: synthesise the week — sleep trend, HRV direction, load, adherence."""
    try:
        now         = datetime.now(timezone.utc)
        week_start  = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        prev_start  = (now - timedelta(days=now.weekday() + 7)).strftime("%Y-%m-%d")

        sessions    = supabase.table("polar_exercises").select("date,sport,distance_meters,training_load,duration_seconds,avg_heart_rate").gte("date", week_start).order("date").execute().data or []
        prev_sess   = supabase.table("polar_exercises").select("date,sport,distance_meters,training_load").gte("date", prev_start).lt("date", week_start).execute().data or []

        sleep_rows  = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score").gte("date", week_start).order("date").execute().data or []
        hrv_this    = supabase.table("polar_hrv").select("date,hrv_avg,recharge_status").gte("date", week_start).order("date").execute().data or []
        hrv_prev    = supabase.table("polar_hrv").select("date,hrv_avg").gte("date", prev_start).lt("date", week_start).execute().data or []

        goals_resp  = supabase.table("goals").select("race_name,race_date,distance_km,target_time").eq("active", True).execute()
        goals_text  = "\n".join([f"- {g['race_name']} {g['race_date']}: {g['distance_km']}km target {g['target_time']}" for g in (goals_resp.data or [])]) or "No active goals."

        wk_km       = sum((r.get("distance_meters") or 0) for r in sessions) / 1000
        wk_load     = sum((r.get("training_load") or 0) for r in sessions)
        pw_km       = sum((r.get("distance_meters") or 0) for r in prev_sess) / 1000
        pw_load     = sum((r.get("training_load") or 0) for r in prev_sess)

        sleep_summary = " | ".join([f"{s['date'][5:]}: {round((s.get('total_sleep_seconds') or 0)/3600,1)}h score {s.get('sleep_score','?')}" for s in sleep_rows]) or "No sleep data."

        hrv_this_avg = (sum(r["hrv_avg"] for r in hrv_this if r.get("hrv_avg")) / max(len([r for r in hrv_this if r.get("hrv_avg")]), 1)) if hrv_this else None
        hrv_prev_avg = (sum(r["hrv_avg"] for r in hrv_prev if r.get("hrv_avg")) / max(len([r for r in hrv_prev if r.get("hrv_avg")]), 1)) if hrv_prev else None

        session_lines = "\n".join([
            f"  {r['date'][5:]}: {sport_emoji(r.get('sport',''))} {r.get('sport','?')} | {round((r.get('distance_meters') or 0)/1000,1)}km | HR {r.get('avg_heart_rate','?')} | Load {r.get('training_load','?')}"
            for r in sessions
        ]) or "  No sessions this week."

        prompt = f"""Weekly review for Luke. Synthesise the week — don't list data, read it.

THIS WEEK: {round(wk_km,1)}km | load {round(wk_load,0)} | {len(sessions)} sessions
LAST WEEK: {round(pw_km,1)}km | load {round(pw_load,0)} | {len(prev_sess)} sessions

SESSIONS:
{session_lines}

SLEEP (Mon–Sun): {sleep_summary}
HRV: this week avg {round(hrv_this_avg,1) if hrv_this_avg else '?'} vs last week {round(hrv_prev_avg,1) if hrv_prev_avg else '?'}

GOALS: {goals_text}

4 short sections:
📅 WEEK IN ONE LINE — what kind of week was this (load, consistency, quality)?
🔬 BODY READ — what are sleep trend + HRV direction + load ratio actually saying together?
🏆 WIN — one specific thing worth reinforcing (adherence, a session, a metric moving right)
📍 NEXT WEEK — one concrete adjustment or focus based on this week's picture

Non-preachy. Newborn context = missed sessions are fine. Value showing up.
End with: NOTE: weekly review | <10-word summary>"""

        response = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=500,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": prompt}]
        )
        reply = extract_and_save_note(response.content[0].text, "weekly review")
        bot.send_message(YOUR_TELEGRAM_ID, f"📆 *Weekly Review — w/e {now.strftime('%-d %b')}*\n\n{reply}", parse_mode="Markdown")
    except Exception as e:
        log.error(f"Weekly review error: {e}")
        bot.send_message(YOUR_TELEGRAM_ID, f"⚠️ Weekly review error: {e}")


# ── BACKGROUND LOOPS ───────────────────────────────────────────────────────

def polar_sync_loop():
    while True:
        try:
            new = sync_new_polar_exercises()
            for ex in new:
                bot.send_message(YOUR_TELEGRAM_ID, format_new_run_notification(ex["data"], ex["id"], ex["splits"]), parse_mode="Markdown")
                threading.Thread(target=send_post_run_debrief, args=(ex["id"],), daemon=True).start()
            sleep_n     = sync_sleep()
            recharge_n  = sync_nightly_recharge()
            activity_n  = sync_daily_activity()
            hr_n        = sync_continuous_hr()
            load_n      = sync_cardio_load()
            sleepwise_n = sync_sleepwise()
            phys_n      = sync_physical_info()
            if any([sleep_n, recharge_n, activity_n, hr_n, load_n, sleepwise_n, phys_n]):
                log.info(f"Sync: sleep={sleep_n} recharge={recharge_n} activity={activity_n} hr={hr_n} load={load_n} sw={sleepwise_n} phys={phys_n}")
        except Exception as e:
            log.error(f"Sync loop error: {e}")
        time.sleep(300)


def scheduler_loop():
    while True:
        now        = datetime.now(timezone.utc)
        brief_hour = BRIEF_HOUR_UTC      # 04:00 UTC = 05:00 BST (set via env var)
        # AM brief (weekdays), 19:00 UTC = evening set-up (Mon–Sat) / weekly review (Sun), midnight reset
        targets = [
            now.replace(hour=brief_hour, minute=0, second=0, microsecond=0),
            now.replace(hour=19,         minute=0, second=0, microsecond=0),  # evening (20:00 BST)
            now.replace(hour=0,          minute=5, second=0, microsecond=0),
        ]
        targets    = [t + timedelta(days=1) if now >= t else t for t in targets]
        sleep_secs = (min(targets) - now).total_seconds()
        log.info(f"Scheduler: next in {sleep_secs/60:.1f}min")
        time.sleep(sleep_secs)
        fire_time = datetime.now(timezone.utc)
        if fire_time.hour == brief_hour and fire_time.minute < 5:
            if fire_time.weekday() < 5:   # Mon–Fri only
                send_morning_briefing()
            else:
                log.info("Scheduler: skipping AM brief — weekend")
        elif fire_time.hour == 19 and fire_time.minute < 5:
            if fire_time.weekday() == 6:  # Sunday → weekly review
                send_weekly_review()
            elif fire_time.weekday() < 6:  # Mon–Sat → evening set-up
                send_evening_debrief()
        elif fire_time.hour == 0 and fire_time.minute < 10:
            debriefed_today.clear()
            alerts_fired_today.clear()
            log.info("Cleared daily state")

# ── TELEGRAM HANDLERS ──────────────────────────────────────────────────────

@bot.message_handler(func=lambda m: True)
def handle_message(message):
    chat_id   = message.chat.id
    if chat_id not in (YOUR_TELEGRAM_ID, GROUP_CHAT_ID):
        bot.reply_to(message, "Unauthorised.")
        return
    user_text = message.text.strip()
    lower     = user_text.lower()

    if lower in ["/start", "/help"]:
        bot.reply_to(message, (
            "👋 *Hey Luke!*\n\n"
            "📋 *Commands*\n"
            "📊 /summary — all data at a glance\n"
            "🟢 /status — readiness + today's session\n"
            "🔄 /sync — sync Polar data\n"
            "☀️ /briefing — morning briefing now\n"
            "🌙 /evening — evening debrief now\n"
            "🏃 /runs — last 10 runs _(or /runs 30)_\n"
            "📈 /splits — km splits for last run\n"
            "💤 /recovery — sleep & HRV\n"
            "📦 /load — weekly training load\n"
            "🔥 /cardio — cardio load trend\n"
            "🧠 /sleepwise — SleepWise alertness\n"
            "❤️ /hr — continuous HR\n"
            "🎯 /goals — target races\n"
            "🔔 /push — check alerts\n"
            "📆 /weekly — weekly review\n"
            "🗑 /clear — clear conversation\n\n"
            "✏️ *Log data*\n"
            "`save run: <Polar stats>`\n"
            "`goal: Cheltenham Half, 21 Sep 2026, 21.1km, sub 2:00`\n"
            "`checkin: weight 77.5kg, fatigue 6/10, sleep 7/10, mood 8/10`\n\n"
            "💬 _Or just ask me anything_"
        ), parse_mode="Markdown")
        return

    if lower == "/summary":
        try:
            bot.send_chat_action(chat_id, "typing")
            bot.reply_to(message, format_full_summary(), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/status":
        try:
            bot.send_chat_action(chat_id, "typing")
            bot.reply_to(message, format_status_dashboard(), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/push":
        try:
            bot.reply_to(message, "🔍 Checking for alerts...")
            n = check_and_push_alerts()
            if n == 0: bot.send_message(chat_id, "✅ No alerts — all signals within normal range.")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/sync":
        bot.reply_to(message, "🔄 Syncing all Polar data...")
        new         = sync_new_polar_exercises()
        sleep_n     = sync_sleep()
        recharge_n  = sync_nightly_recharge()
        activity_n  = sync_daily_activity()
        hr_n        = sync_continuous_hr()
        load_n      = sync_cardio_load()
        sleepwise_n = sync_sleepwise()
        if new:
            for ex in new:
                bot.send_message(chat_id, format_new_run_notification(ex["data"], ex["id"], ex["splits"]), parse_mode="Markdown")
                threading.Thread(target=send_post_run_debrief, args=(ex["id"],), daemon=True).start()
        else:
            bot.send_message(chat_id, "No new exercises found.")
        parts = []
        if sleep_n:     parts.append(f"😴 {sleep_n} sleep nights")
        if recharge_n:  parts.append(f"⚡ {recharge_n} recharge nights")
        if activity_n:  parts.append(f"👟 {activity_n} activity days")
        if hr_n:        parts.append(f"❤️ {hr_n} HR days")
        if load_n:      parts.append(f"🔥 {load_n} load days")
        if sleepwise_n: parts.append(f"🧠 {sleepwise_n} SleepWise days")
        if parts: bot.send_message(chat_id, "✅ Synced: " + "  •  ".join(parts))
        return

    if lower == "/briefing":
        bot.reply_to(message, "⏳ Generating briefing...")
        threading.Thread(target=send_morning_briefing, daemon=True).start()
        return

    if lower == "/evening":
        bot.reply_to(message, "⏳ Generating evening debrief...")
        threading.Thread(target=send_evening_debrief, daemon=True).start()

    if lower == "/weekly":
        bot.reply_to(message, "⏳ Generating weekly review...")
        threading.Thread(target=send_weekly_review, daemon=True).start()
        return
        return

    if lower == "/splits":
        try:
            ex = get_latest_run_with_splits()
            if not ex: bot.reply_to(message, "No runs with splits found."); return
            splits  = supabase.table("polar_km_splits").select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg").eq("exercise_id", ex["polar_exercise_id"]).order("lap_number").execute()
            header  = f"{fmt_date(ex['date'])} — {(ex.get('distance_meters') or 0)/1000:.1f}km {ex.get('sport','')}"
            bot.reply_to(message, format_splits_table(splits.data, header), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower.startswith("/runs"):
        try:
            parts = user_text.split()
            limit = min(int(parts[1]) if len(parts) > 1 else 10, 100)
            runs  = supabase.table("polar_exercises").select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,source").order("date", desc=True).limit(limit).execute()
            bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/recovery":
        try:
            sleep = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv").order("date", desc=True).limit(7).execute()
            hrv   = supabase.table("polar_hrv").select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd").order("date", desc=True).limit(1).execute()
            bot.reply_to(message, format_recovery_dashboard(sleep.data, hrv.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/load":
        try:
            now             = datetime.now(timezone.utc)
            week_start      = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
            last_week_start = (now - timedelta(days=now.weekday()+7)).strftime("%Y-%m-%d")
            this_week = supabase.table("polar_exercises").select("training_load,distance_meters,date,sport").gte("date", week_start).order("date", desc=True).execute()
            last_week = supabase.table("polar_exercises").select("training_load,distance_meters,date,sport").gte("date", last_week_start).lt("date", week_start).execute()
            def sum_load(rows): return sum(r.get("training_load") or 0 for r in rows)
            def sum_km(rows):   return sum((r.get("distance_meters") or 0)/1000 for r in rows)
            lines = ["📈 *Weekly Training Load*\n", f"*This week:*  {sum_km(this_week.data):.1f}km  •  Load {sum_load(this_week.data):.0f}  •  {len(this_week.data)} sessions"]
            for r in this_week.data:
                dist = (r.get("distance_meters") or 0)/1000
                load = f"  Load {r['training_load']:.0f}" if r.get("training_load") else ""
                lines.append(f"  {sport_emoji(r.get('sport',''))} {fmt_date(r['date'])}  {dist:.1f}km{load}")
            lines.append(f"\n*Last week:*  {sum_km(last_week.data):.1f}km  •  Load {sum_load(last_week.data):.0f}  •  {len(last_week.data)} sessions")
            bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/cardio":
        try:
            cl = supabase.table("polar_cardio_load").select("date,cardio_load,cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(14).execute()
            bot.reply_to(message, format_cardio_load_dashboard(cl.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/sleepwise":
        try:
            sw = supabase.table("polar_sleepwise").select("date,grade,grade_classification,sleep_inertia,circadian_bedtime_start,circadian_bedtime_end").order("date", desc=True).limit(7).execute()
            bot.reply_to(message, format_sleepwise_dashboard(sw.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/hr":
        try:
            hr = supabase.table("polar_continuous_hr").select("date,avg_hr,min_hr,max_hr").order("date", desc=True).limit(7).execute()
            bot.reply_to(message, format_hr_dashboard(hr.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/goals":
        try:
            goals = supabase.table("goals").select("race_name,race_date,distance_km,target_time,priority,notes").eq("active", True).order("race_date").execute()
            bot.reply_to(message, format_goals(goals.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if lower == "/clear":
        conversation_history[chat_id] = []
        bot.reply_to(message, "Conversation cleared.")
        return

    if re.match(r"^(goal|race|target)\s*[:：]", lower):
        result = save_goal(user_text)
        try:
            bot.reply_to(message, result, parse_mode="Markdown")
        except Exception:
            bot.reply_to(message, result)
        return

    if re.match(r"^(save\s+run|log\s+run|manual\s+run|run\s+log)\s*[:：]", lower):
        bot.reply_to(message, save_manual_run(user_text), parse_mode="Markdown")
        return

    if re.match(r"^(check.?in|checkin|wellness)\s*[:：]", lower):
        bot.reply_to(message, save_wellness_checkin(user_text), parse_mode="Markdown")
        return

    run_limit  = detect_history_request(user_text) or 10
    sleep_days = detect_recovery_window(user_text)

    if any(kw in lower for kw in ["show","list","display","give me","last","all my"]) and ("run" in lower or "session" in lower) and run_limit > 10:
        try:
            runs = supabase.table("polar_exercises").select("date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,source").order("date", desc=True).limit(run_limit).execute()
            bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    if any(kw in lower for kw in ["sleep","recovery","recharge","hrv","rest"]) and sleep_days > 7:
        try:
            sleep = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv").order("date", desc=True).limit(sleep_days).execute()
            hrv   = supabase.table("polar_hrv").select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd").order("date", desc=True).limit(1).execute()
            bot.reply_to(message, format_recovery_dashboard(sleep.data, hrv.data), parse_mode="Markdown")
        except Exception as e: bot.reply_to(message, f"Error: {e}")
        return

    try:
        bot.send_chat_action(chat_id, "typing")
        add_to_history(chat_id, "user", user_text)
        response = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=1000,
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

# ── MAIN ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("🏃 Polar Super Coach Bot v8.2 starting...")
    log.info(f"Supabase: {SUPABASE_URL}")
    log.info(f"Polar User: {POLAR_USER_ID}")
    threading.Thread(target=polar_sync_loop, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    bot.infinity_polling(interval=1, timeout=30)
