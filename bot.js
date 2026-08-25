import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { JSONFilePreset } from 'lowdb/node';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // e.g. -1001234567890
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'nexapropfirm';
const POINTS_PER_REFERRAL = parseInt(process.env.POINTS_PER_REFERRAL || '14', 10);
const REFERRALS_FOR_REWARD = parseInt(process.env.REFERRALS_FOR_REWARD || '5', 10);
const REWARD_DISCOUNT_PERCENT = parseInt(process.env.REWARD_DISCOUNT_PERCENT || '70', 10);
const COUPON_CODE = process.env.COUPON_CODE || 'NEXA7';
const PLANS_URL = process.env.PLANS_URL || 'https://nexapropfirm.com/plans';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('❌ Missing BOT_TOKEN or CHANNEL_ID in your .env file. Check .env.example.');
  process.exit(1);
}

const POINTS_FOR_REWARD = POINTS_PER_REFERRAL * REFERRALS_FOR_REWARD;

// ---------------------------------------------------------------------------
// DATABASE (lowdb — simple JSON file, no native deps, easy to host anywhere)
// ---------------------------------------------------------------------------
const defaultData = {
  users: {},            // telegramId -> { id, username, firstName, points, referrals, rewarded, isInfluencer, createdAt }
  joins: {},             // telegramId of the JOINER -> { referrerId, joinedAt } (prevents double-crediting)
  pendingReferrals: {},  // telegramId of a NOT-YET-JOINED user -> referrerId (recorded when they open the bot via a referral deep link)
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
      referrals: 0,       // count of successful, tracked referrals (drives the reward — separate from raw points)
      rewarded: false,    // becomes true the moment they hit REFERRALS_FOR_REWARD (so we only ever send the coupon once)
      isInfluencer: false,
      createdAt: new Date().toISOString(),
    };
    await db.write();
  }
  return db.data.users[id];
}

// Escapes text so it's safe to embed inside a Telegram legacy-Markdown message
// (needed because links / usernames / names can contain _, *, `, [ which
// would otherwise be misread as formatting and cause the whole message to fail to send)
function escapeMarkdown(str) {
  return String(str).replace(/([_*`[])/g, '\\$1');
}

// A user's referral link now opens the BOT (not the channel) with their ID baked
// into the /start payload. Opening a bot chat via link always works, even for
// someone who's never messaged the bot before — that's what lets this double as
// a "the bot shows up in their DMs" experience. The bot then hands them a button
// to join the channel, and remembers who referred them until they actually do.
function buildReferralLink(user) {
  if (!BOT_USERNAME) return null;
  return `https://t.me/${BOT_USERNAME}?start=ref_${user.id}`;
}

// ---------------------------------------------------------------------------
// BOT
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

// Filled in once at startup from getMe() — used to build every referral link
let BOT_USERNAME = null;

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx);

  // If they arrived via someone's referral link, ctx.startPayload looks like "ref_123456789".
  // Remember who referred them — we credit the referrer once this person actually joins the channel.
  const payload = ctx.startPayload || '';
  const match = payload.match(/^ref_(\d+)$/);
  if (match) {
    const referrerId = match[1];
    const alreadyJoined = !!db.data.joins[user.id];
    const alreadyPending = !!db.data.pendingReferrals[user.id];
    if (referrerId !== user.id && db.data.users[referrerId] && !alreadyJoined && !alreadyPending) {
      db.data.pendingReferrals[user.id] = referrerId;
      await db.write();
    }
  }

  const link = buildReferralLink(user);

  if (!link) {
    return ctx.reply('⚠️ One moment, still starting up — try /start again in a few seconds.');
  }

  await ctx.reply(
    `👋 Welcome to Nexa Prop Firm, ${escapeMarkdown(user.firstName)}!\n\n` +
      `🔗 *Your personal referral link:*\n${escapeMarkdown(link)}\n\n` +
      `Share it. Every friend who opens it and joins the channel earns you *${POINTS_PER_REFERRAL} Nexa Points*.\n\n` +
      `🎯 *Refer ${REFERRALS_FOR_REWARD} people (${POINTS_FOR_REWARD} points) and unlock:*\n` +
      `• A *${REWARD_DISCOUNT_PERCENT}% off* coupon code, sent to you instantly\n` +
      `• "Nexa Influencer" status — earn up to *50% commission* on every referral you bring in after that\n\n` +
      `💰 Your balance: *${user.points} points* (${user.referrals}/${REFERRALS_FOR_REWARD} referrals)`,
    { parse_mode: 'Markdown', ...(await buildMenu(ctx, user)) }
  );
});

// ---------------------------------------------------------------------------
// TRADING-STYLE BUTTON MENU
// Inline keyboard shown under key messages. Which buttons appear depends on
// whether this person has actually joined the channel yet — checked live
// against Telegram, not from our own records, so it's always accurate.
// ---------------------------------------------------------------------------
async function isChannelMember(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_ID, userId);
    return ['member', 'administrator', 'creator', 'restricted'].includes(member.status);
  } catch (err) {
    // If we can't check (e.g. they've never touched the channel at all), treat as not-a-member
    return false;
  }
}

async function buildMenu(ctx, user) {
  const joinButton = Markup.button.url('✅ Join Nexa Channel', `https://t.me/${CHANNEL_USERNAME}`);
  const member = await isChannelMember(ctx, user.id);

  if (!member) {
    // Not in the channel yet — only the join button, nothing else unlocked
    return Markup.inlineKeyboard([[joinButton]]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 MY LINK', 'menu_mylink'),
      Markup.button.callback('💰 BALANCE', 'menu_balance'),
      Markup.button.callback('🏆 LEADERBOARD', 'menu_leaderboard'),
    ],
  ]);
}

async function sendMyLink(ctx) {
  const user = await getOrCreateUser(ctx);
  const link = buildReferralLink(user);
  if (!link) return ctx.reply('⚠️ Still starting up — try again in a few seconds.');
  await ctx.reply(`🔗 *Your referral link:*\n${escapeMarkdown(link)}`, { parse_mode: 'Markdown', ...(await buildMenu(ctx, user)) });
}

async function sendBalance(ctx) {
  const user = await getOrCreateUser(ctx);

  let msg =
    `💰 *Nexa Points Balance*\n\n` +
    `Points: *${user.points}*\n` +
    `Referrals: *${user.referrals}/${REFERRALS_FOR_REWARD}*\n`;

  if (user.rewarded) {
    msg +=
      `\n🏆 You've unlocked your *${REWARD_DISCOUNT_PERCENT}% off* coupon: *${COUPON_CODE}*\n` +
      `Use it here: ${PLANS_URL}\n\n` +
      `⭐ You're a *Nexa Influencer* — keep sharing your link to earn commission on every referral from here on.`;
  } else {
    const remaining = REFERRALS_FOR_REWARD - user.referrals;
    msg += `\n${remaining} more referral${remaining === 1 ? '' : 's'} to unlock your *${REWARD_DISCOUNT_PERCENT}% off* coupon and Nexa Influencer status.`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', ...(await buildMenu(ctx, user)) });
}

async function sendLeaderboard(ctx) {
  const user = await getOrCreateUser(ctx);
  const top = Object.values(db.data.users)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  if (top.length === 0) return ctx.reply('No referrals yet — be the first!', await buildMenu(ctx, user));

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((u, i) => {
    const name = escapeMarkdown(u.firstName || 'Anonymous');
    const rank = medals[i] || `${i + 1}.`;
    return `${rank} ${name} — ${u.points} pts`;
  });

  await ctx.reply(`🏆 *Top Referrers*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...(await buildMenu(ctx, user)) });
}

async function sendHelp(ctx) {
  const user = await getOrCreateUser(ctx);
  await ctx.reply(
    `*How the Nexa Referral Program works*\n\n` +
      `1. Run /start to get your unique link\n` +
      `2. Share it with friends\n` +
      `3. When they tap it, it opens this bot for them — then they tap "Join Nexa Channel"\n` +
      `4. The moment they join, you get ${POINTS_PER_REFERRAL} points automatically\n` +
      `5. Refer ${REFERRALS_FOR_REWARD} people and you instantly get a *${REWARD_DISCOUNT_PERCENT}% off* coupon code for ${PLANS_URL}\n` +
      `6. You also become a *Nexa Influencer*, earning up to 50% commission on every referral after that\n\n` +
      `Check your progress anytime with the buttons below.`,
    { parse_mode: 'Markdown', ...(await buildMenu(ctx, user)) }
  );
}

bot.command('mylink', sendMyLink);
bot.command('balance', sendBalance);
bot.command('leaderboard', sendLeaderboard);
bot.help(sendHelp);

// Button taps route to the exact same logic as their /command equivalents
bot.action('menu_mylink', async (ctx) => { await ctx.answerCbQuery(); await sendMyLink(ctx); });
bot.action('menu_balance', async (ctx) => { await ctx.answerCbQuery(); await sendBalance(ctx); });
bot.action('menu_leaderboard', async (ctx) => { await ctx.answerCbQuery(); await sendLeaderboard(ctx); });

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
  const totalInfluencers = Object.values(db.data.users).filter((u) => u.isInfluencer).length;
  await ctx.reply(
    `📊 *Nexa Referral Stats*\n\nRegistered users: ${totalUsers}\nSuccessful referrals: ${totalJoins}\nTotal points issued: ${totalPoints}\nNexa Influencers: ${totalInfluencers}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('influencers', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const influencers = Object.values(db.data.users).filter((u) => u.isInfluencer);
  if (influencers.length === 0) return ctx.reply('No Nexa Influencers yet.');

  const lines = influencers.map((u) => {
    const handle = u.username ? `@${u.username}` : `id:${u.id}`;
    return `• ${escapeMarkdown(u.firstName || 'Unknown')} (${handle}) — ${u.referrals} referrals`;
  });

  await ctx.reply(
    `⭐ *Nexa Influencers* (for manual commission payout)\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});

// Wipes everyone's points/referrals/reward status back to zero for a fresh leaderboard.
// Requires typing CONFIRM after the command so it can't be triggered by accident.
// Does NOT delete users or their referral links — people keep the same /mylink,
// it just starts counting from 0 again.
bot.command('resetleaderboard', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [, confirmation] = ctx.message.text.split(' ');

  if (confirmation !== 'CONFIRM') {
    return ctx.reply(
      '⚠️ This wipes everyone\'s points, referral counts, coupon-unlock status, and Nexa Influencer status back to zero.\n\n' +
        'Referral links stay the same, so no one needs to /start again.\n\n' +
        'To confirm, send:\n/resetleaderboard CONFIRM'
    );
  }

  for (const user of Object.values(db.data.users)) {
    user.points = 0;
    user.referrals = 0;
    user.rewarded = false;
    user.isInfluencer = false;
  }
  db.data.joins = {};
  db.data.pendingReferrals = {};
  await db.write();

  await ctx.reply('✅ Leaderboard reset. Everyone is back to 0 points — referral links still work as before.');
});

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

    // Try to DM the new member directly. This only succeeds if they've already
    // messaged the bot before (Telegram blocks bots from cold-DMing anyone) —
    // there's no channel fallback here, so people who joined via the raw public
    // channel link (not through the bot) simply won't receive this one.
    try {
      await ctx.telegram.sendMessage(
        joinerId,
        `🎁 Welcome to Nexasave! 😊\n` +
          `Get your referral link and earn Nexa Points every time a friend joins through you.\n` +
          `Use your points toward prop firm evaluation discounts — up to 70% OFF! 🔥`
      );
    } catch (err) {
      console.log(`Could not DM new joiner ${joinerId} (likely joined without starting the bot):`, err.description || err.message);
    }

    // Attribution now comes from pendingReferrals (set in /start when they opened
    // the bot via someone's ref_ link), not from which channel invite link was used.
    const referrerId = db.data.pendingReferrals[joinerId];
    if (!referrerId) return; // joined directly, or opened the bot without a referral payload

    // Prevent self-referral and double-crediting on leave/rejoin
    if (joinerId === referrerId) return;
    if (db.data.joins[joinerId]) return;

    db.data.joins[joinerId] = { referrerId, joinedAt: new Date().toISOString() };
    delete db.data.pendingReferrals[joinerId];

    if (db.data.users[referrerId]) {
      const referrer = db.data.users[referrerId];
      referrer.points += POINTS_PER_REFERRAL;
      referrer.referrals += 1;
      await db.write();

      try {
        await ctx.telegram.sendMessage(
          referrerId,
          `🎉 Someone just joined Nexa through your referral link!\n+${POINTS_PER_REFERRAL} Nexa Points added.\n\nReferrals: ${referrer.referrals}/${REFERRALS_FOR_REWARD}\nCheck /balance to see your progress.`
        );
      } catch {
        // Referrer may have blocked the bot — ignore, points are still credited
      }

      // Milestone check — fires exactly once, the moment they cross the referral threshold
      if (referrer.referrals >= REFERRALS_FOR_REWARD && !referrer.rewarded) {
        referrer.rewarded = true;
        referrer.isInfluencer = true;
        await db.write();

        try {
          await ctx.telegram.sendMessage(
            referrerId,
            `🎉🔥 Congratulations! You've hit ${REFERRALS_FOR_REWARD} referrals!\n\n` +
              `🎟 Your coupon code: *${COUPON_CODE}* (${REWARD_DISCOUNT_PERCENT}% off)\n` +
              `Use it here to get your evaluation account: ${PLANS_URL}\n\n` +
              `⭐ You're now a *Nexa Influencer*! Keep sharing your referral link — you can earn up to *50% commission* on every referral you bring in from here on. Our team will be in touch about commission payouts.`,
            { parse_mode: 'Markdown' }
          );
        } catch {
          // Referrer may have blocked the bot — reward is still recorded, admins can see it via /influencers
        }
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

// Global safety net: if any handler throws (e.g. a formatting error), log it
// loudly and let the user know something went wrong instead of failing silently.
bot.catch((err, ctx) => {
  console.error(`Unhandled error for update ${ctx.updateType}:`, err);
  if (ctx.chat) {
    ctx.reply('⚠️ Something went wrong on my end — please try again in a moment.').catch(() => {});
  }
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
