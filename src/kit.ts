import { getSetting, setSetting } from './db';
import { normalizeWeekday } from './schoolrun';

// PE / Forest-School "kit needed the night before" schedule for Poppy and Billy.
// A single editable source of truth (stored in app_settings) shared by Rose's
// prompts and the daily summary, so it can't drift like the old hard-coded copy.

export interface KitEntry {
  child: string;    // "Poppy" | "Billy"
  day: string;      // canonical weekday
  activity: string; // "PE" | "Forest School"
  kit?: string;     // what to bring, e.g. "wellies + spare clothes"
}

// Current pattern (Billy's forest school starts next term, so not listed yet).
const DEFAULT_KIT: KitEntry[] = [
  { child: 'Poppy', day: 'Wednesday', activity: 'PE' },
  { child: 'Billy', day: 'Monday', activity: 'PE' },
  { child: 'Billy', day: 'Wednesday', activity: 'PE' },
  { child: 'Poppy', day: 'Thursday', activity: 'Forest School', kit: 'wellies + spare clothes' },
];

const KIT_KEY = 'kit_schedule';

function cap(s: string): string {
  return s.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}
function tidyActivity(s: string): string {
  const t = s.trim();
  return /^pe$/i.test(t) ? 'PE' : cap(t);
}
/** What to physically bring for an entry. */
function kitNoun(e: KitEntry): string {
  return e.kit || (/pe/i.test(e.activity) ? 'PE kit' : 'kit');
}

async function readList(): Promise<KitEntry[]> {
  try {
    const s = await getSetting(KIT_KEY);
    if (s) return JSON.parse(s) as KitEntry[];
  } catch {
    /* fall through to default */
  }
  return DEFAULT_KIT;
}
async function writeList(list: KitEntry[]): Promise<void> {
  await setSetting(KIT_KEY, JSON.stringify(list));
}

export async function getKitForWeekday(weekday: string): Promise<KitEntry[]> {
  const list = await readList();
  return list.filter((e) => e.day.toLowerCase() === weekday.toLowerCase());
}

/** Alert lines for a given weekday, phrased for "today" or "tomorrow". */
export async function kitAlertsFor(weekday: string, when: 'today' | 'tomorrow'): Promise<string[]> {
  const items = await getKitForWeekday(weekday);
  return items.map((e) =>
    when === 'today'
      ? `${e.child} has ${e.activity} today — make sure ${kitNoun(e)} is on them!`
      : `${e.child} has ${e.activity} tomorrow — pack ${kitNoun(e)} tonight.`,
  );
}

/** Add or update a child's activity on a weekday. */
export async function setKit(child: string, day: string, activity: string, kit?: string): Promise<string> {
  const canon = normalizeWeekday(day);
  if (!canon) throw new Error(`"${day}" isn't a weekday`);
  const act = tidyActivity(activity);
  const list = await readList();
  const filtered = list.filter(
    (e) => !(e.child.toLowerCase() === child.toLowerCase() && e.day === canon && e.activity.toLowerCase() === act.toLowerCase()),
  );
  filtered.push({ child: cap(child), day: canon, activity: act, ...(kit ? { kit: kit.trim() } : {}) });
  await writeList(filtered);
  return `${cap(child)}: ${act} on ${canon}`;
}

/** Remove a child's activity on a weekday (omit activity to clear all that day). */
export async function removeKit(child: string, day: string, activity?: string): Promise<string> {
  const canon = normalizeWeekday(day);
  if (!canon) throw new Error(`"${day}" isn't a weekday`);
  const list = await readList();
  const filtered = list.filter(
    (e) => !(e.child.toLowerCase() === child.toLowerCase() && e.day === canon && (!activity || e.activity.toLowerCase() === activity.trim().toLowerCase())),
  );
  await writeList(filtered);
  return `Cleared ${activity ? tidyActivity(activity) : 'activities'} for ${cap(child)} on ${canon}`;
}

export async function resetKit(): Promise<string> {
  await writeList(DEFAULT_KIT);
  return 'Reset the PE / forest-school schedule to the usual pattern.';
}

/** Plain-text summary grouped by child, for prompts. */
export async function describeKit(): Promise<string> {
  const list = await readList();
  if (list.length === 0) return '- (none set)';
  const children = [...new Set(list.map((e) => e.child))];
  return children
    .map((child) => {
      const items = list
        .filter((e) => e.child === child)
        .map((e) => `${e.activity} ${e.day}${e.kit ? ` (${e.kit})` : ''}`);
      return `- ${child}: ${items.join('; ')}`;
    })
    .join('\n');
}
