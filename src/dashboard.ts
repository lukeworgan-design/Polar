import { config } from './config';
import { getTodaysEvents, getUpcomingEvents, CalendarEvent } from './calendar';
import { getWeatherForecast, DayForecast } from './weather';
import { getMealPlan, getLastBabyLog } from './db';
import { getFridayBinType } from './scheduler';

// ── Data gathering ──────────────────────────────────────────────────────────────

interface DashEvent {
  summary: string;
  when: string;
  location: string | null;
  allDay: boolean;
}

interface DashboardData {
  headerDate: string;
  today: DashEvent[];
  upcoming: DashEvent[];
  weather: { today: string | null; tomorrow: string | null };
  dinner: string | null;
  bin: { label: string; colorHex: string } | null;
  baby: { name: string; ageText: string; lastFeed: string | null; lastNappy: string | null } | null;
  generatedAt: string;
}

function tzDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone,
  });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone,
  });
}

function toDashEvent(e: CalendarEvent, withDay: boolean): DashEvent {
  const allDay = e.start.length === 10;
  let when: string;
  if (allDay) {
    when = withDay ? fmtDayAllDay(e.start) : 'All day';
  } else {
    when = withDay ? `${fmtDay(e.start)} · ${fmtTime(e.start)}` : fmtTime(e.start);
  }
  return { summary: e.summary, when, location: e.location ?? null, allDay };
}

function fmtDayAllDay(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone,
  });
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
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/** True if a log is stale enough that on a wall display we'd rather say "not logged recently". */
function isStale(iso: string, maxHours: number): boolean {
  return (Date.now() - new Date(iso).getTime()) / 3600000 > maxHours;
}

export async function getDashboardData(): Promise<DashboardData> {
  const now = new Date();
  const headerDate = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
  });
  const todayStr = tzDateStr(now);

  let today: DashEvent[] = [];
  let upcoming: DashEvent[] = [];
  try {
    const [todayEvents, upcomingEvents] = await Promise.all([
      getTodaysEvents(),
      getUpcomingEvents(7),
    ]);
    const todayIds = new Set(todayEvents.map((e) => e.id));
    today = todayEvents.map((e) => toDashEvent(e, false));
    upcoming = upcomingEvents
      .filter((e) => !todayIds.has(e.id))
      .filter((e) => (e.start.length === 10 ? e.start : e.start.slice(0, 10)) > todayStr)
      .slice(0, 7)
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

  let dinner: string | null = null;
  try {
    const meals = await getMealPlan(todayStr, todayStr);
    const d = meals.find((m) => m.meal_type === 'dinner');
    dinner = d ? d.meal : null;
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

  let baby: DashboardData['baby'] = null;
  const dob = config.family.babyBorn;
  if (dob) {
    baby = {
      name: config.family.babyName || 'Baby',
      ageText: babyAgeText(dob),
      lastFeed: null,
      lastNappy: null,
    };
    try {
      const [feed, nappy] = await Promise.all([getLastBabyLog('feed'), getLastBabyLog('nappy')]);
      // On a wall display, a very old "last feed" reads oddly (means it's not
      // being logged, not that she hasn't fed) — treat >12h as not-recent.
      baby.lastFeed = feed && !isStale(feed.logged_at, 12) ? sinceText(feed.logged_at) : null;
      baby.lastNappy = nappy && !isStale(nappy.logged_at, 12) ? sinceText(nappy.logged_at) : null;
    } catch (err) {
      console.error('Dashboard: baby log fetch failed (table may not exist):', err);
    }
  }

  return {
    headerDate,
    today,
    upcoming,
    weather,
    dinner,
    bin,
    baby,
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

export function renderDashboardPage(d: DashboardData, token: string): string {
  const todayList = d.today.length
    ? `<ul class="events">${d.today.map(eventRow).join('')}</ul>`
    : `<p class="empty">Nothing in the diary today 🎉</p>`;

  const upcomingList = d.upcoming.length
    ? `<ul class="events">${d.upcoming.map(eventRow).join('')}</ul>`
    : `<p class="empty">Clear for the next week</p>`;

  const weatherCard = (d.weather.today || d.weather.tomorrow)
    ? `<div class="card weather">
         <h2>Weather</h2>
         ${d.weather.today ? `<p class="big">${esc(d.weather.today)}</p>` : ''}
         ${d.weather.tomorrow ? `<p class="sub">Tomorrow: ${esc(d.weather.tomorrow)}</p>` : ''}
       </div>` : '';

  const dinnerCard = d.dinner
    ? `<div class="card dinner"><h2>Tonight's dinner</h2><p class="big">🍽 ${esc(d.dinner)}</p></div>`
    : '';

  const binCard = d.bin
    ? `<div class="card bin"><h2>Next bin (Friday)</h2><p class="big"><span class="dot" style="background:${d.bin.colorHex}"></span>${esc(d.bin.label)}</p></div>`
    : '';

  const babyCard = d.baby
    ? `<div class="card baby">
         <h2>${esc(d.baby.name)}</h2>
         <p class="big">👶 ${esc(d.baby.ageText)}</p>
         <p class="sub">${d.baby.lastFeed ? `🍼 Fed ${esc(d.baby.lastFeed)}` : '🍼 No recent feed logged'}${
           d.baby.lastNappy ? ` · 👶 Nappy ${esc(d.baby.lastNappy)}` : ''
         }</p>
       </div>` : '';

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
    --bg: #0b1020; --panel: #151c32; --panel2: #1b2440;
    --text: #eef2ff; --muted: #9aa7c7; --accent: #7cc4ff; --accent2: #ffd479;
  }
  html, body { height: 100%; }
  body {
    background: radial-gradient(1200px 800px at 80% -10%, #1a2340 0%, var(--bg) 60%);
    color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 3vh 3vw; overflow: hidden; -webkit-font-smoothing: antialiased;
  }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2.4vh; }
  header .date { font-size: 3.4vh; font-weight: 700; letter-spacing: .3px; }
  header .clock { font-size: 5.2vh; font-weight: 800; color: var(--accent); font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: 1.35fr 1fr; grid-template-rows: auto auto; gap: 2vh 2vw; height: 84vh; }
  .col { display: flex; flex-direction: column; gap: 2vh; min-height: 0; }
  .card { background: linear-gradient(180deg, var(--panel) 0%, var(--panel2) 100%);
    border: 1px solid rgba(255,255,255,.06); border-radius: 20px; padding: 2.2vh 1.6vw; }
  .card h2 { font-size: 2.3vh; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); margin-bottom: 1.2vh; }
  .big { font-size: 3.2vh; font-weight: 700; }
  .dot { display: inline-block; width: 2.2vh; height: 2.2vh; border-radius: 50%; margin-right: 1vh;
    vertical-align: middle; box-shadow: 0 0 0 2px rgba(255,255,255,.15) inset; }
  .sub { font-size: 2.2vh; color: var(--muted); margin-top: .6vh; }
  .events { list-style: none; display: flex; flex-direction: column; gap: 1.1vh; overflow: hidden; }
  .events li { display: flex; align-items: baseline; gap: 1.2vw; }
  .ev-when { flex: 0 0 auto; min-width: 12vw; color: var(--accent2); font-weight: 700; font-size: 2.5vh; font-variant-numeric: tabular-nums; }
  .ev-name { font-size: 2.7vh; font-weight: 600; display: flex; flex-direction: column; }
  .ev-loc { font-size: 1.9vh; color: var(--muted); font-weight: 400; }
  .events-card { flex: 1; min-height: 0; overflow: hidden; }
  .empty { color: var(--muted); font-size: 2.6vh; padding: 1vh 0; }
  .side { display: grid; grid-template-columns: 1fr 1fr; gap: 2vh 1vw; align-content: start; }
  .side .card.full { grid-column: 1 / -1; }
  footer { position: fixed; bottom: 1vh; right: 2vw; font-size: 1.6vh; color: var(--muted); opacity: .6; }
</style>
</head>
<body>
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
      ${weatherCard}
      ${dinnerCard}
      ${binCard ? `<div class="full">${binCard}</div>` : ''}
      ${babyCard ? `<div class="full">${babyCard}</div>` : ''}
    </div>
  </div>

  <footer>Rose · updated ${esc(d.generatedAt)}</footer>

  <script>
    // Live ticking clock (page also hard-refreshes every ${REFRESH_SECONDS}s for fresh data)
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
