import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env['Supabase_url']!;
const supabaseKey = process.env['Supabase_key']!;

const db = createClient(supabaseUrl, supabaseKey);

// ── Shopping List ────────────────────────────────────────────────────────────

export async function addShoppingItem(item: string, addedBy: string): Promise<void> {
  await db.from('shopping_list').insert({ item, added_by: addedBy });
}

export async function getShoppingList(): Promise<Array<{ id: number; item: string; added_by: string }>> {
  const { data } = await db
    .from('shopping_list')
    .select('id, item, added_by')
    .eq('completed', false)
    .order('added_at', { ascending: true });
  return data ?? [];
}

export async function removeShoppingItem(item: string): Promise<boolean> {
  const { data } = await db
    .from('shopping_list')
    .select('id')
    .eq('completed', false)
    .ilike('item', `%${item}%`);
  if (!data || data.length === 0) return false;
  await db.from('shopping_list').update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  return true;
}

export async function clearShoppingList(): Promise<number> {
  const { data } = await db.from('shopping_list').select('id').eq('completed', false);
  if (!data || data.length === 0) return 0;
  await db.from('shopping_list').update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  return data.length;
}

// ── To-Do List ───────────────────────────────────────────────────────────────

export async function addTodo(task: string, addedBy: string, dueDate?: string): Promise<void> {
  await db.from('todo_list').insert({ task, added_by: addedBy, due_date: dueDate ?? null });
}

export async function getTodos(): Promise<Array<{ id: number; task: string; added_by: string; due_date: string | null }>> {
  const { data } = await db
    .from('todo_list')
    .select('id, task, added_by, due_date')
    .eq('completed', false)
    .order('added_at', { ascending: true });
  return data ?? [];
}

export async function completeTodo(task: string): Promise<boolean> {
  const { data } = await db
    .from('todo_list')
    .select('id')
    .eq('completed', false)
    .ilike('task', `%${task}%`);
  if (!data || data.length === 0) return false;
  await db.from('todo_list').update({ completed: true, completed_at: new Date().toISOString() })
    .in('id', data.map((r) => r.id));
  return true;
}

// ── Reminders ────────────────────────────────────────────────────────────────

export async function addReminder(userName: string, message: string, remindAt: Date): Promise<void> {
  await db.from('reminders').insert({ user_name: userName, message, remind_at: remindAt.toISOString() });
}

export async function getPendingReminders(): Promise<Array<{ id: number; user_name: string; message: string; remind_at: string }>> {
  const { data } = await db
    .from('reminders')
    .select('id, user_name, message, remind_at')
    .eq('fired', false)
    .lte('remind_at', new Date().toISOString())
    .order('remind_at', { ascending: true });
  return data ?? [];
}

export async function markReminderFired(id: number): Promise<void> {
  await db.from('reminders').update({ fired: true, fired_at: new Date().toISOString() }).eq('id', id);
}

// ── Birthdays ─────────────────────────────────────────────────────────────────

export async function addBirthday(name: string, date: string, relation: string, addedBy: string): Promise<void> {
  await db.from('birthdays').insert({ name, date, relation, added_by: addedBy });
}

export async function getBirthdays(): Promise<Array<{ id: number; name: string; date: string; relation: string | null }>> {
  const { data } = await db.from('birthdays').select('id, name, date, relation').order('date', { ascending: true });
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
  const { data } = await db
    .from('fired_birthday_reminders')
    .select('id')
    .eq('birthday_id', birthdayId)
    .eq('year', year)
    .maybeSingle();
  return !!data;
}

export async function markBirthdayReminderFired(birthdayId: number, year: number): Promise<void> {
  await db.from('fired_birthday_reminders').upsert({ birthday_id: birthdayId, year }, { onConflict: 'birthday_id,year', ignoreDuplicates: true });
}

// ── Conversation Context ──────────────────────────────────────────────────────

export async function addConversationMessage(role: string, content: string, userName?: string): Promise<void> {
  await db.from('conversation_context').insert({ role, content, user_name: userName ?? null });
  // Keep only the last 50 messages
  const { data } = await db
    .from('conversation_context')
    .select('id')
    .order('id', { ascending: false })
    .range(50, 10000);
  if (data && data.length > 0) {
    await db.from('conversation_context').delete().in('id', data.map((r) => r.id));
  }
}

export async function getRecentConversation(limit: number = 20): Promise<Array<{ role: string; content: string; user_name: string | null }>> {
  const { data } = await db
    .from('conversation_context')
    .select('role, content, user_name')
    .order('id', { ascending: false })
    .limit(limit);
  return (data ?? []).reverse();
}

export async function clearConversationContext(): Promise<void> {
  await db.from('conversation_context').delete().neq('id', 0);
}

export default db;
