/* ---------------------------------------------------------------------------
 * Developer-portal edits to stats (dashboard → Edit Stats).
 *
 *  • All-time watches (core.watchStats): the per-show counter behind the
 *    "Most watched" board — set, add or remove a show.
 *  • A person's all-time episodes for one show (stats.users[id].months[*].a):
 *    raising it adds the difference to the latest month they watched it (or
 *    this month); lowering it takes it away from the newest months first.
 *    Month totals (episodes, minutes, freaky) move with it, so leaderboards,
 *    recaps and /stats all agree. Daily history (streaks) is left alone.
 * ------------------------------------------------------------------------- */

function monthKeyNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isFreaky(st, mediaId) {
  const sm = st.media?.[mediaId];
  if (!sm) return false;
  return Boolean(sm.fr ?? ((sm.g || []).includes('Ecchi') || (sm.g || []).includes('Hentai')));
}

// [{ mediaId, title, cover, eps, months }] for one AniList account, most watched first.
function animeTotals(st, anilistId) {
  const su = st.users?.[String(anilistId)];
  const per = new Map();
  for (const [ym, m] of Object.entries(su?.months || {})) {
    for (const [id, eps] of Object.entries(m.a || {})) {
      const x = per.get(id) || { mediaId: Number(id), eps: 0, months: [] };
      x.eps += eps;
      x.months.push(ym);
      per.set(id, x);
    }
  }
  return [...per.values()]
    .map((x) => ({ ...x, title: st.media?.[x.mediaId]?.t || `AniList #${x.mediaId}`, cover: st.media?.[x.mediaId]?.c || null, freaky: isFreaky(st, x.mediaId) }))
    .sort((a, b) => b.eps - a.eps);
}

function userTotals(st, anilistId) {
  const su = st.users?.[String(anilistId)];
  let episodes = 0;
  let minutes = 0;
  let completed = 0;
  const shows = new Set();
  for (const m of Object.values(su?.months || {})) {
    episodes += m.e || 0;
    minutes += m.m || 0;
    completed += m.c || 0;
    for (const id of Object.keys(m.a || {})) shows.add(id);
  }
  return { episodes, minutes, completed, anime: shows.size, months: Object.keys(su?.months || {}).length };
}

/**
 * Set someone's all-time episode count for one show.
 * @returns { before, after } or throws
 */
function setAnimeEpisodes(st, anilistId, mediaId, episodes, { minutesPerEp = null } = {}) {
  const su = st.users?.[String(anilistId)];
  if (!su) throw new Error('No stats for that AniList account yet.');
  const target = Math.max(0, Math.min(100000, Math.round(Number(episodes))));
  if (!Number.isFinite(target)) throw new Error('Episodes must be a number.');
  const id = String(Number(mediaId));
  su.months ||= {};
  const withShow = Object.keys(su.months)
    .filter((ym) => su.months[ym].a?.[id])
    .sort();
  const before = withShow.reduce((n, ym) => n + su.months[ym].a[id], 0);
  let delta = target - before;
  if (!delta) return { before, after: before };
  const freaky = isFreaky(st, id);
  const perEp = (m) => minutesPerEp || (m.e ? Math.max(1, Math.round((m.m || 0) / m.e)) : 24);

  if (delta > 0) {
    const ym = withShow[withShow.length - 1] || monthKeyNow();
    const m = (su.months[ym] ||= { e: 0, m: 0, s: 0, c: 0, g: {}, t: {}, f: 0, a: {}, w: [0, 0, 0, 0, 0, 0, 0] });
    m.a ||= {};
    const mins = perEp(m);
    m.a[id] = (m.a[id] || 0) + delta;
    m.e = (m.e || 0) + delta;
    m.m = (m.m || 0) + delta * mins;
    if (freaky) m.f = (m.f || 0) + delta;
  } else {
    let left = -delta;
    for (const ym of withShow.slice().reverse()) {
      if (!left) break;
      const m = su.months[ym];
      const mins = perEp(m);
      const take = Math.min(left, m.a[id]);
      m.a[id] -= take;
      if (!m.a[id]) delete m.a[id];
      m.e = Math.max(0, (m.e || 0) - take);
      m.m = Math.max(0, (m.m || 0) - take * mins);
      if (freaky) m.f = Math.max(0, (m.f || 0) - take);
      left -= take;
    }
  }
  su.adminEdits = (su.adminEdits || 0) + 1;
  const after = Object.values(su.months).reduce((n, m) => n + (m.a?.[id] || 0), 0);
  return { before, after };
}

// All-time watches (core.watchStats) — the "Most watched" counter.
function setWatchCount(core, mediaId, count, info = {}) {
  core.watchStats ||= {};
  const key = String(Number(mediaId));
  const n = Math.max(0, Math.min(1000000, Math.round(Number(count))));
  if (!Number.isFinite(n)) throw new Error('Count must be a number.');
  if (n === 0) {
    delete core.watchStats[key];
    return null;
  }
  const e = core.watchStats[key] || { title: info.title || `AniList #${key}`, siteUrl: info.siteUrl || `https://anilist.co/anime/${key}`, count: 0 };
  e.count = n;
  if (info.title) e.title = info.title;
  if (info.siteUrl) e.siteUrl = info.siteUrl;
  if (info.cover) e.cover = info.cover;
  core.watchStats[key] = e;
  return e;
}

module.exports = { animeTotals, userTotals, setAnimeEpisodes, setWatchCount };
