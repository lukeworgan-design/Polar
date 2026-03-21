# 🌹 Rose — Family Personal Assistant

Rose is a Telegram bot that lives in your family group chat. She's a warm, witty, always-on-top-of-things assistant who handles your shared calendar, shopping list, to-dos, reminders, and birthdays — and chats like a real person, not a command-line tool.

---

## What Rose can do

- 📅 **Calendar** — Read and write the Family Google Calendar with natural language
- 🛒 **Shopping list** — Shared, editable by both of you
- ✅ **To-do list** — Family task list
- ⏰ **Reminders** — Personal reminders delivered to the group at the right time
- 🎂 **Birthdays** — Stores important dates and gives advance notice
- 🌅 **Daily summaries** — Good morning message at 7:30am with what's on today
- 📆 **Weekly summaries** — Sunday evening overview of the week ahead
- 🔔 **Event reminders** — Proactive heads-ups 1 week, 1 day, and 2 hours before events

---

## Setup

### Prerequisites

- Node.js 20+
- A Telegram account
- A Google account with a "Family" calendar
- An Anthropic API key
- A Railway account (for deployment)

---

## Step 1 — Create the Telegram Bot

1. Open Telegram and message **@BotFather**
2. Send `/newbot`
3. Give it a name: `Rose`
4. Give it a username: something like `RoseFamilyBot`
5. BotFather will give you a **bot token** — save it as `TELEGRAM_BOT_TOKEN`

---

## Step 2 — Create the Telegram Group and Add Rose

1. Create a new Telegram group (e.g. "Family")
2. Add both Luke and Toni to the group
3. Add your Rose bot to the group (search by its username)
4. **Promote Rose to admin** — she needs to be an admin to read all messages:
   - Open group settings → Administrators → Add administrator → select Rose
   - She needs: *Send messages*, *Read messages* (default admin permissions are fine)

---

## Step 3 — Get the Group Chat ID

With Rose in the group:

1. Send a message in the group (anything)
2. Visit this URL in your browser (replace `YOUR_BOT_TOKEN`):
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
3. Look for `"chat":{"id":` in the response — the negative number is your group ID
4. Save it as `TELEGRAM_GROUP_ID` (include the minus sign, e.g. `-1001234567890`)

**Alternative:** Once Rose is running, type `/whoami` in the group — she'll reply with her chat ID info. Or check your bot's logs on Railway.

---

## Step 4 — Get Your Telegram User IDs

1. Start the bot locally or on Railway
2. In the Telegram group, each person types: `/whoami`
3. Rose will reply with your Telegram user ID
4. Save:
   - Luke's ID as `TELEGRAM_USER_ID_LUKE`
   - Toni's ID as `TELEGRAM_USER_ID_TONI`

---

## Step 5 — Set Up Google Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g. "Rose Assistant")
3. Go to **APIs & Services → Library** and enable the **Google Calendar API**
4. Go to **APIs & Services → Credentials**
5. Click **Create Credentials → OAuth client ID**
6. Application type: **Desktop app**
7. Download the JSON file
8. Copy the entire contents of the JSON file — this is your `GOOGLE_CREDENTIALS_JSON`

---

## Step 6 — Run the Google OAuth Flow (Local)

This step runs on your local machine to generate the OAuth token.

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/lukeworgan/Polar.git
   cd Polar
   npm install
   ```

2. Create a `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Add your `GOOGLE_CREDENTIALS_JSON` to `.env`

4. Run the auth script:
   ```bash
   npm run auth
   ```

5. The script will:
   - Print a URL — open it in your browser
   - Ask you to log in with your Google account and grant calendar access
   - Give you an authorisation code — paste it back into the terminal
   - Print a `GOOGLE_TOKEN_JSON` string

6. Copy the `GOOGLE_TOKEN_JSON` value — you'll need it for Railway

---

## Step 7 — Deploy to Railway

### Connect your GitHub repo

1. Push this repo to GitHub (it should already be at `github.com/lukeworgan/Polar`)
2. Go to [railway.app](https://railway.app) and sign in
3. Click **New Project → Deploy from GitHub repo**
4. Select the `Polar` repo

### Add environment variables

In Railway, go to your service → **Variables** tab and add:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token from BotFather |
| `TELEGRAM_GROUP_ID` | Your group chat ID (negative number) |
| `TELEGRAM_USER_ID_LUKE` | Luke's Telegram user ID |
| `TELEGRAM_USER_ID_TONI` | Toni's Telegram user ID |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GOOGLE_CREDENTIALS_JSON` | The full credentials JSON string |
| `GOOGLE_TOKEN_JSON` | The token JSON from `npm run auth` |
| `TIMEZONE` | `Europe/London` (or your timezone) |

### Add a volume for SQLite persistence

1. In Railway, go to your service → **Volumes**
2. Add a volume mounted at `/data`
3. This keeps Rose's database (shopping list, reminders, etc.) between deployments

### Deploy

Railway will automatically build and deploy from your GitHub repo. Check the **Logs** tab to see Rose starting up.

---

## Running locally

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Run OAuth flow (first time only)
npm run auth

# Start Rose in development mode
npm run dev

# Or build and run
npm run build
npm start
```

---

## Project structure

```
/src
  bot.ts        — Telegram bot, message routing, and group chat logic
  calendar.ts   — Google Calendar API integration
  scheduler.ts  — Cron jobs for summaries and reminders
  ai.ts         — Claude API calls, tool use, and prompt management
  db.ts         — SQLite database setup and queries
  config.ts     — Environment variables and user configuration
auth.ts         — Standalone OAuth flow script (run locally)
Dockerfile      — Container build for Railway
railway.toml    — Railway deployment configuration
.env.example    — Template for environment variables
```

---

## Talking to Rose

Rose lives in the group chat. Talk to her naturally:

- **"Rose, what have we got on this week?"**
- **"Add swimming lessons every Saturday at 9am"**
- **"Move Tuesday's dentist to Thursday afternoon"**
- **"Add milk and eggs to the shopping list"**
- **"Remind Luke to call the school on Monday morning"**
- **"Add Mum's birthday — it's March 15th"**
- **"Are we free Saturday afternoon?"**
- **"What's left on the to-do list?"**

Rose also chips in proactively — if you're discussing plans and she spots a clash in the calendar, she'll say so without being asked.

---

## Commands

- `/start` — Introduces Rose to the group
- `/help` — Shows what Rose can do
- `/whoami` — Shows your Telegram user ID (useful for setup)

---

## Notes

- Rose only responds to messages in the configured group chat
- She uses AI to decide whether a message warrants a response (to avoid jumping in on every conversation)
- The SQLite database is stored at `/data/rose.db` — mount a Railway volume there for persistence
- If you rotate your Google token, run `npm run auth` again and update `GOOGLE_TOKEN_JSON` in Railway
- The "Family" calendar is the shared Google Calendar Rose reads and writes — make sure it exists and is accessible to the authorised Google account
