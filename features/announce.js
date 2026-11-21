const { ChannelType, MessageFlags } = require('discord.js');
const ui = require('./ui');
const { ctx } = require('./ctx');
const { peekConfig } = require('./guildConfig');

/* ---------------------------------------------------------------------------
 * Announcement: one message to every server the bot is in (developer portal →
 * Announcement). Goes to the server's AniTracker channel (activity channel,
 * else recap channel), else its system channel, else the first channel the
 * bot can post in. Sent one server at a time in the background; the portal
 * polls status() for progress.
 * ------------------------------------------------------------------------- */

const ACCENT = 0x3db4f2;
const GAP_MS = 400; // between servers, well under Discord's rate limits

let job = { running: false, total: 0, done: 0, sent: 0, failed: [], skipped: [], startedAt: null, finishedAt: null, test: false };

function canPost(channel) {
  if (!channel || !channel.isTextBased?.() || channel.isThread?.() || channel.isVoiceBased?.()) return false;
  return !(ctx.missingChannelPerms ? ctx.missingChannelPerms(channel) : []).length;
}

async function channelFor(guild, core, s, { onlyConfigured = false } = {}) {
  const g = core.guilds?.[guild.id];
  const cfg = peekConfig(s, guild.id);
  for (const id of [g?.channelId, cfg.recapChannelId].filter(Boolean)) {
    const c = await ctx.client.channels.fetch(id).catch(() => null);
    if (canPost(c)) return { channel: c, how: 'AniTracker channel' };
  }
  if (onlyConfigured) return null;
  if (canPost(guild.systemChannel)) return { channel: guild.systemChannel, how: 'system channel' };
  const first = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText && canPost(c))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first();
  return first ? { channel: first, how: 'first open channel' } : null;
}

async function targets() {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const list = [];
  for (const guild of ctx.client.guilds.cache.values()) {
    const t = await channelFor(guild, core, s);
    list.push({ guildId: guild.id, name: guild.name, members: guild.memberCount ?? null, channel: t ? `#${t.channel.name}` : null, how: t?.how || null });
  }
  list.sort((a, b) => (b.members || 0) - (a.members || 0));
  return { total: list.length, reachable: list.filter((x) => x.channel).length, configured: list.filter((x) => x.how === 'AniTracker channel').length, servers: list };
}

function payloadFor({ title, message, imageUrl }) {
  const body = ui.softEsc(String(message).replace(/\\n/g, '\n')).replace(/@(everyone|here)/g, '@​$1');
  const p = ui.notice({
    accent: ACCENT,
    label: '📣 AniTracker announcement',
    title: title ? ui.esc(title) : null,
    body,
    banner: imageUrl || null,
    footer: 'From the AniTracker team · ideas or bugs? /feedback',
  });
  return { ...p, flags: ui.V2 | MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } };
}

function start({ title, message, imageUrl, onlyConfigured = false, testGuildId = null }) {
  const guilds = testGuildId ? [ctx.client.guilds.cache.get(testGuildId)].filter(Boolean) : [...ctx.client.guilds.cache.values()];
  job = { running: true, total: guilds.length, done: 0, sent: 0, failed: [], skipped: [], startedAt: new Date().toISOString(), finishedAt: null, test: Boolean(testGuildId) };
  const payload = payloadFor({ title, message, imageUrl });
  (async () => {
    const core = await ctx.loadData();
    const s = await ctx.loadSocial();
    for (const guild of guilds) {
      try {
        const t = await channelFor(guild, core, s, { onlyConfigured });
        if (!t) job.skipped.push({ guildId: guild.id, name: guild.name, reason: onlyConfigured ? 'no AniTracker channel' : 'no channel I can post in' });
        else {
          await t.channel.send(payload);
          job.sent++;
        }
      } catch (e) {
        job.failed.push({ guildId: guild.id, name: guild.name, reason: e.message.slice(0, 160) });
      }
      job.done++;
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    job.running = false;
    job.finishedAt = new Date().toISOString();
    console.log(`[announce] ${job.test ? 'TEST ' : ''}sent to ${job.sent}/${job.total} servers (${job.failed.length} failed, ${job.skipped.length} skipped)`);
  })().catch((e) => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    job.failed.push({ guildId: null, name: 'all', reason: e.message });
  });
  return { total: job.total, test: job.test };
}

const status = () => ({ ...job });

module.exports = { targets, start, status, payloadFor };
