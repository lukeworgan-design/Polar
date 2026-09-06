import cron from 'node-cron';
import { config } from './config';
import { getFridayBinType } from './bin';
export { getFridayBinType } from './bin';
import {
  getUpcomingEvents,
  getEventsForPeriod,
  CalendarEvent,
} from './calendar';
import {
  generateDailySummary,
  generateWeeklySummary,
  generateEventReminder,
  generateBirthdayReminder,
  generateWeekendCheckin,
  generateFridayCheckin,
  generateHolidayActivities,
  generateWeekendEvents,
  generatePregnancyUpdate,
  generateBabyChecklistReminder,
  getDueImmunisationReminder,
  refreshLocalEventsTicker,
} from './ai';
import {
  getPendingReminders,
  markReminderFired,
  getUpcomingBirthdays,
  hasBirthdayReminderFired,
  markBirthdayReminderFired,
  hasNotificationFired,
  markNotificationFired,
} from './db';

type SendMessageFn = (text: string) => Promise<void>;

let sendToGroup: SendMessageFn;

export function initScheduler(sendFn: SendMessageFn): void {
  sendToGroup = sendFn;

  // Daily morning summary — 6:00am every day
  cron.schedule('0 6 * * *', async () => {
    try {
      const summary = await generateDailySummary();
      await sendToGroup(summary);
    } catch (err) {
      console.error('Error sending daily summary:', err);
    }
  }, { timezone: config.timezone });

  // Weekly summary — Sunday at 7pm
  cron.schedule('0 19 * * 0', async () => {
    try {
      const summary = await generateWeeklySummary();
      await sendToGroup(summary);
    } catch (err) {
      console.error('Error sending weekly summary:', err);
    }
  }, { timezone: config.timezone });

  // Event reminders — check every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      await checkEventReminders();
    } catch (err) {
      console.error('Error checking event reminders:', err);
    }
  }, { timezone: config.timezone });

  // Personal reminders — check every minute
  cron.schedule('* * * * *', async () => {
    try {
      await checkPersonalReminders();
    } catch (err) {
      console.error('Error checking personal reminders:', err);
    }
  }, { timezone: config.timezone });

  // Friday 3pm check-in — school's out, what's on locally this afternoon/weekend
  cron.schedule('0 15 * * 5', async () => {
    try {
      const message = await generateFridayCheckin();
      await sendToGroup(message);
    } catch (err) {
      console.error('Error sending Friday check-in:', err);
    }
  }, { timezone: config.timezone });

  // Weekend check-ins — Saturday 9am and Sunday 4pm
  cron.schedule('0 9 * * 6', async () => {
    try {
      const message = await generateWeekendCheckin('saturday');
      await sendToGroup(message);
    } catch (err) {
      console.error('Error sending Saturday check-in:', err);
    }
  }, { timezone: config.timezone });

  cron.schedule('0 16 * * 0', async () => {
    try {
      const message = await generateWeekendCheckin('sunday');
      await sendToGroup(message);
    } catch (err) {
      console.error('Error sending Sunday check-in:', err);
    }
  }, { timezone: config.timezone });

  // Birthday reminders — check daily at 9am
  cron.schedule('0 9 * * *', async () => {
    try {
      await checkBirthdayReminders();
    } catch (err) {
      console.error('Error checking birthday reminders:', err);
    }
  }, { timezone: config.timezone });

  // Upcoming school holiday activities — check daily at 9am
  cron.schedule('0 9 * * *', async () => {
    try {
      await checkUpcomingHolidayActivities();
    } catch (err) {
      console.error('Error checking upcoming holiday activities:', err);
    }
  }, { timezone: config.timezone });

  // Weekend events round-up — every Wednesday at 6pm
  cron.schedule('0 18 * * 3', async () => {
    try {
      const message = await generateWeekendEvents();
      if (message) await sendToGroup(message);
    } catch (err) {
      console.error('Error sending weekend events:', err);
    }
  }, { timezone: config.timezone });

  // Bin day reminder — every Thursday at 7pm (collection is Friday morning)
  cron.schedule('0 19 * * 4', async () => {
    try {
      await sendBinReminder();
    } catch (err) {
      console.error('Error sending bin reminder:', err);
    }
  }, { timezone: config.timezone });

  // Pocket-money payout — every Friday at 4pm (payday). Telegram message + an
  // Echo shout-out of what each kid earned.
  cron.schedule('0 16 * * 5', async () => {
    try {
      const { payoutMessage, paydaySpeech } = await import('./pocketmoney');
      const msg = await payoutMessage();
      if (msg) await sendToGroup(msg);
      await announceJobsVoice(await paydaySpeech());
    } catch (err) {
      console.error('Error sending pocket-money payout:', err);
    }
  }, { timezone: config.timezone });

  // Morning "jobs of the day" on the Echos — 7:30am daily.
  cron.schedule('30 7 * * *', async () => {
    try {
      const { morningJobsSpeech } = await import('./pocketmoney');
      await announceJobsVoice(await morningJobsSpeech());
    } catch (err) {
      console.error('Error announcing morning jobs:', err);
    }
  }, { timezone: config.timezone });

  // Teatime "what's left" nudge on the Echos — 5:00pm daily.
  cron.schedule('0 17 * * *', async () => {
    try {
      const { teatimeNudgeSpeech } = await import('./pocketmoney');
      await announceJobsVoice(await teatimeNudgeSpeech());
    } catch (err) {
      console.error('Error announcing teatime jobs nudge:', err);
    }
  }, { timezone: config.timezone });

  // Weekly pregnancy update — every Monday at 8am
  cron.schedule('0 8 * * 1', async () => {
    try {
      const message = await generatePregnancyUpdate();
      if (message) await sendToGroup(message);
    } catch (err) {
      console.error('Error sending pregnancy update:', err);
    }
  }, { timezone: config.timezone });

  // Baby checklist reminder — every other day at 10am
  cron.schedule('0 10 */2 * *', async () => {
    try {
      const message = await generateBabyChecklistReminder();
      if (message) await sendToGroup(message);
    } catch (err) {
      console.error('Error sending baby checklist reminder:', err);
    }
  }, { timezone: config.timezone });

  // Immunisation reminder — check daily at 9am, nudge ~a week before each jab
  cron.schedule('0 9 * * *', async () => {
    try {
      const due = getDueImmunisationReminder();
      if (due && !(await hasNotificationFired(due.key))) {
        await markNotificationFired(due.key);
        await sendToGroup(due.message);
      }
    } catch (err) {
      console.error('Error sending immunisation reminder:', err);
    }
  }, { timezone: config.timezone });

  // Local events ticker for the TV dashboard — refresh every 6 hours, and once now.
  cron.schedule('0 */6 * * *', () => {
    refreshLocalEventsTicker().catch((err) => console.error('Ticker refresh error:', err));
  }, { timezone: config.timezone });
  refreshLocalEventsTicker().catch((err) => console.error('Initial ticker refresh error:', err));

  console.log('Scheduler initialised ✓');
}

/** Speak a jobs announcement on all Echos, honouring quiet hours. No-ops when
 *  there's nothing to say or voice isn't set up. */
async function announceJobsVoice(text: string | null): Promise<void> {
  if (!text) return;
  const { isVoiceEnabled, speakOnAlexa } = await import('./voice');
  if (!isVoiceEnabled()) return;
  const r = await speakOnAlexa(text, { respectQuietHours: true });
  if (!r.ok && r.reason && !/quiet hours/.test(r.reason)) {
    console.error('Jobs announcement failed:', r.reason);
  }
}

async function checkEventReminders(): Promise<void> {
  const now = new Date();

  // Fetch events in the next 7 days to check for upcoming reminders
  const lookahead = new Date();
  lookahead.setDate(now.getDate() + 7);
  const events = await getEventsForPeriod(now, lookahead);

  for (const event of events) {
    const eventStart = new Date(event.start);
    const hoursUntil = (eventStart.getTime() - now.getTime()) / (1000 * 60 * 60);

    // Reminder windows: 1 week (168h), 1 day (24h), 2 hours
    const reminderWindows = [
      { hours: 168, label: '1-week', tolerance: 0.5 },
      { hours: 24, label: '1-day', tolerance: 0.25 },
      { hours: 2, label: '2-hour', tolerance: 0.2 },
    ];

    for (const window of reminderWindows) {
      const diff = Math.abs(hoursUntil - window.hours);
      if (diff > window.tolerance) continue;

      // Persisted dedupe so reminders survive redeploys/restarts.
      const key = `event:${event.id}:${window.label}`;
      if (await hasNotificationFired(key)) continue;
      await markNotificationFired(key);

      const message = await generateEventReminder(event, Math.round(hoursUntil));
      await sendToGroup(message);
    }
  }
}

async function checkPersonalReminders(): Promise<void> {
  const pending = await getPendingReminders();

  for (const reminder of pending) {
    await markReminderFired(reminder.id);

    const userName = reminder.user_name;
    const message = `Hey ${userName}! 👋 ${reminder.message}`;
    await sendToGroup(message);
  }
}

const HOLIDAY_KEYWORDS = ['school holiday', 'half term', 'easter holiday', 'christmas holiday', 'summer holiday', 'inset day'];

async function checkUpcomingHolidayActivities(): Promise<void> {
  const now = new Date();

  // Look for school holiday events starting 3–5 days from now
  const windowStart = new Date(now);
  windowStart.setDate(now.getDate() + 3);
  const windowEnd = new Date(now);
  windowEnd.setDate(now.getDate() + 5);

  const events = await getEventsForPeriod(windowStart, windowEnd);

  for (const event of events) {
    const name = event.summary.toLowerCase();
    if (!HOLIDAY_KEYWORDS.some(k => name.includes(k))) continue;

    // Persisted dedupe so the nudge isn't re-sent after a redeploy.
    const key = `holiday:${event.id}`;
    if (await hasNotificationFired(key)) continue;
    await markNotificationFired(key);

    // Parse dates — all-day events come back as YYYY-MM-DD strings
    const startDate = event.start.includes('T')
      ? new Date(event.start)
      : new Date(event.start + 'T12:00:00');
    const endDate = event.end.includes('T')
      ? new Date(event.end)
      : new Date(event.end + 'T12:00:00');

    const message = await generateHolidayActivities(event.summary, startDate, endDate);
    if (message) await sendToGroup(message);
  }
}

async function sendBinReminder(): Promise<void> {
  const binType = getFridayBinType();
  if (binType === 'general') {
    await sendToGroup('🗑️ Bin reminder: green bin (general waste) goes out tomorrow morning. Don\'t forget to put it out tonight!');
  } else {
    await sendToGroup('♻️ Bin reminder: blue bin (recycling) goes out tomorrow morning. Don\'t forget to put it out tonight!');
  }
}

async function checkBirthdayReminders(): Promise<void> {
  const upcoming = await getUpcomingBirthdays(14);
  const currentYear = new Date().getFullYear();

  for (const birthday of upcoming) {
    // Send reminder at 14 days and 2 days before
    if (birthday.days_until === 14 || birthday.days_until === 2 || birthday.days_until === 0) {
      const alreadyFired = await hasBirthdayReminderFired(birthday.id, parseInt(`${currentYear}${birthday.days_until}`));

      if (!alreadyFired) {
        await markBirthdayReminderFired(birthday.id, parseInt(`${currentYear}${birthday.days_until}`));
        const message = await generateBirthdayReminder(birthday.name, birthday.relation, birthday.days_until);
        await sendToGroup(message);
      }
    }
  }
}
