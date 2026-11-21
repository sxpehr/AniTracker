const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const { paletteFor, publicUrl } = require('./themes');
const { ctx } = require('./ctx');
const { getProfileSnapshot, getCompletedBetween, titleOf } = require('./anilistSocial');

/* ---------------------------------------------------------------------------
 * /stats, /recap and /leaderboard views.
 *
 * ids:
 *   st:v:<owner>:<tab>:<month>      tabs: month | life | streak
 *   st:m:<owner>                    month picker
 *   rc:share:<owner>:<month>        post a recap publicly
 *   lb:c                            leaderboard category menu
 * ------------------------------------------------------------------------- */

function squareFor(accent) {
  const [r, g, b] = [(accent >> 16) & 255, (accent >> 8) & 255, accent & 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 30) return '⬜';
  if (b >= r && b >= g) return r > g + 40 ? '🟪' : '🟦';
  if (r >= g && r >= b) return g > 170 ? '🟨' : b > 120 ? '🟪' : '🟥';
  return '🟩';
}

function genreBars(genres, unit = 'eps', limit = 4) {
  const top = genres.slice(0, limit);
  const max = top[0]?.value || 0;
  return top.map((g) => `${ui.bar(g.value, max, 10)}  **${ui.esc(g.name)}** · ${ui.num(g.value)} ${unit}`).join('\n');
}

function heatmap(su, tz, accent, weeks = 5) {
  const sq = squareFor(accent);
  const today = engine.dayKey(new Date(), tz);
  // align to Monday
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = engine.addDays(today, -dow - (weeks - 1) * 7);
  const lines = [];
  for (let w = 0; w < weeks; w++) {
    let line = '';
    for (let d = 0; d < 7; d++) {
      const day = engine.addDays(start, w * 7 + d);
      if (day > today) line += '▫️';
      else line += su?.days?.[day]?.[0] ? sq : '⬛';
    }
    const label = new Date(`${engine.addDays(start, w * 7)}T12:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    lines.push(`${line}  ${label}`);
  }
  return `-# M T W T F S S — last ${weeks} weeks\n${lines.join('\n')}`;
}

async function gather(ownerId) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const u = social.peekUser(s, ownerId);
  const al = social.anilistFor(core, ownerId);
  const su = al ? st.users[String(al.id)] : null;
  return { core, s, st, u, al, su, tz: u.prefs.timezone || social.DEFAULT_TZ, pal: paletteFor(u.profile) };
}

/* ------------------------------ stat blocks ------------------------------ */

async function monthBlocks({ st, su, al, tz }, ym, { compact = false } = {}) {
  const sum = engine.monthSummary(st, su, ym);
  const blocks = [];
  let completed = null;
  if (al) {
    try {
      const { from, to } = engine.monthBounds(ym);
      completed = await getCompletedBetween(al.id, from, to);
    } catch (e) {
      console.error('Completed lookup failed:', e.message);
    }
  }
  const scored = (completed || []).filter((e) => e.score > 0);
  const avg = scored.length ? scored.reduce((a, e) => a + e.score, 0) / scored.length : null;
  const completedCount = completed ? completed.length : sum?.completedLocal || 0;

  blocks.push(ui.text(`${ui.label(engine.monthName(ym))}`));
  if (!sum || !sum.episodes) {
    blocks.push(ui.text(`### No episodes logged yet\n-# Stats build up automatically as ${al ? 'AniList activity comes in' : 'you watch (link AniList with `/signin`)'}.`));
    if (completedCount) blocks.push(ui.text(`-# ${completedCount} completed this month on AniList`));
    return blocks;
  }
  blocks.push(
    ui.text(
      `## ${ui.num(sum.episodes)} episodes\n### ${ui.hours(sum.minutes)} hours · ${sum.animeCount} anime\n-# ${[
        `${sum.started} started`,
        `${completedCount} completed`,
        avg ? `avg score ${avg.toFixed(1)}` : null,
        sum.busiestWeekday ? `most active on ${sum.busiestWeekday}s` : null,
        `${sum.activeDays} active days`,
      ]
        .filter(Boolean)
        .join(' · ')}`
    )
  );
  if (compact) return blocks;

  blocks.push(ui.divider());
  const top = sum.topAnime.slice(0, 5);
  blocks.push(ui.text(ui.label('Most watched')));
  const g = ui.coverGallery(top.slice(0, 4).map((a) => ({ url: a.c, description: a.t })));
  if (g) blocks.push(g);
  blocks.push(ui.text(top.map((a, i) => `\`${String(i + 1).padStart(2, '0')}\` **${a.u ? `[${ui.esc(ui.clip(a.t, 60))}](${a.u})` : ui.esc(a.t)}** · ${a.eps} ep${a.eps === 1 ? '' : 's'}`).join('\n')));
  if (sum.topTags.length) {
    blocks.push(ui.text(`${ui.label('Your vibe this month')}\n${genreBars(sum.topTags.map((x) => ({ name: x.genre, value: x.eps })))}`));
  }
  const months = engine.lastMonths(ym, 6);
  const values = months.map((m) => su?.months?.[m]?.e || 0);
  const prev = values[values.length - 2];
  const delta = prev ? Math.round(((sum.episodes - prev) / prev) * 100) : null;
  blocks.push(
    ui.text(
      `${ui.label('Last 6 months')}\n\`${ui.sparkline(values)}\`  ${engine.monthName(months[0], false).split(' ')[0]} → ${engine.monthName(ym, false).split(' ')[0]}${
        delta !== null ? `  ·  ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs last month` : ''
      }`
    )
  );
  if (scored.length) {
    const best = scored[0];
    blocks.push(ui.row([ui.label('Highest rated this month'), `**[${ui.esc(titleOf(best.media))}](${best.media.siteUrl})** · ${best.score}/10`], best.media.coverImage?.large));
  }
  return blocks;
}

async function lifetimeBlocks({ al, su }) {
  if (!al) return [ui.text('### Lifetime stats\n*Link an AniList account with `/signin` to see lifetime stats.*')];
  let snap = null;
  try {
    snap = await getProfileSnapshot(al.id);
  } catch (e) {
    console.error('Lifetime lookup failed:', e.message);
  }
  if (!snap) return [ui.text('### Lifetime stats\n⚠️ AniList didn’t answer (it may be down, or this profile is private).')];
  const L = snap.lifetime;
  const blocks = [
    ui.text(ui.label('Lifetime · from AniList')),
    ui.text(
      `## ${ui.num(L.episodes)} episodes\n### ${ui.hours(L.minutes)} hours · ${(L.minutes / 1440).toFixed(1)} days of anime\n-# ${[
        `${ui.num(L.completed)} completed`,
        `${ui.num(L.watching)} watching`,
        `${ui.num(L.planning)} planned`,
        `${ui.num(L.dropped)} dropped`,
        L.meanScore ? `mean score ${(L.meanScore / 10).toFixed(1)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`
    ),
  ];
  if (L.topRated) {
    blocks.push(
      ui.row([ui.label('Highest rated ever'), `**[${ui.esc(titleOf(L.topRated.media))}](${L.topRated.media.siteUrl})**`, `-# ${L.topRated.score}/10`], L.topRated.media.coverImage?.large)
    );
  }
  const lifeTags = L.tags?.length ? L.tags : L.genres;
  if (lifeTags.length) blocks.push(ui.text(`${ui.label(L.tags?.length ? 'What you watch most' : 'Most watched genres')}\n${genreBars(lifeTags.map((g) => ({ name: g.genre, value: g.count })), 'anime', 5)}`));
  const months = Object.entries(su?.months || {}).sort((a, b) => b[1].e - a[1].e);
  if (months.length) blocks.push(ui.text(`-# Most active month since tracking began: **${engine.monthName(months[0][0])}** · ${ui.num(months[0][1].e)} episodes`));
  return blocks;
}

function streakBlocks({ su, tz, pal }) {
  const s = engine.streakOf(su, tz);
  const blocks = [ui.text(ui.label('Watching streak'))];
  blocks.push(
    ui.text(
      `## 🔥 ${s.current} day${s.current === 1 ? '' : 's'}\n-# ${
        s.current ? (s.activeToday ? 'Watched today — streak is safe ✓' : 'Watch an episode today to keep it alive') : 'Watch an episode to start a new streak'
      }`
    )
  );
  blocks.push(
    ui.text(
      `### 🏆 Longest: ${s.longest} day${s.longest === 1 ? '' : 's'}\n-# ${[
        s.longestEnd ? `ended ${new Date(`${s.longestEnd}T12:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : null,
        `${ui.num(s.activeDays)} active days total`,
        s.lastDay ? `last active ${new Date(`${s.lastDay}T12:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`
    )
  );
  blocks.push(ui.text(heatmap(su, tz, pal.accent)));
  const best = Object.entries(su?.months || {}).sort((a, b) => b[1].e - a[1].e)[0];
  if (best) blocks.push(ui.text(`-# Best month: **${engine.monthName(best[0])}** (${ui.num(best[1].e)} episodes)`));
  return blocks;
}

/* --------------------------------- /stats --------------------------------- */

async function statsPayload(ownerId, viewerId, tab = 'month', ym = null) {
  const g = await gather(ownerId);
  const own = ownerId === viewerId;
  if (!social.canView(g.u, viewerId, ownerId, 'stats')) {
    return ui.fit([ui.card(g.pal.accent, [ui.text(`### 🔒 Private\n<@${ownerId}> keeps their stats private.`)])]);
  }
  ym = ym || engine.monthKey(engine.dayKey(new Date(), g.tz));
  const head = ui.text(`### 📊 ${own ? 'Your' : `<@${ownerId}>’s`} stats${g.al ? `  ·  [${ui.esc(g.al.name)}](${g.al.siteUrl})` : ''}`);
  let body;
  if (tab === 'life') body = await lifetimeBlocks(g);
  else if (tab === 'streak') body = streakBlocks(g);
  else body = await monthBlocks(g, ym);

  const tabs = ui.actionRow(
    ui.button(`st:v:${ownerId}:month:${ym}`, 'This month', { emoji: '🗓️', style: tab === 'month' ? ui.ButtonStyle.Primary : ui.ButtonStyle.Secondary }),
    ui.button(`st:v:${ownerId}:life:${ym}`, 'Lifetime', { emoji: '♾️', style: tab === 'life' ? ui.ButtonStyle.Primary : ui.ButtonStyle.Secondary }),
    ui.button(`st:v:${ownerId}:streak:${ym}`, 'Streaks', { emoji: '🔥', style: tab === 'streak' ? ui.ButtonStyle.Primary : ui.ButtonStyle.Secondary }),
    ui.button(`rc:open:${ownerId}:${ym}`, 'Recap', { emoji: '🎁' })
  );
  const children = [head, ui.divider(), ...body, ui.divider(), tabs];
  if (tab === 'month') {
    const months = Object.keys(g.su?.months || {}).sort().reverse().slice(0, 24);
    if (months.length > 1) children.push(ui.select(`st:m:${ownerId}`, 'Look at another month…', months.map((m) => ({ label: engine.monthName(m), value: m, default: m === ym }))));
  }
  return ui.fit([ui.card(g.pal.accent, children)]);
}

/* --------------------------------- /recap --------------------------------- */

// The recap card itself. Month picker / compare / DM controls are added by
// features/recaps.js (personalRecap).
async function recapPayload(ownerId, viewerId, ym, { shareable = true } = {}) {
  const g = await gather(ownerId);
  const sum = engine.monthSummary(g.st, g.su, ym);
  const own = ownerId === viewerId;
  if (!social.canView(g.u, viewerId, ownerId, 'stats')) {
    return ui.fit([ui.card(g.pal.accent, [ui.text(`### 🔒 Private\n<@${ownerId}> keeps their stats private.`)])]);
  }
  const children = [];
  const top = sum?.topAnime?.[0];
  const base = publicUrl();
  if (top && base) {
    const hex6 = (n) => (n >>> 0).toString(16).padStart(6, '0').slice(-6);
    const g2 = ui.gallery([{ url: `${base}/banner/v1/anime/${top.mediaId}/${hex6(g.pal.bg)}-${hex6(g.pal.accent)}.jpg`, description: `${top.t} banner` }]);
    if (g2) children.push(g2);
  }
  children.push(ui.text(`-# ✦ ANITRACKER RECAP\n# ${engine.monthName(ym)}\n-# for <@${ownerId}>`));
  if (!sum || !sum.episodes) {
    children.push(ui.text(`Nothing logged for ${engine.monthName(ym)} yet — recaps fill up automatically as AniList activity comes in.`));
    return ui.fit([ui.card(g.pal.accent, children)]);
  }

  let completed = null;
  if (g.al) {
    try {
      const { from, to } = engine.monthBounds(ym);
      completed = await getCompletedBetween(g.al.id, from, to);
    } catch {
      /* optional */
    }
  }
  const scored = (completed || []).filter((e) => e.score > 0);
  const avg = scored.length ? scored.reduce((a, e) => a + e.score, 0) / scored.length : null;

  children.push(ui.divider(true));
  children.push(
    ui.text(`## ${ui.num(sum.episodes)} episodes\n### ${ui.hours(sum.minutes)} hours · ${sum.animeCount} anime · ${completed ? completed.length : sum.completedLocal} completed`)
  );
  children.push(ui.divider());
  if (top) {
    children.push(ui.row([ui.label('Your #1 anime'), `### ${top.u ? `[${ui.esc(top.t)}](${top.u})` : ui.esc(top.t)}`, `-# ${top.eps} episode${top.eps === 1 ? '' : 's'} this month`], top.c));
  }
  const rest = sum.topAnime.slice(1, 5);
  if (rest.length) {
    children.push(ui.text(ui.label('Also on repeat')));
    const gal = ui.coverGallery(rest.map((a) => ({ url: a.c, description: a.t })), { single: 'row' });
    if (gal) children.push(gal);
  }
  if (sum.topTags.length) {
    children.push(
      ui.text(`${ui.label('Your vibe')}\n## ${ui.esc(sum.topTags[0].genre)}\n${genreBars(sum.topTags.slice(0, 3).map((x) => ({ name: x.genre, value: x.eps })), 'eps', 3)}`)
    );
  }
  if (scored.length) {
    children.push(
      ui.text(`${ui.label('Highest rated')}\n**[${ui.esc(titleOf(scored[0].media))}](${scored[0].media.siteUrl})** · ${scored[0].score}/10${avg ? `\n-# average score ${avg.toFixed(1)} across ${scored.length} title${scored.length === 1 ? '' : 's'}` : ''}`)
    );
  }
  children.push(
    ui.text(
      `${ui.label('Habits')}\n🔥 Longest streak **${sum.longestStreak} day${sum.longestStreak === 1 ? '' : 's'}** · 📅 **${sum.activeDays}** active days${sum.busiestWeekday ? ` · ⭐ ${sum.busiestWeekday}s were your day` : ''}`
    )
  );
  const months = engine.lastMonths(ym, 6);
  children.push(ui.text(`-# \`${ui.sparkline(months.map((m) => g.su?.months?.[m]?.e || 0))}\` your last 6 months · made with AniTracker · /recap`));
  if (shareable && own) children.push(ui.actionRow(ui.button(`rc:share:${ownerId}:${ym}`, 'Share in this channel', { emoji: '📣', style: ui.ButtonStyle.Primary })));
  return ui.fit([ui.card(g.pal.accent, children)]);
}

/* ------------------------------ leaderboards ------------------------------ */

const BOARDS = {
  episodes: { label: 'Episodes this month', emoji: '📺', unit: 'eps' },
  streak: { label: 'Current streak', emoji: '🔥', unit: 'days' },
  completed: { label: 'Completed this month', emoji: '✅', unit: 'done' },
  recommendations: { label: 'Recommendations', emoji: '💜', unit: 'recs' },
  reviews: { label: 'Reviews written', emoji: '✍️', unit: 'reviews' },
  helpful: { label: 'Most helpful reviewers', emoji: '❤️', unit: 'likes' },
};

function guildBoards(s, guildId) {
  const cfg = s.guildConfig[guildId]?.leaderboards;
  return Object.keys(BOARDS).filter((k) => !cfg || cfg[k] !== false);
}

async function leaderboardPayload(guildId, board) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const enabled = guildBoards(s, guildId);
  if (!enabled.length) return ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text('### 🏆 Leaderboards are switched off in this server.\n-# A server manager can turn them on in `/settings` → Server.')])]);
  if (!enabled.includes(board)) board = enabled[0];

  let rows = [];
  const guildData = core.guilds[guildId] || { users: [] };
  if (['episodes', 'streak', 'completed'].includes(board)) {
    const seen = new Set();
    for (const t of guildData.users || []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const su = st.users[String(t.id)];
      const ownerId = social.discordFor(core, t.id);
      const tz = (ownerId && s.users[ownerId]?.prefs?.timezone) || social.DEFAULT_TZ;
      if (ownerId && s.users[ownerId] && !social.canView(social.peekUser(s, ownerId), null, ownerId, 'stats')) continue;
      const ym = engine.monthKey(engine.dayKey(new Date(), tz));
      let value = 0;
      if (board === 'episodes') value = su?.months?.[ym]?.e || 0;
      if (board === 'completed') value = su?.months?.[ym]?.c || 0;
      if (board === 'streak') value = engine.streakOf(su, tz).current;
      rows.push({ who: ownerId ? `<@${ownerId}>` : `**${ui.esc(t.username)}**`, value });
    }
  } else {
    const members = Object.entries(s.users).filter(([, u]) => (u.guilds || []).includes(guildId));
    for (const [uid, u] of members) {
      let value = 0;
      if (board === 'recommendations') value = (u.recommendations || []).length;
      if (board === 'reviews') value = Object.values(s.reviews).filter((r) => r.authorId === uid).length;
      if (board === 'helpful') value = Object.values(s.reviews).filter((r) => r.authorId === uid).reduce((a, r) => a + (r.likes?.length || 0), 0);
      rows.push({ who: `<@${uid}>`, value });
    }
  }
  rows = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  const meta = BOARDS[board];
  const medals = ['🥇', '🥈', '🥉'];
  const max = rows[0]?.value || 0;
  const lines = rows.map((r, i) => `${medals[i] || `\`#${i + 1}\``} ${r.who}\n${ui.bar(r.value, max, 12)}  **${ui.num(r.value)}** ${meta.unit}`);
  const children = [
    ui.text(`### 🏆 ${meta.emoji} ${meta.label}\n-# ${board === 'episodes' || board === 'completed' ? 'Resets every month · ' : ''}friendly competition — your own stats matter more`),
    ui.divider(),
    ui.text(lines.length ? lines.join('\n') : '*Nobody on the board yet — get watching!*'),
    ui.divider(),
    ui.select('lb:c', 'Switch leaderboard…', enabled.map((k) => ({ label: BOARDS[k].label, value: k, emoji: BOARDS[k].emoji, default: k === board }))),
  ];
  return ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
}

/* -------------------------------- handlers -------------------------------- */

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const me = interaction.user.id;
  const ns = parts[0];
  const updateOrPrivate = async (payload, ownerId) => {
    // Someone else's public card: give the clicker a private copy instead of changing it for everyone.
    const invoker = interaction.message?.interactionMetadata?.user?.id;
    const isPublic = interaction.message && !interaction.message.flags?.has?.(ui.EPHEMERAL);
    try {
      if (isPublic && invoker && invoker !== me) return await interaction.reply({ ...payload, flags: ui.V2 | ui.EPHEMERAL });
      await interaction.deferUpdate();
      return await interaction.editReply(await (typeof payload === 'function' ? payload() : payload));
    } catch (e) {
      console.error('Stats view update failed:', e.message);
    }
  };

  if (ns === 'st') {
    if (parts[1] === 'v') {
      const [, , owner, tab, ym] = parts;
      const isPublic = interaction.message && !interaction.message.flags?.has?.(ui.EPHEMERAL);
      const invoker = interaction.message?.interactionMetadata?.user?.id;
      if (isPublic && invoker && invoker !== me) {
        await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
        return interaction.editReply(await statsPayload(owner, me, tab, ym)).catch(() => {});
      }
      await interaction.deferUpdate().catch(() => {});
      return interaction.editReply(await statsPayload(owner, me, tab, ym)).catch((e) => console.error(e.message));
    }
    if (parts[1] === 'm') {
      await interaction.deferUpdate().catch(() => {});
      return interaction.editReply(await statsPayload(parts[2], me, 'month', interaction.values[0])).catch(() => {});
    }
  }
  if (ns === 'rc') {
    const [, kind, owner, ym] = parts;
    if (kind === 'open') {
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      return interaction.editReply(await require('./recaps').personalRecap(owner, me, ym, { shareable: true })).catch(() => {});
    }
    if (kind === 'share') {
      if (owner !== me) return interaction.reply({ content: 'Only the owner can share their recap.', flags: ui.EPHEMERAL }).catch(() => {});
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      try {
        await interaction.channel.send(await recapPayload(owner, me, ym, { shareable: false }));
        return interaction.editReply({ content: '📣 Recap shared!' });
      } catch (e) {
        return interaction.editReply({ content: `Couldn’t post here: ${e.message}` }).catch(() => {});
      }
    }
  }
  if (ns === 'lb') {
    return updateOrPrivate(await leaderboardPayload(interaction.guildId, interaction.values[0]));
  }
}

module.exports = {
  monthBlocks,
  lifetimeBlocks,
  streakBlocks,
  statsPayload,
  recapPayload,
  leaderboardPayload,
  guildBoards,
  BOARDS,
  gather,
  heatmap,
  onComponent,
};
