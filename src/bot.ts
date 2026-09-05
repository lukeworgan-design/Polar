import { createServer } from 'http';
import { Telegraf, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { config, getUserName } from './config';
import { generateResponse, ImageData, loadBabyArrival } from './ai';
import { initScheduler } from './scheduler';
import { transcribeAudio } from './transcribe';
import { getDashboardData, renderDashboardPage, parseOptions, localBgFiles } from './dashboard';
import { initRing, getDoorbellStatus, getDoorbellSnapshot, getMotionSnapshot, triggerTestDing } from './ring';
import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { extname } from 'path';

const bot = new Telegraf(config.telegram.botToken);
const GROUP_ID = parseInt(config.telegram.groupId, 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFromGroup(ctx: Context): boolean {
  return ctx.chat?.id === GROUP_ID;
}

function getMentionPatterns(botUsername: string): RegExp[] {
  return [
    new RegExp(`@${botUsername}`, 'i'),
    /\brose([,!?\s]|$)/i,
    /\bhey rose\b/i,
  ];
}

function isDirectlyMentioned(text: string, botUsername: string): boolean {
  const patterns = getMentionPatterns(botUsername);
  return patterns.some((p) => p.test(text));
}

function cleanMessageForBot(text: string, botUsername: string): string {
  return text
    .replace(new RegExp(`@${botUsername}`, 'gi'), '')
    .replace(/^rose[,!?\s]*/i, '')
    .replace(/\bhey rose[,!?\s]*/i, '')
    .trim();
}

async function sendToGroup(text: string): Promise<void> {
  try {
    await bot.telegram.sendMessage(GROUP_ID, text, { parse_mode: 'Markdown' });
  } catch {
    // Fallback without markdown if it fails
    try {
      await bot.telegram.sendMessage(GROUP_ID, text);
    } catch (err2) {
      console.error('Failed to send message to group:', err2);
    }
  }
}

// ── Rate limiting (simple in-memory) ─────────────────────────────────────────

const lastResponseTime = new Map<number, number>();
const RATE_LIMIT_MS = 2000; // 2 seconds between responses per user

function isRateLimited(userId: number): boolean {
  const last = lastResponseTime.get(userId) || 0;
  return Date.now() - last < RATE_LIMIT_MS;
}

function updateRateLimit(userId: number): void {
  lastResponseTime.set(userId, Date.now());
}

// ── Message handling ──────────────────────────────────────────────────────────

async function handleGroupMessage(ctx: Context): Promise<void> {
  const message = ctx.message as Message.TextMessage | undefined;
  if (!message || !('text' in message)) return;

  const text = message.text;
  const userId = message.from?.id;
  if (!userId) return;

  // Rate limiting
  if (isRateLimited(userId)) return;

  const botInfo = await bot.telegram.getMe();
  const botUsername = botInfo.username || 'Rose';

  const mentioned = isDirectlyMentioned(text, botUsername);
  const userName = getUserName(userId);

  updateRateLimit(userId);

  // Clean the message text
  const cleanedText = mentioned ? cleanMessageForBot(text, botUsername) : text;
  if (!cleanedText) {
    await ctx.reply("I'm here! What can I help with? 😊");
    return;
  }

  // Show typing indicator
  try {
    await ctx.sendChatAction('typing');
  } catch {
    // Ignore typing indicator errors
  }

  try {
    const response = await generateResponse(cleanedText, userName, userId);
    await ctx.reply(response, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error generating response:', err);
    await ctx.reply("Sorry, I hit a snag just then. Give me a moment and try again?");
  }
}

async function handlePhotoMessage(ctx: Context): Promise<void> {
  const message = ctx.message as Message.PhotoMessage | undefined;
  if (!message || !('photo' in message)) return;

  const userId = message.from?.id;
  if (!userId) return;

  if (isRateLimited(userId)) return;
  updateRateLimit(userId);

  const userName = getUserName(userId);
  const caption = message.caption?.trim() || '';

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }

  try {
    // Get the highest resolution version of the photo
    const photos = message.photo;
    const largest = photos[photos.length - 1];

    const file = await bot.telegram.getFile(largest.file_id);
    if (!file.file_path) {
      await ctx.reply("I couldn't access that photo — try sending it again?");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) {
      await ctx.reply("I had trouble downloading that photo. Try sending it again?");
      return;
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const imageData: ImageData = { base64, mediaType: 'image/jpeg' };

    const response = await generateResponse(caption, userName, userId, imageData);
    await ctx.reply(response, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error handling photo message:', err);
    await ctx.reply("Sorry, I had trouble reading that photo. Try sending it again?");
  }
}

async function handleVoiceMessage(ctx: Context): Promise<void> {
  const message = ctx.message as Message.VoiceMessage | undefined;
  if (!message || !('voice' in message)) return;

  const userId = message.from?.id;
  if (!userId) return;

  if (isRateLimited(userId)) return;
  updateRateLimit(userId);

  const userName = getUserName(userId);

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }

  try {
    const file = await bot.telegram.getFile(message.voice.file_id);
    if (!file.file_path) {
      await ctx.reply("I couldn't access that voice note — try again?");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) {
      await ctx.reply("I had trouble downloading that voice note. Try again?");
      return;
    }

    const buffer = await res.arrayBuffer();
    const transcript = await transcribeAudio(buffer);

    if (!transcript) {
      await ctx.reply("I couldn't make out what you said — could you try again?");
      return;
    }

    // Echo back what was heard so the family can see it in the chat
    await ctx.reply(`🎙 _"${transcript}"_`, { parse_mode: 'Markdown' });

    const response = await generateResponse(transcript, userName, userId);
    await ctx.reply(response, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error handling voice message:', err);
    await ctx.reply("Sorry, I had trouble with that voice note. Try typing it instead?");
  }
}

// ── Bot setup ─────────────────────────────────────────────────────────────────

// Handle /start command (if someone adds Rose to the group)
bot.command('start', async (ctx) => {
  if (!isFromGroup(ctx)) {
    await ctx.reply("Hi! Add me to your family group chat to get started 😊");
    return;
  }

  await ctx.reply(
    "Hey everyone! 👋 I'm Rose, your family assistant. I'm here to help with the calendar, shopping list, reminders, and more. Just say my name or mention me and I'll chip in. Nice to meet you all! 🌹"
  );
});

// Handle /meals command — show this week's meal plan
bot.command('meals', async (ctx) => {
  if (!isFromGroup(ctx)) return;

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }

  const now = new Date();
  const startDate = now.toISOString().slice(0, 10);
  const end = new Date(now);
  end.setDate(now.getDate() + 13);
  const endDate = end.toISOString().slice(0, 10);

  const { getMealPlan } = await import('./db');
  const meals = await getMealPlan(startDate, endDate);

  if (meals.length === 0) {
    await ctx.reply("Nothing planned yet — tell me what you're having and I'll add it! 🍽");
    return;
  }

  // Group by date
  const byDay = new Map<string, typeof meals>();
  for (const m of meals) {
    if (!byDay.has(m.date)) byDay.set(m.date, []);
    byDay.get(m.date)!.push(m);
  }

  const mealEmoji: Record<string, string> = { breakfast: '🥣', lunch: '🥗', dinner: '🍽' };
  const lines: string[] = ['*Meal plan — next two weeks:*\n'];
  for (const [date, entries] of byDay) {
    const d = new Date(date + 'T12:00:00');
    const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const mealLines = entries.map((e) => `  ${mealEmoji[e.meal_type] ?? '🍽'} ${e.meal_type}: ${e.meal}`).join('\n');
    lines.push(`*${dayLabel}*\n${mealLines}`);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// Handle /weekend command — manual trigger for the weekend events round-up
bot.command('weekend', async (ctx) => {
  if (!isFromGroup(ctx)) return;

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }

  const { generateWeekendEvents } = await import('./ai');
  const message = await generateWeekendEvents();
  if (message) {
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply("I couldn't find anything specific on this weekend — might be worth a manual search!");
  }
});

// Handle /baby command — show the baby prep checklist
bot.command('baby', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }
  const { getBabyChecklist } = await import('./db');
  const items = await getBabyChecklist();
  if (items.length === 0) {
    await ctx.reply("🎉 Baby checklist is all clear — everything's been ticked off!");
    return;
  }
  const grouped: Record<string, string[]> = {};
  for (const item of items) {
    const cat = item.category || 'Other';
    (grouped[cat] ??= []).push(item.item);
  }
  const lines = Object.entries(grouped)
    .map(([cat, its]) => `*${cat}*\n${its.map(i => `• ${i}`).join('\n')}`)
    .join('\n\n');
  await ctx.reply(`🍼 *Baby prep checklist* (${items.length} item${items.length === 1 ? '' : 's'} to go)\n\n${lines}`, { parse_mode: 'Markdown' });
});

// Handle /evie command — quick newborn status: last feed/nappy/sleep + 24h counts
bot.command('evie', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }
  try {
    const { getLastBabyLog, getBabyLogsSince } = await import('./db');
    const babyName = config.family.babyName || 'Baby';
    const [lastFeed, lastNappy, lastSleep, dayLogs] = await Promise.all([
      getLastBabyLog('feed'),
      getLastBabyLog('nappy'),
      getLastBabyLog('sleep'),
      getBabyLogsSince(new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    ]);

    const since = (iso: string) => {
      const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
      if (mins < 60) return `${mins} min ago`;
      const h = Math.floor(mins / 60), m = mins % 60;
      return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
    };

    const feeds = dayLogs.filter(l => l.type === 'feed').length;
    const nappies = dayLogs.filter(l => l.type === 'nappy').length;

    const lines = [
      `👶 *${babyName} right now*`,
      '',
      lastFeed ? `🍼 Last feed: ${since(lastFeed.logged_at)}${lastFeed.amount ? ` (${lastFeed.amount})` : ''}` : '🍼 No feeds logged yet',
      lastNappy ? `👶 Last nappy: ${since(lastNappy.logged_at)}${lastNappy.detail ? ` (${lastNappy.detail})` : ''}` : '👶 No nappies logged yet',
      lastSleep ? `😴 Last sleep note: ${since(lastSleep.logged_at)}${lastSleep.detail ? ` (${lastSleep.detail})` : ''}` : '',
      '',
      `📊 Last 24h: ${feeds} feed(s), ${nappies} nappy change(s)`,
    ].filter(Boolean);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error in /evie:', err);
    await ctx.reply("Couldn't pull that up — the baby tracker table may not be set up yet.");
  }
});

// Handle /ticker command — force-refresh and preview the dashboard events ticker
bot.command('ticker', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }
  try {
    const { refreshLocalEventsTicker, getLocalEventsTicker } = await import('./ai');
    await refreshLocalEventsTicker();
    const items = getLocalEventsTicker();
    if (items.length === 0) {
      await ctx.reply("Couldn't find any local events right now — the search may have come back empty. Try again shortly.");
      return;
    }
    await ctx.reply(`📣 *What's on* (now on the TV dashboard):\n\n${items.map((i) => `• ${i}`).join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error in /ticker:', err);
    await ctx.reply("Couldn't refresh the events ticker just now.");
  }
});

// Handle /pregnancy command — manual trigger for the Monday pregnancy update
bot.command('pregnancy', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    // ignore
  } catch {
    // ignore
  }
  const { generatePregnancyUpdate } = await import('./ai');
  const message = await generatePregnancyUpdate();
  if (message) {
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply('No pregnancy update — either the due date has passed or it\'s not configured.');
  }
});

// Handle /bin command — manual trigger for the Wednesday bin reminder
bot.command('bin', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  const { getFridayBinType } = await import('./scheduler');
  const binType = getFridayBinType();
  if (binType === 'general') {
    await ctx.reply('🗑️ Bin reminder: green bin (general waste) goes out tomorrow morning. Don\'t forget to put it out tonight!');
  } else {
    await ctx.reply('♻️ Bin reminder: blue bin (recycling) goes out tomorrow morning. Don\'t forget to put it out tonight!');
  }
});

// Handle /events command — diagnostic: show what Rose reads from the calendar
// and whether she currently considers today a school holiday.
bot.command('events', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }

  try {
    const { getTodaysEvents, getUpcomingEvents } = await import('./calendar');
    const [today, upcoming] = await Promise.all([getTodaysEvents(), getUpcomingEvents(3)]);

    const HOLIDAY_KEYWORDS = ['holiday', 'half term', 'inset', 'teacher training', 'training day', 'school closed'];
    const isHolidayEvent = (summary: string) =>
      HOLIDAY_KEYWORDS.some((k) => summary.toLowerCase().includes(k));

    const fmt = (e: { summary: string; start: string; end: string }) =>
      `• ${e.summary} (${e.start} → ${e.end})${isHolidayEvent(e.summary) ? '  ⟵ 🏖 detected as holiday' : ''}`;

    const seen = new Set<string>();
    const all = [...today, ...upcoming].filter((e) => {
      const key = `${e.summary}|${e.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const lines = all.length ? all.map(fmt).join('\n') : '(no events found)';
    await ctx.reply(
      `📋 What I can see on the Family calendar (today + next 3 days):\n\n${lines}\n\nIf a holiday is missing or not flagged above, either it's named without a holiday keyword or it's on a different calendar than the one I read.`,
    );
  } catch (err) {
    console.error('Error in /events diagnostic:', err);
    await ctx.reply('Couldn\'t read the calendar just now — I may not be able to connect to Google Calendar.');
  }
});

// Handle /friday command — manual trigger for the Friday school's-out check-in
bot.command('friday', async (ctx) => {
  if (!isFromGroup(ctx)) return;

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // ignore
  }

  const { generateFridayCheckin } = await import('./ai');
  const message = await generateFridayCheckin();
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// Handle /say command — speak a message out loud on the Alexa/Echo device(s)
bot.command('say', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  const message = ctx.message as Message.TextMessage | undefined;
  let text = (message?.text || '').replace(/^\/say(@\S+)?\s*/i, '').trim();
  if (!text) {
    await ctx.reply('What should I say? Try: `/say dinner is ready`, or target a room: `/say @lounge tea\'s ready`', { parse_mode: 'Markdown' });
    return;
  }
  // Optional "@room " prefix to target a specific room (e.g. "@kitchen", "@all").
  let target: string | undefined;
  const roomMatch = text.match(/^@(\S+)\s+([\s\S]+)$/);
  if (roomMatch) {
    target = roomMatch[1]!.replace(/-/g, ' ');
    text = roomMatch[2]!.trim();
  }
  const { speakOnAlexa, isVoiceEnabled } = await import('./voice');
  if (!isVoiceEnabled()) {
    await ctx.reply("Alexa speech isn't set up yet. Add the Voice Monkey skill, then set VOICE_MONKEY_TOKEN and VOICE_MONKEY_DEVICES.");
    return;
  }
  const result = await speakOnAlexa(text, { target });
  if (result.ok) {
    await ctx.reply(`🔊 Said it in ${result.spokenOn.join(', ')}.`);
  } else {
    await ctx.reply(`Couldn't say that out loud — ${result.reason ?? 'the Echo didn\'t respond'}.`);
  }
});

// Handle /devices command — list the Voice Monkey device ids (setup/diagnosis)
bot.command('devices', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  const { listVoiceDevices } = await import('./voice');
  const result = await listVoiceDevices();
  if (!result.ok) {
    await ctx.reply(`Couldn't list Alexa devices — ${result.reason ?? 'unknown error'}.`);
    return;
  }
  if (result.ids.length) {
    await ctx.reply(
      `🔊 Voice Monkey devices found:\n${result.ids.map((d) => `• \`${d}\``).join('\n')}\n\nSet \`VOICE_MONKEY_DEVICES\` in Railway to these ids (comma-separated, exactly).`,
      { parse_mode: 'Markdown' },
    );
  } else {
    await ctx.reply(
      `Connected to Voice Monkey but couldn't parse device ids. Raw response:\n\`\`\`\n${result.raw.slice(0, 500)}\n\`\`\``,
      { parse_mode: 'Markdown' },
    );
  }
});

// Handle /birthdays command — diagnostic: dump the birthdays table + computed countdown
bot.command('birthdays', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    const { getBirthdays, getUpcomingBirthdays } = await import('./db');
    const [all, up] = await Promise.all([getBirthdays(), getUpcomingBirthdays(60)]);
    const daysById = new Map(up.map((u) => [u.id, u.days_until]));
    if (all.length === 0) {
      await ctx.reply('🎂 The birthdays table is empty — no birthdays are stored in the DB.');
      return;
    }
    const lines = all.map((b) => {
      const d = daysById.get(b.id);
      const status = d == null ? '⚠️ not parsed / >60d' : d === 0 ? 'today!' : `${d}d`;
      return `• ${b.name}${b.relation ? ` (${b.relation})` : ''} — stored: \`${b.date}\` → ${status}`;
    });
    await ctx.reply(`🎂 *Birthdays table* (${all.length}):\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`Couldn't read the birthdays table: ${(err as Error).message}`);
  }
});

// Handle /jobs command — quick pocket-money status
bot.command('jobs', async (ctx) => {
  if (!isFromGroup(ctx)) return;
  try {
    const pm = await import('./pocketmoney');
    if (!(await pm.isConfigured())) {
      await ctx.reply('No pocket-money jobs are set up yet.');
      return;
    }
    const lines: string[] = ['🌟 *Pocket money today*', ''];
    for (const name of pm.childNames()) {
      const t = await pm.todayProgress(name);
      const w = await pm.weekProgress(name);
      const left = t.remaining.length ? `left: ${t.remaining.join(', ')}` : 'all done! 🎉';
      lines.push(`*${name}* — ${t.done}/${t.total} today (${pm.money(t.pence)}), ${pm.money(w.pence)} this week\n_${left}_`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error in /jobs:', err);
    await ctx.reply("Couldn't pull up the jobs just now.");
  }
});

// Handle /help command
bot.command('help', async (ctx) => {
  if (!isFromGroup(ctx)) return;

  const helpText = `Here's what I can do:

📅 *Calendar* — "What have we got on next week?" / "Add swimming on Saturday at 9am" / "Move Tuesday's dentist to Wednesday"

🛒 *Shopping list* — "Add milk to the shopping list" / "What's on the list?"

✅ *To-do list* — "Add 'call the school' to the to-do list" / "What's on the to-do list?"

⏰ *Reminders* — "Remind me to call the dentist on Monday morning"

🎂 *Birthdays* — "Add Mum's birthday on March 15th" / "Whose birthday is coming up?"

🍽 */meals* — View the meal plan for the next two weeks

🗓 */weekend* — What's actually on locally this weekend (searches for real events)
🏫 */friday* — Friday school's-out check-in with local events and weather
🗑️ */bin* — Which bin goes out tomorrow
🔊 */say [message]* — Say it out loud everywhere (or \`/say @lounge …\` for one room). Or just ask "Rose, announce … in the kitchen"
🌟 */jobs* — Pocket-money jobs. Just tell me "Poppy made her bed" / "Billy did all his jobs" and I'll tick them off

👶 *Baby tracking* — "Fed Evie 90ml", "dirty nappy", "she's asleep", "gave her vitamin D" — I'll log it. Ask "when did she last feed?" or "how's she done today?"
⚖️ *Weigh-ins & jabs* — "Evie was 4.2kg today" / "when are her jabs?"
🍼 */evie* — Quick status: last feed, nappy & sleep at a glance
👩‍⚕️ *Newborn questions* — Ask me anything (I'll always point you to 111/999/GP for anything urgent)

Just chat naturally — I'll figure out what you need! 😊`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// Handle /whoami command — helps users find their Telegram ID
bot.command('whoami', async (ctx) => {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;

  await ctx.reply(
    `Your Telegram user ID is \`${userId}\`${firstName ? ` (${firstName})` : ''}${username ? ` @${username}` : ''}. Pass this to Luke to add you to Rose's config!`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (ctx) => {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const text = (ctx.message as any)?.text ?? '(no text)';
  console.log(`Message received: chatId=${chatId}, type=${chatType}, text="${text.slice(0, 50)}"`);

  // Only handle messages from our group
  if (!isFromGroup(ctx)) {
    console.log(`Ignoring: chatId ${chatId} !== GROUP_ID ${GROUP_ID}`);
    // If someone messages Rose directly (DM), let them know
    if (ctx.chat?.type === 'private') {
      await ctx.reply(
        "Hey! I live in the family group chat — head over there and we can chat properly 😊"
      );
    }
    return;
  }

  // Route photo messages to the photo handler
  if ('photo' in (ctx.message ?? {})) {
    await handlePhotoMessage(ctx);
    return;
  }

  // Route voice messages to the voice handler
  if ('voice' in (ctx.message ?? {})) {
    await handleVoiceMessage(ctx);
    return;
  }

  await handleGroupMessage(ctx);
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// ── HTTP server (Telegram webhook + family TV dashboard) ───────────────────────

const WEBHOOK_PATH = '/webhook';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(); // 1MB cap
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  webhookHandler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  // Telegram webhook
  if (webhookHandler && req.method === 'POST' && path === WEBHOOK_PATH) {
    webhookHandler(req, res);
    return;
  }

  // Alexa skill endpoint
  if (req.method === 'POST' && path === '/alexa') {
    try {
      const body = await readRequestBody(req);
      const event = JSON.parse(body);
      const { handleAlexaRequest } = await import('./alexa');
      const result = await handleAlexaRequest(event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('Alexa endpoint error:', err);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '1.0',
        response: { outputSpeech: { type: 'PlainText', text: 'Sorry, something went wrong.' }, shouldEndSession: true },
      }));
    }
    return;
  }

  // Family TV dashboard
  if (req.method === 'GET' && (path === '/dashboard' || path === '/dashboard/')) {
    if (!config.dashboardToken) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard is not configured. Set DASHBOARD_TOKEN in the environment.');
      return;
    }
    if (url.searchParams.get('token') !== config.dashboardToken) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    try {
      const data = await getDashboardData();
      const html = renderDashboardPage(data, parseOptions(url.searchParams));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (err) {
      console.error('Dashboard render error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard temporarily unavailable.');
    }
    return;
  }

  // Ring doorbell — manual test trigger to check the dashboard overlay works
  if (req.method === 'GET' && path === '/doorbell-test') {
    if (url.searchParams.get('token') !== config.dashboardToken) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    const msg = await triggerTestDing();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(msg);
    return;
  }

  // Ring doorbell — status (polled fast by the dashboard) and latest snapshot
  if (req.method === 'GET' && path === '/doorbell-status') {
    if (url.searchParams.get('token') !== config.dashboardToken) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getDoorbellStatus()));
    return;
  }
  if (req.method === 'GET' && path === '/doorbell.jpg') {
    if (url.searchParams.get('token') !== config.dashboardToken) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    const snap = getDoorbellSnapshot();
    if (!snap) { res.writeHead(404); res.end('No snapshot'); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    res.end(snap);
    return;
  }
  if (req.method === 'GET' && path === '/motion.jpg') {
    if (url.searchParams.get('token') !== config.dashboardToken) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    const snap = getMotionSnapshot();
    if (!snap) { res.writeHead(404); res.end('No snapshot'); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    res.end(snap);
    return;
  }

  // Background photo(s) committed to the repo (assets/dashboard-bg[-N].*)
  if (req.method === 'GET' && (path === '/dashboard-bg' || path.startsWith('/dashboard-bg/'))) {
    const files = localBgFiles();
    const idxStr = path.slice('/dashboard-bg/'.length);
    const idx = idxStr && /^\d+$/.test(idxStr) ? parseInt(idxStr, 10) : 0;
    const file = files[idx];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No background image. Commit one to assets/dashboard-bg.jpg');
      return;
    }
    const ext = extname(file).toLowerCase();
    const contentType = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
      : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
    createReadStream(file).pipe(res);
    return;
  }

  // Health check / everything else
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── Launch ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Starting Rose...');

  // Hydrate persisted state (e.g. whether the baby has arrived) before serving.
  await loadBabyArrival();

  // Start listening for Ring doorbell presses (no-op if no token configured).
  initRing().catch((err) => console.error('Ring init error:', err));

  initScheduler(sendToGroup);

  const domain = process.env['RAILWAY_PUBLIC_DOMAIN'];
  const port = parseInt(process.env['PORT'] || '3000', 10);

  if (domain) {
    // Webhook mode — we run our own HTTP server so the dashboard and the
    // Telegram webhook share one port.
    const webhookHandler = bot.webhookCallback(WEBHOOK_PATH);
    await bot.telegram.setWebhook(`https://${domain}${WEBHOOK_PATH}`);
    createServer((req, res) => { void handleHttp(req, res, webhookHandler); }).listen(port);
    console.log(`Rose is running in webhook mode on port ${port} ✓`);
    if (config.dashboardToken) {
      console.log(`Dashboard: https://${domain}/dashboard?token=<DASHBOARD_TOKEN>`);
    }
  } else {
    // No domain yet — bind to PORT so Railway can generate a public URL,
    // then fall back to long polling until next deploy.
    createServer((req, res) => { void handleHttp(req, res); }).listen(port);
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        await bot.launch();
        break;
      } catch (err: any) {
        if (err?.response?.error_code === 409 && attempt < 12) {
          console.log(`409 conflict (attempt ${attempt}/12), retrying in 15s...`);
          await new Promise(r => setTimeout(r, 15000));
        } else {
          throw err;
        }
      }
    }
    console.log(`Rose is running in polling mode, HTTP server on port ${port} ✓`);
  }

  const botInfo = await bot.telegram.getMe();
  console.log(`Running as @${botInfo.username}, listening to group: ${GROUP_ID}`);

  // Optional "I'm back" ping after a (re)deploy — set ROSE_STARTUP_PING=true to
  // enable. Handy in production to know instantly when Rose recovers; leave off
  // during active development to avoid spamming the chat on every redeploy.
  if (process.env['ROSE_STARTUP_PING'] === 'true') {
    try {
      await sendToGroup('🌹 Rose is back online');
    } catch (err) {
      console.error('Startup ping failed:', err);
    }
  }

  const shutdown = (signal: string) => {
    console.log('Shutting down...');
    // In webhook mode we run our own server (no bot.launch()), so bot.stop()
    // throws "Bot is not running!" — swallow it so shutdown stays clean.
    try { bot.stop(signal); } catch { /* not running — fine */ }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error starting Rose:', err);
  process.exit(1);
});
