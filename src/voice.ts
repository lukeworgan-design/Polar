import { config } from './config';

// Alexa "speak out loud" via Voice Monkey (https://voicemonkey.io).
//
// Voice Monkey is a free Alexa skill that exposes a simple HTTP endpoint to make
// your Echo devices announce arbitrary text — no Amazon skill certification or
// proactive-notifications faff. Rose calls the v3 announce API with a token
// and a device id and the Echo speaks.
//
// Setup (one-off, done in the Amazon Alexa app + voicemonkey.io console):
//   1. Enable the "Voice Monkey" skill in the Alexa app and link your account.
//   2. In the Voice Monkey console, create a device for each Echo you want to
//      speak on and copy its device id.
//   3. Set VOICE_MONKEY_TOKEN and VOICE_MONKEY_DEVICES in the environment.

// Voice Monkey v3 announcement API. (v2 used /announcement + a `text` field on
// api-v2; v3 renames the host to api-v3, the path to /announce and the TTS field
// to `speech`.)
const ANNOUNCE_URL = 'https://api-v3.voicemonkey.io/announce';

export function isVoiceEnabled(): boolean {
  return !!config.voice.token && config.voice.devices.length > 0;
}

/** True if we're currently inside the configured quiet-hours window (family tz). */
export function isInQuietHours(): boolean {
  const q = config.voice.quietHours;
  if (!q || q.start === q.end) return false;
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: config.timezone }).format(new Date()),
    10,
  );
  // Same-day window (e.g. 13-15) vs one that wraps midnight (e.g. 21-7).
  return q.start < q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end;
}

/** A room name matches a spoken target, with a few common aliases. */
function roomMatches(roomName: string, token: string): boolean {
  const alias =
    /^(lounge|living room|front room|sitting room|tv room)$/.test(token) ? 'living'
    : /^(master|master bedroom|our room|main bedroom)$/.test(token) ? 'bedroom'
    : token;
  return roomName.includes(alias) || roomName.includes(token) || alias.includes(roomName);
}

/**
 * Resolve a free-text target ("kitchen", "lounge and bedroom", "all", or
 * undefined) to Voice Monkey device ids plus the friendly room names matched.
 * Undefined / "all" / "everywhere" → every configured room.
 */
export function resolveDevices(target?: string): { ids: string[]; names: string[] } {
  const rooms = config.voice.rooms;
  const t = (target || '').trim().toLowerCase();
  if (!t || /^(all|everyone|everywhere|the house|house|both|whole house)$/.test(t)) {
    return { ids: rooms.map((r) => r.id), names: rooms.map((r) => r.name) };
  }
  const tokens = t.split(/,|\+|&|\band\b/).map((s) => s.trim()).filter(Boolean);
  const picked: typeof rooms = [];
  for (const tok of tokens) {
    for (const room of rooms) {
      // A raw device id passed straight through should also match.
      if (!picked.includes(room) && (room.id.toLowerCase() === tok || roomMatches(room.name, tok))) {
        picked.push(room);
      }
    }
  }
  return { ids: picked.map((r) => r.id), names: picked.map((r) => r.name) };
}

/** All configured room names, for prompts/help. */
export function roomNames(): string[] {
  return config.voice.rooms.map((r) => r.name);
}

/** Strip markdown, emoji and extra whitespace so Alexa reads a clean sentence. */
export function toSpeech(text: string): string {
  return text
    // markdown emphasis / code / links
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // strip emoji and pictographs (Alexa either ignores or mis-reads them)
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** List the device ids registered in the Voice Monkey account (for setup/diagnosis). */
export async function listVoiceDevices(): Promise<{ ok: boolean; ids: string[]; raw: string; reason?: string }> {
  if (!config.voice.token) {
    return { ok: false, ids: [], raw: '', reason: 'Voice Monkey token not configured (set VOICE_MONKEY_TOKEN)' };
  }
  try {
    // Auth via query param — the Authorization header form gets rejected (401),
    // whereas the token query param works (matches how /announce accepts it).
    const res = await fetch(`https://api-v3.voicemonkey.io/devices?token=${encodeURIComponent(config.voice.token)}`);
    const raw = (await res.text().catch(() => '')).trim();
    if (!res.ok) return { ok: false, ids: [], raw, reason: `HTTP ${res.status}${raw ? ` — ${raw.slice(0, 180)}` : ''}` };
    let ids: string[] = [];
    try {
      const j: any = JSON.parse(raw);
      const arr: any[] = Array.isArray(j) ? j : (j.devices || j.data || []);
      ids = arr
        .map((d: any) => (typeof d === 'string' ? d : (d.device || d.device_id || d.id || d.name)))
        .filter((x: any): x is string => typeof x === 'string' && x.length > 0);
    } catch {
      /* leave ids empty; caller can show raw */
    }
    return { ok: true, ids, raw };
  } catch (err) {
    return { ok: false, ids: [], raw: '', reason: (err as Error).message };
  }
}

interface SpeakResult {
  ok: boolean;
  spokenOn: string[]; // friendly room names
  failed: string[];   // friendly room names
  reason?: string;
}

export interface SpeakOptions {
  /** Room(s) to speak in — name, group, comma list, or raw id. Omit for all rooms. */
  target?: string;
  /** If true, suppress during quiet hours (use for automatic announcements). */
  respectQuietHours?: boolean;
}

/**
 * Announce a message on the configured Echo device(s).
 * Returns which rooms succeeded so callers (and Rose) can report truthfully.
 */
export async function speakOnAlexa(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const speech = toSpeech(text);
  if (!speech) return { ok: false, spokenOn: [], failed: [], reason: 'nothing to say' };
  if (!config.voice.token) {
    return { ok: false, spokenOn: [], failed: [], reason: 'Voice Monkey token not configured (set VOICE_MONKEY_TOKEN)' };
  }
  if (opts.respectQuietHours && isInQuietHours()) {
    return { ok: false, spokenOn: [], failed: [], reason: 'suppressed — quiet hours' };
  }

  const { ids, names } = resolveDevices(opts.target);
  if (ids.length === 0) {
    return {
      ok: false, spokenOn: [], failed: [],
      reason: opts.target
        ? `no room matched "${opts.target}" (rooms: ${roomNames().join(', ') || 'none configured'})`
        : 'no Alexa devices configured (set VOICE_MONKEY_DEVICES)',
    };
  }
  const nameFor = (id: string) => names[ids.indexOf(id)] ?? id;

  const spokenOn: string[] = [];
  const failed: string[] = [];
  let lastDetail = '';

  for (const device of ids) {
    try {
      const payload: Record<string, string> = { device, speech };
      if (config.voice.voiceName) payload['voice'] = config.voice.voiceName;

      // Auth via the token query param (the reliable form — the Authorization
      // header gets rejected). Device/speech go in the JSON body.
      const res = await fetch(`${ANNOUNCE_URL}?token=${encodeURIComponent(config.voice.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.voice.token, ...payload }),
      });
      const bodyText = (await res.text().catch(() => '')).trim();
      const looksError = /"?status"?\s*:\s*"?error|"error"\s*:/i.test(bodyText);
      if (res.ok && !looksError) {
        spokenOn.push(nameFor(device));
      } else {
        failed.push(nameFor(device));
        lastDetail = `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 180)}` : ''}`;
        console.error(`Voice: announcement failed on "${device}": ${lastDetail}`);
      }
    } catch (err) {
      failed.push(nameFor(device));
      lastDetail = (err as Error).message;
      console.error(`Voice: announcement error on "${device}":`, err);
    }
  }

  return {
    ok: spokenOn.length > 0,
    spokenOn,
    failed,
    reason: spokenOn.length === 0 ? (lastDetail || 'all devices failed — check the Voice Monkey token/device ids') : undefined,
  };
}
