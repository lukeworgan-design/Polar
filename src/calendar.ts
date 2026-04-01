import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config';

let authClient: OAuth2Client | InstanceType<typeof google.auth.GoogleAuth> | null = null;
let calendarId: string | null = null;

async function getAuthClient(): Promise<OAuth2Client | InstanceType<typeof google.auth.GoogleAuth>> {
  if (authClient) return authClient;

  // Prefer service account — never expires, no token refresh needed
  if (config.google.serviceAccountJson) {
    const credentials = JSON.parse(config.google.serviceAccountJson);
    authClient = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    return authClient;
  }

  // Fall back to OAuth2 (legacy)
  const credentials = JSON.parse(config.google.credentialsJson);
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (config.google.tokenJson) {
    client.setCredentials(JSON.parse(config.google.tokenJson));
  } else {
    throw new Error('Neither GOOGLE_SERVICE_ACCOUNT_JSON nor GOOGLE_TOKEN_JSON is set.');
  }
  authClient = client;
  return authClient;
}

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  const auth = await getAuthClient();
  return google.calendar({ version: 'v3', auth: auth as any });
}

async function getFamilyCalendarId(): Promise<string> {
  if (calendarId) return calendarId;

  const cal = await getCalendarClient();
  const res = await cal.calendarList.list();
  const calendars = res.data.items || [];

  const family = calendars.find(
    (c) => c.summary?.toLowerCase() === config.google.calendarName.toLowerCase()
  );

  if (!family || !family.id) {
    // Fall back to primary if no "Family" calendar found
    console.warn(`No "${config.google.calendarName}" calendar found; using primary`);
    calendarId = 'primary';
  } else {
    calendarId = family.id;
  }

  return calendarId;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  recurrence?: string[];
  location?: string;
}

function formatEventDate(dateTime?: string | null, date?: string | null): string {
  if (dateTime) {
    return new Date(dateTime).toISOString();
  }
  if (date) {
    return date;
  }
  return '';
}

function isAllDay(event: calendar_v3.Schema$Event): boolean {
  return !!(event.start?.date && !event.start?.dateTime);
}

function eventToCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: event.id || '',
    summary: event.summary || 'Untitled event',
    start: formatEventDate(event.start?.dateTime, event.start?.date),
    end: formatEventDate(event.end?.dateTime, event.end?.date),
    description: event.description || undefined,
    recurrence: event.recurrence || undefined,
    location: event.location || undefined,
  };
}

export async function getEventsForPeriod(startDate: Date, endDate: Date): Promise<CalendarEvent[]> {
  const cal = await getCalendarClient();
  const cid = await getFamilyCalendarId();

  const res = await cal.events.list({
    calendarId: cid,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  return (res.data.items || []).map(eventToCalendarEvent);
}

export async function getTodaysEvents(): Promise<CalendarEvent[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return getEventsForPeriod(startOfDay, endOfDay);
}

export async function getWeeksEvents(weeksAhead: number = 0): Promise<CalendarEvent[]> {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1 + weeksAhead * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return getEventsForPeriod(monday, sunday);
}

export async function getUpcomingEvents(days: number = 3): Promise<CalendarEvent[]> {
  const now = new Date();
  const future = new Date();
  future.setDate(now.getDate() + days);
  return getEventsForPeriod(now, future);
}

export async function createEvent(params: {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  recurrence?: string[];
  allDay?: boolean;
}): Promise<CalendarEvent> {
  const cal = await getCalendarClient();
  const cid = await getFamilyCalendarId();

  const eventBody: calendar_v3.Schema$Event = {
    summary: params.summary,
    description: params.description,
    location: params.location,
    recurrence: params.recurrence,
  };

  if (params.allDay) {
    const fmt = (d: Date) => d.toISOString().split('T')[0]!;
    eventBody.start = { date: fmt(params.start) };
    eventBody.end = { date: fmt(params.end) };
  } else {
    eventBody.start = { dateTime: params.start.toISOString(), timeZone: config.timezone };
    eventBody.end = { dateTime: params.end.toISOString(), timeZone: config.timezone };
  }

  const res = await cal.events.insert({ calendarId: cid, requestBody: eventBody });
  return eventToCalendarEvent(res.data);
}

export async function updateEvent(
  eventId: string,
  updates: Partial<{
    summary: string;
    start: Date;
    end: Date;
    description: string;
    location: string;
    recurrence: string[];
    allDay: boolean;
  }>
): Promise<CalendarEvent> {
  const cal = await getCalendarClient();
  const cid = await getFamilyCalendarId();

  // Fetch existing event first
  const existing = await cal.events.get({ calendarId: cid, eventId });
  const eventBody: calendar_v3.Schema$Event = { ...existing.data };

  if (updates.summary) eventBody.summary = updates.summary;
  if (updates.description) eventBody.description = updates.description;
  if (updates.location) eventBody.location = updates.location;
  if (updates.recurrence) eventBody.recurrence = updates.recurrence;

  if (updates.start && updates.end) {
    if (updates.allDay) {
      const fmt = (d: Date) => d.toISOString().split('T')[0]!;
      eventBody.start = { date: fmt(updates.start) };
      eventBody.end = { date: fmt(updates.end) };
    } else {
      eventBody.start = { dateTime: updates.start.toISOString(), timeZone: config.timezone };
      eventBody.end = { dateTime: updates.end.toISOString(), timeZone: config.timezone };
    }
  }

  const res = await cal.events.update({ calendarId: cid, eventId, requestBody: eventBody });
  return eventToCalendarEvent(res.data);
}

export async function deleteEvent(eventId: string): Promise<void> {
  const cal = await getCalendarClient();
  const cid = await getFamilyCalendarId();
  await cal.events.delete({ calendarId: cid, eventId });
}

export async function findEventsByKeyword(keyword: string, daysAhead: number = 365): Promise<CalendarEvent[]> {
  const now = new Date();
  const future = new Date();
  future.setDate(now.getDate() + daysAhead);

  const events = await getEventsForPeriod(now, future);
  const lower = keyword.toLowerCase();
  return events.filter((e) => e.summary.toLowerCase().includes(lower));
}

export async function checkConflicts(start: Date, end: Date, excludeEventId?: string): Promise<CalendarEvent[]> {
  // Check a window around the proposed event
  const windowStart = new Date(start);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(end);
  windowEnd.setHours(23, 59, 59, 999);

  const events = await getEventsForPeriod(windowStart, windowEnd);

  return events.filter((e) => {
    if (excludeEventId && e.id === excludeEventId) return false;
    const eStart = new Date(e.start);
    const eEnd = new Date(e.end);
    // Overlap check: event starts before our end AND ends after our start
    return eStart < end && eEnd > start;
  });
}

export function formatEventsForAI(events: CalendarEvent[]): string {
  if (events.length === 0) return 'No events found.';

  return events
    .map((e) => {
      const start = new Date(e.start);
      const end = new Date(e.end);
      const isAllDayEvent = e.start.length === 10; // YYYY-MM-DD format

      let timeStr: string;
      if (isAllDayEvent) {
        timeStr = start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone });
      } else {
        timeStr = `${start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone })} at ${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone })}–${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone })}`;
      }

      let str = `- ${e.summary} (${timeStr})`;
      if (e.location) str += ` [${e.location}]`;
      if (e.recurrence) str += ' [recurring]';
      return str;
    })
    .join('\n');
}
