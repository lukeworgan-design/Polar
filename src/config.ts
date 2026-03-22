import dotenv from 'dotenv';
dotenv.config();

export interface UserConfig {
  id: number;
  name: string;
}

export interface ChildConfig {
  name: string;
  age: number;
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

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    groupId: requireEnv('TELEGRAM_GROUP_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-20250514',
  },
  google: {
    credentialsJson: requireEnv('GOOGLE_CREDENTIALS_JSON'),
    tokenJson: process.env['GOOGLE_TOKEN_JSON'] || null,
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
  family: {
    children: [
      { name: 'Poppy', age: 7 },
      { name: 'Billy', age: 5 },
    ],
    babyDue: '2026-08-17',
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
