import Anthropic from '@anthropic-ai/sdk';
import { config, ageFromDob } from './config';
import {
  getRecentConversation,
  addConversationMessage,
  getShoppingList,
  addShoppingItem,
  removeShoppingItem,
  clearShoppingList,
  getTodos,
  addTodo,
  completeTodo,
  addReminder,
  getBirthdays,
  addBirthday,
  getMealPlan,
  setMeal,
  clearMeal,
  MealType,
  getBabyChecklist,
  addBabyChecklistItem,
  completeBabyChecklistItem,
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
import { getWeatherForecast, formatDayWeather, formatWeekWeather } from './weather';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Wrapper around anthropic.messages.create with exponential-backoff retry on
 * transient errors (5xx, 429, network). Client errors (other 4xx) fail fast.
 */
async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  retries = 3,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status && status < 500 && status !== 429) throw err; // non-retryable
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

/** Human-readable family description built from config, with live-computed ages. */
function familyDescription(): string {
  const kids = config.family.children.map((c) => `${c.name} (${ageFromDob(c.dob)})`).join(', ');
  const due = new Date(config.family.babyDue).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return `${kids}, and a baby due ${due}`;
}

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
    name: 'clear_shopping_list',
    description: "Clear the entire shopping list (mark all items as completed). Use when the user confirms they've finished the shop, or asks to clear/empty the list.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_baby_checklist',
    description: "Get the baby prep checklist — items still needed before the baby arrives (bouncer, monitor, etc.)",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_baby_checklist_item',
    description: "Add an item to the baby prep checklist",
    input_schema: {
      type: 'object' as const,
      properties: {
        item: { type: 'string', description: 'The item to add (e.g. "baby monitor", "bouncer")' },
        category: { type: 'string', description: 'Optional category (e.g. "sleeping", "feeding", "transport")' },
      },
      required: ['item'],
    },
  },
  {
    name: 'complete_baby_checklist_item',
    description: "Mark a baby checklist item as done/acquired",
    input_schema: {
      type: 'object' as const,
      properties: {
        item: { type: 'string', description: 'The item to mark as done' },
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
  {
    name: 'get_meal_plan',
    description: "Get the meal plan for a date range",
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'set_meal',
    description: "Set a meal for a specific date and meal type (breakfast, lunch, or dinner)",
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date YYYY-MM-DD' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'], description: 'Meal type' },
        meal: { type: 'string', description: 'What the meal is' },
      },
      required: ['date', 'meal_type', 'meal'],
    },
  },
  {
    name: 'clear_meal',
    description: "Remove a meal from the plan for a specific date and meal type",
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date YYYY-MM-DD' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'], description: 'Meal type' },
      },
      required: ['date', 'meal_type'],
    },
  },
  {
    name: 'web_search',
    description: "Search the web for current information — use this for anything requiring up-to-date or local knowledge: businesses, opening hours, prices, news, events, venues, travel info, product recommendations, etc. Prefer this over guessing.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  userName: string
): Promise<string> {
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
        const start = parseInTimezone(toolInput['start_datetime'] as string, config.timezone);
        const end = parseInTimezone(toolInput['end_datetime'] as string, config.timezone);
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
          updates.start = parseInTimezone(toolInput['start_datetime'] as string, config.timezone);
        }
        if (toolInput['end_datetime']) {
          updates.end = parseInTimezone(toolInput['end_datetime'] as string, config.timezone);
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
        const items = await getShoppingList();
        if (items.length === 0) return 'Shopping list is empty.';
        return items.map((i) => `- ${i.item} (added by ${i.added_by})`).join('\n');
      }

      case 'add_shopping_item': {
        await addShoppingItem(toolInput['item'] as string, userName);
        return `Added "${toolInput['item']}" to the shopping list.`;
      }

      case 'remove_shopping_item': {
        const removed = await removeShoppingItem(toolInput['item'] as string);
        return removed
          ? `Removed "${toolInput['item']}" from the shopping list.`
          : `Couldn't find "${toolInput['item']}" on the shopping list.`;
      }

      case 'clear_shopping_list': {
        const count = await clearShoppingList();
        return count > 0
          ? `Cleared ${count} item(s) from the shopping list.`
          : 'The shopping list was already empty.';
      }

      case 'get_baby_checklist': {
        const items = await getBabyChecklist();
        if (items.length === 0) return 'Baby checklist is empty — everything has been ticked off!';
        const grouped: Record<string, string[]> = {};
        for (const item of items) {
          const cat = item.category || 'Other';
          (grouped[cat] ??= []).push(item.item);
        }
        return Object.entries(grouped)
          .map(([cat, its]) => `${cat}:\n${its.map(i => `  - ${i}`).join('\n')}`)
          .join('\n\n');
      }

      case 'add_baby_checklist_item': {
        await addBabyChecklistItem(toolInput['item'] as string, userName, toolInput['category'] as string | undefined);
        return `Added "${toolInput['item']}" to the baby checklist.`;
      }

      case 'complete_baby_checklist_item': {
        const done = await completeBabyChecklistItem(toolInput['item'] as string);
        return done
          ? `Ticked off "${toolInput['item']}" from the baby checklist. ✓`
          : `Couldn't find "${toolInput['item']}" on the baby checklist.`;
      }

      case 'get_todo_list': {
        const todos = await getTodos();
        if (todos.length === 0) return 'To-do list is empty.';
        return todos.map((t) => `- ${t.task}${t.due_date ? ` (due: ${t.due_date})` : ''}`).join('\n');
      }

      case 'add_todo': {
        await addTodo(toolInput['task'] as string, userName, toolInput['due_date'] as string | undefined);
        return `Added "${toolInput['task']}" to the to-do list.`;
      }

      case 'complete_todo': {
        const done = await completeTodo(toolInput['task'] as string);
        return done
          ? `Marked "${toolInput['task']}" as complete.`
          : `Couldn't find "${toolInput['task']}" in the to-do list.`;
      }

      case 'add_reminder': {
        const remindDate = parseInTimezone(toolInput['remind_at'] as string, config.timezone);
        await addReminder(
          toolInput['user_name'] as string,
          toolInput['message'] as string,
          remindDate
        );
        return `Reminder set for ${toolInput['user_name']} at ${remindDate.toLocaleString('en-GB')}: "${toolInput['message']}"`;
      }

      case 'add_birthday': {
        await addBirthday(
          toolInput['name'] as string,
          toolInput['date'] as string,
          (toolInput['relation'] as string) || '',
          userName
        );
        return `Stored birthday: ${toolInput['name']} on ${toolInput['date']}`;
      }

      case 'get_birthdays': {
        const birthdays = await getBirthdays();
        if (birthdays.length === 0) return 'No birthdays stored.';
        return birthdays.map((b) => `- ${b.name}: ${b.date}${b.relation ? ` (${b.relation})` : ''}`).join('\n');
      }

      case 'get_meal_plan': {
        const meals = await getMealPlan(
          toolInput['start_date'] as string,
          toolInput['end_date'] as string
        );
        if (meals.length === 0) return 'No meals planned for that period.';
        return meals.map((m) => {
          const label = new Date(`${m.date}T12:00:00`).toLocaleDateString('en-GB', {
            weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone,
          });
          return `${label} — ${m.meal_type}: ${m.meal}`;
        }).join('\n');
      }

      case 'set_meal': {
        await setMeal(
          toolInput['date'] as string,
          toolInput['meal_type'] as MealType,
          toolInput['meal'] as string,
          userName
        );
        return `Set ${toolInput['meal_type']} on ${toolInput['date']} to "${toolInput['meal']}".`;
      }

      case 'clear_meal': {
        const removed = await clearMeal(
          toolInput['date'] as string,
          toolInput['meal_type'] as MealType
        );
        return removed
          ? `Cleared ${toolInput['meal_type']} on ${toolInput['date']}.`
          : `No ${toolInput['meal_type']} found on ${toolInput['date']}.`;
      }

      case 'check_date': {
        // Use T12:00:00 to avoid UTC midnight boundary flipping the day
        const d = new Date(`${toolInput['date'] as string}T12:00:00`);
        if (isNaN(d.getTime())) return `Invalid date: ${toolInput['date']}`;
        return d.toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });
      }

      case 'web_search': {
        const { braveSearch, formatSearchResults } = await import('./search');
        const results = await braveSearch(toolInput['query'] as string, 6);
        return formatSearchResults(results);
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

/**
 * Parse a naive ISO datetime string (e.g. "2026-04-05T09:00:00" with no offset)
 * as local time in the given IANA timezone, returning a proper UTC Date.
 *
 * Without this, new Date("2026-04-05T09:00:00") on a UTC server = 9am UTC,
 * which Google Calendar displays as 10am BST — 1 hour wrong after DST change.
 */
function parseInTimezone(datetimeStr: string, timezone: string): Date {
  // If the string already has an offset (+HH:mm / Z), parse it as-is
  if (/[Z+\-]\d*$/.test(datetimeStr.slice(10))) {
    return new Date(datetimeStr);
  }
  // Parse as UTC to get a usable Date, then measure the timezone offset at that moment
  const asUtc = new Date(datetimeStr + 'Z');
  const localStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(asUtc).replace(' ', 'T');
  // offsetMs = how far UTC is ahead of local (positive in BST: UTC+1 means local is 1h ahead)
  const offsetMs = asUtc.getTime() - new Date(localStr + 'Z').getTime();
  return new Date(asUtc.getTime() + offsetMs);
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
- Kids: ${children.map(c => `${c.name} (${ageFromDob(c.dob)})`).join(', ')}
- Based in ${config.location}
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

PE DAYS (kit needed the night before):
- Poppy: Mondays and Fridays
- Billy: Wednesdays and Fridays

SCHOOL HOLIDAYS:
School holiday periods are stored in the Family Google Calendar as all-day events (e.g. "School holidays"). When you see one of these events on the calendar:
- There is no school run, no PE kit, and no after-school clubs during this period
- If Luke has travel planned during school holidays, there's no school run to worry about — but dog walker cover may still be needed
- Proactively mention it when it's relevant — e.g. "That week is half term so no school run to worry about"
- CRITICAL: Only mention school holidays if you have actually seen a school holiday event in the calendar for that specific date. Never assume or guess that a date falls in a holiday period based on your own knowledge of typical school term dates — your knowledge may be wrong or differ from this family's school. If no calendar event confirms a holiday, say nothing about it.

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
You have tools to read and write the Family Google Calendar, manage a shopping list, to-do list, reminders, birthdays, and meal plan. Use them whenever the user's request involves these. When you use a tool, integrate the result naturally into your response — don't just dump raw data.

TASK & LIST HANDLING:
- When adding to the to-do list or shopping list, always clean up the text first: fix spelling, capitalise properly, and make it grammatically natural before saving. Examples: "luke haircut" → "Luke's haircut", "Billy hair cut" → "Billy's haircut", "mow lawn" → "Mow the lawn", "milk bread" → two items "Milk" and "Bread".
- When displaying a to-do list, add a relevant emoji before each item to make it easy to scan at a glance. Pick something that fits the task — e.g. ✂️ for haircuts, 🌿 for garden tasks, 🛒 for shopping, 🧹 for chores, 📦 for errands.
- When displaying the shopping list, use 🛒 or a fitting food/item emoji per line.

MEAL PLAN:
- You manage a two-week rolling meal plan covering breakfast, lunch, and dinner.
- When someone sets a meal (e.g. "Monday dinner is spaghetti bolognese"), call set_meal with the correct date, meal_type, and meal name. Clean up the meal name before saving.
- ALWAYS actually call set_meal to persist a meal — never just acknowledge it conversationally. If several dinners are listed at once ("this week we're having X, Y, Z"), call set_meal once per day. If a day isn't specified, ask which day rather than guessing.
- Before saving, resolve any weekday name ("Monday", "tomorrow") to an exact YYYY-MM-DD date using check_date so it lands on the right day. Briefly confirm what you saved, e.g. "Saved — Thursday's dinner is spaghetti bolognese 🍝".
- When asked what's for dinner / what's the plan this week, call get_meal_plan for the relevant date range and display it grouped by day, one day per line, with a fitting food emoji. Only show meal types that have entries — skip empty slots unless the user asks.
- "What's for dinner tonight/this week?" → fetch and display. "We're having X on Tuesday" → set_meal. "Clear Wednesday lunch" → clear_meal.
- When displaying the plan, format like: "Mon 30 Mar — 🍝 Spaghetti Bolognese". Group by day, skip days with nothing planned.

ASDA SHOPPING:
- If someone says "Any Asda shopping?", "Asda list", "doing the Asda shop/order", or similar — fetch the shopping list and present it grouped by supermarket aisle so it's easy to walk round the store. Use these sections (only include sections that have items):
  🥕 Fresh Fruit & Veg
  🥩 Meat & Fish
  🥛 Dairy & Eggs
  🍞 Bakery & Bread
  🧊 Frozen
  🥫 Tins, Jars & Packets
  🥤 Drinks & Juice
  🍫 Snacks & Treats
  🧴 Household & Cleaning
  👶 Baby & Kids
  🛒 Other
- If the list is empty, say so with a light comment ("All clear — nothing to grab!").
- After presenting the Asda list, ask if they want to clear it once they're done shopping.

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
- CRITICAL — ALWAYS FETCH BEFORE ANSWERING: Any question about what is or isn't on the calendar — for today, tomorrow, a specific date, or any period — MUST start with a tool call (get_todays_events, get_upcoming_events, or get_events_for_period). NEVER answer calendar questions from memory, conversation history, or anything the user previously said. If the tool returns no events, say the calendar is clear. Stating that events exist without calling a tool first is a serious error.
- When creating events, always check for conflicts and mention them conversationally
- For recurring events, use proper RRULE format (e.g., RRULE:FREQ=WEEKLY;BYDAY=SA for every Saturday)
- Tag events with which family member(s) they involve where relevant (e.g. "Poppy - swimming", "Billy - football")
- DATE & TIME ACCURACY: Always call check_date before confirming any day+date pair to the user. If the user gives a wrong pairing (e.g. "Tuesday 1st April" when April 1st is a Wednesday), correct it silently. For times: always read the start and end time back from the calendar event data — never reconstruct from memory. Convert to 12-hour format for the user (e.g. "6–7:20pm"). The calendar is the source of truth for both dates and times. CRITICAL: After creating an event, confirm the day name and time by reading them directly from the created event's data. Never echo back a day or time you inferred — always confirm from the actual event.
- NO INVENTED COMMENTARY: Do not add observations, tips, or context that aren't grounded in actual data you have access to (e.g. traffic conditions, journey times, weather on a specific future date unless you've checked the forecast tool). Stick to what you know from the calendar, tools, or what the user has told you.
- TRAVEL AWARENESS: Luke works from home by default. If you detect a travel event being added (a day trip, overnight stay, work trip, conference, site visit, etc.), always ask whether a dog walker has been arranged. If they confirm the dog walker is sorted, immediately create a calendar event titled "Dog walker ✓" (or "Dog walker ✓ - [trip name]" if helpful) as an all-day event on the travel date(s) — this is how the dog walker confirmation is tracked so you can look it up later. If they share a list of dog walker dates (e.g. "dog walker booked: 22 April, 5 May, 12 May"), create one separate "Dog walker ✓" all-day event per date — do not combine them into one event. If a travel event already exists on the calendar, look for a "Dog walker ✓" event on the same date(s) before asking: if one exists, the dog walker is sorted — don't ask again. If no such event exists, a gentle "Have you sorted the dog walker for that one?" is fine.

WEB SEARCH:
- You have a web_search tool — use it freely whenever current or local information would help: finding a restaurant, checking opening times, looking up a service, researching a product, getting local event details, etc.
- Don't tell the user you "can't browse the web" — you can. Search first, then answer with real results.
- Summarise findings conversationally; don't dump raw lists of URLs.

Be Rose. Be warm, be sharp, be helpful.`;
}

// ── Main AI response function ─────────────────────────────────────────────────

export interface ImageData {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export async function generateResponse(
  userMessage: string,
  userName: string,
  _telegramUserId: number,
  imageData?: ImageData
): Promise<string> {
  // Store user message in conversation history (images stored as text placeholder)
  const storedMessage = imageData
    ? `${userName}: [sent a photo] ${userMessage}`.trim()
    : `${userName}: ${userMessage}`;
  await addConversationMessage('user', storedMessage, userName);

  // Get recent conversation history
  const history = await getRecentConversation(20);

  // Pre-fetch real calendar data to inject as ground truth.
  // This prevents Rose from using conversation history as a substitute
  // for actually checking the calendar — which causes hallucinated confirmations.
  let calendarGroundTruth: string;
  try {
    const [upcomingEvents, todayEventsForContext] = await Promise.all([
      getUpcomingEvents(14),
      getTodaysEvents(),
    ]);
    calendarGroundTruth = [
      `[CALENDAR GROUND TRUTH — fetched right now, authoritative]:`,
      `Today's events: ${todayEventsForContext.length === 0 ? 'none' : formatEventsForAI(todayEventsForContext)}`,
      `Upcoming (next 14 days): ${upcomingEvents.length === 0 ? 'none' : formatEventsForAI(upcomingEvents)}`,
      `Use this data when answering any calendar question. Do NOT rely on conversation history for calendar facts.`,
    ].join('\n');
  } catch (err) {
    console.error('Failed to pre-fetch calendar ground truth:', err);
    calendarGroundTruth = `[CALENDAR GROUND TRUTH — unavailable due to error: ${err instanceof Error ? err.message : String(err)}. Use your calendar tools to fetch live data instead.]`;
  }

  // Build messages array
  const messages: Anthropic.MessageParam[] = history.slice(0, -1).map((h) => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }));

  // Add current message — multimodal if an image was provided
  if (imageData) {
    const textPrompt = userMessage
      || 'I\'ve sent you a photo — can you read what it says and let me know if there\'s anything worth adding to the calendar?';
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageData.mediaType,
            data: imageData.base64,
          },
        },
        {
          type: 'text',
          text: `${calendarGroundTruth}\n\n${userName}: ${textPrompt}`,
        },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: `${calendarGroundTruth}\n\n${userName}: ${userMessage}`,
    });
  }

  // Build the system prompt once — it's identical across every loop iteration.
  const systemPrompt = buildSystemPrompt();

  let response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemPrompt,
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
      let result: string;
      try {
        result = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          userName
        );
      } catch (err) {
        console.error(`Tool "${toolUse.name}" failed:`, err);
        result = `ERROR: "${toolUse.name}" failed — ${err instanceof Error ? err.message : String(err)}. Tell the user this action did not complete and they should try again.`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Add assistant response and tool results to messages
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await createMessage({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: systemPrompt,
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
  const now = getLocalNow(config.timezone);
  // Derive today's date directly in the family's timezone (en-CA → YYYY-MM-DD)
  // so the meal-plan lookup key can never drift with the server's process TZ.
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());

  const [calendarResult, weatherDays, todayMeals] = await Promise.all([
    Promise.all([getTodaysEvents(), getUpcomingEvents(3)]).catch((err) => {
      console.error('Calendar fetch failed in daily summary:', err);
      return null;
    }),
    getWeatherForecast(2),
    getMealPlan(todayStr, todayStr),
  ]);

  const todayEvents = calendarResult?.[0] ?? [];
  const upcomingEvents = calendarResult?.[1] ?? [];
  const calendarWarning = calendarResult === null
    ? '\n⚠️ Calendar unavailable — Rose could not connect to Google Calendar this morning.'
    : '';

  // Use the timezone-aware "now" for day-of-week (a fresh new Date() would be
  // UTC on the server and could report the wrong day between midnight and 1am BST).
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  // Detect school holidays from the calendar so we don't nag about school run /
  // PE kit during a break. Only the calendar is authoritative — never guess.
  const tomorrowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowStr = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
  const HOLIDAY_KEYWORDS = ['holiday', 'half term', 'inset', 'teacher training', 'training day', 'school closed'];
  const calendarHolidayRanges = [...todayEvents, ...upcomingEvents]
    .filter(e => HOLIDAY_KEYWORDS.some(k => e.summary.toLowerCase().includes(k)))
    .map(e => ({ start: e.start.slice(0, 10), end: e.end.slice(0, 10) }));
  // Merge calendar-detected holidays with the known term dates in config.
  const holidayRanges = [...calendarHolidayRanges, ...config.family.schoolHolidays];
  const inHoliday = (dateStr: string) =>
    holidayRanges.some(r => (dateStr >= r.start && dateStr < r.end) || dateStr === r.start);
  const todayIsHoliday = inHoliday(todayStr);
  const tomorrowIsHoliday = inHoliday(tomorrowStr);

  const schoolRunSchedule: Record<number, string> = {
    1: 'Luke does drop-off and after-school club pick-up',
    2: 'Grandma handles both — nothing needed from you two',
    3: 'Breakfast club drop-off, Granddad picks up — you\'re off the hook',
    4: 'Luke does drop-off, Toni picks up',
    5: 'Toni does both',
  };
  const todaySchoolRun = (isWeekday && !todayIsHoliday) ? schoolRunSchedule[dayOfWeek] : null;

  // PE schedule: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const peSchedule: Record<number, string[]> = {
    1: ['Poppy'],           // Monday
    3: ['Billy'],           // Wednesday
    5: ['Poppy', 'Billy'],  // Friday
  };
  const tomorrowDow = (dayOfWeek + 1) % 7;
  const todayPE = todayIsHoliday ? [] : (peSchedule[dayOfWeek] ?? []);
  const tomorrowPE = tomorrowIsHoliday ? [] : (peSchedule[tomorrowDow] ?? []);
  const peAlerts: string[] = [];
  if (todayPE.length > 0) {
    peAlerts.push(`${todayPE.join(' and ')} ${todayPE.length === 1 ? 'has' : 'have'} PE today — make sure kit is on them!`);
  }
  if (tomorrowPE.length > 0) {
    peAlerts.push(`${tomorrowPE.join(' and ')} ${tomorrowPE.length === 1 ? 'has' : 'have'} PE tomorrow — pack kit tonight.`);
  }
  const peSection = peAlerts.length > 0 ? peAlerts.join(' ') : null;

  const weatherSection = weatherDays.length > 0
    ? `Today's weather: ${formatDayWeather(weatherDays[0])}${weatherDays[1] ? `\nTomorrow's weather: ${formatDayWeather(weatherDays[1])}` : ''}`
    : '';

  const mealSection = todayMeals.length > 0
    ? `Today's meals:\n${todayMeals.map(m => `- ${m.meal_type}: ${m.meal}`).join('\n')}`
    : '';

  const prompt = `Generate a punchy good morning message for Luke and Toni. Use short bulleted lines with emojis. Group items under bold topic headers where relevant (e.g. **🎒 Kids**, **📅 Today**, **👀 Coming up**, **🌤 Weather**, **🍽 Food**). Keep the tone warm with light wit — like a witty friend who also happens to be extremely organised.

Family: ${familyDescription()}.

Today's events:
${formatEventsForAI(todayEvents)}

Upcoming events (next 3 days):
${formatEventsForAI(upcomingEvents)}

${weatherSection ? `WEATHER:\n${weatherSection}\nInclude a brief **🌤 Weather** note — one line is enough. If it's going to rain, mention it so they can pack a coat or plan accordingly. If it's a nice day, make something of it.` : ''}

${todaySchoolRun ? `SCHOOL RUN TODAY: ${todaySchoolRun}. Include a **🚌 School run** section confirming who's doing what today. If it's all covered by Grandma/Granddad, a little reassurance goes a long way.` : ''}

${mealSection ? `MEALS: ${mealSection}\nInclude a **🍽 Food** section with today's planned meals. Keep it to one line per meal. If only dinner is set, just mention dinner.` : ''}

${peSection ? `PE KIT ALERT: ${peSection}\nInclude this under the **🎒 Kids** section. Use exactly the day names given (today/tomorrow) — do not guess or invent.` : ''}

${todayIsHoliday ? `IMPORTANT: Today is during the school holidays. Do NOT mention PE kit, the school run, school uniform, breakfast club, or after-school clubs — there is no school. If anything, a cheerful "no school run to worry about today" is welcome, but keep it light.` : ''}

Rules:
- Start with a varied one-liner greeting (no "Good morning!" every day)
- Use bullet points, not paragraphs
- Group related items under bold emoji headers
- If nothing's on, say so with a bit of cheer
- Keep it tight — no waffle
- Vary the tone and emojis day to day so it doesn't feel like a template
${calendarWarning}`;

  const response = await createMessage({
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

  const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
  const prompt = `Generate a friendly weekly overview message for Luke and Toni for the coming week (${fmtDate(nextMonday)} to ${fmtDate(nextSunday)}).

IMPORTANT: The day names in the event list and date range above are pre-computed and correct. Use them exactly as given.

Family: ${familyDescription()}.

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

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 600,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || 'Here\'s a look at the week ahead! 📅';
}

export async function generateEventReminder(event: CalendarEvent, hoursUntil: number): Promise<string> {
  // Pre-compute the day name and formatted time in TypeScript so Claude never needs to infer them.
  const eventDate = new Date(event.start.includes('T') ? event.start : `${event.start}T12:00:00`);
  const precomputedDate = eventDate.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone,
  });
  const precomputedTime = event.start.includes('T')
    ? eventDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone })
    : 'all day';

  // Pre-compute school run context for the event date so Claude can't get it wrong
  const eventDow = eventDate.getDay(); // 0=Sun…6=Sat
  const schoolRunNotes: Record<number, string> = {
    1: 'It\'s a Monday — Luke does drop-off and after-school club pick-up (flag if this conflicts)',
    2: 'It\'s a Tuesday — Grandma covers drop-off and pick-up, no action needed',
    3: 'It\'s a Wednesday — Breakfast club + Granddad pick-up, no action needed',
    4: 'It\'s a Thursday — Luke does drop-off, Toni does pick-up',
    5: 'It\'s a Friday — Toni does both, no action needed',
  };
  const schoolRunNote = schoolRunNotes[eventDow] ?? null;

  // Check if a dog walker event already exists on the travel date(s)
  const dayStart = new Date(eventDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(eventDate);
  dayEnd.setHours(23, 59, 59, 999);
  let dogWalkerConfirmed = false;
  try {
    const sameDay = await getEventsForPeriod(dayStart, dayEnd);
    dogWalkerConfirmed = sameDay.some(e => e.summary.toLowerCase().includes('dog walker'));
  } catch {
    // If the calendar check fails, fall through and let Claude decide
  }

  const prompt = `Generate a friendly reminder about this upcoming event for Luke and Toni:

Event: ${event.summary}
Date: ${precomputedDate}
Time: ${precomputedTime}
${event.location ? `Location: ${event.location}` : ''}
Hours until event: ${hoursUntil}
Dog walker sorted: ${dogWalkerConfirmed ? 'YES — there is already a "Dog walker ✓" event on the calendar for this date. Do NOT ask about the dog walker.' : 'Unknown — if this looks like an overnight or away trip, ask whether the dog walker is sorted.'}

IMPORTANT: The date, day name, and time above are pre-computed and correct. Use them exactly as given. Do NOT restate or recalculate the day of the week.
${schoolRunNote ? `School run context: ${schoolRunNote}` : ''}

Write it conversationally — not just "Reminder: X". Reference school run context only if it's a weekday school-time event. Keep it brief and natural. No invented travel tips or traffic commentary.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 256,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || `Heads up — ${event.summary} is in ${hoursUntil} hours!`;
}

export async function generateFridayCheckin(): Promise<string> {
  const { braveSearch, formatSearchResults } = await import('./search');

  const now = getLocalNow(config.timezone);
  const todayStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
  const monthYear = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: config.timezone });

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone });
  const tomorrowStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);

  const [todayEvents, saturdayEvents, weatherDays, results1, results2] = await Promise.all([
    getTodaysEvents(),
    getEventsForPeriod(tomorrowStart, tomorrowEnd),
    getWeatherForecast(2),
    braveSearch(`things to do ${config.location} this Friday evening ${todayStr}`, 5),
    braveSearch(`events ${config.location} this weekend ${monthYear}`, 5),
  ]);

  const seen = new Set<string>();
  const allResults = [...results1, ...results2].filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  const searchContext = allResults.length > 0 ? formatSearchResults(allResults) : 'No local event results found.';

  const todayWeather = weatherDays.length > 0 ? formatDayWeather(weatherDays[0]) : '';
  const satWeather = weatherDays.length > 1 ? formatDayWeather(weatherDays[1]) : '';

  const prompt = `It's Friday at 3pm — school's out! Generate a short, energetic check-in for Luke and Toni about what's on locally this afternoon/evening and tomorrow (Saturday).

Today (Friday): ${todayStr}
Tomorrow (Saturday): ${tomorrowStr}

Friday afternoon calendar:
${formatEventsForAI(todayEvents) || 'Nothing in the calendar this afternoon'}

Saturday calendar:
${formatEventsForAI(saturdayEvents) || 'Nothing in the calendar'}

Local events from web search:
${searchContext}

Weekend weather:
${todayWeather ? `Friday: ${todayWeather}` : ''}
${satWeather ? `Saturday: ${satWeather}` : ''}

RULES:
- Open with energy — "School's out!" or similar
- Pick 2–3 specific local events from the search results if they have real specifics (name, time, venue). If nothing specific, skip and say so briefly.
- Mention Saturday calendar events if there are any
- Weave in weather naturally
- Short and punchy — WhatsApp energy, not a newsletter`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 400,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || "School's out — have a great weekend! 🎉";
}

export async function generateWeekendCheckin(day: 'saturday' | 'sunday'): Promise<string> {
  const { braveSearch, formatSearchResults } = await import('./search');

  const now = getLocalNow(config.timezone);
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
  const monthYear = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: config.timezone });
  const dayName = day === 'saturday' ? 'Saturday' : 'Sunday';

  const [todos, todayEvents, weatherDays, results1, results2] = await Promise.all([
    getTodos(),
    getTodaysEvents(),
    getWeatherForecast(day === 'saturday' ? 2 : 1),
    braveSearch(`events ${config.location} ${dayName} ${dateStr}`, 5),
    braveSearch(`what's on ${config.location} ${monthYear}`, 4),
  ]);

  // Deduplicate by URL
  const seen = new Set<string>();
  const eventResults = [...results1, ...results2].filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  const searchContext = eventResults.length > 0
    ? formatSearchResults(eventResults)
    : 'No local event results found.';

  const todoText = todos.length > 0
    ? todos.map((t) => `- ${t.task}${t.due_date ? ` (due: ${t.due_date})` : ''}`).join('\n')
    : 'Nothing on the to-do list.';

  const todayWeather = weatherDays.length > 0 ? `Weather today: ${formatDayWeather(weatherDays[0])}` : '';
  const tomorrowWeather = day === 'saturday' && weatherDays.length > 1 ? `\nWeather tomorrow (Sunday): ${formatDayWeather(weatherDays[1])}` : '';
  const weatherNote = todayWeather ? `\n\n${todayWeather}${tomorrowWeather}` : '';

  const prompt = day === 'saturday'
    ? `It's Saturday morning. Generate a warm check-in message for Luke and Toni.

Current to-do list:
${todoText}

Today's calendar:
${formatEventsForAI(todayEvents)}
${weatherNote}

Local events search results for today (${dateStr}):
${searchContext}

RULES FOR THIS MESSAGE:
- Lead with the to-do list — acknowledge it's the weekend and nudge them warmly to get things done. Keep this part short.
- If the search results contain specific events happening TODAY with actual names, times, or venues, mention 1–2 of the best ones as a "something happening locally today if you need a break" aside.
- ONLY mention events that appear in the search results with clear specifics. Do NOT fall back to generic suggestions like "visit the museum" or "head to the park" — if there's nothing specific in the results, skip the local events section entirely.
- Weave in the weather naturally.
- Keep the whole message short and warm.`
    : `It's Sunday afternoon. Generate a friendly check-in message for Luke and Toni about where things stand before the new week.

Outstanding to-do list:
${todoText}

Today's calendar:
${formatEventsForAI(todayEvents)}
${weatherNote}

Local events search results for today (${dateStr}):
${searchContext}

RULES FOR THIS MESSAGE:
- Focus on the to-do list — anything left to knock off before Monday? Keep it warm, not guilt-trippy.
- If there are specific events in the search results happening THIS AFTERNOON/EVENING, you can mention one briefly.
- ONLY mention events that appear in the search results with clear specifics. Do NOT suggest generic days out or permanent attractions. If nothing specific is found, skip the local events section.
- Keep it brief and warm.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 450,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || (day === 'saturday' ? 'Happy Saturday! What are we getting done today? 💪' : 'Sunday check-in — anything left to tackle before the week starts? 😊');
}

export async function generateBirthdayReminder(name: string, relation: string | null, daysUntil: number): Promise<string> {
  const prompt = `Generate a friendly reminder for Luke and Toni that ${name}${relation ? ` (${relation})` : ''}'s birthday is in ${daysUntil} days. Keep it warm and natural, maybe suggest thinking about a gift or plans if it's coming up soon.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 200,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || `Just a heads up — it's ${name}'s birthday in ${daysUntil} days! 🎂`;
}

// ── Local events & holiday activities ────────────────────────────────────────

export async function generateHolidayActivities(
  holidayName: string,
  startDate: Date,
  endDate: Date
): Promise<string> {
  const { braveSearch, formatSearchResults } = await import('./search');

  const startStr = startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: config.timezone });
  const endStr = endDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: config.timezone });
  const monthYear = startDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: config.timezone });

  const query = `family activities children ${config.location} ${monthYear}`;

  // Fetch weather for the holiday period (up to 7 days)
  const holidayLengthDays = Math.min(7, Math.ceil((endDate.getTime() - new Date().getTime()) / 86400000) + 1);
  const [results, weatherDays] = await Promise.all([
    braveSearch(query, 6),
    getWeatherForecast(holidayLengthDays),
  ]);
  const searchContext = formatSearchResults(results);

  if (results.length === 0) return '';

  // Filter forecast to the holiday window
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = endDate.toISOString().slice(0, 10);
  const holidayWeather = weatherDays.filter(d => d.date >= startDateStr && d.date <= endDateStr);
  const weatherSection = holidayWeather.length > 0
    ? `Weather forecast for the holiday:\n${formatWeekWeather(holidayWeather)}`
    : '';

  const prompt = `${holidayName} starts in a few days (${startStr}–${endStr}). Toni will be at home with the kids in ${config.location}.

Based on these search results for local things to do:

${searchContext}

${weatherSection ? `${weatherSection}\n\nUse the forecast to help tailor suggestions — point them towards outdoor options on the good-weather days and indoor venues when it looks wet. Mention the forecast briefly so they can plan the week.` : ''}

Write a friendly, practical message suggesting 3–5 specific activities or places they could visit during the holidays. Be specific — use actual names and venues from the results where possible. Write like a PA sharing useful finds, not a robot making a list. Keep it warm and concise. Don't invent places or events not in the results.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 600,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || '';
}

export async function generateWeekendEvents(): Promise<string> {
  const { braveSearch, formatSearchResults } = await import('./search');

  const now = getLocalNow(config.timezone);
  const dayOfWeek = now.getDay();
  const sat = new Date(now);
  sat.setDate(now.getDate() + (6 - dayOfWeek));
  const satStr = sat.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: config.timezone });

  const query1 = `events ${config.location} weekend ${satStr}`;
  const query2 = `what's on ${config.location} this weekend family`;
  const [results1, results2, weatherDays] = await Promise.all([
    braveSearch(query1, 5),
    braveSearch(query2, 4),
    getWeatherForecast(7),
  ]);

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const results = [...results1, ...results2].filter(r => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });
  const searchContext = formatSearchResults(results);

  if (results.length === 0) return '';

  // Find Saturday and Sunday in the forecast
  const satDate = sat.toISOString().slice(0, 10);
  const sunDate = new Date(sat.getTime() + 86400000).toISOString().slice(0, 10);
  const satWeather = weatherDays.find(d => d.date === satDate);
  const sunWeather = weatherDays.find(d => d.date === sunDate);
  const weatherSection = [
    satWeather ? `Saturday: ${formatDayWeather(satWeather)}` : '',
    sunWeather ? `Sunday: ${formatDayWeather(sunWeather)}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `It's Wednesday. You're letting Luke and Toni know what's actually happening this coming weekend (${satStr}) in ${config.location}.

Search results for local events:

${searchContext}

${weatherSection ? `Weekend weather forecast:\n${weatherSection}\n\nFactor the weather into your suggestions — if Saturday's dry, outdoor events first; if it's wet, lead with indoor ones or flag that they'll need to wrap up.` : ''}

RULES:
- Only mention events that appear in the search results with a specific name, date/time, or venue. Do NOT invent, generalise, or suggest permanent attractions (museums, parks, etc.) unless a specific event is happening there this weekend with actual details.
- If the results are thin or vague, be honest: "Not loads on this weekend — might be a quiet one" is better than padding with generic days out.
- Aim for 2–4 specific things. Sound like a PA who's actually done the research, not a search engine summary.
- Keep it short and warm.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 500,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || '';
}

export async function generateBabyChecklistReminder(): Promise<string> {
  const dueDate = new Date(config.family.babyDue);
  const now = getLocalNow(config.timezone);

  if (now >= dueDate) return ''; // baby has arrived

  const items = await getBabyChecklist();
  if (items.length === 0) return ''; // all done!

  const msUntilDue = dueDate.getTime() - now.getTime();
  const weeksRemaining = Math.floor(msUntilDue / (1000 * 60 * 60 * 24 * 7));

  const itemList = items
    .map((i) => `- ${i.item}${i.category ? ` (${i.category})` : ''}`)
    .join('\n');

  const prompt = `${weeksRemaining} weeks until the baby is due. ${items.length} item${items.length === 1 ? '' : 's'} still outstanding on the baby prep checklist:

${itemList}

Write a short, warm nudge for Luke and Toni's family Telegram chat. Highlight 2–3 of the most important outstanding items (sleeping and safety gear first if present). Gently encourage them to tick a couple off — light and supportive, not nagging. 3–4 sentences max.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 300,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || '';
}

export async function generatePregnancyUpdate(): Promise<string> {
  const dueDate = new Date(config.family.babyDue);
  const now = getLocalNow(config.timezone);

  if (now >= dueDate) return ''; // baby has arrived — stop sending

  const msUntilDue = dueDate.getTime() - now.getTime();
  const daysUntilDue = Math.floor(msUntilDue / (1000 * 60 * 60 * 24));
  const weeksRemaining = Math.floor(daysUntilDue / 7);
  const currentWeek = 40 - weeksRemaining;

  if (currentWeek < 1) return '';

  const dueDateStr = dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `Toni is ${currentWeek} weeks pregnant (due ${dueDateStr}, ${weeksRemaining} weeks to go). Write a warm Monday morning pregnancy update for her and Luke to read in their family Telegram chat.

Include:
1. The week number and weeks remaining
2. What the baby is roughly the size of (a recognisable fruit, vegetable, or object)
3. One or two things happening developmentally or physically this week — accurate but conversational, not clinical
4. A short warm closing note

4–6 sentences. Warm and personal, like it's from a friend who knows them — not a medical leaflet.`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 400,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text || '';
}

// ── Message intent detection ──────────────────────────────────────────────────

export async function shouldRoseRespond(
  message: string,
  isDirectlyMentioned: boolean
): Promise<boolean> {
  if (isDirectlyMentioned) return true;

  const response = await createMessage({
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
