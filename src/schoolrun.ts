import { config } from './config';
import { getSetting, setSetting } from './db';

// The school-run rota — a single source of truth shared by the wall dashboard
// and all of Rose's prompts, so they can never drift apart again. It's editable
// at runtime (via Rose in chat) and stored in app_settings.
//
//  - The BASELINE is the normal weekly pattern (persisted overrides on top of the
//    default below).
//  - OVERRIDES are one-off changes for a specific date ("Grandma's doing Thursday
//    this week"); past ones are pruned automatically.

// Default baseline while Toni is on maternity leave — she covers most runs.
const DEFAULT_ROTA: Record<string, string> = {
  Monday: 'Toni: drop-off + pick-up',
  Tuesday: 'Toni: drop-off + pick-up',
  Wednesday: 'Toni — clubs, later pick-up',
  Thursday: 'Toni: drop-off + pick-up',
  Friday: 'Toni: drop-off + pick-up',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ROTA_KEY = 'school_run_rota';          // JSON: baseline changes layered over DEFAULT_ROTA
const OVERRIDE_KEY = 'school_run_overrides';  // JSON: { 'YYYY-MM-DD': note } one-offs

/** Normalise a free-form day to a canonical weekday name, or null. */
export function normalizeWeekday(input: string): string | null {
  const s = (input || '').trim().toLowerCase();
  return WEEKDAYS.find((d) => d.toLowerCase() === s || d.toLowerCase().startsWith(s.slice(0, 3))) ?? null;
}

function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

function weekdayOf(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: config.timezone });
}

async function readJson(key: string): Promise<Record<string, string>> {
  try {
    const s = await getSetting(key);
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
async function writeJson(key: string, obj: Record<string, string>): Promise<void> {
  await setSetting(key, JSON.stringify(obj));
}

/** The effective weekly baseline (default with any persisted changes on top). */
export async function getBaselineRota(): Promise<Record<string, string>> {
  return { ...DEFAULT_ROTA, ...(await readJson(ROTA_KEY)) };
}

/** Upcoming one-off overrides (today onwards); prunes past dates as a side effect. */
export async function getUpcomingOverrides(): Promise<Record<string, string>> {
  const all = await readJson(OVERRIDE_KEY);
  const today = todayStr();
  const kept = Object.fromEntries(Object.entries(all).filter(([d]) => d >= today));
  if (Object.keys(kept).length !== Object.keys(all).length) await writeJson(OVERRIDE_KEY, kept);
  return kept;
}

/** Who's doing the run on a given date — a one-off override wins over the baseline. */
export async function getRunForDate(dateStr: string): Promise<string | null> {
  const overrides = await getUpcomingOverrides();
  if (overrides[dateStr]) return overrides[dateStr];
  const rota = await getBaselineRota();
  return rota[weekdayOf(dateStr)] ?? null;
}

/** Change the normal pattern for a weekday. */
export async function setBaselineDay(day: string, note: string): Promise<string> {
  const canon = normalizeWeekday(day);
  if (!canon) throw new Error(`"${day}" isn't a weekday`);
  const stored = await readJson(ROTA_KEY);
  stored[canon] = note.trim();
  await writeJson(ROTA_KEY, stored);
  return canon;
}

/** Record a one-off change for a specific date (YYYY-MM-DD). */
export async function setOverrideForDate(dateStr: string, note: string): Promise<void> {
  const o = await readJson(OVERRIDE_KEY);
  o[dateStr] = note.trim();
  await writeJson(OVERRIDE_KEY, o);
}

/** Clear a one-off (by date), reset a weekday to default (by day), or reset everything. */
export async function resetSchoolRun(opts: { day?: string; date?: string }): Promise<string> {
  if (opts.date) {
    const o = await readJson(OVERRIDE_KEY);
    delete o[opts.date];
    await writeJson(OVERRIDE_KEY, o);
    return `Cleared the one-off for ${opts.date}.`;
  }
  if (opts.day) {
    const canon = normalizeWeekday(opts.day);
    if (!canon) throw new Error(`"${opts.day}" isn't a weekday`);
    const stored = await readJson(ROTA_KEY);
    delete stored[canon];
    await writeJson(ROTA_KEY, stored);
    return `Reset ${canon} to the normal rota (${DEFAULT_ROTA[canon]}).`;
  }
  await writeJson(ROTA_KEY, {});
  await writeJson(OVERRIDE_KEY, {});
  return 'Reset the whole school-run rota back to the normal pattern.';
}

/** A plain-text summary of the current rota + upcoming one-offs, for prompts/ground truth. */
export async function describeRota(): Promise<string> {
  const rota = await getBaselineRota();
  const lines = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
    .map((d) => `- ${d}: ${rota[d] ?? 'not set'}`);
  const overrides = await getUpcomingOverrides();
  const overrideLines = Object.entries(overrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, note]) => {
      const label = new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
      });
      return `- ${label} (${date}): ${note}  ← one-off, overrides the usual`;
    });
  let out = lines.join('\n');
  if (overrideLines.length) out += `\nOne-off changes coming up:\n${overrideLines.join('\n')}`;
  return out;
}
