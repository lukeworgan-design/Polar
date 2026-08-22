import { existsSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { getTodaysEvents, getUpcomingEvents, CalendarEvent } from './calendar';
import { getWeatherForecast, DayForecast } from './weather';
import { getMealPlan, getLastBabyLog, getUpcomingBirthdays, getShoppingList } from './db';
import { getFridayBinType } from './scheduler';
import { getLocalEventsTicker } from './ai';
import { getDetailedWeather, weatherEmojiForCode, DetailedWeather } from './weather';

// Background photos — a slideshow if more than one is supplied. Two ways:
//   1. Commit images to  assets/dashboard-bg.(jpg|…)  and/or
//      assets/dashboard-bg-1.jpg, dashboard-bg-2.jpg …  — served at /dashboard-bg/N
//   2. Set DASHBOARD_BG_URL to one URL, or several comma-separated URLs.
const BG_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** Ordered list of local background image file paths (dashboard-bg + dashboard-bg-N). */
export function localBgFiles(): string[] {
  const files: string[] = [];
  for (const ext of BG_EXTENSIONS) {
    const base = join(process.cwd(), 'assets', `dashboard-bg.${ext}`);
    if (existsSync(base)) files.push(base);
  }
  for (let n = 1; n <= 12; n++) {
    for (const ext of BG_EXTENSIONS) {
      const p = join(process.cwd(), 'assets', `dashboard-bg-${n}.${ext}`);
      if (existsSync(p)) files.push(p);
    }
  }
  return files;
}

/** Back-compat: first local background file, if any. */
export function localBgFile(): string | null {
  return localBgFiles()[0] ?? null;
}

function backgroundUrls(): string[] {
  if (config.dashboardBgUrl) {
    return config.dashboardBgUrl.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return localBgFiles().map((_, i) => `/dashboard-bg/${i}`);
}

// ── Per-TV options (from URL query) ─────────────────────────────────────────────
// Each TV can tailor its own view via query params, e.g.
//   ?token=…&baby=off      → hide Evie's panel entirely (e.g. living-room TV)
//   ?token=…&baby=age      → show only her age, not feed/nappy details
//   ?token=…&photo=off     → force the plain gradient background
export interface DashboardOptions {
  baby: 'full' | 'age' | 'off';
  photo: boolean;
}

export function parseOptions(params: URLSearchParams): DashboardOptions {
  const baby = params.get('baby');
  return {
    baby: baby === 'off' ? 'off' : baby === 'age' ? 'age' : 'full',
    photo: params.get('photo') !== 'off',
  };
}

// ── Data gathering ──────────────────────────────────────────────────────────────

interface DashEvent {
  summary: string;
  when: string;
  location: string | null;
  allDay: boolean;
}

interface Countdown {
  name: string;
  detail: string;
}

interface DashboardData {
  headerDate: string;
  today: DashEvent[];
  upcoming: DashEvent[];
  weather: DetailedWeather;
  meals: { tonight: string | null; upcoming: Array<{ day: string; meal: string }> };
  bin: { label: string; colorHex: string } | null;
  schoolRun: string | null;
  countdowns: Countdown[];
  baby: { name: string; ageText: string; fact: string | null } | null;
  shopping: string[];
  ticker: string[];
  night: boolean;
  generatedAt: string;
}

function tzDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d);
}

function tzHour(d: Date): number {
  return parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: config.timezone }).format(d), 10);
}

function tzWeekday(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: config.timezone }).format(d);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone,
  });
}

function fmtDay(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone,
  });
}

function toDashEvent(e: CalendarEvent, withDay: boolean): DashEvent {
  const allDay = e.start.length === 10;
  let when: string;
  if (allDay) {
    when = withDay ? fmtDay(e.start) : 'All day';
  } else {
    when = withDay ? `${fmtDay(e.start)} · ${fmtTime(e.start)}` : fmtTime(e.start);
  }
  return { summary: e.summary, when, location: e.location ?? null, allDay };
}

function weatherEmoji(desc: string): string {
  const d = desc.toLowerCase();
  if (d.includes('thunder')) return '⛈';
  if (d.includes('snow')) return '❄️';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) return '🌧';
  if (d.includes('fog')) return '🌫';
  if (d.includes('overcast')) return '☁️';
  if (d.includes('cloud')) return '⛅';
  if (d.includes('clear')) return '☀️';
  return '🌤';
}

function fmtWeather(day: DayForecast): string {
  const rain = day.precipitationMm > 0 ? ` · ${day.precipitationMm}mm` : '';
  return `${weatherEmoji(day.description)} ${day.description}, ${Math.round(day.minTemp)}–${Math.round(day.maxTemp)}°C${rain}`;
}

function babyAgeText(dob: string): string {
  const born = new Date(`${dob}T12:00:00`);
  const days = Math.max(0, Math.floor((Date.now() - born.getTime()) / (1000 * 60 * 60 * 24)));
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  const weeks = Math.floor(days / 7);
  const remDays = days % 7;
  return `${weeks} week${weeks === 1 ? '' : 's'}${remDays ? ` ${remDays}d` : ''} old`;
}

// Baby developmental facts, each unlocked from a given age (days). We show one
// age-appropriate fact per day, rotating so it feels fresh.
const BABY_FACTS: Array<{ from: number; text: string }> = [
  { from: 0, text: 'sees best about 20–30cm away — just right for gazing at your face.' },
  { from: 0, text: 'already knows your voice and your smell.' },
  { from: 1, text: 'has a strong grasp reflex — she\'ll curl her fingers around yours.' },
  { from: 2, text: 'communicates entirely through crying for now — hungry, tired, or wanting a cuddle.' },
  { from: 3, text: 'loves being held skin-to-skin — it steadies her heartbeat and temperature.' },
  { from: 5, text: 'sleeps 14–17 hours a day, in short bursts around the clock.' },
  { from: 7, text: 'prefers looking at high-contrast patterns and faces.' },
  { from: 9, text: 'is having short, more alert windows between sleeps now.' },
  { from: 12, text: 'is likely back to her birth weight around this point.' },
  { from: 14, text: 'may briefly hold your gaze — early eye contact.' },
  { from: 18, text: 'can be soothed by gentle rocking, white noise and swaddling.' },
  { from: 21, text: 'is starting to track slow-moving objects with her eyes.' },
  { from: 28, text: 'might start making little cooing and gurgling sounds soon.' },
  { from: 35, text: 'is becoming more expressive — watch for those first almost-smiles.' },
  { from: 42, text: 'may give her first real social smile around now — 6 weeks!' },
  { from: 49, text: 'is holding her head up a little during tummy time.' },
  { from: 56, text: 'follows objects and faces further across the room now.' },
  { from: 70, text: 'is discovering her hands and might start batting at toys.' },
  { from: 84, text: 'often laughs and coos back in little "conversations".' },
  { from: 112, text: 'may be rolling from tummy to back around this stage.' },
  { from: 140, text: 'is grabbing everything — and it\'s all heading for her mouth!' },
  { from: 168, text: 'might be ready to start sitting with support soon.' },
];

function babyFactFor(ageDays: number, dayIndex: number): string | null {
  const eligible = BABY_FACTS.filter((f) => f.from <= ageDays);
  if (eligible.length === 0) return null;
  // Prefer facts near her current age, rotating daily.
  const recent = eligible.slice(-6);
  return recent[dayIndex % recent.length]!.text;
}

function sinceText(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isStale(iso: string, maxHours: number): boolean {
  return (Date.now() - new Date(iso).getTime()) / 3600000 > maxHours;
}

// School-run rota (mirrors Rose's system prompt). Suppressed during school holidays.
const SCHOOL_RUN: Record<string, string> = {
  Monday: 'Luke: drop-off + after-school pick-up',
  Tuesday: 'Grandma has both — sorted',
  Wednesday: 'Breakfast club drop, Granddad picks up',
  Thursday: 'Luke drops, Toni picks up',
  Friday: 'Toni has both — sorted',
};

const HOLIDAY_KEYWORDS = ['holiday', 'half term', 'inset', 'teacher training', 'training day', 'school closed'];

function isSchoolHoliday(todayStr: string, todayEvents: CalendarEvent[]): boolean {
  const calRanges = todayEvents
    .filter((e) => HOLIDAY_KEYWORDS.some((k) => e.summary.toLowerCase().includes(k)))
    .map((e) => ({ start: e.start.slice(0, 10), end: e.end.slice(0, 10) }));
  const ranges = [...calRanges, ...config.family.schoolHolidays];
  return ranges.some((r) => (todayStr >= r.start && todayStr < r.end) || todayStr === r.start);
}

export async function getDashboardData(): Promise<DashboardData> {
  const now = new Date();
  const headerDate = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
  });
  const todayStr = tzDateStr(now);
  const hour = tzHour(now);
  const night = hour >= 20 || hour < 6;

  let today: DashEvent[] = [];
  let upcoming: DashEvent[] = [];
  let todayEvents: CalendarEvent[] = [];
  try {
    const [te, upcomingEvents] = await Promise.all([
      getTodaysEvents(),
      getUpcomingEvents(21), // three-week look-ahead
    ]);
    todayEvents = te;
    const todayIds = new Set(te.map((e) => e.id));
    today = te.map((e) => toDashEvent(e, false));
    upcoming = upcomingEvents
      .filter((e) => !todayIds.has(e.id))
      .filter((e) => (e.start.length === 10 ? e.start : e.start.slice(0, 10)) > todayStr)
      .slice(0, 16)
      .map((e) => toDashEvent(e, true));
  } catch (err) {
    console.error('Dashboard: calendar fetch failed:', err);
  }

  let weather: DetailedWeather = { current: null, hourly: [], sunrise: null, sunset: null, uvMax: null, pollen: null };
  try {
    weather = await getDetailedWeather();
  } catch (err) {
    console.error('Dashboard: weather fetch failed:', err);
  }

  let meals: { tonight: string | null; upcoming: Array<{ day: string; meal: string }> } = { tonight: null, upcoming: [] };
  try {
    const end = new Date(now);
    end.setDate(now.getDate() + 6);
    const plan = await getMealPlan(todayStr, tzDateStr(end));
    // Normalise the stored date to YYYY-MM-DD in case it comes back as a timestamp.
    const dinners = plan
      .filter((m) => m.meal_type === 'dinner')
      .map((m) => ({ date: String(m.date).slice(0, 10), meal: m.meal }));
    meals.tonight = dinners.find((m) => m.date === todayStr)?.meal ?? null;
    meals.upcoming = dinners
      .filter((m) => m.date > todayStr)
      .slice(0, 5)
      .map((m) => ({ day: fmtDay(m.date), meal: m.meal }));
  } catch (err) {
    console.error('Dashboard: meal fetch failed:', err);
  }

  let bin: { label: string; colorHex: string } | null = null;
  try {
    const type = getFridayBinType();
    bin = type === 'general'
      ? { label: 'Green — general waste', colorHex: '#2ec26a' }
      : { label: 'Blue — recycling', colorHex: '#3aa0ff' };
  } catch (err) {
    console.error('Dashboard: bin calc failed:', err);
  }

  // School run today (weekday and not a holiday)
  let schoolRun: string | null = null;
  const weekday = tzWeekday(now);
  if (SCHOOL_RUN[weekday] && !isSchoolHoliday(todayStr, todayEvents)) {
    schoolRun = SCHOOL_RUN[weekday]!;
  }

  // Countdowns: upcoming birthdays in the next 30 days
  let countdowns: Countdown[] = [];
  try {
    const bdays = await getUpcomingBirthdays(30);
    countdowns = bdays.slice(0, 4).map((b) => ({
      name: `${b.name}${b.relation ? ` (${b.relation})` : ''}`,
      detail: b.days_until === 0 ? 'Today! 🎂' : b.days_until === 1 ? 'Tomorrow 🎂' : `in ${b.days_until} days`,
    }));
  } catch (err) {
    console.error('Dashboard: birthdays fetch failed:', err);
  }

  let baby: DashboardData['baby'] = null;
  const dob = config.family.babyBorn;
  if (dob) {
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(`${dob}T12:00:00`).getTime()) / 86400000));
    const dayIndex = Math.floor(Date.now() / 86400000); // changes once per day
    baby = {
      name: config.family.babyName || 'Baby',
      ageText: babyAgeText(dob),
      fact: babyFactFor(ageDays, dayIndex),
    };
  }

  let shopping: string[] = [];
  try {
    shopping = (await getShoppingList()).map((i) => i.item);
  } catch (err) {
    console.error('Dashboard: shopping fetch failed:', err);
  }

  return {
    headerDate, today, upcoming, weather, meals, bin, schoolRun, countdowns, baby, shopping,
    ticker: getLocalEventsTicker(),
    night,
    generatedAt: fmtTime(now.toISOString()),
  };
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function eventRow(e: DashEvent): string {
  return `<li><span class="ev-when">${esc(e.when)}</span><span class="ev-name">${esc(e.summary)}${
    e.location ? `<span class="ev-loc">📍 ${esc(e.location)}</span>` : ''
  }</span></li>`;
}

/** How often the TV reloads the page (seconds). */
const REFRESH_SECONDS = 90;

export function renderDashboardPage(d: DashboardData, opts: DashboardOptions): string {
  const todayList = d.today.length
    ? `<ul class="events">${d.today.map(eventRow).join('')}</ul>`
    : `<p class="empty">Nothing in the diary today 🎉</p>`;

  const upcomingList = d.upcoming.length
    ? `<ul class="events autoscroll">${d.upcoming.map(eventRow).join('')}</ul>`
    : `<p class="empty">Clear for the next couple of weeks</p>`;

  const SHOP_MAX = 15;
  const shopShown = d.shopping.slice(0, SHOP_MAX);
  const shopMore = d.shopping.length - shopShown.length;
  const shoppingCard = `<div class="card shop-card">
      <h2>🛒 Shopping${d.shopping.length ? ` (${d.shopping.length})` : ''}</h2>
      ${d.shopping.length
        ? `<ul class="shop-list">${shopShown.map((i) => `<li>${esc(i)}</li>`).join('')}${shopMore > 0 ? `<li class="more">+${shopMore} more…</li>` : ''}</ul>`
        : `<p class="empty">All caught up — nothing on the list 🎉</p>`}
    </div>`;

  const w = d.weather;
  const hourlyStrip = w.hourly.length
    ? `<div class="hours">${w.hourly.map((h) => `
        <div class="hr">
          <span class="hr-t">${esc(h.hour)}</span>
          <span class="hr-e">${weatherEmojiForCode(h.code)}</span>
          <span class="hr-d">${h.temp}°</span>
          <span class="hr-r">${h.precipProb >= 10 ? `💧${h.precipProb}%` : ''}</span>
        </div>`).join('')}</div>`
    : '';
  const uvBadge = w.uvMax != null ? `☀️ UV ${w.uvMax}` : '';
  const pollenBadge = w.pollen ? `🌾 ${esc(w.pollen.type)} ${esc(w.pollen.level.toLowerCase())}` : '';
  const sunBadge = (w.sunrise && w.sunset) ? `🌅 ${esc(w.sunrise)} · 🌇 ${esc(w.sunset)}` : '';
  const weatherFooter = [uvBadge, pollenBadge, sunBadge].filter(Boolean).join('  ·  ');
  const weatherCard = w.current
    ? `<div class="card">
         <h2>Weather</h2>
         <p class="big">${weatherEmojiForCode(w.current.code)} ${esc(w.current.description)}, ${w.current.temp}°C</p>
         ${hourlyStrip}
         ${weatherFooter ? `<p class="wfoot">${weatherFooter}</p>` : ''}
       </div>` : '';

  const schoolRunCard = d.schoolRun
    ? `<div class="card"><h2>School run today</h2><p class="big">🚌 ${esc(d.schoolRun)}</p></div>`
    : '';

  const mealsCard = (d.meals.tonight || d.meals.upcoming.length)
    ? `<div class="card">
         <h2>Meals</h2>
         <p class="big">🍽 Tonight: ${d.meals.tonight ? esc(d.meals.tonight) : 'not set yet'}</p>
         ${d.meals.upcoming.length
           ? `<ul class="meals">${d.meals.upcoming.map((m) => `<li><span class="d">${esc(m.day)}</span><span class="m">${esc(m.meal)}</span></li>`).join('')}</ul>`
           : ''}
       </div>`
    : '';

  const binCard = d.bin
    ? `<div class="card"><h2>Next bin (Friday)</h2><p class="big"><span class="dot" style="background:${d.bin.colorHex}"></span>${esc(d.bin.label)}</p></div>`
    : '';

  const countdownCard = d.countdowns.length
    ? `<div class="card"><h2>Coming birthdays</h2><ul class="mini">${
        d.countdowns.map((c) => `<li><span>${esc(c.name)}</span><span class="cd">${esc(c.detail)}</span></li>`).join('')
      }</ul></div>`
    : '';

  let babyCard = '';
  if (d.baby && opts.baby !== 'off') {
    const details = (opts.baby === 'full' && d.baby.fact)
      ? `<p class="sub">💡 Today ${esc(d.baby.name)} ${esc(d.baby.fact)}</p>`
      : '';
    babyCard = `<div class="card"><h2>${esc(d.baby.name)}</h2><p class="big">👶 ${esc(d.baby.ageText)}</p>${details}</div>`;
  }

  const sideCards = [weatherCard, mealsCard, schoolRunCard, binCard, countdownCard, babyCard]
    .filter(Boolean).join('\n');

  const bgs = opts.photo ? backgroundUrls() : [];
  const bgLayer = bgs.length
    ? `${bgs.map((u, i) => `<div class="bg${i === 0 ? ' active' : ''}"><div class="bg-blur" style="background-image:url('${esc(u)}')"></div><img class="bg-img" src="${esc(u)}" alt=""></div>`).join('')}<div class="bg-tint"></div>`
    : '';

  // Scrolling local-events ticker. Duration scales with content so it reads at a steady pace.
  const hasTicker = d.ticker.length > 0;
  const tickerItems = d.ticker
    .map((t) => {
      const dashIdx = t.indexOf('—');
      if (dashIdx > 0) {
        const tag = t.slice(0, dashIdx).trim();
        const rest = t.slice(dashIdx + 1).trim();
        return `<span class="ticker-item"><span class="ti-tag">${esc(tag)}</span>${esc(rest)}</span>`;
      }
      return `<span class="ticker-item">${esc(t)}</span>`;
    })
    .join('<span class="ticker-item">•</span>');
  const tickerSecs = Math.max(30, d.ticker.length * 9);
  const tickerBar = hasTicker
    ? `<div class="ticker"><div class="ticker-lead">📣 What's on near you</div><div class="ticker-track" style="animation-duration:${tickerSecs}s">${tickerItems}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Family Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0b1020; --panel: rgba(16,24,46,.26); --panel2: rgba(11,17,34,.18);
    --text: #eef2ff; --muted: #c8d1e8; --accent: #8fceff; --accent2: #ffd479;
    --stroke: rgba(255,255,255,.16); --dim: 1;
  }
  html, body { height: 100%; }
  body {
    background: radial-gradient(1400px 900px at 80% -10%, #1a2340 0%, var(--bg) 60%);
    color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 3.2vh 3vw; overflow: hidden; -webkit-font-smoothing: antialiased; position: relative;
    filter: brightness(var(--dim));
    text-shadow: 0 1px 4px rgba(0,0,0,.7);
  }
  /* Night dimming after 8pm */
  body[data-night="1"] {
    --bg: #05070f; --panel: rgba(12,17,32,.5); --panel2: rgba(9,13,26,.44);
    --text: #cdd6f0; --muted: #9aa5c6; --accent: #5b9fd6; --accent2: #d8b26a; --dim: .72;
  }
  .bg { position: fixed; inset: 0; z-index: -3; opacity: 0; transition: opacity 1.6s ease-in-out; }
  .bg.active { opacity: 1; }
  .bg-blur { position: absolute; inset: 0; background-size: cover; background-position: center;
    filter: blur(26px) brightness(.6); transform: scale(1.15); }
  .bg-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .bg-tint { position: fixed; inset: 0; z-index: -1;
    background: linear-gradient(180deg, rgba(6,9,20,.42), rgba(6,9,20,.6)); }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2.4vh; }
  header .title { font-size: 4.4vh; font-weight: 800; letter-spacing: .3px; line-height: 1.05; }
  header .date { font-size: 2.8vh; font-weight: 600; color: var(--muted); margin-top: .4vh; }
  header .clock { font-size: 6vh; font-weight: 800; color: var(--accent); font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 2.2vh 2vw; height: 84vh; }
  body.has-ticker .grid { height: 76vh; }
  .col { display: flex; flex-direction: column; gap: 2.2vh; min-height: 0; }
  .card { background: linear-gradient(180deg, var(--panel) 0%, var(--panel2) 100%);
    border: 1px solid var(--stroke); border-radius: 22px; padding: 2.4vh 1.7vw;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  .card h2 { font-size: 2.4vh; text-transform: uppercase; letter-spacing: 1.6px; color: var(--muted); margin-bottom: 1.3vh; }
  .big { font-size: 3.4vh; font-weight: 700; line-height: 1.25; }
  .dot { display: inline-block; width: 2.4vh; height: 2.4vh; border-radius: 50%; margin-right: 1vh;
    vertical-align: middle; box-shadow: 0 0 0 2px rgba(255,255,255,.15) inset; }
  .sub { font-size: 2.3vh; color: var(--muted); margin-top: .7vh; }
  .hours { display: flex; justify-content: space-between; gap: .4vw; margin-top: 1vh; }
  .hr { display: flex; flex-direction: column; align-items: center; gap: .2vh; flex: 1; }
  .hr-t { font-size: 1.5vh; color: var(--muted); font-variant-numeric: tabular-nums; }
  .hr-e { font-size: 2.1vh; }
  .hr-d { font-size: 1.8vh; font-weight: 700; }
  .hr-r { font-size: 1.3vh; color: var(--accent); min-height: 1.3vh; }
  .wfoot { font-size: 1.7vh; color: var(--muted); margin-top: 1vh; }
  /* Compact the right-hand column so all cards fit without clipping */
  .col.side { gap: 1.5vh; }
  .side .card { padding: 1.7vh 1.4vw; }
  .side .card h2 { margin-bottom: .8vh; }
  .side .big { font-size: 3vh; }
  .side .sub { font-size: 2vh; margin-top: .5vh; }
  .events { list-style: none; display: flex; flex-direction: column; gap: 1.3vh; overflow: hidden; }
  .events li { display: flex; align-items: baseline; gap: 1.2vw; }
  .ev-when { flex: 0 0 auto; min-width: 13vw; color: var(--accent2); font-weight: 700; font-size: 2.7vh; font-variant-numeric: tabular-nums; }
  .ev-name { font-size: 2.9vh; font-weight: 600; display: flex; flex-direction: column; }
  .ev-loc { font-size: 2vh; color: var(--muted); font-weight: 400; }
  .today-card { flex: 0 0 auto; }
  .events-card { flex: 1.7; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .events-card .events { flex: 1; min-height: 0; overflow: hidden; }
  .shop-card { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .shop-list { list-style: none; flex: 1; min-height: 0; overflow: hidden;
    columns: 2; column-gap: 2vw; }
  .shop-list li { font-size: 2.5vh; font-weight: 600; padding: .5vh 0; break-inside: avoid; }
  .shop-list li::before { content: "•"; color: var(--accent2); margin-right: .8vw; }
  .shop-list li.more { color: var(--muted); font-weight: 500; }
  .shop-list li.more::before { content: ""; margin: 0; }
  .empty { color: var(--muted); font-size: 2.8vh; padding: 1vh 0; }
  .side { overflow: hidden; }
  .mini { list-style: none; display: flex; flex-direction: column; gap: 1vh; }
  .mini li { display: flex; justify-content: space-between; font-size: 2.5vh; font-weight: 600; }
  .mini .cd { color: var(--accent2); }
  .meals { list-style: none; display: flex; flex-direction: column; gap: .9vh; margin-top: 1.2vh; }
  .meals li { display: flex; gap: 1.2vw; font-size: 2.4vh; align-items: baseline; }
  .meals .d { flex: 0 0 auto; min-width: 9vw; color: var(--accent2); font-weight: 700; }
  .meals .m { font-weight: 600; }
  footer { position: fixed; bottom: 1.2vh; right: 2.2vw; font-size: 1.6vh; color: var(--muted); opacity: .6; }
  /* Local events ticker */
  .ticker { position: fixed; left: 0; right: 0; bottom: 0; height: 7vh;
    background: rgba(6,9,20,.82); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-top: 1px solid var(--stroke); display: flex; align-items: center; overflow: hidden; }
  .ticker-track { display: inline-flex; white-space: nowrap; padding-left: 100%;
    animation: ticker linear infinite; }
  .ticker-item { font-size: 2.8vh; font-weight: 600; margin: 0 3vw; }
  .ticker-item .ti-tag { color: var(--accent2); font-weight: 800; margin-right: .6vw; }
  .ticker-lead { position: absolute; left: 0; top: 0; bottom: 0; z-index: 2; display: flex; align-items: center;
    padding: 0 1.6vw; background: rgba(6,9,20,.95); color: var(--accent); font-weight: 800; font-size: 2.6vh;
    border-right: 1px solid var(--stroke); }
  @keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-100%); } }
  /* Doorbell overlay */
  #doorbell { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center;
    background: rgba(3,5,12,.86); backdrop-filter: blur(6px); }
  #doorbell.show { display: flex; animation: dbin .3s ease-out; }
  @keyframes dbin { from { opacity: 0; } to { opacity: 1; } }
  #doorbell .db-card { text-align: center; max-width: 82vw; }
  #doorbell .db-title { font-size: 5vh; font-weight: 800; color: var(--accent2); margin-bottom: 2vh; }
  #doorbell .db-title .pulse { display: inline-block; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }
  #doorbell img { max-width: 82vw; max-height: 74vh; border-radius: 18px; border: 3px solid rgba(255,255,255,.25);
    box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  #doorbell .db-time { font-size: 2.6vh; color: var(--muted); margin-top: 1.6vh; }
  /* Motion toast (small, corner) */
  #motion { position: fixed; right: 2vw; bottom: 9vh; z-index: 40; display: none;
    align-items: center; gap: 1vw; padding: 1.6vh 1.6vw; border-radius: 16px;
    background: rgba(20,28,50,.9); border: 1px solid var(--stroke); backdrop-filter: blur(10px);
    box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  #motion.show { display: flex; animation: dbin .3s ease-out; }
  #motion img { width: 16vw; max-height: 12vh; object-fit: cover; border-radius: 10px; display: none; }
  #motion .m-txt { font-size: 2.4vh; font-weight: 700; }
  #motion .m-sub { font-size: 1.9vh; color: var(--muted); font-weight: 500; margin-top: .4vh; }
</style>
</head>
<body class="${hasTicker ? 'has-ticker' : ''}"${d.night ? ' data-night="1"' : ''}>
  ${bgLayer}
  <header>
    <div class="head-left">
      <div class="title">${esc(config.dashboardTitle)}</div>
      <div class="date">${esc(d.headerDate)}</div>
    </div>
    <div class="clock" id="clock">--:--</div>
  </header>

  <div class="grid">
    <div class="col">
      <div class="card today-card">
        <h2>Today</h2>
        ${todayList}
      </div>
      <div class="card events-card">
        <h2>Coming up</h2>
        ${upcomingList}
      </div>
      ${shoppingCard}
    </div>

    <div class="col side">
      ${sideCards}
    </div>
  </div>

  ${hasTicker ? '' : `<footer>Rose · updated ${esc(d.generatedAt)}</footer>`}
  ${tickerBar}

  <div id="doorbell">
    <div class="db-card">
      <div class="db-title"><span class="pulse">🔔</span> Someone's at the door</div>
      <img id="db-img" alt="Doorbell snapshot">
      <div class="db-time" id="db-time"></div>
    </div>
  </div>

  <div id="motion">
    <img id="motion-img" alt="">
    <div>
      <div class="m-txt">👀 Movement outside</div>
      <div class="m-sub" id="motion-sub"></div>
    </div>
  </div>

  <script>
    function tick() {
      var now = new Date();
      var h = String(now.getHours()).padStart(2, '0');
      var m = String(now.getMinutes()).padStart(2, '0');
      var el = document.getElementById('clock');
      if (el) el.textContent = h + ':' + m;
    }
    tick(); setInterval(tick, 10000);

    // Background photo slideshow — cross-fade every 18s if more than one image.
    (function () {
      var slides = document.querySelectorAll('.bg');
      if (slides.length < 2) return;
      var i = 0;
      setInterval(function () {
        slides[i].classList.remove('active');
        i = (i + 1) % slides.length;
        slides[i].classList.add('active');
      }, 18000);
    })();

    // Doorbell: poll every 3s; when the bell was pressed recently, flash the
    // latest snapshot full-screen. Hides once the ding window passes.
    (function () {
      var token = new URLSearchParams(location.search).get('token') || '';
      var overlay = document.getElementById('doorbell');
      var img = document.getElementById('db-img');
      var timeEl = document.getElementById('db-time');
      var motionEl = document.getElementById('motion');
      var motionSub = document.getElementById('motion-sub');
      var motionImg = document.getElementById('motion-img');
      var shownAt = null;
      var motionShownAt = null;
      function fmt(iso) {
        var d = new Date(iso);
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      }
      function poll() {
        fetch('/doorbell-status?token=' + encodeURIComponent(token), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (s) {
            if (!s) return;
            // Doorbell press → full-screen overlay (takes priority over motion)
            if (s.active) {
              if (s.at !== shownAt) {
                shownAt = s.at;
                if (s.hasImage) {
                  img.style.display = '';
                  img.src = '/doorbell.jpg?token=' + encodeURIComponent(token) + '&t=' + encodeURIComponent(s.at);
                } else {
                  img.style.display = 'none';
                }
                timeEl.textContent = (s.camera ? s.camera + ' · ' : '') + fmt(s.at);
              }
              overlay.classList.add('show');
              motionEl.classList.remove('show');
            } else {
              overlay.classList.remove('show');
              shownAt = null;
              // Motion → small corner toast (only when no active press)
              if (s.motionActive) {
                if (s.motionAt !== motionShownAt) {
                  motionShownAt = s.motionAt;
                  motionSub.textContent = (s.motionCamera ? s.motionCamera + ' · ' : '') + fmt(s.motionAt);
                  if (s.motionHasImage) {
                    motionImg.style.display = '';
                    motionImg.src = '/motion.jpg?token=' + encodeURIComponent(token) + '&t=' + encodeURIComponent(s.motionAt);
                  } else {
                    motionImg.style.display = 'none';
                  }
                }
                motionEl.classList.add('show');
              } else {
                motionEl.classList.remove('show');
                motionShownAt = null;
              }
            }
          })
          .catch(function () { /* ignore transient errors */ });
      }
      setInterval(poll, 3000); poll();
    })();

    // Gentle auto-scroll for any overflowing list (e.g. Coming up): drift down,
    // pause, drift back up, loop — so nothing stays hidden.
    (function () {
      var lists = document.querySelectorAll('.autoscroll');
      lists.forEach(function (el) {
        if (el.scrollHeight <= el.clientHeight + 4) return; // fits — no scroll needed
        var pos = 0, dir = 1, hold = 0;
        setInterval(function () {
          var max = el.scrollHeight - el.clientHeight;
          if (hold > 0) { hold--; return; }
          pos += dir * 0.4;
          if (pos >= max) { pos = max; dir = -1; hold = 75; }
          else if (pos <= 0) { pos = 0; dir = 1; hold = 75; }
          el.scrollTop = pos;
        }, 40);
      });
    })();
  </script>
</body>
</html>`;
}

export { REFRESH_SECONDS };
