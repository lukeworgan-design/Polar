import { config } from './config';
import { getTodaysEvents, getUpcomingEvents, CalendarEvent } from './calendar';
import { getMealPlan, getShoppingList, addShoppingItem, removeShoppingItem, clearShoppingList, addTodo, addBabyLog } from './db';
import { getFridayBinType, binLabel, nextFridayDate } from './bin';
import { createCalendarEventStructured } from './ai';

// ── Alexa request/response helpers ──────────────────────────────────────────────

interface AlexaResponse {
  version: '1.0';
  response: {
    outputSpeech: { type: 'PlainText'; text: string };
    reprompt?: { outputSpeech: { type: 'PlainText'; text: string } };
    shouldEndSession: boolean;
  };
}

function speak(text: string, endSession = true, reprompt?: string): AlexaResponse {
  const resp: AlexaResponse = {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: endSession,
    },
  };
  if (reprompt) resp.response.reprompt = { outputSpeech: { type: 'PlainText', text: reprompt } };
  return resp;
}

function tz(): string { return config.timezone; }

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz() })
    .replace(':00', '').replace(' ', '');
}

function speakEvent(e: CalendarEvent): string {
  const allDay = e.start.length === 10;
  return allDay ? e.summary : `${e.summary} at ${fmtTime(e.start)}`;
}

/**
 * Spoken weekday + date for an event. For all-day events (date-only strings)
 * the weekday is a pure calendar fact — computed in UTC so it can never slip a
 * day. For timed events we use the family timezone on the actual instant.
 */
function spokenDay(iso: string): string {
  if (iso.length === 10) {
    const [y, mo, da] = iso.split('-').map(Number);
    return new Date(Date.UTC(y!, mo! - 1, da!)).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    });
  }
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: tz(),
  });
}

function joinNaturally(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function babyName(): string { return config.family.babyName || 'the baby'; }

function babyAgeSpoken(): string | null {
  const dob = config.family.babyBorn;
  if (!dob) return null;
  const days = Math.max(0, Math.floor((Date.now() - new Date(`${dob}T12:00:00`).getTime()) / 86400000));
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  return rem === 0 ? `${weeks} weeks old` : `${weeks} weeks and ${rem} day${rem === 1 ? '' : 's'} old`;
}

function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date());
}

// ── Intent handlers ─────────────────────────────────────────────────────────────

async function handleDinner(): Promise<string> {
  const meals = await getMealPlan(todayStr(), todayStr());
  const dinner = meals.find((m) => m.meal_type === 'dinner');
  return dinner
    ? `Tonight's dinner is ${dinner.meal}.`
    : `There's nothing planned for dinner tonight yet.`;
}

async function handleToday(): Promise<string> {
  const events = await getTodaysEvents();
  if (events.length === 0) return `You've got nothing in the diary today.`;
  const list = joinNaturally(events.map(speakEvent));
  return `Today you've got ${list}.`;
}

async function handleUpcoming(): Promise<string> {
  const events = await getUpcomingEvents(7);
  const today = todayStr();
  const upcoming = events
    .filter((e) => (e.start.length === 10 ? e.start : e.start.slice(0, 10)) > today)
    .slice(0, 5);
  if (upcoming.length === 0) return `Nothing coming up in the next week.`;
  const list = joinNaturally(upcoming.map((e) => `${speakEvent(e)} on ${spokenDay(e.start)}`));
  return `Coming up: ${list}.`;
}

function handleBin(): string {
  const type = getFridayBinType();
  const { label } = binLabel(type);
  const day = nextFridayDate().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz() });
  return `The next bin is the ${label}, out on ${day}. Put it out the night before.`;
}

function handleBabyAge(): string {
  const age = babyAgeSpoken();
  return age ? `${babyName()} is ${age}.` : `I don't have a birth date on record.`;
}

function splitItems(s: string): string[] {
  return s.split(/,| and /i).map((x) => x.trim()).filter(Boolean);
}

async function handleAddShopping(item: string | undefined): Promise<string> {
  if (!item) return `What would you like me to add to the groceries?`;
  const items = splitItems(item);
  for (const it of items) await addShoppingItem(it, 'Alexa');
  return items.length === 1
    ? `Added ${items[0]} to the groceries.`
    : `Added ${joinNaturally(items)} to the groceries.`;
}

async function handleRemoveShopping(item: string | undefined): Promise<string> {
  if (!item) return `What would you like me to take off the groceries?`;
  const removed = await removeShoppingItem(item);
  return removed
    ? `Removed ${item} from the groceries.`
    : `I couldn't find ${item} in the groceries.`;
}

async function handleClearShopping(): Promise<string> {
  const count = await clearShoppingList();
  return count > 0 ? `Cleared ${count} item${count === 1 ? '' : 's'} from the groceries.` : `The groceries were already empty.`;
}

async function handleShoppingList(): Promise<string> {
  const list = await getShoppingList();
  if (list.length === 0) return `You don't need anything — the groceries are empty.`;
  return `You need ${list.length} thing${list.length === 1 ? '' : 's'}: ${joinNaturally(list.map((i) => i.item))}.`;
}

async function handleAddTodo(task: string | undefined): Promise<string> {
  if (!task) return `What job should I add?`;
  await addTodo(task, 'Alexa');
  return `Added ${task} to the jobs.`;
}

async function handleLogFeed(amount: string | undefined): Promise<string> {
  await addBabyLog('feed', null, amount ?? null, 'Alexa');
  return `Logged a feed for ${babyName()}${amount ? `, ${amount}` : ''}.`;
}

async function handleAddEvent(title: string | undefined, date: string | undefined, time: string | undefined): Promise<string> {
  if (!title || !date) return `Sorry, I didn't catch the event. Try: add an event to the calendar.`;
  return createCalendarEventStructured(title, date, time);
}

/** Alexa Dialog.Delegate response — lets Alexa collect the remaining slots. */
function delegate(): AlexaResponse & { response: { directives: unknown[] } } {
  return {
    version: '1.0',
    response: { directives: [{ type: 'Dialog.Delegate' }], shouldEndSession: false } as any,
  } as any;
}

// ── Main entry ──────────────────────────────────────────────────────────────────

const HELP = `You can ask me what's for dinner, what's on today, what's coming up, or when the bins go out. For shopping, say: add milk and bread to the groceries, remove milk, or what do we need. And to add to the calendar, say: add an event to the calendar.`;

function slotValue(intent: any, name: string): string | undefined {
  const v = intent?.slots?.[name]?.value;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export async function handleAlexaRequest(event: any): Promise<AlexaResponse> {
  // Verify the request is from our own skill.
  const appId = event?.context?.System?.application?.applicationId
    ?? event?.session?.application?.applicationId;
  if (config.alexaSkillId && appId !== config.alexaSkillId) {
    console.warn('Alexa: rejected request with app id', appId);
    return speak('Sorry, this request could not be verified.');
  }

  const type = event?.request?.type;

  if (type === 'LaunchRequest') {
    return speak(`Hi, I'm Rose. ${HELP}`, false, `Try: what's for dinner?`);
  }

  if (type === 'SessionEndedRequest') {
    return speak('Bye!', true);
  }

  if (type === 'IntentRequest') {
    const intent = event.request.intent;
    const name: string = intent?.name ?? '';

    // If a dialog is mid-way (slots still to fill), let Alexa keep collecting.
    const dialogState = event.request.dialogState;
    if (dialogState && dialogState !== 'COMPLETED') {
      return delegate() as AlexaResponse;
    }

    try {
      switch (name) {
        case 'DinnerIntent': return speak(await handleDinner());
        case 'TodayIntent': return speak(await handleToday());
        case 'UpcomingIntent': return speak(await handleUpcoming());
        case 'BinIntent': return speak(handleBin());
        case 'BabyAgeIntent': return speak(handleBabyAge());
        case 'AddShoppingIntent': return speak(await handleAddShopping(slotValue(intent, 'Item')));
        case 'RemoveShoppingIntent': return speak(await handleRemoveShopping(slotValue(intent, 'Item')));
        case 'ClearShoppingIntent': return speak(await handleClearShopping());
        case 'ShoppingListIntent': return speak(await handleShoppingList());
        case 'AddTodoIntent': return speak(await handleAddTodo(slotValue(intent, 'Task')));
        case 'AddEventIntent': return speak(await handleAddEvent(
          slotValue(intent, 'Title'), slotValue(intent, 'EventDate'), slotValue(intent, 'EventTime'),
        ));
        case 'LogFeedIntent': return speak(await handleLogFeed(slotValue(intent, 'Amount')));
        case 'AMAZON.HelpIntent': return speak(HELP, false, `Try: what's for dinner?`);
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent': return speak('Okay, bye!');
        case 'AMAZON.FallbackIntent':
        default:
          return speak(`Sorry, I didn't catch that. ${HELP}`, false, `Try: what's on today?`);
      }
    } catch (err) {
      console.error(`Alexa intent "${name}" failed:`, err);
      return speak(`Sorry, I couldn't get that just now. Please try again in a moment.`);
    }
  }

  return speak(`Sorry, I didn't understand that.`);
}
