"""
bot.py - Polar Running Coach Telegram Bot v8.2
Athlete: Luke Worgan | Goal: London Marathon 27 Apr 2026 + Ultra marathons
Watch: Polar Grit X2 | Deployed: Railway.app
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
SUPABASE_URL        = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY        = os.environ["SUPABASE_KEY"]

bot      = telebot.TeleBot(TELEGRAM_TOKEN)
claude   = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

ALLOWED_SPORTS      = {"RUNNING", "TRAIL_RUNNING", "TREADMILL_RUNNING"}
POLAR_BASE          = "https://www.polaraccesslink.com/v3"
RESTING_HR_BASELINE = 47
AEROBIC_THRESHOLD   = 149
ANAEROBIC_THRESHOLD = 178
MAX_HR              = 198
MARATHON_DATE       = datetime(2026, 4, 27).date()

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

def days_to_marathon() -> int:
    return (MARATHON_DATE - datetime.now().date()).days

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
    score = readiness["score"]
    dtm   = days_to_marathon()
    ratio = readiness["raw_data"].get("load_ratio", 1.0)
    if 0 < dtm <= 14:
        if score >= 7: return f"TAPER ({dtm}d to London): 6-8km easy @ 5:30-6:00/km, HR <{AEROBIC_THRESHOLD}bpm. Strides only."
        else:          return f"TAPER ({dtm}d to London): 20-30min very easy jog @ 6:00+/km. Keep legs moving only."
    if 15 <= dtm <= 56:
        if score >= 8:   return f"PEAK ({dtm}d to London): 10km w/ 5km @ marathon pace (4:58/km), HR {AEROBIC_THRESHOLD}-{ANAEROBIC_THRESHOLD}bpm."
        elif score >= 6: return f"PEAK ({dtm}d to London): Steady aerobic 12-16km @ 5:20-5:45/km, HR <{AEROBIC_THRESHOLD}bpm."
        else:            return f"PEAK ({dtm}d to London): Recovery run 8km easy @ 6:00+/km, HR <140bpm."
    if score >= 8:   return f"BUILD ({dtm}d to London): 6x1km @ 4:45/km w/ 90s rest, or 18-22km long run @ 5:20/km."
    elif score >= 6:
        if ratio > 1.1: return f"BUILD ({dtm}d to London): Load building — steady 14-16km @ 5:30/km. No intensity."
        return f"BUILD ({dtm}d to London): 14km @ 5:20-5:40/km, HR <{AEROBIC_THRESHOLD}bpm."
    elif score >= 4: return f"BUILD ({dtm}d to London): Easy 8-10km @ 6:00/km, HR <140bpm."
    else:            return f"REST ({dtm}d to London): Readiness {score}/10 — walk, stretch, roll only."


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
                    alerts.append(f"⬇️ *DETRAINING RISK*\nNo runs in 5+ days. Load ratio: {float(ratio):.2f}\n{days_to_marathon()} days to London — even 20 mins easy maintains fitness.")
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

    dtm           = days_to_marathon()
    milestones    = [50, 30, 21, 14, 7, 3, 1]
    milestone_key = f"marathon_milestone_{dtm}"
    if dtm in milestones and milestone_key not in alerts_fired_today:
        alerts_fired_today.add(milestone_key)
        if dtm == 1:
            msg = "🎯 *TOMORROW IS RACE DAY*\nLondon Marathon is tomorrow. 10 min shakeout max.\nKit laid out. Nutrition ready. Sleep early. You've done the work."
        elif dtm <= 7:
            msg = f"🎯 *{dtm} DAYS TO LONDON*\nFinal taper week. Short and easy from here. Trust the fitness — it's banked."
        elif dtm <= 14:
            msg = f"🎯 *{dtm} DAYS TO LONDON*\nTaper in full effect. Resist adding miles — trust the plan."
        elif dtm == 21:
            msg = "🎯 *3 WEEKS TO LONDON*\nLast big effort window. One more quality long run if readiness allows, then taper. Target: 5:41/km."
        else:
            msg = f"🎯 *{dtm} DAYS TO LONDON*\nSub 4:00 target: 5:41/km. Keep building aerobic base. Threshold work is key."
        alerts.append(msg)

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
    dtm        = days_to_marathon()
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
        "", f"🎯 *London: {dtm}d away*",
        f"💡 _{session}_",
    ]
    return "\n".join(lines)
# ── FIT FILE PARSING ───────────────────────────────────────────────────────

def _build_splits_from_laps(fitfile, exercise_id: str, session_date: str, expected_laps) -> list:
    """Parse km splits from FIT 'lap' messages."""
    split_rows = []
    lap_num    = 0
    for record in fitfile.get_messages("lap"):
        data = {d.name: d.value for d in record}
        if expected_laps is not None and lap_num >= expected_laps:
            continue
        lap_dur         = sf(data.get("total_elapsed_time") or data.get("total_timer_time"))
        dist_m          = sf(data.get("total_distance"))
        avg_speed       = sf(data.get("avg_speed") or data.get("enhanced_avg_speed"))
        pace_s          = (1000 / avg_speed) if (avg_speed and avg_speed > 0) else (lap_dur / (dist_m / 1000) if (lap_dur and dist_m and dist_m > 0) else None)
        cadence_raw     = sf(data.get("avg_running_cadence") or data.get("avg_cadence"))
        cadence_max_raw = sf(data.get("max_running_cadence") or data.get("max_cadence"))
        split_rows.append({
            "exercise_id": exercise_id, "session_date": session_date,
            "lap_number": lap_num, "km_number": lap_num + 1,
            "duration_seconds": lap_dur, "split_time_seconds": sf(data.get("total_elapsed_time")),
            "distance_m": dist_m, "pace_min_per_km": sf(pace_s / 60) if pace_s else None,
            "pace_display": seconds_to_pace(pace_s) if pace_s else "N/A",
            "hr_avg": si(data.get("avg_heart_rate")), "hr_max": si(data.get("max_heart_rate")),
            "power_avg": si(data.get("avg_power")), "power_max": si(data.get("max_power")),
            "cadence_avg": si(cadence_raw * 2) if cadence_raw else None,
            "cadence_max": si(cadence_max_raw * 2) if cadence_max_raw else None,
            "ascent_m": None, "descent_m": None,
        })
        lap_num += 1
    return split_rows


def _build_splits_from_records(fitfile, exercise_id: str, session_date: str) -> list:
    """Aggregate per-second FIT 'record' messages into 1km splits."""
    buckets: dict[int, dict] = {}  # km_index -> accumulated data
    prev_dist = 0.0
    for record in fitfile.get_messages("record"):
        data      = {d.name: d.value for d in record}
        dist_m    = sf(data.get("distance"))
        if dist_m is None:
            continue
        km_idx    = int(dist_m / 1000)   # 0-based bucket
        speed     = sf(data.get("speed") or data.get("enhanced_speed"))
        hr        = si(data.get("heart_rate"))
        power     = si(data.get("power"))
        cad_raw   = sf(data.get("running_cadence") or data.get("cadence"))
        cad       = si(cad_raw * 2) if cad_raw else None
        if km_idx not in buckets:
            buckets[km_idx] = {"speeds": [], "hrs": [], "hr_max": None, "powers": [], "cads": [], "start_dist": prev_dist, "count": 0}
        b = buckets[km_idx]
        b["count"]  += 1
        if speed:  b["speeds"].append(speed)
        if hr:
            b["hrs"].append(hr)
            if b["hr_max"] is None or hr > b["hr_max"]: b["hr_max"] = hr
        if power:  b["powers"].append(power)
        if cad:    b["cads"].append(cad)
        prev_dist = dist_m

    split_rows = []
    for km_idx in sorted(buckets.keys()):
        b         = buckets[km_idx]
        km_number = km_idx + 1
        avg_speed = (sum(b["speeds"]) / len(b["speeds"])) if b["speeds"] else None
        pace_s    = (1000 / avg_speed) if (avg_speed and avg_speed > 0) else None
        lap_dur   = sf(pace_s) if pace_s else None   # approx 1km duration
        split_rows.append({
            "exercise_id": exercise_id, "session_date": session_date,
            "lap_number": km_idx, "km_number": km_number,
            "duration_seconds": lap_dur, "split_time_seconds": None,
            "distance_m": 1000.0, "pace_min_per_km": sf(pace_s / 60) if pace_s else None,
            "pace_display": seconds_to_pace(pace_s) if pace_s else "N/A",
            "hr_avg": si(sum(b["hrs"]) / len(b["hrs"])) if b["hrs"] else None,
            "hr_max": b["hr_max"],
            "power_avg": si(sum(b["powers"]) / len(b["powers"])) if b["powers"] else None,
            "power_max": None,
            "cadence_avg": si(sum(b["cads"]) / len(b["cads"])) if b["cads"] else None,
            "cadence_max": None, "ascent_m": None, "descent_m": None,
        })
    return split_rows


def parse_fit_laps(fit_bytes: bytes, exercise_id: str, session_date: str, total_distance_m: float = None) -> list:
    if not fitparse: return []
    try:
        fitfile       = fitparse.FitFile(io.BytesIO(fit_bytes))
        expected_laps = int((total_distance_m or 0) / 1000) if total_distance_m else None

        # Try lap messages first
        split_rows = _build_splits_from_laps(fitfile, exercise_id, session_date, expected_laps)

        # Fall back to per-second records if laps are missing or sparse
        if expected_laps and len(split_rows) < max(5, expected_laps // 2):
            log.info(f"FIT {exercise_id}: only {len(split_rows)} lap msgs for {expected_laps}km — falling back to record aggregation")
            record_splits = _build_splits_from_records(fitfile, exercise_id, session_date)
            if len(record_splits) > len(split_rows):
                return record_splits

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

def format_recovery_dashboard(sleep_data: list, hrv_data: list, hr_by_date: dict = None) -> str:
    lines = ["💤 *Recovery*\n"]

    # ── Recharge ──
    if hrv_data:
        h       = hrv_data[0]
        ans     = h.get('ans_charge')  or '—'
        hrv_avg = h.get('hrv_avg')     or '—'
        rmssd   = h.get('hrv_rmssd')   or '—'
        br      = h.get('breathing_rate')
        br_str  = f" · 🫁{br:.1f}" if br else ""
        status  = recharge_emoji(h.get('recharge_status', ''))
        lines.append(f"🔋 *Recharge* · {fmt_date(h['date'])}  {status}")
        lines.append(f"ANS {ans} · HRV {hrv_avg}ms{br_str}\n")

    # ── Sleep ──
    if sleep_data:
        scores = [s.get("sleep_score") or 0 for s in sleep_data]
        avg_score = sum(scores) / len(scores) if scores else 0
        # Compute HR average across nights that have data
        hr_vals = [v for v in [(hr_by_date or {}).get(s["date"][:10]) for s in sleep_data] if v]
        hr_avg  = sum(hr_vals) / len(hr_vals) if hr_vals else None
        lines.append(f"😴 *Sleep — 7 nights*  _(avg {avg_score:.0f}/100)_\n")
        for s in sleep_data:
            total_s = s.get("total_sleep_seconds") or 0
            score   = s.get("sleep_score") or 0
            hrs     = total_s // 3600
            mins    = (total_s % 3600) // 60
            rem_s   = s.get("rem_seconds") or 0
            deep_s  = s.get("deep_sleep_seconds") or 0
            def fmt_dur(secs):
                h, m = divmod(secs // 60, 60)
                return f"{h}h{m:02d}" if h else f"{m}m"
            rem_str  = fmt_dur(rem_s)
            deep_str = fmt_dur(deep_s)
            sg     = "🟢" if score >= 70 else "🟡" if score >= 50 else "🔴"
            min_hr = (hr_by_date or {}).get(s["date"][:10])
            if min_hr and hr_avg:
                diff   = min_hr - hr_avg
                trend  = " ↑" if diff > 2 else " ↓" if diff < -2 else ""
            else:
                trend  = ""
            hr_str = f"  ❤️{min_hr}{trend}" if min_hr else ""
            lines.append(f"{sg} *{fmt_date(s['date'])}*  {hrs}h{mins:02d}  {score:.0f}{hr_str}\n   💚{rem_str}  💜{deep_str}")
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
    if not goals: return "No goals set. Add one with:\n`goal: London Marathon, 27 Apr 2026, 42.2km, sub 4:00`"
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
        if len(parts) < 2: return "Format: `goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`"
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
            existing = supabase.table("polar_exercises").select("polar_exercise_id,distance_meters").eq("polar_exercise_id", ex_id).limit(1).execute()
            if existing.data:
                # Re-fetch splits if significantly incomplete (e.g. synced mid-run)
                ex_dist_m   = sf((existing.data[0] or {}).get("distance_meters")) or 0
                expected    = int(ex_dist_m / 1000)
                if expected >= 5:
                    split_count = supabase.table("polar_km_splits").select("id", count="exact").eq("exercise_id", ex_id).execute()
                    actual      = split_count.count or 0
                    if actual < max(5, expected // 2):
                        log.info(f"Exercise {ex_id}: only {actual}/{expected} splits — re-fetching FIT")
                        supabase.table("polar_km_splits").delete().eq("exercise_id", ex_id).execute()
                        detail_r2 = requests.get(f"{POLAR_BASE}/exercises/{ex_id}?zones=true", headers=polar_headers())
                        if detail_r2.ok:
                            ex_data2   = detail_r2.json()
                            split_rows = fetch_fit_and_parse(ex_id, ex_data2.get("start_time", "")[:10], ex_dist_m)
                            if split_rows:
                                supabase.table("polar_km_splits").upsert(split_rows, on_conflict="exercise_id,lap_number").execute()
                continue
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
                "breathing_rate":  sf(h.get("breathing_rate_avg") or h.get("mean_nightly_breathing_rate") or h.get("breathing_rate")),
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
            if isinstance(cb, list):
                cb = cb[0] if cb else {}
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

        notes = supabase.table("coaching_notes").select("date,topic,summary").order("date", desc=True).limit(5).execute()
        if notes.data:
            parts.append("\n=== RECENT COACHING NOTES ===")
            for n in notes.data:
                parts.append(f"  {n['date']} | {n.get('topic','?')} | {n.get('summary','')}")

        runs = supabase.table("polar_exercises").select("polar_exercise_id,date,sport,distance_meters,duration_seconds,avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,ascent,descent,source").order("date", desc=True).limit(run_limit).execute()
        if runs.data:
            parts.append(f"\n=== RECENT RUNS (last {len(runs.data)}) ===")
            for r in runs.data:
                dist_km = (r.get("distance_meters") or 0) / 1000
                dur_s   = r.get("duration_seconds") or 0
                pace_s  = dur_s / dist_km if dist_km else 0
                src     = " [manual]" if r.get("source") == "manual" else ""
                parts.append(f"  {r['date'][:10]} | {r.get('sport','?')}{src} | {dist_km:.1f}km | {int(dur_s//60)}min | Pace: {seconds_to_pace(pace_s)} | HR: {r.get('avg_heart_rate','?')}/{r.get('max_heart_rate','?')} | Power: {r.get('avg_power','?')}W | Cadence: {r.get('avg_cadence','?')}spm | Load: {r.get('training_load','?')} | Ascent: {r.get('ascent','?')}m")
            latest = get_latest_run_with_splits()
            if latest:
                splits = supabase.table("polar_km_splits").select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg").eq("exercise_id", latest["polar_exercise_id"]).order("lap_number").execute()
                if splits.data:
                    parts.append(f"\n=== KM SPLITS: {latest['date'][:10]} ({(latest.get('distance_meters') or 0)/1000:.1f}km) ===")
                    for s in splits.data:
                        parts.append(f"  KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | Power {s.get('power_avg','?')}W | Cadence {s.get('cadence_avg','?')}spm")

        now             = datetime.now(timezone.utc)
        week_start      = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        last_week_start = (now - timedelta(days=now.weekday()+7)).strftime("%Y-%m-%d")
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


BASE_SYSTEM = """You are an elite running coach and sports scientist for Luke Worgan.

ATHLETE PROFILE:
- DOB: 1989-03-03 (age 37) | Height: 167cm | Weight: 78kg
- VO2max: 55 | Max HR: 198bpm | Resting HR: 47bpm
- Aerobic threshold: 149bpm | Anaerobic threshold: 178bpm | FTP: 272W
- Watch: Polar Grit X2

PRIMARY GOAL: London Marathon, 27 April 2026 — sub 4:00 (5:41/km)
SECONDARY GOAL: Ultra marathons (ongoing)

DATA ACCESS — 8 live streams: polar_exercises, polar_sleep, polar_hrv, polar_continuous_hr, polar_cardio_load, polar_sleepwise, polar_daily_activity, wellness_checkins

CARDIO LOAD: ratio 0.8-1.1 = MAINTAINING | 1.1-1.3 = PRODUCTIVE | >1.3 = OVERREACHING | <0.8 = DETRAINING
SLEEPWISE: grade 8+ = strong | 5-8 = moderate | <5 = weak — easy day only
RESTING HR: elevation >5bpm for 3 days = systemic fatigue signal
CADENCE TARGET: 170-180spm for marathon efficiency

COACHING RULES:
- Always reference Luke's actual numbers, never generic advice
- Flag overreaching immediately and specifically
- Connect every recommendation to London Marathon timeline ({days_to_marathon} days away)
- Be direct — Luke wants honesty, not encouragement
- Use min/km for pace, bpm for HR, watts for power

WRITE TRIGGERS:
- "save run: ..." → saves to database
- "goal: ..." → saves race goal
- "checkin: weight 77.5kg, fatigue 6/10, sleep 7/10, mood 8/10" → logs wellness

After every substantive response end with:
NOTE: <topic> | <one sentence summary>"""

def build_system_prompt(run_limit: int = 10, sleep_days: int = 7) -> str:
    system = BASE_SYSTEM.replace("{days_to_marathon}", str(days_to_marathon()))
    return f"{system}\n\n{build_training_context(run_limit, sleep_days)}"

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
             f"🎯 *London: {days_to_marathon()}d away* — sub 4:00 @ 5:41/km\n"]

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
                lines.append(f"  {sg} {s['date']} · {hrs}h{mins:02d}m · 📊{score:.0f} · 💤{rem_m}m · 🔵{deep_m}m · 💓{s.get('avg_hrv') or '—'}")
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
                lines.append(f"  {recharge_emoji(h.get('recharge_status',''))} {h['date']} · {h.get('recharge_status','?')} · ANS {h.get('ans_charge') or '—'} · 💓 {h.get('hrv_avg') or '—'} · RMSSD {h.get('hrv_rmssd') or '—'}")
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
                strain  = c.get('strain')
                tol     = c.get('tolerance')
                s_str   = f"{float(strain):.1f}" if strain is not None else '—'
                t_str   = f"{float(tol):.1f}"    if tol     is not None else '—'
                lines.append(f"  {load_emoji(c.get('cardio_load_status',''))} {c['date']} · {status} · 💪{s_str}/{t_str}{r_str}")
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
            today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            lines.append(f"👟 *Activity*")
            for a in act.data:
                active_min = round((a.get("active_time_seconds") or 0) / 60)
                partial    = " _(partial sync — data still building)_" if a["date"] == today_str else ""
                lines.append(f"  · {a['date']} · 👣 {a.get('steps','?')} · 🔥 {a.get('calories_total','?')}kcal · ⏱ {active_min}min{partial}")
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
        sleep = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv").order("date", desc=True).limit(7).execute()
        hrv   = supabase.table("polar_hrv").select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd").order("date", desc=True).limit(1).execute()
        bot.send_message(YOUR_TELEGRAM_ID, format_recovery_dashboard(sleep.data, hrv.data), parse_mode="Markdown")

        readiness = compute_readiness_score()
        session   = recommend_session(readiness)

        # Check for a run this morning (any exercise logged today)
        today_str   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        runs_today  = supabase.table("polar_exercises").select("polar_exercise_id,distance_meters,duration_seconds,avg_heart_rate,training_load,sport").gte("date", today_str).execute().data or []
        ran_today   = bool(runs_today)
        run_context = ""
        if ran_today:
            r = runs_today[0]
            dist_km  = (r.get("distance_meters") or 0) / 1000
            dur_min  = (r.get("duration_seconds") or 0) // 60
            run_context = f" Today's run: {dist_km:.1f}km in {dur_min}min, avg HR {r.get('avg_heart_rate','?')}bpm, load {r.get('training_load','?')}."
        else:
            run_context = " No run detected this morning — rest or cross-training day."

        sw = supabase.table("polar_sleepwise").select("date,grade,grade_classification,sleep_inertia").order("date", desc=True).limit(1).execute()
        sw_context = ""
        if sw.data:
            s  = sw.data[0]
            gc = (s.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
            sw_context = f" SleepWise grade: {s.get('grade','?')} ({gc}), inertia: {s.get('sleep_inertia','?')}."

        cl = supabase.table("polar_cardio_load").select("date,cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(1).execute()
        load_context = ""
        if cl.data:
            c = cl.data[0]
            load_context = f" Cardio load: {c.get('cardio_load_status','?')} | Strain {c.get('strain','?')} / Tolerance {c.get('tolerance','?')} | Ratio {c.get('cardio_load_ratio','?')}."

        if ran_today:
            briefing_type = "Post-run AM briefing"
            sections = """🏃 RUN SNAPSHOT — briefly validate or challenge the readiness score based on today's run data (2-3 sentences)
🧘 RECOVERY TODAY — specific recovery actions: stretches, foam rolling, nutrition. Be concrete.
📅 WEEK AHEAD — day-by-day plan for remaining sessions this week. One line per day.
⚑ FLAG — one watch point from recent data."""
        else:
            briefing_type = "Morning briefing (rest day)"
            sections = """🧘 TODAY'S FOCUS — what to do on a rest day given current load and readiness (recovery, mobility, cross-training). Be specific.
📅 WEEK AHEAD — day-by-day plan for remaining sessions this week. One line per day.
⚑ FLAG — one watch point from recent data."""

        response = claude.messages.create(
            model="claude-sonnet-4-6", max_tokens=600,
            system=build_system_prompt(),
            messages=[{"role": "user", "content": f"""{briefing_type}. London Marathon is {days_to_marathon()} days away.{run_context}{sw_context}{load_context} Algorithmic readiness: {readiness['score']}/10 ({readiness['label']}). Recommended session: {session}.

Structure your reply with clear emoji-led sections so it's easy to scan on mobile:

{sections}

Keep each section tight. Max 4 short sections total."""}]
        )
        reply = extract_and_save_note(response.content[0].text, "morning briefing")
        title = "🌅 *Post-Run AM Briefing" if ran_today else "🌅 *AM Briefing"
        bot.send_message(YOUR_TELEGRAM_ID, f"{title} — {datetime.now().strftime('%-d %b')}*\n\n{readiness_emoji(readiness['score'])} *Readiness: {readiness['score']}/10* — _{readiness['label']}_\n\n{reply}", parse_mode="Markdown")
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
        prompt = f"""Elite running coach. Luke just finished a run. 3 short paragraphs (max 280 tokens).

ATHLETE: Luke Worgan, 37yo, 167cm, 78kg, VO2max 55, max HR 198, aerobic threshold 149bpm, anaerobic threshold 178bpm
LONDON MARATHON: {days_to_marathon()} days away — target sub 4:00 (5:41/km)
GOALS:\n{goals_text}

TODAY'S RUN:
- Distance: {dist_km}km | Duration: {dur_str} | Avg pace: {seconds_to_pace(pace_s)}
- Avg HR: {run.get('avg_heart_rate','?')}bpm | Max HR: {run.get('max_heart_rate','?')}bpm
- Avg power: {run.get('avg_power','?')}W | Cadence: {run.get('avg_cadence','?')}spm
- Training load: {run.get('training_load','?')} | Ascent: {run.get('ascent','?')}m
{splits_text}

RECOVERY: {sleep_text}\n{hrv_text}\n{cl_text}
WEEK SO FAR: {round(weekly_km,1)}km | load {round(weekly_load,0)} across {len(week_runs)} sessions

Para 1: Quality of run — effort, HR vs zones, pacing from splits.
Para 2: One strength, one thing to work on.
Para 3: Rest of today — nutrition, recovery, movement given cardio load.

End with: NOTE: post-run debrief | <10-word summary>"""
        response = claude.messages.create(model="claude-sonnet-4-6", max_tokens=400, messages=[{"role": "user", "content": prompt}])
        reply    = extract_and_save_note(response.content[0].text, "post-run debrief")
        msg      = f"🏃 *Post-run debrief* — {dist_km}km in {dur_str} @ {seconds_to_pace(pace_s)}\n\n{reply}"
        bot.send_message(YOUR_TELEGRAM_ID, msg[:4000], parse_mode="Markdown")
    except Exception as e:
        log.error(f"Post-run debrief error {exercise_id}: {e}")


def send_evening_debrief():
    try:
        today_str     = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        now           = datetime.now(timezone.utc)
        week_start    = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        activity_resp = supabase.table("polar_daily_activity").select("date,steps,active_calories,active_time_seconds").eq("date", today_str).execute()
        activity      = activity_resp.data[0] if activity_resp.data else None
        runs_today    = supabase.table("polar_exercises").select("polar_exercise_id,distance_meters,duration_seconds,avg_heart_rate,training_load,sport").gte("date", today_str).lt("date", (now + timedelta(days=1)).strftime("%Y-%m-%d")).execute().data or []
        week_runs     = supabase.table("polar_exercises").select("date,distance_meters,training_load,duration_seconds").gte("date", week_start).execute().data or []
        weekly_km     = sum((r.get("distance_meters") or 0) for r in week_runs) / 1000
        weekly_load   = sum((r.get("training_load") or 0) for r in week_runs)
        cl_resp       = supabase.table("polar_cardio_load").select("date,cardio_load_status,cardio_load_ratio,strain,tolerance").order("date", desc=True).limit(1).execute()
        cl            = cl_resp.data[0] if cl_resp.data else {}
        sw_resp       = supabase.table("polar_sleepwise").select("date,grade,grade_classification,circadian_bedtime_start,circadian_bedtime_end").order("date", desc=True).limit(1).execute()
        sw            = sw_resp.data[0] if sw_resp.data else {}
        goals_resp    = supabase.table("goals").select("race_name,race_date,distance_km,target_time").eq("active", True).execute()
        goals_text    = "\n".join([f"- {g['race_name']} on {g['race_date']}: target {g['target_time']}" for g in (goals_resp.data or [])]) or "No active goals."
        checkin_resp  = supabase.table("wellness_checkins").select("date,fatigue_score,sleep_score,mood_score,notes").order("date", desc=True).limit(1).execute()
        last_checkin  = checkin_resp.data[0] if checkin_resp.data else None
        checkin_today = last_checkin and last_checkin.get("date") == today_str
        cl_text = f"Cardio load: {cl.get('cardio_load_status','?')} | Strain {cl.get('strain','?')} / Tolerance {cl.get('tolerance','?')} | Ratio {cl.get('cardio_load_ratio','?')}" if cl else ""
        sw_text = ""
        if sw:
            gc      = (sw.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
            bed_str = f"Optimal bedtime: {sw.get('circadian_bedtime_start','?')}–{sw.get('circadian_bedtime_end','?')}" if sw.get("circadian_bedtime_start") else ""
            sw_text = f"SleepWise grade: {sw.get('grade','?')} ({gc}) | {bed_str}"
        if activity:
            steps      = activity.get("steps", "?")
            active_min = round((activity.get("active_time_seconds") or 0) / 60)
            run_summary = "No runs today."
            if runs_today:
                run_lines = []
                for r in runs_today:
                    d   = round((r.get("distance_meters") or 0) / 1000, 2)
                    dur = r.get("duration_seconds") or 0
                    run_lines.append(f"  - {sport_emoji(r.get('sport',''))} {d}km in {dur//60}m | avg HR {r.get('avg_heart_rate','?')} | load {r.get('training_load','?')}")
                run_summary = "Runs today:\n" + "\n".join(run_lines)
            checkin_nudge   = "" if checkin_today else "\nNudge Luke to log a wellness check-in: fatigue, sleep quality, mood out of 10."
            checkin_context = f"\nLast check-in ({last_checkin['date']}): fatigue {last_checkin.get('fatigue_score','?')}/10, mood {last_checkin.get('mood_score','?')}/10" if last_checkin else ""
            prompt = f"""Elite running coach. Evening data summary — short and scannable. Use emojis to lead each section so it's easy to read on mobile.

ATHLETE: Luke Worgan | LONDON MARATHON: {days_to_marathon()} days away — target sub 4:00 (5:41/km)
GOALS:\n{goals_text}

TODAY: Steps {steps} | Active {active_min}min
{run_summary}
{cl_text}
{sw_text}
WEEK: {round(weekly_km,1)}km | load {round(weekly_load,0)} | {len(week_runs)} sessions
{checkin_context}

Structure with these emoji-led sections, 1-3 sentences each:
📊 TODAY'S NUMBERS — one-line snapshot of all key data points (steps, run if any, load ratio, HRV/recharge)
⚖️ BALANCE CHECK — training stress vs recovery today, one green flag, one watch point
🌙 TONIGHT — specific sleep timing from SleepWise window, wind-down tip
{checkin_nudge}
End with: NOTE: evening debrief | <10-word summary>"""
        else:
            prompt = f"""Elite running coach. Evening — data still syncing. Keep it short and emoji-led.

WEEK: {round(weekly_km,1)}km | {len(week_runs)} runs | LONDON: {days_to_marathon()} days
{cl_text}\n{sw_text}

📊 DATA STATUS — note data is still syncing, share what's available
🌙 TONIGHT — one specific sleep/recovery tip for marathon prep
{f"Nudge Luke to log check-in: fatigue, sleep, mood out of 10." if not checkin_today else ""}
End with: NOTE: evening debrief | data pending"""
        response = claude.messages.create(model="claude-sonnet-4-6", max_tokens=400, messages=[{"role": "user", "content": prompt}])
        reply    = extract_and_save_note(response.content[0].text, "evening debrief")
        icon     = "📊" if activity else "⏳"
        msg      = f"{icon} *Evening Debrief — {datetime.now(timezone.utc).strftime('%-d %b')}*\n\n{reply}"
        bot.send_message(YOUR_TELEGRAM_ID, msg[:4000], parse_mode="Markdown")
    except Exception as e:
        log.error(f"Evening debrief error: {e}")
        bot.send_message(YOUR_TELEGRAM_ID, f"⚠️ Evening debrief error: {e}")

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
            if any([sleep_n, recharge_n, activity_n, hr_n, load_n, sleepwise_n]):
                log.info(f"Sync: sleep={sleep_n} recharge={recharge_n} activity={activity_n} hr={hr_n} load={load_n} sw={sleepwise_n}")
        except Exception as e:
            log.error(f"Sync loop error: {e}")
        time.sleep(300)


def scheduler_loop():
    while True:
        now     = datetime.now(timezone.utc)
        targets = [now.replace(hour=6, minute=15, second=0, microsecond=0), now.replace(hour=20, minute=30, second=0, microsecond=0), now.replace(hour=0, minute=5, second=0, microsecond=0)]
        targets = [t + timedelta(days=1) if now >= t else t for t in targets]
        sleep_secs = (min(targets) - now).total_seconds()
        log.info(f"Scheduler: next in {sleep_secs/60:.1f}min")
        time.sleep(sleep_secs)
        fire_time = datetime.now(timezone.utc)
        if fire_time.hour == 6 and fire_time.minute >= 15 and fire_time.minute < 20:
            send_morning_briefing()
        elif fire_time.hour == 20 and fire_time.minute >= 30 and fire_time.minute < 35:
            send_evening_debrief()
        elif fire_time.hour == 0 and fire_time.minute < 10:
            debriefed_today.clear()
            alerts_fired_today.clear()
            log.info("Cleared daily state")

# ── TELEGRAM HANDLERS ──────────────────────────────────────────────────────

@bot.message_handler(func=lambda m: True)
def handle_message(message):
    chat_id   = message.chat.id
    if chat_id != YOUR_TELEGRAM_ID:
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
            "🔁 /resync — re-fetch FIT splits for last run\n"
            "💤 /recovery — sleep & HRV\n"
            "📦 /load — weekly training load\n"
            "🔥 /cardio — cardio load trend\n"
            "🧠 /sleepwise — SleepWise alertness\n"
            "❤️ /hr — continuous HR\n"
            "🎯 /goals — target races\n"
            "🔔 /push — check alerts\n"
            "🗑 /clear — clear conversation\n\n"
            "✏️ *Log data*\n"
            "`save run: <Polar stats>`\n"
            "`goal: London Marathon, 27 Apr 2026, 42.2km, sub 4:00`\n"
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

    if lower.startswith("/resync"):
        try:
            parts   = user_text.split()
            # Default to latest run; optionally accept exercise_id as arg
            if len(parts) > 1:
                ex_id = parts[1]
                ex_row = supabase.table("polar_exercises").select("polar_exercise_id,date,distance_meters,sport").eq("polar_exercise_id", ex_id).limit(1).execute()
                ex = ex_row.data[0] if ex_row.data else None
            else:
                runs = supabase.table("polar_exercises").select("polar_exercise_id,date,distance_meters,sport").order("date", desc=True).limit(1).execute()
                ex = runs.data[0] if runs.data else None
            if not ex:
                bot.reply_to(message, "No exercise found to resync."); return
            ex_id   = ex["polar_exercise_id"]
            dist_m  = sf(ex.get("distance_meters"))
            bot.reply_to(message, f"🔄 Resyncing splits for {fmt_date(ex['date'])} ({(dist_m or 0)/1000:.1f}km)...")
            # Delete existing splits
            supabase.table("polar_km_splits").delete().eq("exercise_id", ex_id).execute()
            # Re-fetch FIT and parse
            split_rows = fetch_fit_and_parse(ex_id, ex["date"][:10], dist_m)
            if split_rows:
                supabase.table("polar_km_splits").upsert(split_rows, on_conflict="exercise_id,lap_number").execute()
                splits = supabase.table("polar_km_splits").select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg").eq("exercise_id", ex_id).order("lap_number").execute()
                header = f"{fmt_date(ex['date'])} — {(dist_m or 0)/1000:.1f}km {ex.get('sport','')}"
                bot.send_message(chat_id, f"✅ {len(split_rows)} splits saved\n\n" + format_splits_table(splits.data, header), parse_mode="Markdown")
            else:
                bot.send_message(chat_id, "⚠️ No splits found in FIT file — watch may not be set to auto-lap every km.")
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
            sleep  = supabase.table("polar_sleep").select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv").order("date", desc=True).limit(7).execute()
            hrv    = supabase.table("polar_hrv").select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd,breathing_rate").order("date", desc=True).limit(1).execute()
            hr_raw = supabase.table("polar_continuous_hr").select("date,min_hr").order("date", desc=True).limit(7).execute()
            hr_by_date = {r["date"]: r["min_hr"] for r in (hr_raw.data or [])}
            bot.reply_to(message, format_recovery_dashboard(sleep.data, hrv.data, hr_by_date), parse_mode="Markdown")
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
