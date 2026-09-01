import { config } from './config';

// Alexa "speak out loud" via Voice Monkey (https://voicemonkey.io).
//
// Voice Monkey is a free Alexa skill that exposes a simple HTTP endpoint to make
// your Echo devices announce arbitrary text — no Amazon skill certification or
// proactive-notifications faff. Rose calls the v2 announcement API with a token
// and a device id and the Echo speaks.
//
// Setup (one-off, done in the Amazon Alexa app + voicemonkey.io console):
//   1. Enable the "Voice Monkey" skill in the Alexa app and link your account.
//   2. In the Voice Monkey console, create a device for each Echo you want to
//      speak on and copy its device id.
//   3. Set VOICE_MONKEY_TOKEN and VOICE_MONKEY_DEVICES in the environment.

const ANNOUNCE_URL = 'https://api-v2.voicemonkey.io/announcement';

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

  for (const device of devices) {
    try {
      const params = new URLSearchParams({
        token: config.voice.token,
        device,
        text: speech,
      });
      if (config.voice.voiceName) params.set('voice', config.voice.voiceName);

      const res = await fetch(`${ANNOUNCE_URL}?${params.toString()}`, { method: 'POST' });
      const bodyText = await res.text().catch(() => '');
      if (res.ok && !/error/i.test(bodyText)) {
        spokenOn.push(device);
      } else {
        failed.push(device);
        console.error(`Voice: announcement failed on "${device}" (${res.status}): ${bodyText.slice(0, 200)}`);
      }
    } catch (err) {
      failed.push(device);
      console.error(`Voice: announcement error on "${device}":`, err);
    }
  }

  return {
    ok: spokenOn.length > 0,
    spokenOn,
    failed,
    reason: spokenOn.length === 0 ? 'all devices failed — check the Voice Monkey token/device ids' : undefined,
  };
}
