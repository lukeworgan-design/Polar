import { existsSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { getTodaysEvents, getUpcomingEvents, CalendarEvent } from './calendar';
import { getWeatherForecast, DayForecast } from './weather';
import { getMealPlan, getLastBabyLog, getUpcomingBirthdays, getBirthdays, getShoppingList } from './db';
import { getFridayBinType } from './scheduler';
import { getRunForDate } from './schoolrun';
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
  close?: boolean; // immediate family — gets a subtle highlight
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
  dailyFun: { header: string; text: string };
  baby: { name: string; ageText: string; fact: string | null } | null;
  shopping: string[];
  reminders: string[];
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

// Some calendar entries carry a junk location ("None", "N/A", "-") — usually from
// an event created without a real address. Treat those as no location so the
// dashboard doesn't print a meaningless "📍 None" pin.
function cleanLocation(loc: string | null | undefined): string | null {
  if (!loc) return null;
  const trimmed = loc.trim();
  if (!trimmed) return null;
  if (/^(none|n\/?a|tbd|tba|null|undefined|-+)$/i.test(trimmed)) return null;
  return trimmed;
}

function toDashEvent(e: CalendarEvent, withDay: boolean): DashEvent {
  const allDay = e.start.length === 10;
  let when: string;
  if (allDay) {
    when = withDay ? fmtDay(e.start) : 'All day';
  } else {
    when = withDay ? `${fmtDay(e.start)} · ${fmtTime(e.start)}` : fmtTime(e.start);
  }
  return { summary: e.summary, when, location: cleanLocation(e.location), allDay };
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

// A daily rotating giggle / fun fact for the family (kid-friendly).
const DAILY_FUN: Array<{ header: string; text: string }> = [
  { header: '😄 Joke of the day', text: 'Why did the scarecrow win an award? Because he was outstanding in his field!' },
  { header: '😄 Joke of the day', text: 'What do you call a fish with no eyes? A fsh!' },
  { header: '😄 Joke of the day', text: 'Why did the bicycle fall over? Because it was two-tired!' },
  { header: '😄 Joke of the day', text: 'What do you call a bear with no teeth? A gummy bear!' },
  { header: '😄 Joke of the day', text: 'Why can\'t you give Elsa a balloon? Because she\'ll let it go!' },
  { header: '😄 Joke of the day', text: 'What do you call cheese that isn\'t yours? Nacho cheese!' },
  { header: '😄 Joke of the day', text: 'Why did the banana go to the doctor? It wasn\'t peeling well!' },
  { header: '😄 Joke of the day', text: 'What\'s orange and sounds like a parrot? A carrot!' },
  { header: '😄 Joke of the day', text: 'Why do bees have sticky hair? Because they use honeycombs!' },
  { header: '😄 Joke of the day', text: 'What did one wall say to the other? "Meet you at the corner!"' },
  { header: '😄 Joke of the day', text: 'How does the ocean say hello? It waves!' },
  { header: '😄 Joke of the day', text: 'Why was the maths book sad? It had too many problems!' },
  { header: '💡 Did you know?', text: 'A group of flamingos is called a "flamboyance".' },
  { header: '💡 Did you know?', text: 'Octopuses have three hearts and blue blood.' },
  { header: '💡 Did you know?', text: 'Honey never goes off — jars found in ancient tombs are still edible!' },
  { header: '💡 Did you know?', text: 'A day on Venus is longer than a year on Venus.' },
  { header: '💡 Did you know?', text: 'Bananas are berries, but strawberries aren\'t!' },
  { header: '💡 Did you know?', text: 'Cows have best friends and get stressed when they\'re apart.' },
  { header: '💡 Did you know?', text: 'The Eiffel Tower can grow over 15cm taller in summer as the metal expands.' },
  { header: '💡 Did you know?', text: 'A newborn baby\'s stomach is only about the size of a cherry on day one.' },
  { header: '💡 Did you know?', text: 'Sea otters hold hands while sleeping so they don\'t drift apart.' },
  { header: '💡 Did you know?', text: 'Wombat poo is cube-shaped!' },
];

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
  // Day of week in the family timezone (0=Sun … 5=Fri … 6=Sat).
  const dayOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    .indexOf(new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: config.timezone }).format(now).slice(0, 3).toLowerCase());

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
      .slice(0, 2)
      .map((m) => ({ day: fmtDay(m.date), meal: m.meal }));
  } catch (err) {
    console.error('Dashboard: meal fetch failed:', err);
  }

  // Bins collect on Friday — only show the card in the run-up (Wed/Thu/Fri).
  let bin: { label: string; colorHex: string } | null = null;
  if (dayOfWeek >= 3 && dayOfWeek <= 5) {
    try {
      const type = getFridayBinType();
      bin = type === 'general'
        ? { label: 'Green — general waste', colorHex: '#2ec26a' }
        : { label: 'Blue — recycling', colorHex: '#3aa0ff' };
    } catch (err) {
      console.error('Dashboard: bin calc failed:', err);
    }
  }

  // School run today (weekday and not a holiday). Read from the shared, editable
  // rota so the wall always matches what Rose says in chat.
  let schoolRun: string | null = null;
  if (!isSchoolHoliday(todayStr, todayEvents)) {
    try {
      schoolRun = await getRunForDate(todayStr);
    } catch (err) {
      console.error('Dashboard: school-run lookup failed:', err);
    }
  }

  // "Don't forget" — PE / forest-school kit for today and tomorrow (skipped in
  // holidays). Reads the same shared schedule Rose uses.
  const reminders: string[] = [];
  try {
    const { getKitForWeekday, kitWallLabel } = await import('./kit');
    const wd = (d: Date) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: config.timezone }).format(d);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = tzDateStr(tomorrow);
    if (!isSchoolHoliday(todayStr, todayEvents)) {
      for (const e of await getKitForWeekday(wd(now))) reminders.push(`Today · ${e.child}: ${kitWallLabel(e)}`);
    }
    if (!isSchoolHoliday(tomorrowStr, todayEvents)) {
      for (const e of await getKitForWeekday(wd(tomorrow))) reminders.push(`Tomorrow · ${e.child}: ${kitWallLabel(e)}`);
    }
  } catch (err) {
    console.error('Dashboard: kit reminders failed:', err);
  }

  // Countdowns: birthdays + Evie milestones + back-to-school, soonest first.
  const raw: Array<{ name: string; days: number; emoji: string; close?: boolean }> = [];
  // Immediate family get a subtle highlight to stand out from friends/relatives.
  const closeNames = new Set<string>(
    [
      ...config.family.children.map((c) => c.name),
      config.users.luke.name, config.users.toni.name, config.family.babyName || '',
    ].map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  const dbBdayNames = new Set<string>();
  try {
    const [bdays, allBdays] = await Promise.all([getUpcomingBirthdays(45), getBirthdays()]);
    const seenBday = new Set<string>();
    for (const b of bdays) {
      const key = `${b.name.trim().toLowerCase()}|${b.days_until}`;
      if (seenBday.has(key)) continue; // skip duplicate rows (e.g. two identical "Alex" entries)
      seenBday.add(key);
      raw.push({ name: b.name, days: b.days_until, emoji: '🎂', close: closeNames.has(b.name.trim().toLowerCase()) });
    }
    // Full list (any date) so a child tracked in the DB is never re-added from
    // config with a placeholder DOB, even if their birthday is outside the window.
    for (const b of allBdays) dbBdayNames.add(b.name.trim().toLowerCase());
  } catch (err) {
    console.error('Dashboard: birthdays fetch failed:', err);
  }
  // Any child NOT tracked in the birthdays table falls back to their config DOB.
  const nextBirthday = (dob: string): { days: number; turning: number } => {
    const b = new Date(`${dob}T12:00:00`);
    const anchor = new Date(`${todayStr}T12:00:00`);
    let next = new Date(anchor.getFullYear(), b.getMonth(), b.getDate(), 12, 0, 0);
    if (next.getTime() < anchor.getTime()) next = new Date(anchor.getFullYear() + 1, b.getMonth(), b.getDate(), 12, 0, 0);
    return { days: Math.round((next.getTime() - anchor.getTime()) / 86400000), turning: next.getFullYear() - b.getFullYear() };
  };
  for (const child of config.family.children) {
    if (dbBdayNames.has(child.name.trim().toLowerCase())) continue;
    const { days, turning } = nextBirthday(child.dob);
    if (days >= 0 && days <= 45) raw.push({ name: `${child.name} turns ${turning}`, days, emoji: '🎂', close: true });
  }
  // Evie's next developmental milestone
  const dobC = config.family.babyBorn;
  if (dobC) {
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(`${dobC}T12:00:00`).getTime()) / 86400000));
    const milestones = [
      { d: 30, label: '1 month old' }, { d: 42, label: '6 weeks — first smiles!' },
      { d: 84, label: '3 months old' }, { d: 182, label: '6 months old' }, { d: 365, label: '1st birthday' },
    ];
    const next = milestones.find((m) => m.d > ageDays);
    if (next) raw.push({ name: `${config.family.babyName || 'Baby'} — ${next.label}`, days: next.d - ageDays, emoji: '👶', close: true });
  }
  // Back to school (end date of the holiday we're currently in)
  const inHol = config.family.schoolHolidays.find((h) => todayStr >= h.start && todayStr < h.end);
  if (inHol) {
    const days = Math.round((new Date(inHol.end + 'T12:00:00Z').getTime() - new Date(todayStr + 'T12:00:00Z').getTime()) / 86400000);
    if (days > 0) raw.push({ name: 'Back to school', days, emoji: '🎒' });
  }
  const countdowns: Countdown[] = raw
    .filter((c) => c.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5)
    .map((c) => ({
      name: `${c.emoji} ${c.name}`,
      detail: c.days === 0 ? 'Today!' : c.days === 1 ? 'Tomorrow' : `${c.days} days`,
      close: c.close,
    }));

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

  const dayIndex = Math.floor(Date.now() / 86400000);
  const dailyFun = DAILY_FUN[dayIndex % DAILY_FUN.length]!;

  return {
    headerDate, today, upcoming, weather, meals, bin, schoolRun, countdowns, dailyFun, baby, shopping, reminders,
    ticker: getLocalEventsTicker(),
    night,
    generatedAt: fmtTime(now.toISOString()),
  };
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Replace emoji with Twemoji images server-side, so even the wall TV's old
// browser (which can't draw newer emoji like 🦦 and may not run our scripts)
// shows every emoji as an image baked straight into the HTML.
const EMOJI_SEQ = /\p{Extended_Pictographic}(\uFE0F|[\u{1F3FB}-\u{1F3FF}])?(\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;
export function emojifyHtml(html: string): string {
  return html.replace(EMOJI_SEQ, (seq) => {
    const cps = Array.from(seq).map((c) => c.codePointAt(0)!).filter((cp) => cp !== 0xfe0f);
    if (cps.length === 0) return seq;
    const name = cps.map((cp) => cp.toString(16)).join('-');
    // Served from Rose's own origin (the TV can reach that, but not external CDNs).
    return `<img class="emoji" alt="${seq}" src="/emoji/${name}.png">`;
  });
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

  // "Don't forget" kit card — only rendered when there's something to pack.
  const remindersCard = d.reminders.length
    ? `<div class="card reminders-card">
        <h2>🎒 Don't forget</h2>
        <ul class="reminders">${d.reminders
          .map((r) => {
            const [tag, rest] = r.split(' · ');
            return `<li><span class="rm-tag">${esc(tag ?? '')}</span>${esc(rest ?? r)}</li>`;
          })
          .join('')}</ul>
      </div>`
    : '';

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
    ? `<div class="card"><h2>School run today</h2><p class="big clamp2">🚌 ${esc(d.schoolRun)}</p></div>`
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
    ? `<div class="card"><h2>Countdowns</h2><ul class="mini">${
        d.countdowns.map((c) => `<li${c.close ? ' class="fam"' : ''}><span>${esc(c.name)}</span><span class="cd">${esc(c.detail)}</span></li>`).join('')
      }</ul></div>`
    : '';

  let babyCard = '';
  if (d.baby && opts.baby !== 'off') {
    const details = (opts.baby === 'full' && d.baby.fact)
      ? `<p class="baby-fact">💡 Today ${esc(d.baby.name)} ${esc(d.baby.fact)}</p>`
      : '';
    babyCard = `<div class="card"><h2>${esc(d.baby.name)}</h2><p class="big">👶 ${esc(d.baby.ageText)}</p>${details}</div>`;
  }

  const funCard = `<div class="card fun-card">
      <h2>${esc(d.dailyFun.header)}</h2>
      <p class="fun-text">${esc(d.dailyFun.text)}</p>
    </div>`;

  // Pair compact single-purpose cards side-by-side so the right column fits on a
  // busy school day (weather + meals + school run + bin + countdowns + Evie + joke)
  // without shoving the kids' beloved joke off the bottom. A pair with only one
  // card present just renders that card full-width.
  const pair = (...cards: string[]): string => {
    const present = cards.filter(Boolean);
    if (present.length === 0) return '';
    if (present.length === 1) return present[0]!;
    return `<div class="side-pair">${present.join('')}</div>`;
  };
  const sideCards = [
    weatherCard,
    mealsCard,
    pair(schoolRunCard, binCard),
    pair(countdownCard, babyCard),
    funCard,
  ].filter(Boolean).join('\n');

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
  .hours { display: flex; justify-content: space-between; gap: .4vw; margin-top: .5vh; }
  .hr { display: flex; flex-direction: column; align-items: center; gap: .2vh; flex: 1; }
  .hr-t { font-size: 1.5vh; color: var(--muted); font-variant-numeric: tabular-nums; }
  .hr-e { font-size: 2.1vh; }
  .hr-d { font-size: 1.8vh; font-weight: 700; }
  .hr-r { font-size: 1.3vh; color: var(--accent); min-height: 1.3vh; }
  .wfoot { font-size: 1.7vh; color: var(--muted); margin-top: .5vh; }
  /* Compact the right-hand column so all cards fit without clipping */
  .col.side { gap: .9vh; }
  .side .card { padding: 1vh 1.3vw; }
  .side .card h2 { margin-bottom: .5vh; }
  .side .big { font-size: 2.7vh; }
  .side .sub { font-size: 1.9vh; margin-top: .4vh; }
  .events { list-style: none; display: flex; flex-direction: column; gap: 1.3vh; overflow: hidden; }
  .events li { display: flex; align-items: baseline; gap: 1.2vw; }
  .ev-when { flex: 0 0 auto; min-width: 13vw; color: var(--accent2); font-weight: 700; font-size: 2.7vh; font-variant-numeric: tabular-nums; }
  .ev-name { font-size: 2.9vh; font-weight: 600; display: flex; flex-direction: column; }
  .ev-loc { font-size: 2vh; color: var(--muted); font-weight: 400; }
  /* Clamp a long value to two lines so an edited rota can't blow up a half-width card. */
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .today-card { flex: 0 0 auto; }
  .reminders-card { flex: 0 0 auto; }
  .reminders { list-style: none; display: flex; flex-direction: column; gap: .8vh; margin-top: .6vh; }
  .reminders li { font-size: 2.5vh; font-weight: 600; display: flex; gap: 1.2vw; align-items: baseline; }
  .reminders .rm-tag { flex: 0 0 auto; min-width: 11vw; color: var(--accent2); font-weight: 700; }
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
  .mini li { display: flex; justify-content: space-between; gap: 1.5vw; font-size: 2.5vh; font-weight: 600; }
  .mini li > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini .cd { color: var(--accent2); flex: 0 0 auto; }
  /* Immediate family — subtle highlight so they stand out from friends/relatives. */
  .mini li.fam > span:first-child { color: var(--accent); }
  /* Two compact cards side by side, equal height, to save vertical space. */
  .side-pair { display: flex; gap: 1.1vh; align-items: stretch; }
  .side-pair > .card { flex: 1 1 0; min-width: 0; }
  /* Countdowns/mini lists sit in half-width paired cards — smaller so labels fit. */
  .side .mini li { font-size: 2.05vh; gap: .8vw; }
  /* Baby fact sits in a half-width paired card — keep it compact and capped at
     two lines so a long fact can't push the joke card off the bottom. */
  .baby-fact { font-size: 1.6vh; color: var(--muted); margin-top: .4vh; line-height: 1.25;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  /* Daily fun card — fills leftover space, but its text is top-aligned so the
     header and joke always render from the top (never centred out of view). */
  .fun-card { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: flex-start; }
  .fun-text { font-size: 2.3vh; font-weight: 600; line-height: 1.2; margin-top: .4vh; }
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
  #doorbell .db-desc { font-size: 3vh; font-weight: 600; margin-top: 1.6vh; color: var(--text); }
  #doorbell .db-time { font-size: 2.6vh; color: var(--muted); margin-top: .8vh; }
  /* Motion toast (small, corner) */
  #motion { position: fixed; right: 2vw; bottom: 9vh; z-index: 40; display: none;
    align-items: center; gap: 1vw; padding: 1.6vh 1.6vw; border-radius: 16px;
    background: rgba(20,28,50,.9); border: 1px solid var(--stroke); backdrop-filter: blur(10px);
    box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  #motion.show { display: flex; animation: dbin .3s ease-out; }
  #motion img { width: 16vw; max-height: 12vh; object-fit: cover; border-radius: 10px; display: none; }
  #motion .m-txt { font-size: 2.4vh; font-weight: 700; }
  #motion .m-sub { font-size: 1.9vh; color: var(--muted); font-weight: 500; margin-top: .4vh; }
  /* Twemoji renders emoji as inline images so newer ones (🦦 etc.) show on the
     TV's old browser font. Size them to the surrounding text. */
  img.emoji { height: 1em; width: 1em; margin: 0 .08em; vertical-align: -0.12em; display: inline-block; }
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
      ${remindersCard}
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
      <div class="db-desc" id="db-desc"></div>
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
      var descEl = document.getElementById('db-desc');
      var timeEl = document.getElementById('db-time');
      var motionEl = document.getElementById('motion');
      var motionSub = document.getElementById('motion-sub');
      var motionImg = document.getElementById('motion-img');
      var shownAt = null, dbImgSet = false;
      var motionShownAt = null, motionImgSet = false;
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
                shownAt = s.at; dbImgSet = false;
                img.style.display = 'none';
                descEl.textContent = '';
                timeEl.textContent = (s.camera ? s.camera + ' · ' : '') + fmt(s.at);
              }
              // Attach the snapshot as soon as it's ready (arrives a moment after the ding).
              if (s.hasImage && !dbImgSet) {
                img.src = '/doorbell.jpg?token=' + encodeURIComponent(token) + '&t=' + encodeURIComponent(s.at);
                img.style.display = ''; dbImgSet = true;
              }
              if (s.description) descEl.textContent = s.description;
              overlay.classList.add('show');
              motionEl.classList.remove('show');
            } else {
              overlay.classList.remove('show');
              shownAt = null; dbImgSet = false;
              // Motion → small corner toast (only when no active press)
              if (s.motionActive) {
                if (s.motionAt !== motionShownAt) {
                  motionShownAt = s.motionAt; motionImgSet = false;
                  motionImg.style.display = 'none';
                  motionSub.textContent = (s.motionCamera ? s.motionCamera + ' · ' : '') + fmt(s.motionAt);
                }
                if (s.motionHasImage && !motionImgSet) {
                  motionImg.src = '/motion.jpg?token=' + encodeURIComponent(token) + '&t=' + encodeURIComponent(s.motionAt);
                  motionImg.style.display = ''; motionImgSet = true;
                }
                motionEl.classList.add('show');
              } else {
                motionEl.classList.remove('show');
                motionShownAt = null; motionImgSet = false;
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
