require('dotenv').config();
const path = require('path');
const express = require('express');
const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const {
  loadData,
  saveData,
  flushData,
  isStorageHealthy,
  backend: storageBackend,
  loadSocial,
  saveSocial,
  loadStats,
  saveStats,
  migrateListsToSocial,
} = require('./storage');
const {
  getUserByName,
  getRecentActivities,
  getRecentFeed,
  getMediaTags,
  getMediaById,
  getUserFavorites,
  getMediaRelations,
  getMediaDetails,
} = require('./anilist');
const { getDominantColor, DEFAULT_COLOR } = require('./imageColor');
const { buildDashboardRouter } = require('./dashboard/routes');
const { buildOAuthRouter, signInUrlFor, isOAuthConfigured } = require('./oauth');
const { buildMoreInfo } = require('./moreInfo');
const feedback = require('./feedback');
const { commands: slashCommands } = require('./commands');
const { LATEST_UPDATE } = require('./changelog');
// Profiles, customisation, collections, reviews, stats (see features/)
const { setup: setupFeatures } = require('./features/ctx');
const ui = require('./features/ui');
const social = require('./features/social');
const statsEngine = require('./features/statsEngine');
const { paletteFor, buildBannerRouter } = require('./features/themes');
const socialCommands = require('./features/commandsSocial');
const profileFeature = require('./features/profile');
const settingsFeature = require('./features/settings');
const collectionsFeature = require('./features/collections');
const reviewsFeature = require('./features/reviews');
const statsUi = require('./features/statsUi');
const picker = require('./features/picker');
const animeFeature = require('./features/anime');
const { snapshot: mediaSnapshot } = require('./features/anilistSocial');
const feed = require('./features/feed');
const activityPost = require('./features/activityPost');
const { guildConfig, peekConfig } = require('./features/guildConfig');
const recaps = require('./features/recaps');
const nudge = require('./features/nudge');
const serverSettings = require('./features/serverSettings');
const ratings = require('./features/ratings');
const watched = require('./features/watched');

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_MINUTES, 10) || 3) * 60 * 1000;
const ANIME_ROLE_NAME = 'anime'; // server role (case-insensitive) pinged on relaunch
const RELAUNCH_NOTICE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // at most one "I restarted" ping per 12h
const MAX_RECENT_POSTS = 300; // per guild, for reaction/recommend lookups
const MAX_SEASON_HOPS = 6; // safety cap on how far back we walk a prequel chain
const MAX_FRANCHISE_HOPS = 12; // safety cap walking a sequel chain for "More Info"
const MAX_CACHE_ENTRIES = 1000;
const MEDIA_DETAILS_TTL_MS = 15 * 60 * 1000;
const REACTION_DM_DEDUPE_MS = 10 * 60 * 1000;
const EPHEMERAL = MessageFlags.Ephemeral;
const TV_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

// What the bot needs in its posting channel. Checked before posting and when
// a channel is chosen, so a missing permission gives a clear message instead
// of silent failures.
const REQUIRED_CHANNEL_PERMS = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
];
// What the invite link asks for (set the same set in the Developer Portal ->
// Installation -> Default Install Settings).
const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
]);

/* ---------------------------------------------------------------------------
 * Small bounded caches (the old season cache grew forever)
 * ------------------------------------------------------------------------- */
function boundedSet(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}
const seasonCache = new Map(); // mediaId -> { season, rootId, rootTitle, rootSiteUrl, popularityRank }
const franchiseCache = new Map(); // rootId -> [tv-ish media ids in order]
const mediaDetailsCache = new Map(); // mediaId -> { at, media }
const reactionDmSeen = new Map(); // `${msg}:${user}:${emoji}` -> timestamp
const warnedChannels = new Set();
// Last poll result per AniList account — shown by the server health check.
const feedHealth = new Map(); // anilistId -> { at, ok, error, latestId, latestAt, entries }
let pollRotation = 0;

// Polling can be paused from the dashboard. Backed by data.botPaused.
let isPaused = false;
let pollRunning = false;
// Result of the last slash-command sync — shown on /health so a failed
// registration is visible without digging through logs.
let commandSync = { ok: null, count: 0, error: null, at: null, clearedGuilds: 0 };
const botStartedAt = Date.now();

/* ---------------------------------------------------------------------------
 * Crash guards
 *
 * Unhandled promise rejections terminate Node by default — and Render then
 * restarts the bot. Several code paths (un-awaited interaction replies,
 * async Express routes, expired interactions) could produce one. These
 * handlers log the problem instead of taking the whole bot down.
 * ------------------------------------------------------------------------- */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User],
});

// An 'error' event with no listener is thrown as an exception by Node's
// EventEmitter — another way the bot used to crash on network blips.
setupFeatures({
  client,
  loadData,
  saveData,
  loadSocial,
  saveSocial,
  loadStats,
  saveStats,
  respond,
  signInUrlFor,
  isOAuthConfigured,
  setLiveActivity: (data, account, on, by) => setLiveActivity(data, account, on, by),
  applyRecommendVote: (...args) => applyRecommendVote(...args),
  buildActivityPreview: (...args) => buildActivityPreview(...args),
  buildMoreInfoPayload: (id, extra) => buildMoreInfoPayload(id, extra),
  toggleList: (interaction, mediaId, field) => handleListToggleButton(interaction, mediaId, field),
  feedHealth,
  missingChannelPerms: (channel) => missingChannelPerms(channel),
  trackInGuild: (...args) => trackInGuild(...args),
  getInviteUrl: () => getInviteUrl(),
});

client.on(Events.Error, (err) => console.error('[discord client error]', err.message));
client.on(Events.Warn, (msg) => console.warn('[discord warn]', msg));
client.on(Events.ShardDisconnect, (ev, id) => console.warn(`[discord] shard ${id} disconnected (${ev?.code}) — discord.js will reconnect`));
client.on(Events.ShardReconnecting, (id) => console.warn(`[discord] shard ${id} reconnecting…`));
client.on(Events.ShardResume, (id) => console.log(`[discord] shard ${id} resumed`));

/* ---------------------------------------------------------------------------
 * Web server: keep-alive, health, dashboard, AniList sign-in callback
 * ------------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.type('text/plain').send('AniTracker is running.');
});

// Lightweight JSON for UptimeRobot / debugging restarts.
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    discordReady: client.isReady(),
    storage: isStorageHealthy() ? 'ok' : 'unavailable',
    uptimeSeconds: Math.floor((Date.now() - botStartedAt) / 1000),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    commands: commandSync,
  });
});

app.use('/dashboard', express.static(path.join(__dirname, 'dashboard', 'public')));
app.use(
  '/dashboard/api',
  buildDashboardRouter(client, {
    loadData,
    saveData,
    getPaused: () => isPaused,
    setPaused: (val) => {
      isPaused = val;
    },
    botStartedAt,
    getInviteUrl,
    storageBackend,
    isStorageHealthy,
    loadSocial,
  })
);
app.use(buildOAuthRouter({ loadData, saveData, onLinked: (id, account, guildId) => sendLinkedConfirmation(id, account, guildId) }));
app.use(buildBannerRouter()); // generated profile banners (fetched + cached by Discord)

// Last-resort Express error handler — a thrown route must never crash the process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[express]', req.method, req.path, err.stack || err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(PORT, () => console.log(`Web server (keep-alive + dashboard) listening on port ${PORT}`));

/* ---------------------------------------------------------------------------
 * Boot / shutdown bookkeeping
 * ------------------------------------------------------------------------- */
let currentBoot = null;

async function recordBoot() {
  const data = await loadData();
  const previous = data.bootHistory[data.bootHistory.length - 1];
  if (previous && !previous.endedAt) {
    // The last run never reached our shutdown handler: it was killed hard —
    // usually Render's out-of-memory kill or a crash.
    previous.reason = 'unexpected (crash, out-of-memory, or hard kill)';
    console.warn('Previous run ended unexpectedly (no clean shutdown recorded). Check Render → Events/Logs around', previous.startedAt);
  }
  currentBoot = {
    startedAt: new Date(botStartedAt).toISOString(),
    endedAt: null,
    reason: null,
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
  };
  data.bootHistory.push(currentBoot);
  await saveData(data);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down cleanly…`);
  const hardExit = setTimeout(() => process.exit(0), 8000);
  hardExit.unref();
  try {
    if (currentBoot) {
      currentBoot.endedAt = new Date().toISOString();
      currentBoot.reason = signal === 'SIGTERM' ? 'clean stop (Render deploy/restart)' : `clean stop (${signal})`;
      saveData();
    }
    await flushData();
  } catch (e) {
    console.error('Error flushing data on shutdown:', e.message);
  }
  server.close();
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Memory watch: Render's free tier kills the process at 512 MB, which shows
// up as a "random" restart. Log usage, and shed caches if it gets high.
setInterval(() => {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMB > 380) {
    console.warn(`[memory] RSS ${rssMB} MB — clearing caches`);
    seasonCache.clear();
    franchiseCache.clear();
    mediaDetailsCache.clear();
  } else {
    console.log(`[memory] RSS ${rssMB} MB`);
  }
}, 15 * 60 * 1000).unref();

// Registers the global slash commands, then removes any old server-only
// copies (left over from running deploy-commands with GUILD_ID), which
// would otherwise shadow/duplicate the global ones in that server.
async function syncCommands() {
  commandSync = { ok: null, count: 0, error: null, at: new Date().toISOString(), clearedGuilds: 0 };
  try {
    const registered = await client.application.commands.set(slashCommands);
    commandSync.ok = true;
    commandSync.count = registered.size;
    console.log(`Registered ${registered.size} global slash commands: ${[...registered.values()].map((c) => c.name).join(', ')}`);
  } catch (e) {
    commandSync.ok = false;
    commandSync.error = `${e.code || ''} ${e.message}`.trim().slice(0, 500);
    console.error('Failed to register global slash commands:', e.rawError ? JSON.stringify(e.rawError) : e.message);
    return;
  }
  for (const guild of client.guilds.cache.values()) {
    try {
      const existing = await guild.commands.fetch();
      if (existing.size) {
        await guild.commands.set([]);
        commandSync.clearedGuilds += 1;
        console.log(`Cleared ${existing.size} stale server-only command(s) in ${guild.name}`);
      }
    } catch (e) {
      console.warn(`Couldn't check server commands in ${guild.name}:`, e.message);
    }
  }
}

function getInviteUrl() {
  const id = client.user?.id || process.env.CLIENT_ID;
  if (!id) return null;
  return `https://discord.com/oauth2/authorize?client_id=${id}&permissions=${INVITE_PERMISSIONS.bitfield}&integration_type=0&scope=bot+applications.commands`;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag} — in ${client.guilds.cache.size} server(s)`);
  console.log(`Invite link: ${getInviteUrl()}`);
  if (!isOAuthConfigured()) {
    console.warn('AniList sign-in is NOT configured (ANILIST_CLIENT_ID / ANILIST_CLIENT_SECRET / PUBLIC_URL). /signin will say so.');
  }
  // Keep Discord's global command list in sync with commands.js on every
  // start, so new/changed commands go live with a normal deploy.
  await syncCommands();

  const data = await loadData();
  isPaused = data.botPaused;
  if (isPaused) console.log('Polling starting in PAUSED state (resume from the dashboard to enable it).');
  pollAllGuilds();
  setInterval(pollAllGuilds, POLL_INTERVAL_MS);
  notifyRelaunch();
});

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

// Makes sure a guild's data object has every field newer features need.
function ensureGuildData(data, guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = { channelId: null, users: [], recommendations: {}, recentPosts: {} };
  }
  const guildData = data.guilds[guildId];
  if (!Array.isArray(guildData.users)) guildData.users = [];
  if (!guildData.recommendations) guildData.recommendations = {};
  if (!guildData.recentPosts) guildData.recentPosts = {};
  return guildData;
}

function isOptedOut(data, anilistId) {
  return Boolean(data.trackingOptOut[String(anilistId)]);
}

// The Discord user who "owns" a tracked profile: whoever signed in with that
// AniList account if anyone has, otherwise whoever ran /track.
function profileOwnerId(data, anilistId, fallbackDiscordId) {
  for (const [discordId, acct] of Object.entries(data.linkedAccounts)) {
    if (acct.anilistId === anilistId) return discordId;
  }
  return fallbackDiscordId || null;
}

function missingChannelPerms(channel) {
  if (!channel?.guild) return [];
  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms) return REQUIRED_CHANNEL_PERMS.map(([name]) => name);
  return REQUIRED_CHANNEL_PERMS.filter(([, flag]) => !perms.has(flag)).map(([name]) => name);
}

function prettyPerm(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// Replies (or edits a deferred reply) without ever throwing — an expired
// interaction must not be able to crash anything.
async function respond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      // Visibility is fixed when the reply/defer was created; editReply
      // doesn't accept the Ephemeral flag, so drop it here.
      const { flags, ...rest } = typeof payload === 'string' ? { content: payload } : payload;
      if (flags) {
        const keep = Number(flags) & ~Number(EPHEMERAL); // e.g. keep the Components V2 flag
        if (keep) rest.flags = keep;
      }
      return await interaction.editReply(rest);
    }
    return await interaction.reply(payload);
  } catch (e) {
    console.error(`Failed to respond to interaction (${interaction.customId || interaction.commandName || 'unknown'}):`, e.message);
    return null;
  }
}

async function safeDefer(interaction, ephemeral) {
  try {
    await interaction.deferReply(ephemeral ? { flags: EPHEMERAL } : {});
    return true;
  } catch (e) {
    console.error('Failed to defer interaction (likely expired):', e.message);
    return false;
  }
}

function titleOf(media) {
  return media?.title?.english || media?.title?.romaji || 'Unknown title';
}


async function findAnimeRole(guild) {
  try {
    const roles = await guild.roles.fetch();
    return roles.find((r) => r.name.toLowerCase() === ANIME_ROLE_NAME) || null;
  } catch (e) {
    console.error(`Failed to fetch roles for guild ${guild.id}:`, e.message);
    return null;
  }
}

// Pings the @Anime role once on startup — but at most once every 12 hours,
// so a burst of deploys/restarts doesn't spam every server.
async function notifyRelaunch() {
  const data = await loadData();
  if (Date.now() - data.lastRelaunchNoticeAt < RELAUNCH_NOTICE_COOLDOWN_MS) {
    console.log('Skipping relaunch notice (one was sent in the last 12h).');
    return;
  }
  data.lastRelaunchNoticeAt = Date.now();
  saveData(data);

  const soc = await loadSocial();
  for (const guildId of Object.keys(data.guilds)) {
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId) continue;
    const cfg = peekConfig(soc, guildId);
    if (!cfg.relaunchPing) continue;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
      if (!channel || missingChannelPerms(channel).length) continue;
      const animeRole = cfg.animeRoleId ? await guild.roles.fetch(cfg.animeRoleId).catch(() => null) : await findAnimeRole(guild);
      if (!animeRole) continue;
      await channel.send({
        content: `<@&${animeRole.id}> 🔄 AniTracker just restarted. If your activity feed looks stale, re-run \`/track\` for your profile.`,
        allowedMentions: { roles: [animeRole.id] },
      });
    } catch (e) {
      console.error(`Failed to send relaunch notice for guild ${guildId}:`, e.message);
    }
  }
}

/* ---------------------------------------------------------------------------
 * New servers: say hi with a quick start
 * ------------------------------------------------------------------------- */
client.on(Events.GuildCreate, async (guild) => {
  try {
    console.log(`Joined server: ${guild.name} (${guild.id})`);
    const channel = guild.systemChannel;
    if (!channel || missingChannelPerms(channel).length) return;
    const payload = ui.notice({
      label: '✦ AniTracker',
      title: 'Thanks for adding AniTracker!',
      thumbnail: client.user.displayAvatarURL({ size: 256, extension: 'png' }),
      body: [
        'I post AniList activity — episodes watched, chapters read, status changes — right here, plus weekly & monthly server recaps.',
        '',
        '**Quick start**',
        '`/serversettings` — admins: pick the channel, recaps, leaderboards and more',
        '`/track username:<AniList name>` — start posting someone’s activity',
        '`/signin` — link your own AniList (you’ll be tracked here automatically)',
        '`/profile` · `/settings` — your own customizable anime profile',
        '`/help` — everything else',
      ].join('\n'),
    });
    await channel.send(payload);
  } catch (e) {
    console.error('Failed to send welcome message:', e.message);
  }
});

/* ---------------------------------------------------------------------------
 * Interaction router
 * ------------------------------------------------------------------------- */
client.on(Events.InteractionCreate, (interaction) => dispatchInteraction(interaction));

async function dispatchInteraction(interaction) {
  try {
    if (interaction.isAutocomplete()) return await socialCommands.autocomplete(interaction);
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return await nudge.maybeNudge(interaction);
    }
    // Profile / settings / collections / reviews / stats components use "ns:..." ids.
    if ((interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) && interaction.customId.includes(':')) {
      return await routeFeatureInteraction(interaction);
    }
    if (interaction.isButton()) {
      await handleButton(interaction);
      return await nudge.maybeNudge(interaction);
    }
    if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
    else if (interaction.isModalSubmit()) await handleModalSubmit(interaction);
  } catch (err) {
    console.error('Unhandled error in interaction handler:', err);
    if (!interaction.isAutocomplete()) await respond(interaction, { content: 'Something went wrong. Try again in a bit.', flags: EPHEMERAL });
  }
}

async function routeFeatureInteraction(interaction) {
  const ns = interaction.customId.split(':')[0];
  if (interaction.guildId) {
    // remember which servers people use AniTracker in (for server leaderboards)
    const s = await loadSocial();
    if (s.users[interaction.user.id]) social.markGuild(s.users[interaction.user.id], interaction.guildId);
  }
  if (interaction.isModalSubmit()) {
    if (ns === 's') return settingsFeature.onModal(interaction);
    if (ns === 'c') return collectionsFeature.onModal(interaction);
    if (ns === 'rv') return reviewsFeature.onModal(interaction);
    if (ns === 'q') return picker.onModal(interaction);
    if (ns === 'sv') return serverSettings.onModal(interaction);
    if (ns === 'rt') return ratings.onModal(interaction);
    return;
  }
  switch (ns) {
    case 'nudge':
      return nudge.onComponent(interaction);
    case 'sv':
      return serverSettings.onComponent(interaction);
    case 'rx':
      return recaps.onComponent(interaction);
    case 'rt':
      return ratings.onComponent(interaction);
    case 'wt':
      return watched.onComponent(interaction);
    case 'p':
      return profileFeature.onComponent(interaction);
    case 's':
      return settingsFeature.onComponent(interaction);
    case 'c':
      return collectionsFeature.onComponent(interaction);
    case 'rv':
      return reviewsFeature.onComponent(interaction);
    case 'st':
    case 'rc':
    case 'lb':
      return statsUi.onComponent(interaction);
    case 'a':
      return animeFeature.onComponent(interaction);
    case 'q':
    case 'qs':
    case 'qx':
    case 'qr':
      return picker.onComponent(interaction);
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Reaction → private DM alerts
 * ------------------------------------------------------------------------- */
client.on(Events.MessageReactionAdd, async (reaction, reactingUser) => {
  try {
    if (reactingUser.partial) reactingUser = await reactingUser.fetch().catch(() => reactingUser);
    if (reactingUser.bot) return;
    if (reaction.partial) {
      const fetched = await reaction.fetch().catch(() => null);
      if (!fetched) return;
      reaction = fetched;
    }
    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    if (!message || !message.guild || message.author?.id !== client.user.id) return;

    const data = await loadData();
    const guildData = ensureGuildData(data, message.guild.id);
    const postInfo = guildData.recentPosts[message.id];
    if (!postInfo) return;

    const ownerId = profileOwnerId(data, postInfo.anilistId, postInfo.addedBy);
    if (!ownerId || reactingUser.id === ownerId) return; // no owner, or reacting to your own post

    const emojiStr = reaction.emoji.toString();

    // Toggling the same reaction on/off shouldn't spam DMs.
    const dedupeKey = `${message.id}:${reactingUser.id}:${reaction.emoji.id || reaction.emoji.name}`;
    const now = Date.now();
    if (now - (reactionDmSeen.get(dedupeKey) || 0) < REACTION_DM_DEDUPE_MS) return;
    reactionDmSeen.set(dedupeKey, now);
    if (reactionDmSeen.size > 2000) reactionDmSeen.delete(reactionDmSeen.keys().next().value);

    const cover = postInfo.cover || message.embeds[0]?.image?.url || null;
    const animeTitle = postInfo.animeTitle || 'your activity';
    const titleLink = postInfo.siteUrl ? `[${ui.esc(animeTitle)}](${postInfo.siteUrl})` : `**${ui.esc(animeTitle)}**`;
    const color = postInfo.color ?? message.embeds[0]?.color ?? DEFAULT_COLOR;
    const where = `-# 🏠 ${ui.esc(message.guild.name)} · <#${message.channelId}> · ${ui.relTime(Date.now())}`;
    const jump = ui.linkButton(message.url, 'Jump to post', '↗️');
    const who = reactingUser.displayName || reactingUser.username;

    const owner = await client.users.fetch(ownerId).catch(() => null);
    // DM to the profile owner: who reacted, to what, and where.
    if (owner) {
      await owner
        .send(ui.notice({ accent: color, label: `${emojiStr} new reaction`, title: `${ui.esc(who)} reacted ${emojiStr}`, body: `<@${reactingUser.id}> reacted to you watching ${titleLink}\n${where}`, thumbnail: cover, buttons: [jump] }))
        .catch((e) => console.error(`Failed to DM profile owner ${ownerId}:`, e.message));
    }
    // DM to the reactor: private confirmation the alert went out.
    await reactingUser
      .send(ui.notice({ accent: color, label: 'sent', title: `✅ Alert sent`, body: `<@${ownerId}> was told about your ${emojiStr} on ${titleLink}\n${where}`, thumbnail: cover, buttons: [jump] }))
      .catch((e) => console.error(`Failed to DM reactor ${reactingUser.id}:`, e.message));
  } catch (e) {
    console.error('Error handling reaction notification:', e.message);
  }
});

/* ---------------------------------------------------------------------------
 * Slash commands
 * ------------------------------------------------------------------------- */
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (!interaction.inGuild()) {
    await respond(interaction, { content: 'AniTracker commands only work inside a server.', flags: EPHEMERAL });
    return;
  }

  // Modals must be shown as the very first response — do it before anything else.
  if (commandName === 'feedback') {
    await handleFeedbackCommand(interaction);
    return;
  }

  // Remember which servers each person uses AniTracker in (server leaderboards,
  // "share my recap to a server"). Cheap: in-memory, batched save.
  loadSocial()
    .then((s) => {
      const u = social.getUser(s, interaction.user.id);
      const before = u.guilds.length;
      social.markGuild(u, interaction.guildId);
      if (u.guilds.length !== before) saveSocial();
    })
    .catch(() => {});

  if (commandName === 'serversettings') return serverSettings.handleCommand(interaction);

  // Profiles, settings, collections, reviews, stats, recaps, leaderboards.
  if (socialCommands.HANDLED.has(commandName)) {
    try {
      await socialCommands.handle(interaction);
    } catch (err) {
      console.error(`Error handling /${commandName}:`, err);
      await respond(interaction, { content: 'Something went wrong. Try again in a bit.', flags: EPHEMERAL });
    }
    return;
  }

  const data = await loadData(); // in-memory, instant
  const guildData = ensureGuildData(data, interaction.guildId);

  try {
    switch (commandName) {
      case 'track':
        return await handleTrack(interaction, data, guildData);
      case 'untrack':
        return await handleUntrack(interaction, data, guildData);
      case 'list':
        return await handleList(interaction, data, guildData);
      case 'whostracking':
        return await handleWhosTracking(interaction, data, guildData);
      case 'setchannel':
        return await handleSetChannel(interaction, data, guildData);
      case 'recommendanimes':
        return await handleRecommendAnimes(interaction, guildData, data);
      case 'favorites':
        return await handleFavorites(interaction);
      case 'signin':
        return await handleSignIn(interaction, data);
      case 'signout':
        return await handleSignOut(interaction, data);
      case 'tracking':
        return await handleTracking(interaction, data);
      case 'help':
        return await handleHelp(interaction);
      case 'update':
        return await handleUpdate(interaction, guildData);
      default:
        return await respond(interaction, { content: 'Unknown command — try `/help`.', flags: EPHEMERAL });
    }
  } catch (err) {
    console.error(`Error handling /${commandName}:`, err);
    await respond(interaction, { content: 'Something went wrong. Try again in a bit.', flags: EPHEMERAL });
  }
}

async function handleTrack(interaction, data, guildData) {
  const username = interaction.options.getString('username').trim();
  const soc = await loadSocial();
  const cfg = peekConfig(soc, interaction.guildId);
  const isManager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const ownLinked = data.linkedAccounts[interaction.user.id];
  const tracksSelf = ownLinked && ownLinked.anilistName?.toLowerCase() === username.toLowerCase();
  if (cfg.trackPerm === 'managers' && !isManager && !tracksSelf) {
    await respond(interaction, {
      ...ui.notice({ accent: 0xfb7185, label: 'Server setting', title: '🔒 Only managers can track profiles here', body: 'This server’s admins limited `/track` to people with **Manage Server**. You can still track **yourself**: `/signin`, then `/track` your own AniList name.' }),
      flags: ui.V2 | EPHEMERAL,
    });
    return;
  }
  if (!(await safeDefer(interaction, false))) return;

  const existing = guildData.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (existing) {
    await respond(interaction, { content: `Already tracking **${existing.username}** in this server.`, allowedMentions: { parse: [] } });
    return;
  }

  let user;
  try {
    user = await getUserByName(username);
  } catch (e) {
    console.error('AniList lookup failed in /track:', e.message);
    await respond(interaction, { content: '⚠️ AniList isn’t responding right now (this is on AniList’s side). Try again in a few minutes.' });
    return;
  }
  if (!user) {
    await respond(interaction, { content: `Couldn't find an AniList user named **${username}**.`, allowedMentions: { parse: [] } });
    return;
  }
  // The exact-name check above can miss (different casing typed); check by id too.
  if (guildData.users.some((u) => u.id === user.id)) {
    await respond(interaction, { content: `Already tracking **${user.name}** in this server.`, allowedMentions: { parse: [] } });
    return;
  }

  // Record the current latest activity id so we don't dump their whole history on first track.
  const activities = await getRecentActivities(user.id, 1).catch(() => []);
  const lastActivityId = activities.length ? activities[0].id : 0;

  guildData.users.push({
    username: user.name,
    id: user.id,
    lastActivityId,
    addedBy: interaction.user.id,
    avatar: user.avatar?.medium || null,
  });
  if (!guildData.channelId) guildData.channelId = interaction.channelId;
  await saveData(data);

  const lines = [`✅ Now tracking **[${user.name}](${user.siteUrl})**. New updates will post in <#${guildData.channelId}> and quietly ping <@${interaction.user.id}>.`];
  const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
  const missing = missingChannelPerms(channel);
  if (missing.length) {
    lines.push(`\n⚠️ I can't post in <#${guildData.channelId}> yet — I'm missing **${missing.map(prettyPerm).join(', ')}** there. Fix my permissions or use \`/setchannel\`.`);
  }
  if (isOptedOut(data, user.id)) {
    lines.push('\n⏸️ This profile’s owner has turned their live activity **off** (`/tracking`), so nothing will post until they turn it back on.');
  }
  await respond(interaction, { content: lines.join('\n'), allowedMentions: { parse: [] } });
}

async function handleUntrack(interaction, data, guildData) {
  const username = interaction.options.getString('username').trim();
  const entry = guildData.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!entry) {
    await respond(interaction, { content: `Wasn't tracking anyone named **${username}** here.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    return;
  }

  // Who may untrack: whoever started tracking it, the AniList account's real
  // (signed-in) owner, or a server manager.
  const linked = data.linkedAccounts[interaction.user.id];
  const allowed =
    entry.addedBy === interaction.user.id ||
    (linked && linked.anilistId === entry.id) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!allowed) {
    await respond(interaction, {
      content: `Only <@${entry.addedBy}> (who started tracking **${entry.username}**), the profile's owner, or someone with **Manage Server** can untrack it.`,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
    return;
  }

  guildData.users = guildData.users.filter((u) => u !== entry);
  await saveData(data);
  await respond(interaction, { content: `🗑️ Stopped tracking **${entry.username}**.`, allowedMentions: { parse: [] } });
}

function trackedLine(data, u, trackerLabel) {
  const paused = isOptedOut(data, u.id) ? ' ⏸️' : '';
  const streak = u.streak > 1 ? ` · 🔥 ${u.streak}` : '';
  return `• **[${u.username}](https://anilist.co/user/${encodeURIComponent(u.username)})**${paused}${streak}${trackerLabel ? ` — ${trackerLabel}` : ''}`;
}

async function handleList(interaction, data, guildData) {
  if (!guildData.users.length) {
    await respond(interaction, { content: 'Not tracking any AniList profiles yet. Use `/track username:<name>` to add one.' });
    return;
  }
  const lines = guildData.users.map((u) => trackedLine(data, u, u.addedBy ? `<@${u.addedBy}>` : null));
  // Mentions render as names but never ping.
  await respond(interaction, trackedCard(`📋 Tracked profiles · ${guildData.users.length}`, guildData, lines));
}

// Same info as /list, but with plain display names (no mentions at all).
async function handleWhosTracking(interaction, data, guildData) {
  if (!guildData.users.length) {
    await respond(interaction, { content: 'Not tracking any AniList profiles yet.' });
    return;
  }
  if (!(await safeDefer(interaction, false))) return;
  const lines = await Promise.all(
    guildData.users.map(async (u) => {
      let trackerName = 'unknown';
      if (u.addedBy) {
        const member = await interaction.guild.members.fetch(u.addedBy).catch(() => null);
        trackerName = member ? member.displayName : 'someone who left';
      }
      return trackedLine(data, u, `tracked by ${trackerName}`);
    })
  );
  await respond(interaction, trackedCard('📋 Who’s tracking what', guildData, lines));
}

function trackedCard(title, guildData, lines) {
  const chunks = [];
  let cur = '';
  for (const l of lines) {
    if ((cur + l).length > 1800) {
      chunks.push(cur);
      cur = '';
    }
    cur += `${l}\n`;
  }
  if (cur) chunks.push(cur);
  const children = [
    ui.text(`### ${title}\n-# ${guildData.channelId ? `Posting in <#${guildData.channelId}>` : 'No channel picked yet — `/serversettings`'}  ·  ⏸️ = owner turned live activity off`),
    ui.divider(),
    ...chunks.slice(0, 2).map((c) => ui.text(c.trim())),
  ];
  if (chunks.length > 2) children.push(ui.text(`-# …and ${lines.length - chunks.slice(0, 2).join('').split('\n').filter(Boolean).length} more`));
  return ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
}

async function handleSetChannel(interaction, data, guildData) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await respond(interaction, { content: 'You need the **Manage Server** permission to do that.', flags: EPHEMERAL });
    return;
  }
  const channel = interaction.options.getChannel('channel');
  if (!channel?.isTextBased?.() || channel.isVoiceBased?.()) {
    await respond(interaction, { content: 'Pick a regular text channel.', flags: EPHEMERAL });
    return;
  }
  const missing = missingChannelPerms(channel);
  if (missing.length) {
    await respond(interaction, {
      content: `⚠️ I can't post in <#${channel.id}> — I'm missing **${missing.map(prettyPerm).join(', ')}** there. Give me those in the channel's permissions and run this again.`,
      flags: EPHEMERAL,
    });
    return;
  }
  guildData.channelId = channel.id;
  await saveData(data);
  await respond(interaction, { content: `✅ AniList updates will now post in <#${channel.id}>.` });
}

/* ----- /recommendanimes ----- */
const RECOMMEND_EMBED_COLOR = 0xff9800;

function buildRecommendEntries(recsObj) {
  return Object.entries(recsObj || {})
    .filter(([, r]) => r.title && r.recommendedBy && r.recommendedBy.length > 0)
    .map(([mediaId, r]) => ({ mediaId, title: r.title, siteUrl: r.siteUrl, count: r.recommendedBy.length, by: r.recommendedBy }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// Who voted, as mentions (never pings). For the global board only people who
// voted from THIS server are named — other servers' members stay anonymous.
function votersLine(e, guildData, isGlobal) {
  const local = isGlobal ? (e.by || []).filter((id) => guildData.recommendations?.[e.mediaId]?.recommendedBy?.includes(id)) : e.by || [];
  if (!local.length) return isGlobal ? '-# nobody from this server yet' : '';
  const shown = local.slice(0, 6).map((id) => `<@${id}>`).join(' ');
  return `-# 💜 ${isGlobal ? 'from here: ' : ''}${shown}${local.length > 6 ? ` +${local.length - 6}` : ''}`;
}

function buildRecommendPayload(scope, guildData, data) {
  const isGlobal = scope === 'global';
  const entries = buildRecommendEntries(isGlobal ? data.globalRecommendations : guildData.recommendations);
  const scopeLabel = isGlobal ? '🌍 Global' : '🏠 This server';
  const children = [ui.text(`-# ✦ ANITRACKER · ${isGlobal ? 'EVERY SERVER' : 'THIS SERVER'}\n## ⭐ Most recommended anime`)];

  if (!entries.length) {
    children.push(ui.text(`*No recommendations ${isGlobal ? 'anywhere' : 'in this server'} yet — use \`/recommend\` to start the board!*`));
  } else {
    const totalVotes = entries.reduce((sum, e) => sum + e.count, 0);
    children.push(ui.text(`-# ${scopeLabel} · ${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'} across ${entries.length} title${entries.length === 1 ? '' : 's'} · one vote per person`));
    children.push(ui.divider());
    const medals = ['🥇', '🥈', '🥉'];
    const max = entries[0].count;
    entries.slice(0, 3).forEach((e, i) => {
      const cover = data.watchStats?.[e.mediaId]?.cover || null;
      children.push(ui.row([`${medals[i]} **[${ui.esc(ui.clip(e.title, 70))}](${e.siteUrl})**`, `\`${ui.bar(e.count, max, 12)}\`  **${e.count}** ${e.count === 1 ? 'vote' : 'votes'}`, votersLine(e, guildData, isGlobal) || null].filter(Boolean), cover));
    });
    if (entries.length > 3) {
      children.push(
        ui.text(
          entries
            .slice(3)
            .map((e, i) => `\`#${i + 4}\` [${ui.esc(ui.clip(e.title, 60))}](${e.siteUrl}) · **${e.count}**${votersLine(e, guildData, isGlobal) ? `\n${votersLine(e, guildData, isGlobal)}` : ''}`)
            .join('\n')
        )
      );
    }
  }
  children.push(ui.divider());
  if (entries.length) {
    children.push(
      ui.select(
        `recwho_${scope}`,
        '👥 See who voted for…',
        entries.map((e) => ({ label: ui.clip(e.title, 100), value: String(e.mediaId), description: `${e.count} ${e.count === 1 ? 'vote' : 'votes'}`, emoji: '💜' }))
      )
    );
  }
  children.push(buildRecommendScopeRow(scope));
  return ui.fit([ui.card(RECOMMEND_EMBED_COLOR, children)]);
}

// Everyone (from this server) who recommended one anime, with their messages.
async function buildVotersPayload(scope, guildData, data, mediaId) {
  const local = guildData.recommendations?.[mediaId] || {};
  const global = data.globalRecommendations?.[mediaId] || {};
  const rec = scope === 'global' ? global : local;
  const voters = local.recommendedBy || [];
  const soc = await loadSocial();
  const lines = voters.map((id) => {
    const note = soc.users[id]?.recommendations?.find((x) => String(x.mediaId) === String(mediaId))?.message;
    return `💜 <@${id}>${note ? `\n-# “${ui.softEsc(ui.clip(note, 120))}”` : ''}`;
  });
  const cover = data.watchStats?.[mediaId]?.cover || null;
  const others = (global.recommendedBy || []).filter((id) => !voters.includes(id)).length;
  const children = [
    ui.row(
      [
        '-# 💜 WHO RECOMMENDED IT',
        `## ${rec.siteUrl ? `[${ui.esc(ui.clip(rec.title || 'this anime', 80))}](${rec.siteUrl})` : ui.esc(rec.title || 'this anime')}`,
        `-# **${voters.length}** from this server${others ? ` · ${others} more in other servers` : ''}`,
      ],
      cover
    ),
    ui.divider(),
    ui.text(lines.length ? lines.join('\n').slice(0, 3500) : '*Nobody in this server has recommended it — only people in other servers.*'),
  ];
  return ui.fit([ui.card(RECOMMEND_EMBED_COLOR, children)]);
}

function buildRecommendScopeRow(scope) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('recscope')
    .setPlaceholder('Choose a scope to view')
    .addOptions(
      { label: 'This Server', description: 'Recommendations made in this server', value: 'guild', emoji: '🏠', default: scope !== 'global' },
      { label: 'Global', description: 'Recommendations from every server (one vote per person)', value: 'global', emoji: '🌍', default: scope === 'global' }
    );
  return new ActionRowBuilder().addComponents(menu);
}

async function handleRecommendAnimes(interaction, guildData, data) {
  await respond(interaction, buildRecommendPayload('guild', guildData, data));
}

async function handleSelectMenu(interaction) {
  if (interaction.customId.startsWith('recwho_') && interaction.guildId) {
    const data = await loadData();
    const guildData = ensureGuildData(data, interaction.guildId);
    const scope = interaction.customId.split('_')[1] === 'global' ? 'global' : 'guild';
    await respond(interaction, { ...(await buildVotersPayload(scope, guildData, data, interaction.values[0])), flags: ui.V2 | EPHEMERAL });
    return;
  }
  if (interaction.customId !== 'recscope' || !interaction.guildId) return;
  const data = await loadData();
  const guildData = ensureGuildData(data, interaction.guildId);
  const scope = interaction.values[0] === 'global' ? 'global' : 'guild';
  const payload = buildRecommendPayload(scope, guildData, data);

  // Only the person who ran the command switches the shared message; anyone
  // else gets their own private copy instead of changing it for everybody.
  const ownerId = interaction.message.interactionMetadata?.user?.id;
  if (ownerId && ownerId !== interaction.user.id) {
    await respond(interaction, { ...payload, flags: ui.V2 | EPHEMERAL });
    return;
  }
  try {
    // An old classic-embed board can't switch layouts in place: reply fresh.
    if (!interaction.message.flags?.has?.(MessageFlags.IsComponentsV2)) await interaction.reply({ ...payload, flags: ui.V2 | EPHEMERAL });
    else await interaction.update(payload);
  } catch (e) {
    console.error('Failed to update recommend scope:', e.message);
  }
}

async function handleFavorites(interaction) {
  const username = interaction.options.getString('username').trim();
  if (!(await safeDefer(interaction, false))) return;

  let user;
  try {
    user = await getUserFavorites(username);
  } catch (e) {
    await respond(interaction, { content: '⚠️ AniList isn’t responding right now (this is on AniList’s side). Try again in a few minutes.' });
    return;
  }
  if (!user) {
    await respond(interaction, { content: `Couldn't find an AniList user named **${username}**.`, allowedMentions: { parse: [] } });
    return;
  }

  const animeList = user.favourites?.anime?.nodes || [];
  const mangaList = user.favourites?.manga?.nodes || [];
  if (!animeList.length && !mangaList.length) {
    await respond(interaction, { content: `**${user.name}** hasn't favourited anything on AniList yet.`, allowedMentions: { parse: [] } });
    return;
  }
  const fmt = (list) => list.map((m, i) => `\`${String(i + 1).padStart(2, '0')}\` [${ui.esc(ui.clip(titleOf(m), 60))}](${m.siteUrl})`).join('\n');
  const children = [ui.row([`-# ANILIST FAVOURITES`, `## [${ui.esc(user.name)}](${user.siteUrl})`, `-# ${animeList.length} anime · ${mangaList.length} manga`], user.avatar?.medium)];
  const covers = ui.coverGallery(animeList.slice(0, 5).map((m) => ({ url: m.coverImage?.large, description: titleOf(m) })));
  if (covers) children.push(covers);
  if (animeList.length) children.push(ui.text(`${ui.label('📺 Anime')}\n${fmt(animeList)}`));
  if (mangaList.length) children.push(ui.text(`${ui.label('📖 Manga')}\n${fmt(mangaList)}`));
  await respond(interaction, ui.fit([ui.card(DEFAULT_COLOR, children)]));
}

/* ----- /signin, /signout ----- */
function trackHereButton(data, guildId, anilistId) {
  if (!guildId) return null;
  const g = data.guilds[guildId];
  if (!g?.channelId || (g.users || []).some((u) => u.id === anilistId)) return null;
  return ui.button('trk_here', 'Post my activity in this server', { emoji: '📡', style: ButtonStyle.Success });
}

async function handleSignIn(interaction, data) {
  if (!isOAuthConfigured()) {
    await respond(interaction, {
      content: '🔧 AniList sign-in isn’t switched on for this bot yet — the developer still needs to finish setting it up. Check back soon!',
      flags: EPHEMERAL,
    });
    return;
  }
  const linked = data.linkedAccounts[interaction.user.id];
  const signIn = ui.linkButton(signInUrlFor(interaction.user.id, interaction.guildId), linked ? 'Switch account' : 'Sign in with AniList', '🔐');
  let payload;
  if (linked) {
    payload = ui.notice({
      label: 'AniList account',
      title: `🔐 You’re signed in as [${ui.esc(linked.anilistName)}](${linked.siteUrl})`,
      body: 'Want a different account? Sign in again with it below — or use `/signout` to unlink.',
      thumbnail: linked.avatar,
      buttons: [signIn, trackHereButton(data, interaction.guildId, linked.anilistId)],
      footer: 'Only you can see this',
    });
  } else {
    payload = ui.notice({
      label: 'AniList account',
      title: '🔐 Sign in with AniList',
      body: [
        'Linking proves which AniList profile is yours, so **only you** control it — like turning your live activity on/off with `/tracking`.',
        '',
        '• AniTracker only reads your **username and avatar**',
        '• It never posts, edits or changes anything on your AniList',
        '• You’ll be tracked in this server automatically (if its admins allow it)',
        '• The link is personal and expires in 15 minutes — don’t share it',
      ].join('\n'),
      buttons: [signIn],
      footer: 'Only you can see this',
    });
  }
  await respond(interaction, { ...payload, flags: ui.V2 | EPHEMERAL });
}

async function handleSignOut(interaction, data) {
  const linked = data.linkedAccounts[interaction.user.id];
  if (!linked) {
    await respond(interaction, { content: 'You’re not signed in. Use `/signin` to link your AniList account.', flags: EPHEMERAL });
    return;
  }
  delete data.linkedAccounts[interaction.user.id];
  await saveData(data);
  const stillOff = isOptedOut(data, linked.anilistId);
  await respond(interaction, {
    content: `👋 Unlinked **${linked.anilistName}** from your Discord account.${
      stillOff ? '\nYour live activity stays **off** — sign in again any time to turn it back on.' : ''
    }`,
    flags: EPHEMERAL,
  });
}

// Adds an AniList account to a server's tracked list (no backlog dump).
async function trackInGuild(data, guildId, account, addedBy) {
  const guildData = ensureGuildData(data, guildId);
  if (guildData.users.some((u) => u.id === account.anilistId)) return { ok: false, reason: 'exists' };
  const latest = await getRecentActivities(account.anilistId, 1).catch(() => []);
  guildData.users.push({
    username: account.anilistName,
    id: account.anilistId,
    lastActivityId: latest[0]?.id || 0,
    addedBy,
    avatar: account.avatar || null,
    autoTracked: true,
  });
  await saveData(data);
  return { ok: true, channelId: guildData.channelId };
}

async function sendLinkedConfirmation(discordUserId, account, guildId) {
  const user = await client.users.fetch(discordUserId).catch(() => null);
  let trackedLine = '';
  // Signing in from a server tracks you there too (unless its admins turned that off).
  if (guildId && client.guilds.cache.has(guildId)) {
    const data = await loadData();
    const soc = await loadSocial();
    const g = data.guilds[guildId];
    if (g?.channelId && peekConfig(soc, guildId).autoTrack) {
      const res = await trackInGuild(data, guildId, account, discordUserId).catch(() => ({ ok: false }));
      if (res.ok) trackedLine = `\n\n📡 Your activity will now post in <#${res.channelId}> (**${ui.esc(client.guilds.cache.get(guildId)?.name || 'the server')}**).`;
    }
  }
  if (!user) return;
  await user
    .send(
      ui.notice({
        label: 'AniList linked',
        title: `✅ Linked to [${ui.esc(account.anilistName)}](${account.siteUrl})`,
        body: `Use \`/tracking\` in any server to turn your live activity posts on or off.${trackedLine}`,
        thumbnail: account.avatar,
      })
    )
    .catch(() => {});
}

/* ----- /tracking (live activity on/off, owner only) ----- */
function trackedInGuilds(data, anilistId) {
  const names = [];
  for (const [guildId, g] of Object.entries(data.guilds)) {
    if ((g.users || []).some((u) => u.id === anilistId)) names.push(client.guilds.cache.get(guildId)?.name || 'a server');
  }
  return names;
}

function buildTrackingPanel(data, account, guildId) {
  const off = isOptedOut(data, account.anilistId);
  const servers = trackedInGuilds(data, account.anilistId);
  const serverLine = servers.length
    ? `Tracked in **${servers.length}** server${servers.length === 1 ? '' : 's'}: ${servers.slice(0, 10).map((n) => ui.esc(n)).join(', ')}${servers.length > 10 ? '…' : ''}`
    : 'Nobody is tracking your profile right now.';
  const here = guildId ? data.guilds[guildId] : null;
  const trackedHere = here && (here.users || []).some((u) => u.id === account.anilistId);
  const hereLine = !guildId
    ? null
    : !here?.channelId
      ? '-# This server hasn’t picked an activity channel yet (admins: `/serversettings`).'
      : trackedHere
        ? `-# ✅ Tracked here · posts go to <#${here.channelId}>`
        : '-# ⚠️ You’re **not tracked in this server** yet — that’s why nothing posts here.';
  return ui.notice({
    accent: off ? 0xfb7185 : 0x34d399,
    label: `Live activity · ${account.anilistName}`,
    title: off ? '🔴 Live activity is OFF' : '🟢 Live activity is ON',
    thumbnail: account.avatar,
    body: [
      off
        ? 'Your AniList updates are **not** posted anywhere (your stats and streak still update privately). Turning it back on starts from your *next* update — nothing you did while it was off gets posted.'
        : 'Your AniList updates are posted in every server tracking you.',
      '',
      serverLine,
      hereLine,
    ]
      .filter((x) => x !== null)
      .join('\n'),
    buttons: [
      off ? ui.button('trk_on', 'Turn on', { emoji: '🟢', style: ButtonStyle.Success }) : ui.button('trk_off', 'Turn off', { emoji: '🔴', style: ButtonStyle.Danger }),
      trackHereButton(data, guildId, account.anilistId),
    ],
    footer: 'Only you can change this — it applies everywhere',
  });
}

async function setLiveActivity(data, account, on, byUserId) {
  const key = String(account.anilistId);
  if (on) {
    if (!data.trackingOptOut[key]) return;
    delete data.trackingOptOut[key];
    // Skip anything they did while it was off: fast-forward every tracked
    // entry for this profile to their latest activity.
    const latest = await getRecentActivities(account.anilistId, 1).catch(() => []);
    const latestId = latest[0]?.id;
    if (latestId) {
      for (const g of Object.values(data.guilds)) {
        for (const u of g.users || []) if (u.id === account.anilistId) u.lastActivityId = Math.max(u.lastActivityId || 0, latestId);
      }
    }
  } else {
    data.trackingOptOut[key] = { since: new Date().toISOString(), by: byUserId };
  }
  await saveData(data);
}

async function handleTracking(interaction, data) {
  const account = data.linkedAccounts[interaction.user.id];
  if (!account) {
    await respond(interaction, {
      ...ui.notice({
        label: 'Live activity',
        title: '🔐 Sign in first',
        body: 'To make sure only the **real owner** of an AniList profile can turn its live activity on or off, link your AniList account first with `/signin` — then run `/tracking` again.',
        buttons: isOAuthConfigured() ? [ui.linkButton(signInUrlFor(interaction.user.id, interaction.guildId), 'Sign in with AniList', '🔐')] : [],
      }),
      flags: ui.V2 | EPHEMERAL,
    });
    return;
  }

  const status = interaction.options.getString('status');
  if (status === 'on' || status === 'off') {
    if (!(await safeDefer(interaction, true))) return;
    await setLiveActivity(data, account, status === 'on', interaction.user.id);
  }
  await respond(interaction, { ...buildTrackingPanel(data, account, interaction.guildId), flags: ui.V2 | EPHEMERAL });
}

async function handleTrackingButton(interaction, on) {
  const data = await loadData();
  const account = data.linkedAccounts[interaction.user.id];
  if (!account) {
    await respond(interaction, { content: 'You need to `/signin` first.', flags: EPHEMERAL });
    return;
  }
  try {
    await interaction.deferUpdate();
  } catch {
    return;
  }
  await setLiveActivity(data, account, on, interaction.user.id);
  await interaction.editReply(buildTrackingPanel(data, account, interaction.guildId)).catch((e) => console.error('Failed to refresh tracking panel:', e.message));
}

// "Post my activity in this server" (from /signin and /tracking).
async function handleTrackHereButton(interaction) {
  const data = await loadData();
  const account = data.linkedAccounts[interaction.user.id];
  if (!account || !interaction.guildId) return respond(interaction, { content: 'Sign in with `/signin` first.', flags: EPHEMERAL });
  try {
    await interaction.deferUpdate();
  } catch {
    return;
  }
  const res = await trackInGuild(data, interaction.guildId, account, interaction.user.id);
  const note = res.ok ? `✅ Done — your next AniList update posts in <#${res.channelId}>.` : 'You’re already tracked here.';
  await interaction.editReply(buildTrackingPanel(data, account, interaction.guildId)).catch(() => {});
  await interaction.followUp({ content: note, flags: EPHEMERAL }).catch(() => {});
}

/* ----- /help ----- */
async function handleHelp(interaction) {
  const sections = [
    ['📡 Tracking', ['`/track` — post someone’s AniList activity here', '`/untrack` — stop tracking a profile', '`/list` · `/whostracking` — who’s tracked in this server', '`/serversettings` — channel, recaps, boards & more *(admins)*']],
    ['🪪 Your profile', ['`/profile` — your anime page (or `/profile user:@someone`)', '`/settings` — theme, banner, showcase, activity style, privacy', '`/signin` · `/signout` — link your AniList · `/tracking` — posts on/off']],
    [
      '📚 Lists & reviews',
      ['`/anime info · search · trending · random · airing` — look anything up', '`/watchlater` · `/myfavorites` · `/rotation` — view, add, remove', '`/collection` — custom lists like “Comfort Anime”', '`/recommend` — recommend an anime with a message', '`/review write · read · browse` — write and discover reviews', '`/favorites` — anyone’s AniList favourites'],
    ],
    ['⭐ Ratings & search', ['`/rate` — score any anime 1-10 · `/ratings` — server top rated, someone’s page, or one anime', '`/watched` — who here watched an anime, what someone watched, or search the server’s history']],
    ['📊 Stats & community', ['`/stats` — month, lifetime, streaks · `/recap` — monthly recap', '`/leaderboard` — server boards · `/recommendanimes` — most recommended (and who voted)', '-# Weekly + monthly server recaps post automatically; your personal recap arrives by DM on the 1st']],
    ['💬 Other', ['`/feedback` — rate AniTracker & tell the developer anything', '`/update` — post an update notice silently *(Manage Server)*']],
    ['🔘 On activity posts', ['🤍 Like · ⭐ Rate · ✍️ Review · 🗂️ Save to a list · 📊 More info — replies only you can see', 'React to a post and its owner gets a private DM']],
  ];
  const children = [ui.row(['-# ✦ ANITRACKER', '## Commands & buttons', '-# Everything AniTracker can do'], client.user.displayAvatarURL({ size: 256, extension: 'png' }))];
  for (const [title, lines] of sections) {
    children.push(ui.divider());
    children.push(ui.text(`**${title}**\n${lines.join('\n')}`));
  }
  const invite = getInviteUrl();
  const links = [invite ? ui.linkButton(invite, 'Add to a server', '➕') : null, ui.linkButton(nudge.TOPGG_URL, 'Review on Top.gg', '⭐')];
  children.push(ui.divider());
  children.push(ui.actionRow(links));
  await respond(interaction, { ...ui.fit([ui.card(DEFAULT_COLOR, children)]), flags: ui.V2 | EPHEMERAL });
}

/* ----- /update (silent announcement in this server) ----- */
async function handleUpdate(interaction, guildData) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await respond(interaction, { content: 'You need the **Manage Server** permission to do that.', flags: EPHEMERAL });
    return;
  }
  const custom = interaction.options.getString('message')?.trim();
  const picked = interaction.options.getChannel('channel');
  const channel =
    picked ||
    (guildData.channelId ? await client.channels.fetch(guildData.channelId).catch(() => null) : null) ||
    interaction.channel;
  if (!channel?.isTextBased?.()) {
    await respond(interaction, { content: 'Pick a text channel to post in.', flags: EPHEMERAL });
    return;
  }
  const missing = missingChannelPerms(channel);
  if (missing.length) {
    await respond(interaction, { content: `I can't post in <#${channel.id}> — missing **${missing.map(prettyPerm).join(', ')}**.`, flags: EPHEMERAL });
    return;
  }

  const avatar = client.user.displayAvatarURL({ size: 256, extension: 'png' });
  const payload = custom
    ? ui.notice({ label: 'AniTracker update', title: null, body: ui.softEsc(custom.replace(/\\n/g, '\n')), thumbnail: avatar, footer: `Posted by ${ui.esc(interaction.member?.displayName || interaction.user.username)}` })
    : ui.notice({ label: 'What’s new', title: LATEST_UPDATE.title, body: LATEST_UPDATE.items.map((i) => `• ${i}`).join('\n'), thumbnail: avatar, footer: LATEST_UPDATE.footer });

  try {
    // @silent: shows normally, but no push notification or sound for anyone.
    await channel.send({ ...payload, flags: ui.V2 | MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } });
  } catch (e) {
    await respond(interaction, { content: `Couldn't post: ${e.message}`, flags: EPHEMERAL });
    return;
  }
  await respond(interaction, { content: `🔕 Posted ${custom ? 'your update' : 'the latest changelog'} silently in <#${channel.id}>.`, flags: EPHEMERAL });
}

/* ----- /feedback ----- */
async function handleFeedbackCommand(interaction) {
  const data = await loadData();
  const last = data.feedback.find((f) => f.userId === interaction.user.id);
  if (last && Date.now() - new Date(last.createdAt).getTime() < feedback.COOLDOWN_MS) {
    await respond(interaction, { content: '⏳ You just sent feedback — give it a minute before sending more.', flags: EPHEMERAL });
    return;
  }
  try {
    await interaction.showModal(feedback.buildFeedbackModal());
  } catch (e) {
    console.error('Failed to show feedback modal:', e.message);
    await respond(interaction, { content: 'Couldn’t open the feedback form — please try again.', flags: EPHEMERAL });
  }
}

async function handleModalSubmit(interaction) {
  if (interaction.customId !== feedback.MODAL_ID) return;
  const submission = feedback.readFeedbackSubmission(interaction);
  if (!submission) {
    await respond(interaction, { content: 'Please fill in the rating, title and message.', flags: EPHEMERAL });
    return;
  }
  const data = await loadData();
  const entry = {
    id: `cmd-${interaction.id}`,
    source: 'discord',
    ...submission,
    userId: interaction.user.id,
    userName: interaction.user.username,
    userAvatar: interaction.user.displayAvatarURL({ size: 64 }),
    guildId: interaction.guildId || null,
    guildName: interaction.guild?.name || null,
    createdAt: new Date().toISOString(),
  };
  data.feedback.unshift(entry);
  await saveData(data);
  console.log(`New feedback (${submission.rating}/5) from ${interaction.user.username}: ${submission.title}`);
  await respond(interaction, { ...feedback.buildThanksCard(entry), flags: ui.V2 | EPHEMERAL });
}

/* ---------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------- */
async function handleButton(interaction) {
  const { customId } = interaction;
  if (customId === 'trk_on' || customId === 'trk_off') return handleTrackingButton(interaction, customId === 'trk_on');
  if (customId === 'trk_here') return handleTrackHereButton(interaction);

  if (!interaction.guildId) return;
  const [action, idStr] = customId.split('_');
  const mediaId = parseInt(idStr, 10);
  if (!mediaId || !['wl', 'rec', 'fav', 'info', 'like', 'rvw', 'col', 'rate'].includes(action)) return;

  // Forms must be the very first response (no defer before a modal).
  if (action === 'rate') {
    const data = await loadData();
    const post = data.guilds[interaction.guildId]?.recentPosts?.[interaction.message?.id];
    return ratings.openRateForm(interaction, mediaId, post?.mediaTitle || post?.animeTitle);
  }
  if (action === 'rvw') {
    const data = await loadData();
    const post = data.guilds[interaction.guildId]?.recentPosts?.[interaction.message?.id];
    const knownTitle = post?.mediaTitle || post?.animeTitle || interaction.message?.embeds?.[0]?.description?.match(/^# \[(.+?)\]\(/m)?.[1];
    return reviewsFeature.openWriteForm(interaction, mediaId, knownTitle);
  }

  // Ack Discord's 3s window first. If that fails the interaction is gone.
  if (!(await safeDefer(interaction, true))) return;

  const data = await loadData();
  const guildData = ensureGuildData(data, interaction.guildId);

  try {
    if (action === 'wl') await handleListToggleButton(interaction, mediaId, 'watchlist');
    else if (action === 'fav') await handleListToggleButton(interaction, mediaId, 'favorites');
    else if (action === 'rec') await handleRecommendButton(interaction, data, guildData, mediaId);
    else if (action === 'info') await handleMoreInfoButton(interaction, mediaId);
    else if (action === 'like') await handleLikeButton(interaction, data, guildData, mediaId);
    else if (action === 'col') {
      const media = await getMediaById(mediaId).catch(() => null);
      if (!media) return respond(interaction, { content: '⚠️ AniList isn’t responding right now (their side). Try again in a bit.' });
      const s = await loadSocial();
      await respond(interaction, collectionsFeature.saveToPayload(social.getUser(s, interaction.user.id), media));
    }
  } catch (err) {
    console.error(`Error handling button ${customId}:`, err);
    await respond(interaction, { content: 'Something went wrong. Try again in a bit.' });
  }
}

// Small private confirmation card with the cover, used by the post buttons.
function confirmCard(media, heading, sub, buttons = []) {
  const snap = mediaSnapshot(media);
  return ui.fit([ui.card(ui.ANILIST_BLUE, [ui.row([`-# ${heading}`, `### ${ui.esc(snap.title)}`, sub], snap.cover), ui.actionRow(buttons)].filter(Boolean))]);
}

// Watch later + Favorite: one list per person (stored with their profile).
async function handleListToggleButton(interaction, mediaId, field) {
  const s = await loadSocial();
  const u = social.getUser(s, interaction.user.id);
  social.markGuild(u, interaction.guildId);
  const list = u[field];
  const isWatch = field === 'watchlist';
  const media = await getMediaById(mediaId).catch(() => null);
  const existing = list.find((e) => e.mediaId === mediaId);

  if (existing) {
    social.removeItem(list, mediaId);
    await saveSocial();
    const fallback = { id: mediaId, title: { english: existing.title }, siteUrl: existing.siteUrl, coverImage: { large: existing.cover } };
    await respond(
      interaction,
      confirmCard(media || fallback, isWatch ? '📌 REMOVED FROM WATCH LATER' : '⭐ REMOVED FROM FAVORITES', `-# ${list.length} left`, [
        ui.button(`col_${mediaId}`, 'Save to other lists', { emoji: '🗂️' }),
      ])
    );
    return;
  }

  if (!media) {
    await respond(interaction, { content: "⚠️ Couldn't reach AniList to save that (AniList-side hiccup). Try again in a bit." });
    return;
  }
  const res = social.addItem(list, mediaSnapshot(media), field);
  if (!res.ok) {
    await respond(interaction, { content: `Your ${isWatch ? 'Watch Later' : 'Favorites'} list is full — make room with \`/${isWatch ? 'watchlater' : 'myfavorites'}\`.` });
    return;
  }
  await saveSocial();
  await respond(
    interaction,
    confirmCard(media, isWatch ? '📌 ADDED TO WATCH LATER' : '⭐ ADDED TO FAVORITES', `-# #${list.length} on your list · tap the button again on the post to remove`, [
      ui.button(`c:v:me:${field}:1:${Math.floor((list.length - 1) / collectionsFeature.PAGE)}`, isWatch ? 'Open Watch Later' : 'Open Favorites', { emoji: isWatch ? '📌' : '⭐' }),
      ui.button(`col_${mediaId}`, 'More lists', { emoji: '🗂️' }),
    ])
  );
}

// Adds/removes one person's recommend vote in this server's + the global tally.
async function applyRecommendVote(guildId, userId, media, add) {
  const data = await loadData();
  const mediaId = media.id;
  const title = titleOf(media);
  if (guildId) {
    const guildData = ensureGuildData(data, guildId);
    const rec = (guildData.recommendations[mediaId] ||= { title: null, siteUrl: null, recommendedBy: [] });
    rec.title = title;
    rec.siteUrl = media.siteUrl;
    if (add && !rec.recommendedBy.includes(userId)) rec.recommendedBy.push(userId);
    if (!add) rec.recommendedBy = rec.recommendedBy.filter((id) => id !== userId);
  }
  const globalRec = (data.globalRecommendations[mediaId] ||= { title, siteUrl: media.siteUrl, recommendedBy: [] });
  globalRec.title = title;
  globalRec.siteUrl = media.siteUrl;
  if (add && !globalRec.recommendedBy.includes(userId)) globalRec.recommendedBy.push(userId);
  if (!add) {
    const stillElsewhere = Object.values(data.guilds).some((g) => g.recommendations?.[mediaId]?.recommendedBy?.includes(userId));
    if (!stillElsewhere) globalRec.recommendedBy = globalRec.recommendedBy.filter((id) => id !== userId);
  }
  await saveData(data);
}

// Updates the counts on a post after a Like (or an old Recommend) click.
// Modern posts only get their Like label rewritten; classic embed posts
// (from before the layout change) switch to the new, slimmer button row.
async function refreshPostButtons(interaction, guildData, rootId) {
  try {
    const msg = interaction.message;
    const likeCount = guildData.recentPosts[msg.id]?.likes?.length || 0;
    const json = (msg.components || []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));
    if (msg.flags?.has?.(MessageFlags.IsComponentsV2)) {
      await msg.edit({ components: activityPost.withLikeCount(json, likeCount) });
      return;
    }
    const infoId = activityPost.findButtonId(json, 'info') || rootId;
    const editPayload = { components: [postRow(rootId, infoId, likeCount)] };
    const recCount = guildData.recommendations[rootId]?.recommendedBy?.length || 0;
    const existingEmbed = msg.embeds[0];
    if (existingEmbed) editPayload.embeds = [EmbedBuilder.from(existingEmbed).setFooter({ text: buildFooterText(recCount) })];
    await msg.edit(editPayload);
  } catch (e) {
    console.error('Failed to refresh post buttons:', e.message);
  }
}

async function handleRecommendButton(interaction, data, guildData, mediaId) {
  const userId = interaction.user.id;
  const alreadyRecommended = Boolean(guildData.recommendations[mediaId]?.recommendedBy?.includes(userId));
  const media = await getMediaById(mediaId).catch(() => null);
  const fallback = { id: mediaId, title: { english: guildData.recommendations[mediaId]?.title || 'this anime' }, siteUrl: guildData.recommendations[mediaId]?.siteUrl || `https://anilist.co/anime/${mediaId}` };
  await applyRecommendVote(interaction.guildId, userId, media || fallback, !alreadyRecommended);

  // Mirror it in the person's own Recommendations list (shown on their profile).
  const s = await loadSocial();
  const u = social.getUser(s, userId);
  social.markGuild(u, interaction.guildId);
  if (alreadyRecommended) social.removeItem(u.recommendations, mediaId);
  else if (media) social.addItem(u.recommendations, mediaSnapshot(media), 'recommendations');
  await saveSocial();

  await refreshPostButtons(interaction, guildData, mediaId);

  // DM the post's owner on a fresh recommend (not a removal).
  const rec = guildData.recommendations[mediaId] || {};
  if (!alreadyRecommended) {
    const postInfo = guildData.recentPosts[interaction.message.id];
    const ownerId = postInfo ? profileOwnerId(data, postInfo.anilistId, postInfo.addedBy) : null;
    if (ownerId && ownerId !== userId) {
      const owner = await client.users.fetch(ownerId).catch(() => null);
      if (owner) {
        const animeName = rec.title || postInfo.animeTitle || 'an anime';
        const cover = postInfo?.cover || interaction.message.embeds[0]?.image?.url || interaction.message.embeds[0]?.thumbnail?.url;
        await owner
          .send(
            ui.notice({
              accent: postInfo?.color ?? interaction.message.embeds[0]?.color ?? RECOMMEND_EMBED_COLOR,
              label: '💜 New recommendation',
              title: `${ui.esc(interaction.user.displayName || interaction.user.username)} recommended it`,
              body: `<@${userId}> recommended **${rec.siteUrl ? `[${ui.esc(animeName)}](${rec.siteUrl})` : ui.esc(animeName)}** that you were watching!\n-# 🏠 ${ui.esc(interaction.guild.name)}`,
              thumbnail: cover,
              buttons: [ui.linkButton(interaction.message.url, 'Jump to post', '↗️')],
            })
          )
          .catch((e) => console.error('Failed to DM recommend notification:', e.message));
      }
    }
  }

  if (alreadyRecommended) {
    await respond(interaction, confirmCard(media || fallback, '💜 RECOMMENDATION REMOVED', '-# Removed from your profile’s recommendations too'));
    return;
  }
  await respond(
    interaction,
    confirmCard(media || fallback, '💜 YOU RECOMMENDED', '-# It’s on your profile now — add a message so people know why', [
      ui.button(`c:note:recommendations:${mediaId}`, 'Add a message', { emoji: '✏️', style: ui.ButtonStyle.Primary }),
      ui.button(`p:t:${userId}:recs:0`, 'My recommendations', { emoji: '💜' }),
    ])
  );
}

// ❤️ Like on an activity post: count on the button + a quiet DM to the owner.
async function handleLikeButton(interaction, data, guildData, rootId) {
  const userId = interaction.user.id;
  const post = (guildData.recentPosts[interaction.message.id] ||= { addedBy: null, anilistId: null, animeTitle: null });
  post.likes = post.likes || [];
  const had = post.likes.includes(userId);
  post.likes = had ? post.likes.filter((x) => x !== userId) : [...post.likes, userId];
  await saveData(data);
  await refreshPostButtons(interaction, guildData, rootId);
  await respond(interaction, { content: had ? '🤍 Unliked.' : '❤️ Liked! They’ll get a quiet DM.' });

  const ownerId = profileOwnerId(data, post.anilistId, post.addedBy);
  if (had || !ownerId || ownerId === userId) return;
  const key = `like:${interaction.message.id}:${userId}`;
  if (Date.now() - (reactionDmSeen.get(key) || 0) < REACTION_DM_DEDUPE_MS) return;
  reactionDmSeen.set(key, Date.now());
  const owner = await client.users.fetch(ownerId).catch(() => null);
  if (!owner) return;
  const cover = post.cover || interaction.message.embeds[0]?.image?.url || interaction.message.embeds[0]?.thumbnail?.url;
  await owner
    .send(
      ui.notice({
        accent: post.color ?? interaction.message.embeds[0]?.color ?? DEFAULT_COLOR,
        label: '❤️ New like',
        title: `${ui.esc(interaction.user.displayName || interaction.user.username)} liked your activity`,
        body: `<@${userId}> liked you watching **${ui.esc(post.animeTitle || 'an anime')}**\n-# 🏠 ${ui.esc(interaction.guild.name)}`,
        thumbnail: cover,
        buttons: [ui.linkButton(interaction.message.url, 'Jump to post', '↗️')],
      })
    )
    .catch(() => {});
}

/* ----- More Info ----- */
async function getMediaDetailsCached(mediaId) {
  const hit = mediaDetailsCache.get(mediaId);
  if (hit && Date.now() - hit.at < MEDIA_DETAILS_TTL_MS) return hit.media;
  const media = await getMediaDetails(mediaId);
  if (media) boundedSet(mediaDetailsCache, mediaId, { at: Date.now(), media });
  return media;
}

// Walks the franchise forward from its root along SEQUEL links and returns
// the ordered list of TV-style entries (TV / TV Short / ONA) — i.e. "seasons".
// Movies/OVAs between seasons are passed through but not counted.
async function getFranchiseSeasonIds(rootId) {
  if (franchiseCache.has(rootId)) return franchiseCache.get(rootId);
  const ids = [];
  const visited = new Set();
  let cursor = rootId;
  for (let hop = 0; hop < MAX_FRANCHISE_HOPS && cursor && !visited.has(cursor); hop++) {
    visited.add(cursor);
    const media = await getMediaRelations(cursor).catch(() => null);
    if (!media) break;
    if (media.type === 'ANIME' && TV_FORMATS.has(media.format)) ids.push(media.id);
    const sequels = (media.relations?.edges || []).filter((e) => e.relationType === 'SEQUEL' && e.node?.type === 'ANIME');
    const next = sequels.find((e) => TV_FORMATS.has(e.node.format)) || sequels[0];
    cursor = next?.node?.id;
  }
  boundedSet(franchiseCache, rootId, ids);
  return ids;
}

// The "More Info" panel for any anime (used by the post button and /anime).
async function buildMoreInfoPayload(mediaId, extra = {}) {
  let media;
  try {
    media = await getMediaDetailsCached(mediaId);
  } catch (e) {
    console.error('More Info lookup failed:', e.message);
  }
  if (!media) return null;

  let seasonNumber = null;
  let totalSeasons = null;
  if (media.type === 'ANIME') {
    try {
      const { rootId } = await resolveSeasonInfo(mediaId, titleOf(media), media.siteUrl, media.type);
      const seasonIds = await getFranchiseSeasonIds(rootId);
      if (seasonIds.length) {
        totalSeasons = seasonIds.length;
        const idx = seasonIds.indexOf(mediaId);
        seasonNumber = idx === -1 ? null : idx + 1;
      }
    } catch (e) {
      console.error('Season count failed:', e.message);
    }
  }
  return buildMoreInfo(media, { seasonNumber, totalSeasons, ...extra });
}

async function handleMoreInfoButton(interaction, mediaId) {
  const payload = await buildMoreInfoPayload(mediaId);
  if (!payload) {
    await respond(interaction, { content: '⚠️ AniList isn’t responding right now (this is on AniList’s side). Try again in a bit.' });
    return;
  }
  await respond(interaction, payload);
}

/* ---------------------------------------------------------------------------
 * Activity post building (layout lives in features/activityPost.js)
 * ------------------------------------------------------------------------- */
function postRow(rootId, infoMediaId, likeCount = 0) {
  return activityPost.postButtons(rootId, infoMediaId, { likeCount, rateLabel: POST_RATE_BUTTON });
}
// The ⭐ Rate button on posts (part of the ratings feature).
const POST_RATE_BUTTON = true;

// Footer for classic (pre-layout-change) embed posts when their buttons refresh.
function buildFooterText(recommendCount) {
  if (recommendCount > 0) return `Recommended by ${recommendCount} ${recommendCount === 1 ? 'person' : 'people'} • AniList`;
  return 'AniList';
}

function getPopularityRank(rankings) {
  if (!rankings) return null;
  const entry = rankings.find((r) => r.type === 'POPULAR' && r.allTime);
  if (!entry || entry.rank > 100) return null;
  return entry.rank;
}

// Walks AniList's PREQUEL chain to the franchise root (e.g. Season 1).
// Everything downstream (title link, Watch Later, Recommend) keys on the
// root, so seasons consolidate. Season number counts TV-style entries only,
// so a movie between seasons doesn't shift "season 2" to "season 3".
async function resolveSeasonInfo(mediaId, fallbackTitle, fallbackSiteUrl, mediaType) {
  if (seasonCache.has(mediaId)) return seasonCache.get(mediaId);

  let tvCount = 0;
  let currentIsTv = false;
  let rootId = mediaId;
  let rootTitle = fallbackTitle;
  let rootSiteUrl = fallbackSiteUrl;
  let rootRankings = null;
  let lookupFailed = false;

  let cursorId = mediaId;
  for (let hop = 0; hop < MAX_SEASON_HOPS; hop++) {
    const media = await getMediaRelations(cursorId).catch(() => null);
    if (!media) {
      lookupFailed = hop === 0;
      break;
    }
    if (hop === 0) {
      rootRankings = media.rankings || null;
      currentIsTv = media.type === 'ANIME' && TV_FORMATS.has(media.format);
      if (currentIsTv) tvCount = 1;
    }
    const type = media.type || mediaType;
    const prequel = (media.relations?.edges || []).find((e) => e.relationType === 'PREQUEL' && (!type || e.node?.type === type));
    if (!prequel) break;

    if (TV_FORMATS.has(prequel.node.format)) tvCount += 1;
    rootId = prequel.node.id;
    rootTitle = prequel.node.title?.english || prequel.node.title?.romaji || rootTitle;
    rootSiteUrl = prequel.node.siteUrl || rootSiteUrl;
    rootRankings = prequel.node.rankings || null;
    cursorId = prequel.node.id;
  }

  const result = {
    season: currentIsTv && tvCount > 1 ? tvCount : null,
    rootId,
    rootTitle,
    rootSiteUrl,
    popularityRank: getPopularityRank(rootRankings),
  };
  // Don't cache a result that only exists because AniList was down.
  if (!lookupFailed) boundedSet(seasonCache, mediaId, result);
  return result;
}

// AniList gives most covers a colour; only decode the image when it doesn't.
async function coverColor(media) {
  const hex = media?.coverImage?.color;
  if (typeof hex === 'string' && /^#?[0-9a-f]{6}$/i.test(hex)) return parseInt(hex.replace('#', ''), 16);
  const cover = media?.coverImage || {};
  return getDominantColor(cover.medium || cover.large || cover.extraLarge);
}

async function buildPostPayload({ username, activity, seasonInfo, look, ownerId, mentionId, streak, cfg, guildId = null, likeCount = 0, preview = false }) {
  const color = activity.media ? await coverColor(activity.media).catch(() => DEFAULT_COLOR) : DEFAULT_COLOR;
  const extra = postExtras ? await postExtras({ activity, seasonInfo, cfg, guildId }).catch(() => ({})) : {};
  return activityPost.buildActivityPost({ username, activity, streak, seasonInfo, look, ownerId, mentionId, color, cfg, likeCount, preview, rateLabel: POST_RATE_BUTTON, ...extra });
}
// Extra post details: the server's community rating ("👥 8.3 here (4)").
const postExtras = (args) => ratings.postExtras(args);

/* ---------------------------------------------------------------------------
 * Poller
 * ------------------------------------------------------------------------- */
async function pollAllGuilds() {
  if (isPaused || !client.isReady()) return;
  // If a poll is still running (slow AniList), don't start a second one on
  // top of it — overlapping polls used to double-post the same activity.
  if (pollRunning) {
    console.warn('Previous poll still running — skipping this tick.');
    return;
  }
  pollRunning = true;
  const started = Date.now();
  try {
    await pollOnce();
  } catch (e) {
    console.error('Poll failed:', e.stack || e.message);
  } finally {
    pollRunning = false;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (Date.now() - started > 60000) console.warn(`Poll took ${secs}s`);
  }
}

function sortEvents(list) {
  return list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id || 0) - (b.id || 0));
}

async function pollOnce() {
  const data = await loadData();
  const soc = await loadSocial();
  const st = await loadStats();
  const tzFor = (anilistId) => {
    const ownerId = social.discordFor(data, anilistId);
    return (ownerId && soc.users[ownerId]?.prefs?.timezone) || social.DEFAULT_TZ;
  };

  // Every AniList account we know: tracked in a server OR signed in.
  const accounts = new Set();
  for (const [guildId, g] of Object.entries(data.guilds)) {
    if (!client.guilds.cache.has(guildId)) continue;
    for (const u of g.users || []) accounts.add(u.id);
  }
  for (const acct of Object.values(data.linkedAccounts)) accounts.add(acct.anilistId);
  // Start somewhere different each poll, so if AniList rate-limits us part
  // way through, it's not always the same people who miss out.
  const order = [...accounts];
  if (order.length) {
    const k = pollRotation++ % order.length;
    order.push(...order.splice(0, k));
  }

  // 1) Fetch each account once: activities + recent list entries. Work out
  //    merged / no-activity updates (features/feed.js).
  const feeds = new Map(); // anilistId -> { activities, entries, merged, synthetic }
  let coreChanged = false;
  for (const anilistId of order) {
    if (isPaused) break;
    try {
      const f = await getRecentFeed(anilistId, 25);
      const ev = feed.expand(feed.stateFor(data, anilistId), f.activities, f.entries);
      feeds.set(anilistId, { ...f, ...ev });
      coreChanged = true;
      const latest = f.activities[0];
      feedHealth.set(anilistId, { at: Date.now(), ok: true, error: null, latestId: latest?.id || null, latestAt: latest?.createdAt || null, entries: f.entries ? f.entries.length : null, merged: ev.merged.length, synthetic: ev.synthetic.length });
      if (ev.merged.length || ev.synthetic.length) console.log(`[feed] AniList ${anilistId}: ${ev.merged.length} merged + ${ev.synthetic.length} list-only update(s)`);
    } catch (e) {
      feedHealth.set(anilistId, { ...(feedHealth.get(anilistId) || {}), at: Date.now(), ok: false, error: e.message.slice(0, 300) });
      console.error(`Failed fetching AniList user ${anilistId}:`, e.message);
    }
    if (feedHealth.size > 2000) feedHealth.delete(feedHealth.keys().next().value);
  }

  // 2) Specific tags (Isekai, Satire…) for the shows in this poll's new
  //    updates — one request for all of them.
  const dayAgo = Date.now() / 1000 - 86400;
  const needTags = new Set();
  for (const f of feeds.values()) {
    for (const a of [...f.activities, ...f.merged, ...f.synthetic]) if (a.media && (a.createdAt || 0) > dayAgo) needTags.add(a.media.id);
  }
  if (needTags.size) {
    try {
      const tags = await getMediaTags([...needTags]);
      for (const f of feeds.values()) for (const a of [...f.activities, ...f.merged, ...f.synthetic]) if (a.media && tags.has(a.media.id)) a.media.tags = tags.get(a.media.id);
    } catch (e) {
      console.warn('Tag lookup failed (posts fall back to genres):', e.message);
    }
  }

  // 3) Stats & streaks — recorded even when posting is off.
  let statsChanged = false;
  for (const [anilistId, f] of feeds) {
    try {
      if (statsEngine.record(st, anilistId, f.activities, tzFor(anilistId), [...f.merged, ...f.synthetic])) statsChanged = true;
    } catch (e) {
      console.error(`Failed recording stats for AniList user ${anilistId}:`, e.message);
    }
  }
  if (statsChanged) saveStats();

  // 4) Post new activity in each server.
  let changed = coreChanged;
  for (const guildId of Object.keys(data.guilds)) {
    if (isPaused) break;
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId || !guildData.users.length) continue;
    if (!client.guilds.cache.has(guildId)) continue; // bot was removed from this server
    const cfg = peekConfig(soc, guildId);

    const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
    if (!channel) continue;
    const missing = missingChannelPerms(channel);
    if (missing.length) {
      if (!warnedChannels.has(channel.id)) {
        warnedChannels.add(channel.id);
        console.warn(`Can't post in #${channel.name} (${guildId}) — missing ${missing.join(', ')}. Skipping until fixed.`);
      }
      continue;
    }
    warnedChannels.delete(channel.id);

    for (const user of [...guildData.users]) {
      const f = feeds.get(user.id);
      if (!f) continue; // fetch failed this poll — try again next time
      try {
        const last = user.lastActivityId || 0;
        const fresh = f.activities.filter((a) => a.id > last);
        // Merged updates only for activities this server already posted;
        // list-only updates always (the feed memory prevents backlogs).
        const extra = [...f.merged.filter((a) => a.id <= last), ...f.synthetic];
        const events = sortEvents([...fresh, ...extra]);
        if (!events.length) continue;
        const advance = () => {
          const maxId = Math.max(last, ...fresh.map((a) => a.id));
          if (maxId > (user.lastActivityId || 0)) user.lastActivityId = maxId;
          changed = true;
        };
        if (isOptedOut(data, user.id)) {
          // Owner turned live activity off: skip posting, but don't build a backlog either.
          advance();
          continue;
        }

        const ownerId = profileOwnerId(data, user.id, user.addedBy);
        const look = ownerId && soc.users[ownerId] ? social.getUser(soc, ownerId) : null;
        const streak = statsEngine.streakOf(st.users[String(user.id)], tzFor(user.id)).current;

        for (const activity of events) {
          const isText = activity.__typename === 'TextActivity' || activity.__typename === 'MessageActivity';
          const skip =
            (isText && !cfg.postText) ||
            (activity.media?.type === 'MANGA' && !cfg.postManga) ||
            (activity.media?.isAdult && cfg.mature === 'skip');
          if (skip) {
            if (activity.id > (user.lastActivityId || 0)) user.lastActivityId = activity.id;
            changed = true;
            continue;
          }
          let seasonInfo = null;
          if (activity.__typename === 'ListActivity' && activity.media) {
            seasonInfo = await resolveSeasonInfo(activity.media.id, titleOf(activity.media), activity.media.siteUrl, activity.media.type);
            const key = String(seasonInfo.rootId);
            const entry = data.watchStats[key] || { title: seasonInfo.rootTitle, siteUrl: seasonInfo.rootSiteUrl, count: 0 };
            entry.count += 1;
            entry.title = seasonInfo.rootTitle;
            entry.siteUrl = seasonInfo.rootSiteUrl;
            entry.cover = activity.media.coverImage?.large || entry.cover || null;
            data.watchStats[key] = entry;
          }

          const mentionId = cfg.ping === 'off' ? null : user.addedBy || null;
          const payload = await buildPostPayload({ username: user.username, activity, seasonInfo, look, ownerId, mentionId, streak, cfg, guildId });
          const sentMessage = await channel.send(payload);

          guildData.recentPosts[sentMessage.id] = {
            addedBy: user.addedBy || null,
            anilistId: user.id,
            animeTitle: seasonInfo ? seasonInfo.rootTitle : null,
            mediaTitle: activity.media ? titleOf(activity.media) : null,
            siteUrl: seasonInfo ? seasonInfo.rootSiteUrl : null,
            rootId: seasonInfo ? seasonInfo.rootId : null,
            mediaId: activity.media?.id || null,
            cover: activity.media?.coverImage?.large || activity.media?.coverImage?.medium || null,
            color: payload.components?.[0]?.data?.accent_color ?? null,
            postedAt: new Date().toISOString(),
            likes: [],
          };
          // Advance per activity, so a failure halfway never re-posts the earlier ones.
          if (activity.id > (user.lastActivityId || 0)) user.lastActivityId = activity.id;
          changed = true;
        }
        advance();
      } catch (e) {
        console.error(`Failed polling ${user.username}:`, e.message);
      }
    }

    // Keep recentPosts bounded (insertion order is chronological).
    const postKeys = Object.keys(guildData.recentPosts);
    if (postKeys.length > MAX_RECENT_POSTS) {
      for (const k of postKeys.slice(0, postKeys.length - MAX_RECENT_POSTS)) delete guildData.recentPosts[k];
      changed = true;
    }
  }

  if (changed) await saveData(data);
  await recaps.runScheduled().catch((e) => console.error('Scheduled recaps failed:', e.stack || e.message));
}

// Settings → Activity posts → "Preview a post": the person's latest real
// activity (or a sample) rendered with their unsaved draft settings.
async function buildActivityPreview(userId, draftUser) {
  const data = await loadData();
  const st = await loadStats();
  const al = social.anilistFor(data, userId);
  let activity = null;
  if (al) {
    const acts = await getRecentActivities(al.id, 10).catch(() => []);
    activity = acts.find((a) => a.__typename === 'ListActivity' && a.media?.type === 'ANIME') || null;
  }
  if (!activity) {
    const m = await getMediaDetailsCached(154587).catch(() => null); // Frieren as a friendly sample
    if (!m) return null;
    activity = {
      __typename: 'ListActivity',
      id: 0,
      status: 'watched episode',
      progress: '5',
      createdAt: Math.floor(Date.now() / 1000),
      media: { ...m, coverImage: { extraLarge: m.coverImage?.extraLarge, large: m.coverImage?.large, medium: m.coverImage?.large, color: m.coverImage?.color } },
    };
  }
  if (!activity.media.tags) {
    const tags = await getMediaTags([activity.media.id]).catch(() => null);
    if (tags) activity.media.tags = tags.get(activity.media.id);
  }
  const seasonInfo = await resolveSeasonInfo(activity.media.id, titleOf(activity.media), activity.media.siteUrl, activity.media.type);
  const tz = draftUser?.prefs?.timezone || social.DEFAULT_TZ;
  const streak = al ? statsEngine.streakOf(st.users[String(al.id)], tz).current : 3;
  return buildPostPayload({ username: al?.name || 'you', activity, seasonInfo, look: draftUser, ownerId: userId, mentionId: null, streak, cfg: {}, preview: true });
}

/* ---------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------- */
(async () => {
  if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN is not set — cannot log in.');
    return;
  }
  // Warm every storage document before anything can touch it.
  await Promise.all([loadData(), loadSocial(), loadStats()]);
  await migrateListsToSocial().catch((e) => console.error('List migration failed:', e.message));
  await recordBoot();
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (e) {
    console.error('Discord login failed:', e.message);
    // Exit so Render restarts us instead of sitting there half-alive.
    await flushData();
    process.exit(1);
  }
})();

// Exposed only so the handlers can be exercised in isolation; unused at runtime.
module.exports = {
  _internals: { client, app, dispatchInteraction, buildActivityPreview, buildPostPayload, handleSlashCommand, handleButton, handleModalSubmit, handleSelectMenu, pollOnce, resolveSeasonInfo, getFranchiseSeasonIds, feedHealth },
};
