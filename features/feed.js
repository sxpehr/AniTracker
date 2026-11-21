/* ---------------------------------------------------------------------------
 * Catching AniList updates that never arrive as a NEW activity.
 *
 * The poller used to post only activities with an id newer than the last one
 * it saw. Two common AniList behaviours slip past that:
 *
 *  1. Activity merging. AniList folds quick follow-up updates into the SAME
 *     activity ("watched episode 3" becomes "watched episodes 3 - 5", same id).
 *     With "Activity merge time" set long in AniList settings, nearly every
 *     update after the first is a merge — so nothing new ever posted.
 *  2. List activity turned off. AniList lets people disable activity creation
 *     per status (Settings → Lists). The list still updates, but no activity
 *     exists to post.
 *
 * For each AniList account we keep a small memory (core doc → feedState):
 *   sigs   { activityId: "status|progress" }   for the latest ~25 activities
 *   list   { mediaId: "STATUS|progress" }      for the latest ~12 list entries
 *   lastId newest activity id seen, listAt newest list update time seen
 * and turn differences into extra "events" shaped exactly like activities.
 * The first poll for an account only fills the memory (no backlog dump).
 * ------------------------------------------------------------------------- */

const MAX_SIGS = 40;
const MAX_LIST = 30;

const sigOf = (a) => `${a.status || ''}|${a.progress || ''}`;
const entrySig = (e) => `${e.status || ''}|${e.progress || 0}`;

function rangeOf(progress) {
  const nums = String(progress || '')
    .split('-')
    .map((x) => parseInt(x.trim(), 10))
    .filter(Number.isFinite);
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}

function rangeText(from, to) {
  return from >= to ? String(to) : `${from} - ${to}`;
}

// "watched episodes 3 - 4" grew to "3 - 6": the NEW part is 5 - 6.
function mergedEvent(activity, prevSig, nowSec) {
  const [prevStatus, prevProgress] = prevSig.split('|');
  const statusChanged = (prevStatus || '') !== (activity.status || '');
  let progress = activity.progress;
  const prev = rangeOf(prevProgress);
  const cur = rangeOf(activity.progress);
  if (!statusChanged && prev && cur) {
    if (cur[1] <= prev[1]) return null; // nothing new (or went backwards)
    progress = rangeText(prev[1] + 1, cur[1]);
  }
  return { ...activity, progress, merged: true, createdAt: Math.max(activity.createdAt || 0, nowSec) };
}

// A list entry changed with no activity for it: describe it like AniList would.
function entryEvent(entry, prevSig) {
  const media = entry.media;
  if (!media) return null;
  const manga = media.type === 'MANGA';
  const [prevStatus, prevP] = (prevSig || '').split('|');
  const prevProgress = parseInt(prevP, 10) || 0;
  const p = entry.progress || 0;
  let status;
  let progress = null;
  switch (entry.status) {
    case 'CURRENT':
    case 'REPEATING': {
      if (!p) return null; // just added to "watching", nothing watched yet
      const sameRun = prevStatus === entry.status;
      if (sameRun && p <= prevProgress) return null;
      const from = sameRun && prevProgress ? prevProgress + 1 : p;
      progress = rangeText(from, p);
      if (entry.status === 'REPEATING') status = manga ? 'reread chapter' : 'rewatched episode';
      else status = manga ? 'read chapter' : 'watched episode';
      break;
    }
    case 'COMPLETED':
      status = 'completed';
      break;
    case 'PLANNING':
      status = manga ? 'plans to read' : 'plans to watch';
      break;
    case 'DROPPED':
      status = 'dropped';
      progress = p ? String(p) : null;
      break;
    case 'PAUSED':
      status = manga ? 'paused reading' : 'paused watching';
      progress = p ? String(p) : null;
      break;
    default:
      return null;
  }
  return { __typename: 'ListActivity', id: 0, synthetic: true, status, progress, createdAt: entry.updatedAt || Math.floor(Date.now() / 1000), media };
}

/**
 * @param state       feedState entry for this account (mutated)
 * @param activities  latest activities (newest first)
 * @param entries     latest list entries, or null when unavailable
 * @returns { merged: [...], synthetic: [...] } extra events, oldest first
 */
function expand(state, activities, entries) {
  const nowSec = Math.floor(Date.now() / 1000);
  const initialized = Boolean(state.init);
  const merged = [];
  const synthetic = [];
  const touched = new Set(); // media with a real (new or merged) activity this poll

  const sigs = state.sigs || {};
  const nextSigs = {};
  let maxId = state.lastId || 0;
  for (const a of activities || []) {
    if (a.__typename !== 'ListActivity' || !a.media) continue;
    const sig = sigOf(a);
    nextSigs[a.id] = sig;
    if (a.id > (state.lastId || 0)) {
      touched.add(a.media.id);
    } else if (initialized && sigs[a.id] && sigs[a.id] !== sig) {
      const ev = mergedEvent(a, sigs[a.id], nowSec);
      if (ev) merged.push(ev);
      touched.add(a.media.id);
    }
    maxId = Math.max(maxId, a.id);
  }
  // Keep only the newest MAX_SIGS signatures.
  state.sigs = Object.fromEntries(
    Object.entries(nextSigs)
      .sort((x, y) => Number(y[0]) - Number(x[0]))
      .slice(0, MAX_SIGS)
  );
  state.lastId = maxId;

  if (Array.isArray(entries)) {
    const list = state.list || {};
    const listInitialized = initialized && typeof state.listAt === 'number';
    let listAt = state.listAt || 0;
    for (const e of entries) {
      if (!e.media) continue;
      const key = String(e.media.id);
      const sig = entrySig(e);
      if (listInitialized && (e.updatedAt || 0) > (state.listAt || 0) && list[key] !== sig && !touched.has(e.media.id)) {
        const ev = entryEvent(e, list[key]);
        if (ev) synthetic.push(ev);
      }
      list[key] = sig;
      listAt = Math.max(listAt, e.updatedAt || 0);
    }
    const keys = Object.keys(list);
    if (keys.length > MAX_LIST) {
      const keep = new Set(entries.map((e) => String(e.media?.id)));
      for (const k of keys) if (Object.keys(list).length > MAX_LIST && !keep.has(k)) delete list[k];
    }
    state.list = list;
    state.listAt = listAt;
  }
  state.init = true;
  const byTime = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  return { merged: merged.sort(byTime), synthetic: synthetic.sort(byTime) };
}

function stateFor(core, anilistId) {
  core.feedState ||= {};
  return (core.feedState[String(anilistId)] ||= {});
}

module.exports = { expand, stateFor, rangeOf, _internals: { mergedEvent, entryEvent, sigOf, entrySig } };
