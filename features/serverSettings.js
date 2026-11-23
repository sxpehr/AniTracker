const { ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, PermissionFlagsBits, ActionRowBuilder } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const { ctx } = require('./ctx');
const { guildConfig } = require('./guildConfig');

/* ---------------------------------------------------------------------------
 * /serversettings — the admin panel (Manage Server only).
 *
 *  ┌ 🛡️ Server settings › 📡 Activity feed ─────────────┐
 *  │ [ jump to… ]                                         │
 *  │ settings for that page (menus apply instantly)       │
 *  └──────────────────────────────────────────────────────┘
 *
 * Pages: feed · recaps · members · other · health
 * ids: sv:open · sv:cat · sv:ch · sv:ping · sv:content · sv:mature · sv:burst · sv:rch ·
 *      sv:rch:same · sv:recaps · sv:tz · sv:lb · sv:rp:<week|month> ·
 *      sv:post:<week|month> · sv:auto · sv:perm · sv:relaunch · sv:role ·
 *      sv:role:auto · sv:nudge · sv:diag · sv:diag:now:<anilistId>
 * ------------------------------------------------------------------------- */

const PAGES = {
  feed: { label: 'Activity feed', emoji: '📡', description: 'Channel, pings, what gets posted, 18+ titles' },
  recaps: { label: 'Recaps & leaderboards', emoji: '🏆', description: 'Weekly/monthly recaps, recap channel, boards' },
  members: { label: 'Members', emoji: '👥', description: 'Auto-tracking, who can /track, restart pings' },
  other: { label: 'Reminders', emoji: '💬', description: 'Top.gg review / feedback reminders' },
  health: { label: 'Health check', emoji: '🩺', description: 'Why isn’t someone posting? Check here' },
};
const pageOf = new Map(); // userId -> page

function isManager(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function channelSelect(id, placeholder, current) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  if (current) menu.setDefaultChannels(current);
  return new ActionRowBuilder().addComponents(menu);
}

function roleSelect(id, placeholder, current) {
  const menu = new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1);
  if (current) menu.setDefaultRoles(current);
  return new ActionRowBuilder().addComponents(menu);
}

function onOff(id, placeholder, value, onLabel, offLabel, { onDesc, offDesc } = {}) {
  return ui.select(id, placeholder, [
    { label: onLabel, value: 'on', emoji: '🟢', description: onDesc, default: Boolean(value) },
    { label: offLabel, value: 'off', emoji: '⚪', description: offDesc, default: !value },
  ]);
}

async function permLine(channelId) {
  if (!channelId) return '⚠️ **No channel picked yet** — nothing posts until you choose one.';
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel) return `⚠️ <#${channelId}> no longer exists (or I can’t see it) — pick another.`;
  const missing = ctx.missingChannelPerms ? ctx.missingChannelPerms(channel) : [];
  return missing.length ? `⚠️ I’m missing **${missing.join(', ')}** in <#${channelId}>.` : `✅ Posting in <#${channelId}> — permissions look good.`;
}

async function pageBlocks(page, interaction) {
  const guildId = interaction.guildId;
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const cfg = guildConfig(s, guildId);
  const g = core.guilds[guildId] || {};
  const blocks = [];

  if (page === 'feed') {
    blocks.push(ui.text(`${ui.label('Activity channel')}\n-# ${await permLine(g.channelId)}`));
    blocks.push(channelSelect('sv:ch', 'Where AniList updates get posted…', g.channelId));
    blocks.push(ui.text(ui.label('Ping on each post')));
    blocks.push(
      ui.select('sv:ping', 'Mention on posts…', [
        { label: 'Quiet mention of whoever tracked it', value: 'quiet', emoji: '🔕', description: 'Shows the @, no sound or push notification (default)', default: cfg.ping !== 'off' },
        { label: 'No mention at all', value: 'off', emoji: '➖', default: cfg.ping === 'off' },
      ])
    );
    blocks.push(ui.text(ui.label('What gets posted')));
    blocks.push(
      ui.select(
        'sv:content',
        'Also post…',
        [
          { label: 'Status posts & messages', value: 'text', emoji: '💬', description: 'Text posts people write on AniList', default: cfg.postText },
          { label: 'Manga & chapter updates', value: 'manga', emoji: '📖', default: cfg.postManga },
        ],
        { min: 0, max: 2 }
      )
    );
    blocks.push(ui.text(ui.label('18+ titles')));
    blocks.push(
      ui.select('sv:mature', '18+ titles…', [
        { label: 'Cover as a spoiler', value: 'blur', emoji: '🌫️', description: 'Post it; the cover is blurred until clicked (default)', default: cfg.mature === 'blur' },
        { label: 'Show normally', value: 'show', emoji: '👁️', default: cfg.mature === 'show' },
        { label: 'Post without the cover', value: 'hide', emoji: '🙈', default: cfg.mature === 'hide' },
        { label: 'Don’t post them', value: 'skip', emoji: '🚫', default: cfg.mature === 'skip' },
      ])
    );
    blocks.push(ui.text(`${ui.label('Flood protection')}\n-# When someone has a pile of updates waiting (the bot was down, AniList was slow), only the newest few post on their own and the rest are bundled into one “caught up” post. Repeats of the same update are never posted twice.`));
    const burst = Number(cfg.burst) || 3;
    blocks.push(
      ui.select(
        'sv:burst',
        'Separate posts per person at once…',
        [1, 2, 3, 5, 8].map((n) => ({ label: `${n} post${n === 1 ? '' : 's'} at once, bundle the rest`, value: String(n), emoji: n === 3 ? '🛡️' : '📦', description: n === 3 ? 'Default' : undefined, default: burst === n }))
      )
    );
  }

  if (page === 'recaps') {
    const statsUi = require('./statsUi');
    blocks.push(
      ui.text(
        `${ui.label('Recap channel')}\n-# ${cfg.recapChannelId ? await permLine(cfg.recapChannelId) : `Same as the activity channel${g.channelId ? ` (<#${g.channelId}>)` : ''}`}`
      )
    );
    blocks.push(channelSelect('sv:rch', 'Post recaps in…', cfg.recapChannelId));
    if (cfg.recapChannelId) blocks.push(ui.actionRow(ui.button('sv:rch:same', 'Use the activity channel', { emoji: '↩️' })));
    blocks.push(ui.text(ui.label('Automatic server recaps')));
    blocks.push(
      ui.select(
        'sv:recaps',
        'Post automatically…',
        [
          { label: 'Weekly recap — every Monday', value: 'weekly', emoji: '📅', description: 'Last week’s hours, episodes, variety, completions', default: cfg.weeklyRecap },
          { label: 'Monthly recap — on the 1st', value: 'monthly', emoji: '🗓️', description: 'The same for the whole month', default: cfg.monthlyRecap },
        ],
        { min: 0, max: 2 }
      )
    );
    blocks.push(ui.select('sv:tz', 'Server time zone (when weeks & months start)…', social.TIMEZONES.map(([v, l]) => ({ label: l, value: v, default: cfg.timezone === v }))));
    blocks.push(
      ui.actionRow(
        ui.button('sv:rp:week', 'Preview weekly', { emoji: '👁️' }),
        ui.button('sv:rp:month', 'Preview monthly', { emoji: '👁️' }),
        ui.button('sv:post:week', 'Post last week now', { emoji: '📣', style: ui.ButtonStyle.Primary })
      )
    );
    const enabled = statsUi.guildBoards(s, guildId);
    blocks.push(ui.text(ui.label('Leaderboards in /leaderboard')));
    blocks.push(
      ui.select(
        'sv:lb',
        'Leaderboards…',
        Object.entries(statsUi.BOARDS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, description: v.adminNote, default: enabled.includes(k) })),
        { min: 0, max: Object.keys(statsUi.BOARDS).length }
      )
    );
  }

  if (page === 'members') {
    blocks.push(ui.text(ui.label('Auto-track people who sign in')));
    blocks.push(
      onOff('sv:auto', 'Auto-track…', cfg.autoTrack, 'On — /signin here also tracks them here', 'Off — someone has to /track them', {
        onDesc: 'Their activity starts posting right after they sign in',
      })
    );
    blocks.push(ui.text(ui.label('Who can /track other people')));
    blocks.push(
      ui.select('sv:perm', 'Who can /track…', [
        { label: 'Everyone', value: 'everyone', emoji: '🌍', default: cfg.trackPerm !== 'managers' },
        { label: 'Only managers', value: 'managers', emoji: '🛡️', description: 'Members can still track themselves', default: cfg.trackPerm === 'managers' },
      ])
    );
    blocks.push(ui.text(`${ui.label('Restart ping')}\n-# When the bot restarts, ping a role (at most every 12 hours) so people know to check their feed.`));
    blocks.push(onOff('sv:relaunch', 'Restart ping…', cfg.relaunchPing, 'On', 'Off'));
    blocks.push(ui.text(`-# Role: ${cfg.animeRoleId ? `<@&${cfg.animeRoleId}>` : 'a role named **anime** (if there is one)'}`));
    blocks.push(roleSelect('sv:role', 'Role to ping on restart…', cfg.animeRoleId));
    if (cfg.animeRoleId) blocks.push(ui.actionRow(ui.button('sv:role:auto', 'Use a role named “anime”', { emoji: '↩️' })));
  }

  if (page === 'other') {
    blocks.push(
      ui.text(
        `${ui.label('Top.gg & feedback reminders')}\n-# Now and then (5% of actions, at most every two weeks per person) members get a private card asking for a Top.gg review or feedback. Everyone can also opt out themselves.`
      )
    );
    blocks.push(onOff('sv:nudge', 'Reminders in this server…', cfg.nudges, 'Allow the occasional reminder', 'Never show reminders here'));
  }

  if (page === 'health') {
    blocks.push(ui.text(`${ui.label('Channel')}\n-# ${await permLine(g.channelId)}`));
    const users = (g.users || []).slice(0, 25);
    if (!users.length) blocks.push(ui.text('*Nobody is tracked here yet — `/track` someone, or have them `/signin`.*'));
    else {
      blocks.push(ui.text(`${ui.label('Check a tracked profile')}\n-# Pick someone whose updates aren’t showing up — you’ll see exactly what the bot sees.`));
      blocks.push(
        ui.select(
          'sv:diag',
          'Check a profile…',
          users.map((u) => {
            const h = ctx.feedHealth?.get(u.id);
            return { label: ui.clip(u.username, 100), value: String(u.id), emoji: !h ? '⏳' : h.ok ? '🟢' : '🔴', description: !h ? 'Not polled since the last restart' : h.ok ? `Last checked ${Math.round((Date.now() - h.at) / 60000)} min ago` : ui.clip(`Error: ${h.error}`, 100) };
          })
        )
      );
    }
  }
  return blocks;
}

async function render(interaction, note) {
  const me = interaction.user.id;
  const page = PAGES[pageOf.get(me)] ? pageOf.get(me) : 'feed';
  const guildName = interaction.guild?.name || 'this server';
  const head = ui.text(`## 🛡️ Server settings  ›  ${PAGES[page].emoji} ${PAGES[page].label}\n-# ${note || `${ui.esc(guildName)} · changes apply instantly`}`);
  const nav = ui.select('sv:cat', 'Jump to…', Object.entries(PAGES).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, description: v.description, default: k === page })));
  return ui.fit([ui.card(ui.ANILIST_BLUE, [head, nav, ui.divider(), ...(await pageBlocks(page, interaction))])]);
}

async function show(interaction, note) {
  const payload = await render(interaction, note);
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    if (interaction.isMessageComponent?.() && interaction.message?.flags?.has?.(ui.EPHEMERAL)) return await interaction.update(payload);
    return await interaction.reply({ ...payload, flags: ui.V2 | ui.EPHEMERAL });
  } catch (e) {
    console.error('Server settings render failed:', e.message);
  }
}

const denied = (interaction) =>
  ctx.respond(interaction, { ...ui.notice({ accent: 0xfb7185, title: '🛡️ Admins only', body: 'You need the **Manage Server** permission to change server settings.' }), flags: ui.V2 | ui.EPHEMERAL });

async function handleCommand(interaction) {
  if (!isManager(interaction)) return denied(interaction);
  return show(interaction);
}

/* ------------------------------ health check ------------------------------ */

async function diagnosis(guildId, anilistId, { fresh = null } = {}) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const g = core.guilds[guildId] || {};
  const u = (g.users || []).find((x) => x.id === anilistId);
  if (!u) return ui.notice({ title: 'Not tracked here', body: 'That profile isn’t tracked in this server anymore.' });
  const cfg = guildConfig(s, guildId);
  const h = ctx.feedHealth?.get(anilistId);
  const owner = social.discordFor(core, anilistId);
  const linked = Object.entries(core.linkedAccounts || {}).find(([, a]) => a.anilistId === anilistId);
  const checks = [];
  const ok = (t) => checks.push(`✅ ${t}`);
  const bad = (t) => checks.push(`⚠️ ${t}`);

  if (core.trackingOptOut?.[String(anilistId)]) bad('**Live activity is OFF** — the owner turned posting off with `/tracking` (or in /settings). Only they can turn it back on.');
  else ok('Live activity is on');
  checks.push(linked ? `✅ Signed in as <@${linked[0]}>` : `ℹ️ Not signed in${owner ? ` · tracked by <@${owner}>` : ''} (that’s fine — signing in is optional)`);
  const perm = await permLine(g.channelId);
  checks.push(perm);
  if (!h) bad('Not polled since the bot last restarted — give it a few minutes.');
  else if (!h.ok) bad(`Last AniList check **failed** ${ui.relTime(h.at)}: \`${ui.clip(h.error || 'unknown', 160)}\`${/429|rate/i.test(h.error || '') ? '\n-# That’s AniList’s rate limit — it clears on its own.' : /40[34]|disabled/i.test(h.error || '') ? '\n-# AniList refused the request — usually AniList-side, or the profile was renamed/deleted.' : ''}`);
  else ok(`AniList checked ${ui.relTime(h.at)}${h.entries === null ? ' (activities only)' : ''}`);

  const latestId = fresh?.activities?.[0]?.id ?? h?.latestId ?? null;
  const latestAt = fresh?.activities?.[0]?.createdAt ?? h?.latestAt ?? null;
  if (latestId) {
    if (latestId > (u.lastActivityId || 0)) bad(`Newest AniList activity (#${latestId}${latestAt ? `, ${ui.relTime(latestAt * 1000)}` : ''}) hasn’t been posted yet — it should go out on the next poll.`);
    else ok(`Up to date with AniList (newest activity #${latestId}${latestAt ? `, ${ui.relTime(latestAt * 1000)}` : ''})`);
  }
  if (h?.merged || h?.synthetic) ok(`Caught ${h.merged || 0} merged + ${h.synthetic || 0} list-only update(s) last poll`);
  if (!cfg.postManga) checks.push('ℹ️ Manga updates are switched off here (Activity feed page)');
  if (!cfg.postText) checks.push('ℹ️ Status posts are switched off here');
  if (cfg.mature === 'skip') checks.push('ℹ️ 18+ titles are not posted here');

  const children = [ui.text(`-# 🩺 HEALTH CHECK\n### [${ui.esc(u.username)}](https://anilist.co/user/${encodeURIComponent(u.username)})`), ui.text(checks.join('\n'))];
  if (fresh?.activities?.length) {
    const lines = fresh.activities.slice(0, 5).map((a) => {
      const what = a.__typename === 'ListActivity' ? `${a.status}${a.progress ? ` ${a.progress}` : ''} · ${ui.esc(ui.clip(a.media?.title?.english || a.media?.title?.romaji || '', 40))}` : a.__typename.replace('Activity', ' post');
      const state = a.id > (u.lastActivityId || 0) ? '🕓 waiting to post' : '✓ handled';
      return `\`#${a.id}\` ${what} · ${ui.relTime(a.createdAt * 1000)} · ${state}`;
    });
    children.push(ui.text(`${ui.label('Latest on AniList (live)')}\n${lines.join('\n')}`));
    if (fresh.entries) {
      const e = fresh.entries[0];
      if (e) children.push(ui.text(`-# Latest list update: ${ui.esc(ui.clip(e.media?.title?.english || e.media?.title?.romaji || '', 40))} → ${e.status} ${e.progress || ''} · ${ui.relTime(e.updatedAt * 1000)}`));
    }
    children.push(
      ui.text(
        '-# Tip: if their AniList list changes but no **activity** appears on their AniList profile, they’ve turned off list activity (AniList → Settings → Lists) or set a long “activity merge time”. The bot now catches both from their list instead.'
      )
    );
  } else if (fresh) {
    children.push(ui.text('-# AniList returned no activity for this profile.'));
  }
  children.push(ui.actionRow(ui.button(`sv:diag:now:${anilistId}`, 'Check AniList now', { emoji: '🔄', style: ui.ButtonStyle.Primary }), ui.button('sv:open', 'Back to settings', { emoji: '↩️' })));
  return ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
}

/* -------------------------------- handlers -------------------------------- */

async function onComponent(interaction) {
  if (!interaction.guildId || !isManager(interaction)) return denied(interaction);
  const parts = interaction.customId.split(':');
  const key = parts[1];
  const v = interaction.values || [];
  const me = interaction.user.id;
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const cfg = guildConfig(s, interaction.guildId);
  let note = null;

  switch (key) {
    case 'open':
      return show(interaction);
    case 'cat':
      pageOf.set(me, v[0]);
      return show(interaction);
    case 'ch': {
      const channel = await ctx.client.channels.fetch(v[0]).catch(() => null);
      const missing = channel && ctx.missingChannelPerms ? ctx.missingChannelPerms(channel) : ['ViewChannel'];
      if (missing.length) {
        note = `⚠️ I can’t post in <#${v[0]}> — I’m missing ${missing.join(', ')} there. Fix that first, then pick it again.`;
        break;
      }
      const g = (core.guilds[interaction.guildId] ||= { channelId: null, users: [], recommendations: {}, recentPosts: {} });
      g.channelId = v[0];
      await ctx.saveData(core);
      note = `✅ AniList updates now post in <#${v[0]}>`;
      break;
    }
    case 'ping':
      cfg.ping = v[0] === 'off' ? 'off' : 'quiet';
      break;
    case 'content':
      cfg.postText = v.includes('text');
      cfg.postManga = v.includes('manga');
      break;
    case 'mature':
      cfg.mature = ['show', 'blur', 'hide', 'skip'].includes(v[0]) ? v[0] : 'blur';
      break;
    case 'burst':
      cfg.burst = [1, 2, 3, 5, 8].includes(Number(v[0])) ? Number(v[0]) : 3;
      break;
    case 'rch':
      if (parts[2] === 'same') cfg.recapChannelId = null;
      else {
        const channel = await ctx.client.channels.fetch(v[0]).catch(() => null);
        const missing = channel && ctx.missingChannelPerms ? ctx.missingChannelPerms(channel) : ['ViewChannel'];
        if (missing.length) {
          note = `⚠️ I can’t post in <#${v[0]}> — missing ${missing.join(', ')}.`;
          break;
        }
        cfg.recapChannelId = v[0];
      }
      break;
    case 'recaps':
      cfg.weeklyRecap = v.includes('weekly');
      cfg.monthlyRecap = v.includes('monthly');
      break;
    case 'tz':
      cfg.timezone = v[0];
      break;
    case 'lb': {
      const statsUi = require('./statsUi');
      cfg.leaderboards = Object.fromEntries(Object.keys(statsUi.BOARDS).map((k) => [k, v.includes(k)]));
      break;
    }
    case 'auto':
      cfg.autoTrack = v[0] === 'on';
      break;
    case 'perm':
      cfg.trackPerm = v[0] === 'managers' ? 'managers' : 'everyone';
      break;
    case 'relaunch':
      cfg.relaunchPing = v[0] === 'on';
      break;
    case 'role':
      if (parts[2] === 'auto') cfg.animeRoleId = null;
      else cfg.animeRoleId = v[0] || null;
      break;
    case 'nudge':
      cfg.nudges = v[0] === 'on';
      break;
    case 'rp':
    case 'post': {
      const recaps = require('./recaps');
      const kind = parts[2] === 'month' ? 'month' : 'week';
      const { day } = { day: engine.dayKey(new Date(), cfg.timezone) };
      const lastKey = kind === 'week' ? engine.previousWeek(day).key : engine.lastMonths(engine.monthKey(day), 2)[0];
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      if (key === 'post') {
        const res = await recaps.postServerRecap(interaction.guildId, kind, lastKey).catch((e) => ({ ok: false, reason: e.message }));
        const msg = res.ok
          ? `📣 Posted ${kind === 'week' ? 'last week’s' : 'last month’s'} recap in <#${res.channelId}>.`
          : res.reason === 'empty'
            ? `Nobody here logged any episodes ${kind === 'week' ? 'last week' : 'last month'} — nothing to post.`
            : res.reason === 'channel'
              ? 'I can’t post in the recap channel (none picked, or missing permissions).'
              : `Couldn’t post: ${res.reason}`;
        return interaction.editReply({ content: msg }).catch(() => {});
      }
      // Preview: the last full period, or the current one so far if that's empty.
      let payload = await recaps.serverRecapPayload(interaction.guildId, kind, lastKey, { preview: true });
      let lead = `-# 👁️ Preview of ${kind === 'week' ? 'last week’s' : 'last month’s'} recap — only you can see this`;
      if (!payload) {
        const curKey = kind === 'week' ? engine.addDays(engine.previousWeek(day).key, 7) : engine.monthKey(day);
        payload = await recaps.serverRecapPayload(interaction.guildId, kind, curKey, { preview: true });
        lead = `-# 👁️ Nothing was logged ${kind === 'week' ? 'last week' : 'last month'}, so here’s ${kind === 'week' ? 'this week' : 'this month'} so far — only you can see this`;
      }
      if (!payload) return interaction.editReply({ content: 'Nobody here has logged any episodes yet — recaps fill up as AniList activity comes in.' }).catch(() => {});
      payload.components.unshift(ui.text(lead));
      return interaction.editReply(payload).catch((e) => console.error('Recap preview failed:', e.message));
    }
    case 'diag': {
      const anilistId = parts[2] === 'now' ? parseInt(parts[3], 10) : parseInt(v[0], 10);
      let fresh = null;
      await interaction.deferUpdate().catch(() => {});
      if (parts[2] === 'now') {
        const { getRecentFeed } = require('../anilist');
        try {
          fresh = await getRecentFeed(anilistId, 10);
        } catch (e) {
          fresh = { activities: [], entries: null };
          ctx.feedHealth?.set(anilistId, { ...(ctx.feedHealth.get(anilistId) || {}), at: Date.now(), ok: false, error: e.message.slice(0, 300) });
        }
      }
      return interaction.editReply(await diagnosis(interaction.guildId, anilistId, { fresh })).catch((e) => console.error('Diagnosis failed:', e.message));
    }
    default:
      return undefined;
  }
  await ctx.saveSocial();
  return show(interaction, note || '✅ Saved');
}

async function onModal() {
  /* no forms yet */
}

module.exports = { handleCommand, onComponent, onModal, PAGES, diagnosis };
