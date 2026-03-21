import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env['DB_PATH'] || path.join(process.cwd(), 'data', 'rose.db');

// Ensure the data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS shopping_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed INTEGER DEFAULT 0,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS todo_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    due_date TEXT,
    completed INTEGER DEFAULT 0,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT NOT NULL,
    message TEXT NOT NULL,
    remind_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    fired INTEGER DEFAULT 0,
    fired_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS birthdays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    relation TEXT,
    added_by TEXT NOT NULL,
    advance_reminder_days INTEGER DEFAULT 14
  );

  CREATE TABLE IF NOT EXISTS conversation_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    user_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fired_birthday_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    birthday_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    fired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(birthday_id, year)
  );
`);

// ── Shopping List ────────────────────────────────────────────────────────────

export function addShoppingItem(item: string, addedBy: string): void {
  db.prepare('INSERT INTO shopping_list (item, added_by) VALUES (?, ?)').run(item, addedBy);
}

export function getShoppingList(): Array<{ id: number; item: string; added_by: string }> {
  return db.prepare('SELECT id, item, added_by FROM shopping_list WHERE completed = 0 ORDER BY added_at ASC').all() as Array<{ id: number; item: string; added_by: string }>;
}

export function removeShoppingItem(item: string): boolean {
  const result = db.prepare(
    "UPDATE shopping_list SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE completed = 0 AND item LIKE ?"
  ).run(`%${item}%`);
  return result.changes > 0;
}

export function clearShoppingList(): number {
  const result = db.prepare("UPDATE shopping_list SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE completed = 0").run();
  return result.changes;
}

// ── To-Do List ───────────────────────────────────────────────────────────────

export function addTodo(task: string, addedBy: string, dueDate?: string): void {
  db.prepare('INSERT INTO todo_list (task, added_by, due_date) VALUES (?, ?, ?)').run(task, addedBy, dueDate || null);
}

export function getTodos(): Array<{ id: number; task: string; added_by: string; due_date: string | null }> {
  return db.prepare('SELECT id, task, added_by, due_date FROM todo_list WHERE completed = 0 ORDER BY added_at ASC').all() as Array<{ id: number; task: string; added_by: string; due_date: string | null }>;
}

export function completeTodo(task: string): boolean {
  const result = db.prepare(
    "UPDATE todo_list SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE completed = 0 AND task LIKE ?"
  ).run(`%${task}%`);
  return result.changes > 0;
}

// ── Reminders ────────────────────────────────────────────────────────────────

export function addReminder(userName: string, message: string, remindAt: Date): void {
  db.prepare('INSERT INTO reminders (user_name, message, remind_at) VALUES (?, ?, ?)').run(
    userName,
    message,
    remindAt.toISOString()
  );
}

export function getPendingReminders(): Array<{ id: number; user_name: string; message: string; remind_at: string }> {
  return db.prepare(
    "SELECT id, user_name, message, remind_at FROM reminders WHERE fired = 0 AND remind_at <= datetime('now') ORDER BY remind_at ASC"
  ).all() as Array<{ id: number; user_name: string; message: string; remind_at: string }>;
}

export function markReminderFired(id: number): void {
  db.prepare("UPDATE reminders SET fired = 1, fired_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

// ── Birthdays ─────────────────────────────────────────────────────────────────

export function addBirthday(name: string, date: string, relation: string, addedBy: string): void {
  db.prepare('INSERT INTO birthdays (name, date, relation, added_by) VALUES (?, ?, ?, ?)').run(name, date, relation, addedBy);
}

export function getBirthdays(): Array<{ id: number; name: string; date: string; relation: string | null }> {
  return db.prepare('SELECT id, name, date, relation FROM birthdays ORDER BY date ASC').all() as Array<{ id: number; name: string; date: string; relation: string | null }>;
}

export function getUpcomingBirthdays(daysAhead: number = 14): Array<{ id: number; name: string; date: string; relation: string | null; days_until: number }> {
  const birthdays = getBirthdays();
  const now = new Date();
  const results: Array<{ id: number; name: string; date: string; relation: string | null; days_until: number }> = [];

  for (const b of birthdays) {
    const [, month, day] = b.date.split('-').map(Number);
    const thisYear = new Date(now.getFullYear(), (month as number) - 1, day as number);
    const nextYear = new Date(now.getFullYear() + 1, (month as number) - 1, day as number);

    const upcoming = thisYear >= now ? thisYear : nextYear;
    const diffMs = upcoming.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays <= daysAhead) {
      results.push({ ...b, days_until: diffDays });
    }
  }

  return results.sort((a, b) => a.days_until - b.days_until);
}

export function hasBirthdayReminderFired(birthdayId: number, year: number): boolean {
  const row = db.prepare('SELECT id FROM fired_birthday_reminders WHERE birthday_id = ? AND year = ?').get(birthdayId, year);
  return !!row;
}

export function markBirthdayReminderFired(birthdayId: number, year: number): void {
  db.prepare('INSERT OR IGNORE INTO fired_birthday_reminders (birthday_id, year) VALUES (?, ?)').run(birthdayId, year);
}

// ── Conversation Context ──────────────────────────────────────────────────────

export function addConversationMessage(role: string, content: string, userName?: string): void {
  db.prepare('INSERT INTO conversation_context (role, content, user_name) VALUES (?, ?, ?)').run(role, content, userName || null);
  // Keep only the last 50 messages to avoid unbounded growth
  db.prepare(`
    DELETE FROM conversation_context WHERE id NOT IN (
      SELECT id FROM conversation_context ORDER BY id DESC LIMIT 50
    )
  `).run();
}

export function getRecentConversation(limit: number = 20): Array<{ role: string; content: string; user_name: string | null }> {
  return db.prepare(
    'SELECT role, content, user_name FROM conversation_context ORDER BY id DESC LIMIT ?'
  ).all(limit).reverse() as Array<{ role: string; content: string; user_name: string | null }>;
}

export function clearConversationContext(): void {
  db.prepare('DELETE FROM conversation_context').run();
}

export default db;
