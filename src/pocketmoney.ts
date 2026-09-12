import { config } from './config';
import { getSetting, setSetting } from './db';

// Pocket-money job tracker for the kids. Per-job pennies: each job done adds its
// value to that child's running total for the week; payout on Sunday. Stored as
// JSON in app_settings (no new table needed), like the school-run / kit schedules.

export type JobDays = 'daily' | 'weekdays';
export interface Job {
  id: string;
  child: string;
  name: string;
  valuePence: number;
  days: JobDays;
}
interface PMConfig {
  jobs: Job[];
  // date (YYYY-MM-DD) → child → list of completed job ids that day
  completions: Record<string, Record<string, string[]>>;
  // Legacy: the old single weekly total (£5). Kept for back-compat but no longer
  // used for earnings — jobs now target jobsTargetPence and behaviour is separate.
  weeklyTargetPence?: number;
  // The amount a child can earn from jobs each week (a share of this, by jobs done).
  jobsTargetPence?: number;
  // The weekly "good behaviour" amount each child STARTS the week with (docked for
  // bad behaviour). weekStart (Saturday, YYYY-MM-DD) → child → pence still awarded
  // this week (absent = the full behaviourWeeklyPence).
  behaviourWeeklyPence?: number;
  behaviour?: Record<string, Record<string, number>>;
}

const KEY = 'pocket_money';
const DEFAULT_VALUE = 0; // per-job value is unused now — earnings are a share of the weekly target
const DEFAULT_TARGET = 500; // legacy £5 total (unused now)
const DEFAULT_JOBS_TARGET = 400; // £4 per child per week from jobs
const DEFAULT_BEHAVIOUR = 100;   // £1 per child per week for good behaviour (starts on)

// Seeded from Luke's list (names refinable via Rose). Weekday-only where it makes sense.
const DEFAULT_JOBS: Array<{ name: string; days: JobDays }> = [
  { name: 'Empty school bag', days: 'weekdays' },
  { name: 'Tidy room', days: 'daily' },
  { name: 'Make bed', days: 'daily' },
  { name: 'Dishes in sink', days: 'daily' },
  { name: 'Go to bed nicely', days: 'daily' },
  { name: 'Homework', days: 'weekdays' },
  { name: 'Get dressed', days: 'daily' },
  { name: 'Feed Charlie', days: 'daily' },
];

const STOP = new Set(['the', 'a', 'an', 'your', 'you', 'my', 'his', 'her', 'first', 'thing', 'in', 'to', 'and', 'up', 'nicely', 'good', 'go', 'put']);

function kids(): string[] {
  return config.family.children.map((c) => c.name);
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function jobId(child: string, name: string): string {
  return `${slug(child)}--${slug(name)}`;
}

function seed(): PMConfig {
  const jobs: Job[] = [];
  for (const child of kids()) {
    for (const j of DEFAULT_JOBS) {
      jobs.push({ id: jobId(child, j.name), child, name: j.name, valuePence: DEFAULT_VALUE, days: j.days });
    }
  }
  return { jobs, completions: {}, jobsTargetPence: DEFAULT_JOBS_TARGET, behaviourWeeklyPence: DEFAULT_BEHAVIOUR, behaviour: {} };
}

/** The weekly jobs target (£4). Ignores the legacy weeklyTargetPence field. */
function targetPence(cfg: PMConfig): number {
  return cfg.jobsTargetPence ?? DEFAULT_JOBS_TARGET;
}
/** The full weekly good-behaviour amount (£1) each child starts with. */
function behaviourWeekly(cfg: PMConfig): number {
  return cfg.behaviourWeeklyPence ?? DEFAULT_BEHAVIOUR;
}
/** Total job-slots a child could tick across the full Mon–Sun week. */
function weekPossible(cfg: PMConfig, child: string, dateStr: string): number {
  return fullWeekDates(dateStr).reduce((sum, date) => sum + jobsForChildOn(cfg, child, date).length, 0);
}
/** Money earned for `doneCount` completed job-slots this week — a share of the target. */
function earnedPence(cfg: PMConfig, child: string, doneCount: number, dateStr: string): number {
  const possible = weekPossible(cfg, child, dateStr);
  if (possible <= 0) return 0;
  return Math.round((targetPence(cfg) * doneCount) / possible);
}

async function read(): Promise<PMConfig> {
  try {
    const s = await getSetting(KEY);
    if (s) {
      const cfg = JSON.parse(s) as PMConfig;
      if (Array.isArray(cfg.jobs)) return {
        jobs: cfg.jobs,
        completions: cfg.completions || {},
        weeklyTargetPence: cfg.weeklyTargetPence,
        jobsTargetPence: cfg.jobsTargetPence ?? DEFAULT_JOBS_TARGET,
        behaviourWeeklyPence: cfg.behaviourWeeklyPence ?? DEFAULT_BEHAVIOUR,
        behaviour: cfg.behaviour ?? {},
      };
    }
  } catch {
    /* fall through to seed */
  }
  return seed();
}
async function write(cfg: PMConfig): Promise<void> {
  prune(cfg);
  await setSetting(KEY, JSON.stringify(cfg));
}

// Serialize every read-modify-write so ticking two kids at once (two rapid
// mutations of the same app_settings blob) can't lose an update.
let chain: Promise<unknown> = Promise.resolve();
async function mutate<T>(fn: (cfg: PMConfig) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const cfg = await read();
    const result = await fn(cfg);
    await write(cfg);
    return result;
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// ── Dates (family timezone) ────────────────────────────────────────────────────
export function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}
function isWeekday(dateStr: string): boolean {
  const wd = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: config.timezone });
  return wd !== 'Sat' && wd !== 'Sun';
}
// The pocket-money week runs Saturday → Friday, so Friday is payday (the last day).
function sinceWeekStart(dow: number): number {
  return (dow + 1) % 7; // days since Saturday (Sat=0 … Fri=6)
}
/** Dates from the week's Saturday up to `dateStr` (inclusive). */
function weekDates(dateStr: string): string[] {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const since = sinceWeekStart(d.getUTCDay());
  const out: string[] = [];
  for (let i = since; i >= 0; i--) {
    const dd = new Date(d);
    dd.setUTCDate(d.getUTCDate() - i);
    out.push(dd.toISOString().slice(0, 10));
  }
  return out;
}
/** Full Sat–Fri week containing `dateStr` (for the payout summary). */
function fullWeekDates(dateStr: string): string[] {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - sinceWeekStart(d.getUTCDay()));
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(start);
    dd.setUTCDate(start.getUTCDate() + i);
    out.push(dd.toISOString().slice(0, 10));
  }
  return out;
}
/** Friendly label for a date, e.g. "Saturday, 6 September". */
export function dayLabel(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
  });
}
/** Whether a date is in the same Sat–Fri pay-week as today (i.e. not yet paid). */
export function isInCurrentPayWeek(dateStr: string): boolean {
  return fullWeekDates(todayStr())[0] === fullWeekDates(dateStr)[0];
}
/**
 * Validate a date for ticking/backfilling jobs. Rejects the future (you can't
 * earn a job you haven't done) and dates more than ~2 weeks back (older
 * completions get pruned anyway).
 */
export function checkJobDate(dateStr: string): { ok: boolean; reason?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, reason: 'not a valid date' };
  const today = todayStr();
  if (dateStr > today) return { ok: false, reason: 'that day is in the future — jobs can only be ticked off once they have actually been done' };
  const daysBack = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${dateStr}T12:00:00Z`)) / 86400000);
  if (daysBack > 13) return { ok: false, reason: 'that is more than two weeks ago — too far back to change now' };
  return { ok: true };
}
function prune(cfg: PMConfig): void {
  // Keep ~3 weeks of completions so the blob can't grow forever.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 21);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const date of Object.keys(cfg.completions)) {
    if (date < cutoffStr) delete cfg.completions[date];
  }
}

// ── Matching a spoken job to a real one ────────────────────────────────────────
function keyStems(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 4));
}
function matchJobs(jobs: Job[], phrase: string): Job[] {
  const p = phrase.trim().toLowerCase();
  if (!p) return [];
  // Prefer an exact name match (the AI passes exact names from the list) so
  // "Make bed" doesn't also tick "Go to bed nicely" via the shared word "bed".
  const exact = jobs.filter((j) => j.name.toLowerCase() === p);
  if (exact.length) return exact;
  return jobs.filter((j) => keyStems(j.name).some((stem) => p.includes(stem)));
}
/** Match a comma/'and'-separated list of job references, de-duplicated. */
function matchList(jobs: Job[], phrase: string): Job[] {
  const parts = phrase.split(/,|\band\b/i).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const part of parts) {
    for (const j of matchJobs(jobs, part)) {
      if (!seen.has(j.id)) { seen.add(j.id); out.push(j); }
    }
  }
  return out;
}

// ── Public helpers ─────────────────────────────────────────────────────────────
export function money(pence: number): string {
  if (pence < 100) return `${pence}p`;
  return `£${(pence / 100).toFixed(2)}`;
}
export function childNames(): string[] {
  return kids();
}
/** Resolve a loose child reference ("poppy", "billy") to the canonical name. */
export function resolveChild(input: string): string | null {
  const p = (input || '').trim().toLowerCase();
  return kids().find((k) => k.toLowerCase() === p || k.toLowerCase().startsWith(p.slice(0, 4))) ?? null;
}

export async function getConfig(): Promise<PMConfig> {
  return read();
}
export function jobsForChildOn(cfg: PMConfig, child: string, dateStr: string): Job[] {
  const weekday = isWeekday(dateStr);
  return cfg.jobs.filter((j) => j.child === child && (j.days === 'daily' || weekday));
}

export interface TodayProgress { done: number; total: number; pence: number; remaining: string[]; }
export async function todayProgress(child: string, dateStr = todayStr()): Promise<TodayProgress> {
  const cfg = await read();
  const jobs = jobsForChildOn(cfg, child, dateStr);
  const doneIds = new Set(cfg.completions[dateStr]?.[child] ?? []);
  const doneJobs = jobs.filter((j) => doneIds.has(j.id));
  return {
    done: doneJobs.length,
    total: jobs.length,
    pence: earnedPence(cfg, child, doneJobs.length, dateStr),
    remaining: jobs.filter((j) => !doneIds.has(j.id)).map((j) => j.name),
  };
}

/** A day's jobs for a child (default today), each with whether it's ticked off. */
export async function todayChecklist(child: string, dateStr = todayStr()): Promise<Array<{ name: string; done: boolean }>> {
  const cfg = await read();
  const doneIds = new Set(cfg.completions[dateStr]?.[child] ?? []);
  return jobsForChildOn(cfg, child, dateStr).map((j) => ({ name: j.name, done: doneIds.has(j.id) }));
}

/** Saturday (week start) of the pay-week containing dateStr. */
function weekStartOf(dateStr: string): string {
  return fullWeekDates(dateStr)[0]!;
}
/** Good-behaviour pence still awarded this week (starts full, docked for bad behaviour). */
function behaviourAwarded(cfg: PMConfig, child: string, dateStr: string): number {
  const full = behaviourWeekly(cfg);
  const override = cfg.behaviour?.[weekStartOf(dateStr)]?.[child];
  const v = override == null ? full : override;
  return Math.max(0, Math.min(full, Math.round(v)));
}

// pence: total for the week (jobs + behaviour). jobsPence / behaviourPence break it down.
export interface WeekProgress { count: number; jobsPence: number; behaviourPence: number; pence: number; }
export async function weekProgress(child: string, dateStr = todayStr()): Promise<WeekProgress> {
  const cfg = await read();
  const byId = new Map(cfg.jobs.map((j) => [j.id, j]));
  let count = 0;
  for (const date of weekDates(dateStr)) {
    for (const id of cfg.completions[date]?.[child] ?? []) {
      if (byId.has(id)) count++;
    }
  }
  const jobsPence = earnedPence(cfg, child, count, dateStr);
  const behaviourPence = behaviourAwarded(cfg, child, dateStr);
  return { count, jobsPence, behaviourPence, pence: jobsPence + behaviourPence };
}

/** Change how much good behaviour is worth per week (in pence) for every child. */
export async function setBehaviourWeekly(pence: number): Promise<void> {
  await mutate((cfg) => { cfg.behaviourWeeklyPence = Math.max(0, Math.round(pence)); });
}
export async function getBehaviourWeekly(): Promise<number> {
  return behaviourWeekly(await read());
}
/** Dock this week's good-behaviour money for a child: 'all' or an amount in pence. */
export async function dockBehaviour(child: string, amount: 'all' | number, dateStr = todayStr()): Promise<{ ok: boolean; nowPence: number; fullPence: number }> {
  return mutate((cfg) => {
    const ws = weekStartOf(dateStr);
    const full = behaviourWeekly(cfg);
    const current = behaviourAwarded(cfg, child, dateStr);
    const next = amount === 'all' ? 0 : Math.max(0, current - Math.round(amount));
    cfg.behaviour ??= {};
    cfg.behaviour[ws] ??= {};
    cfg.behaviour[ws][child] = next;
    return { ok: true, nowPence: next, fullPence: full };
  });
}
/** Restore a child's good-behaviour money to the full weekly amount. */
export async function restoreBehaviour(child: string, dateStr = todayStr()): Promise<number> {
  return mutate((cfg) => {
    const ws = weekStartOf(dateStr);
    if (cfg.behaviour?.[ws]) delete cfg.behaviour[ws][child];
    return behaviourWeekly(cfg);
  });
}

/** Mark job(s) done for a child on `dateStr` (default today). `phrase` = 'all' or
 *  a loose job description. Pass an earlier date to backfill a forgotten day. */
export async function markDone(child: string, phrase: string, dateStr = todayStr()): Promise<{ ok: boolean; matched: string[]; alreadyDone: string[] }> {
  return mutate((cfg) => {
    const active = jobsForChildOn(cfg, child, dateStr);
    const target = /\ball\b|everything|the lot/i.test(phrase) ? active : matchList(active, phrase);
    if (target.length === 0) return { ok: false, matched: [], alreadyDone: [] };

    cfg.completions[dateStr] ??= {};
    cfg.completions[dateStr][child] ??= [];
    const set = new Set(cfg.completions[dateStr][child]);
    const matched: string[] = [], alreadyDone: string[] = [];
    for (const j of target) {
      if (set.has(j.id)) alreadyDone.push(j.name);
      else { set.add(j.id); matched.push(j.name); }
    }
    cfg.completions[dateStr][child] = [...set];
    return { ok: true, matched, alreadyDone };
  });
}

/** Un-tick job(s) done on `dateStr` (default today) — a mis-tap or a correction. */
export async function undoDone(child: string, phrase: string, dateStr = todayStr()): Promise<{ ok: boolean; undone: string[] }> {
  return mutate((cfg) => {
    const done = cfg.completions[dateStr]?.[child];
    if (!done || done.length === 0) return { ok: false, undone: [] };
    const active = jobsForChildOn(cfg, child, dateStr);
    const target = /\ball\b|everything/i.test(phrase) ? active : matchList(active, phrase);
    const removeIds = new Set(target.map((j) => j.id));
    const undone = cfg.jobs.filter((j) => done.includes(j.id) && removeIds.has(j.id)).map((j) => j.name);
    cfg.completions[dateStr][child] = done.filter((id) => !removeIds.has(id));
    return { ok: undone.length > 0, undone };
  });
}

/** Add or update a job for a child (or 'both'). */
export async function addJob(child: string, name: string, valuePence?: number, days: JobDays = 'daily'): Promise<string[]> {
  return mutate((cfg) => {
    const targets = child.toLowerCase() === 'both' || child.toLowerCase() === 'all' ? kids() : [child];
    const added: string[] = [];
    for (const c of targets) {
      const id = jobId(c, name);
      const existing = cfg.jobs.find((j) => j.id === id);
      if (existing) {
        if (valuePence != null) existing.valuePence = valuePence;
        existing.days = days;
      } else {
        cfg.jobs.push({ id, child: c, name: name.trim(), valuePence: valuePence ?? DEFAULT_VALUE, days });
      }
      added.push(c);
    }
    return added;
  });
}
export async function removeJob(child: string, phrase: string): Promise<string[]> {
  return mutate((cfg) => {
    const targets = child.toLowerCase() === 'both' || child.toLowerCase() === 'all' ? kids() : [child];
    const removed: string[] = [];
    for (const c of targets) {
      const match = matchList(cfg.jobs.filter((j) => j.child === c), phrase);
      for (const j of match) { removed.push(`${c}: ${j.name}`); }
      const ids = new Set(match.map((j) => j.id));
      cfg.jobs = cfg.jobs.filter((j) => !ids.has(j.id));
    }
    return removed;
  });
}
/** The weekly JOBS target each child can earn from jobs (£4). */
export async function getWeeklyTarget(): Promise<number> {
  return targetPence(await read());
}
/** The full weekly pocket money (jobs target + good-behaviour amount) — e.g. £5. */
export async function getFullWeekly(): Promise<number> {
  const cfg = await read();
  return targetPence(cfg) + behaviourWeekly(cfg);
}
/** Set the weekly JOBS target (in pence) for every child. */
export async function setWeeklyTarget(pence: number): Promise<void> {
  await mutate((cfg) => { cfg.jobsTargetPence = Math.max(0, Math.round(pence)); });
}

/** Text summary of the current jobs + today's/week's progress, for prompts/ground truth. */
export async function describeState(dateStr = todayStr()): Promise<string> {
  const cfg = await read();
  const isToday = dateStr === todayStr();
  const dayWord = isToday ? 'today' : `on ${dayLabel(dateStr)}`;
  const lines: string[] = [];
  const jobsTarget = targetPence(cfg);
  const behFull = behaviourWeekly(cfg);
  for (const child of kids()) {
    const t = await todayProgress(child, dateStr);
    const w = await weekProgress(child, dateStr);
    const jobs = jobsForChildOn(cfg, child, dateStr);
    const doneIds = new Set(cfg.completions[dateStr]?.[child] ?? []);
    const list = jobs.map((j) => `${doneIds.has(j.id) ? '✓' : '○'} ${j.name}`).join(', ');
    const remaining = t.remaining.length ? ` Still to do ${dayWord}: ${t.remaining.join(', ')}.` : ` All done ${dayWord}.`;
    const behNote = w.behaviourPence >= behFull ? `behaviour ${money(behFull)} (full)` : `behaviour ${money(w.behaviourPence)} of ${money(behFull)} (some docked)`;
    lines.push(`${child}: ${dayWord} ${t.done}/${t.total} jobs done. This week earned ${money(w.pence)} of ${money(jobsTarget + behFull)} — ${money(w.jobsPence)} jobs (of ${money(jobsTarget)}) + ${behNote}. Jobs ${dayWord} — ${list || 'none'}.${remaining}`);
  }
  return `Weekly pocket money: ${money(jobsTarget)} from jobs + ${money(behFull)} good behaviour = ${money(jobsTarget + behFull)} max each.\n${lines.join('\n')}`;
}

export interface PayoutRow { child: string; pence: number; jobsPence: number; behaviourPence: number; count: number; }
/** Full Sat–Fri totals for the payout summary (jobs + good behaviour). */
export async function weeklyPayout(dateStr = todayStr()): Promise<PayoutRow[]> {
  const cfg = await read();
  const byId = new Map(cfg.jobs.map((j) => [j.id, j]));
  return kids().map((child) => {
    let count = 0;
    for (const date of fullWeekDates(dateStr)) {
      for (const id of cfg.completions[date]?.[child] ?? []) {
        if (byId.has(id)) count++;
      }
    }
    const jobsPence = earnedPence(cfg, child, count, dateStr);
    const behaviourPence = behaviourAwarded(cfg, child, dateStr);
    return { child, pence: jobsPence + behaviourPence, jobsPence, behaviourPence, count };
  });
}

export async function isConfigured(): Promise<boolean> {
  const cfg = await read();
  return cfg.jobs.length > 0;
}

/** The Sunday payout message for Telegram, or null if nothing was earned. */
export async function payoutMessage(): Promise<string | null> {
  const rows = await weeklyPayout();
  if (!rows.some((r) => r.pence > 0)) return null;
  const full = await getFullWeekly();
  const lines = rows.map((r) => `• ${r.child}: *${money(r.pence)}* of ${money(full)}  (${money(r.jobsPence)} jobs + ${money(r.behaviourPence)} behaviour)`);
  const total = rows.reduce((s, r) => s + r.pence, 0);
  return `💰 *Pocket money — this week*\n\n${lines.join('\n')}\n\nTotal to pay out: *${money(total)}*. Great work this week! 🌟`;
}

// ── Spoken announcements (for Alexa / Voice Monkey) ──────────────────────────
// Plain spoken-word text: no emoji, no markdown, amounts read as words so the
// Echo doesn't say "three eight p". Each returns null when there's nothing worth
// saying (jobs not set up, or no jobs today).

/** Amount as natural speech: 38 → "38 pence", 500 → "5 pounds", 214 → "2 pounds 14". */
function spokenAmount(pence: number): string {
  if (pence <= 0) return 'nothing yet';
  const pounds = Math.floor(pence / 100);
  const rem = pence % 100;
  if (pounds === 0) return `${rem} pence`;
  const p = `${pounds} pound${pounds === 1 ? '' : 's'}`;
  return rem === 0 ? p : `${p} ${rem}`;
}

/** Join a list for speech: ["a","b","c"] → "a, b and c". */
function speakList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Morning call-out of each child's jobs for today. */
export async function morningJobsSpeech(): Promise<string | null> {
  if (!(await isConfigured())) return null;
  const parts: string[] = [];
  for (const child of childNames()) {
    const list = await todayChecklist(child);
    if (list.length === 0) continue;
    const todo = list.filter((j) => !j.done).map((j) => j.name.toLowerCase());
    parts.push(todo.length === 0
      ? `${child}, you're already all done, amazing!`
      : `${child}, today you've got: ${speakList(todo)}.`);
  }
  if (parts.length === 0) return null;
  const target = await getWeeklyTarget();
  return `Good morning! Here are today's jobs. ${parts.join(' ')} Do them all to earn your ${spokenAmount(target)} this week. Have a great day!`;
}

/** Teatime nudge of what each child still has left today. */
export async function teatimeNudgeSpeech(): Promise<string | null> {
  if (!(await isConfigured())) return null;
  const parts: string[] = [];
  let anyOutstanding = false;
  for (const child of childNames()) {
    const list = await todayChecklist(child);
    if (list.length === 0) continue;
    const todo = list.filter((j) => !j.done).map((j) => j.name.toLowerCase());
    if (todo.length === 0) {
      parts.push(`${child}, you're all done for today, brilliant!`);
    } else {
      anyOutstanding = true;
      parts.push(`${child}, you've still got: ${speakList(todo)}.`);
    }
  }
  if (parts.length === 0) return null;
  const tail = anyOutstanding
    ? ' Get them ticked off before bed to earn your pocket money. Nice work so far!'
    : ' Fantastic effort today!';
  return `Jobs check! ${parts.join(' ')}${tail}`;
}

/** Payday shout-out of what each child earned this week. */
export async function paydaySpeech(): Promise<string | null> {
  const rows = await weeklyPayout();
  if (!rows.some((r) => r.pence > 0)) return null;
  const parts = rows.filter((r) => r.pence > 0).map((r) => `${r.child} earned ${spokenAmount(r.pence)}`);
  return `It's payday! This week, ${speakList(parts)}. Great work this week, keep it up!`;
}

/** Short day label, e.g. "Fri 11 Sep". */
function shortDay(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone,
  });
}

/**
 * Deterministic review of the current pay-week so far: for each day from the
 * week start up to AND INCLUDING today, what each child missed (or, for today,
 * what's still to do). Computed here — never leave the day-by-day reckoning to
 * the model, which mislabels the days. Returns a Telegram-ready message, or null
 * if jobs aren't set up / no days yet.
 */
export async function weekMissedMessage(dateStr = todayStr()): Promise<string | null> {
  if (!(await isConfigured())) return null;
  const days = fullWeekDates(dateStr).filter((d) => d <= dateStr); // Sat..today
  if (days.length === 0) return null;

  const kids = childNames();
  const lines: string[] = [];
  for (const d of days) {
    const isToday = d === dateStr;
    const perKid: string[] = [];
    let anyJobs = false;
    for (const child of kids) {
      const p = await todayProgress(child, d);
      if (p.total === 0) continue; // e.g. weekend, weekday-only jobs
      anyJobs = true;
      if (p.remaining.length) perKid.push(`   • ${child}: ${p.remaining.join(', ')}`);
    }
    if (!anyJobs) continue;
    const label = `${shortDay(d)}${isToday ? ' (today)' : ''}`;
    if (perKid.length) {
      lines.push(`*${label}* — ${isToday ? 'still to do' : 'missed'}:\n${perKid.join('\n')}`);
    } else {
      lines.push(`*${label}* — all done ✅`);
    }
  }
  if (lines.length === 0) return null;

  const full = await getFullWeekly();
  const totals = await Promise.all(
    kids.map(async (c) => {
      const w = await weekProgress(c, dateStr);
      return `${c} *${money(w.pence)}* (${money(w.jobsPence)} jobs + ${money(w.behaviourPence)} behaviour)`;
    }),
  );
  const range = days.length === 1 ? shortDay(days[0]!) : `${shortDay(days[0]!)} – ${shortDay(days[days.length - 1]!)}`;
  return `🗓️ *This week's jobs so far* (${range})\n\n${lines.join('\n')}\n\n💰 So far: ${totals.join(' · ')} (of ${money(full)} each). If they actually did any of these, just tell me and I'll add it before payday 🌟`;
}
