const { PermissionFlagsBits } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const { ctx } = require('./ctx');
const { guildConfig, peekConfig } = require('./guildConfig');
const { publicUrl } = require('./themes');

/* ---------------------------------------------------------------------------
 * Automatic recaps.
 *
 *  • Weekly server recap   — every Monday (server time zone), last Mon–Sun:
 *                            who watched the most hours, episodes, different
 *                            anime, completions, streaks + the server favourite.
 *  • Monthly server recap  — on the 1st, the same for last month.
 *  • Personal monthly DM   — everyone with a linked/tracked AniList gets their
 *                            own recap on the 1st, with "Share to a server",
 *                            "Compare with another month" and "Stop these DMs".
 *
 * Admins turn the server ones on/off and pick the channel in /serversettings.
 *
 * ids:
 *   rx:share:<owner>:<ym>      (select: guild)   post a recap to a server
 *   rx:cmp:<owner>:<ym>        (select: month)   compare two months
 *   rx:m:<owner>               (select: month)   recap of another month
 *   rx:open:<owner>:<ym>       back to the recap
 *   rx:stop:<owner>            stop recap DMs
 *   rx:me:stats · rx:me:recap:<ym> · rx:lb      buttons on server recaps
 * ------------------------------------------------------------------------- */

const MEDALS = ['🥇', '🥈', '🥉'];
const WEEKLY_ACCENT = 0x3db4f2;
const MONTHLY_ACCENT = 0xf5a524;
const MAX_DMS_PER_RUN = 20;
const hex6 = (n) => (n >>> 0).toString(16).padStart(6, '0').slice(-6);

function localParts(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const day = engine.dayKey(new Date(), tz);
  return { day, hour, dow: engine.weekday(day) }; // dow: 0 = Sunday
}

function fmtDay(day, opts = { month: 'short', day: 'numeric' }) {
  return new Date(`${day}T12:00:00Z`).toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
}

// Everyone who counts for a server's recap: tracked profiles, plus signed-in
// members who use the bot here. Private stats are left out.
function participants(core, s, st, guildId) {
  const out = new Map(); // anilistId -> p
  const g = core.guilds[guildId] || { users: [] };
  for (const t of g.users || []) {
    if (out.has(t.id)) continue;
    out.set(t.id, { anilistId: t.id, name: t.username, ownerId: social.discordFor(core, t.id) });
  }
  for (const [discordId, acct] of Object.entries(core.linkedAccounts || {})) {
    if (out.has(acct.anilistId)) continue;
    const u = s.users[discordId];
    if (u && (u.guilds || []).includes(guildId)) out.set(acct.anilistId, { anilistId: acct.anilistId, name: acct.anilistName, ownerId: discordId });
  }
  const list = [];
  for (const p of out.values()) {
    if (p.ownerId && s.users[p.ownerId] && !social.canView(social.peekUser(s, p.ownerId), null, p.ownerId, 'stats')) continue;
    p.su = st.users[String(p.anilistId)];
    list.push(p);
  }
  return list;
}

function who(p) {
  return p.ownerId ? `<@${p.ownerId}>` : `**${ui.esc(p.name)}**`;
}

// One person's numbers for the period, in one shape for weeks and months.
function periodSummary(st, su, kind, key) {
  if (!su) return null;
  if (kind === 'week') return engine.rangeSummary(st, su, key, engine.addDays(key, 6));
  const m = su.months?.[key];
  if (!m) return null;
  const sum = engine.monthSummary(st, su, key);
  return {
    episodes: m.e,
    minutes: m.m,
    completed: m.c,
    animeCount: Object.keys(m.a || {}).length,
    longestStreak: sum.longestStreak,
    activeDays: sum.activeDays,
    topAnime: sum.topAnime,
    topTags: sum.topTags,
    anime: m.a || {},
  };
}

function periodTitle(kind, key) {
  if (kind === 'week') {
    const end = engine.addDays(key, 6);
    return `${fmtDay(key)} – ${fmtDay(end, key.slice(5, 7) === end.slice(5, 7) ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
  }
  return engine.monthName(key);
}

// Medal per place, with ties sharing a medal (two people on 7 days both get 🥇).
function placed(sorted, value) {
  let place = 0;
  return sorted.map((r, i) => {
    if (i > 0 && value(r) !== value(sorted[i - 1])) place = i;
    return { r, place };
  });
}

function podium(rows, value, fmt) {
  const sorted = rows.filter((r) => value(r) > 0).sort((a, b) => value(b) - value(a));
  const top = placed(sorted, value).filter((x) => x.place < 3).slice(0, 4);
  if (!top.length) return null;
  return top.map(({ r, place }) => `${MEDALS[place]} ${who(r.p)} ${fmt(value(r))}`).join('  ·  ');
}

function isFreakyMedia(st, id) {
  const sm = st.media?.[id];
  if (!sm) return false;
  return Boolean(sm.fr ?? ((sm.g || []).includes('Ecchi') || (sm.g || []).includes('Hentai')));
}

// Who watched the most hours, as rows for the leaderboard image.
async function hoursBoard(guildId, kind, key) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const rows = participants(core, s, st, guildId)
    .map((p) => ({ p, sum: periodSummary(st, p.su, kind, key) }))
    .filter((r) => r.sum && r.sum.minutes > 0)
    .sort((a, b) => b.sum.minutes - a.sum.minutes)
    .slice(0, 8);
  if (!rows.length) return null;
  const names = await require('./statsUi').memberNames(guildId, rows.map((r) => r.p.ownerId));
  const tracked = new Map((core.guilds[guildId]?.users || []).map((t) => [t.id, t.avatar]));
  return {
    title: `Most hours · ${periodTitle(kind, key)}`,
    subtitle: `${kind === 'week' ? 'Weekly' : 'Monthly'} recap · ${ctx.client?.guilds.cache.get(guildId)?.name || 'this server'}`,
    unit: 'hours',
    accent: kind === 'week' ? WEEKLY_ACCENT : MONTHLY_ACCENT,
    rows: rows.map((r) => {
      const top = Object.entries(r.sum.anime || {}).sort((a, b) => b[1] - a[1])[0];
      return {
        name: (r.p.ownerId && names[r.p.ownerId]) || r.p.name,
        fallbackName: r.p.name,
        avatar: tracked.get(r.p.anilistId) || core.linkedAccounts?.[r.p.ownerId]?.avatar || null,
        value: r.sum.minutes,
        valueText: ui.hours(r.sum.minutes),
        detail: [`${ui.num(r.sum.episodes)} eps`, `${r.sum.animeCount} anime`, r.sum.completed ? `${r.sum.completed} done` : null, top ? `top: ${st.media?.[top[0]]?.t || ''}` : null].filter(Boolean).join(' · '),
      };
    }),
  };
}

/**
 * The server recap card (weekly or monthly). Returns null when nobody in the
 * server watched anything that period.
 */
async function serverRecapPayload(guildId, kind, key, { preview = false } = {}) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const people = participants(core, s, st, guildId);
  const rows = people.map((p) => ({ p, sum: periodSummary(st, p.su, kind, key) })).filter((r) => r.sum && r.sum.episodes > 0);
  if (!rows.length) return null;

  const weekly = kind === 'week';
  const accent = weekly ? WEEKLY_ACCENT : MONTHLY_ACCENT;
  const totals = rows.reduce((t, r) => ({ eps: t.eps + r.sum.episodes, min: t.min + r.sum.minutes, done: t.done + (r.sum.completed || 0) }), { eps: 0, min: 0, done: 0 });

  // Server favourites: shows ranked by how many people watched them, then episodes.
  const shows = new Map();
  for (const r of rows) {
    for (const [id, eps] of Object.entries(r.sum.anime || {})) {
      const x = shows.get(id) || { id: Number(id), eps: 0, watchers: 0, ...(st.media[id] || {}) };
      x.eps += eps;
      x.watchers += 1;
      shows.set(id, x);
    }
  }
  const topShows = [...shows.values()].sort((a, b) => b.watchers - a.watchers || b.eps - a.eps);
  const fav = topShows[0];
  const tagCount = {};
  for (const sh of topShows) for (const t of sh.tg || sh.g || []) tagCount[t] = (tagCount[t] || 0) + sh.eps;
  const vibe = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t]) => t);

  const children = [];
  if (fav) {
    const base = publicUrl();
    const banner = fav.b || (base ? `${base}/banner/v1/anime/${fav.id}/0b1622-${hex6(accent)}.jpg` : null);
    const g = banner ? ui.gallery([{ url: banner, description: fav.t }]) : null;
    if (g) children.push(g);
  }
  const guildName = ctx.client?.guilds.cache.get(guildId)?.name || 'this server';
  children.push(
    ui.text(
      [
        `-# ✦ ANITRACKER · ${weekly ? 'WEEKLY' : 'MONTHLY'} RECAP${preview ? ' · PREVIEW' : ''}`,
        `# ${periodTitle(kind, key)}`,
        `-# ${ui.esc(guildName)} · **${rows.length}** watcher${rows.length === 1 ? '' : 's'} · **${ui.hours(totals.min)}** hours · **${ui.num(totals.eps)}** episodes · **${shows.size}** different anime`,
      ].join('\n')
    )
  );
  children.push(ui.divider(true));

  // Main board: hours — an image with avatars and bars (text if images are off).
  const byHours = rows.slice().sort((a, b) => b.sum.minutes - a.sum.minutes);
  const artRoutes = require('./artRoutes');
  const board = await hoursBoard(guildId, kind, key);
  const boardUrl = board ? artRoutes.recapBoardUrl(guildId, kind, key, board.rows) : null;
  const boardImg = boardUrl ? ui.gallery([{ url: boardUrl, description: `Most hours: ${board.rows.slice(0, 3).map((r) => r.name).join(', ')}` }]) : null;
  if (boardImg) {
    artRoutes.warm(boardUrl);
    children.push(ui.text('### ⏱️ Most hours watched'));
    children.push(boardImg);
    children.push(ui.text(`-# ${placed(byHours, (r) => r.sum.minutes).slice(0, 5).map(({ r, place }) => `\`${place + 1}\` ${who(r.p)} ${ui.hours(r.sum.minutes)}h`).join('  ·  ')}`));
  } else {
    const maxMin = byHours[0].sum.minutes;
    children.push(
      ui.text(
        `### ⏱️ Most hours watched\n${placed(byHours, (r) => r.sum.minutes)
          .slice(0, 5)
          .map(
            ({ r, place }) =>
              `${MEDALS[place] || `\`#${place + 1}\``} ${who(r.p)}  ·  **${ui.hours(r.sum.minutes)} h**\n-# \`${ui.bar(r.sum.minutes, maxMin, 14)}\`  ${ui.num(r.sum.episodes)} eps · ${r.sum.animeCount} anime${r.sum.completed ? ` · ${r.sum.completed} completed` : ''}`
          )
          .join('\n')}${byHours.length > 5 ? `\n-# +${byHours.length - 5} more watching` : ''}`
      )
    );
  }
  children.push(ui.divider());

  // Category podiums.
  const boards = [
    ['📺 Most episodes', podium(rows, (r) => r.sum.episodes, (v) => `**${ui.num(v)}**`)],
    ['🎬 Most different anime', podium(rows, (r) => r.sum.animeCount, (v) => `**${v}**`)],
    ['✅ Most completed', podium(rows, (r) => r.sum.completed || 0, (v) => `**${v}**`)],
    ['🔥 Longest streak', podium(rows, (r) => r.sum.longestStreak || 0, (v) => `**${v}**d`)],
    ['📅 Most active days', podium(rows, (r) => r.sum.activeDays || 0, (v) => `**${v}**`)],
  ].filter(([, line]) => line);
  children.push(ui.text(boards.map(([t, line]) => `**${t}**\n${line}`).join('\n')));

  if (fav) {
    children.push(ui.divider());
    children.push(
      ui.text(
        [
          ui.label(weekly ? 'Server favourite this week' : 'Server favourite this month'),
          `### ${fav.u ? `[${ui.esc(ui.clip(fav.t || 'Unknown', 70))}](${fav.u})` : ui.esc(fav.t || 'Unknown')}`,
          `-# watched by **${fav.watchers}** ${fav.watchers === 1 ? 'person' : 'people'} · ${ui.num(fav.eps)} episodes`,
        ].join('\n')
      )
    );
    const more = topShows.slice(1, 5);
    if (more.length) {
      const bl = artRoutes.bannerListUrl(more.map((x) => ({ mediaId: x.id, detail: `${x.watchers} watching · ${ui.num(x.eps)} ep${x.eps === 1 ? '' : 's'}` })), 'Also popular', { start: 2 });
      const bg = bl ? ui.gallery([{ url: bl, description: more.map((x) => x.t).join(' · ') }]) : null;
      if (bg) {
        artRoutes.warm(bl);
        children.push(bg);
      } else {
        children.push(
          ui.text(
            `${ui.label('Also popular')}\n${more
              .map((x, i) => `\`${String(i + 2).padStart(2, '0')}\` ${x.u ? `[${ui.esc(ui.clip(x.t || 'Unknown', 55))}](${x.u})` : ui.esc(x.t || 'Unknown')} · ${x.watchers} watching · ${x.eps} eps`)
              .join('\n')}`
          )
        );
      }
    }
  }

  // Freakiest this period (only where admins turned that board on).
  const freakyOn = require('./statsUi').guildBoards(s, guildId).includes('freaky');
  if (freakyOn) {
    const fr = rows
      .map((r) => {
        const shows = Object.entries(r.sum.anime || {})
          .filter(([id]) => isFreakyMedia(st, id))
          .map(([id, eps]) => ({ id: Number(id), eps, t: st.media[id]?.t || 'Unknown' }))
          .sort((a, b) => b.eps - a.eps);
        return { r, shows, eps: shows.reduce((a, x) => a + x.eps, 0) };
      })
      .filter((x) => x.eps > 0)
      .sort((a, b) => b.eps - a.eps);
    if (fr.length) {
      children.push(ui.divider());
      const maxF = fr[0].eps;
      children.push(
        ui.text(
          `### 😳 Freakiest ${weekly ? 'this week' : 'this month'}\n${fr
            .slice(0, 3)
            .map((x, i) => `\`${i + 1}\` ${who(x.r.p)} **${x.eps}** eps  \`${ui.bar(x.eps, maxF, 10)}\`\n-# ${x.shows.slice(0, 3).map((sh) => ui.esc(ui.clip(sh.t, 40))).join(', ')}`)
            .join('\n')}`
        )
      );
      const shows = new Map();
      for (const x of fr) for (const sh of x.shows) shows.set(sh.id, { ...sh, eps: (shows.get(sh.id)?.eps || 0) + sh.eps });
      const picks = [...shows.values()].sort((a, b) => b.eps - a.eps).slice(0, 3);
      const bl = artRoutes.bannerListUrl(picks.map((x) => ({ mediaId: x.id, detail: `${x.eps} ep${x.eps === 1 ? '' : 's'}` })), 'The freaky picks');
      const bg = bl ? ui.gallery([{ url: bl, description: picks.map((x) => x.t).join(' · ') }]) : null;
      if (bg) {
        artRoutes.warm(bl);
        children.push(bg);
      }
    }
  }
  if (vibe.length) children.push(ui.text(`${ui.label('The vibe')}\n🏷️ ${vibe.map((t) => `\`${t}\``).join(' ')}`));

  children.push(ui.divider());
  const buttons = [ui.button('rx:me:stats', 'My stats', { emoji: '📊' })];
  if (!weekly) buttons.push(ui.button(`rx:me:recap:${key}`, 'My recap', { emoji: '🎁', style: ui.ButtonStyle.Primary }));
  buttons.push(ui.button('rx:lb', 'Leaderboards', { emoji: '🏆' }));
  children.push(ui.actionRow(buttons));
  children.push(ui.text(`-# ${weekly ? 'Posts every Monday' : 'Posts on the 1st'} · your own recap: /recap · admins: /serversettings`));
  return ui.fit([ui.card(accent, children)]);
}

async function recapChannelFor(core, s, guildId) {
  const cfg = peekConfig(s, guildId);
  const id = cfg.recapChannelId || core.guilds[guildId]?.channelId;
  if (!id) return null;
  const channel = await ctx.client.channels.fetch(id).catch(() => null);
  if (!channel || (ctx.missingChannelPerms && ctx.missingChannelPerms(channel).length)) return null;
  return channel;
}

async function postServerRecap(guildId, kind, key) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const channel = await recapChannelFor(core, s, guildId);
  if (!channel) return { ok: false, reason: 'channel' };
  const payload = await serverRecapPayload(guildId, kind, key);
  if (!payload) return { ok: false, reason: 'empty' };
  await channel.send(payload);
  return { ok: true, channelId: channel.id };
}

/* ------------------------------ personal DMs ------------------------------ */

function dmMode(u) {
  return u?.prefs?.recapDmMode || 'on';
}

// Servers this person could share a recap to.
function shareableGuilds(core, s, userId) {
  const al = social.anilistFor(core, userId);
  const u = s.users[userId];
  const ids = new Set(u?.guilds || []);
  if (core.linkedAccounts?.[userId]?.guildId) ids.add(core.linkedAccounts[userId].guildId);
  for (const [gid, g] of Object.entries(core.guilds)) if (al && (g.users || []).some((x) => x.id === al.id)) ids.add(gid);
  return [...ids].filter((gid) => ctx.client?.guilds.cache.has(gid) && (core.guilds[gid]?.channelId || peekConfig(s, gid).recapChannelId)).slice(0, 25);
}

function monthOptions(current, ym, exclude = null) {
  return engine
    .lastMonths(current, 6)
    .reverse()
    .filter((m) => m !== exclude)
    .map((m) => ({ label: engine.monthName(m), value: m, default: m === ym }));
}

// Extra controls under a recap: month picker + compare (+ DM-only bits).
async function recapControls(ownerId, ym, { dm = false } = {}) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const tz = social.peekUser(s, ownerId).prefs.timezone || social.DEFAULT_TZ;
  const current = engine.monthKey(engine.dayKey(new Date(), tz));
  const rows = [];
  rows.push(ui.select(`rx:m:${ownerId}`, '🗓️ See another month…', monthOptions(current, ym)));
  rows.push(ui.select(`rx:cmp:${ownerId}:${ym}`, `📈 Compare ${engine.monthName(ym, false)} with…`, monthOptions(current, null, ym)));
  if (dm) {
    const guilds = shareableGuilds(core, s, ownerId);
    if (guilds.length) {
      rows.push(
        ui.select(
          `rx:share:${ownerId}:${ym}`,
          '📣 Share this recap to a server…',
          guilds.map((gid) => ({ label: ui.clip(ctx.client.guilds.cache.get(gid)?.name || 'Server', 100), value: gid, emoji: '🏠' }))
        )
      );
    }
    rows.push(ui.actionRow(ui.button(`rx:stop:${ownerId}`, 'Stop recap DMs', { emoji: '🔕' })));
  }
  return rows;
}

async function personalRecap(ownerId, viewerId, ym, { dm = false, controls = true, shareable = false } = {}) {
  const statsUi = require('./statsUi');
  const payload = await statsUi.recapPayload(ownerId, viewerId, ym, { shareable: shareable && !dm && ownerId === viewerId });
  if (controls && social.canView(social.peekUser(await ctx.loadSocial(), ownerId), viewerId, ownerId, 'stats')) {
    const extra = await recapControls(ownerId, ym, { dm });
    attachRows(payload, extra);
  }
  return payload;
}

// Puts rows inside the recap card (keeps it one tidy block), within limits.
function attachRows(payload, rows) {
  const container = payload.components[0];
  let count = payload.components.reduce((n, c) => n + ui.countJson(c.toJSON ? c.toJSON() : c), 0);
  for (const r of rows.filter(Boolean)) {
    const cost = ui.countJson(r.toJSON());
    if (count + cost > 40) break;
    if (container?.addActionRowComponents) container.addActionRowComponents(r);
    else payload.components.push(r);
    count += cost;
  }
}

async function sendPersonalRecaps() {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const owners = new Set(Object.keys(core.linkedAccounts || {}));
  for (const g of Object.values(core.guilds)) for (const t of g.users || []) if (t.addedBy && social.anilistFor(core, t.addedBy)?.id === t.id) owners.add(t.addedBy);

  let sent = 0;
  let touched = false;
  for (const userId of owners) {
    if (sent >= MAX_DMS_PER_RUN) break;
    const peek = social.peekUser(s, userId);
    if (dmMode(peek) === 'off') continue;
    const tz = peek.prefs.timezone || social.DEFAULT_TZ;
    const today = engine.dayKey(new Date(), tz);
    if (Number(today.slice(8, 10)) > 7) continue; // first week of the month only
    const prev = engine.lastMonths(engine.monthKey(today), 2)[0];
    if (peek.prefs.lastRecapSent === prev) continue;
    const al = social.anilistFor(core, userId);
    const u = social.getUser(s, userId);
    touched = true;
    u.prefs.lastRecapSent = prev; // mark first: never DM twice, even if sending fails
    if (!al || !st.users[String(al.id)]?.months?.[prev]?.e) continue; // nothing watched
    try {
      const user = await ctx.client.users.fetch(userId);
      await user.send(await personalRecap(userId, userId, prev, { dm: true }));
      sent++;
    } catch (e) {
      console.error(`Couldn't DM recap to ${userId}:`, e.message);
    }
  }
  if (touched) ctx.saveSocial();
  if (sent) console.log(`[recaps] sent ${sent} personal monthly recap DM(s)`);
}

/* ------------------------------- scheduler ------------------------------- */

let lastRun = 0;
async function runScheduled({ force = false } = {}) {
  if (!force && Date.now() - lastRun < 20 * 60 * 1000) return;
  lastRun = Date.now();
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  for (const guildId of Object.keys(core.guilds)) {
    if (!ctx.client?.guilds.cache.has(guildId)) continue;
    const peek = peekConfig(s, guildId);
    if (!peek.recapChannelId && !core.guilds[guildId]?.channelId) continue;
    const { day, hour, dow } = localParts(peek.timezone);

    if (peek.weeklyRecap) {
      const wk = engine.previousWeek(day);
      const due = (dow === 1 && hour >= 10) || dow === 2 || dow === 3; // Monday 10am, catch up until Wednesday
      if (due && peek.lastWeekly !== wk.key) {
        const cfg = guildConfig(s, guildId);
        cfg.lastWeekly = wk.key;
        ctx.saveSocial();
        const res = await postServerRecap(guildId, 'week', wk.key).catch((e) => ({ ok: false, reason: e.message }));
        if (res.ok) console.log(`[recaps] weekly recap posted in ${guildId}`);
      }
    }
    if (peek.monthlyRecap) {
      const dom = Number(day.slice(8, 10));
      const prev = engine.lastMonths(engine.monthKey(day), 2)[0];
      const due = (dom === 1 && hour >= 10) || (dom > 1 && dom <= 5);
      if (due && peek.lastMonthly !== prev) {
        const cfg = guildConfig(s, guildId);
        cfg.lastMonthly = prev;
        ctx.saveSocial();
        const res = await postServerRecap(guildId, 'month', prev).catch((e) => ({ ok: false, reason: e.message }));
        if (res.ok) console.log(`[recaps] monthly recap posted in ${guildId}`);
      }
    }
  }
  await sendPersonalRecaps();
}

/* ------------------------------- comparison ------------------------------- */

async function comparePayload(ownerId, viewerId, a, b) {
  const statsUi = require('./statsUi');
  const g = await statsUi.gather(ownerId);
  if (!social.canView(g.u, viewerId, ownerId, 'stats')) return ui.notice({ title: '🔒 Private', body: `<@${ownerId}> keeps their stats private.` });
  const A = engine.monthSummary(g.st, g.su, a);
  const B = engine.monthSummary(g.st, g.su, b);
  const nA = engine.monthName(a, false).split(' ')[0];
  const nB = engine.monthName(b, false).split(' ')[0];
  const val = (x, k) => (x ? x[k] || 0 : 0);
  const delta = (x, y, pct = true) => {
    if (!y) return x ? '🆕' : '—';
    const d = x - y;
    if (!d) return '＝';
    return pct ? `${d > 0 ? '▲' : '▼'} ${Math.abs(Math.round((d / y) * 100))}%` : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`;
  };
  const line = (emoji, label, x, y, fmt = (v) => ui.num(v), pct = true) => `${emoji} **${label}** · ${nA} **${fmt(x)}** · ${nB} ${fmt(y)}  ·  ${delta(x, y, pct)}`;
  const children = [
    ui.text(`-# ✦ RECAP COMPARISON\n## ${engine.monthName(a)} vs ${engine.monthName(b)}\n-# for <@${ownerId}>`),
    ui.divider(),
    ui.text(
      [
        line('📺', 'Episodes', val(A, 'episodes'), val(B, 'episodes')),
        line('⏱️', 'Hours', val(A, 'minutes'), val(B, 'minutes'), (v) => ui.hours(v)),
        line('🎬', 'Different anime', val(A, 'animeCount'), val(B, 'animeCount'), (v) => v, false),
        line('🌱', 'Started', val(A, 'started'), val(B, 'started'), (v) => v, false),
        line('✅', 'Completed', val(A, 'completedLocal'), val(B, 'completedLocal'), (v) => v, false),
        line('🔥', 'Longest streak', val(A, 'longestStreak'), val(B, 'longestStreak'), (v) => `${v}d`, false),
        line('📅', 'Active days', val(A, 'activeDays'), val(B, 'activeDays'), (v) => v, false),
      ].join('\n')
    ),
    ui.divider(),
  ];
  for (const [name, sum] of [
    [nA, A],
    [nB, B],
  ]) {
    const top = sum?.topAnime?.[0];
    const tag = sum?.topTags?.[0]?.genre;
    if (top) children.push(ui.row([ui.label(`#1 in ${name}`), `**${top.u ? `[${ui.esc(ui.clip(top.t, 60))}](${top.u})` : ui.esc(top.t || 'Unknown')}** · ${top.eps} eps`, tag ? `-# vibe: ${ui.esc(tag)}` : null].filter(Boolean), top.c));
    else children.push(ui.text(`${ui.label(`#1 in ${name}`)}\n-# nothing logged`));
  }
  const tz = g.tz;
  const current = engine.monthKey(engine.dayKey(new Date(), tz));
  children.push(ui.select(`rx:cmp:${ownerId}:${a}`, `Compare ${nA} with another month…`, monthOptions(current, b, a)));
  children.push(ui.actionRow(ui.button(`rx:open:${ownerId}:${a}`, `Back to ${nA} recap`, { emoji: '↩️' })));
  return ui.fit([ui.card(g.pal.accent, children)]);
}

/* -------------------------------- handlers -------------------------------- */

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const kind = parts[1];
  const me = interaction.user.id;
  const priv = async (payload) => {
    try {
      if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
      return await interaction.reply({ ...payload, flags: ui.V2 | ui.EPHEMERAL });
    } catch (e) {
      console.error('Recap reply failed:', e.message);
    }
  };
  // Change the message in place if it's the clicker's own (DM or private), else a private copy.
  const isPrivate = !interaction.guildId || Boolean(interaction.message?.flags?.has?.(ui.EPHEMERAL));
  const swap = async (build) => {
    const invoker = interaction.message?.interactionMetadata?.user?.id;
    const mine = isPrivate || invoker === me;
    try {
      if (mine) {
        await interaction.deferUpdate();
        return await interaction.editReply(await build());
      }
      await interaction.deferReply({ flags: ui.EPHEMERAL });
      return await interaction.editReply(await build());
    } catch (e) {
      console.error('Recap view failed:', e.message);
    }
  };

  if (kind === 'me') {
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    const statsUi = require('./statsUi');
    if (parts[2] === 'stats') return priv(await statsUi.statsPayload(me, me, 'month'));
    return priv(await personalRecap(me, me, parts[3], { shareable: true }));
  }
  if (kind === 'lb') {
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    const statsUi = require('./statsUi');
    return priv(await statsUi.leaderboardPayload(interaction.guildId, 'episodes'));
  }
  if (kind === 'm') {
    const owner = parts[2];
    const ym = interaction.values[0];
    return swap(() => personalRecap(owner, me, ym, { dm: !interaction.guildId && owner === me, shareable: isPrivate && Boolean(interaction.guildId) }));
  }
  if (kind === 'open') {
    const [, , owner, ym] = parts;
    return swap(() => personalRecap(owner, me, ym, { dm: !interaction.guildId && owner === me, shareable: isPrivate && Boolean(interaction.guildId) }));
  }
  if (kind === 'cmp') {
    const [, , owner, ym] = parts;
    return swap(() => comparePayload(owner, me, ym, interaction.values[0]));
  }
  if (kind === 'stop') {
    if (parts[2] !== me) return priv({ content: 'Only the owner can change this.' });
    const s = await ctx.loadSocial();
    social.getUser(s, me).prefs.recapDmMode = 'off';
    await ctx.saveSocial();
    return priv(ui.notice({ label: 'Recap DMs', title: '🔕 No more recap DMs', body: 'Turn them back on any time in `/settings` → **Stats & reviews**. `/recap` still works whenever you want one.' }));
  }
  if (kind === 'share') {
    const [, , owner, ym] = parts;
    if (owner !== me) return priv({ content: 'Only the owner can share their recap.' });
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    const guildId = interaction.values[0];
    const guild = ctx.client.guilds.cache.get(guildId);
    if (!guild) return priv({ content: 'I’m not in that server anymore.' });
    const member = await guild.members.fetch(me).catch(() => null);
    if (!member) return priv({ content: 'You’re not in that server anymore.' });
    const core = await ctx.loadData();
    const s = await ctx.loadSocial();
    const channel = await recapChannelFor(core, s, guildId);
    if (!channel) return priv({ content: `I can’t post in **${ui.esc(guild.name)}** right now (no channel picked, or I’m missing permissions there).` });
    if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) return priv({ content: 'You can’t see that server’s AniTracker channel.' });
    const statsUi = require('./statsUi');
    const payload = await statsUi.recapPayload(owner, owner, ym, { shareable: false, controls: false });
    payload.components.unshift(ui.text(`-# 📣 <@${owner}> shared their ${engine.monthName(ym)} recap`));
    try {
      await channel.send(payload);
      return priv({ content: `📣 Shared in **${ui.esc(guild.name)}** → <#${channel.id}>` });
    } catch (e) {
      return priv({ content: `Couldn’t post there: ${e.message}` });
    }
  }
}

module.exports = { hoursBoard, _participants: participants, runScheduled, serverRecapPayload, postServerRecap, personalRecap, comparePayload, recapControls, attachRows, onComponent, periodTitle, sendPersonalRecaps };
