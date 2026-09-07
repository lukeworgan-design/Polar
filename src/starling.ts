// Read-only Starling Bank lookup — used (for now) to display the kids' Space
// balances and to diagnose which spaces a personal access token can see.
//
// Setup: create a *personal access token* in the Starling developer portal
// (developer.starlingbank.com → Personal Access), scoped read-only —
// account:read, balance:read, space:read, savings-goal:read — and set it as
// STARLING_TOKEN in the environment. The token can only read; it can't move
// money. Everything here is GET-only.

const API_BASE = 'https://api.starlingbank.com/api/v2';

function token(): string | null {
  return (process.env['STARLING_TOKEN'] || '').trim() || null;
}

export function isStarlingEnabled(): boolean {
  return !!token();
}

async function api(path: string): Promise<{ ok: boolean; status: number; json?: any; text: string }> {
  const t = token();
  if (!t) return { ok: false, status: 0, text: 'no token' };
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
  });
  const text = (await res.text().catch(() => '')).trim();
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* leave undefined; caller can show text */ }
  return { ok: res.ok, status: res.status, json, text };
}

function describeErr(r: { status: number; text: string }): string {
  if (r.status === 403) return 'access denied (403) — the token is missing a scope (needs account:read, space:read and savings-goal:read)';
  if (r.status === 401) return 'unauthorised (401) — the token is invalid, expired, or revoked';
  if (r.status === 0) return 'no Starling token set (STARLING_TOKEN)';
  return `HTTP ${r.status}${r.text ? ` — ${r.text.slice(0, 160)}` : ''}`;
}

export function gbp(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export type SpaceKind = 'spending' | 'saving';
export interface StarlingSpace {
  name: string;
  balancePence: number;
  kind: SpaceKind;
  account: string; // friendly account label the space sits under
}

export interface SpacesResult {
  ok: boolean;
  spaces: StarlingSpace[];
  reason?: string;
  raw?: string; // first account's raw /spaces JSON, for diagnosing odd structures (e.g. under-16s)
}

/** List every Space (spending + saving) the token can see, across all accounts. */
export async function listSpaces(): Promise<SpacesResult> {
  if (!token()) return { ok: false, spaces: [], reason: 'no Starling token set (STARLING_TOKEN)' };

  const accts = await api('/accounts');
  if (!accts.ok) return { ok: false, spaces: [], reason: describeErr(accts) };
  const accounts: any[] = (accts.json as any)?.accounts ?? [];
  if (accounts.length === 0) return { ok: false, spaces: [], reason: 'the token returned no accounts' };

  const spaces: StarlingSpace[] = [];
  let raw: string | undefined;
  for (const acc of accounts) {
    const uid = acc.accountUid;
    const label = acc.name || acc.accountType || 'account';
    const sp = await api(`/account/${uid}/spaces`);
    if (raw === undefined) raw = sp.text.slice(0, 800);
    if (!sp.ok) continue; // skip an account we can't read rather than failing the lot
    const j = sp.json as any;
    for (const s of (j?.spendingSpaces ?? [])) {
      spaces.push({ name: s.name ?? 'Space', balancePence: s.balance?.minorUnits ?? 0, kind: 'spending', account: label });
    }
    for (const g of (j?.savingsGoals ?? [])) {
      spaces.push({ name: g.name ?? 'Goal', balancePence: g.totalSaved?.minorUnits ?? 0, kind: 'saving', account: label });
    }
  }
  return { ok: true, spaces, raw };
}

/** Balance (in pence) of the first space whose name matches `name` (case-insensitive). */
export async function spaceBalanceByName(name: string): Promise<number | null> {
  const r = await listSpaces();
  if (!r.ok) return null;
  const want = name.trim().toLowerCase();
  const hit = r.spaces.find((s) => s.name.trim().toLowerCase() === want);
  return hit ? hit.balancePence : null;
}

// Cached name→pence map so the 90s dashboard refresh doesn't hammer the API.
let cache: { at: number; map: Record<string, number> } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** lowercased space name → balance (pence), cached ~5 min. On a failed read,
 *  returns the last good map if we have one, else an empty map — never throws. */
export async function spaceBalances(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const r = await listSpaces();
  if (!r.ok) return cache?.map ?? {};
  const map: Record<string, number> = {};
  for (const s of r.spaces) map[s.name.trim().toLowerCase()] = s.balancePence;
  cache = { at: Date.now(), map };
  return map;
}
