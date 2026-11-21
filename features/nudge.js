const ui = require('./ui');
const social = require('./social');
const { ctx } = require('./ctx');
const { peekConfig } = require('./guildConfig');

/* ---------------------------------------------------------------------------
 * The occasional "enjoying AniTracker?" reminder.
 *
 * After someone uses a command or a post button there's a small chance they
 * get a private card asking for a Top.gg review, with a one-tap way to send
 * feedback / report a bug. Built not to be annoying:
 *   • only a 5% chance per action
 *   • at most once every 14 days per person, and never in their first day
 *   • stops for good after 4 reminders, or the moment they review / tap
 *     "Don't remind me" (also a switch in /settings → Stats & reviews)
 *   • admins can turn it off for their whole server in /serversettings
 *
 * ids: nudge:fb · nudge:off · nudge:done
 * ------------------------------------------------------------------------- */

const TOPGG_URL = 'https://top.gg/bot/1534390550260748390';
const CHANCE = 0.05;
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_NUDGES = 4;
const SKIP_COMMANDS = new Set(['feedback', 'help', 'signin', 'signout', 'serversettings', 'settings']);

async function maybeNudge(interaction) {
  try {
    if (!interaction.guildId || !(interaction.replied || interaction.deferred)) return; // e.g. a form was opened instead
    if (interaction.isChatInputCommand?.() && SKIP_COMMANDS.has(interaction.commandName)) return;
    if (Math.random() >= CHANCE) return;
    const s = await ctx.loadSocial();
    if (!peekConfig(s, interaction.guildId).nudges) return;
    const existing = s.users[interaction.user.id];
    if (!existing) return; // brand-new people: let them settle in first
    const u = social.getUser(s, interaction.user.id);
    const p = u.prefs;
    if (p.nudge === 'off' || p.nudge === 'done' || (p.nudgeCount || 0) >= MAX_NUDGES) return;
    if (Date.now() - (p.lastNudgeAt || 0) < COOLDOWN_MS) return;
    if (u.createdAt && Date.now() - new Date(u.createdAt).getTime() < 24 * 60 * 60 * 1000) return;
    p.lastNudgeAt = Date.now();
    p.nudgeCount = (p.nudgeCount || 0) + 1;
    ctx.saveSocial();
    await interaction.followUp({ ...card(), flags: ui.V2 | ui.EPHEMERAL }).catch(() => {});
  } catch (e) {
    console.error('Nudge failed:', e.message);
  }
}

function card() {
  return ui.notice({
    accent: 0xffb703,
    label: '💛 a quick one',
    title: 'Enjoying AniTracker?',
    body: 'A review on **Top.gg** helps other servers find the bot — it takes 20 seconds. And if something’s broken or missing, tell me and I’ll build it.',
    thumbnail: ctx.client?.user?.displayAvatarURL?.({ size: 256, extension: 'png' }),
    buttons: [
      ui.linkButton(`${TOPGG_URL}#reviews`, 'Review on Top.gg', '⭐'),
      ui.button('nudge:fb', 'Ideas or bugs', { emoji: '💬' }),
      ui.button('nudge:off', 'Don’t remind me', { emoji: '🔕' }),
    ],
    footer: 'You’ll see this rarely · turn it off any time in /settings → Stats & reviews',
  });
}

async function onComponent(interaction) {
  const action = interaction.customId.split(':')[1];
  if (action === 'fb') {
    const feedback = require('../feedback');
    return interaction.showModal(feedback.buildFeedbackModal()).catch(() => {});
  }
  if (action === 'off' || action === 'done') {
    const s = await ctx.loadSocial();
    social.getUser(s, interaction.user.id).prefs.nudge = action;
    await ctx.saveSocial();
    return interaction
      .update(ui.notice({ accent: 0xffb703, label: 'Reminders', title: action === 'off' ? '🔕 Got it — no more reminders' : '💛 Thank you!', body: '-# Change this any time in `/settings` → **Stats & reviews**.' }))
      .catch(() => {});
  }
}

module.exports = { maybeNudge, onComponent, TOPGG_URL, card };
