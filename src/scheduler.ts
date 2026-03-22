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
} from './ai';
import {
  getPendingReminders,
  markReminderFired,
  getUpcomingBirthdays,
  hasBirthdayReminderFired,
  markBirthdayReminderFired,
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

  // Birthday reminders — check daily at 9am
  cron.schedule('0 9 * * *', async () => {
    try {
      await checkBirthdayReminders();
    } catch (err) {
      console.error('Error checking birthday reminders:', err);
    }
  }, { timezone: config.timezone });

  console.log('Scheduler initialised ✓');
}

// Track which event reminders we've already sent this run (persists in memory)
const sentEventReminders = new Set<string>();

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
      const key = `${event.id}-${window.label}`;
      if (sentEventReminders.has(key)) continue;

      const diff = Math.abs(hoursUntil - window.hours);
      if (diff <= window.tolerance) {
        sentEventReminders.add(key);
        const message = await generateEventReminder(event, Math.round(hoursUntil));
        await sendToGroup(message);
      }
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
