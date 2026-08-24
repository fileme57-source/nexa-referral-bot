import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { JSONFilePreset } from 'lowdb/node';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // e.g. -1001234567890
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'nexapropfirm';
const POINTS_PER_REFERRAL = parseInt(process.env.POINTS_PER_REFERRAL || '10', 10);
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('❌ Missing BOT_TOKEN or CHANNEL_ID in your .env file. Check .env.example.');
  process.exit(1);
}

// Catch anything that slips through so a single bad send doesn't kill the process
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Discount tiers — edit these to match your pricing. Points are cumulative (lifetime).
// Sorted ascending; the bot picks the highest tier the user qualifies for.
const DISCOUNT_TIERS = [
  { points: 0, discount: 0 },
  { points: 10, discount: 5 },
  { points: 30, discount: 10 },
  { points: 60, discount: 15 },
  { points: 100, discount: 20 },
  { points: 200, discount: 30 },
];

function getDiscountForPoints(points) {
  let tier = DISCOUNT_TIERS[0];
  for (const t of DISCOUNT_TIERS) {
    if (points >= t.points) tier = t;
  }
  return tier.discount;
}

function nextTierInfo(points) {
  const next = DISCOUNT_TIERS.find((t) => t.points > points);
  if (!next) return null;
  return { pointsNeeded: next.points - points, discount: next.discount };
}

// Escapes Markdown special chars (mainly underscores in usernames) so
// Telegram's parser doesn't choke and reject the whole message.
function escapeMarkdown(str) {
  return String(str).replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}

// Escapes text for safe use inside Telegram HTML-parse-mode messages
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Shared inline keyboard shown under the welcome message and reusable elsewhere
const mainMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🔗 My Link', 'mylink')],
  [Markup.button.callback('💰 Balance', 'balance')],
  [Markup.button.callback('🏆 Leaderboard', 'leaderboard')],
  [Markup.button.callback('❓ Help', 'help')],
]);

// ---------------------------------------------------------------------------
// DATABASE (lowdb — simple JSON file, no native deps, easy to host anywhere)
// ---------------------------------------------------------------------------
const defaultData = {
  users: {},           // telegramId -> { id, username, firstName, points, inviteLink, createdAt }
  invites: {},         // inviteLinkUrl -> telegramId (owner of that link)
  joins: {},           // telegramId of the JOINER -> { referrerId, joinedAt } (prevents double-crediting)
  pendingWelcomes: {},  // telegramId of the JOINER -> channel message_id of their welcome post (deleted once they /start the bot)
};

const db = await JSONFilePreset('db.json', defaultData);

async function getOrCreateUser(ctx) {
  const id = String(ctx.from.id);
  if (!db.data.users[id]) {
    db.data.users[id] = {
      id,
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || '',
      points: 0,
      inviteLink: null,
      createdAt: new Date().toISOString(),
    };
    await db.write();
  }
  return db.data.users[id];
}

async function ensureInviteLink(ctx, user) {
  if (user.inviteLink) return user.inviteLink;

  try {
    const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
      name: `ref-${user.id}`.slice(0, 32), // Telegram limits invite link names to 32 chars
      creates_join_request: false,
    });
    user.inviteLink = link.invite_link;
    db.data.invites[link.invite_link] = user.id;
    await db.write();
    return user.inviteLink;
  } catch (err) {
    console.error('Failed to create invite link:', err.description || err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// BOT
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// ---------------------------------------------------------------------------
// SHARED HANDLER LOGIC
// Each of these is called from BOTH the /command version and the button
// (bot.action) version below, so the behavior always stays in sync.
// ---------------------------------------------------------------------------

async function sendMyLink(ctx) {
  const user = await getOrCreateUser(ctx);
  const link = await ensureInviteLink(ctx, user);
  if (!link) return ctx.reply('⚠️ Could not fetch your link right now, try again shortly.');
  await ctx.reply(`🔗 Your referral link:\n${link}`);
}

async function sendBalance(ctx) {
  const user = await getOrCreateUser(ctx);
  const discount = getDiscountForPoints(user.points);
  const next = nextTierInfo(user.points);

  let msg =
    `💰 *Nexa Points Balance*\n\n` +
    `Points: *${user.points}*\n` +
    `Current discount: *${discount}%*\n`;

  if (next) {
    msg += `\nEarn *${next.pointsNeeded} more points* to unlock *${next.discount}% off*.`;
  } else {
    msg += `\n🏆 You're at the top tier!`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

async function sendLeaderboard(ctx) {
  const top = Object.values(db.data.users)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  if (top.length === 0) return ctx.reply('No referrals yet — be the first!');

  const lines = top.map((u, i) => {
    // Escape the name so a stray "_" (like @scientist_te) can't break
    // Telegram's Markdown parser and crash the send.
    const rawName = u.username ? `@${u.username}` : u.firstName || 'Anonymous';
    const name = escapeMarkdown(rawName);
    return `${i + 1}. ${name} — ${u.points} pts`;
  });

  const text = `🏆 *Top Referrers*\n\n${lines.join('\n')}`;

  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Failed to send leaderboard (Markdown), retrying as plain text:', err.description || err.message);
    try {
      // Fallback: strip all formatting so a bad character can never crash this again
      await ctx.reply(text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, ''));
    } catch (fallbackErr) {
      console.error('Leaderboard fallback send also failed:', fallbackErr.description || fallbackErr.message);
    }
  }
}

async function sendHelp(ctx) {
  await ctx.reply(
    `*How the Nexa Referral Program works*\n\n` +
      `1. Run /start to get your unique invite link\n` +
      `2. Share it with friends\n` +
      `3. When they join t.me/${CHANNEL_USERNAME} through YOUR link, you get ${POINTS_PER_REFERRAL} points automatically\n` +
      `4. Points unlock bigger discounts on Nexa evaluations — check /balance anytime`,
    { parse_mode: 'Markdown' }
  );
}

// ---------------------------------------------------------------------------
// COMMANDS (typed by user)
// ---------------------------------------------------------------------------

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx);

  // If this user still has an unclaimed welcome message sitting in the channel, delete it now
  const pendingMessageId = db.data.pendingWelcomes[user.id];
  if (pendingMessageId) {
    try {
      await ctx.telegram.deleteMessage(CHANNEL_ID, pendingMessageId);
    } catch (err) {
      console.error('Failed to delete welcome message:', err.description || err.message);
    } finally {
      delete db.data.pendingWelcomes[user.id];
      await db.write();
    }
  }

  const link = await ensureInviteLink(ctx, user);

  if (!link) {
    return ctx.reply(
      '⚠️ I could not generate your referral link. Please tell the Nexa team — the bot likely needs to be made an admin of the channel with "Invite Users via Link" permission.'
    );
  }

  const discount = getDiscountForPoints(user.points);

  await ctx.reply(
    `👋 Welcome to Nexa Prop Firm, ${user.firstName}!\n\n` +
      `🔗 *Your personal referral link:*\n${link}\n\n` +
      `Share this link. When someone joins the channel through it, you automatically earn *${POINTS_PER_REFERRAL} Nexa Points*.\n\n` +
      `💰 Your current balance: *${user.points} points* → *${discount}% discount*`,
    { parse_mode: 'Markdown', ...mainMenuKeyboard }
  );
});

bot.command('mylink', sendMyLink);
bot.command('balance', sendBalance);
bot.command('leaderboard', sendLeaderboard);
bot.help(sendHelp);

// ---------------------------------------------------------------------------
// BUTTON TAPS (inline keyboard callbacks)
// ---------------------------------------------------------------------------

bot.action('mylink', async (ctx) => {
  await ctx.answerCbQuery();
  await sendMyLink(ctx);
});

bot.action('balance', async (ctx) => {
  await ctx.answerCbQuery();
  await sendBalance(ctx);
});

bot.action('leaderboard', async (ctx) => {
  await ctx.answerCbQuery();
  await sendLeaderboard(ctx);
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await sendHelp(ctx);
});

// ---------------------------------------------------------------------------
// ADMIN COMMANDS
// ---------------------------------------------------------------------------
bot.command('addpoints', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [, targetId, amountStr] = ctx.message.text.split(' ');
  const amount = parseInt(amountStr, 10);
  if (!targetId || Number.isNaN(amount)) {
    return ctx.reply('Usage: /addpoints <telegram_id> <amount>');
  }
  if (!db.data.users[targetId]) return ctx.reply('User not found (they must /start the bot first).');
  db.data.users[targetId].points += amount;
  await db.write();
  await ctx.reply(`✅ Added ${amount} points to ${targetId}. New balance: ${db.data.users[targetId].points}`);
});

bot.command('removepoints', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [, targetId, amountStr] = ctx.message.text.split(' ');
  const amount = parseInt(amountStr, 10);
  if (!targetId || Number.isNaN(amount)) {
    return ctx.reply('Usage: /removepoints <telegram_id> <amount>');
  }
  if (!db.data.users[targetId]) return ctx.reply('User not found.');
  db.data.users[targetId].points = Math.max(0, db.data.users[targetId].points - amount);
  await db.write();
  await ctx.reply(`✅ Removed ${amount} points from ${targetId}. New balance: ${db.data.users[targetId].points}`);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const totalUsers = Object.keys(db.data.users).length;
  const totalJoins = Object.keys(db.data.joins).length;
  const totalPoints = Object.values(db.data.users).reduce((sum, u) => sum + u.points, 0);
  await ctx.reply(
    `📊 *Nexa Referral Stats*\n\nRegistered users: ${totalUsers}\nSuccessful referrals: ${totalJoins}\nTotal points issued: ${totalPoints}`,
    { parse_mode: 'Markdown' }
  );
});

// Filled in once at startup from getMe() — used to build the "DM the bot" link
let BOT_USERNAME = null;

// ---------------------------------------------------------------------------
// CORE TRACKING LOGIC
// Fires whenever someone's membership status changes in the channel.
// Requires the bot to be an ADMIN of the channel, and 'chat_member' to be
// in allowed_updates (set below in bot.launch).
// ---------------------------------------------------------------------------
bot.on('chat_member', async (ctx) => {
  try {
    const update = ctx.update.chat_member;
    if (String(update.chat.id) !== String(CHANNEL_ID)) return;

    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;
    const joinedNow = ['left', 'kicked'].includes(oldStatus) && ['member', 'restricted'].includes(newStatus);
    if (!joinedNow) return;

    const joiner = update.new_chat_member.user;
    const joinerId = String(joiner.id);
    const joinerName = escapeHtml(joiner.first_name || joiner.username || 'there');

    // Post a welcome message in the channel pointing the new member to the bot,
    // regardless of whether we can attribute them to a referrer.
    if (BOT_USERNAME) {
      try {
        const sent = await ctx.telegram.sendMessage(
          CHANNEL_ID,
          `👋 Welcome, <a href="tg://user?id=${joinerId}">${joinerName}</a>!\n\n` +
            `Want to earn rewards? DM me @${BOT_USERNAME} and tap Start to get your own referral link — every friend who joins through it earns you Nexa Points toward a discount.`,
          { parse_mode: 'HTML' }
        );
        // Remember this message so we can delete it once they actually /start the bot
        db.data.pendingWelcomes[joinerId] = sent.message_id;
        await db.write();
      } catch (err) {
        console.error('Failed to post welcome message:', err.description || err.message);
      }
    }

    const inviteLinkUsed = update.invite_link?.invite_link;
    if (!inviteLinkUsed) return; // joined without a tracked link (e.g. public link, admin add)

    const referrerId = db.data.invites[inviteLinkUsed];
    if (!referrerId) return; // link not in our records

    // Prevent self-referral and double-crediting on leave/rejoin
    if (joinerId === referrerId) return;
    if (db.data.joins[joinerId]) return;

    db.data.joins[joinerId] = { referrerId, joinedAt: new Date().toISOString() };

    if (db.data.users[referrerId]) {
      db.data.users[referrerId].points += POINTS_PER_REFERRAL;
      await db.write();

      try {
        await ctx.telegram.sendMessage(
          referrerId,
          `🎉 Someone just joined Nexa through your referral link!\n+${POINTS_PER_REFERRAL} Nexa Points added.\n\nCheck /balance to see your discount tier.`
        );
      } catch {
        // Referrer may have blocked the bot — ignore, points are still credited
      }
    }
  } catch (err) {
    console.error('Error processing chat_member update:', err);
  }
});

// ---------------------------------------------------------------------------
// LAUNCH
// ---------------------------------------------------------------------------
bot.telegram.getMe().then((me) => {
  BOT_USERNAME = me.username;
  console.log(`   Bot username resolved: @${BOT_USERNAME}`);
});

bot.launch({
  allowedUpdates: ['message', 'chat_member', 'my_chat_member', 'callback_query'],
}).then(() => {
  console.log('✅ Nexa Referral Bot is running.');
  console.log(`   Tracking channel: ${CHANNEL_ID} (@${CHANNEL_USERNAME})`);
  console.log(`   Points per referral: ${POINTS_PER_REFERRAL}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
