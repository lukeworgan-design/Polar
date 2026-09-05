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
}

const KEY = 'pocket_money';
const DEFAULT_VALUE = 5; // pence per job (easily changed via Rose)

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
  return { jobs, completions: {} };
}

async function read(): Promise<PMConfig> {
  try {
    const s = await getSetting(KEY);
    if (s) {
      const cfg = JSON.parse(s) as PMConfig;
      if (Array.isArray(cfg.jobs)) return { jobs: cfg.jobs, completions: cfg.completions || {} };
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

// ── Dates (family timezone) ────────────────────────────────────────────────────
export function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}
function isWeekday(dateStr: string): boolean {
  const wd = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: config.timezone });
  return wd !== 'Sat' && wd !== 'Sun';
}
/** Dates from Monday of the current week up to `dateStr` (inclusive). */
function weekDates(dateStr: string): string[] {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const sinceMon = (d.getUTCDay() + 6) % 7; // 0 on Monday
  const out: string[] = [];
  for (let i = sinceMon; i >= 0; i--) {
    const dd = new Date(d);
    dd.setUTCDate(d.getUTCDate() - i);
    out.push(dd.toISOString().slice(0, 10));
  }
  return out;
}
/** Full Mon–Sun week containing `dateStr` (for the payout summary). */
function fullWeekDates(dateStr: string): string[] {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const sinceMon = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - sinceMon);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(monday);
    dd.setUTCDate(monday.getUTCDate() + i);
    out.push(dd.toISOString().slice(0, 10));
  }
  return out;
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
export async function todayProgress(child: string): Promise<TodayProgress> {
  const cfg = await read();
  const today = todayStr();
  const jobs = jobsForChildOn(cfg, child, today);
  const doneIds = new Set(cfg.completions[today]?.[child] ?? []);
  const doneJobs = jobs.filter((j) => doneIds.has(j.id));
  return {
    done: doneJobs.length,
    total: jobs.length,
    pence: doneJobs.reduce((s, j) => s + j.valuePence, 0),
    remaining: jobs.filter((j) => !doneIds.has(j.id)).map((j) => j.name),
  };
}

export interface WeekProgress { count: number; pence: number; }
export async function weekProgress(child: string, dateStr = todayStr()): Promise<WeekProgress> {
  const cfg = await read();
  const byId = new Map(cfg.jobs.map((j) => [j.id, j]));
  let pence = 0, count = 0;
  for (const date of weekDates(dateStr)) {
    for (const id of cfg.completions[date]?.[child] ?? []) {
      const job = byId.get(id);
      if (job) { pence += job.valuePence; count++; }
    }
  }
  return { count, pence };
}

/** Mark job(s) done today for a child. `phrase` = 'all' or a loose job description. */
export async function markDone(child: string, phrase: string): Promise<{ ok: boolean; matched: string[]; alreadyDone: string[] }> {
  const cfg = await read();
  const today = todayStr();
  const active = jobsForChildOn(cfg, child, today);
  const target = /\ball\b|everything|the lot/i.test(phrase) ? active : matchList(active, phrase);
  if (target.length === 0) return { ok: false, matched: [], alreadyDone: [] };

  cfg.completions[today] ??= {};
  cfg.completions[today][child] ??= [];
  const set = new Set(cfg.completions[today][child]);
  const matched: string[] = [], alreadyDone: string[] = [];
  for (const j of target) {
    if (set.has(j.id)) alreadyDone.push(j.name);
    else { set.add(j.id); matched.push(j.name); }
  }
  cfg.completions[today][child] = [...set];
  await write(cfg);
  return { ok: true, matched, alreadyDone };
}

/** Un-tick job(s) done today (a mis-tap). */
export async function undoDone(child: string, phrase: string): Promise<{ ok: boolean; undone: string[] }> {
  const cfg = await read();
  const today = todayStr();
  const done = cfg.completions[today]?.[child];
  if (!done || done.length === 0) return { ok: false, undone: [] };
  const active = jobsForChildOn(cfg, child, today);
  const target = /\ball\b|everything/i.test(phrase) ? active : matchList(active, phrase);
  const removeIds = new Set(target.map((j) => j.id));
  const undone = cfg.jobs.filter((j) => done.includes(j.id) && removeIds.has(j.id)).map((j) => j.name);
  cfg.completions[today][child] = done.filter((id) => !removeIds.has(id));
  await write(cfg);
  return { ok: undone.length > 0, undone };
}

/** Add or update a job for a child (or 'both'). */
export async function addJob(child: string, name: string, valuePence?: number, days: JobDays = 'daily'): Promise<string[]> {
  const cfg = await read();
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
  await write(cfg);
  return added;
}
export async function removeJob(child: string, phrase: string): Promise<string[]> {
  const cfg = await read();
  const targets = child.toLowerCase() === 'both' || child.toLowerCase() === 'all' ? kids() : [child];
  const removed: string[] = [];
  for (const c of targets) {
    const match = matchList(cfg.jobs.filter((j) => j.child === c), phrase);
    for (const j of match) { removed.push(`${c}: ${j.name}`); }
    const ids = new Set(match.map((j) => j.id));
    cfg.jobs = cfg.jobs.filter((j) => !ids.has(j.id));
  }
  await write(cfg);
  return removed;
}
/** Set the pence value — for one matched job, or all jobs if phrase is 'all'/empty. */
export async function setValue(pence: number, phrase = 'all', child?: string): Promise<number> {
  const cfg = await read();
  const scope = child ? cfg.jobs.filter((j) => j.child === child) : cfg.jobs;
  const targets = /^all$|^every|^each/i.test(phrase.trim()) || !phrase.trim() ? scope : matchJobs(scope, phrase);
  for (const j of targets) j.valuePence = pence;
  await write(cfg);
  return targets.length;
}

/** Text summary of the current jobs + today's/week's progress, for prompts/ground truth. */
export async function describeState(): Promise<string> {
  const cfg = await read();
  const today = todayStr();
  const lines: string[] = [];
  for (const child of kids()) {
    const t = await todayProgress(child);
    const w = await weekProgress(child, today);
    const jobs = jobsForChildOn(cfg, child, today);
    const doneIds = new Set(cfg.completions[today]?.[child] ?? []);
    const list = jobs.map((j) => `${doneIds.has(j.id) ? '✓' : '○'} ${j.name} (${money(j.valuePence)})`).join(', ');
    lines.push(`${child}: today ${t.done}/${t.total} done (${money(t.pence)}), this week ${money(w.pence)}. Jobs today — ${list || 'none'}`);
  }
  return lines.join('\n');
}

export interface PayoutRow { child: string; pence: number; count: number; }
/** Full Mon–Sun totals for the payout summary. */
export async function weeklyPayout(dateStr = todayStr()): Promise<PayoutRow[]> {
  const cfg = await read();
  const byId = new Map(cfg.jobs.map((j) => [j.id, j]));
  return kids().map((child) => {
    let pence = 0, count = 0;
    for (const date of fullWeekDates(dateStr)) {
      for (const id of cfg.completions[date]?.[child] ?? []) {
        const job = byId.get(id);
        if (job) { pence += job.valuePence; count++; }
      }
    }
    return { child, pence, count };
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
  const lines = rows.map((r) => `• ${r.child}: *${money(r.pence)}* (${r.count} job${r.count === 1 ? '' : 's'})`);
  const total = rows.reduce((s, r) => s + r.pence, 0);
  return `💰 *Pocket money — this week*\n\n${lines.join('\n')}\n\nTotal to pay out: *${money(total)}*. Great work this week! 🌟`;
}
