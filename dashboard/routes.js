const crypto = require('crypto');
const express = require('express');
const { requireAuth, isAuthenticated, setSessionCookie, clearSessionCookie } = require('./auth');

// Discord snowflake IDs encode their creation time — no need to store a
// separate "postedAt" field on recentPosts entries just for the dashboard.
const DISCORD_EPOCH = 1420070400000n;
function snowflakeToDate(id) {
  try {
    const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
    return new Date(Number(ms));
  } catch {
    return null;
  }
}

// Channel the "AniTracker - Feedback" webhook posts into (Make.com relays
// Webflow site-feedback submissions there). Webhook URLs are write-only, so
// the dashboard reads this channel directly via the bot's own client.
const FEEDBACK_CHANNEL_ID = process.env.FEEDBACK_CHANNEL_ID || '1541620519911034910';
const VALID_FEEDBACK_STATUSES = new Set(['resolved', 'disputed', 'later']);

// Express 4 doesn't catch errors thrown by async route handlers — they
// become unhandled promise rejections (which could crash the whole bot).
// Every async route is wrapped so errors become a JSON 500 instead.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Parses a website feedback message's plain-text content, e.g.:
//   📩 New AniTracker Submission!
//   ⭐ Rating: 4/5
//   💬 Feedback/Question: ...
//   📧 Contact: ...
function parseFeedbackMessage(content) {
  const text = content || '';
  const ratingMatch = text.match(/⭐\s*Rating:\s*(\d+)\s*\/\s*5/i);
  const feedbackMatch = text.match(/💬\s*Feedback\/Question:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  const contactMatch = text.match(/📧\s*Contact:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  return {
    rating: ratingMatch ? Math.min(5, parseInt(ratingMatch[1], 10)) : null,
    content: feedbackMatch ? feedbackMatch[1].trim() : text.trim(),
    contact: contactMatch ? contactMatch[1].trim() : null,
  };
}

// Website (webhook) feedback. Returns [] on any failure rather than throwing.
async function fetchWebsiteFeedback(client, statusMap) {
  const channel = await client.channels.fetch(FEEDBACK_CHANNEL_ID).catch(() => null);
  if (!channel?.messages) return [];
  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!fetched) return [];
  return [...fetched.values()]
    .filter((m) => m.webhookId || /📩\s*New AniTracker Submission/i.test(m.content))
    .map((m) => ({
      id: m.id,
      source: 'website',
      title: null,
      ...parseFeedbackMessage(m.content),
      userName: null,
      userAvatar: null,
      guildName: null,
      postedAt: snowflakeToDate(m.id),
      status: statusMap[m.id] || null,
    }));
}

// /feedback command submissions, in the same shape.
function commandFeedback(data) {
  return data.feedback.map((f) => ({
    id: f.id,
    source: 'discord',
    rating: f.rating,
    title: f.title,
    content: f.message,
    contact: null,
    userId: f.userId,
    userName: f.userName,
    userAvatar: f.userAvatar,
    guildName: f.guildName,
    postedAt: f.createdAt,
    status: data.feedbackStatus[f.id] || null,
  }));
}

// client: the discord.js Client instance (for live guild/channel/user info)
// deps: { loadData, saveData, getPaused, setPaused, botStartedAt, getInviteUrl, storageBackend, isStorageHealthy }
function buildDashboardRouter(client, deps) {
  const { loadData, saveData, getPaused, setPaused, botStartedAt, getInviteUrl, storageBackend, isStorageHealthy } = deps;
  const router = express.Router();

  router.use(express.json({ limit: '100kb' }));

  // Discord ids -> readable usernames (cache first, then a bounded fetch).
  async function resolveUserNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = {};
    const toFetch = [];
    for (const id of unique) {
      const cached = client.users.cache.get(id);
      if (cached) out[id] = cached.username;
      else toFetch.push(id);
    }
    await Promise.all(
      toFetch.slice(0, 50).map(async (id) => {
        const u = await client.users.fetch(id).catch(() => null);
        if (u) out[id] = u.username;
      })
    );
    return out;
  }

  async function allFeedback() {
    const data = await loadData();
    const website = await fetchWebsiteFeedback(client, data.feedbackStatus);
    return [...commandFeedback(data), ...website].sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
  }

  // ---- Auth ----------------------------------------------------------
  router.post('/login', (req, res) => {
    const { password } = req.body || {};
    const expected = process.env.DASHBOARD_PASSWORD;
    if (!expected) {
      return res.status(500).json({ error: 'DASHBOARD_PASSWORD is not configured on the server.' });
    }
    // Constant-time compare so the password can't be guessed via timing.
    const a = crypto.createHash('sha256').update(String(password ?? '')).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (typeof password !== 'string' || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    setSessionCookie(res);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
  });

  // Everything below requires a valid session.
  router.use(requireAuth);

  // ---- Overview --------------------------------------------------------
  router.get(
    '/overview',
    wrap(async (req, res) => {
      const data = await loadData();
      const guildIds = Object.keys(data.guilds);
      const totalTrackedUsers = guildIds.reduce((sum, id) => sum + (data.guilds[id].users?.length || 0), 0);
      const totalRecommendations = Object.values(data.globalRecommendations || {}).reduce((s, r) => s + (r.recommendedBy?.length || 0), 0);

      const feedback = await allFeedback();
      const pendingFeedback = feedback.filter((f) => !f.status).length;
      const mem = process.memoryUsage();

      res.json({
        botTag: client.user?.tag || null,
        botAvatar: client.user?.displayAvatarURL?.({ size: 128 }) || null,
        totalServers: client.guilds.cache.size,
        totalTrackedUsers,
        totalRecommendations,
        linkedAccounts: Object.keys(data.linkedAccounts).length,
        botPaused: getPaused(),
        uptimeSeconds: Math.floor((Date.now() - botStartedAt) / 1000),
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        storage: { backend: storageBackend, healthy: isStorageHealthy() },
        pendingFeedback,
        inviteUrl: getInviteUrl ? getInviteUrl() : null,
        restarts: [...data.bootHistory].reverse().slice(0, 10),
      });
    })
  );

  // ---- Servers -----------------------------------------------------------
  router.get(
    '/servers',
    wrap(async (req, res) => {
      const data = await loadData();
      const servers = client.guilds.cache.map((guild) => {
        const guildData = data.guilds[guild.id];
        const channel = guildData?.channelId ? guild.channels.cache.get(guildData.channelId) : null;
        return {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL({ size: 64 }) || null,
          memberCount: guild.memberCount ?? null,
          trackedUserCount: guildData?.users?.length || 0,
          channelId: guildData?.channelId || null,
          channelName: channel ? `#${channel.name}` : null,
        };
      });
      servers.sort((a, b) => b.trackedUserCount - a.trackedUserCount);
      res.json({ servers });
    })
  );

  router.get(
    '/servers/:guildId/channels',
    wrap(async (req, res) => {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) return res.status(404).json({ error: 'Server not found (bot may have been removed).' });
      await guild.channels.fetch().catch(() => null); // fall back to cache if a fresh fetch fails
      const me = guild.members.me;
      const channels = guild.channels.cache
        .filter((c) => c.isTextBased && c.isTextBased() && !c.isThread() && !c.isVoiceBased?.())
        .filter((c) => !me || c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']))
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ channels });
    })
  );

  // ---- Tracked users ----------------------------------------------------
  router.get(
    '/users',
    wrap(async (req, res) => {
      const data = await loadData();
            const users = [];
      for (const [guildId, guildData] of Object.entries(data.guilds)) {
        const guild = client.guilds.cache.get(guildId);
        for (const u of guildData.users || []) {
          users.push({
            guildId,
            guildName: guild?.name || 'Unknown server',
            username: u.name,
            discordId: u.discordId,
            avatar: u.avatar || null,
            addedBy: u.addedBy || null,
            trackingOff: Boolean(data.trackingOptOut[u.discordId]),
            linked: Boolean(data.linkedAccounts[u.discordId]?.token),
          });
        }
      }
      const names = await resolveUserNames(users.map((u) => u.addedBy));
      for (const u of users) u.addedByName = names[u.addedBy] || null;
      users.sort((a, b) => a.username.localeCompare(b.username));
      res.json({ users, total: users.length });
    })
  );

  // ---- Recent activity ----------------------------------------------------
  router.get(
    '/activity',
    wrap(async (req, res) => {
      const data = await loadData();
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 300);
      const posts = [];
      for (const [guildId, guildData] of Object.entries(data.guilds)) {
        const guild = client.guilds.cache.get(guildId);
        for (const [messageId, info] of Object.entries(guildData.recentPosts || {})) {
          posts.push({
            guildId,
            guildName: guild?.name || 'Unknown server',
            messageId,
            title: info.title || null,
            cover: info.cover || null,
            addedBy: info.addedBy || null,
            postedAt: snowflakeToDate(messageId),
          });
        }
      }
      posts.sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1));
      const page = posts.slice(0, limit);
      const names = await resolveUserNames(page.map((p) => p.addedBy));
      for (const p of page) p.addedByName = names[p.addedBy] || null;
      res.json({ activity: page });
    })
  );

  // ---- Leaderboards ----------------------------------------------------
  router.get(
    '/leaderboards/recommended',
    wrap(async (req, res) => {
      const data = await loadData();
      const list = Object.entries(data.globalRecommendations || {})
        .filter(([, r]) => r.title && r.recommendedBy?.length)
        .map(([key, r]) => ({ key, title: r.title, siteUrl: r.siteUrl, count: r.recommendedBy.length }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);
      res.json({ list, note: 'Global — each person counts once per title, no matter how many servers they voted in.' });
    })
  );

  router.get(
    '/leaderboards/watched',
    wrap(async (req, res) => {
      const data = await loadData();
      const list = Object.entries(data.watchStats || {})
        .map(([key, s]) => ({ key, title: s.title, siteUrl: s.siteUrl, count: s.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);
      res.json({ list, note: 'Counts watch posts for each title, across all servers. Starts fresh after the move to Simkl.' });
    })
  );

  router.get(
    '/leaderboards/watchlater',
    wrap(async (req, res) => {
      const data = await loadData();
      const users = Object.entries(data.userLists || {})
        .filter(([, l]) => l.watchlist?.length)
        .map(([userId, l]) => ({ userId, count: l.watchlist.length, titles: l.watchlist }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
      const names = await resolveUserNames(users.map((u) => u.userId));
      for (const u of users) u.userName = names[u.userId] || null;
      res.json({ users });
    })
  );

  router.get(
    '/leaderboards/linked',
    wrap(async (req, res) => {
      const data = await loadData();
      const accounts = Object.entries(data.linkedAccounts || {}).map(([discordId, info]) => ({
        discordId,
        ...info,
        trackingOff: Boolean(data.trackingOptOut[discordId]),
      }));
      const names = await resolveUserNames(accounts.map((a) => a.discordId));
      for (const a of accounts) a.discordName = names[a.discordId] || null;
      accounts.sort((a, b) => new Date(b.linkedAt) - new Date(a.linkedAt));
      res.json({ accounts, note: 'People who linked their Simkl account with /signin.' });
    })
  );

  // ---- Feedback ----------------------------------------------------------
  router.get(
    '/feedback',
    wrap(async (req, res) => {
      res.json({ feedback: await allFeedback() });
    })
  );

  router.post(
    '/feedback/:id/status',
    wrap(async (req, res) => {
      const { status } = req.body || {};
      if (status !== null && status !== undefined && !VALID_FEEDBACK_STATUSES.has(status)) {
        return res.status(400).json({ error: 'status must be resolved, disputed, later, or null.' });
      }
      const data = await loadData();
      if (status === null || status === undefined) delete data.feedbackStatus[req.params.id];
      else data.feedbackStatus[req.params.id] = status;
      await saveData(data);
      res.json({ ok: true, status: status || null });
    })
  );

  // Only /feedback-command entries live in our storage, so only they can be deleted here.
  router.delete(
    '/feedback/:id',
    wrap(async (req, res) => {
      const data = await loadData();
      const before = data.feedback.length;
      data.feedback = data.feedback.filter((f) => f.id !== req.params.id);
      if (data.feedback.length === before) return res.status(404).json({ error: 'Not found (website feedback can only be deleted in Discord).' });
      delete data.feedbackStatus[req.params.id];
      await saveData(data);
      res.json({ ok: true });
    })
  );

  // ---- Send message ----------------------------------------------------
  router.post(
    '/send',
    wrap(async (req, res) => {
      const { guildId, channelId, message } = req.body || {};
      if (!guildId || !channelId || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'guildId, channelId, and message are all required.' });
      }
      if (message.length > 2000) return res.status(400).json({ error: 'Discord messages are limited to 2000 characters.' });
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Server not found.' });
      try {
        const channel = await guild.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'That channel is not a text channel.' });
        await channel.send({ content: message, allowedMentions: { parse: ['users', 'roles'] } }); // no accidental @everyone
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: `Failed to send: ${e.message}` });
      }
    })
  );

  // ---- Bot controls ----------------------------------------------------
  router.post(
    '/pause',
    wrap(async (req, res) => {
      setPaused(true);
      const data = await loadData();
      data.botPaused = true;
      await saveData(data);
      res.json({ ok: true, botPaused: true });
    })
  );

  router.post(
    '/resume',
    wrap(async (req, res) => {
      setPaused(false);
      const data = await loadData();
      data.botPaused = false;
      await saveData(data);
      res.json({ ok: true, botPaused: false });
    })
  );

  router.post(
    '/redeploy',
    wrap(async (req, res) => {
      const hookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
      if (!hookUrl) return res.status(500).json({ error: 'RENDER_DEPLOY_HOOK_URL is not configured on the server.' });
      try {
        const resp = await fetch(hookUrl, { method: 'POST', signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error(`Deploy hook returned ${resp.status}`);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: `Failed to trigger redeploy: ${e.message}` });
      }
    })
  );

  // Errors from any wrapped route land here.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error('[dashboard api]', req.method, req.path, err.stack || err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error — check the bot logs.' });
  });

  return router;
}

module.exports = { buildDashboardRouter };
