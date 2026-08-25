import 'dotenv/config';
import { Telegraf } from 'telegraf';
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
      referrals: 0,       // count of successful, tracked referrals (drives the reward — separate from raw points)
      rewarded: false,    // becomes true the moment they hit REFERRALS_FOR_REWARD (so we only ever send the coupon once)
      isInfluencer: false,
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

  await ctx.reply(
    `👋 Welcome to Nexa Prop Firm, ${user.firstName}!\n\n` +
      `🔗 *Your personal referral link:*\n${link}\n\n` +
      `Share it. Every friend who joins the channel through your link earns you *${POINTS_PER_REFERRAL} Nexa Points*.\n\n` +
      `🎯 *Refer ${REFERRALS_FOR_REWARD} people (${POINTS_FOR_REWARD} points) and unlock:*\n` +
      `• A *${REWARD_DISCOUNT_PERCENT}% off* coupon code, sent to you instantly\n` +
      `• "Nexa Influencer" status — earn up to *50% commission* on every referral you bring in after that\n\n` +
      `💰 Your balance: *${user.points} points* (${user.referrals}/${REFERRALS_FOR_REWARD} referrals)\n\n` +
      `Commands:\n` +
      `/mylink – get your referral link again\n` +
      `/balance – check your progress\n` +
      `/leaderboard – see the top referrers\n` +
      `/help – how this works`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('mylink', async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const link = await ensureInviteLink(ctx, user);
  if (!link) return ctx.reply('⚠️ Could not fetch your link right now, try again shortly.');
  await ctx.reply(`🔗 Your referral link:\n${link}`);
});

bot.command('balance', async (ctx) => {
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
    msg += `\n${remaining} more referral${remaining === 1 ? '' : 's'} to unlock your *${REWARD_DISCOUNT_PERCENT}% off* coupon (${COUPON_CODE}) and Nexa Influencer status.`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('leaderboard', async (ctx) => {
  const top = Object.values(db.data.users)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  if (top.length === 0) return ctx.reply('No referrals yet — be the first!');

  const lines = top.map((u, i) => {
    const name = u.firstName || 'Anonymous';
    return `${i + 1}. ${name} — ${u.points} pts`;
  });

  await ctx.reply(`🏆 *Top Referrers*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

bot.help((ctx) =>
  ctx.reply(
    `*How the Nexa Referral Program works*\n\n` +
      `1. Run /start to get your unique invite link\n` +
      `2. Share it with friends\n` +
      `3. When they join t.me/${CHANNEL_USERNAME} through YOUR link, you get ${POINTS_PER_REFERRAL} points automatically\n` +
      `4. Refer ${REFERRALS_FOR_REWARD} people and you instantly get a *${REWARD_DISCOUNT_PERCENT}% off* coupon (${COUPON_CODE}) for ${PLANS_URL}\n` +
      `5. You also become a *Nexa Influencer*, earning up to 50% commission on every referral after that\n\n` +
      `Check /balance anytime to see your progress.`,
    { parse_mode: 'Markdown' }
  )
);

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
    return `• ${u.firstName || 'Unknown'} (${handle}) — ${u.referrals} referrals`;
  });

  await ctx.reply(
    `⭐ *Nexa Influencers* (for manual commission payout)\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});

// Escapes text for safe use inside Telegram HTML-parse-mode messages
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

bot.launch({
  allowedUpdates: ['message', 'chat_member', 'my_chat_member'],
}).then(() => {
  console.log('✅ Nexa Referral Bot is running.');
  console.log(`   Tracking channel: ${CHANNEL_ID} (@${CHANNEL_USERNAME})`);
  console.log(`   Points per referral: ${POINTS_PER_REFERRAL}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
