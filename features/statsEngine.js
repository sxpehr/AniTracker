/* ---------------------------------------------------------------------------
 * Watch-history recording + stats maths (no Discord UI in here).
 *
 * The poller hands every new AniList list activity to record(). We keep, per
 * AniList user:
 *   days   { 'YYYY-MM-DD': [episodes, minutes, completed, {mediaId:eps}] }
 *          (~13 months, in their time zone; the per-show map is kept ~10 weeks
 *          for weekly recaps)
 *   months { 'YYYY-MM': { e, m, s, c, g:{genre:eps}, t:{tag:eps}, f, a:{mediaId:eps}, w:[7] } }  (forever)
 *          t = specific AniList tags (Isekai, Satire…), f = "freaky" episodes
 *   media  { mediaId: { p: highest episode seen } }  ← prevents double counting
 *
 * Lifetime totals come straight from AniList (it already knows everything),
 * so nothing here duplicates what AniList stores.
 * ------------------------------------------------------------------------- */

const { statTags, isFreaky } = require('./tags');

const fmtCache = new Map();
function dayKey(date, tz) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    fmtCache.set(tz, fmt);
  }
  return fmt.format(date); // YYYY-MM-DD
}
const monthKey = (day) => day.slice(0, 7);

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
}

function parseProgress(progress) {
  if (!progress) return null;
  const nums = String(progress)
    .split('-')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

function ensureUser(stats, anilistId) {
  const key = String(anilistId);
  if (!stats.users[key]) stats.users[key] = { lastActivityId: 0, media: {}, days: {}, months: {}, longest: 0, longestEnd: null, activeDays: 0, lastDay: null };
  const su = stats.users[key];
  su.media ||= {};
  su.days ||= {};
  su.months ||= {};
  return su;
}

function ensureMonth(su, ym) {
  if (!su.months[ym]) su.months[ym] = { e: 0, m: 0, s: 0, c: 0, g: {}, t: {}, f: 0, a: {}, w: [0, 0, 0, 0, 0, 0, 0] };
  const m = su.months[ym];
  m.t ||= {};
  m.f ||= 0;
  return m;
}

// Returns how many new activities were counted. `extra` = merged/list
// events from feed.js (already known to be new, so no id filter).
function record(stats, anilistId, activities, tz, extra = []) {
  const su = ensureUser(stats, anilistId);
  const fresh = activities.filter((a) => a.id > (su.lastActivityId || 0)).sort((a, b) => a.id - b.id);
  for (const act of fresh) su.lastActivityId = Math.max(su.lastActivityId || 0, act.id);
  const all = [...fresh, ...(extra || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let counted = 0;

  for (const act of all) {
    if (act.__typename !== 'ListActivity' || !act.media || act.media.type !== 'ANIME') continue;
    const media = act.media;
    const status = (act.status || '').toLowerCase();
    const mm = (su.media[media.id] ||= {});
    const range = parseProgress(act.progress);
    let eps = 0;
    let started = 0;
    let completed = 0;

    if (status.includes('watched episode') && range) {
      const [start, end] = range;
      if (status.includes('rewatch')) {
        eps = end - start + 1;
      } else {
        const prev = mm.p || 0;
        eps = prev ? Math.max(0, end - Math.max(start - 1, prev)) : end - start + 1;
        mm.p = Math.max(prev, end);
        if (start === 1 && !prev) started = 1;
      }
    } else if (status.includes('complet')) {
      const total = media.episodes || 0;
      const prev = mm.p || 0;
      if (total && prev && prev < total) eps = total - prev;
      else if (!prev) eps = 1; // finishing usually logs the final episode as "completed"
      if (total) mm.p = total;
      if (!prev && total === 1) started = 1; // a movie: started and finished
      completed = 1;
    } else {
      continue; // planning / paused / dropped don't count as watching
    }

    eps = Math.min(eps, 500);
    const minutes = eps * (media.duration || 24);
    const day = dayKey(new Date(act.createdAt * 1000), tz);
    const month = ensureMonth(su, monthKey(day));

    if (!stats.media[media.id]) stats.media[media.id] = {};
    const sm = stats.media[media.id];
    Object.assign(sm, {
      t: media.title?.english || media.title?.romaji || 'Unknown',
      c: media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || null,
      g: (media.genres || []).slice(0, 4),
      u: media.siteUrl,
    });
    if (media.bannerImage) sm.b = media.bannerImage;
    if (media.episodes) sm.n = media.episodes;
    if (Array.isArray(media.tags)) {
      sm.tg = statTags(media.tags, media.genres);
      sm.fr = isFreaky(media.tags, media.genres) ? 1 : 0;
    }
    const tagsForStats = sm.tg || [];
    const freaky = sm.fr ?? (isFreaky(null, media.genres) ? 1 : 0);

    const d = su.days[day] || [0, 0, 0, {}];
    if (d.length < 4) d.push(...[0, 0, 0, {}].slice(d.length));
    if (completed) d[2] = (d[2] || 0) + 1;
    if (eps > 0) {
      d[0] += eps;
      d[1] += minutes;
      d[3] = d[3] || {};
      d[3][media.id] = (d[3][media.id] || 0) + eps;
    }
    if (eps > 0 || completed) su.days[day] = d;

    if (eps > 0) {
      const wasActive = d[0] - eps > 0;
      if (!wasActive) su.activeDays = (su.activeDays || 0) + 1;
      if (!su.lastDay || day > su.lastDay) su.lastDay = day;
      month.e += eps;
      month.m += minutes;
      month.w[weekday(day)] += eps;
      month.a[media.id] = (month.a[media.id] || 0) + eps;
      for (const g of media.genres || []) month.g[g] = (month.g[g] || 0) + eps;
      for (const t of tagsForStats) month.t[t] = (month.t[t] || 0) + eps;
      if (freaky) month.f += eps;
    }
    month.s += started;
    month.c += completed;
    counted++;
  }

  // Keep the longest-streak record even after old days are trimmed.
  const s = streakOf(su, tz);
  if (s.longest > (su.longest || 0)) {
    su.longest = s.longest;
    su.longestEnd = s.longestEnd;
  }
  return counted;
}

// Current streak counts consecutive active days ending today — or yesterday,
// so an evening watcher's streak doesn't look broken first thing in the morning.
function streakOf(su, tz) {
  const today = dayKey(new Date(), tz);
  const active = (d) => Boolean(su?.days?.[d]?.[0]);
  let current = 0;
  let cursor = active(today) ? today : addDays(today, -1);
  while (active(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let longestEnd = null;
  let run = 0;
  let prev = null;
  for (const d of Object.keys(su?.days || {}).filter(active).sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = d;
    }
    prev = d;
  }
  if ((su?.longest || 0) > longest) {
    longest = su.longest;
    longestEnd = su.longestEnd;
  }
  return { current, longest, longestEnd, activeToday: active(today), lastDay: su?.lastDay || null, activeDays: su?.activeDays || 0 };
}

// Longest streak inside one month (for recaps).
function longestInMonth(su, ym) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of Object.keys(su?.days || {}).filter((d) => d.startsWith(ym) && su.days[d][0]).sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function monthSummary(stats, su, ym) {
  const m = su?.months?.[ym];
  if (!m) return null;
  const topAnime = Object.entries(m.a || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, eps]) => ({ mediaId: Number(id), eps, ...(stats.media[id] || {}) }));
  const topGenres = Object.entries(m.g || {})
    .sort((a, b) => b[1] - a[1])
    .map(([genre, eps]) => ({ genre, eps }));
  const days = Object.keys(su.days || {}).filter((d) => d.startsWith(ym) && su.days[d][0]).length;
  const week = Array.isArray(m.w) && m.w.length === 7 ? m.w : [0, 0, 0, 0, 0, 0, 0];
  const wd = week.indexOf(Math.max(...week));
  // Specific tags (Isekai, Satire…) when we have them; genres for older months.
  const topTags = Object.entries(m.t || {})
    .sort((a, b) => b[1] - a[1])
    .map(([genre, eps]) => ({ genre, eps }));
  return {
    month: ym,
    topTags: topTags.length ? topTags : topGenres,
    freaky: m.f || 0,
    episodes: m.e,
    minutes: m.m,
    started: m.s,
    completedLocal: m.c,
    animeCount: Object.keys(m.a).length,
    topAnime,
    topGenres,
    activeDays: days,
    busiestWeekday: Math.max(...m.w) > 0 ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd] : null,
    longestStreak: longestInMonth(su, ym),
  };
}

// Any date range (inclusive, 'YYYY-MM-DD'), e.g. a week for weekly recaps.
function rangeSummary(stats, su, fromDay, toDay) {
  const out = { episodes: 0, minutes: 0, completed: 0, activeDays: 0, longestStreak: 0, anime: {}, topAnime: [], topTags: [], freaky: 0 };
  if (!su?.days) return out;
  let run = 0;
  let prev = null;
  for (const d of Object.keys(su.days).filter((k) => k >= fromDay && k <= toDay).sort()) {
    const [e = 0, m = 0, c = 0, a = {}] = su.days[d];
    out.episodes += e;
    out.minutes += m;
    out.completed += c || 0;
    for (const [id, n] of Object.entries(a || {})) out.anime[id] = (out.anime[id] || 0) + n;
    if (e) {
      out.activeDays++;
      run = prev && addDays(prev, 1) === d ? run + 1 : 1;
      out.longestStreak = Math.max(out.longestStreak, run);
      prev = d;
    }
  }
  out.topAnime = Object.entries(out.anime)
    .sort((x, y) => y[1] - x[1])
    .map(([id, eps]) => ({ mediaId: Number(id), eps, ...(stats.media[id] || {}) }));
  const tags = {};
  for (const a of out.topAnime) {
    for (const t of a.tg || a.g || []) tags[t] = (tags[t] || 0) + a.eps;
    if (a.fr) out.freaky += a.eps;
  }
  out.topTags = Object.entries(tags)
    .sort((x, y) => y[1] - x[1])
    .map(([genre, eps]) => ({ genre, eps }));
  out.animeCount = out.topAnime.length;
  return out;
}

// Monday..Sunday of the week before the one containing `day`.
function previousWeek(day) {
  const dow = (weekday(day) + 6) % 7; // 0 = Monday
  const thisMonday = addDays(day, -dow);
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1), key: addDays(thisMonday, -7) };
}

function lastMonths(fromYm, n) {
  const [y, m] = fromYm.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function monthName(ym, long = true) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
}

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: y * 10000 + m * 100 + 0, to: y * 10000 + m * 100 + last + 1 };
}

module.exports = {
  dayKey,
  monthKey,
  addDays,
  record,
  streakOf,
  longestInMonth,
  monthSummary,
  lastMonths,
  monthName,
  monthBounds,
  ensureUser,
  rangeSummary,
  previousWeek,
  weekday,
};
