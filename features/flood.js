/* ---------------------------------------------------------------------------
 * Flood protection for activity posts.
 *
 * Normally a check finds one or two new updates per person. Sometimes a pile
 * builds up (the bot was down, AniList was slow, someone batch-updated their
 * list) and posting all of it would flood the channel. Per person, per check:
 *
 *  1. Collapse: several updates for the same show become one
 *     ("Watched episode 3", "4", "5" → "Watched episodes 3 - 5";
 *      episodes then "Completed" → just the Completed post).
 *  2. Never twice: an update that was already posted here within 12 hours
 *     (same show, status and progress — or episodes an earlier post already
 *     covered) is skipped.
 *  3. Burst limit: only the newest `burst` updates post on their own
 *     (server setting, default 3). Older ones, and anything more than 6 hours
 *     old, go into ONE "caught up" post instead.
 *
 * Pure functions: index.js does the sending.
 * ------------------------------------------------------------------------- */

const STALE_SECS = 6 * 3600; // older than this → bundled, not posted on its own
const DUP_TTL_MS = 12 * 3600 * 1000;
const MAX_KEYS = 600; // remembered "already posted" keys per server
const GUILD_CAP = 12; // separate posts per server per check, across everyone

function nums(progress) {
  return String(progress || '')
    .split('-')
    .map((x) => parseInt(x.trim(), 10))
    .filter(Number.isFinite);
}

function isProgressStatus(status) {
  const s = (status || '').toLowerCase();
  return /(watched|read|rewatched|reread) (episode|chapter)/.test(s) || s === 'watched episode' || s === 'read chapter';
}

function isList(ev) {
  return ev && ev.__typename === 'ListActivity' && ev.media;
}

// Several updates for one show → one. Events must be oldest → newest.
// Returns { kept, folded } (folded = absorbed into a kept one).
function collapse(events) {
  const byMedia = new Map();
  const order = [];
  for (const ev of events) {
    if (!isList(ev)) {
      order.push({ single: ev });
      continue;
    }
    const k = `${ev.media.type || 'ANIME'}:${ev.media.id}`;
    if (!byMedia.has(k)) {
      byMedia.set(k, []);
      order.push({ key: k });
    }
    byMedia.get(k).push(ev);
  }
  const kept = [];
  const folded = [];
  for (const slot of order) {
    if (slot.single) {
      kept.push(slot.single);
      continue;
    }
    const group = byMedia.get(slot.key);
    const last = group[group.length - 1];
    if (group.length === 1) {
      kept.push(last);
      continue;
    }
    let result = last;
    if (isProgressStatus(last.status)) {
      // Merge the run of same-status progress updates that ends with `last`.
      let i = group.length - 1;
      while (i > 0 && group[i - 1].status === last.status && isProgressStatus(group[i - 1].status)) i--;
      const run = group.slice(i);
      const all = run.flatMap((e) => nums(e.progress));
      if (all.length) {
        const lo = Math.min(...all);
        const hi = Math.max(...all);
        result = { ...last, progress: lo === hi ? String(hi) : `${lo} - ${hi}` };
      }
    }
    kept.push(result);
    for (const e of group) if (e !== last) folded.push(e);
  }
  // Keep chronological order by the kept event's time.
  kept.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id || 0) - (b.id || 0));
  return { kept, folded };
}

function dupKey(anilistId, ev) {
  if (!isList(ev)) return `${anilistId}:a${ev.id}`;
  return `${anilistId}:${ev.media.id}:${(ev.status || '').toLowerCase()}:${String(ev.progress || '').replace(/\s+/g, '')}`;
}
// Highest episode/chapter already posted for this show + status ("watched episode").
function hiKey(anilistId, ev) {
  return `${anilistId}:${ev.media.id}:${(ev.status || '').toLowerCase()}:hi`;
}
const stamp = (v) => (Array.isArray(v) ? v[0] : v);

// Was this already covered by a recent post? Exact repeat, or episodes that a
// previous post already included ("Watched episode 4" after "episodes 3 - 4").
function alreadyPosted(recent, anilistId, ev, now) {
  const exact = recent[dupKey(anilistId, ev)];
  if (exact && now - stamp(exact) < DUP_TTL_MS) return true;
  if (isList(ev) && isProgressStatus(ev.status)) {
    const hi = recent[hiKey(anilistId, ev)];
    const top = Math.max(...nums(ev.progress), -1);
    if (Array.isArray(hi) && now - hi[0] < DUP_TTL_MS && top >= 0 && top <= hi[1]) return true;
  }
  return false;
}

/**
 * Decide what to post for one person.
 * @param events      new events, oldest → newest (already filtered for server settings)
 * @param o.anilistId
 * @param o.burst     separate posts allowed
 * @param o.recent    guildData.postKeys ({ key: ms }) — read only here
 * @param o.now       ms
 * @param o.capLeft   separate posts this server can still make this check
 * @returns { individual, bundled, duplicates, folded }
 */
function plan(events, { anilistId, burst = 3, recent = {}, now = Date.now(), capLeft = GUILD_CAP } = {}) {
  const { kept, folded } = collapse(events);
  const duplicates = [];
  const fresh = [];
  const stale = [];
  const nowSecs = now / 1000;
  for (const ev of kept) {
    if (alreadyPosted(recent, anilistId, ev, now)) {
      duplicates.push(ev);
      continue;
    }
    if (ev.createdAt && nowSecs - ev.createdAt > STALE_SECS) stale.push(ev);
    else fresh.push(ev);
  }
  const allowed = Math.max(0, Math.min(Math.max(1, burst | 0), capLeft));
  const individual = allowed ? fresh.slice(-allowed) : [];
  let bundled = [...stale, ...fresh.slice(0, fresh.length - individual.length)];
  bundled.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  // A "bundle" of one is just a post.
  if (bundled.length === 1 && capLeft > individual.length) {
    individual.unshift(bundled[0]);
    bundled = [];
  }
  individual.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id || 0) - (b.id || 0));
  return { individual, bundled, duplicates, folded };
}

// Remember what was posted; drops expired keys and keeps the map bounded.
function remember(recent, anilistId, events, now = Date.now()) {
  for (const ev of events) {
    recent[dupKey(anilistId, ev)] = now;
    if (isList(ev) && isProgressStatus(ev.status)) {
      const top = Math.max(...nums(ev.progress), -1);
      const prev = recent[hiKey(anilistId, ev)];
      const prevHi = Array.isArray(prev) && now - prev[0] < DUP_TTL_MS ? prev[1] : -1;
      if (top >= 0) recent[hiKey(anilistId, ev)] = [now, Math.max(prevHi, top)];
    }
  }
  for (const [k, v] of Object.entries(recent)) if (now - stamp(v) > DUP_TTL_MS) delete recent[k];
  const keys = Object.keys(recent);
  if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete recent[k];
  return recent;
}

module.exports = { collapse, plan, remember, dupKey, STALE_SECS, GUILD_CAP, DUP_TTL_MS };
