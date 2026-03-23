import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import {
  getRecentConversation,
  addConversationMessage,
  getShoppingList,
  getTodos,
  getBirthdays,
} from './db';
import {
  getEventsForPeriod,
  getTodaysEvents,
  getUpcomingEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findEventsByKeyword,
  checkConflicts,
  formatEventsForAI,
  CalendarEvent,
} from './calendar';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── Tool definitions ──────────────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: 'get_todays_events',
    description: "Get all calendar events for today from the Family calendar",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_events_for_period',
    description: "Get calendar events for a specific date range",
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'ISO date string for period start' },
        end_date: { type: 'string', description: 'ISO date string for period end' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_upcoming_events',
    description: "Get upcoming events for the next N days",
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Number of days to look ahead (default 7)' },
      },
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description: "Create a new event in the Family calendar",
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Event title/name' },
        start_datetime: { type: 'string', description: 'ISO datetime string for start' },
        end_datetime: { type: 'string', description: 'ISO datetime string for end' },
        description: { type: 'string', description: 'Optional event description' },
        location: { type: 'string', description: 'Optional event location' },
        all_day: { type: 'boolean', description: 'Whether this is an all-day event' },
        recurrence_rule: { type: 'string', description: 'RRULE string for recurring events e.g. RRULE:FREQ=WEEKLY;BYDAY=SA' },
      },
      required: ['summary', 'start_datetime', 'end_datetime'],
    },
  },
  {
    name: 'update_calendar_event',
    description: "Update an existing calendar event (move it, rename it, etc.)",
    input_schema: {
      type: 'object' as const,
      properties: {
        event_keyword: { type: 'string', description: 'Keyword to search for the event to update' },
        summary: { type: 'string', description: 'New event title (optional)' },
        start_datetime: { type: 'string', description: 'New start datetime ISO string (optional)' },
        end_datetime: { type: 'string', description: 'New end datetime ISO string (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        location: { type: 'string', description: 'New location (optional)' },
      },
      required: ['event_keyword'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: "Delete a calendar event",
    input_schema: {
      type: 'object' as const,
      properties: {
        event_keyword: { type: 'string', description: 'Keyword to search for the event to delete' },
      },
      required: ['event_keyword'],
    },
  },
  {
    name: 'get_shopping_list',
    description: "Get the current family shopping list",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_shopping_item',
    description: "Add an item to the shopping list",
    input_schema: {
      type: 'object' as const,
      properties: {
        item: { type: 'string', description: 'Item to add' },
      },
      required: ['item'],
    },
  },
  {
    name: 'remove_shopping_item',
    description: "Remove or tick off an item from the shopping list",
    input_schema: {
      type: 'object' as const,
      properties: {
        item: { type: 'string', description: 'Item to remove' },
      },
      required: ['item'],
    },
  },
  {
    name: 'get_todo_list',
    description: "Get the current family to-do list",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_todo',
    description: "Add a task to the family to-do list",
    input_schema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Task to add' },
        due_date: { type: 'string', description: 'Optional due date (ISO date string)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'complete_todo',
    description: "Mark a to-do item as complete",
    input_schema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Task to complete' },
      },
      required: ['task'],
    },
  },
  {
    name: 'add_reminder',
    description: "Set a personal reminder for a specific person at a specific time",
    input_schema: {
      type: 'object' as const,
      properties: {
        user_name: { type: 'string', description: 'Name of the person to remind (Luke or Toni)' },
        message: { type: 'string', description: 'Reminder message' },
        remind_at: { type: 'string', description: 'ISO datetime string for when to remind' },
      },
      required: ['user_name', 'message', 'remind_at'],
    },
  },
  {
    name: 'add_birthday',
    description: "Store a birthday or anniversary",
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the person' },
        date: { type: 'string', description: 'Date in MM-DD format (e.g. 03-15 for March 15th)' },
        relation: { type: 'string', description: 'Relationship (e.g. Mum, Dad, sister)' },
      },
      required: ['name', 'date'],
    },
  },
  {
    name: 'get_birthdays',
    description: "Get all stored birthdays and anniversaries",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'check_date',
    description: "Look up what day of the week a date falls on. ALWAYS call this before stating a day+date combination (e.g. 'Saturday 5th April') to guarantee accuracy.",
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'ISO date string to check, e.g. 2026-04-05' },
      },
      required: ['date'],
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  userName: string
): Promise<string> {
  const db = await import('./db');

  try {
    switch (toolName) {
      case 'get_todays_events': {
        const events = await getTodaysEvents();
        return events.length === 0
          ? 'No events today.'
          : formatEventsForAI(events);
      }

      case 'get_events_for_period': {
        const events = await getEventsForPeriod(
          new Date(toolInput['start_date'] as string),
          new Date(toolInput['end_date'] as string)
        );
        return formatEventsForAI(events);
      }

      case 'get_upcoming_events': {
        const days = (toolInput['days'] as number) || 7;
        const events = await getUpcomingEvents(days);
        return formatEventsForAI(events);
      }

      case 'create_calendar_event': {
        const start = new Date(toolInput['start_datetime'] as string);
        const end = new Date(toolInput['end_datetime'] as string);
        const summary = toolInput['summary'] as string;

        // Duplicate guard: check if an event with this exact summary already exists on the same day
        const existingMatches = await findEventsByKeyword(summary);
        const sameDay = existingMatches.filter(e => {
          const d = new Date(e.start);
          return d.toDateString() === start.toDateString();
        });
        if (sameDay.length > 0) {
          return `DUPLICATE BLOCKED: An event named "${sameDay[0]!.summary}" already exists on ${start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone })}. No new event was created. If you meant to update it, use update_calendar_event instead.`;
        }

        // Check for conflicts first
        const conflicts = await checkConflicts(start, end);
        const recurrence = toolInput['recurrence_rule']
          ? [(toolInput['recurrence_rule'] as string).startsWith('RRULE:')
              ? toolInput['recurrence_rule'] as string
              : `RRULE:${toolInput['recurrence_rule']}`]
          : undefined;

        const event = await createEvent({
          summary,
          start,
          end,
          description: toolInput['description'] as string | undefined,
          location: toolInput['location'] as string | undefined,
          allDay: (toolInput['all_day'] as boolean) || false,
          recurrence,
        });

        const startDt = new Date(event.start);
        const endDt = new Date(event.end);
        const dateStr2 = startDt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone });
        const startTime = startDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone });
        const endTime = endDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone });
        let result = `Created event: "${event.summary}" on ${dateStr2}, ${startTime}–${endTime}`;
        if (conflicts.length > 0) {
          result += `\n\nCONFLICT WARNING: There are already events at this time:\n${formatEventsForAI(conflicts)}`;
        }
        return result;
      }

      case 'update_calendar_event': {
        const keyword = toolInput['event_keyword'] as string;
        const events = await findEventsByKeyword(keyword);
        if (events.length === 0) return `Could not find any event matching "${keyword}"`;
        const event = events[0]!;

        const updates: Parameters<typeof updateEvent>[1] = {};
        if (toolInput['summary']) updates.summary = toolInput['summary'] as string;
        if (toolInput['description']) updates.description = toolInput['description'] as string;
        if (toolInput['location']) updates.location = toolInput['location'] as string;
        if (toolInput['start_datetime']) {
          updates.start = new Date(toolInput['start_datetime'] as string);
        }
        if (toolInput['end_datetime']) {
          updates.end = new Date(toolInput['end_datetime'] as string);
        }

        // Check conflicts if moving time
        if (updates.start && updates.end) {
          const conflicts = await checkConflicts(updates.start, updates.end, event.id);
          const updated = await updateEvent(event.id, updates);
          const updStartDt = new Date(updated.start);
          const updEndDt = new Date(updated.end);
          const updDate = updStartDt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone });
          const updStart = updStartDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone });
          const updEnd = updEndDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone });
          let result = `Updated "${updated.summary}" — now on ${updDate}, ${updStart}–${updEnd}`;
          if (conflicts.length > 0) {
            result += `\n\nCONFLICT WARNING:\n${formatEventsForAI(conflicts)}`;
          }
          return result;
        }

        const updated = await updateEvent(event.id, updates);
        const updStartDt2 = new Date(updated.start);
        const updEndDt2 = new Date(updated.end);
        const updDate2 = updStartDt2.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone });
        const updStart2 = updStartDt2.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone });
        const updEnd2 = updEndDt2.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone });
        return `Updated "${updated.summary}" — now on ${updDate2}, ${updStart2}–${updEnd2}`;
      }

      case 'delete_calendar_event': {
        const keyword = toolInput['event_keyword'] as string;
        const events = await findEventsByKeyword(keyword);
        if (events.length === 0) return `Could not find any event matching "${keyword}" in the next 365 days. No events were deleted.`;
        const deleted: string[] = [];
        for (const ev of events) {
          await deleteEvent(ev.id);
          const dt = new Date(ev.start);
          const label = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone });
          deleted.push(`"${ev.summary}" on ${label}`);
        }
        return `Deleted ${deleted.length} event(s):\n${deleted.map(d => `- ${d}`).join('\n')}`;
      }

      case 'get_shopping_list': {
        const items = await db.getShoppingList();
        if (items.length === 0) return 'Shopping list is empty.';
        return items.map((i) => `- ${i.item} (added by ${i.added_by})`).join('\n');
      }

      case 'add_shopping_item': {
        await db.addShoppingItem(toolInput['item'] as string, userName);
        return `Added "${toolInput['item']}" to the shopping list.`;
      }

      case 'remove_shopping_item': {
        const removed = await db.removeShoppingItem(toolInput['item'] as string);
        return removed
          ? `Removed "${toolInput['item']}" from the shopping list.`
          : `Couldn't find "${toolInput['item']}" on the shopping list.`;
      }

      case 'get_todo_list': {
        const todos = await db.getTodos();
        if (todos.length === 0) return 'To-do list is empty.';
        return todos.map((t) => `- ${t.task}${t.due_date ? ` (due: ${t.due_date})` : ''}`).join('\n');
      }

      case 'add_todo': {
        await db.addTodo(toolInput['task'] as string, userName, toolInput['due_date'] as string | undefined);
        return `Added "${toolInput['task']}" to the to-do list.`;
      }

      case 'complete_todo': {
        const done = await db.completeTodo(toolInput['task'] as string);
        return done
          ? `Marked "${toolInput['task']}" as complete.`
          : `Couldn't find "${toolInput['task']}" in the to-do list.`;
      }

      case 'add_reminder': {
        await db.addReminder(
          toolInput['user_name'] as string,
          toolInput['message'] as string,
          new Date(toolInput['remind_at'] as string)
        );
        const remindDate = new Date(toolInput['remind_at'] as string);
        return `Reminder set for ${toolInput['user_name']} at ${remindDate.toLocaleString('en-GB')}: "${toolInput['message']}"`;
      }

      case 'add_birthday': {
        await db.addBirthday(
          toolInput['name'] as string,
          toolInput['date'] as string,
          (toolInput['relation'] as string) || '',
          userName
        );
        return `Stored birthday: ${toolInput['name']} on ${toolInput['date']}`;
      }

      case 'get_birthdays': {
        const birthdays = await db.getBirthdays();
        if (birthdays.length === 0) return 'No birthdays stored.';
        return birthdays.map((b) => `- ${b.name}: ${b.date}${b.relation ? ` (${b.relation})` : ''}`).join('\n');
      }

      case 'check_date': {
        // Use T12:00:00 to avoid UTC midnight boundary flipping the day
        const d = new Date(`${toolInput['date'] as string}T12:00:00`);
        if (isNaN(d.getTime())) return `Invalid date: ${toolInput['date']}`;
        return d.toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    const error = err as Error;
    return `Error executing ${toolName}: ${error.message}`;
  }
}

// ── Timezone-aware "now" ──────────────────────────────────────────────────────

/**
 * Returns a plain Date object representing the current wall-clock time in the
 * given IANA timezone.  JS Dates are always UTC internally, so this creates a
 * "fake-local" Date whose year/month/day/hours match the timezone — good
 * enough for date arithmetic and toLocaleDateString display.
 */
function getLocalNow(timezone: string): Date {
  const utcNow = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcNow);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const now = getLocalNow(config.timezone);
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  const children = config.family.children;
  const babyDue = new Date(config.family.babyDue);
  const babyDueStr = babyDue.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const daysUntilBaby = Math.ceil((babyDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const babyCountdown = daysUntilBaby > 0 ? `${daysUntilBaby} days to go` : 'any day now!';

  return `You are Rose, a family personal assistant living inside a Telegram group chat shared by Luke and Toni. You're like a brilliant friend who happens to be incredibly organised — warm, casual, occasionally witty, always helpful.

Current date and time: ${dateStr} at ${timeStr} (${config.timezone})

FAMILY:
- Luke and Toni are the parents
- Kids: ${children.map(c => `${c.name} (${c.age})`).join(', ')}
- Baby due ${babyDueStr} — ${babyCountdown}
- They have a dog — whenever Luke is away from home (day travel or overnight), dog walker coverage needs to be in place
- Luke mainly works from home, but has occasional day trips and overnight stays for work
- As the due date gets closer, gently flag things like childcare cover for Poppy and Billy, hospital bag readiness, and last-minute prep

SCHOOL RUN & CHILDCARE:
The regular weekly school run schedule for Poppy and Billy is:
- Monday: Luke does drop-off and after-school club pick-up
- Tuesday: Grandma does drop-off and pick-up (fully covered regardless of Luke)
- Wednesday: Breakfast club covers the morning (self-drop), Granddad does pick-up (fully covered regardless of Luke)
- Thursday: Luke does drop-off, Toni does pick-up
- Friday: Toni doesn't work — Toni does both drop-off and pick-up (fully covered regardless of Luke)

When Luke is away (day trip or overnight), cross-reference his travel dates against the above:
- Monday away: both drop-off AND pick-up need alternative cover — flag this clearly
- Thursday away: morning drop-off needs cover (Toni already has the afternoon)
- Tuesday, Wednesday, Friday: already covered — no action needed, but you can reassure them it's fine
Grandma is the most likely person to step in for extra cover. If Luke books travel on a Monday or Thursday, proactively flag which part of the school run needs sorting and suggest asking Grandma if needed.

PERSONALITY:
- Natural, conversational tone at all times — never robotic
- Use Luke and Toni by their first names, and the kids' names naturally
- Volunteer information proactively — if you spot a clash, a gap, or something worth flagging, say so
- Use emojis naturally and sparingly
- Never sound like a bot. Instead of "I have added the event to your calendar" say "Done! I've popped that in for Thursday. Just a heads up, you've already got dinner out that evening — want me to move anything?"
- If the same thing gets asked repeatedly, you can gently tease: "Third time this week — it's Thursday at 3pm 😄"
- If something is ambiguous, ask ONE clarifying question rather than guessing or erroring
- Keep responses concise and human — don't over-explain
- When confirming multiple items (several events added, a list of things on the calendar), always present them as a clean bullet-point list — one item per line. Lead with a short sentence, then the list, then any notes or flags after. This makes it much easier to read at a glance.

GROUP CHAT BEHAVIOUR:
- You're in a shared family group chat with Luke and Toni
- Respond when directly addressed (Rose, or @Rose) or when someone asks a question you can help with
- If Luke and Toni are discussing plans, you can chip in with relevant calendar info
- If there's a disagreement about what's on when, you're the tie-breaker: "According to the calendar it's the 14th — Luke added it on Monday"

TOOLS:
You have tools to read and write the Family Google Calendar, manage a shopping list, to-do list, reminders, and birthdays. Use them whenever the user's request involves these. When you use a tool, integrate the result naturally into your response — don't just dump raw data.

TASK & LIST HANDLING:
- When adding to the to-do list or shopping list, always clean up the text first: fix spelling, capitalise properly, and make it grammatically natural before saving. Examples: "luke haircut" → "Luke's haircut", "Billy hair cut" → "Billy's haircut", "mow lawn" → "Mow the lawn", "milk bread" → two items "Milk" and "Bread".
- When displaying a to-do list, add a relevant emoji before each item to make it easy to scan at a glance. Pick something that fits the task — e.g. ✂️ for haircuts, 🌿 for garden tasks, 🛒 for shopping, 🧹 for chores, 📦 for errands.
- When displaying the shopping list, use 🛒 or a fitting food/item emoji per line.

TIME HANDLING:
- The current time is ${timeStr} and today is ${dateStr}
- When users say things like "tomorrow", "next week", "Saturday", interpret relative to today
- For events without a specified duration, default to 1 hour
- For all-day events (birthdays, holidays), use all_day: true
- Always use the timezone ${config.timezone}
- Tool inputs (start_datetime, end_datetime, remind_at) must always be ISO 8601 strings, e.g. 2026-04-05T18:00:00
- When displaying times to the user, use 12-hour format with am/pm (e.g. 6pm, 9am, 6–7:20pm). Never show raw ISO strings to the user.
- CRITICAL — DATE ACCURACY: Never state a day-name + date-number combination (e.g. "Saturday 5th April") without first calling the check_date tool with the ISO date to verify the day name. The date reference below is your starting point, and check_date is your final confirmation. If the user gives you a day+date that doesn't match (e.g. they say "Saturday 5th April" but the 5th is a Sunday), silently correct it — use the right day name for that date. Never echo back an incorrect pairing.

Date reference (today + 8 weeks) — use this as the authoritative source for all day/date lookups:
${(() => {
  // Build from local midnight to avoid any UTC-offset contamination
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Array.from({ length: 57 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }).join('\n');
})()}

CALENDAR:
- The shared calendar is called "Family"
- When creating events, always check for conflicts and mention them conversationally
- For recurring events, use proper RRULE format (e.g., RRULE:FREQ=WEEKLY;BYDAY=SA for every Saturday)
- Tag events with which family member(s) they involve where relevant (e.g. "Poppy - swimming", "Billy - football")
- DATE & TIME ACCURACY: Always call check_date before confirming any day+date pair to the user. If the user gives a wrong pairing (e.g. "Tuesday 1st April" when April 1st is a Wednesday), correct it silently. For times: always read the start and end time back from the calendar event data — never reconstruct from memory. Convert to 12-hour format for the user (e.g. "6–7:20pm"). The calendar is the source of truth for both dates and times.
- TRAVEL AWARENESS: Luke works from home by default. If you detect a travel event being added (a day trip, overnight stay, work trip, conference, site visit, etc.), always ask whether a dog walker has been arranged. If it's an overnight stay, also flag that it covers the full day(s) away. If it's already on the calendar and you're reviewing upcoming events, proactively check whether dog walker is confirmed if it hasn't been mentioned — a gentle "Have you sorted the dog walker for that one?" is fine

Be Rose. Be warm, be sharp, be helpful.`;
}

// ── Main AI response function ─────────────────────────────────────────────────

export async function generateResponse(
  userMessage: string,
  userName: string,
  _telegramUserId: number
): Promise<string> {
  // Store user message in conversation history
  await addConversationMessage('user', `${userName}: ${userMessage}`, userName);

  // Get recent conversation history
  const history = await getRecentConversation(20);

  // Build messages array
  const messages: Anthropic.MessageParam[] = history.slice(0, -1).map((h) => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }));

  // Add current message
  messages.push({
    role: 'user',
    content: `${userName}: ${userMessage}`,
  });

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    tools,
    messages,
  });

  // Agentic loop — keep going while there are tool calls
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const result = await executeTool(
        toolUse.name,
        toolUse.input as Record<string, unknown>,
        userName
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Add assistant response and tool results to messages
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools,
      messages,
    });
  }

  // Extract text response
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const responseText = textBlock?.text || "Sorry, I couldn't think of a response just now!";

  // Store assistant response in conversation history
  await addConversationMessage('assistant', responseText);

  return responseText;
}

// ── Proactive message generation ──────────────────────────────────────────────

export async function generateDailySummary(): Promise<string> {
  const todayEvents = await getTodaysEvents();
  const upcomingEvents = await getUpcomingEvents(3);

  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  const schoolRunSchedule: Record<number, string> = {
    1: 'Luke does drop-off and after-school club pick-up',
    2: 'Grandma handles both — nothing needed from you two',
    3: 'Breakfast club drop-off, Granddad picks up — you\'re off the hook',
    4: 'Luke does drop-off, Toni picks up',
    5: 'Toni does both',
  };
  const todaySchoolRun = isWeekday ? schoolRunSchedule[dayOfWeek] : null;

  const prompt = `Generate a punchy good morning message for Luke and Toni. Use short bulleted lines with emojis. Group items under bold topic headers where relevant (e.g. **🎒 Kids**, **📅 Today**, **👀 Coming up**). Keep the tone warm with light wit — like a witty friend who also happens to be extremely organised.

Family: Poppy (7), Billy (5), and a baby due 17th August.

Today's events:
${formatEventsForAI(todayEvents)}

Upcoming events (next 3 days):
${formatEventsForAI(upcomingEvents)}

${todaySchoolRun ? `SCHOOL RUN TODAY: ${todaySchoolRun}. Include a **🚌 School run** section confirming who's doing what today. If it's all covered by Grandma/Granddad, a little reassurance goes a long way.` : ''}

Rules:
- Start with a varied one-liner greeting (no "Good morning!" every day)
- Use bullet points, not paragraphs
- Group related items under bold emoji headers
- If nothing's on, say so with a bit of cheer
- Keep it tight — no waffle
- Vary the tone and emojis day to day so it doesn't feel like a template`;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || 'Good morning! Hope you both have a lovely day 😊';
}

export async function generateWeeklySummary(): Promise<string> {
  const now = new Date();
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + (8 - now.getDay()) % 7 || 7);
  nextMonday.setHours(0, 0, 0, 0);
  const nextSunday = new Date(nextMonday);
  nextSunday.setDate(nextMonday.getDate() + 6);
  nextSunday.setHours(23, 59, 59, 999);

  const weekEvents = await getEventsForPeriod(nextMonday, nextSunday);

  const prompt = `Generate a friendly weekly overview message for Luke and Toni for the coming week (${nextMonday.toLocaleDateString('en-GB')} to ${nextSunday.toLocaleDateString('en-GB')}).

Family: Poppy (7), Billy (5), and a baby due 17th August.

This week's events:
${formatEventsForAI(weekEvents)}

Mention any busy days, any gaps, anything that needs preparing or booking ahead. Call out anything involving the kids specifically. Keep it conversational and warm — not a bullet list. Flag anything that stands out. If it's a quiet week, say so positively.

SCHOOL RUN CHECK: Cross-reference the week's events against the regular school run schedule:
- Monday: Luke does drop-off and after-school club pick-up
- Tuesday: Grandma handles both — no action needed
- Wednesday: Breakfast club in the morning, Granddad picks up — no action needed
- Thursday: Luke does drop-off, Toni picks up
- Friday: Toni does both — no action needed

If there are any travel events or work commitments for Luke on Monday or Thursday, flag the specific school run that needs cover and suggest asking Grandma. If Monday and Thursday are clear, give a quick reassuring note that the school runs are sorted for the week.`;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 600,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || 'Here\'s a look at the week ahead! 📅';
}

export async function generateEventReminder(event: CalendarEvent, hoursUntil: number): Promise<string> {
  const prompt = `Generate a friendly reminder about this upcoming event for Luke and Toni:

Event: ${event.summary}
Start: ${new Date(event.start).toLocaleString('en-GB', { hour12: false })}
${event.location ? `Location: ${event.location}` : ''}
Hours until event: ${hoursUntil}

Write it conversationally — not just "Reminder: X". If appropriate, suggest leaving early, what to prepare, etc. Keep it brief and natural.`;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 256,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || `Heads up — ${event.summary} is in ${hoursUntil} hours!`;
}

export async function generateWeekendCheckin(day: 'saturday' | 'sunday'): Promise<string> {
  const todos = await getTodos();
  const todayEvents = await getTodaysEvents();

  const todoText = todos.length > 0
    ? todos.map((t) => `- ${t.task}${t.due_date ? ` (due: ${t.due_date})` : ''}`).join('\n')
    : 'Nothing on the to-do list.';

  const prompt = day === 'saturday'
    ? `It's Saturday morning. Generate a warm, motivating check-in message for Luke and Toni to kick off the weekend.

Current to-do list:
${todoText}

Today's events:
${formatEventsForAI(todayEvents)}

Acknowledge it's the weekend, highlight what's on the list, and give them a friendly nudge to get stuff done. Be encouraging, not naggy. Keep it short — a couple of sentences max, then list the tasks with emojis. Maybe a light-hearted comment about tackling the list together.`
    : `It's Sunday afternoon. Generate a friendly check-in message for Luke and Toni about where things stand before the new week.

Outstanding to-do list:
${todoText}

Today's events:
${formatEventsForAI(todayEvents)}

Acknowledge the weekend's nearly done, see how they're getting on with the list. If there are outstanding tasks, gently nudge them — not in a guilt-trippy way, more "anything you want to knock off before Monday?". If the list is clear, celebrate that! Keep it warm and brief.`;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 400,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || (day === 'saturday' ? 'Happy Saturday! What are we getting done today? 💪' : 'Sunday check-in — anything left to tackle before the week starts? 😊');
}

export async function generateBirthdayReminder(name: string, relation: string | null, daysUntil: number): Promise<string> {
  const prompt = `Generate a friendly reminder for Luke and Toni that ${name}${relation ? ` (${relation})` : ''}'s birthday is in ${daysUntil} days. Keep it warm and natural, maybe suggest thinking about a gift or plans if it's coming up soon.`;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 200,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || `Just a heads up — it's ${name}'s birthday in ${daysUntil} days! 🎂`;
}

// ── Message intent detection ──────────────────────────────────────────────────

export async function shouldRoseRespond(
  message: string,
  isDirectlyMentioned: boolean
): Promise<boolean> {
  if (isDirectlyMentioned) return true;

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: `Is this message something a helpful family assistant should respond to, or is it just casual chat between two people that doesn't need a response? Reply with only "yes" or "no".

Message: "${message}"`,
      },
    ],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text?.toLowerCase().includes('yes') ?? false;
}
