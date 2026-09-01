import dotenv from 'dotenv';
dotenv.config();

export interface UserConfig {
  id: number;
  name: string;
}

export interface ChildConfig {
  name: string;
  dob: string; // ISO date string (YYYY-MM-DD)
}

export interface FamilyConfig {
  children: ChildConfig[];
  babyDue: string; // ISO date string
  babyBorn: string | null; // ISO date string once the baby has arrived
  babyName: string | null;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Accurate current age from a date of birth (accounts for whether the birthday has passed this year). */
export function ageFromDob(dob: string): number {
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

/** Normalise a date string to YYYY-MM-DD. Accepts YYYY-MM-DD as-is and UK
 *  DD/MM/YY(YY) (with / - or . separators); falls back if it can't parse. */
export function normalizeIsoDate(input: string, fallback: string): string {
  const s = (input || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) {
    const dd = m[1]!.padStart(2, '0');
    const mm = m[2]!.padStart(2, '0');
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${year}-${mm}-${dd}`;
  }
  return fallback;
}

/** Normalise a bin type from free-form input to 'general' | 'recycling'. */
export function normalizeBinType(input: string): 'general' | 'recycling' {
  const s = (input || '').trim().toLowerCase();
  if (s.includes('recycl') || s.includes('blue')) return 'recycling';
  return 'general';
}

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    groupId: requireEnv('TELEGRAM_GROUP_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-5',
  },
  supabase: {
    url: requireEnv('Supabase_url'),
    key: requireEnv('Supabase_key'),
  },
  google: {
    credentialsJson: process.env['GOOGLE_CREDENTIALS_JSON'] || '{}',
    tokenJson: process.env['GOOGLE_TOKEN_JSON'] || null,
    serviceAccountJson: process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] || null,
    calendarId: process.env['GOOGLE_CALENDAR_ID']?.trim() || null,
    calendarName: 'Family',
  },
  users: {
    luke: {
      id: parseInt(process.env['TELEGRAM_USER_ID_LUKE'] || '0', 10),
      name: 'Luke',
    },
    toni: {
      id: parseInt(process.env['TELEGRAM_USER_ID_TONI'] || '0', 10),
      name: 'Toni',
    },
  },
  timezone: process.env['TIMEZONE'] || 'Europe/London',
  location: process.env['FAMILY_LOCATION'] || 'Cheltenham, Gloucestershire',
  braveSearchApiKey: process.env['BRAVE_SEARCH_API_KEY'] || null,
  openaiApiKey: process.env['OPENAI_API_KEY'] || null,
  // Secret token guarding the family TV dashboard (served at /dashboard?token=...).
  // Set DASHBOARD_TOKEN in the environment to any long random string.
  dashboardToken: process.env['DASHBOARD_TOKEN'] || null,
  // Title shown at the top of the dashboard. Set DASHBOARD_TITLE to rename it.
  dashboardTitle: process.env['DASHBOARD_TITLE'] || 'The Worgan Family',
  // Optional full-screen background image URL for the dashboard (a public image
  // URL — e.g. a family photo). Shown dimmed behind the cards. Leave unset for
  // the default gradient.
  dashboardBgUrl: process.env['DASHBOARD_BG_URL'] || null,
  // Alexa skill ID (amzn1.ask.skill.…) — set ALEXA_SKILL_ID so the /alexa
  // endpoint only answers requests from your own skill.
  alexaSkillId: process.env['ALEXA_SKILL_ID'] || null,
  // Ring doorbell — set RING_REFRESH_TOKEN (generated with ring-auth-cli) to
  // show a snapshot on the dashboard when the bell is pressed.
  ringRefreshToken: process.env['RING_REFRESH_TOKEN'] || null,
  // Alexa "speak out loud" via Voice Monkey (voicemonkey.io). Install the free
  // Voice Monkey skill, link it to your Amazon account, then:
  //  - VOICE_MONKEY_TOKEN   → your account token from the Voice Monkey console
  //  - VOICE_MONKEY_DEVICES → comma-separated device id(s) you created there
  //                           (e.g. "kitchen-echo,living-room"). Rose announces
  //                           to every device listed.
  // Leave unset to disable Alexa speech (everything else keeps working).
  voice: {
    token: process.env['VOICE_MONKEY_TOKEN']?.trim() || null,
    devices: (process.env['VOICE_MONKEY_DEVICES'] || process.env['VOICE_MONKEY_DEVICE'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Announce doorbell presses aloud on the Echo(s). On by default when voice is
    // configured; set VOICE_ANNOUNCE_DOORBELL=false to keep the door quiet.
    announceDoorbell: process.env['VOICE_ANNOUNCE_DOORBELL'] !== 'false',
    // Optional Amazon voice to use (e.g. "Amy", "Brian"). Leave unset for default.
    voiceName: process.env['VOICE_MONKEY_VOICE']?.trim() || null,
  },
  family: {
    children: [
      // Set POPPY_DOB / BILLY_DOB (YYYY-MM-DD) in the environment to the real
      // dates of birth so ages stay accurate automatically. Defaults below
      // produce the current ages (Poppy 7, Billy 5) but are placeholders.
      { name: 'Poppy', dob: process.env['POPPY_DOB'] || '2018-09-01' },
      { name: 'Billy', dob: process.env['BILLY_DOB'] || '2020-09-01' },
    ],
    babyDue: process.env['BABY_DUE_DATE'] || '2026-08-10',
    // Evie arrived on 10 August 2026. This switches Rose out of pregnancy/
    // countdown mode — no more due-date nudges or "any twinges?" — and into
    // newborn mode. Overridable via BABY_BORN_DATE / BABY_NAME env vars.
    babyBorn: process.env['BABY_BORN_DATE'] || '2026-08-10',
    babyName: process.env['BABY_NAME'] || 'Evie',
    // Optional manual holiday ranges [start, endExclusive]. The Family Google
    // Calendar is the primary source — Rose reads holiday/half-term/INSET events
    // from there. This list is just a belt-and-braces fallback; leave it empty
    // to rely purely on the calendar, or add ranges if a break isn't showing up.
    schoolHolidays: [
      { name: 'Summer holidays 2026', start: '2026-07-22', end: '2026-09-03' },
    ] as Array<{ name: string; start: string; end: string }>,
  },
  // Bin collection — Cheltenham BC alternates general/recycling fortnightly on Thursdays.
  // Set BIN_REFERENCE_DATE to any known Friday collection date (YYYY-MM-DD) and
  // BIN_REFERENCE_TYPE to the bin that went out that day ('general' or 'recycling').
  bin: {
    referenceDate: normalizeIsoDate(process.env['BIN_REFERENCE_DATE'] || '', '2026-06-05'),
    referenceType: normalizeBinType(process.env['BIN_REFERENCE_TYPE'] || 'general'),
  },
};

export function getUserByTelegramId(telegramId: number): UserConfig | null {
  if (config.users.luke.id && telegramId === config.users.luke.id) {
    return config.users.luke;
  }
  if (config.users.toni.id && telegramId === config.users.toni.id) {
    return config.users.toni;
  }
  return null;
}

export function getUserName(telegramId: number): string {
  const user = getUserByTelegramId(telegramId);
  return user ? user.name : 'there';
}
