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
  const artRoutes = require('./artRoutes');
  const bl = artRoutes.bannerListUrl(top.map((a) => ({ mediaId: a.mediaId, detail: `${a.eps} episode${a.eps === 1 ? '' : 's'} this month` })));
  const g = bl ? ui.gallery([{ url: bl, description: top.map((a) => a.t).join(' · ') }]) : null;
  if (g) {
    artRoutes.warm(bl);
    blocks.push(g);
  }
  const maxEps = top[0]?.eps || 0;
  blocks.push(ui.text(top.map((a, i) => `\`${String(i + 1).padStart(2, '0')}\` **${a.u ? `[${ui.esc(ui.clip(a.t, 60))}](${a.u})` : ui.esc(a.t)}** · ${a.eps} ep${a.eps === 1 ? '' : 's'}${g ? '' : `\n\`${ui.bar(a.eps, maxEps, 12)}\``}`).join('\n')));
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
  const payload = ui.fit([ui.card(g.pal.accent, children)]);
  await require('./artRoutes').warmPayload(payload);
  return payload;
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
    const payload = ui.fit([ui.card(g.pal.accent, children)]);
  await require('./artRoutes').warmPayload(payload);
  return payload;
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
    const artRoutes = require('./artRoutes');
    // The #1 is already the banner at the top; list the rest as banners.
    const five = sum.topAnime.slice(base ? 1 : 0, 5);
    children.push(ui.text(`${ui.label('Your #1 anime')}\n### ${top.u ? `[${ui.esc(top.t)}](${top.u})` : ui.esc(top.t)}\n-# ${top.eps} episode${top.eps === 1 ? '' : 's'} this month`));
    const bl = five.length ? artRoutes.bannerListUrl(five.map((a) => ({ mediaId: a.mediaId, detail: `${a.eps} episode${a.eps === 1 ? '' : 's'}` })), 'Also on repeat', { start: base ? 2 : 1 }) : null;
    const gal = bl ? ui.gallery([{ url: bl, description: five.map((a) => a.t).join(' · ') }]) : null;
    if (gal) {
      artRoutes.warm(bl);
      children.push(gal);
    } else if (five.length) {
      const maxEps = top.eps || 0;
      children.push(ui.text(`${ui.label('Also on repeat')}\n${five.map((a) => `\`${ui.bar(a.eps, maxEps, 10)}\` **${ui.esc(ui.clip(a.t, 50))}** · ${a.eps} eps`).join('\n')}`));
    }
  }
  // Freaky corner: the ecchi / fan-service shows this month, if any.
  const freaky = Object.entries(g.su?.months?.[ym]?.a || {})
    .filter(([id]) => {
      const sm = g.st.media?.[id];
      return sm && (sm.fr ?? ((sm.g || []).includes('Ecchi') ? 1 : 0));
    })
    .map(([id, eps]) => ({ t: g.st.media[id].t, eps }))
    .sort((a, b) => b.eps - a.eps);
  if (freaky.length) {
    children.push(ui.text(`${ui.label('Freaky corner 😳')}\n${freaky.slice(0, 4).map((x) => `**${ui.esc(ui.clip(x.t, 50))}** · ${x.eps} eps`).join('  ·  ')}`));
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
  const payload = ui.fit([ui.card(g.pal.accent, children)]);
  await require('./artRoutes').warmPayload(payload);
  return payload;
}

/* ------------------------------ leaderboards ------------------------------ */

const BOARDS = {
  episodes: { label: 'Episodes this month', emoji: '📺', unit: 'eps', accent: 0x3db4f2 },
  streak: { label: 'Current streak', emoji: '🔥', unit: 'days', accent: 0xf97316 },
  completed: { label: 'Completed this month', emoji: '✅', unit: 'done', accent: 0x22c55e },
  recommendations: { label: 'Recommendations', emoji: '💜', unit: 'recs', accent: 0xa855f7 },
  reviews: { label: 'Reviews written', emoji: '✍️', unit: 'reviews', accent: 0x38bdf8 },
  helpful: { label: 'Most helpful reviewers', emoji: '❤️', unit: 'likes', accent: 0xf43f5e },
  ratings: { label: 'Most anime rated', emoji: '⭐', unit: 'rated', accent: 0xfacc15 },
  freaky: { label: 'Freakiest in the server', emoji: '😳', unit: 'ecchi eps', accent: 0xec4899, adminNote: 'Off by default · counts ecchi / fan-service episodes', optIn: true },
};

// Boards switched on in a server. Opt-in boards (freaky) stay off until an admin turns them on.
function guildBoards(s, guildId) {
  const cfg = s.guildConfig[guildId]?.leaderboards;
  return Object.keys(BOARDS).filter((k) => (cfg && k in cfg ? cfg[k] !== false : !BOARDS[k].optIn));
}

// All-time "freaky" episodes: tagged ecchi/fan-service shows (older months
// only know genres, so the Ecchi genre counts there).
function freakyEpisodes(su) {
  let n = 0;
  for (const m of Object.values(su?.months || {})) n += m.f || (m.g?.Ecchi || 0) + (m.g?.Hentai || 0);
  return n;
}

// Shows someone watched that count as "freaky", most episodes first.
function freakyShows(st, su) {
  const per = {};
  for (const m of Object.values(su?.months || {})) {
    for (const [id, eps] of Object.entries(m.a || {})) {
      const sm = st.media?.[id];
      if (!sm) continue;
      const freaky = sm.fr ?? ((sm.g || []).includes('Ecchi') || (sm.g || []).includes('Hentai') ? 1 : 0);
      if (freaky) per[id] = (per[id] || 0) + eps;
    }
  }
  return Object.entries(per)
    .map(([id, eps]) => ({ mediaId: Number(id), eps, title: st.media[id]?.t || 'Unknown' }))
    .sort((a, b) => b.eps - a.eps);
}

// Display names for a server's members (nickname > global name > username).
async function memberNames(guildId, ids) {
  const out = {};
  const guild = ctx.client?.guilds?.cache.get(guildId);
  const want = [...new Set(ids.filter(Boolean))];
  if (guild?.members?.cache && want.length) {
    try {
      const missing = want.filter((id) => !guild.members.cache.has(id));
      if (missing.length) await guild.members.fetch({ user: missing.slice(0, 100) }).catch(() => null);
      for (const id of want) {
        const m = guild.members.cache.get(id);
        if (m) out[id] = m.displayName;
      }
    } catch {
      /* names fall back below */
    }
  }
  for (const id of want) {
    if (out[id]) continue;
    const u = ctx.client?.users?.cache.get(id);
    if (u) out[id] = u.globalName || u.username;
  }
  return out;
}

/**
 * The rows behind a leaderboard (used by the card and its image).
 * @returns { board, enabled, offNote, subtitle, rows: [{ discordId, anilistId, name, fallbackName, avatar, value, detail, shows }] }
 */
async function leaderboardRows(guildId, board) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const enabled = guildBoards(s, guildId);
  let offNote = null;
  if (enabled.length && !enabled.includes(board)) {
    if (BOARDS[board]) offNote = `-# ${BOARDS[board].emoji} ${BOARDS[board].label} is switched off in this server — admins can turn it on in \`/serversettings\` → Recaps & leaderboards.`;
    board = enabled[0];
  }
  const guildData = core.guilds[guildId] || { users: [] };
  const linkedAvatar = (discordId) => core.linkedAccounts?.[discordId]?.avatar || null;
  let rows = [];

  if (['episodes', 'streak', 'completed', 'freaky'].includes(board)) {
    const seen = new Set();
    for (const t of guildData.users || []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const su = st.users[String(t.id)];
      const ownerId = social.discordFor(core, t.id);
      const tz = (ownerId && s.users[ownerId]?.prefs?.timezone) || social.DEFAULT_TZ;
      if (ownerId && s.users[ownerId] && !social.canView(social.peekUser(s, ownerId), null, ownerId, 'stats')) continue;
      const ym = engine.monthKey(engine.dayKey(new Date(), tz));
      const month = su?.months?.[ym];
      const topOf = (m) => {
        const best = Object.entries(m?.a || {}).sort((a, b) => b[1] - a[1])[0];
        return best ? st.media?.[best[0]]?.t : null;
      };
      let value = 0;
      let detail = '';
      let shows = null;
      if (board === 'episodes') {
        value = month?.e || 0;
        const top = topOf(month);
        detail = [top ? `Top: ${top}` : null, month ? `${Object.keys(month.a || {}).length} anime` : null, month?.m ? `${ui.hours(month.m)} h` : null].filter(Boolean).join(' · ');
      }
      if (board === 'completed') {
        value = month?.c || 0;
        detail = month ? `${Object.keys(month.a || {}).length} anime · ${ui.num(month.e || 0)} eps this month` : '';
      }
      if (board === 'streak') {
        const sk = engine.streakOf(su, tz);
        value = sk.current;
        detail = `Best ever: ${sk.longest} day${sk.longest === 1 ? '' : 's'}${topOf(month) ? ` · lately: ${topOf(month)}` : ''}`;
      }
      if (board === 'freaky') {
        value = freakyEpisodes(su);
        shows = freakyShows(st, su);
        detail = shows.length ? shows.slice(0, 3).map((x) => x.title).join(', ') : '';
      }
      rows.push({ discordId: ownerId, anilistId: t.id, fallbackName: t.username, avatar: t.avatar || linkedAvatar(ownerId), value, detail, shows });
    }
  } else {
    const ratings = require('./ratings');
    const members = Object.entries(s.users).filter(([, u]) => (u.guilds || []).includes(guildId));
    for (const [uid, u] of members) {
      let value = 0;
      let detail = '';
      const mine = Object.values(s.reviews).filter((r) => r.authorId === uid);
      if (board === 'recommendations') {
        value = (u.recommendations || []).length;
        detail = (u.recommendations || []).slice(0, 3).map((e) => e.title).join(', ');
      }
      if (board === 'reviews') {
        value = mine.length;
        const latest = mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        detail = latest ? `Latest: ${latest.mediaTitle}` : '';
      }
      if (board === 'helpful') {
        value = mine.reduce((a, r) => a + (r.likes?.length || 0), 0);
        detail = `${mine.length} review${mine.length === 1 ? '' : 's'}`;
      }
      if (board === 'ratings') {
        const map = ratings.ratingsOf(s, uid);
        value = map.size;
        if (map.size) {
          const all = [...map.values()];
          const avg = all.reduce((a, r) => a + r.s, 0) / all.length;
          const best = all.sort((a, b) => b.s - a.s)[0];
          detail = `Average ${avg.toFixed(1)}${best?.t ? ` · top: ${best.t}` : ''}`;
        }
      }
      const al = social.anilistFor(core, uid);
      rows.push({ discordId: uid, anilistId: al?.id || null, fallbackName: al?.name || null, avatar: linkedAvatar(uid), value, detail });
    }
  }
  rows = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  const names = await memberNames(guildId, rows.map((r) => r.discordId));
  for (const r of rows) {
    r.name = (r.discordId && names[r.discordId]) || r.fallbackName || 'Someone';
    if (!r.avatar && r.discordId) {
      const u = ctx.client?.users?.cache.get(r.discordId);
      r.avatar = u ? u.displayAvatarURL({ extension: 'png', size: 128 }) : null;
    }
  }
  const subtitle =
    board === 'freaky'
      ? 'All-time ecchi & fan-service episodes · just for fun'
      : board === 'episodes' || board === 'completed'
        ? `${engine.monthName(engine.monthKey(engine.dayKey(new Date(), social.DEFAULT_TZ)))} · resets every month`
        : 'Friendly competition · your own stats matter more';
  return { board, enabled, offNote, subtitle, rows };
}

async function leaderboardPayload(guildId, board) {
  const s = await ctx.loadSocial();
  if (!guildBoards(s, guildId).length) return ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text('### 🏆 Leaderboards are switched off in this server.\n-# A server manager can turn them on in `/serversettings` → Recaps & leaderboards.')])]);
  const res = await leaderboardRows(guildId, board);
  board = res.board;
  const meta = BOARDS[board];
  const { rows } = res;
  const artRoutes = require('./artRoutes');
  const children = [ui.text(`### 🏆 ${meta.emoji} ${meta.label}\n-# ${res.subtitle}`)];
  if (res.offNote) children.push(ui.text(res.offNote));

  const url = artRoutes.leaderboardUrl(guildId, board, rows);
  const g = url ? ui.gallery([{ url, description: `${meta.label}: ${rows.slice(0, 3).map((r) => r.name).join(', ')}` }]) : null;
  if (g) {
    artRoutes.warm(url);
    children.push(g);
    // Clickable names under the picture (mentions never ping).
    const who = rows.slice(0, 10).map((r, i) => `\`${i + 1}\` ${r.discordId ? `<@${r.discordId}>` : `**${ui.esc(r.name)}**`} ${ui.num(r.value)}`);
    if (who.length) children.push(ui.text(`-# ${who.join('  ·  ')}`));
  } else {
    const max = rows[0]?.value || 0;
    const lines = rows.map((r, i) => `\`#${i + 1}\` ${r.discordId ? `<@${r.discordId}>` : `**${ui.esc(r.name)}**`}  **${ui.num(r.value)}** ${meta.unit}\n\`${ui.bar(r.value, max, 14)}\`${r.detail ? `  -# ${ui.esc(ui.clip(r.detail, 70))}` : ''}`);
    children.push(ui.text(lines.length ? lines.join('\n') : '*Nobody on the board yet — get watching!*'));
  }

  // Freaky board: the shows behind it, as banners.
  if (board === 'freaky' && rows.length) {
    const per = new Map();
    for (const r of rows) {
      for (const sh of r.shows || []) {
        const x = per.get(sh.mediaId) || { mediaId: sh.mediaId, title: sh.title, eps: 0, who: [] };
        x.eps += sh.eps;
        x.who.push(`${r.name} ${sh.eps}`);
        per.set(sh.mediaId, x);
      }
    }
    const top = [...per.values()].sort((a, b) => b.eps - a.eps).slice(0, 5);
    const bl = artRoutes.bannerListUrl(top.map((x) => ({ mediaId: x.mediaId, detail: `${x.eps} eps · ${x.who.slice(0, 3).join(' · ')}` })), 'The freaky picks');
    const bg = bl ? ui.gallery([{ url: bl, description: top.map((x) => x.title).join(' · ') }]) : null;
    if (bg) {
      artRoutes.warm(bl);
      children.push(bg);
    } else if (top.length) children.push(ui.text(`${ui.label('The freaky picks')}\n${top.map((x, i) => `\`${i + 1}\` **${ui.esc(x.title)}** · ${x.eps} eps`).join('\n')}`));
  }

  // Episodes board: what the server watched most this month, as banners.
  if (board === 'episodes' && rows.length) {
    const st = await ctx.loadStats();
    const per = new Map();
    for (const r of rows) {
      const su = st.users[String(r.anilistId)];
      const ym = engine.monthKey(engine.dayKey(new Date(), social.DEFAULT_TZ));
      for (const [id, eps] of Object.entries(su?.months?.[ym]?.a || {})) {
        const x = per.get(id) || { mediaId: Number(id), eps: 0, watchers: 0 };
        x.eps += eps;
        x.watchers += 1;
        per.set(id, x);
      }
    }
    const top = [...per.values()].sort((a, b) => b.watchers - a.watchers || b.eps - a.eps).slice(0, 3);
    const bl = artRoutes.bannerListUrl(top.map((x) => ({ mediaId: x.mediaId, detail: `${x.watchers} watching · ${x.eps} ep${x.eps === 1 ? '' : 's'} this month` })), 'Most watched here this month');
    const bg = bl ? ui.gallery([{ url: bl, description: 'Most watched this month' }]) : null;
    if (bg) {
      artRoutes.warm(bl);
      children.push(bg);
    }
  }

  children.push(ui.divider());
  children.push(ui.select('lb:c', 'Switch leaderboard…', res.enabled.map((k) => ({ label: BOARDS[k].label, value: k, emoji: BOARDS[k].emoji, default: k === board }))));
  const payload = ui.fit([ui.card(meta.accent || ui.ANILIST_BLUE, children)]);
  await artRoutes.warmPayload(payload);
  return payload;
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
    const resolve = () => (typeof payload === 'function' ? payload() : payload);
    try {
      // Acknowledge first: building a card can wait a few seconds for its images.
      if (isPublic && invoker && invoker !== me) {
        await interaction.deferReply({ flags: ui.EPHEMERAL });
        return await interaction.editReply(await resolve());
      }
      await interaction.deferUpdate();
      return await interaction.editReply(await resolve());
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
    return updateOrPrivate(() => leaderboardPayload(interaction.guildId, interaction.values[0]));
  }
}

module.exports = {
  monthBlocks,
  lifetimeBlocks,
  streakBlocks,
  statsPayload,
  recapPayload,
  leaderboardPayload,
  leaderboardRows,
  freakyShows,
  memberNames,
  guildBoards,
  BOARDS,
  gather,
  heatmap,
  onComponent,
};
