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
    const res = await fetch('https://api-v3.voicemonkey.io/devices', {
      headers: { 'Authorization': config.voice.token },
    });
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
  spokenOn: string[];
  failed: string[];
  reason?: string;
}

/**
 * Announce a message on the configured Echo device(s).
 * Returns which devices succeeded so callers (and Rose) can report truthfully.
 */
export async function speakOnAlexa(text: string, deviceOverride?: string): Promise<SpeakResult> {
  const speech = toSpeech(text);
  if (!speech) return { ok: false, spokenOn: [], failed: [], reason: 'nothing to say' };
  if (!config.voice.token) {
    return { ok: false, spokenOn: [], failed: [], reason: 'Voice Monkey token not configured (set VOICE_MONKEY_TOKEN)' };
  }

  const devices = deviceOverride ? [deviceOverride] : config.voice.devices;
  if (devices.length === 0) {
    return { ok: false, spokenOn: [], failed: [], reason: 'no Alexa devices configured (set VOICE_MONKEY_DEVICES)' };
  }

  const spokenOn: string[] = [];
  const failed: string[] = [];
  let lastDetail = '';

  for (const device of devices) {
    try {
      const payload: Record<string, string> = { device, speech };
      if (config.voice.voiceName) payload['voice'] = config.voice.voiceName;

      // v3 wants a JSON body with the token in an Authorization header (raw
      // token, not "Bearer ..."). Sending token in the body too is harmless.
      const res = await fetch(ANNOUNCE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': config.voice.token,
        },
        body: JSON.stringify({ token: config.voice.token, ...payload }),
      });
      const bodyText = (await res.text().catch(() => '')).trim();
      const looksError = /"?status"?\s*:\s*"?error|"error"\s*:/i.test(bodyText);
      if (res.ok && !looksError) {
        spokenOn.push(device);
      } else {
        failed.push(device);
        lastDetail = `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 180)}` : ''}`;
        console.error(`Voice: announcement failed on "${device}": ${lastDetail}`);
      }
    } catch (err) {
      failed.push(device);
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
