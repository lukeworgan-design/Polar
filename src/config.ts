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

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    groupId: requireEnv('TELEGRAM_GROUP_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-20250514',
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
  family: {
    children: [
      // Set POPPY_DOB / BILLY_DOB (YYYY-MM-DD) in the environment to the real
      // dates of birth so ages stay accurate automatically. Defaults below
      // produce the current ages (Poppy 7, Billy 5) but are placeholders.
      { name: 'Poppy', dob: process.env['POPPY_DOB'] || '2018-09-01' },
      { name: 'Billy', dob: process.env['BILLY_DOB'] || '2020-09-01' },
    ],
    babyDue: process.env['BABY_DUE_DATE'] || '2026-08-17',
  },
  // Bin collection — Cheltenham BC alternates general/recycling fortnightly on Thursdays.
  // Set BIN_REFERENCE_DATE to any known Friday collection date (YYYY-MM-DD) and
  // BIN_REFERENCE_TYPE to the bin that went out that day ('general' or 'recycling').
  bin: {
    referenceDate: process.env['BIN_REFERENCE_DATE'] || '2026-06-05',
    referenceType: (process.env['BIN_REFERENCE_TYPE'] || 'general') as 'general' | 'recycling',
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
