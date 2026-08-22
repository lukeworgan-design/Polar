import { config } from './config';
import { getSetting, setSetting } from './db';

// Ring doorbell integration (unofficial API). When the bell is pressed we grab a
// snapshot and hold it in memory so the dashboard can flash it on screen. No
// video streaming — just a still image and a timestamp.

let latestDing: { at: number; camera: string } | null = null;
let latestSnapshot: Buffer | null = null;
let latestDingDescription: string | null = null;
let latestMotion: { at: number; camera: string } | null = null;
let motionSnapshot: Buffer | null = null;
let lastMotionSnapAt = 0;
let started = false;
let ringCameras: any[] = [];

const DING_WINDOW_S = 90;
const MOTION_WINDOW_S = 40;
const MOTION_SNAP_THROTTLE_MS = 45_000; // don't grab a motion snapshot more than once per 45s

export function getDoorbellStatus(): {
  active: boolean; at: string | null; agoSeconds: number | null; camera: string | null; hasImage: boolean; description: string | null;
  motionActive: boolean; motionAt: string | null; motionCamera: string | null; motionHasImage: boolean;
} {
  const dingAgo = latestDing ? Math.round((Date.now() - latestDing.at) / 1000) : null;
  const motionAgo = latestMotion ? Math.round((Date.now() - latestMotion.at) / 1000) : null;
  return {
    // Ding: full-screen banner on any recent press, even if the snapshot didn't come through.
    active: dingAgo != null && dingAgo <= DING_WINDOW_S,
    at: latestDing ? new Date(latestDing.at).toISOString() : null,
    agoSeconds: dingAgo,
    camera: latestDing?.camera ?? null,
    hasImage: latestSnapshot != null,
    description: latestDingDescription,
    // Motion: small corner toast, shorter window.
    motionActive: motionAgo != null && motionAgo <= MOTION_WINDOW_S,
    motionAt: latestMotion ? new Date(latestMotion.at).toISOString() : null,
    motionCamera: latestMotion?.camera ?? null,
    motionHasImage: motionSnapshot != null,
  };
}

export function getDoorbellSnapshot(): Buffer | null {
  return latestSnapshot;
}

export function getMotionSnapshot(): Buffer | null {
  return motionSnapshot;
}

/** Record motion; grab a small snapshot but throttled to avoid Ring rate limits. */
async function recordMotion(cam: any): Promise<void> {
  latestMotion = { at: Date.now(), camera: cam.name };
  if (Date.now() - lastMotionSnapAt > MOTION_SNAP_THROTTLE_MS) {
    lastMotionSnapAt = Date.now();
    try {
      motionSnapshot = await cam.getSnapshot();
    } catch (err) {
      console.error('Ring: motion snapshot failed:', err);
    }
  }
}

/** Record a ding now and try to grab a snapshot — used by real presses and the test endpoint. */
/** Pull any human-readable AI/text description Ring includes in a push notification. */
function extractRingDescription(n: any): string | null {
  if (!n) return null;
  const candidates = [
    n?.aps?.alert?.body,
    n?.android_config?.body,
    n?.description,
    n?.ding?.description,
    n?.data?.description,
    n?.event?.description,
    n?.body,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && !/is at your front door|motion detected/i.test(c)) return c.trim();
  }
  return null;
}

async function recordDing(cameraName: string, cam?: any, ringDescription?: string): Promise<void> {
  latestDing = { at: Date.now(), camera: cameraName };
  // Prefer Ring's own summary (it can name familiar faces); Claude vision is the fallback.
  latestDingDescription = ringDescription && ringDescription.trim() ? ringDescription.trim() : null;
  if (latestDingDescription) console.log(`Ring: using Ring's description — ${latestDingDescription}`);
  const target = cam ?? ringCameras[0];
  if (target) {
    try {
      latestSnapshot = await target.getSnapshot();
      console.log('Ring: snapshot captured.');
      if (!latestDingDescription && latestSnapshot) {
        try {
          const { describeDoorbellImage } = await import('./ai');
          latestDingDescription = await describeDoorbellImage(latestSnapshot);
          if (latestDingDescription) console.log(`Ring: Claude description — ${latestDingDescription}`);
        } catch (err) {
          console.error('Ring: description failed:', err);
        }
      }
    } catch (err) {
      console.error('Ring: snapshot failed:', err);
    }
  }
}

/** Manually trigger the doorbell overlay (for testing the dashboard side). */
export async function triggerTestDing(): Promise<string> {
  if (ringCameras.length === 0) {
    latestDing = { at: Date.now(), camera: 'Test' };
    return 'Test ding fired, but no Ring camera is connected (banner will show without a photo).';
  }
  await recordDing(`${ringCameras[0].name} (test)`, ringCameras[0]);
  return `Test ding fired for "${ringCameras[0].name}"${latestSnapshot ? ' with a snapshot' : ' (snapshot failed)'}. Check the dashboard.`;
}

export async function initRing(): Promise<void> {
  if (started) return;

  // Token precedence:
  //  - If the RING_REFRESH_TOKEN env var has changed since we last bootstrapped,
  //    the user has provided a NEW token — use it and reset our stored copy.
  //  - Otherwise use the stored (rotated) token, since Ring rotates on each use.
  const envToken = (config.ringRefreshToken || '').trim();
  let stored: string | null = null;
  let envSeed: string | null = null;
  try {
    stored = await getSetting('ring_refresh_token');
    envSeed = await getSetting('ring_env_seed');
  } catch {
    // app_settings may not exist yet — that's fine
  }

  let token = '';
  let source = '';
  if (envToken && envToken !== (envSeed || '').trim()) {
    // Fresh env token — take over and remember which env value seeded it.
    token = envToken;
    source = 'env (new)';
    try {
      await setSetting('ring_refresh_token', envToken);
      await setSetting('ring_env_seed', envToken);
    } catch { /* non-fatal */ }
  } else if (stored && stored.trim()) {
    token = stored.trim();
    source = 'stored (rotated)';
  } else if (envToken) {
    token = envToken;
    source = 'env';
  }

  if (!token) {
    console.log('Ring: no RING_REFRESH_TOKEN set — doorbell snapshots disabled.');
    return;
  }
  console.log(`Ring: authenticating with token from ${source}, length ${token.length}.`);

  try {
    // Loaded lazily and untyped (non-literal specifier) so the build never
    // depends on the heavy ring-client-api package — it's an optional dep.
    const specifier = 'ring-client-api';
    const ringModule: any = await import(specifier).catch(() => null);
    if (!ringModule || !ringModule.RingApi) {
      console.log('Ring: ring-client-api not available — doorbell snapshots disabled.');
      return;
    }
    const { RingApi } = ringModule;
    const ringApi: any = new RingApi({ refreshToken: token, cameraStatusPollingSeconds: 20 });

    // Persist rotated refresh tokens so restarts keep working.
    ringApi.onRefreshTokenUpdated.subscribe(async ({ newRefreshToken }: { newRefreshToken: string }) => {
      try {
        await setSetting('ring_refresh_token', newRefreshToken);
      } catch (err) {
        console.error('Ring: failed to persist rotated refresh token:', err);
      }
    });

    const cameras: any[] = await ringApi.getCameras();
    if (cameras.length === 0) {
      console.log('Ring: connected but found no cameras.');
      return;
    }
    ringCameras = cameras;

    for (const cam of cameras) {
      // Primary: dedicated doorbell-press event.
      cam.onDoorbellPressed.subscribe(async () => {
        console.log(`Ring: doorbell pressed on "${cam.name}"`);
        await recordDing(cam.name, cam);
      });
      // Motion — grabs a throttled snapshot so the toast can show a small thumbnail.
      if (cam.onMotionDetected && cam.onMotionDetected.subscribe) {
        cam.onMotionDetected.subscribe(async (motion: any) => {
          if (motion) {
            console.log(`Ring: motion detected on "${cam.name}"`);
            await recordMotion(cam);
          }
        });
      }
      // Fallback + diagnostics: log every push notification and route ding/motion.
      if (cam.onNewNotification && cam.onNewNotification.subscribe) {
        cam.onNewNotification.subscribe(async (notification: any) => {
          const kind = String(notification?.subtype ?? notification?.ding?.subtype ?? notification?.action ?? 'unknown').toLowerCase();
          const ringDesc = extractRingDescription(notification);
          console.log(`Ring: notification on "${cam.name}" — kind: ${kind}${ringDesc ? `, desc: ${ringDesc}` : ''}`);
          // One-off structure dump to discover where Ring puts its AI text.
          try { console.log('Ring: notification payload:', JSON.stringify(notification).slice(0, 600)); } catch { /* ignore */ }
          if (kind.includes('ding')) {
            await recordDing(cam.name, cam, ringDesc ?? undefined);
          } else if (kind.includes('motion')) {
            await recordMotion(cam);
          }
        });
      }
    }

    started = true;
    console.log(`Ring: listening for doorbell presses on ${cameras.length} camera(s): ${cameras.map((c: any) => c.name).join(', ')}`);
  } catch (err) {
    console.error('Ring: failed to initialise (bad token or API change?):', err);
  }
}
