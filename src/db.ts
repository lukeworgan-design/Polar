import { createClient } from '@supabase/supabase-js';
import { config } from './config';

const db = createClient(config.supabase.url, config.supabase.key);

// ── Shopping List ────────────────────────────────────────────────────────────

export async function addShoppingItem(item: string, addedBy: string): Promise<void> {
  const { error } = await db.from('shopping_list').insert({ item, added_by: addedBy });
  if (error) throw new Error(`DB addShoppingItem failed: ${error.message}`);
}

export async function getShoppingList(): Promise<Array<{ id: number; item: string; added_by: string }>> {
  const { data, error } = await db
    .from('shopping_list')
    .select('id, item, added_by')
    .eq('completed', false)
    .order('added_at', { ascending: true });
  if (error) throw new Error(`DB getShoppingList failed: ${error.message}`);
  return data ?? [];
}

export async function removeShoppingItem(item: string): Promise<boolean> {
  const { data, error } = await db
    .from('shopping_list')
    .select('id')
    .eq('completed', false)
    .ilike('item', `%${item}%`);
  if (error) throw new Error(`DB removeShoppingItem failed: ${error.message}`);
  if (!data || data.length === 0) return false;
  const { error: updError } = await db.from('shopping_list')
    .update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  if (updError) throw new Error(`DB removeShoppingItem update failed: ${updError.message}`);
  return true;
}

export async function clearShoppingList(): Promise<number> {
  const { data, error } = await db.from('shopping_list').select('id').eq('completed', false);
  if (error) throw new Error(`DB clearShoppingList failed: ${error.message}`);
  if (!data || data.length === 0) return 0;
  const { error: updError } = await db.from('shopping_list')
    .update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  if (updError) throw new Error(`DB clearShoppingList update failed: ${updError.message}`);
  return data.length;
}

// ── To-Do List ───────────────────────────────────────────────────────────────

export async function addTodo(task: string, addedBy: string, dueDate?: string): Promise<void> {
  const { error } = await db.from('todo_list').insert({ task, added_by: addedBy, due_date: dueDate ?? null });
  if (error) throw new Error(`DB addTodo failed: ${error.message}`);
}

export async function getTodos(): Promise<Array<{ id: number; task: string; added_by: string; due_date: string | null }>> {
  const { data, error } = await db
    .from('todo_list')
    .select('id, task, added_by, due_date')
    .eq('completed', false)
    .order('added_at', { ascending: true });
  if (error) throw new Error(`DB getTodos failed: ${error.message}`);
  return data ?? [];
}

export async function completeTodo(task: string): Promise<boolean> {
  const { data, error } = await db
    .from('todo_list')
    .select('id')
    .eq('completed', false)
    .ilike('task', `%${task}%`);
  if (error) throw new Error(`DB completeTodo failed: ${error.message}`);
  if (!data || data.length === 0) return false;
  const { error: updError } = await db.from('todo_list')
    .update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  if (updError) throw new Error(`DB completeTodo update failed: ${updError.message}`);
  return true;
}

// ── Reminders ────────────────────────────────────────────────────────────────

export async function addReminder(userName: string, message: string, remindAt: Date): Promise<void> {
  const { error } = await db.from('reminders').insert({ user_name: userName, message, remind_at: remindAt.toISOString() });
  if (error) throw new Error(`DB addReminder failed: ${error.message}`);
}

export async function getPendingReminders(): Promise<Array<{ id: number; user_name: string; message: string; remind_at: string }>> {
  const { data, error } = await db
    .from('reminders')
    .select('id, user_name, message, remind_at')
    .eq('fired', false)
    .lte('remind_at', new Date().toISOString())
    .order('remind_at', { ascending: true });
  if (error) throw new Error(`DB getPendingReminders failed: ${error.message}`);
  return data ?? [];
}

export async function markReminderFired(id: number): Promise<void> {
  const { error } = await db.from('reminders').update({ fired: true, fired_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`DB markReminderFired failed: ${error.message}`);
}

// ── Birthdays ─────────────────────────────────────────────────────────────────

export async function addBirthday(name: string, date: string, relation: string, addedBy: string): Promise<void> {
  const { error } = await db.from('birthdays').insert({ name, date, relation, added_by: addedBy });
  if (error) throw new Error(`DB addBirthday failed: ${error.message}`);
}

export async function getBirthdays(): Promise<Array<{ id: number; name: string; date: string; relation: string | null }>> {
  const { data, error } = await db.from('birthdays').select('id, name, date, relation').order('date', { ascending: true });
  if (error) throw new Error(`DB getBirthdays failed: ${error.message}`);
  return data ?? [];
}

export async function getUpcomingBirthdays(daysAhead: number = 14): Promise<Array<{ id: number; name: string; date: string; relation: string | null; days_until: number }>> {
  const birthdays = await getBirthdays();
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

export async function hasBirthdayReminderFired(birthdayId: number, year: number): Promise<boolean> {
  const { data, error } = await db
    .from('fired_birthday_reminders')
    .select('id')
    .eq('birthday_id', birthdayId)
    .eq('year', year)
    .maybeSingle();
  if (error) throw new Error(`DB hasBirthdayReminderFired failed: ${error.message}`);
  return !!data;
}

export async function markBirthdayReminderFired(birthdayId: number, year: number): Promise<void> {
  const { error } = await db.from('fired_birthday_reminders')
    .upsert({ birthday_id: birthdayId, year }, { onConflict: 'birthday_id,year', ignoreDuplicates: true });
  if (error) throw new Error(`DB markBirthdayReminderFired failed: ${error.message}`);
}

// ── Fired Notifications (generic, restart-safe dedupe) ─────────────────────────
// Used for event reminders and holiday-activity nudges so they survive redeploys.
// Requires a Supabase table:
//   create table fired_notifications (key text primary key, fired_at timestamptz default now());

export async function hasNotificationFired(key: string): Promise<boolean> {
  const { data, error } = await db.from('fired_notifications').select('key').eq('key', key).maybeSingle();
  if (error) throw new Error(`DB hasNotificationFired failed: ${error.message}`);
  return !!data;
}

export async function markNotificationFired(key: string): Promise<void> {
  const { error } = await db.from('fired_notifications')
    .upsert({ key }, { onConflict: 'key', ignoreDuplicates: true });
  if (error) throw new Error(`DB markNotificationFired failed: ${error.message}`);
}

// ── Meal Plan ─────────────────────────────────────────────────────────────────

export type MealType = 'breakfast' | 'lunch' | 'dinner';

export interface MealEntry {
  id: number;
  date: string;        // YYYY-MM-DD
  meal_type: MealType;
  meal: string;
  added_by: string | null;
}

export async function setMeal(date: string, mealType: MealType, meal: string, addedBy: string): Promise<void> {
  const { error } = await db.from('meal_plan').upsert(
    { date, meal_type: mealType, meal, added_by: addedBy },
    { onConflict: 'date,meal_type' }
  );
  if (error) throw new Error(`DB setMeal failed: ${error.message}`);
}

export async function getMealPlan(startDate: string, endDate: string): Promise<MealEntry[]> {
  const { data, error } = await db
    .from('meal_plan')
    .select('id, date, meal_type, meal, added_by')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })
    .order('meal_type', { ascending: true });
  if (error) throw new Error(`DB getMealPlan failed: ${error.message}`);
  return (data ?? []) as MealEntry[];
}

export async function clearMeal(date: string, mealType: MealType): Promise<boolean> {
  const { data, error } = await db
    .from('meal_plan')
    .select('id')
    .eq('date', date)
    .eq('meal_type', mealType);
  if (error) throw new Error(`DB clearMeal failed: ${error.message}`);
  if (!data || data.length === 0) return false;
  const { error: delError } = await db.from('meal_plan').delete().in('id', data.map((r) => r.id));
  if (delError) throw new Error(`DB clearMeal delete failed: ${delError.message}`);
  return true;
}

// ── Conversation Context ──────────────────────────────────────────────────────

const CONVERSATION_KEEP = 50;

export async function addConversationMessage(role: string, content: string, userName?: string): Promise<void> {
  const { error } = await db.from('conversation_context').insert({ role, content, user_name: userName ?? null });
  if (error) throw new Error(`DB addConversationMessage failed: ${error.message}`);

  // Trim to the most recent CONVERSATION_KEEP rows. Fetch the IDs beyond the
  // keep window (capped) and delete them.
  const { data: stale, error: selError } = await db
    .from('conversation_context')
    .select('id')
    .order('id', { ascending: false })
    .range(CONVERSATION_KEEP, CONVERSATION_KEEP + 200);
  if (selError) throw new Error(`DB conversation trim select failed: ${selError.message}`);
  if (stale && stale.length > 0) {
    const { error: delError } = await db.from('conversation_context').delete().in('id', stale.map((r) => r.id));
    if (delError) throw new Error(`DB conversation trim delete failed: ${delError.message}`);
  }
}

export async function getRecentConversation(limit: number = 20): Promise<Array<{ role: string; content: string; user_name: string | null }>> {
  const { data, error } = await db
    .from('conversation_context')
    .select('role, content, user_name')
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`DB getRecentConversation failed: ${error.message}`);
  return (data ?? []).reverse();
}

export async function clearConversationContext(): Promise<void> {
  const { error } = await db.from('conversation_context').delete().neq('id', 0);
  if (error) throw new Error(`DB clearConversationContext failed: ${error.message}`);
}

// ── Baby Checklist ─────────────────────────────────────────────────────────────

export interface BabyChecklistItem {
  id: number;
  item: string;
  category: string | null;
}

export async function addBabyChecklistItem(item: string, addedBy: string, category?: string): Promise<void> {
  const { error } = await db.from('baby_checklist').insert({ item, added_by: addedBy, category: category ?? null });
  if (error) throw new Error(`DB addBabyChecklistItem failed: ${error.message}`);
}

export async function getBabyChecklist(): Promise<BabyChecklistItem[]> {
  const { data, error } = await db
    .from('baby_checklist')
    .select('id, item, category')
    .eq('completed', false)
    .order('added_at', { ascending: true });
  if (error) throw new Error(`DB getBabyChecklist failed: ${error.message}`);
  return (data ?? []) as BabyChecklistItem[];
}

export async function completeBabyChecklistItem(item: string): Promise<boolean> {
  const { data, error } = await db
    .from('baby_checklist')
    .select('id')
    .eq('completed', false)
    .ilike('item', `%${item}%`);
  if (error) throw new Error(`DB completeBabyChecklistItem failed: ${error.message}`);
  if (!data || data.length === 0) return false;
  const { error: updError } = await db.from('baby_checklist')
    .update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  if (updError) throw new Error(`DB completeBabyChecklistItem update failed: ${updError.message}`);
  return true;
}

// ── App Settings (generic key/value) ───────────────────────────────────────────
// Requires a Supabase table:
//   create table app_settings (key text primary key, value text, updated_at timestamptz default now());

export async function getSetting(key: string): Promise<string | null> {
  const { data, error } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(`DB getSetting failed: ${error.message}`);
  return data?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const { error } = await db.from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`DB setSetting failed: ${error.message}`);
}

export default db;
