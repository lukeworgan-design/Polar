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
  clearTodos,
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
  getSetting,
  setSetting,
  addBabyLog,
  getLastBabyLog,
  getBabyLogsSince,
  addBabyWeight,
  getBabyWeights,
  BabyLogType,
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
import { getFridayBinType, binLabel, nextFridayDate } from './bin';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── Baby arrival state ──────────────────────────────────────────────────────────
// Held in memory so the (synchronous) system prompt can read it, backed by the
// app_settings table so it survives restarts. Seeded from env, hydrated from DB
// at startup (loadBabyArrival), and updated live when Rose is told the baby is here.
interface BabyArrival { bornOn: string; name: string | null }
let babyArrival: BabyArrival | null =
  config.family.babyBorn ? { bornOn: config.family.babyBorn, name: config.family.babyName } : null;

export async function loadBabyArrival(): Promise<void> {
  try {
    const bornOn = await getSetting('baby_born_date');
    if (bornOn) {
      const name = await getSetting('baby_name');
      babyArrival = { bornOn, name: name ?? config.family.babyName };
    }
  } catch (err) {
    console.error('Failed to load baby arrival state:', err);
  }
}

function getBabyArrival(): BabyArrival | null {
  return babyArrival;
}

/** Evie's date of birth (from the recorded arrival, falling back to config). */
function babyDob(): string | null {
  return babyArrival?.bornOn ?? config.family.babyBorn ?? null;
}

function babyDisplayName(): string {
  return babyArrival?.name ?? config.family.babyName ?? 'the baby';
}

/** Age in whole days / weeks from DOB. */
function babyAgeDays(): number | null {
  const dob = babyDob();
  if (!dob) return null;
  const born = new Date(`${dob}T12:00:00`);
  return Math.floor((Date.now() - born.getTime()) / (1000 * 60 * 60 * 24));
}

function humanSince(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs}h ago` : `${hrs}h ${rem}m ago`;
}

/**
 * UK routine childhood immunisation schedule (NHS), as offsets from DOB.
 * Returns the schedule with computed calendar dates.
 */
function immunisationSchedule(): Array<{ dueWeeks: number; label: string; date: string }> {
  const dob = babyDob();
  if (!dob) return [];
  const born = new Date(`${dob}T12:00:00`);
  const milestones: Array<{ weeks: number; label: string }> = [
    { weeks: 8, label: '8-week jabs (6-in-1, rotavirus, MenB)' },
    { weeks: 12, label: '12-week jabs (6-in-1, pneumococcal, rotavirus)' },
    { weeks: 16, label: '16-week jabs (6-in-1, MenB)' },
    { weeks: 52, label: '1-year jabs (Hib/MenC, MMR, pneumococcal, MenB)' },
  ];
  return milestones.map((m) => {
    const d = new Date(born);
    d.setDate(d.getDate() + m.weeks * 7);
    return { dueWeeks: m.weeks, label: m.label, date: d.toISOString().slice(0, 10) };
  });
}

/** If a jab is roughly a week away, return a ready-to-send reminder (with a dedupe key). */
export function getDueImmunisationReminder(): { key: string; message: string } | null {
  const schedule = immunisationSchedule();
  if (schedule.length === 0) return null;
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
  for (const s of schedule) {
    const days = Math.round((new Date(s.date).getTime() - new Date(todayStr).getTime()) / (1000 * 60 * 60 * 24));
    if (days >= 5 && days <= 8) {
      const pretty = new Date(`${s.date}T12:00:00`).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
      });
      return {
        key: `jab:${s.date}`,
        message: `💉 Heads up — ${babyDisplayName()}'s ${s.label} are due around ${pretty}. The GP surgery usually sends an invite, but worth booking if you've not heard.`,
      };
    }
  }
  return null;
}

/** Parse a spoken weight ('4.2kg', '9lb 4oz', '4200g') into grams, or null. */
function parseWeightToGrams(input: string): number | null {
  const s = input.toLowerCase().trim();
  const lbOz = s.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)\s*(?:(\d+(?:\.\d+)?)\s*(?:oz|ounce|ounces))?/);
  if (lbOz) {
    const lb = parseFloat(lbOz[1]!);
    const oz = lbOz[2] ? parseFloat(lbOz[2]!) : 0;
    return Math.round((lb * 453.592) + (oz * 28.3495));
  }
  const kg = s.match(/(\d+(?:\.\d+)?)\s*kg/);
  if (kg) return Math.round(parseFloat(kg[1]!) * 1000);
  const g = s.match(/(\d+(?:\.\d+)?)\s*g/);
  if (g) return Math.round(parseFloat(g[1]!));
  const bare = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const n = parseFloat(bare[1]!);
    return n < 20 ? Math.round(n * 1000) : Math.round(n); // <20 assume kg, else grams
  }
  return null;
}

function formatGrams(grams: number): string {
  const kg = (grams / 1000).toFixed(2);
  const totalOz = grams / 28.3495;
  const lb = Math.floor(totalOz / 16);
  const oz = Math.round(totalOz - lb * 16);
  return `${kg}kg (${lb}lb ${oz}oz)`;
}

/**
 * Safety check for infant paracetamol / ibuprofen. Newborns should not be given
 * these without medical advice; paracetamol is licensed from 2 months (and one
 * post-8-week-jab dose from 2 months), ibuprofen from 3 months / 5kg.
 * Returns a warning string, or null if nothing to flag.
 */
async function medicineSafetyNote(medicine: string): Promise<string | null> {
  const med = medicine.toLowerCase();
  const isParacetamol = /calpol|paracetamol|infant suspension/.test(med);
  const isIbuprofen = /ibuprofen|nurofen/.test(med);
  const ageDays = babyAgeDays();

  if ((isParacetamol || isIbuprofen) && ageDays !== null) {
    if (isParacetamol && ageDays < 61) {
      return `⚠️ Evie is under 2 months — infant paracetamol should only be given on the advice of a GP, health visitor, or 111. Please check first.`;
    }
    if (isIbuprofen && ageDays < 92) {
      return `⚠️ Evie is under 3 months — infant ibuprofen isn't suitable yet. Please check with a GP, health visitor, or 111.`;
    }
  }

  // Interval check against the last recorded dose of the same medicine.
  const last = await getLastBabyLog('medicine');
  if (last && last.detail && last.detail.toLowerCase().includes(med.split(' ')[0] ?? med)) {
    const minsSince = (Date.now() - new Date(last.logged_at).getTime()) / 60000;
    if (isParacetamol && minsSince < 240) {
      const wait = Math.ceil((240 - minsSince) / 60 * 10) / 10;
      return `⚠️ Last ${last.detail} dose was ${humanSince(last.logged_at)}. Paracetamol doses must be at least 4 hours apart (max 4 in 24h) — wait about ${wait}h before the next.`;
    }
    if (isIbuprofen && minsSince < 360) {
      return `⚠️ Last ${last.detail} dose was ${humanSince(last.logged_at)}. Ibuprofen doses must be at least 6–8 hours apart — please wait.`;
    }
  }
  return null;
}

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
    name: 'record_baby_arrival',
    description: "Record that the baby has been born. Call this as soon as Luke or Toni say the baby has arrived. This stops all pregnancy/due-date/countdown messaging permanently.",
    input_schema: {
      type: 'object' as const,
      properties: {
        born_on: { type: 'string', description: "The baby's date of birth as YYYY-MM-DD. If they don't give a date, use today's date." },
        name: { type: 'string', description: "The baby's name, if known (optional)" },
      },
      required: ['born_on'],
    },
  },
  {
    name: 'log_baby_event',
    description: "Log a newborn care event (feed, nappy, sleep, medicine, or pumped/expressed milk). Call this whenever Luke or Toni mention one, e.g. 'fed Evie 90ml', 'dirty nappy', 'she's asleep', 'gave her vitamin D'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['feed', 'nappy', 'sleep', 'medicine', 'pump'], description: 'The kind of event' },
        detail: { type: 'string', description: "For feed: 'left'/'right'/'bottle'/'breast'. For nappy: 'wet'/'dirty'/'both'. For sleep: 'asleep' or 'awake'. For medicine: the medicine name (e.g. 'Vitamin D', 'Calpol'). Optional otherwise." },
        amount: { type: 'string', description: "Optional amount, e.g. '90ml' for a feed, '2.5ml' for medicine, '45 min' for a nap." },
        time: { type: 'string', description: "Optional ISO datetime if the event wasn't just now (e.g. a 3am feed logged later). Omit for 'now'." },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_baby_last',
    description: "Get when the baby last did something (feed, nappy, sleep, medicine). Use for 'when did she last feed?', 'when was her last nappy?'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['feed', 'nappy', 'sleep', 'medicine', 'pump'], description: 'What to look up' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_baby_day_summary',
    description: "Summarise the baby's feeds, nappies, sleep and medicine over the last 24 hours (or a given day). Use for 'how's Evie done today?' or an overnight recap.",
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: "Optional YYYY-MM-DD. Omit for the last 24 hours." },
      },
      required: [],
    },
  },
  {
    name: 'log_baby_weight',
    description: "Record the baby's weight from a weigh-in (health visitor / red book).",
    input_schema: {
      type: 'object' as const,
      properties: {
        weight: { type: 'string', description: "Weight as said, e.g. '4.2kg', '9lb 4oz', '4200g'." },
        date: { type: 'string', description: "Optional YYYY-MM-DD the weight was measured. Omit for today." },
        note: { type: 'string', description: 'Optional note (e.g. centile, who weighed).' },
      },
      required: ['weight'],
    },
  },
  {
    name: 'get_baby_growth',
    description: "Get the baby's recorded weights over time to see the trend.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_immunisation_schedule',
    description: "Get the baby's UK childhood immunisation schedule with dates computed from her date of birth, and how far away each is.",
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
    name: 'clear_todo_list',
    description: "Clear the entire to-do list (mark all items as done). Use when asked to clear/empty the to-do list or start fresh.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
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
    name: 'get_bin_day',
    description: "Get which bin (green/general or blue/recycling) is going out next, and when. Use this for any bin question — 'what's bin day this week?', 'which bin goes out?', 'is it recycling this week?'. Bins are collected on Fridays in Cheltenham; do NOT look at the calendar for this.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
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
        const itemName = toolInput['item'] as string;
        await addShoppingItem(itemName, userName);
        // Verify it persisted.
        const after = await getShoppingList();
        if (!after.some((i) => i.item.toLowerCase() === itemName.toLowerCase())) {
          return `⚠️ Tried to add "${itemName}" but it did NOT save to the shopping list. Tell the user it failed — do not claim success.`;
        }
        return `Added "${itemName}" to the shopping list. The list now has ${after.length} item(s).`;
      }

      case 'remove_shopping_item': {
        const removed = await removeShoppingItem(toolInput['item'] as string);
        return removed
          ? `Removed "${toolInput['item']}" from the shopping list.`
          : `Couldn't find "${toolInput['item']}" on the shopping list.`;
      }

      case 'clear_shopping_list': {
        const count = await clearShoppingList();
        // Verify the list is actually empty now.
        const remaining = await getShoppingList();
        if (remaining.length > 0) {
          return `⚠️ Tried to clear the shopping list but ${remaining.length} item(s) are still on it. Tell the user the clear did NOT work — do not claim success.`;
        }
        return count > 0
          ? `Cleared ${count} item(s) from the shopping list. It is now empty.`
          : 'The shopping list was already empty.';
      }

      case 'record_baby_arrival': {
        const bornOn = toolInput['born_on'] as string;
        const name = (toolInput['name'] as string | undefined)?.trim() || null;
        await setSetting('baby_born_date', bornOn);
        if (name) await setSetting('baby_name', name);
        babyArrival = { bornOn, name: name ?? babyArrival?.name ?? null };
        return `Recorded the baby's arrival${name ? ` — welcome, ${name}!` : ''} (born ${bornOn}). Pregnancy countdown and due-date reminders are now switched off. Congratulations to Luke and Toni! 🎉`;
      }

      case 'log_baby_event': {
        const type = toolInput['type'] as BabyLogType;
        const detail = (toolInput['detail'] as string | undefined)?.trim() || null;
        const amount = (toolInput['amount'] as string | undefined)?.trim() || null;
        const at = toolInput['time']
          ? parseInTimezone(toolInput['time'] as string, config.timezone)
          : undefined;

        let safety: string | null = null;
        if (type === 'medicine' && detail) {
          safety = await medicineSafetyNote(detail);
        }

        await addBabyLog(type, detail, amount, userName, at);

        const name = babyDisplayName();
        const bits = [detail, amount].filter(Boolean).join(', ');
        let msg = `Logged: ${name} — ${type}${bits ? ` (${bits})` : ''}${at ? ` at ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone })}` : ''}.`;

        // Helpful context: gap since previous feed
        if (type === 'feed') {
          const since = await getBabyLogsSince(new Date(Date.now() - 36 * 3600 * 1000).toISOString());
          const feeds = since.filter((l) => l.type === 'feed');
          if (feeds.length >= 2) {
            const prev = feeds[feeds.length - 2]!;
            msg += ` (${humanSince(prev.logged_at).replace(' ago', '')} since the last feed)`;
          }
        }
        if (safety) msg += `\n\n${safety}`;
        return msg;
      }

      case 'get_baby_last': {
        const type = toolInput['type'] as BabyLogType;
        const last = await getLastBabyLog(type);
        const name = babyDisplayName();
        if (!last) return `No ${type} logged for ${name} yet.`;
        const bits = [last.detail, last.amount].filter(Boolean).join(', ');
        return `${name}'s last ${type} was ${humanSince(last.logged_at)}${bits ? ` (${bits})` : ''}.`;
      }

      case 'get_baby_day_summary': {
        const name = babyDisplayName();
        let sinceIso: string;
        let label: string;
        if (toolInput['date']) {
          sinceIso = `${toolInput['date']}T00:00:00`;
          label = `on ${toolInput['date']}`;
        } else {
          sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
          label = 'in the last 24h';
        }
        const logs = await getBabyLogsSince(sinceIso);
        if (logs.length === 0) return `Nothing logged for ${name} ${label} yet.`;

        const feeds = logs.filter((l) => l.type === 'feed');
        const nappies = logs.filter((l) => l.type === 'nappy');
        const wet = nappies.filter((l) => (l.detail ?? '').includes('wet') || (l.detail ?? '').includes('both')).length;
        const dirty = nappies.filter((l) => (l.detail ?? '').includes('dirty') || (l.detail ?? '').includes('both')).length;
        const meds = logs.filter((l) => l.type === 'medicine');
        const sleeps = logs.filter((l) => l.type === 'sleep');

        const totalMl = feeds.reduce((sum, f) => {
          const m = (f.amount ?? '').match(/(\d+)\s*ml/i);
          return sum + (m ? parseInt(m[1]!, 10) : 0);
        }, 0);

        const lines = [
          `👶 ${name} ${label}:`,
          `• Feeds: ${feeds.length}${totalMl > 0 ? ` (~${totalMl}ml)` : ''}`,
          `• Nappies: ${nappies.length}${nappies.length ? ` (${wet} wet, ${dirty} dirty)` : ''}`,
          sleeps.length ? `• Sleep events logged: ${sleeps.length}` : '',
          meds.length ? `• Medicine: ${meds.map((m) => m.detail).filter(Boolean).join(', ')}` : '',
        ].filter(Boolean);
        return lines.join('\n');
      }

      case 'log_baby_weight': {
        const grams = parseWeightToGrams(toolInput['weight'] as string);
        if (grams === null) return `Sorry, I couldn't read "${toolInput['weight']}" as a weight — try like "4.2kg" or "9lb 4oz".`;
        const measuredOn = (toolInput['date'] as string | undefined) ||
          new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
        const note = (toolInput['note'] as string | undefined)?.trim() || null;
        await addBabyWeight(grams, measuredOn, note, userName);
        return `Recorded ${babyDisplayName()}'s weight: ${formatGrams(grams)} on ${measuredOn}.`;
      }

      case 'get_baby_growth': {
        const weights = await getBabyWeights();
        const name = babyDisplayName();
        if (weights.length === 0) return `No weights recorded for ${name} yet.`;
        const rows = weights.map((w) => `• ${w.measured_on}: ${formatGrams(w.grams)}${w.note ? ` — ${w.note}` : ''}`);
        let trend = '';
        if (weights.length >= 2) {
          const first = weights[0]!;
          const last = weights[weights.length - 1]!;
          const diff = last.grams - first.grams;
          trend = `\nChange since ${first.measured_on}: ${diff >= 0 ? '+' : ''}${diff}g.`;
        }
        return `${name}'s weights:\n${rows.join('\n')}${trend}`;
      }

      case 'get_immunisation_schedule': {
        const schedule = immunisationSchedule();
        const name = babyDisplayName();
        if (schedule.length === 0) return `No date of birth on record, so I can't work out ${name}'s jab dates.`;
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
        const rows = schedule.map((s) => {
          const days = Math.round((new Date(s.date).getTime() - new Date(todayStr).getTime()) / (1000 * 60 * 60 * 24));
          const when = days < 0 ? 'done/overdue' : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`;
          return `• ${s.date} — ${s.label} (${when})`;
        });
        return `${name}'s NHS immunisation schedule:\n${rows.join('\n')}\n\nYou'll get an invite from the GP surgery — these dates are a guide.`;
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

      case 'clear_todo_list': {
        const count = await clearTodos();
        const remaining = await getTodos();
        if (remaining.length > 0) {
          return `⚠️ Tried to clear the to-do list but ${remaining.length} item(s) remain. Tell the user it did NOT clear — do not claim success.`;
        }
        return count > 0 ? `Cleared ${count} item(s) from the to-do list. It is now empty.` : 'The to-do list was already empty.';
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
        const mealDate = toolInput['date'] as string;
        const mealType = toolInput['meal_type'] as MealType;
        const mealName = toolInput['meal'] as string;
        await setMeal(mealDate, mealType, mealName, userName);
        // Verify it actually persisted — read the row straight back.
        const check = await getMealPlan(mealDate, mealDate);
        const saved = check.find((m) => m.meal_type === mealType && m.meal === mealName);
        if (!saved) {
          return `⚠️ Tried to save ${mealType} on ${mealDate} ("${mealName}") but it did NOT persist to the database. Tell the user the save failed and to try again — do NOT claim it was saved.`;
        }
        return `Saved and verified: ${mealType} on ${mealDate} = "${mealName}".`;
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

      case 'get_bin_day': {
        const type = getFridayBinType();
        const { colour, label } = binLabel(type);
        const friday = nextFridayDate();
        const dayStr = friday.toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
        });
        return `Next bin collection is ${dayStr}: the ${label}. (${colour} bin out Thursday night.)`;
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
  const arrival = getBabyArrival();

  let babyLines: string;
  if (arrival) {
    const bornDate = new Date(`${arrival.bornOn}T12:00:00`);
    const bornStr = bornDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const ageDays = Math.max(0, Math.floor((now.getTime() - bornDate.getTime()) / (1000 * 60 * 60 * 24)));
    const nameStr = arrival.name ? ` ${arrival.name}` : '';
    babyLines = `- 🎉 THE BABY HAS ARRIVED: baby${nameStr} was born on ${bornStr} (${ageDays} day${ageDays === 1 ? '' : 's'} old). There is a newborn in the house.
- The pregnancy is over. NEVER ask about the due date, labour, "twinges", hospital bag, or being overdue — that's all in the past. If it comes up, congratulate them warmly.
- Be gentle and supportive of two knackered new parents: help with feeds/sleep tracking if asked, keep other reminders light, and don't pile on.`;
  } else {
    const babyDue = new Date(config.family.babyDue);
    const babyDueStr = babyDue.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const daysUntilBaby = Math.ceil((babyDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const babyCountdown = daysUntilBaby > 0 ? `${daysUntilBaby} days to go` : 'any day now!';
    babyLines = `- Baby due ${babyDueStr} — ${babyCountdown}
- As the due date gets closer, gently flag things like childcare cover for Poppy and Billy, hospital bag readiness, and last-minute prep. If Luke or Toni mention the baby has arrived, call record_baby_arrival straight away so you stop the countdown.`;
  }

  const babyName = babyDisplayName();
  const newbornSection = arrival ? `

NEWBORN CARE & VIRTUAL NANNY (${babyName} is a newborn):
- TRACKING: When Luke or Toni mention a feed, nappy, nap, dose of medicine, or expressed milk, call log_baby_event to record it. If they ask "when did she last feed/have a nappy?", call get_baby_last. For "how's she done today / overnight?", call get_baby_day_summary. Log weigh-ins with log_baby_weight and show trends with get_baby_growth. For jab timings, call get_immunisation_schedule.
- MEDICINE SAFETY: Never suggest a paracetamol/ibuprofen dose or interval yourself. The log_baby_event tool returns a safety note — surface it clearly. For a baby this young, always steer them to a GP, health visitor, or 111 before giving pain/fever medicine.
- REASSURANCE (you are a supportive nanny, not a doctor): You can share general, widely-accepted newborn guidance — safe sleep (on the back, in a clear flat cot, room temp ~16-20°C), rough feed frequency, normal nappy counts, soothing tips, cluster feeding, cradle cap, etc. Always frame it as general info, keep it calm and practical, and remind them you're not a substitute for a medical professional.
- RED FLAGS — this is critical. If anything suggests a medical emergency or a poorly young baby, tell them plainly to contact the right service NOW rather than reassuring:
  • 999 / A&E: trouble breathing, blue/grey/very pale, unresponsive or floppy, a fit/seizure, a spreading rash that doesn't fade under a glass.
  • 111 or GP urgently: any fever in a baby under 3 months (38°C+), not feeding / far fewer wet nappies, persistent vomiting, unusually drowsy or inconsolable, or you're simply worried.
  Never downplay these or tell them to "wait and see". When in doubt, say get it checked.
- Keep the tone warm and steady — they're exhausted. Short, kind, practical.` : '';

  return `You are Rose, a family personal assistant living inside a Telegram group chat shared by Luke and Toni. You're like a brilliant friend who happens to be incredibly organised — warm, casual, occasionally witty, always helpful.

Current date and time: ${dateStr} at ${timeStr} (${config.timezone})

FAMILY:
- Luke and Toni are the parents
- Kids: ${children.map(c => `${c.name} (${ageFromDob(c.dob)})`).join(', ')}
- Based in ${config.location}
${babyLines}
- They have a dog — whenever Luke is away from home (day travel or overnight), dog walker coverage needs to be in place
- Luke mainly works from home, but has occasional day trips and overnight stays for work
${newbornSection}
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
- CRITICAL: When asked what's on the shopping list, to-do list, calendar, or meal plan, you MUST call the relevant tool (get_shopping_list, get_todo_list, get_todays_events, get_meal_plan) to fetch the LIVE data every time — NEVER answer from memory or the earlier conversation. Items can be added or removed via voice or the wall dashboard, so the conversation is not a reliable record. List exactly what the tool returns.

TASK & LIST HANDLING:
- CRITICAL: You cannot change any list by yourself — the ONLY way to add, remove, or clear items is by calling the tools (add_shopping_item, remove_shopping_item, clear_shopping_list, add_todo, complete_todo). NEVER say you've cleared, added, removed, or "updated" a list unless you actually called the matching tool in this turn and it returned success. Do NOT invent or describe a "new list" from memory — if you want to show the resulting list, call get_shopping_list (or get_todo_list) AFTER your changes and read back exactly what it returns.
- For a "clear and replace" request: first call clear_shopping_list, then call add_shopping_item once per new item, then (optionally) call get_shopping_list to confirm. Only report success after the tools have run.
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

  // Pre-fetch the live shopping and to-do lists too, so Rose reports/clears the
  // REAL lists rather than what she thinks they are from the conversation.
  let listsGroundTruth: string;
  try {
    const [shopping, todos] = await Promise.all([getShoppingList(), getTodos()]);
    listsGroundTruth = [
      `[LISTS GROUND TRUTH — fetched right now, authoritative]:`,
      `Shopping list (${shopping.length}): ${shopping.length === 0 ? 'empty' : shopping.map((i) => i.item).join(', ')}`,
      `To-do list (${todos.length}): ${todos.length === 0 ? 'empty' : todos.map((t) => t.task).join(', ')}`,
      `Use these exact contents for any list question. Do NOT rely on the conversation. To change a list you MUST call the tool (add/remove/clear) — never just say you did.`,
    ].join('\n');
  } catch (err) {
    console.error('Failed to pre-fetch lists ground truth:', err);
    listsGroundTruth = `[LISTS GROUND TRUTH — unavailable; use get_shopping_list / get_todo_list tools to fetch live data.]`;
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
          text: `${calendarGroundTruth}\n\n${listsGroundTruth}\n\n${userName}: ${textPrompt}`,
        },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: `${calendarGroundTruth}\n\n${listsGroundTruth}\n\n${userName}: ${userMessage}`,
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

  // Overnight newborn recap (best-effort — never let a missing table break the summary).
  let babyRecap = '';
  if (getBabyArrival()) {
    try {
      const logs = await getBabyLogsSince(new Date(Date.now() - 12 * 3600 * 1000).toISOString());
      if (logs.length > 0) {
        const feeds = logs.filter(l => l.type === 'feed').length;
        const nappies = logs.filter(l => l.type === 'nappy').length;
        const sleeps = logs.filter(l => l.type === 'sleep').length;
        babyRecap = `${babyDisplayName()} overnight (last 12h): ${feeds} feed(s), ${nappies} nappy change(s)${sleeps ? `, ${sleeps} sleep note(s)` : ''}.`;
      }
    } catch (err) {
      console.error('Baby recap fetch failed (table may not exist yet):', err);
    }
  }

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

${babyRecap ? `BABY OVERNIGHT: ${babyRecap}\nInclude a short **👶 ${babyDisplayName()}** line with this overnight recap. Keep it warm and brief.` : ''}

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
  const now = getLocalNow(config.timezone);
  const todayStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
  const todayISO = localIso(now);

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone });
  const tomorrowISO = localIso(tomorrow);
  const tomorrowStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);

  await refreshLocalEventsTicker().catch(() => {});
  const [todayEvents, saturdayEvents, weatherDays] = await Promise.all([
    getTodaysEvents(),
    getEventsForPeriod(tomorrowStart, tomorrowEnd),
    getWeatherForecast(2),
  ]);
  const localEvents = getUpcomingLocalEvents(todayISO, tomorrowISO);
  const eventsText = localEvents.length > 0 ? localEvents.map(e => `- ${e}`).join('\n') : 'None found for today/tomorrow.';

  const todayWeather = weatherDays.length > 0 ? formatDayWeather(weatherDays[0]) : '';
  const satWeather = weatherDays.length > 1 ? formatDayWeather(weatherDays[1]) : '';

  const prompt = `It's Friday at 3pm — school's out! Generate a short, energetic check-in for Luke and Toni about what's on locally this afternoon/evening and tomorrow (Saturday).

Today (Friday): ${todayStr}
Tomorrow (Saturday): ${tomorrowStr}

Friday afternoon calendar:
${formatEventsForAI(todayEvents) || 'Nothing in the calendar this afternoon'}

Saturday calendar:
${formatEventsForAI(saturdayEvents) || 'Nothing in the calendar'}

Confirmed, dated local events (Fri/Sat) — use ONLY these, never invent or add permanent attractions:
${eventsText}

Weekend weather:
${todayWeather ? `Friday: ${todayWeather}` : ''}
${satWeather ? `Saturday: ${satWeather}` : ''}

RULES:
- Open with energy — "School's out!" or similar
- Mention 2–3 of the dated local events above (name, time, venue). If there are none, just say it's a quiet one — don't pad.
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
  const now = getLocalNow(config.timezone);
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
  // Saturday: cover today + tomorrow (Sun). Sunday: just today.
  const todayISO = localIso(now);
  const toISO = day === 'saturday' ? localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) : todayISO;

  await refreshLocalEventsTicker().catch(() => {});
  const [todos, todayEvents, weatherDays] = await Promise.all([
    getTodos(),
    getTodaysEvents(),
    getWeatherForecast(day === 'saturday' ? 2 : 1),
  ]);
  const localEvents = getUpcomingLocalEvents(todayISO, toISO);
  const searchContext = localEvents.length > 0
    ? localEvents.map(e => `- ${e}`).join('\n')
    : 'No dated local events found for this window.';

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

Confirmed, dated local events (already researched — use ONLY these, never invent or add attractions):
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

Confirmed, dated local events (already researched — use ONLY these, never invent or add attractions):
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
  const now = getLocalNow(config.timezone);
  const dayOfWeek = now.getDay();
  const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - dayOfWeek));
  const sun = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + 1);
  const satISO = localIso(sat);
  const sunISO = localIso(sun);
  const satStr = sat.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: config.timezone });

  // Refresh the curated, dated events list, then pull just this weekend's.
  await refreshLocalEventsTicker().catch(() => {});
  const events = getUpcomingLocalEvents(satISO, sunISO);
  if (events.length === 0) return ''; // genuinely nothing dated on — stay quiet

  const weatherDays = await getWeatherForecast(7);
  const satWeather = weatherDays.find(d => d.date === satISO);
  const sunWeather = weatherDays.find(d => d.date === sunISO);
  const weatherSection = [
    satWeather ? `Saturday: ${formatDayWeather(satWeather)}` : '',
    sunWeather ? `Sunday: ${formatDayWeather(sunWeather)}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `It's Wednesday. Let Luke and Toni know what's actually on this coming weekend (${satStr}) in ${config.location}.

These are the confirmed, specifically-dated local family events (already researched and verified). Use ONLY these — do NOT invent anything, add permanent attractions, or pad with generic days out:
${events.map(e => `- ${e}`).join('\n')}

${weatherSection ? `Weekend weather:\n${weatherSection}\n\nFactor the weather in — dry days favour the outdoor ones; if it's wet, lead with indoor or flag they'll need to wrap up.` : ''}

Write a short, warm weekend round-up — group by day if it helps, mention times/venues, sound like a PA who's done the research. WhatsApp-length, not a newsletter.`;

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
  if (getBabyArrival()) return ''; // baby has arrived — no more prep nudges
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
  if (getBabyArrival()) return ''; // baby has arrived — stop pregnancy updates
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

// ── Voice: create a calendar event from Alexa-resolved slots ───────────────────

export async function createCalendarEventStructured(
  summary: string,
  dateStr: string,
  timeStr?: string,
): Promise<string> {
  // If Alexa didn't resolve a concrete calendar date (e.g. "next week"), fall
  // back to the free-text parser which reasons about relative dates.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return createCalendarEventFromText([summary, dateStr, timeStr].filter(Boolean).join(' '));
  }
  const spokenDate = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  try {
    if (timeStr && /^\d{2}:\d{2}/.test(timeStr)) {
      const start = parseInTimezone(`${dateStr}T${timeStr.slice(0, 5)}:00`, config.timezone);
      const end = new Date(start.getTime() + 60 * 60000);
      await createEvent({ summary, start, end });
      const t = start.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: config.timezone }).replace(':00', '').replace(' ', '');
      return `Added ${summary} to the calendar on ${spokenDate} at ${t}.`;
    }
    const start = new Date(`${dateStr}T12:00:00Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60000);
    await createEvent({ summary, start, end, allDay: true });
    return `Added ${summary} to the calendar on ${spokenDate}.`;
  } catch (err) {
    console.error('createCalendarEventStructured failed:', err);
    return `I understood the event but couldn't save it just now.`;
  }
}

// ── Voice: create a calendar event from a free-text phrase (used by Alexa) ─────

export async function createCalendarEventFromText(details: string): Promise<string> {
  const now = getLocalNow(config.timezone);
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
  const refBase = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  const dateReference = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(refBase);
    d.setDate(refBase.getDate() + i);
    return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone })} = ${d.toLocaleDateString('en-CA', { timeZone: config.timezone })}`;
  }).join(', ');

  const prompt = `Today is ${dateStr} (${config.timezone}). Extract a SINGLE calendar event from this spoken request and reply with ONLY a JSON object, no other text.

Request: "${details}"

JSON shape: {"summary": string, "date": "YYYY-MM-DD", "start_time": "HH:mm" or null, "duration_minutes": number}
Rules:
- Interpret relative dates ("tomorrow", "next Tuesday") against today using the DATE REFERENCE below.
- If a time is given, set start_time (24h) and a sensible duration_minutes (default 60).
- If no time is given, set start_time to null (an all-day event).
- Clean up the summary into a tidy title (e.g. "dentist" → "Dentist appointment" only if clearly implied; otherwise keep it short and natural).
- If you cannot determine a date at all, reply with {"error": "no date"}.

DATE REFERENCE: ${dateReference}`;

  const response = await createMessage({
    model: config.anthropic.model,
    max_tokens: 200,
    system: 'You output only a single JSON object describing a calendar event. No prose.',
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return `Sorry, I couldn't work out that event. Try including a day and time.`;

  let parsed: { summary?: string; date?: string; start_time?: string | null; duration_minutes?: number; error?: string };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return `Sorry, I couldn't work out that event. Try including a day and time.`;
  }
  if (parsed.error || !parsed.date || !parsed.summary) {
    return `Sorry, I couldn't work out when that should be. Try saying something like: add dentist on Tuesday at 3pm.`;
  }

  const summary = parsed.summary;
  const spokenDate = new Date(`${parsed.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  try {
    if (parsed.start_time) {
      const start = parseInTimezone(`${parsed.date}T${parsed.start_time}:00`, config.timezone);
      const end = new Date(start.getTime() + (parsed.duration_minutes || 60) * 60000);
      await createEvent({ summary, start, end });
      const timeStr = start.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: config.timezone }).replace(':00', '').replace(' ', '');
      return `Added ${summary} to the calendar on ${spokenDate} at ${timeStr}.`;
    }
    // All-day: use noon UTC anchors so the date can't slip.
    const start = new Date(`${parsed.date}T12:00:00Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60000);
    await createEvent({ summary, start, end, allDay: true });
    return `Added ${summary} to the calendar on ${spokenDate}.`;
  } catch (err) {
    console.error('createCalendarEventFromText: createEvent failed:', err);
    return `I understood the event but couldn't save it to the calendar just now.`;
  }
}

// ── Doorbell snapshot description (vision) ─────────────────────────────────────

/** One short, factual line describing who/what is at the door in a JPEG snapshot. */
export async function describeDoorbellImage(jpeg: Buffer): Promise<string> {
  try {
    const b64 = jpeg.toString('base64');
    const resp = await createMessage({
      model: config.anthropic.model,
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: "This is a snapshot from a front-door camera. In ONE short, factual sentence, say who or what is at the door — e.g. 'A delivery driver holding a parcel', 'A woman with a pushchair', 'Two children'. If no person is visible, say so briefly (e.g. 'No one at the door — just the driveway'). No preamble, no quotes." },
        ],
      }],
    });
    return resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text?.trim() || '';
  } catch (err) {
    console.error('describeDoorbellImage failed:', err);
    return '';
  }
}

// ── Local events ticker (for the TV dashboard) ────────────────────────────────
// Refreshed periodically by the scheduler (not per dashboard render) so we don't
// hammer the search API. Held in memory; empty until the first refresh.

interface TickerItem { text: string; date: string } // date = YYYY-MM-DD
let tickerItems: TickerItem[] = [];

/** Returns upcoming ticker lines (future-dated, soonest first). */
export function getLocalEventsTicker(): string[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
  return tickerItems
    .filter((i) => i.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((i) => i.text);
}

/** Curated, dated local events whose date falls in [fromISO, toISO] (inclusive). */
export function getUpcomingLocalEvents(fromISO: string, toISO: string): string[] {
  return tickerItems
    .filter((i) => i.date >= fromISO && i.date <= toISO)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((i) => i.text);
}

/** YYYY-MM-DD from a getLocalNow()-style date (components are already local). */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parse "Sun 24 Aug — …" into a YYYY-MM-DD date (assuming the near future). */
function parseTickerDate(text: string, now: Date): string | null {
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!m) return null;
  const day = parseInt(m[1]!, 10);
  const monIdx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(m[2]!.slice(0, 3).toLowerCase());
  if (monIdx < 0 || day < 1 || day > 31) return null;
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  let d = Date.UTC(now.getFullYear(), monIdx, day);
  // If it lands well in the past, it's next year's date (year-boundary safety).
  if (d < todayUTC - 30 * 86400000) d = Date.UTC(now.getFullYear() + 1, monIdx, day);
  return new Date(d).toISOString().slice(0, 10);
}

export async function refreshLocalEventsTicker(): Promise<void> {
  try {
    const { braveSearch, formatSearchResults, fetchPageText } = await import('./search');
    const now = getLocalNow(config.timezone);
    const monthStr = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: config.timezone });
    const todayLabel = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone });
    // 22-day date reference so weekday↔date pairings are always correct.
    const refBase = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const dateReference = Array.from({ length: 22 }, (_, i) => {
      const d = new Date(refBase);
      d.setDate(refBase.getDate() + i);
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone });
    }).join(', ');

    // Queries aimed at dated, one-off happenings (fetes, fun days, festivals,
    // markets, workshops) — not permanent attractions. Nearby towns included.
    const queries = [
      `family fun day OR fete OR festival OR fair ${config.location} OR Winchcombe OR Tewkesbury OR Gloucester ${monthStr}`,
      `things to do this weekend ${config.location} with kids`,
      `Gloucestershire family events ${monthStr} what's on this week`,
      `children's events workshops ${config.location} ${monthStr} tickets`,
      `eventbrite family kids ${config.location} Gloucestershire`,
    ];
    const searches = await Promise.all(queries.map((q) => braveSearch(q, 6, { freshness: 'pm' }).catch(() => [])));
    const seen = new Set<string>();
    const results = searches.flat().filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
    if (results.length === 0) return;

    // Read a few promising event-listing pages so we get REAL dates, not just snippets.
    const listingHints = ['event', 'whats-on', 'what-s-on', 'ticket', 'festival', 'funday', 'fun-day', 'fete', 'dayoutwiththekids', 'eventbrite', 'visit'];
    const toFetch = results
      .filter((r) => listingHints.some((h) => r.url.toLowerCase().includes(h)))
      .slice(0, 4);
    const pages = await Promise.all(
      toFetch.map(async (r) => {
        const text = await fetchPageText(r.url, 3500);
        return text ? `PAGE: ${r.url}\n${text}` : '';
      }),
    );
    const pageContext = pages.filter(Boolean).join('\n\n');

    const prompt = `Today is ${todayLabel}. You're compiling a "What's on for families" ticker for a family with young kids (7, 5 and a newborn) in and around ${config.location}, Gloucestershire.

Produce a list of SPECIFIC, DATED, one-off events happening in the NEXT 3 WEEKS — things like family fun days, fetes, festivals, fairs, markets, seasonal trails, children's workshops, shows, and community events. The whole point is timeliness: "Sun 24 Aug — Family Fun Day, Winchcombe", not permanent attractions.

STRICT RULES:
- ONLY include an event if a specific date (or clear "this weekend"/named day) appears in the sources below. If there's no date, LEAVE IT OUT.
- Do NOT list permanent attractions, venues, museums, farm parks, soft play, lidos or "places to visit" — those are not events.
- NEVER invent an event, date, or venue. Better to return few items than to make things up.
- Prefer events within the next 3 weeks; ignore past dates (today is ${todayLabel}).

Format each on its own line as: "Day D Mon — Event name, Town/Venue" (e.g. "Sun 24 Aug — Teddy Bears' Picnic, Pittville Park"). Up to 12 items. Output ONLY the lines — no intro, no numbering, no commentary.

DATE REFERENCE — these are the only valid dates (correct weekday↔date pairings). Use the weekday exactly as shown here for each date, and ignore any event whose date is NOT in this list (it's either past or too far off):
${dateReference}

SEARCH RESULTS:
${formatSearchResults(results)}

${pageContext ? `EVENT PAGE CONTENT:\n${pageContext}` : ''}`;

    const response = await createMessage({
      model: config.anthropic.model,
      max_tokens: 700,
      system: 'You extract real, specifically-dated local events from web sources for a family listings ticker. You never invent events or dates, and you exclude permanent attractions. Output only the event lines.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text || '';
    const freshLines = text
      .split('\n')
      .map((l) => l.replace(/^[-•*\d.\s]+/, '').trim())
      .filter((l) => l.length > 4 && l.includes('—'))
      .slice(0, 12);

    // Merge with what we already have so a thin search doesn't empty the ticker.
    // Dedupe by normalised text; drop past-dated items; keep the soonest ~20.
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const merged = new Map<string, TickerItem>();
    for (const item of tickerItems) merged.set(norm(item.text), item);
    for (const line of freshLines) {
      const date = parseTickerDate(line, now);
      if (date) merged.set(norm(line), { text: line, date });
    }
    tickerItems = [...merged.values()]
      .filter((i) => i.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 20);
    console.log(`Local events ticker: +${freshLines.length} found, ${tickerItems.length} upcoming after merge.`);
  } catch (err) {
    console.error('refreshLocalEventsTicker failed:', err);
  }
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
