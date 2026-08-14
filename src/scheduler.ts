import cron from 'node-cron';
import { config } from './config';
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

  console.log('Scheduler initialised ✓');
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

/** Returns which bin type is due on the next Friday from now. */
export function getFridayBinType(): 'general' | 'recycling' {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun … 4=Thu … 5=Fri
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
  const nextFriday = new Date(now);
  nextFriday.setHours(12, 0, 0, 0);
  nextFriday.setDate(now.getDate() + daysUntilFriday);

  const refDate = new Date(config.bin.referenceDate + 'T12:00:00');
  const diffDays = Math.round((nextFriday.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.round(diffDays / 7);

  const sameAsRef = diffWeeks % 2 === 0;
  if (sameAsRef) return config.bin.referenceType;
  return config.bin.referenceType === 'general' ? 'recycling' : 'general';
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
