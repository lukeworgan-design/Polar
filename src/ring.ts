import { config } from './config';
import { getSetting, setSetting } from './db';

// Ring doorbell integration (unofficial API). When the bell is pressed we grab a
// snapshot and hold it in memory so the dashboard can flash it on screen. No
// video streaming — just a still image and a timestamp.

let latestDing: { at: number; camera: string } | null = null;
let latestSnapshot: Buffer | null = null;
let started = false;

export function getDoorbellStatus(): { active: boolean; at: string | null; agoSeconds: number | null; camera: string | null } {
  if (!latestDing) return { active: false, at: null, agoSeconds: null, camera: null };
  const agoSeconds = Math.round((Date.now() - latestDing.at) / 1000);
  return {
    active: agoSeconds <= 90 && latestSnapshot != null,
    at: new Date(latestDing.at).toISOString(),
    agoSeconds,
    camera: latestDing.camera,
  };
}

export function getDoorbellSnapshot(): Buffer | null {
  return latestSnapshot;
}

export async function initRing(): Promise<void> {
  if (started) return;

  // Prefer a token persisted from a previous run (Ring rotates them), fall back to env.
  let token: string | null = null;
  try {
    token = await getSetting('ring_refresh_token');
  } catch {
    // app_settings may not exist yet — that's fine
  }
  token = (token || config.ringRefreshToken || '').trim();
  if (!token) {
    console.log('Ring: no RING_REFRESH_TOKEN set — doorbell snapshots disabled.');
    return;
  }

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

    for (const cam of cameras) {
      cam.onDoorbellPressed.subscribe(async () => {
        console.log(`Ring: doorbell pressed on "${cam.name}"`);
        latestDing = { at: Date.now(), camera: cam.name };
        try {
          latestSnapshot = await cam.getSnapshot();
        } catch (err) {
          console.error('Ring: snapshot failed:', err);
        }
      });
    }

    started = true;
    console.log(`Ring: listening for doorbell presses on ${cameras.length} camera(s): ${cameras.map((c: any) => c.name).join(', ')}`);
  } catch (err) {
    console.error('Ring: failed to initialise (bad token or API change?):', err);
  }
}
