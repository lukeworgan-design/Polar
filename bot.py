“””
bot.py - Polar Running Coach Telegram Bot v8.0
Athlete: Luke Worgan | Goal: London Marathon 27 Apr 2026 + Ultra marathons
Watch: Polar Grit X2 | Deployed: Railway.app

v8.0 changes (merged v7.3 + Super Coach V3 intelligence layer):

- compute_readiness_score() — algorithmic 1-10 score from SleepWise grade (30%),
  cardio load ratio (30%), resting HR trend (20%), HRV week-on-week (20%), wellness
- recommend_session() — taper-aware session logic (56-day peak, 14-day taper)
- check_and_push_alerts() — proactive unsolicited alerts:
  • Cardio load ratio > 1.3 (overreaching)
  • Resting HR elevated 3+ consecutive days vs 47bpm baseline
  • HRV declining week-on-week
  • SleepWise grade < 5
  • London countdown milestones: 50, 30, 21, 14, 7, 3, 1 days
  • Detraining risk (no runs + load ratio < 0.7)
- /status command — live readiness dashboard with traffic-light emojis
- /push command — manually trigger alert check
- All v7.3 functionality preserved unchanged

v7.3 changes:

- sync_cardio_load() hits real /v3/users/cardio-load/ endpoint
- sync_sleepwise() — /v3/users/sleepwise/alertness + circadian-bedtime
- Both added to polar_sync_loop() and build_training_context()
- /cardio command updated to show strain/tolerance/ratio
  “””

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

# ── Logging ────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format=”%(asctime)s [%(levelname)s] %(message)s”)
log = logging.getLogger(**name**)

# ── Environment variables ──────────────────────────────────────────────────

TELEGRAM_TOKEN      = os.environ[“TELEGRAM_TOKEN”]
ANTHROPIC_API_KEY   = os.environ[“ANTHROPIC_API_KEY”]
POLAR_ACCESS_TOKEN  = os.environ[“POLAR_ACCESS_TOKEN”]
POLAR_CLIENT_ID     = os.environ[“POLAR_CLIENT_ID”]
POLAR_CLIENT_SECRET = os.environ[“POLAR_CLIENT_SECRET”]
POLAR_USER_ID       = os.environ[“POLAR_USER_ID”]
YOUR_TELEGRAM_ID    = int(os.environ[“YOUR_TELEGRAM_ID”])
SUPABASE_URL        = os.environ[“SUPABASE_URL”].rstrip(”/”)
SUPABASE_KEY        = os.environ[“SUPABASE_KEY”]

# ── Clients ────────────────────────────────────────────────────────────────

bot      = telebot.TeleBot(TELEGRAM_TOKEN)
claude   = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

ALLOWED_SPORTS = {“RUNNING”, “TRAIL_RUNNING”, “TREADMILL_RUNNING”}
POLAR_BASE     = “https://www.polaraccesslink.com/v3”

# Athlete constants

RESTING_HR_BASELINE = 47
AEROBIC_THRESHOLD   = 149
ANAEROBIC_THRESHOLD = 178
MAX_HR              = 198
MARATHON_DATE       = datetime(2026, 4, 27).date()

# ── Debrief state ──────────────────────────────────────────────────────────

debriefed_today: set = set()

# Track which alert milestones have already fired today

alerts_fired_today: set = set()

# ══════════════════════════════════════════════════════════════════════════

# HELPERS

# ══════════════════════════════════════════════════════════════════════════

def polar_headers():
return {“Authorization”: f”Bearer {POLAR_ACCESS_TOKEN}”, “Accept”: “application/json”}

def parse_pt_seconds(pt: str) -> float:
if not pt:
return 0.0
m = re.match(r”PT([\d.]+)S$”, pt)
if m:
return float(m.group(1))
hours = re.search(r”(\d+)H”, pt)
mins  = re.search(r”(\d+)M”, pt)
secs  = re.search(r”([\d.]+)S”, pt)
total = 0.0
if hours: total += float(hours.group(1)) * 3600
if mins:  total += float(mins.group(1)) * 60
if secs:  total += float(secs.group(1))
return total

def _parse_pt_to_seconds(pt) -> int:
if pt is None:
return 0
if isinstance(pt, (int, float)):
return int(pt)
pt = str(pt).strip()
if not pt.startswith(“PT”):
try:
return int(float(pt))
except:
return 0
h = re.search(r”(\d+)H”, pt)
m = re.search(r”(\d+)M”, pt)
s = re.search(r”([\d.]+)S”, pt)
total = 0
if h: total += int(h.group(1)) * 3600
if m: total += int(m.group(1)) * 60
if s: total += int(float(s.group(1)))
return total

def seconds_to_pace(seconds: float) -> str:
if not seconds or seconds <= 0:
return “N/A”
return f”{int(seconds // 60)}:{int(seconds % 60):02d}/km”

def sf(v):
try: return float(v) if v not in (None, “”, “N/A”) else None
except: return None

def si(v):
try: return int(float(v)) if v not in (None, “”, “N/A”) else None
except: return None

def days_to_marathon() -> int:
return (MARATHON_DATE - datetime.now().date()).days

def recharge_emoji(status: str) -> str:
if not status: return “⚪”
s = status.upper()
if “EXCELLENT” in s: return “🟢”
if “GOOD” in s:      return “🟢”
if “MODERATE” in s:  return “🟡”
if “LOW” in s:       return “🔴”
if “POOR” in s:      return “🔴”
return “⚪”

def load_emoji(status: str) -> str:
if not status: return “⚪”
s = status.upper()
if “PRODUCTIVE” in s:   return “🟢”
if “MAINTAINING” in s:  return “🟡”
if “OVERREACHING” in s: return “🔴”
if “DETRAINING” in s:   return “⬇️”
if “RECOVERY” in s:     return “🔵”
return “⚪”

def grade_emoji(grade) -> str:
if grade is None: return “⚪”
g = float(grade) if grade else 0
if g >= 8:  return “🟢”
if g >= 6:  return “🟡”
if g >= 4:  return “🟠”
return “🔴”

def readiness_emoji(score: float) -> str:
if score >= 8:  return “🟢”
if score >= 6:  return “🟡”
if score >= 4:  return “🟠”
return “🔴”

def sport_emoji(sport: str) -> str:
if not sport: return “🏃”
if “TRAIL” in sport:     return “🏔️”
if “TREADMILL” in sport: return “⚙️”
return “🏃”

def fmt_date(date_str: str) -> str:
try:
return datetime.fromisoformat(date_str[:10]).strftime(”%-d %b”)
except:
return date_str[:10]

def get_latest_run_with_splits():
try:
runs = supabase.table(“polar_exercises”)  
.select(“polar_exercise_id,date,distance_meters,sport”)  
.order(“date”, desc=True).limit(30).execute()
for run in runs.data:
check = supabase.table(“polar_km_splits”)  
.select(“id”)  
.eq(“exercise_id”, run[“polar_exercise_id”])  
.limit(1).execute()
if check.data:
return run
except Exception as e:
log.error(f”get_latest_run_with_splits error: {e}”)
return None

def detect_history_request(text: str):
text = text.lower()
m = re.search(r”last\s+(\d+)\s+runs?”, text)
if m: return min(int(m.group(1)), 200)
m = re.search(r”last\s+(\d+)\s+months?”, text)
if m: return min(int(m.group(1)) * 30, 365)
if “last month” in text:  return 30
if “last 3 months” in text or “last three months” in text: return 90
if “last 6 months” in text or “last six months” in text:   return 180
if “all” in text and (“run” in text or “history” in text): return 200
return None

def detect_recovery_window(text: str) -> int:
text = text.lower()
m = re.search(r”last\s+(\d+)\s+(?:days?|nights?)”, text)
if m: return min(int(m.group(1)), 90)
if “last month” in text:  return 30
if “last 2 weeks” in text or “last two weeks” in text: return 14
if “last week” in text:   return 7
return 7

# ══════════════════════════════════════════════════════════════════════════

# INTELLIGENCE ENGINE — NEW IN V8.0

# ══════════════════════════════════════════════════════════════════════════

def compute_readiness_score() -> dict:
“””
Algorithmic readiness score 1-10.
Weights: SleepWise grade 30%, cardio load ratio 30%,
resting HR trend 20%, HRV week-on-week 20%.
Returns dict with score, components, and label.
“””
scores   = {}
raw_data = {}

```
# 1. SleepWise grade (30%)
try:
    sw = supabase.table("polar_sleepwise")\
        .select("date,grade,grade_classification")\
        .order("date", desc=True).limit(1).execute()
    if sw.data and sw.data[0].get("grade") is not None:
        grade           = float(sw.data[0]["grade"])
        raw_data["sw_grade"] = grade
        scores["sleepwise"] = min(grade / 10.0, 1.0)  # grade is already 1-10
    else:
        scores["sleepwise"] = 0.6  # neutral if no data
except:
    scores["sleepwise"] = 0.6

# 2. Cardio load ratio (30%)
try:
    cl = supabase.table("polar_cardio_load")\
        .select("date,cardio_load_ratio,cardio_load_status")\
        .order("date", desc=True).limit(1).execute()
    if cl.data and cl.data[0].get("cardio_load_ratio") is not None:
        ratio = float(cl.data[0]["cardio_load_ratio"])
        raw_data["load_ratio"] = ratio
        raw_data["load_status"] = cl.data[0].get("cardio_load_status", "")
        # Optimal ratio ~0.9-1.1 scores highest
        if ratio < 0.6:    cl_score = 0.5   # detraining
        elif ratio < 0.8:  cl_score = 0.7
        elif ratio <= 1.1: cl_score = 1.0   # sweet spot
        elif ratio <= 1.3: cl_score = 0.6   # building but ok
        else:              cl_score = 0.2   # overreaching
        scores["cardio_load"] = cl_score
    else:
        scores["cardio_load"] = 0.6
except:
    scores["cardio_load"] = 0.6

# 3. Resting HR trend (20%) — compare last 3 days vs baseline 47bpm
try:
    chr_data = supabase.table("polar_continuous_hr")\
        .select("date,min_hr")\
        .order("date", desc=True).limit(3).execute()
    if chr_data.data:
        hr_vals = [r["min_hr"] for r in chr_data.data if r.get("min_hr")]
        if hr_vals:
            avg_resting     = sum(hr_vals) / len(hr_vals)
            raw_data["avg_resting_hr"] = round(avg_resting, 1)
            elevation       = avg_resting - RESTING_HR_BASELINE
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

# 4. HRV trend (20%) — this week avg vs last week avg
try:
    hrv_data = supabase.table("polar_hrv")\
        .select("date,hrv_avg")\
        .order("date", desc=True).limit(14).execute()
    if hrv_data.data and len(hrv_data.data) >= 4:
        this_week_hrv = [r["hrv_avg"] for r in hrv_data.data[:7]  if r.get("hrv_avg")]
        last_week_hrv = [r["hrv_avg"] for r in hrv_data.data[7:14] if r.get("hrv_avg")]
        if this_week_hrv and last_week_hrv:
            this_avg       = sum(this_week_hrv) / len(this_week_hrv)
            last_avg       = sum(last_week_hrv) / len(last_week_hrv)
            raw_data["hrv_this_week"] = round(this_avg, 1)
            raw_data["hrv_last_week"] = round(last_avg, 1)
            pct_change = (this_avg - last_avg) / last_avg if last_avg else 0
            if pct_change >= 0.05:    hrv_score = 1.0   # improving
            elif pct_change >= -0.05: hrv_score = 0.8   # stable
            elif pct_change >= -0.10: hrv_score = 0.55  # declining
            else:                     hrv_score = 0.3   # significant drop
            scores["hrv"] = hrv_score
        else:
            scores["hrv"] = 0.6
    else:
        scores["hrv"] = 0.6
except:
    scores["hrv"] = 0.6

# Wellness check-in modifier (bonus/penalty up to ±0.5)
try:
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    well = supabase.table("wellness_checkins")\
        .select("date,fatigue_score,sleep_score,mood_score")\
        .order("date", desc=True).limit(1).execute()
    if well.data and well.data[0].get("date") == today_str:
        w         = well.data[0]
        fatigue   = w.get("fatigue_score") or 5
        sleep_sc  = w.get("sleep_score")   or 5
        mood      = w.get("mood_score")    or 5
        # High fatigue (7-10) = bad; low fatigue (1-3) = good
        well_mod  = (10 - fatigue + sleep_sc + mood) / 30.0 - 0.5  # range -0.17 to +0.17
        raw_data["wellness_mod"] = round(well_mod, 2)
    else:
        well_mod = 0
except:
    well_mod = 0

# Weighted total
weighted = (
    scores.get("sleepwise",    0.6) * 0.30 +
    scores.get("cardio_load",  0.6) * 0.30 +
    scores.get("resting_hr",   0.6) * 0.20 +
    scores.get("hrv",          0.6) * 0.20
)
raw_score = weighted + well_mod
final     = max(1.0, min(10.0, round(raw_score * 10, 1)))

if final >= 8:   label = "Excellent — go hard"
elif final >= 6: label = "Good — train as planned"
elif final >= 5: label = "Moderate — reduce intensity"
elif final >= 3: label = "Poor — easy only"
else:            label = "Very poor — rest day"

return {
    "score":      final,
    "label":      label,
    "components": scores,
    "raw_data":   raw_data,
}
```

def recommend_session(readiness: dict) -> str:
“””
Taper-aware session recommendation based on readiness score
and days to London Marathon.
“””
score  = readiness[“score”]
dtm    = days_to_marathon()
ratio  = readiness[“raw_data”].get(“load_ratio”, 1.0)

```
# Taper phase: inside 14 days
if 0 < dtm <= 14:
    if score >= 7:
        return f"TAPER ({dtm}d to London): 6-8km easy @ 5:30-6:00/km, HR <{AEROBIC_THRESHOLD}bpm. Strides only. Trust the taper."
    else:
        return f"TAPER ({dtm}d to London): 20-30min very easy jog @ 6:00+/km. Keep legs moving only."

# Peak phase: 15-56 days out
if 15 <= dtm <= 56:
    if score >= 8:
        return f"PEAK PHASE ({dtm}d to London): Threshold or long run. E.g. 10km w/ 5km @ marathon pace (4:58/km), HR {AEROBIC_THRESHOLD}-{ANAEROBIC_THRESHOLD}bpm."
    elif score >= 6:
        return f"PEAK PHASE ({dtm}d to London): Steady aerobic. 12-16km @ 5:20-5:45/km, HR <{AEROBIC_THRESHOLD}bpm."
    else:
        return f"PEAK PHASE ({dtm}d to London): Recovery run only. 8km easy @ 6:00+/km, HR <140bpm. Don't dig deeper."

# Build phase: 57+ days out
if score >= 8:
    return f"BUILD ({dtm}d to London): Quality session available. E.g. 6x1km @ 4:45/km w/ 90s rest, or 18-22km long run @ 5:20/km."
elif score >= 6:
    if ratio > 1.1:
        return f"BUILD ({dtm}d to London): Load is building — steady 14-16km @ 5:30/km. No intensity today."
    return f"BUILD ({dtm}d to London): Moderate aerobic. 14km @ 5:20-5:40/km, HR <{AEROBIC_THRESHOLD}bpm."
elif score >= 4:
    return f"BUILD ({dtm}d to London): Easy recovery. 8-10km @ 6:00/km, HR <140bpm. No ego today."
else:
    return f"REST DAY ({dtm}d to London): Readiness {score}/10. Active recovery only — walk, stretch, roll."
```

def check_and_push_alerts():
“””
Proactive unsolicited alerts. Fires to Telegram when:
- Cardio load ratio > 1.3 (overreaching)
- Resting HR elevated 3+ consecutive days
- HRV declining week-on-week > 10%
- SleepWise grade < 5
- London countdown milestones: 50, 30, 21, 14, 7, 3, 1 days
- Detraining risk (no runs 5+ days + load ratio < 0.7)
“””
global alerts_fired_today
alerts = []

```
# 1. Cardio load overreaching
try:
    cl = supabase.table("polar_cardio_load")\
        .select("date,cardio_load_ratio,cardio_load_status,strain,tolerance")\
        .order("date", desc=True).limit(1).execute()
    if cl.data:
        ratio  = cl.data[0].get("cardio_load_ratio")
        status = cl.data[0].get("cardio_load_status", "")
        if ratio and float(ratio) > 1.3 and "overreaching_alert" not in alerts_fired_today:
            alerts_fired_today.add("overreaching_alert")
            alerts.append(
                f"🔴 *OVERREACHING ALERT*\n"
                f"Cardio load ratio: {ratio:.2f} (threshold: 1.30)\n"
                f"Strain {cl.data[0].get('strain','?')} vs Tolerance {cl.data[0].get('tolerance','?')}\n"
                f"Mandatory easy day or rest. No quality sessions until ratio drops below 1.1."
            )
        if ratio and float(ratio) < 0.7 and "detraining_alert" not in alerts_fired_today:
            # Check no runs in 5+ days
            five_days_ago = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%d")
            recent = supabase.table("polar_exercises")\
                .select("date").gte("date", five_days_ago).limit(1).execute()
            if not recent.data:
                alerts_fired_today.add("detraining_alert")
                alerts.append(
                    f"⬇️ *DETRAINING RISK*\n"
                    f"No runs in 5+ days. Load ratio: {ratio:.2f}\n"
                    f"{days_to_marathon()} days to London — even 20 mins easy today maintains fitness."
                )
except Exception as e:
    log.error(f"Alert check cardio load: {e}")

# 2. Resting HR elevated 3+ consecutive days
try:
    if "elevated_hr_alert" not in alerts_fired_today:
        chr_data = supabase.table("polar_continuous_hr")\
            .select("date,min_hr")\
            .order("date", desc=True).limit(3).execute()
        if chr_data.data and len(chr_data.data) >= 3:
            elevated = [r for r in chr_data.data if r.get("min_hr") and
                        float(r["min_hr"]) > RESTING_HR_BASELINE + 5]
            if len(elevated) >= 3:
                alerts_fired_today.add("elevated_hr_alert")
                avg_hr = round(sum(float(r["min_hr"]) for r in elevated) / len(elevated), 1)
                alerts.append(
                    f"❤️ *ELEVATED RESTING HR — 3 DAYS*\n"
                    f"Avg resting HR last 3 nights: {avg_hr}bpm (baseline: {RESTING_HR_BASELINE}bpm)\n"
                    f"Systemic fatigue or illness signal. Prioritise sleep and reduce load."
                )
except Exception as e:
    log.error(f"Alert check HR: {e}")

# 3. HRV declining week-on-week > 10%
try:
    if "hrv_decline_alert" not in alerts_fired_today:
        hrv_data = supabase.table("polar_hrv")\
            .select("date,hrv_avg")\
            .order("date", desc=True).limit(14).execute()
        if hrv_data.data and len(hrv_data.data) >= 8:
            this_w = [r["hrv_avg"] for r in hrv_data.data[:7]  if r.get("hrv_avg")]
            last_w = [r["hrv_avg"] for r in hrv_data.data[7:14] if r.get("hrv_avg")]
            if this_w and last_w:
                this_avg = sum(this_w) / len(this_w)
                last_avg = sum(last_w) / len(last_w)
                pct      = (this_avg - last_avg) / last_avg if last_avg else 0
                if pct < -0.10:
                    alerts_fired_today.add("hrv_decline_alert")
                    alerts.append(
                        f"📉 *HRV DECLINING*\n"
                        f"This week avg: {this_avg:.1f} vs last week: {last_avg:.1f} "
                        f"({pct*100:.1f}%)\n"
                        f"Recovery debt building. Reduce intensity and increase sleep."
                    )
except Exception as e:
    log.error(f"Alert check HRV: {e}")

# 4. SleepWise grade < 5
try:
    if "sleepwise_poor_alert" not in alerts_fired_today:
        sw = supabase.table("polar_sleepwise")\
            .select("date,grade,grade_classification")\
            .order("date", desc=True).limit(1).execute()
        if sw.data and sw.data[0].get("grade") is not None:
            grade     = float(sw.data[0]["grade"])
            sw_date   = sw.data[0].get("date", "")
            today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            if grade < 5 and sw_date == today_str:
                alerts_fired_today.add("sleepwise_poor_alert")
                gc = (sw.data[0].get("grade_classification") or "")\
                    .replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
                alerts.append(
                    f"🧠 *POOR SLEEPWISE GRADE*\n"
                    f"Today's alertness grade: {grade}/10 ({gc})\n"
                    f"Cognitive and physical performance compromised. "
                    f"Downgrade today's session — easy run or rest."
                )
except Exception as e:
    log.error(f"Alert check SleepWise: {e}")

# 5. London Marathon countdown milestones
dtm       = days_to_marathon()
milestones = [50, 30, 21, 14, 7, 3, 1]
milestone_key = f"marathon_milestone_{dtm}"
if dtm in milestones and milestone_key not in alerts_fired_today:
    alerts_fired_today.add(milestone_key)
    if dtm == 1:
        msg = (
            f"🎯 *TOMORROW IS RACE DAY*\n"
            f"London Marathon is tomorrow. Do nothing today except a 10 min shakeout if you feel like it.\n"
            f"Kit laid out. Nutrition ready. Sleep early. You've done the work."
        )
    elif dtm <= 7:
        msg = (
            f"🎯 *{dtm} DAYS TO LONDON*\n"
            f"Final taper week. Runs are short and easy from here. "
            f"Trust the fitness you've built — it's banked."
        )
    elif dtm <= 14:
        msg = (
            f"🎯 *{dtm} DAYS TO LONDON*\n"
            f"Taper is in full effect. Volume dropping, sharpness coming. "
            f"Resist the urge to add extra miles — trust the plan."
        )
    elif dtm == 21:
        msg = (
            f"🎯 *3 WEEKS TO LONDON*\n"
            f"Last big effort window. One more quality long run this week if readiness allows, "
            f"then taper begins. Target pace: 4:58/km."
        )
    else:
        msg = (
            f"🎯 *{dtm} DAYS TO LONDON*\n"
            f"Sub 3:30 target: 4:58/km pace. Keep building aerobic base. "
            f"Threshold work is key in this window."
        )
    alerts.append(msg)

# Send all alerts
for alert in alerts:
    try:
        bot.send_message(YOUR_TELEGRAM_ID, alert, parse_mode="Markdown")
        time.sleep(1)
    except Exception as e:
        log.error(f"Alert send error: {e}")

return len(alerts)
```

def format_status_dashboard() -> str:
“”“Full readiness dashboard with traffic-light emojis.”””
readiness = compute_readiness_score()
session   = recommend_session(readiness)
score     = readiness[“score”]
rd        = readiness[“raw_data”]
comp      = readiness[“components”]
dtm       = days_to_marathon()

```
# SleepWise row
sw_grade   = rd.get("sw_grade", "?")
sw_emoji   = grade_emoji(sw_grade) if sw_grade != "?" else "⚪"
sw_score   = round(comp.get("sleepwise", 0.6) * 10, 1)

# Load row
ratio      = rd.get("load_ratio", "?")
status_str = (rd.get("load_status") or "").replace("_", " ").title()
cl_emoji   = load_emoji(rd.get("load_status", ""))
cl_score   = round(comp.get("cardio_load", 0.6) * 10, 1)

# HR row
avg_rhr   = rd.get("avg_resting_hr", "?")
hr_emoji  = "🟢" if comp.get("resting_hr", 0.6) >= 0.8 else \
            "🟡" if comp.get("resting_hr", 0.6) >= 0.6 else "🔴"
hr_score  = round(comp.get("resting_hr", 0.6) * 10, 1)

# HRV row
hrv_this  = rd.get("hrv_this_week", "?")
hrv_last  = rd.get("hrv_last_week", "?")
hrv_emoji = "🟢" if comp.get("hrv", 0.6) >= 0.8 else \
            "🟡" if comp.get("hrv", 0.6) >= 0.6 else "🔴"
hrv_score = round(comp.get("hrv", 0.6) * 10, 1)

lines = [
    f"{readiness_emoji(score)} *Readiness Score: {score}/10*",
    f"_{readiness['label']}_",
    f"",
    f"*Component Breakdown:*",
    f"{sw_emoji} SleepWise grade: {sw_grade}/10  →  {sw_score}/10  _(30% weight)_",
    f"{cl_emoji} Cardio load ratio: {ratio}  →  {cl_score}/10  _(30% weight)_",
    f"   _{status_str}_",
    f"{hr_emoji} Resting HR (3d avg): {avg_rhr}bpm  →  {hr_score}/10  _(20% weight)_",
    f"{hrv_emoji} HRV trend: {hrv_this} vs {hrv_last} last week  →  {hrv_score}/10  _(20% weight)_",
    f"",
    f"🎯 *London Marathon: {dtm} days away*",
    f"",
    f"💡 *Today's Session:*",
    f"_{session}_",
]
return "\n".join(lines)
```

# ══════════════════════════════════════════════════════════════════════════

# FIT FILE PARSING

# ══════════════════════════════════════════════════════════════════════════

def parse_fit_laps(fit_bytes: bytes, exercise_id: str, session_date: str,
total_distance_m: float = None) -> list:
if not fitparse:
log.error(“fitparse not installed”)
return []
try:
fitfile       = fitparse.FitFile(io.BytesIO(fit_bytes))
split_rows    = []
lap_num       = 0
expected_laps = int((total_distance_m or 0) / 1000) if total_distance_m else None

```
    for record in fitfile.get_messages("lap"):
        data = {d.name: d.value for d in record}
        if expected_laps is not None and lap_num >= expected_laps:
            log.info(f"Skipping lap {lap_num}: beyond expected {expected_laps} laps")
            continue

        lap_dur   = sf(data.get("total_elapsed_time") or data.get("total_timer_time"))
        dist_m    = sf(data.get("total_distance"))
        pace_s    = None
        avg_speed = sf(data.get("avg_speed") or data.get("enhanced_avg_speed"))
        if avg_speed and avg_speed > 0:
            pace_s = 1000 / avg_speed
        elif lap_dur and dist_m and dist_m > 0:
            pace_s = lap_dur / (dist_m / 1000)

        hr_avg          = si(data.get("avg_heart_rate"))
        hr_max          = si(data.get("max_heart_rate"))
        power_avg       = si(data.get("avg_power"))
        power_max       = si(data.get("max_power"))
        cadence_raw     = sf(data.get("avg_running_cadence") or data.get("avg_cadence"))
        cadence_max_raw = sf(data.get("max_running_cadence") or data.get("max_cadence"))
        cadence_avg     = si(cadence_raw * 2)     if cadence_raw     else None
        cadence_max     = si(cadence_max_raw * 2) if cadence_max_raw else None

        split_rows.append({
            "exercise_id":        exercise_id,
            "session_date":       session_date,
            "lap_number":         lap_num,
            "km_number":          lap_num + 1,
            "duration_seconds":   lap_dur,
            "split_time_seconds": sf(data.get("total_elapsed_time")),
            "distance_m":         dist_m,
            "pace_min_per_km":    sf(pace_s / 60) if pace_s else None,
            "pace_display":       seconds_to_pace(pace_s) if pace_s else "N/A",
            "hr_avg":             hr_avg,
            "hr_max":             hr_max,
            "power_avg":          power_avg,
            "power_max":          power_max,
            "cadence_avg":        cadence_avg,
            "cadence_max":        cadence_max,
            "ascent_m":           None,
            "descent_m":          None,
        })
        lap_num += 1

    log.info(f"FIT parsed: {len(split_rows)} laps for {exercise_id}")
    return split_rows

except Exception as e:
    log.error(f"FIT parse error {exercise_id}: {e}")
    return []
```

def fetch_fit_and_parse(exercise_id: str, session_date: str,
total_distance_m: float = None) -> list:
try:
r = requests.get(
f”{POLAR_BASE}/exercises/{exercise_id}/fit”,
headers={
“Authorization”: f”Bearer {POLAR_ACCESS_TOKEN}”,
“Accept”: “application/octet-stream”,
}
)
log.info(f”FIT download {exercise_id}: {r.status_code} {len(r.content)} bytes”)
if not r.ok:
log.error(f”FIT download failed: {r.status_code} {r.text[:200]}”)
return []
return parse_fit_laps(r.content, exercise_id, session_date, total_distance_m)
except Exception as e:
log.error(f”FIT fetch error {exercise_id}: {e}”)
return []

# ══════════════════════════════════════════════════════════════════════════

# FORMATTING

# ══════════════════════════════════════════════════════════════════════════

def format_run_list(runs: list) -> str:
if not runs:
return “No runs found.”
lines = [f”🏃 *Last {len(runs)} Runs*\n”]
for r in runs:
dist_km  = (r.get(“distance_meters”) or 0) / 1000
dur_s    = r.get(“duration_seconds”) or 0
pace_s   = dur_s / dist_km if dist_km else 0
load     = r.get(“training_load”)
load_str = f”  🔥 {load:.0f}” if load else “”
source   = “ ✏️” if r.get(“source”) == “manual” else “”
avg_pwr  = r.get(“avg_power”)
avg_cad  = r.get(“avg_cadence”)
pwr_str  = f”{avg_pwr}W” if avg_pwr else “?”
cad_str  = f”{avg_cad}spm” if avg_cad else “?”
lines.append(
f”{sport_emoji(r.get(‘sport’,’’))} *{fmt_date(r[‘date’])}*{source}  •  “
f”{dist_km:.1f}km  •  {int(dur_s//60)}min\n”
f”   💨 {seconds_to_pace(pace_s)}  ❤️ {r.get(‘avg_heart_rate’,’?’)}/{r.get(‘max_heart_rate’,’?’)}”
f”  ⚡ {pwr_str}  👟 {cad_str}{load_str}”
)
return “\n”.join(lines)

def format_splits_table(splits: list, header: str) -> str:
if not splits:
return “No splits found.”
lines = [f”📊 *{header}*\n”]
lines.append(”`KM  │ Pace     │ HR      │  Power │ Cad`”)
lines.append(”`────┼──────────┼─────────┼────────┼────`”)
for s in splits:
km    = str(s.get(“km_number”, “?”)).rjust(2)
pace  = (s.get(“pace_display”) or “N/A”).ljust(8)
hr    = f”{s.get(‘hr_avg’,’?’)}/{s.get(‘hr_max’,’?’)}”.ljust(7)
power = str(s.get(“power_avg”) or “?”).rjust(4) + “W”
cad   = str(s.get(“cadence_avg”) or “?”).rjust(3)
lines.append(f”`{km}  │ {pace} │ {hr} │ {power:>6} │ {cad}`”)
return “\n”.join(lines)

def format_recovery_dashboard(sleep_data: list, hrv_data: list) -> str:
lines = [“💤 *Recovery Dashboard*\n”]
if hrv_data:
h     = hrv_data[0]
emoji = recharge_emoji(h.get(“recharge_status”, “”))
lines.append(
f”{emoji} *Nightly Recharge — {h[‘date’]}*\n”
f”   ANS: {h.get(‘ans_charge’,’?’)}  •  Sleep charge: {h.get(‘sleep_charge’,’?’)}\n”
f”   HRV avg: {h.get(‘hrv_avg’,’?’)}  •  RMSSD: {h.get(‘hrv_rmssd’,’?’)}\n”
)
if sleep_data:
lines.append(“😴 *Sleep History*\n”)
for s in sleep_data:
total_s = s.get(“total_sleep_seconds”) or 0
score   = s.get(“sleep_score”) or 0
hrv     = s.get(“avg_hrv”) or “?”
hrs     = total_s // 3600
mins    = (total_s % 3600) // 60
rem_m   = (s.get(“rem_seconds”) or 0) // 60
deep_m  = (s.get(“deep_sleep_seconds”) or 0) // 60
bar     = “█” * int(score / 10) + “░” * (10 - int(score / 10))
lines.append(
f”*{s[‘date’]}*  {hrs}h{mins:02d}m  Score: {score:.0f}\n”
f”   `{bar}`\n”
f”   REM {rem_m}min  •  Deep {deep_m}min  •  HRV {hrv}”
)
return “\n”.join(lines)

def format_hr_dashboard(hr_data: list) -> str:
if not hr_data:
return “No continuous HR data found.”
lines = [“❤️ *Continuous Heart Rate — Last 7 Days*\n”]
for h in hr_data:
lines.append(
f”*{h[‘date’]}*  Avg {h.get(‘avg_hr’,’?’)}bpm  •  “
f”Min {h.get(‘min_hr’,’?’)}  •  Max {h.get(‘max_hr’,’?’)}”
)
return “\n”.join(lines)

def format_cardio_load_dashboard(load_data: list) -> str:
if not load_data:
return “No cardio load data found.”
lines = [“🔥 *Cardio Load — Last 14 Days*\n”]
for c in load_data:
emoji   = load_emoji(c.get(“cardio_load_status”, “”))
status  = (c.get(“cardio_load_status”) or “”).replace(”_”, “ “).title()
strain  = c.get(“strain”)
tol     = c.get(“tolerance”)
ratio   = c.get(“cardio_load_ratio”)
strain_str = f”  Strain: {strain:.0f}” if strain else “”
tol_str    = f”  Tol: {tol:.0f}”       if tol    else “”
ratio_str  = f”  Ratio: {ratio:.2f}”   if ratio  else “”
lines.append(
f”{emoji} *{c[‘date’]}*  {status}”
f”{strain_str}{tol_str}{ratio_str}”
)
return “\n”.join(lines)

def format_sleepwise_dashboard(sw_data: list) -> str:
if not sw_data:
return “No SleepWise data found.”
lines = [“🧠 *SleepWise Alertness — Last 7 Days*\n”]
for s in sw_data:
grade   = s.get(“grade”)
emoji   = grade_emoji(grade)
gc      = (s.get(“grade_classification”) or “”).replace(“GRADE_CLASSIFICATION_”, “”).replace(”*”, “ “).title()
inertia = (s.get(“sleep_inertia”) or “”).replace(“SLEEP_INERTIA*”, “”).replace(”_”, “ “).title()
bedtime_start = s.get(“circadian_bedtime_start”) or “”
bedtime_end   = s.get(“circadian_bedtime_end”)   or “”
bedtime_str   = f”  🛏 {bedtime_start}–{bedtime_end}” if bedtime_start else “”
lines.append(
f”{emoji} *{s[‘date’]}*  Grade: {grade or ‘?’}  •  {gc}\n”
f”   Sleep inertia: {inertia}{bedtime_str}”
)
return “\n”.join(lines)

def format_goals(goals: list) -> str:
if not goals:
return “No goals set. Add one with:\n`goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`”
lines = [“🎯 *Goals & Target Races*\n”]
for g in goals:
days_to = “”
if g.get(“race_date”):
try:
d    = datetime.strptime(g[“race_date”], “%Y-%m-%d”).date()
diff = (d - datetime.now().date()).days
days_to = f”  •  {diff}d away” if diff > 0 else “  •  PAST”
except:
pass
lines.append(
f”{‘⭐’ if g.get(‘priority’) == 1 else ‘🔹’} *{g.get(‘race_name’,’?’)}*\n”
f”   📅 {g.get(‘race_date’,’?’)}{days_to}\n”
f”   📏 {g.get(‘distance_km’,’?’)}km  •  🎯 {g.get(‘target_time’,’?’)}\n”
f”   {g.get(‘notes’,’’) or ‘’}”
)
return “\n”.join(lines)

def format_new_run_notification(ex: dict, exercise_id: str, splits_count: int) -> str:
try:
sport   = ex.get(“sport”, “RUN”)
dist_km = (ex.get(“distance”) or ex.get(“distance_meters”) or 0) / 1000
dur_s   = parse_pt_seconds(ex.get(“duration”, “”)) or (ex.get(“duration_seconds”) or 0)
hr      = ex.get(“heart_rate”, {}) or {}
avg_hr  = hr.get(“average”) or hr.get(“avg”) or ex.get(“avg_heart_rate”, “?”)
max_hr  = hr.get(“maximum”) or hr.get(“max”) or ex.get(“max_heart_rate”, “?”)
load    = ex.get(“training_load”) or ex.get(“training_load_pro”, {}).get(“cardio-load”, “?”)
pace_s  = dur_s / dist_km if dist_km else 0
lines   = [
f”{sport_emoji(sport)} *New {sport.replace(’_’,’ ’).title()} Synced!*\n”,
f”📅 {fmt_date(ex.get(‘start_time’) or ex.get(‘date’,’’))}  •  {dist_km:.2f}km  •  {int(dur_s//60)}min”,
f”💨 {seconds_to_pace(pace_s)}  ❤️ {avg_hr}/{max_hr}bpm”,
f”🔥 Load {load}”,
f”📊 {splits_count} km splits saved”,
]
if splits_count > 0:
split_data = supabase.table(“polar_km_splits”)  
.select(“km_number,pace_display,hr_avg,power_avg,cadence_avg”)  
.eq(“exercise_id”, exercise_id).order(“lap_number”).limit(5).execute()
if split_data.data:
lines.append(”\n*First splits:*”)
lines.append(”`KM  │ Pace     │  HR │ Power │ Cad`”)
for s in split_data.data:
km   = str(s[‘km_number’]).rjust(2)
pace = (s.get(‘pace_display’) or ‘N/A’).ljust(8)
hr_v = str(s.get(‘hr_avg’) or ‘?’).rjust(3)
pwr  = str(s.get(‘power_avg’) or ‘?’).rjust(4) + “W”
cad  = str(s.get(‘cadence_avg’) or ‘?’).rjust(3)
lines.append(f”`{km}  │ {pace} │ {hr_v} │ {pwr} │ {cad}`”)
return “\n”.join(lines)
except Exception as e:
log.error(f”Format notification error: {e}”)
return “✅ New run synced”

# ══════════════════════════════════════════════════════════════════════════

# WRITE TO SUPABASE

# ══════════════════════════════════════════════════════════════════════════

def save_coaching_note(topic: str, summary: str, full_response: str):
try:
supabase.table(“coaching_notes”).insert({
“date”:          datetime.now().strftime(”%Y-%m-%d”),
“topic”:         topic[:200],
“summary”:       summary[:500],
“full_response”: full_response[:5000],
}).execute()
except Exception as e:
log.error(f”Save coaching note error: {e}”)

def save_goal(text: str) -> str:
try:
text  = re.sub(r”^(goal|race|target)\s*[:：]\s*”, “”, text.strip(), flags=re.IGNORECASE)
parts = [p.strip() for p in text.split(”,”)]
if len(parts) < 2:
return “Format: `goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`”
race_name   = parts[0]
race_date   = None
distance_km = None
target_time = None
notes       = None
for p in parts[1:]:
date_match = re.search(r”(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})”, p)
if date_match and not race_date:
try:
race_date = datetime.strptime(date_match.group(1), “%d %b %Y”).strftime(”%Y-%m-%d”)
except:
try:
race_date = datetime.strptime(date_match.group(1), “%Y-%m-%d”).strftime(”%Y-%m-%d”)
except:
pass
continue
dist_match = re.search(r”([\d.]+)\s*km”, p, re.IGNORECASE)
if dist_match and not distance_km:
distance_km = float(dist_match.group(1))
continue
if re.search(r”(sub|under|target|<|goal)?\s*\d+[:h]\d+”, p, re.IGNORECASE) and not target_time:
target_time = p.strip()
continue
notes = p.strip()
supabase.table(“goals”).insert({
“race_name”:   race_name,
“race_date”:   race_date,
“distance_km”: distance_km,
“target_time”: target_time,
“notes”:       notes,
“priority”:    1,
“active”:      True,
}).execute()
return (
f”🎯 *Goal saved!*\n\n*{race_name}*\n”
f”📅 {race_date or ‘date TBC’}  •  📏 {distance_km or ‘?’}km\n”
f”🎯 {target_time or ‘time TBC’}”
)
except Exception as e:
log.error(f”Save goal error: {e}”)
return f”Error saving goal: {e}”

def save_manual_run(text: str) -> str:
raw_json = None
try:
raw   = re.sub(r”^(save\s+run|log\s+run|manual\s+run|run\s+log)\s*[:：]\s*”, “”, text.strip(), flags=re.IGNORECASE)
today = datetime.now().strftime(”%Y-%m-%d”)
parse_resp = claude.messages.create(
model=“claude-sonnet-4-20250514”,
max_tokens=1000,
system=(
“You are a precise data parser for running data. “
“Extract all fields and return ONLY a valid JSON object. “
“No markdown, no backticks, no explanation, no trailing commas, no comments. “
“All string values must use double quotes. Use null for missing fields. “
“All numeric values must be plain numbers, never strings.\n\n”
“Required fields: date (YYYY-MM-DD), sport (RUNNING/TRAIL_RUNNING/TREADMILL_RUNNING), “
“distance_meters, duration_seconds, avg_heart_rate, max_heart_rate, “
“avg_power, max_power, avg_cadence, max_cadence, “
“ascent, descent, calories, training_load, muscle_load, notes, “
“splits (array).\n\n”
“Each split object: km_number, duration_seconds, split_time_seconds, distance_m, “
“hr_avg, hr_max, power_avg, power_max, cadence_avg, cadence_max, pace_display.\n\n”
“pace_display format: MM:SS/km e.g. 7:31/km\n”
“duration_seconds: convert MM:SS to total seconds e.g. 7:03 = 423\n”
“split_time_seconds: cumulative time at end of lap in seconds\n”
“distance_m: always 1000 for full km splits”
),
messages=[{“role”: “user”, “content”: f”Today is {today}. Parse this run:\n\n{raw}”}]
)
raw_json = parse_resp.content[0].text.strip()
raw_json = re.sub(r”^`[a-zA-Z]*\s*", "", raw_json, flags=re.MULTILINE) raw_json = re.sub(r"`\s*$”, “”, raw_json, flags=re.MULTILINE)
raw_json = raw_json.strip()
log.info(f”Manual run JSON (first 500): {raw_json[:500]}”)
fields   = json.loads(raw_json)
ex_id    = f”manual-{datetime.now().strftime(’%Y%m%d%H%M%S’)}”
run_date = fields.get(“date”) or today
dur_s    = fields.get(“duration_seconds”) or 0
dist_m   = fields.get(“distance_meters”) or 0
pace_s   = dur_s / (dist_m / 1000) if dist_m else 0
sport    = fields.get(“sport”) or “RUNNING”
supabase.table(“polar_exercises”).upsert({
“polar_exercise_id”: ex_id,
“date”:              f”{run_date}T00:00:00+00:00”,
“sport”:             sport,
“duration_seconds”:  si(dur_s),
“distance_meters”:   sf(dist_m),
“avg_heart_rate”:    si(fields.get(“avg_heart_rate”)),
“max_heart_rate”:    si(fields.get(“max_heart_rate”)),
“avg_power”:         si(fields.get(“avg_power”)),
“max_power”:         si(fields.get(“max_power”)),
“avg_cadence”:       si(fields.get(“avg_cadence”)),
“max_cadence”:       si(fields.get(“max_cadence”)),
“ascent”:            sf(fields.get(“ascent”)),
“descent”:           sf(fields.get(“descent”)),
“calories”:          si(fields.get(“calories”)),
“training_load”:     sf(fields.get(“training_load”)),
“muscle_load”:       sf(fields.get(“muscle_load”)),
“notes”:             fields.get(“notes”),
“source”:            “manual”,
}, on_conflict=“polar_exercise_id”).execute()
splits     = fields.get(“splits”) or []
split_rows = []
for s in splits:
lap_dur = s.get(“duration_seconds”) or 0
split_rows.append({
“exercise_id”:        ex_id,
“session_date”:       run_date,
“lap_number”:         (s.get(“km_number”) or 1) - 1,
“km_number”:          s.get(“km_number”) or 1,
“duration_seconds”:   sf(lap_dur),
“split_time_seconds”: sf(s.get(“split_time_seconds”)),
“distance_m”:         sf(s.get(“distance_m”) or 1000),
“pace_min_per_km”:    sf(lap_dur / 60) if lap_dur else None,
“pace_display”:       s.get(“pace_display”) or seconds_to_pace(lap_dur),
“hr_avg”:             si(s.get(“hr_avg”)),
“hr_max”:             si(s.get(“hr_max”)),
“power_avg”:          si(s.get(“power_avg”)),
“power_max”:          si(s.get(“power_max”)),
“cadence_avg”:        si(s.get(“cadence_avg”)),
“cadence_max”:        si(s.get(“cadence_max”)),
“ascent_m”:           sf(s.get(“ascent_m”, 0)),
“descent_m”:          sf(s.get(“descent_m”, 0)),
})
if split_rows:
supabase.table(“polar_km_splits”).upsert(
split_rows, on_conflict=“exercise_id,lap_number”
).execute()
dist_km = dist_m / 1000 if dist_m else 0
lines   = [
f”✏️ *Run saved!*\n”,
f”{sport_emoji(sport)} {sport.replace(’_’,’ ‘).title()}  •  {run_date}”,
f”📏 {dist_km:.2f}km  •  ⏱ {int(dur_s//60)}:{int(dur_s%60):02d}”,
f”💨 {seconds_to_pace(pace_s)}  ❤️ {fields.get(‘avg_heart_rate’,’?’)}/{fields.get(‘max_heart_rate’,’?’)}bpm”,
f”⚡ {fields.get(‘avg_power’,’?’)}W  •  👟 {fields.get(‘avg_cadence’,’?’)}spm”,
f”⬆️ {fields.get(‘ascent’) or 0:.0f}m  •  🔥 Load {fields.get(‘training_load’,’?’)}”,
]
if split_rows:
lines.append(f”\n📊 {len(split_rows)} km splits saved”)
lines.append(”\n`KM  │ Pace     │ HR      │ Power │ Cad`”)
for s in split_rows:
km   = str(s[“km_number”]).rjust(2)
pace = (s.get(“pace_display”) or “N/A”).ljust(8)
hr   = f”{s.get(‘hr_avg’,’?’)}/{s.get(‘hr_max’,’?’)}”.ljust(7)
pwr  = str(s.get(“power_avg”) or “?”).rjust(4) + “W”
cad  = str(s.get(“cadence_avg”) or “?”).rjust(3)
lines.append(f”`{km}  │ {pace} │ {hr} │ {pwr} │ {cad}`”)
return “\n”.join(lines)
except json.JSONDecodeError as e:
log.error(f”JSON decode error: {e} raw_json={raw_json[:1000] if raw_json else ‘None’}”)
return “Error parsing run data — check Railway logs for details.”
except Exception as e:
log.error(f”Save manual run error: {e}”)
return f”Error saving run: {e}”

def save_wellness_checkin(text: str) -> str:
try:
text        = re.sub(r”^(check.?in|wellness|feeling|mood)\s*[:：]\s*”, “”, text.strip(), flags=re.IGNORECASE)
weight_kg   = None
fatigue     = None
sleep_score = None
mood        = None
m = re.search(r”([\d.]+)\s*kg”, text, re.IGNORECASE)
if m: weight_kg = float(m.group(1))
m = re.search(r”fatigue\s+(\d+)(?:/10)?”, text, re.IGNORECASE)
if m: fatigue = int(m.group(1))
m = re.search(r”sleep\s+(\d+)(?:/10)?”, text, re.IGNORECASE)
if m: sleep_score = int(m.group(1))
m = re.search(r”mood\s+(\d+)(?:/10)?”, text, re.IGNORECASE)
if m: mood = int(m.group(1))
supabase.table(“wellness_checkins”).insert({
“date”:          datetime.now().strftime(”%Y-%m-%d”),
“weight_kg”:     weight_kg,
“fatigue_score”: fatigue,
“sleep_score”:   sleep_score,
“mood_score”:    mood,
“notes”:         text[:500],
}).execute()
parts = [“✅ *Check-in saved!*\n”]
if weight_kg:   parts.append(f”⚖️ {weight_kg}kg”)
if fatigue:     parts.append(f”😓 Fatigue: {fatigue}/10”)
if sleep_score: parts.append(f”😴 Sleep: {sleep_score}/10”)
if mood:        parts.append(f”😊 Mood: {mood}/10”)
return “\n”.join(parts)
except Exception as e:
log.error(f”Save wellness error: {e}”)
return f”Error saving check-in: {e}”

# ══════════════════════════════════════════════════════════════════════════

# POLAR SYNC

# ══════════════════════════════════════════════════════════════════════════

def save_exercise_from_api(ex_data: dict, exercise_id: str, split_rows: list) -> int:
try:
sport       = ex_data.get(“sport”, “”)
hr          = ex_data.get(“heart_rate”, {}) or {}
load        = ex_data.get(“training_load_pro”, {}) or {}
zones       = ex_data.get(“heart_rate_zones”, []) or []
start       = ex_data.get(“start_time”, “”)
dur_s       = parse_pt_seconds(ex_data.get(“duration”, “”))
dist_m      = sf(ex_data.get(“distance”))
cadence_obj = ex_data.get(“cadence”, {}) or {}
power_obj   = ex_data.get(“power”, {}) or {}
avg_cadence = si(cadence_obj.get(“avg”) or ex_data.get(“avg_cadence”))
max_cadence = si(cadence_obj.get(“max”) or ex_data.get(“max_cadence”))
avg_power   = si(power_obj.get(“avg”)   or ex_data.get(“avg_power”))
max_power   = si(power_obj.get(“max”)   or ex_data.get(“max_power”))

```
    if avg_cadence is None and split_rows:
        cad_vals = [s["cadence_avg"] for s in split_rows if s.get("cadence_avg")]
        if cad_vals:
            avg_cadence = si(sum(cad_vals) / len(cad_vals))
    if avg_power is None and split_rows:
        pwr_vals = [s["power_avg"] for s in split_rows if s.get("power_avg")]
        if pwr_vals:
            avg_power = si(sum(pwr_vals) / len(pwr_vals))

    hr_zones_parsed = [{
        "zone":    z.get("index"),
        "lower":   z.get("lower-limit"),
        "upper":   z.get("upper-limit"),
        "seconds": parse_pt_seconds(z.get("in-zone", "PT0S")),
    } for z in zones]

    load_info   = ex_data.get("loadInformation") or {}
    cardio_load = sf(ex_data.get("training_load") or load.get("cardio-load") or load_info.get("cardioLoad"))
    muscle_load = sf(load.get("muscle-load") or load_info.get("muscleLoad"))

    supabase.table("polar_exercises").upsert({
        "polar_exercise_id": exercise_id,
        "date":              start,
        "sport":             sport,
        "duration_seconds":  si(dur_s),
        "distance_meters":   dist_m,
        "calories":          si(ex_data.get("calories")),
        "avg_heart_rate":    si(hr.get("average")),
        "max_heart_rate":    si(hr.get("maximum")),
        "avg_cadence":       avg_cadence,
        "max_cadence":       max_cadence,
        "avg_power":         avg_power,
        "max_power":         max_power,
        "training_load":     cardio_load,
        "muscle_load":       muscle_load,
        "ascent":            sf(ex_data.get("ascent")),
        "descent":           sf(ex_data.get("descent")),
        "hr_zones":          json.dumps(hr_zones_parsed),
        "raw_json":          json.dumps(ex_data),
        "source":            "polar",
    }, on_conflict="polar_exercise_id").execute()

    if split_rows:
        supabase.table("polar_km_splits").upsert(
            split_rows, on_conflict="exercise_id,lap_number"
        ).execute()

    log.info(f"Saved {exercise_id}: {sport} {(dist_m or 0)/1000:.1f}km, {len(split_rows)} splits")
    return len(split_rows)

except Exception as e:
    log.error(f"Save exercise error {exercise_id}: {e}")
    return 0
```

def sync_new_polar_exercises() -> list:
try:
r = requests.get(f”{POLAR_BASE}/exercises”, headers=polar_headers())
log.info(f”Exercises GET: {r.status_code}”)
if r.status_code == 204 or not r.ok:
return []
exercises = r.json()
if not isinstance(exercises, list):
exercises = exercises.get(“exercises”, [])
log.info(f”Exercises: {len(exercises)} found”)
new_exercises = []
for ex in exercises:
ex_id = str(ex.get(“id”, “”))
if not ex_id:
continue
sport = ex.get(“sport”, “”)
if sport not in ALLOWED_SPORTS:
continue
existing = supabase.table(“polar_exercises”)  
.select(“polar_exercise_id”)  
.eq(“polar_exercise_id”, ex_id).limit(1).execute()
if existing.data:
continue
detail_r = requests.get(
f”{POLAR_BASE}/exercises/{ex_id}?zones=true”,
headers=polar_headers()
)
if not detail_r.ok:
log.error(f”Exercise detail error {ex_id}: {detail_r.status_code}”)
continue
ex_data    = detail_r.json()
start      = ex_data.get(“start_time”, “”)
dist_m     = sf(ex_data.get(“distance”))
split_rows = fetch_fit_and_parse(ex_id, start[:10], dist_m)
splits     = save_exercise_from_api(ex_data, ex_id, split_rows)
new_exercises.append({“id”: ex_id, “data”: ex_data, “splits”: splits})
return new_exercises
except Exception as e:
log.error(f”Exercises sync error: {e}”)
return []

def sync_sleep() -> int:
try:
r = requests.get(f”{POLAR_BASE}/users/{POLAR_USER_ID}/sleep”, headers=polar_headers())
log.info(f”Sleep GET: {r.status_code}”)
if r.status_code == 204 or not r.ok:
return 0
data   = r.json()
nights = data.get(“nights”, data if isinstance(data, list) else [data])
count  = 0
for s in nights:
date = (s.get(“date”) or s.get(“night”, “”))[:10]
if not date:
continue
total_s       = _parse_pt_to_seconds(s.get(“sleepTimeSeconds”) or s.get(“sleep_time”) or 0)
rem_s         = _parse_pt_to_seconds(s.get(“remSleepSeconds”)   or s.get(“rem_sleep”)  or 0)
deep_s        = _parse_pt_to_seconds(s.get(“deepSleepSeconds”)  or s.get(“deep_sleep”) or 0)
light_s       = _parse_pt_to_seconds(s.get(“lightSleepSeconds”) or s.get(“light_sleep”)or 0)
score         = sf(s.get(“sleepScore”)       or s.get(“sleep_score”))
avg_hrv       = sf(s.get(“avgHrv”)           or s.get(“avg_hrv”))
interruptions = si(s.get(“numInterruptions”) or s.get(“interruptions”))
supabase.table(“polar_sleep”).upsert({
“date”:                date,
“total_sleep_seconds”: total_s or None,
“sleep_score”:         score,
“rem_seconds”:         rem_s   or None,
“light_sleep_seconds”: light_s or None,
“deep_sleep_seconds”:  deep_s  or None,
“interruptions”:       interruptions,
“avg_hrv”:             avg_hrv,
“raw_json”:            json.dumps(s),
}, on_conflict=“date”).execute()
count += 1
log.info(f”Sleep sync: {count} nights”)
return count
except Exception as e:
log.error(f”Sleep sync error: {e}”)
return 0

def _recharge_status_label(status_int) -> str:
mapping = {1: “POOR”, 2: “LOW”, 3: “MODERATE”, 4: “GOOD”, 5: “EXCELLENT”}
if status_int is None:
return None
try:
return mapping.get(int(status_int), str(status_int))
except:
return str(status_int)

def sync_nightly_recharge() -> int:
try:
r = requests.get(f”{POLAR_BASE}/users/{POLAR_USER_ID}/nightly-recharge”, headers=polar_headers())
log.info(f”Recharge GET: {r.status_code}”)
if r.status_code == 204 or not r.ok:
return 0
data   = r.json()
nights = data.get(“recharges”, data if isinstance(data, list) else [data])
count  = 0
for h in nights:
date = (h.get(“date”) or “”)[:10]
if not date:
continue
hrv_avg = None
samples = h.get(“hrv_samples”) or h.get(“hrvSamples”, {})
if isinstance(samples, dict) and samples:
vals    = list(samples.values())
hrv_avg = round(sum(vals) / len(vals), 1)
if not hrv_avg:
hrv_avg = sf(h.get(“heartRateVariabilityAvg”) or h.get(“hrv_avg”))
supabase.table(“polar_hrv”).upsert({
“date”:            date,
“hrv_avg”:         hrv_avg,
“hrv_rmssd”:       sf(h.get(“beatToBeatAvg”)  or h.get(“hrv_rmssd”)),
“ans_charge”:      sf(h.get(“ansCharge”)       or h.get(“ans_charge”)),
“sleep_charge”:    sf(h.get(“ansChargeStatus”) or h.get(“sleep_charge”)),
“recharge_status”: _recharge_status_label(
h.get(“nightlyRechargeStatus”) or h.get(“nightly_recharge_status”)
),
“raw_json”:        json.dumps(h),
}, on_conflict=“date”).execute()
count += 1
log.info(f”Recharge sync: {count} nights”)
return count
except Exception as e:
log.error(f”Recharge sync error: {e}”)
return 0

def sync_daily_activity() -> int:
try:
r = requests.get(f”{POLAR_BASE}/users/activities”, headers=polar_headers())
log.info(f”Activity GET: {r.status_code}”)
if r.status_code == 204 or not r.ok:
return 0
data       = r.json()
activities = data if isinstance(data, list) else data.get(“activities”, [data])
count      = 0
for a in activities:
date = (a.get(“start_time”) or a.get(“date”) or “”)[:10]
if not date:
continue
supabase.table(“polar_daily_activity”).upsert({
“date”:                date,
“steps”:               si(a.get(“steps”)),
“calories_total”:      sf(a.get(“calories”)),
“active_calories”:     sf(a.get(“active_calories”) or a.get(“activeCalories”)),
“active_time_seconds”: si(_parse_pt_to_seconds(a.get(“active_duration”) or 0)),
“raw_json”:            json.dumps(a),
}, on_conflict=“date”).execute()
count += 1
log.info(f”Activity sync: {count} days”)
return count
except Exception as e:
log.error(f”Activity sync error: {e}”)
return 0

def sync_continuous_hr() -> int:
try:
count = 0
for delta in range(7):
date = (datetime.now(timezone.utc) - timedelta(days=delta)).strftime(”%Y-%m-%d”)
r    = requests.get(
f”{POLAR_BASE}/users/continuous-heart-rate/{date}”,
headers=polar_headers()
)
if r.status_code == 404 or not r.ok:
continue
data    = r.json()
samples = data.get(“heart_rate_samples”, [])
hr_vals = [s.get(“heart_rate”) for s in samples if s.get(“heart_rate”)]
avg_hr  = round(sum(hr_vals) / len(hr_vals)) if hr_vals else None
min_hr  = min(hr_vals) if hr_vals else None
max_hr  = max(hr_vals) if hr_vals else None
supabase.table(“polar_continuous_hr”).upsert({
“date”:     date,
“avg_hr”:   avg_hr,
“min_hr”:   min_hr,
“max_hr”:   max_hr,
“raw_json”: json.dumps(data),
}, on_conflict=“date”).execute()
count += 1
log.info(f”Continuous HR sync: {count} days”)
return count
except Exception as e:
log.error(f”Continuous HR sync error: {e}”)
return 0

def sync_cardio_load() -> int:
“”“Hits the real /v3/users/cardio-load/ endpoint.”””
try:
r = requests.get(f”{POLAR_BASE}/users/cardio-load/”, headers=polar_headers())
log.info(f”Cardio load GET: {r.status_code}”)
if r.status_code == 204 or not r.ok:
return 0
data    = r.json()
entries = data if isinstance(data, list) else data.get(“cardio_load”, [data])
count   = 0
for c in entries:
date_str = (c.get(“date”) or “”)[:10]
if not date_str:
continue
levels = c.get(“cardio_load_level”) or {}
supabase.table(“polar_cardio_load”).upsert({
“date”:               date_str,
“cardio_load”:        sf(c.get(“cardio_load”)),
“cardio_load_status”: c.get(“cardio_load_status”),
“cardio_load_ratio”:  sf(c.get(“cardio_load_ratio”)),
“strain”:             sf(c.get(“strain”)),
“tolerance”:          sf(c.get(“tolerance”)),
“load_very_low”:      sf(levels.get(“very_low”)),
“load_low”:           sf(levels.get(“low”)),
“load_medium”:        sf(levels.get(“medium”)),
“load_high”:          sf(levels.get(“high”)),
“load_very_high”:     sf(levels.get(“very_high”)),
“raw_json”:           json.dumps(c),
}, on_conflict=“date”).execute()
count += 1
log.info(f”Cardio load sync: {count} days from API”)
return count
except Exception as e:
log.error(f”Cardio load sync error: {e}”)
return 0

def sync_sleepwise() -> int:
“”“Syncs SleepWise alertness grades and circadian bedtime window.”””
try:
r = requests.get(f”{POLAR_BASE}/users/sleepwise/alertness”, headers=polar_headers())
log.info(f”SleepWise GET: {r.status_code}”)
if r.status_code == 204 or not r.ok:
return 0
data    = r.json()
entries = data if isinstance(data, list) else data.get(“alertness”, [data])
count   = 0
for s in entries:
period_start = s.get(“period_start_time”) or s.get(“sleep_period_start_time”) or “”
date_str     = period_start[:10] if period_start else “”
if not date_str:
continue
supabase.table(“polar_sleepwise”).upsert({
“date”:                    date_str,
“grade”:                   sf(s.get(“grade”)),
“grade_classification”:    s.get(“grade_classification”),
“sleep_inertia”:           s.get(“sleep_inertia”),
“sleep_type”:              s.get(“sleep_type”),
“period_start_time”:       s.get(“period_start_time”),
“period_end_time”:         s.get(“period_end_time”),
“sleep_period_start_time”: s.get(“sleep_period_start_time”),
“sleep_period_end_time”:   s.get(“sleep_period_end_time”),
“raw_json”:                json.dumps(s),
}, on_conflict=“date”).execute()
count += 1

```
    # Circadian bedtime window
    r2 = requests.get(f"{POLAR_BASE}/users/sleepwise/circadian-bedtime", headers=polar_headers())
    log.info(f"Circadian bedtime GET: {r2.status_code}")
    if r2.ok:
        cb      = r2.json()
        today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        start_t = cb.get("start") or cb.get("bedtime_start") or cb.get("circadian_start")
        end_t   = cb.get("end")   or cb.get("bedtime_end")   or cb.get("circadian_end")
        if start_t or end_t:
            supabase.table("polar_sleepwise").upsert({
                "date":                    today,
                "circadian_bedtime_start": str(start_t) if start_t else None,
                "circadian_bedtime_end":   str(end_t)   if end_t   else None,
            }, on_conflict="date").execute()

    log.info(f"SleepWise sync: {count} days")
    return count
except Exception as e:
    log.error(f"SleepWise sync error: {e}")
    return 0
```

# ══════════════════════════════════════════════════════════════════════════

# SUPABASE CONTEXT FOR CLAUDE

# ══════════════════════════════════════════════════════════════════════════

def build_training_context(run_limit: int = 10, sleep_days: int = 7) -> str:
try:
parts = []

```
    goals = supabase.table("goals")\
        .select("race_name,race_date,distance_km,target_time,priority,notes")\
        .eq("active", True).order("race_date").execute()
    if goals.data:
        parts.append("=== GOALS & TARGET RACES ===")
        for g in goals.data:
            try:
                d        = datetime.strptime(g["race_date"], "%Y-%m-%d").date()
                diff     = (d - datetime.now().date()).days
                days_str = f" ({diff} days away)" if diff > 0 else " (PAST)"
            except:
                days_str = ""
            parts.append(
                f"  {g.get('race_name')} | {g.get('race_date')}{days_str} | "
                f"{g.get('distance_km')}km | Target: {g.get('target_time')} | "
                f"{'A-race' if g.get('priority')==1 else 'B-race'}"
            )

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

    notes = supabase.table("coaching_notes")\
        .select("date,topic,summary")\
        .order("date", desc=True).limit(5).execute()
    if notes.data:
        parts.append("\n=== RECENT COACHING NOTES ===")
        for n in notes.data:
            parts.append(f"  {n['date']} | {n.get('topic','?')} | {n.get('summary','')}")

    runs = supabase.table("polar_exercises")\
        .select("polar_exercise_id,date,sport,distance_meters,duration_seconds,"
                "avg_heart_rate,max_heart_rate,avg_power,avg_cadence,training_load,"
                "ascent,descent,source")\
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
                f"Power: {r.get('avg_power','?')}W | Cadence: {r.get('avg_cadence','?')}spm | "
                f"Load: {r.get('training_load','?')} | Ascent: {r.get('ascent','?')}m"
            )
        latest = get_latest_run_with_splits()
        if latest:
            splits = supabase.table("polar_km_splits")\
                .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg")\
                .eq("exercise_id", latest["polar_exercise_id"])\
                .order("lap_number").execute()
            if splits.data:
                dist_km = (latest.get("distance_meters") or 0) / 1000
                parts.append(f"\n=== KM SPLITS: {latest['date'][:10]} ({dist_km:.1f}km) ===")
                for s in splits.data:
                    parts.append(
                        f"  KM {s['km_number']:2d} | {s.get('pace_display','?'):10s} | "
                        f"HR {s.get('hr_avg','?')}/{s.get('hr_max','?')} | "
                        f"Power {s.get('power_avg','?')}W | "
                        f"Cadence {s.get('cadence_avg','?')}spm"
                    )

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

    sleep = supabase.table("polar_sleep")\
        .select("date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,light_sleep_seconds,avg_hrv,interruptions")\
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
                f"Interruptions: {s.get('interruptions','?')} | "
                f"HRV: {s.get('avg_hrv','?')}"
            )

    hrv = supabase.table("polar_hrv")\
        .select("date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd")\
        .order("date", desc=True).limit(7).execute()
    if hrv.data:
        parts.append(f"\n=== NIGHTLY RECHARGE (last {len(hrv.data)} nights) ===")
        for h in hrv.data:
            parts.append(
                f"  {h['date']} | Status: {h.get('recharge_status','?')} | "
                f"ANS: {h.get('ans_charge','?')} | "
                f"HRV: {h.get('hrv_avg','?')} | RMSSD: {h.get('hrv_rmssd','?')}"
            )

    try:
        chr_data = supabase.table("polar_continuous_hr")\
            .select("date,avg_hr,min_hr,max_hr")\
            .order("date", desc=True).limit(7).execute()
        if chr_data.data:
            parts.append(f"\n=== CONTINUOUS HEART RATE (last {len(chr_data.data)} days) ===")
            for h in chr_data.data:
                parts.append(
                    f"  {h['date']} | Avg: {h.get('avg_hr','?')}bpm | "
                    f"Min: {h.get('min_hr','?')} | Max: {h.get('max_hr','?')}"
                )
    except:
        pass

    try:
        cl_data = supabase.table("polar_cardio_load")\
            .select("date,cardio_load,cardio_load_status,cardio_load_ratio,strain,tolerance")\
            .order("date", desc=True).limit(14).execute()
        if cl_data.data:
            parts.append(f"\n=== CARDIO LOAD (last {len(cl_data.data)} days) ===")
            for c in cl_data.data:
                parts.append(
                    f"  {c['date']} | Status: {c.get('cardio_load_status','?')} | "
                    f"Strain: {c.get('strain','?')} | Tolerance: {c.get('tolerance','?')} | "
                    f"Ratio: {c.get('cardio_load_ratio','?')} | Load: {c.get('cardio_load','?')}"
                )
    except:
        pass

    try:
        sw_data = supabase.table("polar_sleepwise")\
            .select("date,grade,grade_classification,sleep_inertia,circadian_bedtime_start,circadian_bedtime_end")\
            .order("date", desc=True).limit(7).execute()
        if sw_data.data:
            parts.append(f"\n=== SLEEPWISE ALERTNESS (last {len(sw_data.data)} days) ===")
            for s in sw_data.data:
                gc      = (s.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
                inertia = (s.get("sleep_inertia") or "").replace("SLEEP_INERTIA_", "").replace("_", " ").title()
                bedtime = f"Bedtime window: {s.get('circadian_bedtime_start','?')}–{s.get('circadian_bedtime_end','?')}" \
                          if s.get("circadian_bedtime_start") else ""
                parts.append(
                    f"  {s['date']} | Grade: {s.get('grade','?')} | {gc} | "
                    f"Inertia: {inertia} | {bedtime}"
                )
    except:
        pass

    activity = supabase.table("polar_daily_activity")\
        .select("date,steps,calories_total,active_calories,active_time_seconds")\
        .order("date", desc=True).limit(7).execute()
    if activity.data:
        parts.append(f"\n=== DAILY ACTIVITY (last {len(activity.data)} days) ===")
        for a in activity.data:
            active_min = (a.get("active_time_seconds") or 0) // 60
            parts.append(
                f"  {a['date']} | Steps: {a.get('steps','?')} | "
                f"Calories: {a.get('calories_total','?')} | Active: {active_min}min"
            )

    return "\n".join(parts)

except Exception as e:
    log.error(f"Context error: {e}")
    return "Training data temporarily unavailable."
```

# ══════════════════════════════════════════════════════════════════════════

# CLAUDE — SUPER COACH

# ══════════════════════════════════════════════════════════════════════════

BASE_SYSTEM = “”“You are an elite running coach and sports scientist for Luke Worgan. You have access to his complete physiological and training data in real time.

ATHLETE PROFILE:

- DOB: 1989-03-03 (age 37) | Height: 167cm | Weight: 78kg
- VO2max: 55 | Max HR: 198bpm | Resting HR: 47bpm
- Aerobic threshold: 149bpm | Anaerobic threshold: 178bpm | FTP: 272W
- Watch: Polar Grit X2

PRIMARY GOAL: London Marathon, 27 April 2026 — sub 3:30 (4:58/km)
SECONDARY GOAL: Ultra marathons (ongoing)

YOUR DATA ACCESS — 8 live data streams:

1. polar_exercises — every run with km splits, HR, power, cadence, load
1. polar_sleep — nightly sleep stages (REM, deep, light), score, HRV (historical)
1. polar_hrv — nightly recharge, ANS charge, HRV avg and RMSSD (historical)
1. polar_continuous_hr — 24hr resting HR trends (cardiac drift, overtraining signal)
1. polar_cardio_load — daily strain, tolerance, ratio, status (LIVE from Polar API)
1. polar_sleepwise — SleepWise alertness grade, classification, sleep inertia, circadian bedtime
1. polar_daily_activity — steps, calories, active time
1. wellness_checkins — Luke’s manual fatigue/sleep/mood scores

HOW TO USE ALL 8 DATA STREAMS AS A SUPER COACH:

READINESS scoring — combine ALL signals before recommending any session:
• SleepWise grade (8-10 = green, 6-8 = amber, <6 = red)
• Sleep inertia — NO_INERTIA vs HIGH_INERTIA affects morning performance
• Cardio load ratio (>1.3 = overreaching risk, <0.8 = detraining)
• Strain vs tolerance — if strain > tolerance, recovery needed
• Continuous HR trend — resting HR elevated >3 days = systemic fatigue
• Subjective wellness checkin scores

CARDIO LOAD INTERPRETATION:
• strain = today’s acute load
• tolerance = chronic fitness base (28-day rolling)
• ratio = strain/tolerance — the key number
• ratio 0.8-1.1 = MAINTAINING | 1.1-1.3 = PRODUCTIVE | >1.3 = OVERREACHING | <0.8 = DETRAINING
• Status RECOVERY_AFTER_OVERREACHING = mandatory easy days, flag this immediately

SLEEPWISE INTERPRETATION:
• grade 1-10 scale — reflects predicted alertness from sleep quality
• GRADE_CLASSIFICATION_STRONG (8+) = well rested, ready for hard session
• GRADE_CLASSIFICATION_MODERATE (5-8) = acceptable, adjust intensity
• GRADE_CLASSIFICATION_WEAK (<5) = compromised, easy day only
• Sleep inertia HIGH = morning grogginess will affect early session performance
• Circadian bedtime window = Luke’s optimal sleep timing

PERFORMANCE TRENDS:
• Track pace/HR drift across equivalent efforts (aerobic efficiency)
• Power-to-pace ratio changes indicate fitness or fatigue
• Cadence trends — target 170-180spm for marathon efficiency
• KM splits for pacing discipline (positive vs negative splits)

COACHING RULES:

- Always reference Luke’s actual numbers, never generic advice
- Flag overreaching risk immediately and specifically
- Connect every recommendation to London Marathon timeline ({days_to_marathon} days away)
- Be direct — Luke wants honesty, not encouragement
- Use min/km for pace, bpm for HR, watts for power
- Never break character — you are his coach, not an AI

WRITE TRIGGERS:

- “save run: …” → saves to database with splits
- “goal: …” → saves race goal
- “checkin: weight 77.5kg, fatigue 6/10, sleep 7/10, mood 8/10” → logs wellness

After every substantive response, end with:
NOTE: <topic> | <one sentence summary>”””

def build_system_prompt(run_limit: int = 10, sleep_days: int = 7) -> str:
system = BASE_SYSTEM.replace(”{days_to_marathon}”, str(days_to_marathon()))
return f”{system}\n\n{build_training_context(run_limit, sleep_days)}”

conversation_history = {}

def get_history(chat_id):
return conversation_history.get(chat_id, [])

def add_to_history(chat_id, role, content):
if chat_id not in conversation_history:
conversation_history[chat_id] = []
conversation_history[chat_id].append({“role”: role, “content”: content})
conversation_history[chat_id] = conversation_history[chat_id][-20:]

def extract_and_save_note(reply: str, user_text: str):
try:
m = re.search(r”NOTE:\s*(.+?)\s*|\s*(.+?)$”, reply, re.MULTILINE)
if m:
save_coaching_note(m.group(1).strip(), m.group(2).strip(), reply)
return re.sub(r”\nNOTE:.+$”, “”, reply, flags=re.MULTILINE).strip()
except Exception as e:
log.error(f”Extract note error: {e}”)
return reply

# ══════════════════════════════════════════════════════════════════════════

# MORNING BRIEFING

# ══════════════════════════════════════════════════════════════════════════

def send_morning_briefing():
try:
sleep = supabase.table(“polar_sleep”)  
.select(“date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds,avg_hrv”)  
.order(“date”, desc=True).limit(7).execute()
hrv = supabase.table(“polar_hrv”)  
.select(“date,recharge_status,ans_charge,sleep_charge,hrv_avg,hrv_rmssd”)  
.order(“date”, desc=True).limit(1).execute()
bot.send_message(YOUR_TELEGRAM_ID,
format_recovery_dashboard(sleep.data, hrv.data), parse_mode=“Markdown”)

```
    # Compute readiness algorithmically
    readiness = compute_readiness_score()
    session   = recommend_session(readiness)

    # SleepWise today
    sw = supabase.table("polar_sleepwise")\
        .select("date,grade,grade_classification,sleep_inertia,circadian_bedtime_start,circadian_bedtime_end")\
        .order("date", desc=True).limit(1).execute()
    sw_context = ""
    if sw.data:
        s  = sw.data[0]
        gc = (s.get("grade_classification") or "").replace("GRADE_CLASSIFICATION_", "").replace("_", " ").title()
        sw_context = f" SleepWise grade: {s.get('grade','?')} ({gc}), inertia: {s.get('sleep_inertia','?')}."

    # Cardio load today
    cl = supabase.table("polar_cardio_load")\
        .select("date,cardio_load_status,cardio_load_ratio,strain,tolerance")\
        .order("date", desc=True).limit(1).execute()
    load_context = ""
    if cl.data:
        c            = cl.data[0]
        load_context = (
            f" Cardio load: {c.get('cardio_load_status','?')} | "
            f"Strain {c.get('strain','?')} / Tolerance {c.get('tolerance','?')} | "
            f"Ratio {c.get('cardio_load_ratio','?')}."
        )

    response = claude.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system=build_system_prompt(),
        messages=[{"role": "user", "content": (
            f"Morning briefing. London Marathon is {days_to_marathon()} days away."
            f"{sw_context}{load_context} "
            f"Algorithmic readiness score today: {readiness['score']}/10 ({readiness['label']}). "
            f"Recommended session: {session}. "
            f"Give Luke: (1) validate or challenge the readiness score with your own analysis, "
            f"(2) confirm or adjust today's session recommendation with specific effort/pace/HR targets, "
            f"(3) one flag from recent data that needs attention, "
            f"(4) weekly load check. Be specific and direct. Max 4 paragraphs."
        )}]
    )
    reply = extract_and_save_note(response.content[0].text, "morning briefing")
    bot.send_message(YOUR_TELEGRAM_ID,
        f"☀️ *Morning Briefing — {datetime.now().strftime('%-d %b')}*\n\n"
        f"{readiness_emoji(readiness['score'])} *Readiness: {readiness['score']}/10* — _{readiness['label']}_\n\n"
        f"{reply}",
        parse_mode="Markdown")

    # Run alert check after morning briefing
    check_and_push_alerts()

except Exception as e:
    log.error(f"Briefing error: {e}")
```

# ══════════════════════════════════════════════════════════════════════════

# POST-RUN DEBRIEF

# ══════════════════════════════════════════════════════════════════════════

def send_post_run_debrief(exercise_id: str):
if exercise_id in debriefed_today:
log.info(f”Post-run debrief already sent for {exercise_id}, skipping”)
return
debriefed_today.add(exercise_id)
log.info(f”Post-run debrief: waiting 4 minutes for {exercise_id}”)
time.sleep(240)
try:
run_resp = supabase.table(“polar_exercises”)  
.select(”*”).eq(“polar_exercise_id”, exercise_id).limit(1).execute()
if not run_resp.data:
return
run = run_resp.data[0]
splits_resp = supabase.table(“polar_km_splits”)  
.select(“km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg”)  
.eq(“exercise_id”, exercise_id).order(“lap_number”).execute()
splits     = splits_resp.data or []
sleep_resp = supabase.table(“polar_sleep”)  
.select(“date,total_sleep_seconds,sleep_score,rem_seconds,deep_sleep_seconds”)  
.order(“date”, desc=True).limit(3).execute()
sleep_rows = sleep_resp.data or []
hrv_resp   = supabase.table(“polar_hrv”)  
.select(“date,hrv_avg,ans_charge,recharge_status”)  
.order(“date”, desc=True).limit(1).execute()
hrv        = hrv_resp.data[0] if hrv_resp.data else {}
cl_resp    = supabase.table(“polar_cardio_load”)  
.select(“date,cardio_load_status,cardio_load_ratio,strain,tolerance”)  
.order(“date”, desc=True).limit(1).execute()
cl         = cl_resp.data[0] if cl_resp.data else {}
now        = datetime.now(timezone.utc)
week_start = (now - timedelta(days=now.weekday())).strftime(”%Y-%m-%d”)
load_resp  = supabase.table(“polar_exercises”)  
.select(“date,distance_meters,training_load,duration_seconds”)  
.gte(“date”, week_start).order(“date”).execute()
week_runs  = load_resp.data or []
goals_resp = supabase.table(“goals”)  
.select(“race_name,race_date,distance_km,target_time”)  
.eq(“active”, True).execute()
goals_text = “\n”.join([
f”- {g[‘race_name’]} on {g[‘race_date’]}: {g[‘distance_km’]}km target {g[‘target_time’]}”
for g in (goals_resp.data or [])
]) or “No active goals.”
dist_km    = round((run.get(“distance_meters”) or 0) / 1000, 2)
dur_s      = run.get(“duration_seconds”) or 0
dur_str    = f”{dur_s // 3600}h {(dur_s % 3600) // 60}m” if dur_s >= 3600 else f”{dur_s // 60}m {dur_s % 60}s”
pace_s     = (dur_s / dist_km) if dist_km > 0 else 0
splits_text = “”
if splits:
lines = [
f”  km {s[‘km_number’]}: {s.get(‘pace_display’,’?’)} | “
f”HR {s.get(‘hr_avg’,’?’)}/{s.get(‘hr_max’,’?’)} | “
f”Power {s.get(‘power_avg’,’?’)}W | Cad {s.get(‘cadence_avg’,’?’)}spm”
for s in splits[:20]
]
splits_text = “KM SPLITS:\n” + “\n”.join(lines)
weekly_km   = sum((r.get(“distance_meters”) or 0) for r in week_runs) / 1000
weekly_load = sum((r.get(“training_load”) or 0) for r in week_runs)
sleep_text  = “\n”.join([
f”  - {s[‘date’]}: {round((s.get(‘total_sleep_seconds’) or 0)/3600,1)}h, “
f”score {s.get(‘sleep_score’,’?’)}, deep {(s.get(‘deep_sleep_seconds’) or 0)//60}min”
for s in sleep_rows
]) or “No recent sleep data.”
hrv_text    = (
f”Recharge: {hrv.get(‘recharge_status’,’?’)}, ANS {hrv.get(‘ans_charge’,’?’)}, HRV {hrv.get(‘hrv_avg’,’?’)}”
) if hrv else “No HRV data.”
cl_text     = (
f”Cardio load: {cl.get(‘cardio_load_status’,’?’)} | “
f”Strain {cl.get(‘strain’,’?’)} / Tolerance {cl.get(‘tolerance’,’?’)} | “
f”Ratio {cl.get(‘cardio_load_ratio’,’?’)}”
) if cl else “No cardio load data.”
prompt = f””“You are an elite running coach. Luke just finished a run. Write a focused post-run debrief in exactly 3 short paragraphs (max 280 tokens). Reference his actual numbers.

ATHLETE: Luke Worgan, 36yo, 167cm, 78kg, VO2max 55, max HR 198, aerobic threshold 149bpm, anaerobic threshold 178bpm
LONDON MARATHON: {days_to_marathon()} days away — target sub 3:30 (4:58/km)
GOALS:\n{goals_text}

TODAY’S RUN:

- Distance: {dist_km}km | Duration: {dur_str} | Avg pace: {seconds_to_pace(pace_s)}
- Avg HR: {run.get(‘avg_heart_rate’,’?’)}bpm | Max HR: {run.get(‘max_heart_rate’,’?’)}bpm
- Avg power: {run.get(‘avg_power’,’?’)}W | Cadence: {run.get(‘avg_cadence’,’?’)}spm
- Training load: {run.get(‘training_load’,’?’)} | Ascent: {run.get(‘ascent’,’?’)}m
  {splits_text}

RECOVERY CONTEXT:
{sleep_text}
{hrv_text}
{cl_text}

WEEK SO FAR: {round(weekly_km,1)}km | load {round(weekly_load,0)} across {len(week_runs)} sessions

Paragraph 1: Quality of this run — effort appropriateness, HR vs pace vs zones, pacing from splits.
Paragraph 2: One specific strength and one thing to work on.
Paragraph 3: Rest of today — specific nutrition, recovery and movement advice given cardio load ratio and recent recovery data.

End with:
NOTE: post-run debrief | <10-word summary>”””
response = claude.messages.create(
model=“claude-sonnet-4-20250514”, max_tokens=400,
messages=[{“role”: “user”, “content”: prompt}]
)
reply  = extract_and_save_note(response.content[0].text, “post-run debrief”)
header = f”🏃 *Post-run debrief* — {dist_km}km in {dur_str} @ {seconds_to_pace(pace_s)}\n\n”
msg    = header + reply
if len(msg) > 4000: msg = msg[:4000]
bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode=“Markdown”)
except Exception as e:
log.error(f”Post-run debrief error {exercise_id}: {e}”)

# ══════════════════════════════════════════════════════════════════════════

# EVENING DEBRIEF

# ══════════════════════════════════════════════════════════════════════════

def send_evening_debrief():
try:
today_str  = datetime.now(timezone.utc).strftime(”%Y-%m-%d”)
now        = datetime.now(timezone.utc)
week_start = (now - timedelta(days=now.weekday())).strftime(”%Y-%m-%d”)
activity_resp = supabase.table(“polar_daily_activity”)  
.select(“date,steps,active_calories,active_time_seconds”)  
.eq(“date”, today_str).execute()
activity     = activity_resp.data[0] if activity_resp.data else None
data_present = activity is not None
runs_resp    = supabase.table(“polar_exercises”)  
.select(“polar_exercise_id,distance_meters,duration_seconds,avg_heart_rate,training_load,sport”)  
.like(“date”, f”{today_str}%”).execute()
runs_today   = runs_resp.data or []
week_resp    = supabase.table(“polar_exercises”)  
.select(“date,distance_meters,training_load,duration_seconds”)  
.gte(“date”, week_start).execute()
week_runs    = week_resp.data or []
weekly_km    = sum((r.get(“distance_meters”) or 0) for r in week_runs) / 1000
weekly_load  = sum((r.get(“training_load”) or 0) for r in week_runs)
cl_resp      = supabase.table(“polar_cardio_load”)  
.select(“date,cardio_load_status,cardio_load_ratio,strain,tolerance”)  
.order(“date”, desc=True).limit(1).execute()
cl           = cl_resp.data[0] if cl_resp.data else {}
sw_resp      = supabase.table(“polar_sleepwise”)  
.select(“date,grade,grade_classification,circadian_bedtime_start,circadian_bedtime_end”)  
.order(“date”, desc=True).limit(1).execute()
sw           = sw_resp.data[0] if sw_resp.data else {}
goals_resp   = supabase.table(“goals”)  
.select(“race_name,race_date,distance_km,target_time”)  
.eq(“active”, True).execute()
goals_text   = “\n”.join([
f”- {g[‘race_name’]} on {g[‘race_date’]}: target {g[‘target_time’]}”
for g in (goals_resp.data or [])
]) or “No active goals.”
checkin_resp  = supabase.table(“wellness_checkins”)  
.select(“date,fatigue_score,sleep_score,mood_score,notes”)  
.order(“date”, desc=True).limit(1).execute()
last_checkin  = checkin_resp.data[0] if checkin_resp.data else None
checkin_today = last_checkin and last_checkin.get(“date”) == today_str
cl_text = (
f”Cardio load: {cl.get(‘cardio_load_status’,’?’)} | “
f”Strain {cl.get(‘strain’,’?’)} / Tolerance {cl.get(‘tolerance’,’?’)} | “
f”Ratio {cl.get(‘cardio_load_ratio’,’?’)}”
) if cl else “”
sw_text = “”
if sw:
gc      = (sw.get(“grade_classification”) or “”).replace(“GRADE_CLASSIFICATION_”, “”).replace(”_”, “ “).title()
bed_str = f”Optimal bedtime: {sw.get(‘circadian_bedtime_start’,’?’)}–{sw.get(‘circadian_bedtime_end’,’?’)}”   
if sw.get(“circadian_bedtime_start”) else “”
sw_text = f”SleepWise grade: {sw.get(‘grade’,’?’)} ({gc}) | {bed_str}”
if data_present:
steps       = activity.get(“steps”, “?”)
active_min  = round((activity.get(“active_time_seconds”) or 0) / 60)
run_summary = “No runs recorded today.”
if runs_today:
run_lines = []
for r in runs_today:
d       = round((r.get(“distance_meters”) or 0) / 1000, 2)
dur     = r.get(“duration_seconds”) or 0
dur_str = f”{dur // 60}m {dur % 60}s”
run_lines.append(
f”  - {sport_emoji(r.get(‘sport’,’’))} {d}km in {dur_str} | “
f”avg HR {r.get(‘avg_heart_rate’,’?’)} | load {r.get(‘training_load’,’?’)}”
)
run_summary = “Runs today:\n” + “\n”.join(run_lines)
checkin_nudge   = “” if checkin_today else   
“\nNudge Luke to log a wellness check-in: fatigue, sleep quality, mood out of 10.”
checkin_context = “”
if last_checkin:
checkin_context = (
f”\nLast wellness check-in ({last_checkin[‘date’]}): “
f”fatigue {last_checkin.get(‘fatigue_score’,’?’)}/10, “
f”mood {last_checkin.get(‘mood_score’,’?’)}/10”
)
prompt = f””“You are an elite running coach. End-of-day debrief for Luke. 3 short direct paragraphs (max 280 tokens).

ATHLETE: Luke Worgan, VO2max 55, max HR 198, aerobic threshold 149bpm
LONDON MARATHON: {days_to_marathon()} days away — target sub 3:30
GOALS:\n{goals_text}

TODAY:

- Steps: {steps} | Active time: {active_min}min
  {run_summary}
  {cl_text}
  {sw_text}

WEEK SO FAR: {round(weekly_km,1)}km | load {round(weekly_load,0)} | {len(week_runs)} sessions
{checkin_context}

Paragraph 1: How today landed — training stress vs recovery balance, cardio load ratio context.
Paragraph 2: One green flag and one watch point heading into tomorrow.
Paragraph 3: Tonight — specific sleep timing recommendation using SleepWise circadian bedtime window if available.
{checkin_nudge}

End with:
NOTE: evening debrief | <10-word summary>”””
else:
prompt = f””“You are an elite running coach. Evening — today’s Polar data hasn’t fully synced.

WEEK SO FAR: {round(weekly_km,1)}km across {len(week_runs)} runs
LONDON MARATHON: {days_to_marathon()} days away
{cl_text}
{sw_text}

2 short paragraphs (max 150 tokens):

- Acknowledge data still syncing, give one useful evening tip for marathon prep at this stage
- Sleep timing recommendation using circadian bedtime window if available

Nudge Luke to log a wellness check-in: fatigue, sleep quality, mood out of 10.

End with:
NOTE: evening debrief | data pending”””
response = claude.messages.create(
model=“claude-sonnet-4-20250514”, max_tokens=400,
messages=[{“role”: “user”, “content”: prompt}]
)
reply  = extract_and_save_note(response.content[0].text, “evening debrief”)
icon   = “📊” if data_present else “⏳”
header = f”{icon} *Evening Debrief — {datetime.now(timezone.utc).strftime(’%-d %b’)}*\n\n”
msg    = header + reply
if len(msg) > 4000: msg = msg[:4000]
bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode=“Markdown”)
except Exception as e:
log.error(f”Evening debrief error: {e}”)

# ══════════════════════════════════════════════════════════════════════════

# BACKGROUND LOOPS

# ══════════════════════════════════════════════════════════════════════════

def polar_sync_loop():
while True:
try:
new = sync_new_polar_exercises()
for ex in new:
msg = format_new_run_notification(ex[“data”], ex[“id”], ex[“splits”])
bot.send_message(YOUR_TELEGRAM_ID, msg, parse_mode=“Markdown”)
threading.Thread(
target=send_post_run_debrief, args=(ex[“id”],), daemon=True
).start()
sleep_n     = sync_sleep()
recharge_n  = sync_nightly_recharge()
activity_n  = sync_daily_activity()
hr_n        = sync_continuous_hr()
load_n      = sync_cardio_load()
sleepwise_n = sync_sleepwise()
if any([sleep_n, recharge_n, activity_n, hr_n, load_n, sleepwise_n]):
log.info(
f”Passive sync: sleep={sleep_n} recharge={recharge_n} “
f”activity={activity_n} hr={hr_n} load={load_n} sleepwise={sleepwise_n}”
)
except Exception as e:
log.error(f”Sync loop error: {e}”)
time.sleep(300)

def scheduler_loop():
while True:
now     = datetime.now(timezone.utc)
targets = [
now.replace(hour=7,  minute=0,  second=0, microsecond=0),
now.replace(hour=20, minute=30, second=0, microsecond=0),
now.replace(hour=0,  minute=5,  second=0, microsecond=0),
]
targets     = [t + timedelta(days=1) if now >= t else t for t in targets]
next_target = min(targets)
sleep_secs  = (next_target - now).total_seconds()
log.info(f”Scheduler: next at {next_target.strftime(’%H:%M UTC’)} in {sleep_secs/60:.1f}min”)
time.sleep(sleep_secs)
fire_time = datetime.now(timezone.utc)
if fire_time.hour == 7 and fire_time.minute < 5:
send_morning_briefing()
elif fire_time.hour == 20 and fire_time.minute >= 30 and fire_time.minute < 35:
send_evening_debrief()
elif fire_time.hour == 0 and fire_time.minute < 10:
debriefed_today.clear()
alerts_fired_today.clear()
log.info(“Cleared debriefed_today and alerts_fired_today for new day”)

# ══════════════════════════════════════════════════════════════════════════

# TELEGRAM HANDLERS

# ══════════════════════════════════════════════════════════════════════════

@bot.message_handler(func=lambda m: True)
def handle_message(message):
chat_id   = message.chat.id
if chat_id != YOUR_TELEGRAM_ID:
bot.reply_to(message, “Unauthorised.”)
return
user_text = message.text.strip()
lower     = user_text.lower()

```
if lower in ["/start", "/help"]:
    bot.reply_to(message, (
        "👋 *Hey Luke!* Your Polar super coach is live.\n\n"
        "*Commands:*\n"
        "/status — readiness score + today's session\n"
        "/sync — sync all Polar data\n"
        "/briefing — morning briefing now\n"
        "/evening — evening debrief now\n"
        "/runs — last 10 runs _(or /runs 30)_\n"
        "/splits — km splits for last run\n"
        "/recovery — sleep & HRV dashboard\n"
        "/load — weekly training load\n"
        "/cardio — cardio load trend\n"
        "/sleepwise — SleepWise alertness\n"
        "/hr — continuous HR dashboard\n"
        "/goals — target races\n"
        "/push — check & send any pending alerts\n"
        "/clear — clear conversation\n\n"
        "*Log data:*\n"
        "`save run: <paste Polar stats>`\n"
        "`goal: London Marathon, 27 Apr 2026, 42.2km, sub 3:30`\n"
        "`checkin: weight 77.5kg, fatigue 6/10, sleep 7/10, mood 8/10`\n\n"
        "Or just ask me anything 💬"
    ), parse_mode="Markdown")
    return

# NEW: /status — readiness dashboard
if lower == "/status":
    try:
        bot.send_chat_action(chat_id, "typing")
        bot.reply_to(message, format_status_dashboard(), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

# NEW: /push — manual alert check
if lower == "/push":
    try:
        bot.reply_to(message, "🔍 Checking for alerts...")
        n = check_and_push_alerts()
        if n == 0:
            bot.send_message(chat_id, "✅ No alerts to fire right now — all signals within normal range.")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
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
            bot.send_message(chat_id,
                format_new_run_notification(ex["data"], ex["id"], ex["splits"]),
                parse_mode="Markdown")
            threading.Thread(
                target=send_post_run_debrief, args=(ex["id"],), daemon=True
            ).start()
    else:
        bot.send_message(chat_id, "No new exercises found.")
    parts = []
    if sleep_n:     parts.append(f"😴 {sleep_n} sleep nights")
    if recharge_n:  parts.append(f"⚡ {recharge_n} recharge nights")
    if activity_n:  parts.append(f"👟 {activity_n} activity days")
    if hr_n:        parts.append(f"❤️ {hr_n} HR days")
    if load_n:      parts.append(f"🔥 {load_n} load days")
    if sleepwise_n: parts.append(f"🧠 {sleepwise_n} SleepWise days")
    if parts:
        bot.send_message(chat_id, "✅ Synced: " + "  •  ".join(parts))
    return

if lower == "/briefing":
    bot.reply_to(message, "⏳ Generating briefing...")
    send_morning_briefing()
    return

if lower == "/evening":
    bot.reply_to(message, "⏳ Generating evening debrief...")
    send_evening_debrief()
    return

if lower == "/splits":
    try:
        ex = get_latest_run_with_splits()
        if not ex:
            bot.reply_to(message, "No runs with splits found.")
            return
        splits = supabase.table("polar_km_splits")\
            .select("km_number,pace_display,hr_avg,hr_max,power_avg,cadence_avg")\
            .eq("exercise_id", ex["polar_exercise_id"]).order("lap_number").execute()
        dist_km = (ex.get("distance_meters") or 0) / 1000
        header  = f"{fmt_date(ex['date'])} — {dist_km:.1f}km {ex.get('sport','')}"
        bot.reply_to(message, format_splits_table(splits.data, header), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

if lower.startswith("/runs"):
    try:
        parts = user_text.split()
        limit = int(parts[1]) if len(parts) > 1 else 10
        limit = min(limit, 100)
        runs  = supabase.table("polar_exercises")\
            .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,"
                    "max_heart_rate,avg_power,avg_cadence,training_load,source")\
            .order("date", desc=True).limit(limit).execute()
        bot.reply_to(message, format_run_list(runs.data), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

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

if lower == "/cardio":
    try:
        cl = supabase.table("polar_cardio_load")\
            .select("date,cardio_load,cardio_load_status,cardio_load_ratio,strain,tolerance")\
            .order("date", desc=True).limit(14).execute()
        bot.reply_to(message, format_cardio_load_dashboard(cl.data), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

if lower == "/sleepwise":
    try:
        sw = supabase.table("polar_sleepwise")\
            .select("date,grade,grade_classification,sleep_inertia,circadian_bedtime_start,circadian_bedtime_end")\
            .order("date", desc=True).limit(7).execute()
        bot.reply_to(message, format_sleepwise_dashboard(sw.data), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

if lower == "/hr":
    try:
        hr = supabase.table("polar_continuous_hr")\
            .select("date,avg_hr,min_hr,max_hr")\
            .order("date", desc=True).limit(7).execute()
        bot.reply_to(message, format_hr_dashboard(hr.data), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

if lower == "/goals":
    try:
        goals = supabase.table("goals")\
            .select("race_name,race_date,distance_km,target_time,priority,notes")\
            .eq("active", True).order("race_date").execute()
        bot.reply_to(message, format_goals(goals.data), parse_mode="Markdown")
    except Exception as e:
        bot.reply_to(message, f"Error: {e}")
    return

if lower == "/clear":
    conversation_history[chat_id] = []
    bot.reply_to(message, "Conversation cleared.")
    return

if re.match(r"^(goal|race|target)\s*[:：]", lower):
    bot.reply_to(message, save_goal(user_text), parse_mode="Markdown")
    return

if re.match(r"^(save\s+run|log\s+run|manual\s+run|run\s+log)\s*[:：]", lower):
    bot.reply_to(message, save_manual_run(user_text), parse_mode="Markdown")
    return

if re.match(r"^(check.?in|checkin|wellness)\s*[:：]", lower):
    bot.reply_to(message, save_wellness_checkin(user_text), parse_mode="Markdown")
    return

run_limit  = detect_history_request(user_text) or 10
sleep_days = detect_recovery_window(user_text)

run_list_keywords = ["show", "list", "display", "give me", "last", "all my"]
is_run_list_req   = any(kw in lower for kw in run_list_keywords) and \
                    ("run" in lower or "session" in lower) and run_limit > 10
if is_run_list_req:
    try:
        runs = supabase.table("polar_exercises")\
            .select("date,sport,distance_meters,duration_seconds,avg_heart_rate,"
                    "max_heart_rate,avg_power,avg_cadence,training_load,source")\
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

try:
    bot.send_chat_action(chat_id, "typing")
    add_to_history(chat_id, "user", user_text)
    response = claude.messages.create(
        model="claude-sonnet-4-20250514",
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
```

# ══════════════════════════════════════════════════════════════════════════

# MAIN

# ══════════════════════════════════════════════════════════════════════════

if **name** == “**main**”:
log.info(“🏃 Polar Super Coach Bot v8.0 starting…”)
log.info(f”Supabase: {SUPABASE_URL}”)
log.info(f”Polar User: {POLAR_USER_ID}”)
threading.Thread(target=polar_sync_loop, daemon=True).start()
threading.Thread(target=scheduler_loop, daemon=True).start()
bot.infinity_polling(interval=1, timeout=30)