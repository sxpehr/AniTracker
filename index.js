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
  buildMoreInfoPayload: (id) => buildMoreInfoPayload(id),
  toggleList: (interaction, mediaId, field) => handleListToggleButton(interaction, mediaId, field),
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
app.use(buildOAuthRouter({ loadData, saveData, onLinked: sendLinkedConfirmation }));
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

function signInButtonRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Sign in with AniList').setEmoji('🔐').setURL(signInUrlFor(userId))
  );
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

  for (const guildId of Object.keys(data.guilds)) {
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId) continue;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
      if (!channel || missingChannelPerms(channel).length) continue;
      const animeRole = await findAnimeRole(guild);
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
    const embed = new EmbedBuilder()
      .setColor(DEFAULT_COLOR)
      .setTitle('✦ Thanks for adding AniTracker!')
      .setDescription(
        [
          'I post AniList activity (episodes watched, chapters read, status changes) right here in Discord.',
          '',
          '**Quick start**',
          '`/setchannel` — pick where updates go (needs Manage Server)',
          '`/track username:<AniList name>` — start posting someone’s activity',
          '`/signin` — link your own AniList so you control your live activity',
          '`/profile` · `/settings` — your own customizable anime profile',
          '`/help` — everything else',
        ].join('\n')
      );
    await channel.send({ embeds: [embed] });
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
    if (interaction.isChatInputCommand()) return await handleSlashCommand(interaction);
    // Profile / settings / collections / reviews / stats components use "ns:..." ids.
    if ((interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) && interaction.customId.includes(':')) {
      return await routeFeatureInteraction(interaction);
    }
    if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
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
    return;
  }
  switch (ns) {
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

    const sourceEmbed = message.embeds[0];
    const cover = postInfo.cover || sourceEmbed?.image?.url || null;
    const animeTitle = postInfo.animeTitle || 'your activity';
    const animeUrl = postInfo.siteUrl || null;
    const titleLink = animeUrl ? `[${animeTitle}](${animeUrl})` : `**${animeTitle}**`;
    const color = sourceEmbed?.color ?? DEFAULT_COLOR;
    const guildIcon = message.guild.iconURL({ size: 64 }) || undefined;
    const jumpRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to post').setEmoji('↗️').setURL(message.url)
    );

    const owner = await client.users.fetch(ownerId).catch(() => null);

    // DM to the profile owner: who reacted, to what, and where.
    if (owner) {
      const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: `${reactingUser.displayName || reactingUser.username} reacted ${emojiStr}`, iconURL: reactingUser.displayAvatarURL({ size: 64 }) })
        .setDescription(`<@${reactingUser.id}> reacted ${emojiStr} to you watching ${titleLink}\n\n🏠 **${message.guild.name}** · <#${message.channelId}>`)
        .setFooter({ text: message.guild.name, iconURL: guildIcon })
        .setTimestamp(new Date());
      if (cover) embed.setThumbnail(cover);
      await owner.send({ embeds: [embed], components: [jumpRow], allowedMentions: { parse: [] } }).catch((e) =>
        console.error(`Failed to DM profile owner ${ownerId}:`, e.message)
      );
    }

    // DM to the reactor: private confirmation the alert went out.
    const confirm = new EmbedBuilder()
      .setColor(color)
      .setDescription(`✅ <@${ownerId}> was alerted of your ${emojiStr} on ${titleLink}\n\n🏠 **${message.guild.name}** · <#${message.channelId}>`)
      .setFooter({ text: message.guild.name, iconURL: guildIcon })
      .setTimestamp(new Date());
    if (cover) confirm.setThumbnail(cover);
    await reactingUser.send({ embeds: [confirm], components: [jumpRow], allowedMentions: { parse: [] } }).catch((e) =>
      console.error(`Failed to DM reactor ${reactingUser.id}:`, e.message)
    );
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
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle(`📋 Tracked profiles (${guildData.users.length})`)
    .setDescription(`${guildData.channelId ? `Posting in <#${guildData.channelId}>\n\n` : ''}${lines.join('\n')}`.slice(0, 4096))
    .setFooter({ text: '⏸️ = owner turned live activity off' });
  // Mentions render as names but never ping.
  await respond(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
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
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle("📋 Who's tracking what")
    .setDescription(lines.join('\n').slice(0, 4096));
  await respond(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
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
    .map(([mediaId, r]) => ({ mediaId, title: r.title, siteUrl: r.siteUrl, count: r.recommendedBy.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function buildRecommendEmbed(scope, guildData, data) {
  const isGlobal = scope === 'global';
  const entries = buildRecommendEntries(isGlobal ? data.globalRecommendations : guildData.recommendations);
  const scopeLabel = isGlobal ? '🌍 Global' : '🏠 This Server';

  const embed = new EmbedBuilder()
    .setColor(RECOMMEND_EMBED_COLOR)
    .setTitle('⭐ Most Recommended Anime')
    .setFooter({ text: `Showing: ${scopeLabel} — use the menu below to switch` })
    .setTimestamp(new Date());

  if (!entries.length) {
    embed.setDescription(
      isGlobal
        ? 'No recommendations anywhere yet — click ⭐ **Recommend** on an activity to start the leaderboard!'
        : 'No recommendations in this server yet — click ⭐ **Recommend** on an activity to start the leaderboard!'
    );
    return embed;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const totalVotes = entries.reduce((sum, e) => sum + e.count, 0);
  embed.setDescription(
    `**${scopeLabel}**  •  ${totalVotes} total ${totalVotes === 1 ? 'vote' : 'votes'} across ${entries.length} title${entries.length === 1 ? '' : 's'}`
  );
  entries.forEach((e, i) => {
    embed.addFields({
      name: `${medals[i] || `#${i + 1}`}  ${e.title}`.slice(0, 256),
      value: `[View on AniList ↗](${e.siteUrl})\n**${e.count}** ${e.count === 1 ? 'vote' : 'votes'}`,
      inline: entries.length > 3,
    });
  });
  return embed;
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
  const scope = 'guild';
  await respond(interaction, { embeds: [buildRecommendEmbed(scope, guildData, data)], components: [buildRecommendScopeRow(scope)] });
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== 'recscope' || !interaction.guildId) return;
  const data = await loadData();
  const guildData = ensureGuildData(data, interaction.guildId);
  const scope = interaction.values[0] === 'global' ? 'global' : 'guild';
  const payload = { embeds: [buildRecommendEmbed(scope, guildData, data)], components: [buildRecommendScopeRow(scope)] };

  // Only the person who ran the command switches the shared message; anyone
  // else gets their own private copy instead of changing it for everybody.
  const ownerId = interaction.message.interactionMetadata?.user?.id;
  if (ownerId && ownerId !== interaction.user.id) {
    await respond(interaction, { ...payload, flags: EPHEMERAL });
    return;
  }
  try {
    await interaction.update(payload);
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

  const embed = new EmbedBuilder().setColor(DEFAULT_COLOR).setTitle(`💖 ${user.name}'s Favourites`).setURL(user.siteUrl);
  if (user.avatar?.medium) embed.setThumbnail(user.avatar.medium);
  const fmt = (list) =>
    list
      .map((m, i) => `\`${i + 1}\` [${titleOf(m)}](${m.siteUrl})`)
      .join('\n')
      .slice(0, 1024);
  if (animeList.length) embed.addFields({ name: '📺 Anime', value: fmt(animeList), inline: mangaList.length > 0 });
  if (mangaList.length) embed.addFields({ name: '📖 Manga', value: fmt(mangaList), inline: animeList.length > 0 });
  await respond(interaction, { embeds: [embed] });
}

/* ----- /signin, /signout ----- */
async function handleSignIn(interaction, data) {
  if (!isOAuthConfigured()) {
    await respond(interaction, {
      content: '🔧 AniList sign-in isn’t switched on for this bot yet — the developer still needs to finish setting it up. Check back soon!',
      flags: EPHEMERAL,
    });
    return;
  }
  const linked = data.linkedAccounts[interaction.user.id];
  const embed = new EmbedBuilder().setColor(DEFAULT_COLOR);
  if (linked) {
    embed
      .setTitle('🔐 You’re signed in')
      .setDescription(
        `Linked to **[${linked.anilistName}](${linked.siteUrl})**.\n\nWant to switch accounts? Sign in again below with the other AniList account. Or use \`/signout\` to unlink.`
      );
    if (linked.avatar) embed.setThumbnail(linked.avatar);
  } else {
    embed
      .setTitle('🔐 Sign in with AniList')
      .setDescription(
        [
          'Linking proves which AniList profile is yours, so **only you** can control it — like turning your live activity on/off with `/tracking`.',
          '',
          '• AniTracker only reads your **username and avatar**',
          '• It never posts, edits, or changes anything on your AniList',
          '• The link below is personal and expires in 15 minutes — don’t share it',
        ].join('\n')
      );
  }
  embed.setFooter({ text: 'Only you can see this' });
  await respond(interaction, { embeds: [embed], components: [signInButtonRow(interaction.user.id)], flags: EPHEMERAL });
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

async function sendLinkedConfirmation(discordUserId, account) {
  const user = await client.users.fetch(discordUserId).catch(() => null);
  if (!user) return;
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('✅ AniList linked')
    .setDescription(`Your Discord account is now linked to **[${account.anilistName}](${account.siteUrl})**.\n\nUse \`/tracking\` in any server to turn your live activity posts on or off.`);
  if (account.avatar) embed.setThumbnail(account.avatar);
  await user.send({ embeds: [embed] }).catch(() => {});
}

/* ----- /tracking (live activity on/off, owner only) ----- */
function trackedInGuilds(data, anilistId) {
  const names = [];
  for (const [guildId, g] of Object.entries(data.guilds)) {
    if ((g.users || []).some((u) => u.id === anilistId)) names.push(client.guilds.cache.get(guildId)?.name || 'a server');
  }
  return names;
}

function buildTrackingPanel(data, account) {
  const off = isOptedOut(data, account.anilistId);
  const servers = trackedInGuilds(data, account.anilistId);
  const serverLine = servers.length
    ? `Tracked in **${servers.length}** server${servers.length === 1 ? '' : 's'}: ${servers.slice(0, 10).join(', ')}${servers.length > 10 ? '…' : ''}`
    : 'Nobody is tracking your profile right now.';

  const embed = new EmbedBuilder()
    .setColor(off ? 0xfb7185 : 0x34d399)
    .setAuthor({ name: account.anilistName, iconURL: account.avatar || undefined, url: account.siteUrl })
    .setTitle(off ? '🔴 Live activity is OFF' : '🟢 Live activity is ON')
    .setDescription(
      [
        off
          ? 'Your AniList updates are **not** being posted in any server (your stats and streak still update privately). Turning it back on starts from your *next* update — nothing you did while it was off gets posted.'
          : 'Your AniList updates are posted in every server tracking you.',
        '',
        serverLine,
      ].join('\n')
    )
    .setFooter({ text: 'Only you can change this — it applies everywhere' });

  const row = new ActionRowBuilder().addComponents(
    off
      ? new ButtonBuilder().setCustomId('trk_on').setLabel('Turn on').setEmoji('🟢').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('trk_off').setLabel('Turn off').setEmoji('🔴').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
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
    const embed = new EmbedBuilder()
      .setColor(DEFAULT_COLOR)
      .setTitle('🔐 Sign in first')
      .setDescription(
        'To make sure only the **real owner** of an AniList profile can turn its live activity on or off, link your AniList account first with `/signin` — then run `/tracking` again.'
      );
    const payload = { embeds: [embed], flags: EPHEMERAL };
    if (isOAuthConfigured()) payload.components = [signInButtonRow(interaction.user.id)];
    await respond(interaction, payload);
    return;
  }

  const status = interaction.options.getString('status');
  if (status === 'on' || status === 'off') {
    if (!(await safeDefer(interaction, true))) return;
    await setLiveActivity(data, account, status === 'on', interaction.user.id);
  }
  await respond(interaction, { ...buildTrackingPanel(data, account), flags: EPHEMERAL });
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
  await interaction.editReply(buildTrackingPanel(data, account)).catch((e) => console.error('Failed to refresh tracking panel:', e.message));
}

/* ----- /help ----- */
async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('✦ AniTracker commands')
    .addFields(
      {
        name: '📡 Tracking',
        value: [
          '`/track` — post someone’s AniList activity here',
          '`/untrack` — stop tracking a profile',
          '`/list` · `/whostracking` — who’s tracked in this server',
          '`/setchannel` — where updates post *(Manage Server)*',
        ].join('\n'),
      },
      {
        name: '🪪 Your profile',
        value: [
          '`/profile` — your anime page (or `/profile user:@someone`)',
          '`/settings` — theme, banner, showcase, activity style, privacy',
          '`/signin` · `/signout` — link your AniList · `/tracking` — posts on/off',
        ].join('\n'),
      },
      {
        name: '📚 Lists & reviews',
        value: [
          '`/anime info · search · trending · random · airing` — look anything up',
          '`/watchlater` · `/myfavorites` · `/rotation` — view, add, remove',
          '`/collection` — custom lists like “Comfort Anime”',
          '`/recommend` — recommend an anime with a message',
          '`/review write` · `/review browse` — write and discover reviews',
          '`/favorites` — anyone’s AniList favourites',
        ].join('\n'),
      },
      {
        name: '📊 Stats & community',
        value: ['`/stats` — month, lifetime, streaks · `/recap` — monthly recap', '`/leaderboard` — server boards · `/recommendanimes` — most recommended'].join('\n'),
      },
      { name: '💬 Other', value: '`/feedback` — rate AniTracker & tell the developer anything\n`/update` — post an update notice silently *(Manage Server)*' },
      {
        name: '🔘 Buttons on activity posts',
        value: '💜 Recommend · 🤍 Like · ⭐ Favorite · 📌 Watch later\n✍️ Review · 🗂️ Save to list · 📊 More info — replies only you can see\nReact to a post and its owner gets a private DM.',
      }
    );
  const invite = getInviteUrl();
  const components = invite
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Add AniTracker to a server').setURL(invite))]
    : [];
  await respond(interaction, { embeds: [embed], components, flags: EPHEMERAL });
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

  const embed = new EmbedBuilder().setColor(DEFAULT_COLOR).setTimestamp(new Date());
  if (custom) {
    embed
      .setAuthor({ name: 'AniTracker update', iconURL: client.user.displayAvatarURL({ size: 64 }) })
      .setDescription(custom.replace(/\\n/g, '\n'))
      .setFooter({ text: `Posted by ${interaction.member?.displayName || interaction.user.username}` });
  } else {
    embed
      .setTitle(LATEST_UPDATE.title)
      .setThumbnail(client.user.displayAvatarURL({ size: 128 }))
      .setDescription(LATEST_UPDATE.items.map((i) => `• ${i}`).join('\n'))
      .setFooter({ text: LATEST_UPDATE.footer });
  }

  try {
    await channel.send({
      embeds: [embed],
      // @silent: shows normally, but no push notification or sound for anyone.
      flags: MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] },
    });
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
  await respond(interaction, { embeds: [feedback.buildThanksEmbed(entry)], flags: EPHEMERAL });
}

/* ---------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------- */
async function handleButton(interaction) {
  const { customId } = interaction;
  if (customId === 'trk_on' || customId === 'trk_off') return handleTrackingButton(interaction, customId === 'trk_on');

  if (!interaction.guildId) return;
  const [action, idStr] = customId.split('_');
  const mediaId = parseInt(idStr, 10);
  if (!mediaId || !['wl', 'rec', 'fav', 'info', 'like', 'rvw', 'col'].includes(action)) return;

  // The review form must be the very first response (no defer before a modal).
  if (action === 'rvw') {
    const embedTitle = interaction.message?.embeds?.[0]?.description?.match(/^# \[(.+?)\]\(/m)?.[1];
    return reviewsFeature.openWriteForm(interaction, mediaId, embedTitle);
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

async function refreshPostButtons(interaction, guildData, rootId) {
  try {
    const recCount = guildData.recommendations[rootId]?.recommendedBy?.length || 0;
    const likeCount = guildData.recentPosts[interaction.message.id]?.likes?.length || 0;
    const infoId = findInfoIdOnMessage(interaction.message) || rootId;
    const editPayload = { components: buildActivityButtons(rootId, infoId, recCount, likeCount) };
    const existingEmbed = interaction.message.embeds[0];
    if (existingEmbed) editPayload.embeds = [EmbedBuilder.from(existingEmbed).setFooter({ text: buildFooterText(recCount) })];
    await interaction.message.edit(editPayload);
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
        const embed = new EmbedBuilder()
          .setColor(interaction.message.embeds[0]?.color ?? RECOMMEND_EMBED_COLOR)
          .setAuthor({ name: `${interaction.user.displayName || interaction.user.username} recommended it 💜`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
          .setDescription(`<@${userId}> recommended **${rec.siteUrl ? `[${animeName}](${rec.siteUrl})` : animeName}** that you were watching!\n\n🏠 **${interaction.guild.name}**`)
          .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL({ size: 64 }) || undefined })
          .setTimestamp(new Date());
        const cover = postInfo?.cover || interaction.message.embeds[0]?.image?.url || interaction.message.embeds[0]?.thumbnail?.url;
        if (cover) embed.setThumbnail(cover);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to post').setEmoji('↗️').setURL(interaction.message.url)
        );
        await owner.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch((e) => console.error('Failed to DM recommend notification:', e.message));
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
  await respond(interaction, { content: had ? 'Unliked.' : '❤️ Liked!' });

  const ownerId = profileOwnerId(data, post.anilistId, post.addedBy);
  if (had || !ownerId || ownerId === userId) return;
  const key = `like:${interaction.message.id}:${userId}`;
  if (Date.now() - (reactionDmSeen.get(key) || 0) < REACTION_DM_DEDUPE_MS) return;
  reactionDmSeen.set(key, Date.now());
  const owner = await client.users.fetch(ownerId).catch(() => null);
  if (!owner) return;
  const embed = new EmbedBuilder()
    .setColor(interaction.message.embeds[0]?.color ?? DEFAULT_COLOR)
    .setAuthor({ name: `${interaction.user.displayName || interaction.user.username} liked your activity ❤️`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
    .setDescription(`<@${userId}> liked you watching **${post.animeTitle || 'an anime'}**\n\n🏠 **${interaction.guild.name}**`)
    .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL({ size: 64 }) || undefined })
    .setTimestamp(new Date());
  const cover = post.cover || interaction.message.embeds[0]?.image?.url || interaction.message.embeds[0]?.thumbnail?.url;
  if (cover) embed.setThumbnail(cover);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to post').setEmoji('↗️').setURL(interaction.message.url));
  await owner.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => {});
}

function findInfoIdOnMessage(message) {
  for (const row of message?.components || []) {
    for (const c of row.components || []) {
      if (c.customId?.startsWith('info_')) return parseInt(c.customId.split('_')[1], 10) || null;
    }
  }
  return null;
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
async function buildMoreInfoPayload(mediaId) {
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
  return buildMoreInfo(media, { seasonNumber, totalSeasons });
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
 * Activity post building
 * ------------------------------------------------------------------------- */
// Two rows under every activity post:
//   💜 Recommend · ❤️ Like · ⭐ Favorite · 📌 Watch later
//   ✍️ Review · 🗂️ Save to list · 📊 More info
function buildActivityButtons(rootId, infoMediaId, recommendCount = 0, likeCount = 0) {
  const target = infoMediaId || rootId;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rec_${rootId}`)
        .setLabel(recommendCount ? `Recommend · ${recommendCount}` : 'Recommend')
        .setEmoji('💜')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`like_${rootId}`)
        .setLabel(likeCount ? `Like · ${likeCount}` : 'Like')
        .setEmoji('🤍')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`fav_${rootId}`).setLabel('Favorite').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`wl_${rootId}`).setLabel('Watch later').setEmoji('📌').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rvw_${target}`).setLabel('Review').setEmoji('✍️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`col_${rootId}`).setLabel('Save to list').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`info_${target}`).setLabel('More info').setEmoji('📊').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildFooterText(recommendCount) {
  if (recommendCount > 0) return `Recommended by ${recommendCount} ${recommendCount === 1 ? 'person' : 'people'} • AniList`;
  return 'AniList';
}

function statusEmoji(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complet')) return '✅';
  if (s.includes('drop')) return '🗑️';
  if (s.includes('paus')) return '⏸️';
  if (s.includes('plan')) return '📌';
  if (s.includes('rewatch') || s.includes('reread')) return '🔁';
  if (s.includes('watch')) return '▶️';
  if (s.includes('read')) return '📖';
  return '📺';
}

function statusVerbShort(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complet')) return 'Completed';
  if (s.includes('drop')) return 'Dropped';
  if (s.includes('paus')) return 'Paused';
  if (s.includes('plan')) return s.includes('read') ? 'Plans to read' : 'Plans to watch';
  if (s.includes('rewatch')) return 'Rewatched';
  if (s.includes('reread')) return 'Reread';
  if (s.includes('watch')) return 'Watched';
  if (s.includes('read')) return 'Read';
  return capitalize(s) || 'Updated';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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

function stripMarkup(text) {
  return (text || '')
    .replace(/img\d*\(.*?\)/g, '')
    .replace(/webm\(.*?\)/g, '')
    .replace(/youtube\(.*?\)/g, '')
    .replace(/~!.*?!~/gs, '')
    .replace(/[_*~`]/g, '')
    .trim();
}

function stripDescription(text) {
  if (!text) return '';
  return text
    .replace(/~!.*?!~/gs, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

// "season 2, episode 5" / "episodes 3 - 5" / "chapter 120"
function progressText(activity, season) {
  const isManga = activity.media?.type === 'MANGA';
  const parts = [];
  if (season && !isManga) parts.push(`season ${season}`);
  if (activity.progress) {
    const range = String(activity.progress).includes('-');
    const unit = isManga ? (range ? 'chapters' : 'chapter') : range ? 'episodes' : 'episode';
    parts.push(`${unit} ${activity.progress}`);
  }
  return parts.join(', ');
}

// `look` = the profile owner's activity-post settings (style, colour, which
// details to show). With no settings saved, this produces the original look.
async function buildEmbed(username, avatarUrl, activity, streak, seasonInfo, look = null) {
  const a = look?.activity || { style: 'full', color: 'cover', show: social.DEFAULT_ACTIVITY_FIELDS };
  const show = new Set(a.show || social.DEFAULT_ACTIVITY_FIELDS);
  const style = a.style || 'full';
  const embed = new EmbedBuilder().setTimestamp(new Date(activity.createdAt * 1000));
  const authorOpts = {
    name: show.has('streak') && streak > 0 ? `✦ ${username} 🔥 ${streak}` : `✦ ${username}`,
    url: `https://anilist.co/user/${encodeURIComponent(username)}`,
  };
  if (avatarUrl) authorOpts.iconURL = avatarUrl;
  embed.setAuthor(authorOpts);

  if (activity.__typename === 'ListActivity' && activity.media) {
    const { season, rootTitle, rootSiteUrl, popularityRank } = seasonInfo;
    const progress = progressText(activity, season);
    const verb = statusVerbShort(activity.status);
    const captionLine = `${progress ? `${verb} ${progress}` : verb} ${statusEmoji(activity.status)}`;
    // "# " header renders bigger than Title and doesn't force an underline.
    const headerLine = `${style === 'minimal' ? '##' : '#'} [${rootTitle}](${rootSiteUrl})`;

    const cover = activity.media.coverImage || {};
    const displayImage = cover.extraLarge || cover.large || cover.medium;
    let color;
    if (a.color === 'theme') color = paletteFor(look?.profile).accent;
    else if (a.color === 'anilist') color = DEFAULT_COLOR;
    else color = await getDominantColor(cover.medium || cover.large || displayImage);

    const infoBits = [];
    if (show.has('rating') && typeof activity.media.averageScore === 'number') infoBits.push(`⭐ ${(activity.media.averageScore / 10).toFixed(1)}/10`);
    if (show.has('genres') && activity.media.genres?.length) infoBits.push(`🎭 ${activity.media.genres.slice(0, 3).join(', ')}`);
    if (activity.media.isAdult) infoBits.push('🔞 Mature');
    if (show.has('popularity') && popularityRank) infoBits.push(`❤️ #${popularityRank} Most Popular`);
    const infoLine = style === 'minimal' ? '' : infoBits.join('  •  ');

    const synopsisMax = style === 'compact' ? 100 : 160;
    const synopsis = style !== 'minimal' && show.has('description') ? truncate(stripDescription(activity.media.description), synopsisMax) : '';
    const descParts = [`${captionLine}\n${headerLine}`];
    if (infoLine) descParts.push(infoLine);
    if (synopsis) descParts.push(synopsis);
    embed.setDescription(descParts.join('\n\n'));

    embed.setColor(color).setFooter({ text: buildFooterText(0) });
    if (show.has('cover') && displayImage) {
      if (style === 'full') embed.setImage(displayImage);
      else embed.setThumbnail(displayImage);
    }
  } else if (activity.__typename === 'TextActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('💬 Posted a status update')
      .setURL(activity.siteUrl)
      .setDescription(truncate(stripMarkup(activity.text), 300) || '*(image or media post)*')
      .setFooter({ text: 'AniList' });
  } else if (activity.__typename === 'MessageActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('💬 Posted a message')
      .setURL(activity.siteUrl)
      .setDescription(truncate(stripMarkup(activity.message), 300) || '*(image or media post)*')
      .setFooter({ text: 'AniList' });
  } else {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('📺 New AniList activity')
      .setURL(`https://anilist.co/user/${encodeURIComponent(username)}`)
      .setFooter({ text: 'AniList' });
  }
  return embed;
}

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

async function pollOnce() {
  const data = await loadData();
  const soc = await loadSocial();
  const st = await loadStats();
  // Each AniList profile is fetched once per poll, however many servers track it.
  const activityCache = new Map();
  const fetchActivities = (anilistId) => {
    if (!activityCache.has(anilistId)) activityCache.set(anilistId, getRecentActivities(anilistId, 25));
    return activityCache.get(anilistId);
  };
  const tzFor = (anilistId) => {
    const ownerId = social.discordFor(data, anilistId);
    return (ownerId && soc.users[ownerId]?.prefs?.timezone) || social.DEFAULT_TZ;
  };

  // 1) Stats & streaks — for every AniList account we know: tracked in a
  //    server OR signed in with /signin. Recorded even when posting is off.
  const accounts = new Set();
  for (const [guildId, g] of Object.entries(data.guilds)) {
    if (!client.guilds.cache.has(guildId)) continue;
    for (const u of g.users || []) accounts.add(u.id);
  }
  for (const acct of Object.values(data.linkedAccounts)) accounts.add(acct.anilistId);
  let statsChanged = false;
  for (const anilistId of accounts) {
    if (isPaused) break;
    try {
      const acts = await fetchActivities(anilistId);
      if (statsEngine.record(st, anilistId, acts, tzFor(anilistId))) statsChanged = true;
    } catch (e) {
      console.error(`Failed recording stats for AniList user ${anilistId}:`, e.message);
    }
  }
  if (statsChanged) saveStats();

  // 2) Post new activity in each server.
  let changed = false;

  for (const guildId of Object.keys(data.guilds)) {
    if (isPaused) break;
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId || !guildData.users.length) continue;
    if (!client.guilds.cache.has(guildId)) continue; // bot was removed from this server

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
      try {
        const activities = await fetchActivities(user.id);
        const newOnes = activities.filter((a) => a.id > (user.lastActivityId || 0)).sort((a, b) => a.id - b.id);
        if (!newOnes.length) continue;
        if (isOptedOut(data, user.id)) {
          // Owner turned live activity off: skip posting, but don't build a backlog either.
          user.lastActivityId = Math.max(user.lastActivityId || 0, ...newOnes.map((a) => a.id));
          changed = true;
          continue;
        }

        const ownerId = profileOwnerId(data, user.id, user.addedBy);
        const look = ownerId && soc.users[ownerId] ? social.getUser(soc, ownerId) : null;
        const streak = statsEngine.streakOf(st.users[String(user.id)], tzFor(user.id)).current;

        for (const activity of newOnes) {
          let seasonInfo = null;
          if (activity.__typename === 'ListActivity' && activity.media) {
            seasonInfo = await resolveSeasonInfo(activity.media.id, titleOf(activity.media), activity.media.siteUrl, activity.media.type);
            const key = String(seasonInfo.rootId);
            const entry = data.watchStats[key] || { title: seasonInfo.rootTitle, siteUrl: seasonInfo.rootSiteUrl, count: 0 };
            entry.count += 1;
            entry.title = seasonInfo.rootTitle;
            entry.siteUrl = seasonInfo.rootSiteUrl;
            data.watchStats[key] = entry;
          }

          const embed = await buildEmbed(user.username, user.avatar, activity, streak, seasonInfo, look);
          const components = seasonInfo ? buildActivityButtons(seasonInfo.rootId, activity.media.id, 0, 0) : [];

          const sentMessage = await channel.send({
            content: user.addedBy ? `<@${user.addedBy}>` : undefined,
            embeds: [embed],
            components,
            allowedMentions: user.addedBy ? { users: [user.addedBy] } : { parse: [] },
            // Quiet ping: shows the mention, no push notification/sound.
            flags: user.addedBy ? MessageFlags.SuppressNotifications : undefined,
          });

          guildData.recentPosts[sentMessage.id] = {
            addedBy: user.addedBy || null,
            anilistId: user.id,
            animeTitle: seasonInfo ? seasonInfo.rootTitle : null,
            siteUrl: seasonInfo ? seasonInfo.rootSiteUrl : null,
            mediaId: activity.media?.id || null,
            cover: activity.media?.coverImage?.large || activity.media?.coverImage?.medium || null,
            likes: [],
          };
          // Advance per activity, so a failure halfway never re-posts the earlier ones.
          user.lastActivityId = Math.max(user.lastActivityId || 0, activity.id);
          changed = true;
        }
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
  await sendMonthlyRecaps(data, soc, st).catch((e) => console.error('Monthly recaps failed:', e.message));
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
      media: { ...m, coverImage: { extraLarge: m.coverImage?.extraLarge, large: m.coverImage?.large, medium: m.coverImage?.large } },
    };
  }
  const seasonInfo = await resolveSeasonInfo(activity.media.id, titleOf(activity.media), activity.media.siteUrl, activity.media.type);
  const tz = draftUser?.prefs?.timezone || social.DEFAULT_TZ;
  const streak = al ? statsEngine.streakOf(st.users[String(al.id)], tz).current : 3;
  const username = al?.name || 'you';
  const embed = await buildEmbed(username, al?.avatar || null, activity, streak, seasonInfo, draftUser);
  const rows = buildActivityButtons(seasonInfo.rootId, activity.media.id, 0, 0);
  rows.forEach((r) => r.components.forEach((b) => b.setDisabled(true)));
  return { embeds: [embed], components: rows };
}

// People who chose "DM me my recap" get last month's recap during the first
// week of a new month (so a bot restart on the 1st doesn't skip anyone).
let lastRecapCheck = 0;
async function sendMonthlyRecaps(data, soc, st) {
  if (Date.now() - lastRecapCheck < 60 * 60 * 1000) return; // at most hourly
  lastRecapCheck = Date.now();
  let sent = 0;
  for (const [userId, u] of Object.entries(soc.users)) {
    if (!u.prefs?.recapDm || sent >= 15) continue;
    const al = social.anilistFor(data, userId);
    if (!al) continue;
    const tz = u.prefs.timezone || social.DEFAULT_TZ;
    const today = statsEngine.dayKey(new Date(), tz);
    if (Number(today.slice(8, 10)) > 7) continue;
    const prev = statsEngine.lastMonths(statsEngine.monthKey(today), 2)[0];
    if (u.prefs.lastRecapSent === prev) continue;
    if (!st.users[String(al.id)]?.months?.[prev]?.e) {
      u.prefs.lastRecapSent = prev; // nothing watched — nothing to send
      continue;
    }
    try {
      const user = await client.users.fetch(userId);
      await user.send(await statsUi.recapPayload(userId, userId, prev, { shareable: false }));
      sent++;
    } catch (e) {
      console.error(`Couldn't DM recap to ${userId}:`, e.message);
    }
    u.prefs.lastRecapSent = prev;
  }
  saveSocial();
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
  _internals: { client, app, dispatchInteraction, buildActivityPreview, sendMonthlyRecaps, handleSlashCommand, handleButton, handleModalSubmit, handleSelectMenu, pollOnce, buildEmbed, resolveSeasonInfo, getFranchiseSeasonIds },
};
