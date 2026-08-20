import { existsSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { getTodaysEvents, getUpcomingEvents, CalendarEvent } from './calendar';
import { getWeatherForecast, DayForecast } from './weather';
import { getMealPlan, getLastBabyLog, getUpcomingBirthdays } from './db';
import { getFridayBinType } from './scheduler';
import { getLocalEventsTicker } from './ai';

// A background photo can be supplied two ways:
//   1. Commit an image to  assets/dashboard-bg.(jpg|jpeg|png|webp)  — Rose serves
//      it at /dashboard-bg (no third-party host needed), OR
//   2. Set DASHBOARD_BG_URL to any public image URL.
const BG_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

export function localBgFile(): string | null {
  for (const ext of BG_EXTENSIONS) {
    const p = join(process.cwd(), 'assets', `dashboard-bg.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function backgroundUrl(): string | null {
  if (config.dashboardBgUrl) return config.dashboardBgUrl;
  return localBgFile() ? '/dashboard-bg' : null;
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
  weather: { today: string | null; tomorrow: string | null };
  meals: { tonight: string | null; upcoming: Array<{ day: string; meal: string }> };
  bin: { label: string; colorHex: string } | null;
  schoolRun: string | null;
  countdowns: Countdown[];
  baby: { name: string; ageText: string; lastFeed: string | null; lastNappy: string | null } | null;
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
      getUpcomingEvents(14), // two-week look-ahead
    ]);
    todayEvents = te;
    const todayIds = new Set(te.map((e) => e.id));
    today = te.map((e) => toDashEvent(e, false));
    upcoming = upcomingEvents
      .filter((e) => !todayIds.has(e.id))
      .filter((e) => (e.start.length === 10 ? e.start : e.start.slice(0, 10)) > todayStr)
      .slice(0, 10)
      .map((e) => toDashEvent(e, true));
  } catch (err) {
    console.error('Dashboard: calendar fetch failed:', err);
  }

  let weather: { today: string | null; tomorrow: string | null } = { today: null, tomorrow: null };
  try {
    const days = await getWeatherForecast(2);
    if (days[0]) weather.today = fmtWeather(days[0]);
    if (days[1]) weather.tomorrow = fmtWeather(days[1]);
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
    baby = { name: config.family.babyName || 'Baby', ageText: babyAgeText(dob), lastFeed: null, lastNappy: null };
    try {
      const [feed, nappy] = await Promise.all([getLastBabyLog('feed'), getLastBabyLog('nappy')]);
      baby.lastFeed = feed && !isStale(feed.logged_at, 12) ? sinceText(feed.logged_at) : null;
      baby.lastNappy = nappy && !isStale(nappy.logged_at, 12) ? sinceText(nappy.logged_at) : null;
    } catch (err) {
      console.error('Dashboard: baby log fetch failed (table may not exist):', err);
    }
  }

  return {
    headerDate, today, upcoming, weather, meals, bin, schoolRun, countdowns, baby,
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
    ? `<ul class="events">${d.upcoming.map(eventRow).join('')}</ul>`
    : `<p class="empty">Clear for the next couple of weeks</p>`;

  const weatherCard = (d.weather.today || d.weather.tomorrow)
    ? `<div class="card">
         <h2>Weather</h2>
         ${d.weather.today ? `<p class="big">${esc(d.weather.today)}</p>` : ''}
         ${d.weather.tomorrow ? `<p class="sub">Tomorrow: ${esc(d.weather.tomorrow)}</p>` : ''}
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
    const details = opts.baby === 'full'
      ? `<p class="sub">${d.baby.lastFeed ? `🍼 Fed ${esc(d.baby.lastFeed)}` : '🍼 No recent feed logged'}${
          d.baby.lastNappy ? ` · 👶 Nappy ${esc(d.baby.lastNappy)}` : ''
        }</p>`
      : '';
    babyCard = `<div class="card"><h2>${esc(d.baby.name)}</h2><p class="big">👶 ${esc(d.baby.ageText)}</p>${details}</div>`;
  }

  const sideCards = [weatherCard, mealsCard, schoolRunCard, binCard, countdownCard, babyCard]
    .filter(Boolean).join('\n');

  const bg = opts.photo ? backgroundUrl() : null;
  const bgLayer = bg
    ? `<div class="bg" style="background-image:url('${esc(bg)}')"></div><div class="bg-tint"></div>`
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
    ? `<div class="ticker"><div class="ticker-lead">📣 What's on</div><div class="ticker-track" style="animation-duration:${tickerSecs}s">${tickerItems}</div></div>`
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
    --bg: #0b1020; --panel: rgba(20,28,50,.58); --panel2: rgba(15,21,40,.5);
    --text: #eef2ff; --muted: #b6c0dc; --accent: #7cc4ff; --accent2: #ffd479;
    --stroke: rgba(255,255,255,.12); --dim: 1;
  }
  html, body { height: 100%; }
  body {
    background: radial-gradient(1400px 900px at 80% -10%, #1a2340 0%, var(--bg) 60%);
    color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 3.2vh 3vw; overflow: hidden; -webkit-font-smoothing: antialiased; position: relative;
    filter: brightness(var(--dim));
    text-shadow: 0 1px 3px rgba(0,0,0,.55);
  }
  /* Night dimming after 8pm */
  body[data-night="1"] {
    --bg: #05070f; --panel: rgba(12,17,32,.66); --panel2: rgba(9,13,26,.6);
    --text: #cdd6f0; --muted: #8a95b8; --accent: #5b9fd6; --accent2: #d8b26a; --dim: .72;
  }
  .bg { position: fixed; inset: 0; background-size: cover; background-position: center; z-index: -2; }
  .bg-tint { position: fixed; inset: 0; z-index: -1;
    background: linear-gradient(180deg, rgba(6,9,20,.42), rgba(6,9,20,.6)); }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2.6vh; }
  header .date { font-size: 4vh; font-weight: 700; letter-spacing: .3px; }
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
  .events { list-style: none; display: flex; flex-direction: column; gap: 1.3vh; overflow: hidden; }
  .events li { display: flex; align-items: baseline; gap: 1.2vw; }
  .ev-when { flex: 0 0 auto; min-width: 13vw; color: var(--accent2); font-weight: 700; font-size: 2.7vh; font-variant-numeric: tabular-nums; }
  .ev-name { font-size: 2.9vh; font-weight: 600; display: flex; flex-direction: column; }
  .ev-loc { font-size: 2vh; color: var(--muted); font-weight: 400; }
  .events-card { flex: 1; min-height: 0; overflow: hidden; }
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
</style>
</head>
<body class="${hasTicker ? 'has-ticker' : ''}"${d.night ? ' data-night="1"' : ''}>
  ${bgLayer}
  <header>
    <div class="date">${esc(d.headerDate)}</div>
    <div class="clock" id="clock">--:--</div>
  </header>

  <div class="grid">
    <div class="col">
      <div class="card events-card">
        <h2>Today</h2>
        ${todayList}
      </div>
      <div class="card events-card">
        <h2>Coming up</h2>
        ${upcomingList}
      </div>
    </div>

    <div class="col side">
      ${sideCards}
    </div>
  </div>

  ${hasTicker ? '' : `<footer>Rose · updated ${esc(d.generatedAt)}</footer>`}
  ${tickerBar}

  <script>
    function tick() {
      var now = new Date();
      var h = String(now.getHours()).padStart(2, '0');
      var m = String(now.getMinutes()).padStart(2, '0');
      var el = document.getElementById('clock');
      if (el) el.textContent = h + ':' + m;
    }
    tick(); setInterval(tick, 10000);
  </script>
</body>
</html>`;
}

export { REFRESH_SECONDS };
