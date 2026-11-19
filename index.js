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
const { loadData, saveData, flushData, isStorageHealthy, backend: storageBackend } = require('./storage');
const simkl = require('./simkl');
const { getDominantColor, DEFAULT_COLOR } = require('./imageColor');
const { buildDashboardRouter } = require('./dashboard/routes');
const { buildMoreInfo } = require('./moreInfo');
const feedback = require('./feedback');
const { commands: slashCommands } = require('./commands');
const { LATEST_UPDATE } = require('./changelog');

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_MINUTES, 10) || 3) * 60 * 1000;
const PING_ROLE_NAME = (process.env.PING_ROLE_NAME || 'tv').toLowerCase(); // role pinged on relaunch
const RELAUNCH_NOTICE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MAX_RECENT_POSTS = 300; // per server, for reaction/recommend lookups
const MAX_CACHE_ENTRIES = 1000;
const DETAILS_TTL_MS = 15 * 60 * 1000;
const REACTION_DM_DEDUPE_MS = 10 * 60 * 1000;
const RECOMMEND_EMBED_COLOR = 0xff9800;
const EPHEMERAL = MessageFlags.Ephemeral;
const KINDS = new Set(['movie', 'show']);

// What the bot needs in its posting channel. Checked before posting and when
// a channel is chosen, so a missing permission gives a clear message.
const REQUIRED_CHANNEL_PERMS = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
];
// What the invite link asks for (match the Developer Portal's Default Install Settings).
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
 * Small bounded caches
 * ------------------------------------------------------------------------- */
function boundedSet(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}
const detailsCache = new Map(); // key -> { at, title }
const reactionDmSeen = new Map(); // `${msg}:${user}:${emoji}` -> timestamp
const warnedChannels = new Set();
const pendingLogins = new Map(); // discord user id -> timer for an open /signin
const warnedUnlinked = new Set(); // tracked people whose sign-in is gone (warn once)

// Polling can be paused from the dashboard. Backed by data.botPaused.
let isPaused = false;
let pollRunning = false;
// Result of the last slash-command sync, shown on /health.
let commandSync = { ok: null, count: 0, error: null, at: null, clearedGuilds: 0 };
const botStartedAt = Date.now();

/* ---------------------------------------------------------------------------
 * Crash guards: a stray async error must log, not restart the bot
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
client.on(Events.Error, (err) => console.error('[discord client error]', err.message));
client.on(Events.Warn, (msg) => console.warn('[discord warn]', msg));
client.on(Events.ShardDisconnect, (ev, id) => console.warn(`[discord] shard ${id} disconnected (${ev?.code}), discord.js will reconnect`));
client.on(Events.ShardReconnecting, (id) => console.warn(`[discord] shard ${id} reconnecting…`));
client.on(Events.ShardResume, (id) => console.log(`[discord] shard ${id} resumed`));

/* ---------------------------------------------------------------------------
 * Web server: keep-alive, health, dashboard
 * ------------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.type('text/plain').send('TV Tracker is running.');
});

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    discordReady: client.isReady(),
    storage: isStorageHealthy() ? 'ok' : 'unavailable',
    simkl: simkl.isConfigured() ? 'configured' : 'missing SIMKL_CLIENT_ID',
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
  })
);

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
    previous.reason = 'unexpected (crash, out-of-memory, or hard kill)';
    console.warn('Previous run ended unexpectedly (no clean shutdown recorded). Check your host logs around', previous.startedAt);
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
  console.log(`${signal} received, shutting down cleanly…`);
  const hardExit = setTimeout(() => process.exit(0), 8000);
  hardExit.unref();
  try {
    if (currentBoot) {
      currentBoot.endedAt = new Date().toISOString();
      currentBoot.reason = signal === 'SIGTERM' ? 'clean stop (deploy or restart)' : `clean stop (${signal})`;
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

// Memory watch: shed caches if the process gets large.
setInterval(() => {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMB > 380) {
    console.warn(`[memory] RSS ${rssMB} MB, clearing caches`);
    detailsCache.clear();
  } else {
    console.log(`[memory] RSS ${rssMB} MB`);
  }
}, 15 * 60 * 1000).unref();

// Registers the global slash commands, then removes any old server-only copies.
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

// One-time cleanup when the bot moved from AniList to Simkl. Old AniList ids
// mean nothing to Simkl, so tracked entries, sign-ins and lists are reset.
function migrateToSimkl(data) {
  if (data.simklMigrated) return false;
  for (const guildData of Object.values(data.guilds)) {
    guildData.users = (guildData.users || []).filter((u) => u.discordId);
    guildData.recommendations = {};
    guildData.recentPosts = {};
  }
  data.globalRecommendations = {};
  data.trackingOptOut = {};
  data.linkedAccounts = Object.fromEntries(Object.entries(data.linkedAccounts || {}).filter(([, a]) => a.token));
  data.userLists = {};
  data.simklMigrated = true;
  return true;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}, in ${client.guilds.cache.size} server(s)`);
  console.log(`Invite link: ${getInviteUrl()}`);
  if (!simkl.isConfigured()) {
    console.warn('SIMKL_CLIENT_ID is not set. Sign-in and tracking will say so until it is added.');
  }
  await syncCommands();

  const data = await loadData();
  if (migrateToSimkl(data)) {
    await saveData(data);
    console.log('Migrated stored data from AniList to Simkl (old AniList entries cleared).');
  }
  isPaused = data.botPaused;
  if (isPaused) console.log('Polling starting PAUSED (resume from the dashboard to enable it).');
  pollAllGuilds();
  setInterval(pollAllGuilds, POLL_INTERVAL_MS);
  notifyRelaunch();
});

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */
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

function ensureUserLists(data, userId) {
  if (!data.userLists[userId]) data.userLists[userId] = { watchlist: [], favorites: [] };
  const lists = data.userLists[userId];
  if (!Array.isArray(lists.watchlist)) lists.watchlist = [];
  if (!Array.isArray(lists.favorites)) lists.favorites = [];
  return lists;
}

function isOptedOut(data, discordId) {
  return Boolean(data.trackingOptOut[discordId]);
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

// Replies (or edits a deferred reply) without ever throwing.
async function respond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      const { flags, ...rest } = typeof payload === 'string' ? { content: payload } : payload;
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

function titleKey(kind, id) {
  return `${kind}_${id}`;
}

function parseKey(key) {
  const [kind, id] = String(key).split('_');
  if (!KINDS.has(kind)) return null;
  const num = parseInt(id, 10);
  return num ? { kind, id: num, key: titleKey(kind, num) } : null;
}

// Fetches one title (cached briefly so buttons on the same post are quick).
async function fetchTitle(key) {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const cached = detailsCache.get(key);
  if (cached && Date.now() - cached.at < DETAILS_TTL_MS) return cached.title;
  const title = await simkl.getDetails(parsed.kind, parsed.id);
  if (title) boundedSet(detailsCache, key, { at: Date.now(), title });
  return title;
}

// Everything a signed-in person has watched, movies and shows together.
async function loadLibrary(token) {
  const [movies, shows] = await Promise.all([simkl.getWatched(token, 'movie'), simkl.getWatched(token, 'show')]);
  return [...movies, ...shows];
}

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
      const roles = await guild.roles.fetch().catch(() => null);
      const role = roles?.find((r) => r.name.toLowerCase() === PING_ROLE_NAME);
      if (!role) continue;
      await channel.send({
        content: `<@&${role.id}> 🔄 TV Tracker just restarted and is back online.`,
        allowedMentions: { roles: [role.id] },
      });
    } catch (e) {
      console.error(`Failed to send relaunch notice for server ${guildId}:`, e.message);
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
      .setTitle('📺 Thanks for adding TV Tracker!')
      .setDescription(
        [
          'I post movie and TV activity (what people finish and what they’re watching) right here in Discord.',
          '',
          '**Quick start**',
          '`/setchannel`: pick where watch posts go (needs Manage Server)',
          '`/signin`: link your Simkl account (a short code, no website)',
          '`/track user:@someone`: post a signed-in person’s watches',
          '`/find title:<name>`: look up any movie or show',
          '`/help`: everything else',
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
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleSlashCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
    else if (interaction.isModalSubmit()) await handleModalSubmit(interaction);
  } catch (err) {
    console.error('Unhandled error in interaction handler:', err);
    await respond(interaction, { content: 'Something went wrong. Try again in a bit.', flags: EPHEMERAL });
  }
});

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

    const ownerId = postInfo.discordId;
    if (!ownerId || reactingUser.id === ownerId) return;

    const emojiStr = reaction.emoji.toString();
    const dedupeKey = `${message.id}:${reactingUser.id}:${reaction.emoji.id || reaction.emoji.name}`;
    const now = Date.now();
    if (now - (reactionDmSeen.get(dedupeKey) || 0) < REACTION_DM_DEDUPE_MS) return;
    reactionDmSeen.set(dedupeKey, now);
    if (reactionDmSeen.size > 2000) reactionDmSeen.delete(reactionDmSeen.keys().next().value);

    const sourceEmbed = message.embeds[0];
    const cover = postInfo.cover || sourceEmbed?.image?.url || null;
    const titleName = postInfo.title || 'your watch';
    const titleLink = postInfo.siteUrl ? `[${titleName}](${postInfo.siteUrl})` : `**${titleName}**`;
    const color = sourceEmbed?.color ?? DEFAULT_COLOR;
    const guildIcon = message.guild.iconURL({ size: 64 }) || undefined;
    const jumpRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to post').setEmoji('↗️').setURL(message.url)
    );

    const owner = await client.users.fetch(ownerId).catch(() => null);
    if (owner) {
      const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: `${reactingUser.displayName || reactingUser.username} reacted ${emojiStr}`, iconURL: reactingUser.displayAvatarURL({ size: 64 }) })
        .setDescription(`<@${reactingUser.id}> reacted ${emojiStr} to your post about ${titleLink}\n\n🏠 **${message.guild.name}** · <#${message.channelId}>`)
        .setFooter({ text: message.guild.name, iconURL: guildIcon })
        .setTimestamp(new Date());
      if (cover) embed.setThumbnail(cover);
      await owner.send({ embeds: [embed], components: [jumpRow], allowedMentions: { parse: [] } }).catch((e) =>
        console.error(`Failed to DM ${ownerId}:`, e.message)
      );
    }

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
    await respond(interaction, { content: 'TV Tracker commands only work inside a server.', flags: EPHEMERAL });
    return;
  }

  // Modals must be shown as the very first response.
  if (commandName === 'feedback') {
    await handleFeedbackCommand(interaction);
    return;
  }

  const data = await loadData();
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
      case 'find':
        return await handleFind(interaction, data);
      case 'watchlater':
        return await handleMyList(interaction, data, 'watchlist');
      case 'myfavorites':
        return await handleMyList(interaction, data, 'favorites');
      case 'recommend':
        return await handleRecommend(interaction, guildData, data);
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
        return await respond(interaction, { content: 'Unknown command. Try `/help`.', flags: EPHEMERAL });
    }
  } catch (err) {
    console.error(`Error handling /${commandName}:`, err);
    await respond(interaction, { content: 'Something went wrong. Try again in a bit.', flags: EPHEMERAL });
  }
}

const simklDownMessage = '⚠️ Simkl isn’t responding right now (this is on Simkl’s side). Try again in a few minutes.';

async function handleTrack(interaction, data, guildData) {
  const target = interaction.options.getUser('user');
  if (!(await safeDefer(interaction, false))) return;

  if (target.bot) {
    await respond(interaction, { content: 'Bots don’t watch anything.', flags: EPHEMERAL });
    return;
  }
  const account = data.linkedAccounts[target.id];
  if (!account?.token) {
    await respond(interaction, {
      content: `**${target.username}** hasn’t linked Simkl yet. They can run \`/signin\`, then you can run \`/track\` again.`,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (guildData.users.some((u) => u.discordId === target.id)) {
    await respond(interaction, { content: `Already tracking **${account.name}** in this server.`, allowedMentions: { parse: [] } });
    return;
  }

  // Start from their current history, so only what they watch from now on posts.
  let baseline = null;
  try {
    const library = await loadLibrary(account.token);
    baseline = simkl.latestWatch(library) || new Date().toISOString();
  } catch (e) {
    console.error('Simkl lookup failed in /track:', e.message);
    const expired = e.status === 401;
    await respond(interaction, {
      content: expired
        ? `**${target.username}**’s Simkl sign-in has expired. They need to run \`/signin\` again.`
        : simklDownMessage,
      allowedMentions: { parse: [] },
    });
    return;
  }

  guildData.users.push({
    discordId: target.id,
    name: account.name,
    avatar: account.avatar || null,
    siteUrl: account.siteUrl || null,
    addedBy: interaction.user.id,
    watchedAt: baseline,
    stamps: null,
  });
  if (!guildData.channelId) guildData.channelId = interaction.channelId;
  await saveData(data);

  const lines = [`✅ Now tracking **${account.name}**. New watches will post in <#${guildData.channelId}> and quietly ping <@${interaction.user.id}>.`];
  const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
  const missing = missingChannelPerms(channel);
  if (missing.length) {
    lines.push(`\n⚠️ I can’t post in <#${guildData.channelId}> yet. I’m missing **${missing.map(prettyPerm).join(', ')}** there. Fix my permissions or use \`/setchannel\`.`);
  }
  if (isOptedOut(data, target.id)) {
    lines.push('\n⏸️ This person has turned their live posts **off** (`/tracking`), so nothing will post until they turn it back on.');
  }
  await respond(interaction, { content: lines.join('\n'), allowedMentions: { parse: [] } });
}

async function handleUntrack(interaction, data, guildData) {
  const target = interaction.options.getUser('user');
  const entry = guildData.users.find((u) => u.discordId === target.id);
  if (!entry) {
    await respond(interaction, { content: `Wasn’t tracking **${target.username}** here.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    return;
  }

  // Who may untrack: whoever started tracking, the person themselves, or a server manager.
  const allowed =
    entry.addedBy === interaction.user.id ||
    entry.discordId === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!allowed) {
    await respond(interaction, {
      content: `Only <@${entry.addedBy}> (who started tracking **${entry.name}**), **${entry.name}** themselves, or someone with **Manage Server** can untrack them.`,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
    return;
  }

  guildData.users = guildData.users.filter((u) => u !== entry);
  await saveData(data);
  await respond(interaction, { content: `🗑️ Stopped tracking **${entry.name}**.`, allowedMentions: { parse: [] } });
}

function trackedLine(data, u, trackerLabel) {
  const paused = isOptedOut(data, u.discordId) ? ' ⏸️' : '';
  const linked = data.linkedAccounts[u.discordId]?.token ? '' : ' ⚠️ sign-in expired';
  const name = u.siteUrl ? `[${u.name}](${u.siteUrl})` : `**${u.name}**`;
  return `• ${name}${paused}${linked}${trackerLabel ? ` · ${trackerLabel}` : ''}`;
}

async function handleList(interaction, data, guildData) {
  if (!guildData.users.length) {
    await respond(interaction, { content: 'Not tracking anyone yet. Use `/track user:@someone` for a signed-in person.' });
    return;
  }
  const lines = guildData.users.map((u) => trackedLine(data, u, u.addedBy ? `<@${u.addedBy}>` : null));
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle(`📋 Tracked people (${guildData.users.length})`)
    .setDescription(`${guildData.channelId ? `Posting in <#${guildData.channelId}>\n\n` : ''}${lines.join('\n')}`.slice(0, 4096))
    .setFooter({ text: '⏸️ = turned live posts off · ⚠️ = needs /signin again' });
  await respond(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
}

// Same as /list, with plain names (no mentions at all).
async function handleWhosTracking(interaction, data, guildData) {
  if (!guildData.users.length) {
    await respond(interaction, { content: 'Not tracking anyone yet.' });
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
  const embed = new EmbedBuilder().setColor(DEFAULT_COLOR).setTitle("📋 Who's tracking what").setDescription(lines.join('\n').slice(0, 4096));
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
      content: `⚠️ I can’t post in <#${channel.id}>. I’m missing **${missing.map(prettyPerm).join(', ')}** there. Give me those and run this again.`,
      flags: EPHEMERAL,
    });
    return;
  }
  guildData.channelId = channel.id;
  await saveData(data);
  await respond(interaction, { content: `✅ Watch posts will now go to <#${channel.id}>.` });
}

/* ----- /find: look up a movie or show ----- */
async function handleFind(interaction, data) {
  const text = interaction.options.getString('title').trim();
  if (!simkl.isConfigured()) {
    await respond(interaction, { content: '🔧 Simkl isn’t set up for this bot yet (SIMKL_CLIENT_ID is missing).', flags: EPHEMERAL });
    return;
  }
  if (!(await safeDefer(interaction, false))) return;
  let results;
  try {
    results = await simkl.searchTitles(text, 'all', 5);
  } catch (e) {
    console.error('Simkl search failed:', e.message);
    await respond(interaction, { content: simklDownMessage });
    return;
  }
  if (!results.length) {
    await respond(interaction, { content: `No movies or shows matched **${text}**. Try fewer words, or add the year (for example “Dune 2021”).`, allowedMentions: { parse: [] } });
    return;
  }
  const best = results[0];
  boundedSet(detailsCache, best.key, { at: Date.now(), title: best });
  const color = await getDominantColor(best.poster).catch(() => DEFAULT_COLOR);
  const panel = buildTitleCard(best, data, color);
  const others = results.slice(1);
  if (others.length) {
    panel.embeds[0].addFields({
      name: 'Other matches',
      value: others.map((t) => `• [${t.title}${t.year ? ` (${t.year})` : ''}](${t.siteUrl}) · ${t.kind === 'movie' ? 'Movie' : 'TV'}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }
  await respond(interaction, panel);
}

/* ----- /watchlater and /myfavorites: one list per person, across servers ----- */
async function handleMyList(interaction, data, field) {
  const list = ensureUserLists(data, interaction.user.id)[field];
  const isWatch = field === 'watchlist';
  const icon = isWatch ? '📌' : '🤍';
  const name = isWatch ? 'Watch Later' : 'Favorites';

  if (!list.length) {
    await respond(interaction, {
      content: isWatch
        ? 'Your watch later list is empty. Click 📌 **Watch later** on any post or `/find` result to add one!'
        : 'Your favorites list is empty. Click 🤍 **Favorite** on any post or `/find` result to add one!',
      flags: EPHEMERAL,
    });
    return;
  }

  const lines = [];
  let length = 0;
  for (let i = 0; i < list.length; i++) {
    const line = `\`${String(i + 1).padStart(2, ' ')}\` **[${list[i].title}](${list[i].siteUrl})**${list[i].year ? ` (${list[i].year})` : ''}`;
    if (length + line.length > 3800) {
      lines.push(`…and **${list.length - i}** more`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle(`${icon} Your ${name} · ${list.length}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Only you can see this • Click ${icon} again on a post to remove it` });
  if (list[0]?.cover) embed.setThumbnail(list[0].cover);
  await respond(interaction, { embeds: [embed], flags: EPHEMERAL });
}

/* ----- /recommend ----- */
function buildRecommendEntries(recsObj) {
  return Object.entries(recsObj || {})
    .filter(([, r]) => r.title && r.recommendedBy && r.recommendedBy.length > 0)
    .map(([key, r]) => ({ key, title: r.title, year: r.year, siteUrl: r.siteUrl, count: r.recommendedBy.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function buildRecommendEmbed(scope, guildData, data) {
  const isGlobal = scope === 'global';
  const entries = buildRecommendEntries(isGlobal ? data.globalRecommendations : guildData.recommendations);
  const scopeLabel = isGlobal ? '🌍 Global' : '🏠 This Server';

  const embed = new EmbedBuilder()
    .setColor(RECOMMEND_EMBED_COLOR)
    .setTitle('⭐ Most Recommended')
    .setFooter({ text: `Showing: ${scopeLabel}. Use the menu below to switch.` })
    .setTimestamp(new Date());

  if (!entries.length) {
    embed.setDescription(
      `No recommendations ${isGlobal ? 'anywhere' : 'in this server'} yet. Click ⭐ **Recommend** on a post to start the leaderboard!`
    );
    return embed;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const totalVotes = entries.reduce((sum, e) => sum + e.count, 0);
  embed.setDescription(`**${scopeLabel}**  •  ${totalVotes} total ${totalVotes === 1 ? 'vote' : 'votes'} across ${entries.length} title${entries.length === 1 ? '' : 's'}`);
  entries.forEach((e, i) => {
    embed.addFields({
      name: `${medals[i] || `#${i + 1}`}  ${e.title}${e.year ? ` (${e.year})` : ''}`.slice(0, 256),
      value: `[View on Simkl ↗](${e.siteUrl})\n**${e.count}** ${e.count === 1 ? 'vote' : 'votes'}`,
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

async function handleRecommend(interaction, guildData, data) {
  const scope = 'guild';
  await respond(interaction, { embeds: [buildRecommendEmbed(scope, guildData, data)], components: [buildRecommendScopeRow(scope)] });
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== 'recscope' || !interaction.guildId) return;
  const data = await loadData();
  const guildData = ensureGuildData(data, interaction.guildId);
  const scope = interaction.values[0] === 'global' ? 'global' : 'guild';
  const payload = { embeds: [buildRecommendEmbed(scope, guildData, data)], components: [buildRecommendScopeRow(scope)] };

  // Only the person who ran the command switches the shared message.
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

/* ----- /signin, /signout: Simkl device-code sign-in (no website) ----- */
async function handleSignIn(interaction, data) {
  if (!simkl.isConfigured()) {
    await respond(interaction, { content: '🔧 Simkl sign-in isn’t switched on for this bot yet. The developer needs to add SIMKL_CLIENT_ID.', flags: EPHEMERAL });
    return;
  }
  const linked = data.linkedAccounts[interaction.user.id];
  if (linked?.token) {
    const embed = new EmbedBuilder()
      .setColor(DEFAULT_COLOR)
      .setTitle('🔐 You’re signed in')
      .setDescription(`Linked to **[${linked.name}](${linked.siteUrl || 'https://simkl.com'})**.\n\nTo switch accounts, run \`/signout\` first, then \`/signin\` again.`);
    if (linked.avatar) embed.setThumbnail(linked.avatar);
    await respond(interaction, { embeds: [embed], flags: EPHEMERAL });
    return;
  }

  if (!(await safeDefer(interaction, true))) return;
  let login;
  try {
    login = await simkl.startDeviceLogin();
  } catch (e) {
    console.error('Simkl sign-in start failed:', e.message);
    await respond(interaction, { content: simklDownMessage, flags: EPHEMERAL });
    return;
  }

  const minutes = Math.max(1, Math.round(login.expiresIn / 60));
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('🔐 Sign in to Simkl')
    .setDescription(
      [
        `1. Open **${login.verificationUrl}**`,
        `2. Enter this code: **\`${login.userCode}\`**`,
        '3. Approve TV Tracker. I’ll notice and finish here.',
        '',
        `The code expires in about ${minutes} minutes. Only you can see this message.`,
        'TV Tracker only reads your watch history. It never changes your Simkl lists.',
      ].join('\n')
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Simkl').setEmoji('🔐').setURL(login.verificationUrl)
  );
  await respond(interaction, { embeds: [embed], components: [row] });
  watchDeviceLogin(interaction, login);
}

// Polls Simkl until the person approves, the code expires, or they say no.
function watchDeviceLogin(interaction, login) {
  const discordId = interaction.user.id;
  const deadline = Date.now() + login.expiresIn * 1000;
  let waitMs = login.interval * 1000;
  if (pendingLogins.has(discordId)) clearTimeout(pendingLogins.get(discordId));

  const finish = async (embed) => {
    pendingLogins.delete(discordId);
    const payload = { embeds: [embed], components: [] };
    try {
      await interaction.editReply(payload);
    } catch {
      await interaction.user.send(payload).catch(() => {});
    }
  };

  const schedule = (ms) => {
    const timer = setTimeout(tick, ms);
    timer.unref?.();
    pendingLogins.set(discordId, timer);
  };

  const tick = async () => {
    pendingLogins.delete(discordId);
    if (Date.now() > deadline) {
      await finish(new EmbedBuilder().setColor(0xfb7185).setTitle('⌛ Code expired').setDescription('Run `/signin` again to get a new code.'));
      return;
    }
    try {
      const result = await simkl.pollDeviceLogin(login.deviceCode);
      if (result.state === 'pending') return schedule(waitMs);
      if (result.state === 'slow_down') {
        waitMs += 5000;
        return schedule(waitMs);
      }
      if (result.state === 'denied') {
        await finish(new EmbedBuilder().setColor(0xfb7185).setTitle('Sign-in cancelled').setDescription('You said no on Simkl, so nothing was linked.'));
        return;
      }
      if (result.state === 'expired') {
        await finish(new EmbedBuilder().setColor(0xfb7185).setTitle('⌛ Code expired').setDescription('Run `/signin` again to get a new code.'));
        return;
      }
      // Approved: find out whose account it is and save it.
      const account = await simkl.getAccount(result.token);
      const data = await loadData();
      data.linkedAccounts[discordId] = {
        token: result.token,
        simklId: account.id,
        name: account.name,
        avatar: account.avatar,
        siteUrl: account.siteUrl,
        linkedAt: new Date().toISOString(),
      };
      await saveData(data);
      const done = new EmbedBuilder()
        .setColor(0x34d399)
        .setTitle('✅ Simkl linked')
        .setDescription(`Linked to **[${account.name}](${account.siteUrl})**.\n\nUse \`/tracking\` in any server to turn your live posts on or off.`);
      if (account.avatar) done.setThumbnail(account.avatar);
      await finish(done);
    } catch (e) {
      console.error('Simkl sign-in check failed:', e.message);
      if (Date.now() < deadline) return schedule(waitMs);
      await finish(new EmbedBuilder().setColor(0xfb7185).setTitle('Sign-in didn’t finish').setDescription('Simkl didn’t answer in time. Run `/signin` again.'));
    }
  };

  schedule(waitMs);
}

async function handleSignOut(interaction, data) {
  const linked = data.linkedAccounts[interaction.user.id];
  if (!linked) {
    await respond(interaction, { content: 'You’re not signed in. Use `/signin` to link your Simkl account.', flags: EPHEMERAL });
    return;
  }
  delete data.linkedAccounts[interaction.user.id];
  await saveData(data);
  await respond(interaction, {
    content: `👋 Unlinked **${linked.name}** from your Discord account. Nothing will post for you until you sign in again.`,
    flags: EPHEMERAL,
  });
}

/* ----- /tracking (live posts on/off, owner only) ----- */
function trackedInGuilds(data, discordId) {
  const names = [];
  for (const [guildId, g] of Object.entries(data.guilds)) {
    if ((g.users || []).some((u) => u.discordId === discordId)) names.push(client.guilds.cache.get(guildId)?.name || 'a server');
  }
  return names;
}

function buildTrackingPanel(data, discordId, account) {
  const off = isOptedOut(data, discordId);
  const servers = trackedInGuilds(data, discordId);
  const serverLine = servers.length
    ? `Tracked in **${servers.length}** server${servers.length === 1 ? '' : 's'}: ${servers.slice(0, 10).join(', ')}${servers.length > 10 ? '…' : ''}`
    : 'Nobody is tracking you right now.';

  const embed = new EmbedBuilder()
    .setColor(off ? 0xfb7185 : 0x34d399)
    .setAuthor({ name: account.name, iconURL: account.avatar || undefined, url: account.siteUrl || undefined })
    .setTitle(off ? '🔴 Live posts are OFF' : '🟢 Live posts are ON')
    .setDescription(
      [
        off
          ? 'Your watches are **not** being posted in any server. Turning it back on starts from your *next* watch. Nothing you watched while it was off gets posted.'
          : 'Your watches are posted in every server tracking you.',
        '',
        serverLine,
      ].join('\n')
    )
    .setFooter({ text: 'Only you can change this. It applies everywhere.' });

  const row = new ActionRowBuilder().addComponents(
    off
      ? new ButtonBuilder().setCustomId('trk_on').setLabel('Turn on').setEmoji('🟢').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('trk_off').setLabel('Turn off').setEmoji('🔴').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}

async function setLiveActivity(data, discordId, account, on, byUserId) {
  if (on) {
    if (!data.trackingOptOut[discordId]) return;
    delete data.trackingOptOut[discordId];
    // Skip anything watched while it was off: move each tracked entry to now.
    const nowIso = new Date().toISOString();
    for (const g of Object.values(data.guilds)) {
      for (const u of g.users || []) if (u.discordId === discordId) u.watchedAt = nowIso;
    }
  } else {
    data.trackingOptOut[discordId] = { since: new Date().toISOString(), by: byUserId };
  }
  await saveData(data);
}

async function handleTracking(interaction, data) {
  const account = data.linkedAccounts[interaction.user.id];
  if (!account?.token) {
    const embed = new EmbedBuilder()
      .setColor(DEFAULT_COLOR)
      .setTitle('🔐 Sign in first')
      .setDescription('Link your Simkl account with `/signin`, then run `/tracking` again.');
    await respond(interaction, { embeds: [embed], flags: EPHEMERAL });
    return;
  }

  const status = interaction.options.getString('status');
  if (status === 'on' || status === 'off') {
    if (!(await safeDefer(interaction, true))) return;
    await setLiveActivity(data, interaction.user.id, account, status === 'on', interaction.user.id);
  }
  await respond(interaction, { ...buildTrackingPanel(data, interaction.user.id, account), flags: EPHEMERAL });
}

async function handleTrackingButton(interaction, on) {
  const data = await loadData();
  const account = data.linkedAccounts[interaction.user.id];
  if (!account?.token) {
    await respond(interaction, { content: 'You need to `/signin` first.', flags: EPHEMERAL });
    return;
  }
  try {
    await interaction.deferUpdate();
  } catch {
    return;
  }
  await setLiveActivity(data, interaction.user.id, account, on, interaction.user.id);
  await interaction.editReply(buildTrackingPanel(data, interaction.user.id, account)).catch((e) => console.error('Failed to refresh tracking panel:', e.message));
}

/* ----- /help ----- */
async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('📺 TV Tracker commands')
    .addFields(
      {
        name: '📡 Tracking',
        value: [
          '`/track` · post a signed-in person’s watches here',
          '`/untrack` · stop tracking someone',
          '`/list` · `/whostracking` · who’s tracked here',
          '`/setchannel` · where posts go *(Manage Server)*',
        ].join('\n'),
      },
      {
        name: '🔐 Your account',
        value: ['`/signin` · `/signout` · link or unlink Simkl (short code)', '`/tracking` · turn your live posts on or off'].join('\n'),
      },
      {
        name: '🎬 Discover',
        value: ['`/find` · look up any movie or show', '`/recommend` · most-recommended leaderboard', '`/watchlater` · `/myfavorites` · your private lists'].join('\n'),
      },
      { name: '💬 Other', value: '`/feedback` · rate TV Tracker and tell the developer anything\n`/update` · post an update notice silently *(Manage Server)*' },
      {
        name: '🔘 Buttons on posts',
        value: '⭐ Recommend · 🤍 Favorite · 📌 Watch later · ℹ️ More info (only you see it)\nReact to a post and its owner gets a private DM.',
      }
    )
    .setFooter({ text: 'Movies and TV only. Anime is not included.' });
  const invite = getInviteUrl();
  const components = invite
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Add TV Tracker to a server').setURL(invite))]
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
    await respond(interaction, { content: `I can’t post in <#${channel.id}>. I’m missing **${missing.map(prettyPerm).join(', ')}**.`, flags: EPHEMERAL });
    return;
  }

  const embed = new EmbedBuilder().setColor(DEFAULT_COLOR).setTimestamp(new Date());
  if (custom) {
    embed
      .setAuthor({ name: 'TV Tracker update', iconURL: client.user.displayAvatarURL({ size: 64 }) })
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
      flags: MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    await respond(interaction, { content: `Couldn’t post: ${e.message}`, flags: EPHEMERAL });
    return;
  }
  await respond(interaction, { content: `🔕 Posted ${custom ? 'your update' : 'the latest changelog'} silently in <#${channel.id}>.`, flags: EPHEMERAL });
}

/* ----- /feedback ----- */
async function handleFeedbackCommand(interaction) {
  const data = await loadData();
  const last = data.feedback.find((f) => f.userId === interaction.user.id);
  if (last && Date.now() - new Date(last.createdAt).getTime() < feedback.COOLDOWN_MS) {
    await respond(interaction, { content: '⏳ You just sent feedback. Give it a minute before sending more.', flags: EPHEMERAL });
    return;
  }
  try {
    await interaction.showModal(feedback.buildFeedbackModal());
  } catch (e) {
    console.error('Failed to show feedback modal:', e.message);
    await respond(interaction, { content: 'Couldn’t open the feedback form. Please try again.', flags: EPHEMERAL });
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
 * Title cards, posts and buttons
 * ------------------------------------------------------------------------- */
function synopsisOf(title, max = 160) {
  const text = (title.overview || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function buildInfoLine(title) {
  const bits = [];
  if (title.rating) bits.push(`⭐ ${title.rating.toFixed(1)}/10`);
  if (title.genres?.length) bits.push(`🎭 ${title.genres.slice(0, 3).join(', ')}`);
  return bits.join('  •  ');
}

// The public card for one title, used by /find and as a reusable result.
function buildTitleCard(title, data, color) {
  const embed = new EmbedBuilder()
    .setColor(color || DEFAULT_COLOR)
    .setAuthor({ name: title.kind === 'movie' ? '🎬 Movie' : '📺 TV show' })
    .setTitle(`${title.title}${title.year ? ` (${title.year})` : ''}`)
    .setURL(title.siteUrl);
  const info = buildInfoLine(title);
  const synopsis = synopsisOf(title);
  embed.setDescription([info, synopsis].filter(Boolean).join('\n\n') || '*No description yet.*');
  if (title.poster) embed.setImage(title.poster);
  const rec = data ? recCountFor(data, title.key) : 0;
  embed.setFooter({ text: rec ? `⭐ ${rec} ${rec === 1 ? 'recommendation' : 'recommendations'} · Data from Simkl` : 'Data from Simkl' });
  return { embeds: [embed], components: [buildTitleButtons(title.key, rec)] };
}

function recCountFor(data, key) {
  return data.globalRecommendations?.[key]?.recommendedBy?.length || 0;
}

function buildTitleButtons(key, recommendCount = 0) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rec_${key}`).setLabel(recommendCount ? `Recommend (${recommendCount})` : 'Recommend').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`fav_${key}`).setLabel('Favorite').setEmoji('🤍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wl_${key}`).setLabel('Watch later').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`info_${key}`).setLabel('More info').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary)
  );
}

function buildWatchEmbed(user, title, item, color) {
  const embed = new EmbedBuilder().setTimestamp(new Date(item.watchedAt || Date.now()));
  const authorOpts = { name: `${user.name} watched`, url: user.siteUrl || undefined };
  if (user.avatar) authorOpts.iconURL = user.avatar;
  embed.setAuthor(authorOpts);

  const caption = title.kind === 'movie' ? '🎬 Watched' : '📺 Watched';
  let progress = '';
  if (title.kind === 'show' && item.watchedEpisodes) {
    progress = item.totalEpisodes ? ` · ${item.watchedEpisodes} of ${item.totalEpisodes} episodes` : ` · ${item.watchedEpisodes} episodes`;
  }
  const headerLine = `# [${title.title}${title.year ? ` (${title.year})` : ''}](${title.siteUrl})`;
  const parts = [`${caption}${progress}\n${headerLine}`];
  const info = buildInfoLine(title);
  if (info) parts.push(info);
  const synopsis = synopsisOf(title);
  if (synopsis) parts.push(synopsis);
  embed.setDescription(parts.join('\n\n'));
  embed.setColor(color || DEFAULT_COLOR).setFooter({ text: 'Data from Simkl' });
  if (title.poster) embed.setImage(title.poster);
  return embed;
}

async function handleButton(interaction) {
  const { customId } = interaction;
  if (customId === 'trk_on' || customId === 'trk_off') return handleTrackingButton(interaction, customId === 'trk_on');

  if (!interaction.guildId) return;
  const [action, kind, idStr] = customId.split('_');
  const key = `${kind}_${idStr}`;
  if (!['wl', 'fav', 'rec', 'info'].includes(action) || !parseKey(key)) return;

  if (!(await safeDefer(interaction, true))) return;

  const data = await loadData();
  const guildData = ensureGuildData(data, interaction.guildId);

  try {
    if (action === 'wl') await handleListToggleButton(interaction, data, key, 'watchlist');
    else if (action === 'fav') await handleListToggleButton(interaction, data, key, 'favorites');
    else if (action === 'rec') await handleRecommendButton(interaction, data, guildData, key);
    else if (action === 'info') await handleMoreInfoButton(interaction, key);
  } catch (err) {
    console.error(`Error handling button ${customId}:`, err);
    await respond(interaction, { content: 'Something went wrong. Try again in a bit.' });
  }
}

// Watch later and Favorite share one toggle. Lists are per person.
async function handleListToggleButton(interaction, data, key, field) {
  const list = ensureUserLists(data, interaction.user.id)[field];
  const isWatch = field === 'watchlist';
  const existingIndex = list.findIndex((e) => e.key === key);

  if (existingIndex !== -1) {
    const [removed] = list.splice(existingIndex, 1);
    await saveData(data);
    await respond(interaction, {
      content: isWatch ? `🗑️ Removed **${removed.title}** from your watch later list.` : `💔 Removed **${removed.title}** from your favorites.`,
    });
    return;
  }

  const title = await fetchTitle(key).catch(() => null);
  if (!title) {
    await respond(interaction, { content: '⚠️ Couldn’t reach Simkl to save that. Try again in a bit.' });
    return;
  }
  list.push({ key, title: title.title, year: title.year, siteUrl: title.siteUrl, cover: title.poster, addedAt: new Date().toISOString() });
  await saveData(data);
  await respond(interaction, {
    content: isWatch
      ? `📌 Added **${title.title}** to your watch later list (${list.length} total). See it with \`/watchlater\`.`
      : `🤍 Added **${title.title}** to your favorites (${list.length} total). See them with \`/myfavorites\`.`,
  });
}

async function handleRecommendButton(interaction, data, guildData, key) {
  const userId = interaction.user.id;
  if (!guildData.recommendations[key]) guildData.recommendations[key] = { title: null, year: null, siteUrl: null, recommendedBy: [] };
  const rec = guildData.recommendations[key];
  const alreadyRecommended = rec.recommendedBy.includes(userId);

  if (alreadyRecommended) {
    rec.recommendedBy = rec.recommendedBy.filter((id) => id !== userId);
  } else {
    if (!rec.title) {
      const title = await fetchTitle(key).catch(() => null);
      if (title) {
        rec.title = title.title;
        rec.year = title.year;
        rec.siteUrl = title.siteUrl;
      }
    }
    rec.recommendedBy.push(userId);
  }

  // Global tally: one vote per person per title. A vote leaves it only when removed in every server.
  if (!data.globalRecommendations[key]) {
    data.globalRecommendations[key] = { title: rec.title, year: rec.year, siteUrl: rec.siteUrl, recommendedBy: [] };
  }
  const globalRec = data.globalRecommendations[key];
  if (rec.title) {
    globalRec.title = rec.title;
    globalRec.year = rec.year;
    globalRec.siteUrl = rec.siteUrl;
  }
  if (alreadyRecommended) {
    const stillElsewhere = Object.values(data.guilds).some((g) => g.recommendations?.[key]?.recommendedBy?.includes(userId));
    if (!stillElsewhere) globalRec.recommendedBy = globalRec.recommendedBy.filter((id) => id !== userId);
  } else if (!globalRec.recommendedBy.includes(userId)) {
    globalRec.recommendedBy.push(userId);
  }
  await saveData(data);

  // Refresh the count on the button and footer.
  try {
    const newCount = rec.recommendedBy.length;
    const editPayload = { components: [buildTitleButtons(key, newCount)] };
    const existingEmbed = interaction.message.embeds[0];
    if (existingEmbed) {
      const footerText = existingEmbed.footer?.text?.replace(/^⭐ \d+ .*? · /, '') || 'Data from Simkl';
      editPayload.embeds = [EmbedBuilder.from(existingEmbed).setFooter({ text: newCount ? `⭐ ${newCount} ${newCount === 1 ? 'recommendation' : 'recommendations'} · ${footerText}` : footerText })];
    }
    await interaction.message.edit(editPayload);
  } catch (e) {
    console.error('Failed to update recommend display:', e.message);
  }

  // DM the post's owner on a fresh recommend.
  if (!alreadyRecommended) {
    const postInfo = guildData.recentPosts[interaction.message.id];
    const ownerId = postInfo?.discordId;
    if (ownerId && ownerId !== userId) {
      const owner = await client.users.fetch(ownerId).catch(() => null);
      if (owner) {
        const name = rec.title || postInfo.title || 'a title';
        const embed = new EmbedBuilder()
          .setColor(interaction.message.embeds[0]?.color ?? RECOMMEND_EMBED_COLOR)
          .setAuthor({ name: `${interaction.user.displayName || interaction.user.username} recommended it ⭐`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
          .setDescription(`<@${userId}> recommended **${rec.siteUrl ? `[${name}](${rec.siteUrl})` : name}** after your watch!\n\n🏠 **${interaction.guild.name}**`)
          .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL({ size: 64 }) || undefined })
          .setTimestamp(new Date());
        const cover = postInfo?.cover || interaction.message.embeds[0]?.image?.url;
        if (cover) embed.setThumbnail(cover);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to post').setEmoji('↗️').setURL(interaction.message.url)
        );
        await owner.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch((e) => console.error('Failed to DM recommend notification:', e.message));
      }
    }
  }

  await respond(interaction, {
    content: alreadyRecommended ? 'Removed your recommendation.' : `Thanks for recommending **${rec.title || 'this'}**! ⭐ See the leaderboard with \`/recommend\`.`,
  });
}

async function handleMoreInfoButton(interaction, key) {
  const title = await fetchTitle(key).catch(() => null);
  if (!title) {
    await respond(interaction, { content: simklDownMessage });
    return;
  }
  const color = await getDominantColor(title.poster).catch(() => DEFAULT_COLOR);
  const panel = buildMoreInfo(title, { color });
  await respond(interaction, { ...panel, flags: EPHEMERAL });
}

/* ---------------------------------------------------------------------------
 * Poller: check each signed-in, tracked person and post new watches
 * ------------------------------------------------------------------------- */
async function pollAllGuilds() {
  if (isPaused || !client.isReady()) return;
  if (pollRunning) {
    console.warn('Previous poll still running, skipping this tick.');
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
  if (!simkl.isConfigured()) return;
  const data = await loadData();

  // Same person tracked in several servers: check Simkl once per poll.
  const libraryCache = new Map();
  const libraryFor = (discordId, token) => {
    if (!libraryCache.has(discordId)) libraryCache.set(discordId, (async () => {
      const activity = await simkl.getActivities(token);
      return { activity, library: null };
    })());
    return libraryCache.get(discordId);
  };

  let changed = false;

  for (const guildId of Object.keys(data.guilds)) {
    if (isPaused) break;
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId || !guildData.users.length) continue;
    if (!client.guilds.cache.has(guildId)) continue;

    const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
    if (!channel) continue;
    const missing = missingChannelPerms(channel);
    if (missing.length) {
      if (!warnedChannels.has(channel.id)) {
        warnedChannels.add(channel.id);
        console.warn(`Can't post in #${channel.name} (${guildId}), missing ${missing.join(', ')}. Skipping until fixed.`);
      }
      continue;
    }
    warnedChannels.delete(channel.id);

    for (const user of [...guildData.users]) {
      if (isOptedOut(data, user.discordId)) continue;
      const account = data.linkedAccounts[user.discordId];
      if (!account?.token) {
        if (!warnedUnlinked.has(user.discordId)) {
          warnedUnlinked.add(user.discordId);
          console.warn(`${user.name} is tracked but isn't signed in. They need /signin again.`);
        }
        continue;
      }
      warnedUnlinked.delete(user.discordId);

      try {
        const cached = await libraryFor(user.discordId, account.token);
        const activity = cached.activity;
        // Nothing changed on Simkl since last time: skip the heavier library lookup.
        if (user.stamps && user.stamps.movies === activity.movies && user.stamps.shows === activity.shows) continue;

        if (!cached.library) cached.library = await loadLibrary(account.token);
        const library = cached.library;

        if (!user.watchedAt) user.watchedAt = simkl.latestWatch(library) || new Date().toISOString();
        const fresh = simkl.newWatches(library, user.watchedAt);

        for (const item of fresh) {
          const title = await fetchTitle(item.key).catch(() => null);
          const display = title || { ...item, siteUrl: item.siteUrl };
          const color = await getDominantColor(display.poster).catch(() => DEFAULT_COLOR);
          const embed = buildWatchEmbed({ ...user, avatar: account.avatar, siteUrl: account.siteUrl }, display, item, color);
          const sentMessage = await channel.send({
            content: user.addedBy ? `<@${user.addedBy}>` : undefined,
            embeds: [embed],
            components: [buildTitleButtons(item.key, recCountFor(data, item.key))],
            allowedMentions: user.addedBy ? { users: [user.addedBy] } : { parse: [] },
            // Quiet ping: the mention shows, but without a push notification.
            flags: user.addedBy ? MessageFlags.SuppressNotifications : undefined,
          });

          guildData.recentPosts[sentMessage.id] = {
            discordId: user.discordId,
            addedBy: user.addedBy || null,
            title: display.title,
            siteUrl: display.siteUrl,
            key: item.key,
            cover: display.poster || null,
          };
          // Advance per watch, so a failure halfway never re-posts earlier ones.
          user.watchedAt = user.watchedAt && Date.parse(user.watchedAt) > Date.parse(item.watchedAt) ? user.watchedAt : item.watchedAt;
          changed = true;
        }

        user.stamps = { movies: activity.movies, shows: activity.shows };
        changed = true;
      } catch (e) {
        if (e.status === 401) {
          console.warn(`Simkl rejected ${user.name}'s sign-in. They need /signin again.`);
        } else {
          console.error(`Failed polling ${user.name}:`, e.message);
        }
      }
    }

    const postKeys = Object.keys(guildData.recentPosts);
    if (postKeys.length > MAX_RECENT_POSTS) {
      for (const k of postKeys.slice(0, postKeys.length - MAX_RECENT_POSTS)) delete guildData.recentPosts[k];
      changed = true;
    }
  }

  if (changed) await saveData(data);
}

/* ---------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------- */
(async () => {
  if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN is not set. Cannot log in.');
    return;
  }
  await loadData();
  await recordBoot();
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (e) {
    console.error('Discord login failed:', e.message);
    await flushData();
    process.exit(1);
  }
})();

// Exposed only so the handlers can be exercised in isolation.
module.exports = {
  _internals: { client, app, handleSlashCommand, handleButton, handleModalSubmit, handleSelectMenu, pollOnce, buildWatchEmbed, buildTitleCard },
};
