# Nexa Referral Bot

Tracks referrals into your Nexa Prop Firm Telegram channel and rewards Nexa Points → discounts.

## How it actually works (important)

Bots **cannot** silently add someone to a channel — Telegram doesn't allow that for privacy reasons.
Instead, this bot uses Telegram's built-in tracking system:

1. Every user gets their **own personal invite link** to your channel (generated automatically by the bot).
2. They share that link instead of your normal public channel link.
3. When someone taps it and joins, Telegram tells the bot *which link was used*.
4. The bot matches that link to the referrer and adds points — fully automatic, no manual work.

The person joining still taps "Join Channel" like normal — that part can't be skipped — but the whole tracking + rewarding is automatic.

## Setup

### 1. Create the bot
- Message **@BotFather** on Telegram → `/newbot` → follow prompts → copy the **token**.

### 2. Add the bot to your channel as admin
- Open your channel → Administrators → Add Admin → add your bot.
- Give it at minimum: **"Invite Users via Link"**. It also needs to remain a regular admin to receive join events (default admin rights are fine).

### 3. Get your Channel ID
- Add **@userinfobot** or **@RawDataBot** to your channel briefly (or forward any message from the channel to it) to get the numeric ID — it'll look like `-1001234567890`.

### 4. Configure
```bash
cp .env.example .env
```
Fill in `BOT_TOKEN`, `CHANNEL_ID`, `CHANNEL_USERNAME`, `POINTS_PER_REFERRAL`, `ADMIN_IDS`.

### 5. Install & run
```bash
npm install
npm start
```

You should see `✅ Nexa Referral Bot is running.` in the console.

## Commands

**Users:**
- `/start` – registers the user and gives their personal referral link
- `/mylink` – re-send their link
- `/balance` – points + current discount tier
- `/leaderboard` – top 10 referrers
- `/help` – explains the program

**Admins** (must be in `ADMIN_IDS` in `.env`):
- `/addpoints <telegram_id> <amount>`
- `/removepoints <telegram_id> <amount>`
- `/stats` – overall program stats

## Editing discount tiers

Open `bot.js` and edit the `DISCOUNT_TIERS` array near the top:

```js
const DISCOUNT_TIERS = [
  { points: 0,   discount: 0 },
  { points: 10,  discount: 5 },
  { points: 30,  discount: 10 },
  { points: 60,  discount: 15 },
  { points: 100, discount: 20 },
  { points: 200, discount: 30 },
];
```

Add, remove, or reprice tiers freely — no other code changes needed.

## Data storage

Uses a local `db.json` file (via lowdb) — zero setup, no database server needed. It's created automatically on first run. **Back this file up regularly** if you're running this in production; it's your only record of everyone's points.

## Hosting (so it runs 24/7)

This needs to run continuously to catch join events — your laptop won't do. Cheapest reliable options:
- **Railway.app** or **Render.com** – free/cheap tier, deploy straight from a GitHub repo, just add your `.env` values as environment variables in their dashboard.
- A small **VPS** (e.g. Hetzner, DigitalOcean) running the bot with `pm2 start bot.js` so it survives reboots.

Whichever you choose: push this folder to a GitHub repo first, then connect that repo to Railway/Render.

## Redeeming discounts

This bot tracks and displays points/discounts but doesn't touch payments — when someone checks out for a Nexa evaluation, your team (or your checkout system) looks up their `/balance` and applies the matching discount manually or via your own checkout logic. Let me know if you want that wired up to an actual checkout flow later.
