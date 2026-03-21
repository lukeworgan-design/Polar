import { Telegraf, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { config, getUserName } from './config';
import { generateResponse, shouldRoseRespond } from './ai';
import { initScheduler } from './scheduler';

const bot = new Telegraf(config.telegram.botToken);
const GROUP_ID = parseInt(config.telegram.groupId, 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFromGroup(ctx: Context): boolean {
  return ctx.chat?.id === GROUP_ID;
}

function getMentionPatterns(botUsername: string): RegExp[] {
  return [
    new RegExp(`@${botUsername}`, 'i'),
    /\brose[,!?\s]/i,
    /^rose$/i,
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

  // Decide whether Rose should respond
  let shouldRespond = mentioned;

  if (!shouldRespond) {
    // Use AI to decide if this is worth responding to
    // But only if the message looks like it could be relevant (avoid calling AI for every message)
    const mightBeRelevant =
      text.includes('?') ||
      /\b(calendar|schedule|shopping|list|remind|birthday|tomorrow|today|week|add|remove|cancel|book|dentist|meeting|doctor)\b/i.test(text);

    if (mightBeRelevant) {
      shouldRespond = await shouldRoseRespond(text, false);
    }
  }

  if (!shouldRespond) return;

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

// ── Bot setup ─────────────────────────────────────────────────────────────────

bot.on('message', async (ctx) => {
  // Only handle messages from our group
  if (!isFromGroup(ctx)) {
    // If someone messages Rose directly (DM), let them know
    if (ctx.chat?.type === 'private') {
      await ctx.reply(
        "Hey! I live in the family group chat — head over there and we can chat properly 😊"
      );
    }
    return;
  }

  await handleGroupMessage(ctx);
});

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

// Handle /help command
bot.command('help', async (ctx) => {
  if (!isFromGroup(ctx)) return;

  const helpText = `Here's what I can do:

📅 *Calendar* — "What have we got on next week?" / "Add swimming on Saturday at 9am" / "Move Tuesday's dentist to Wednesday"

🛒 *Shopping list* — "Add milk to the shopping list" / "What's on the list?"

✅ *To-do list* — "Add 'call the school' to the to-do list" / "What's on the to-do list?"

⏰ *Reminders* — "Remind me to call the dentist on Monday morning"

🎂 *Birthdays* — "Add Mum's birthday on March 15th" / "Whose birthday is coming up?"

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

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// ── Launch ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Starting Rose...');

  // Initialise the scheduler with a send function
  initScheduler(sendToGroup);

  // Launch the bot
  await bot.launch();

  const botInfo = await bot.telegram.getMe();
  console.log(`Rose is running as @${botInfo.username} ✓`);
  console.log(`Listening to group: ${GROUP_ID}`);

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('Shutting down...');
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    console.log('Shutting down...');
    bot.stop('SIGTERM');
  });
}

main().catch((err) => {
  console.error('Fatal error starting Rose:', err);
  process.exit(1);
});
