const fs = require('fs');
const path = require('path');

const STORAGE_KEY = 'anitracker:data';
const LOCAL_PATH = path.join(__dirname, 'data', 'storage.json');
const SAVE_DEBOUNCE_MS = 400;
const MAX_FEEDBACK = 500;
const MAX_BOOT_HISTORY = 20;

const hasUpstash = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let redis = null;
if (hasUpstash) {
  // Lazy require so the package is only touched when actually configured —
  // keeps local dev working even before @upstash/redis env vars are set.
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Storage: using Upstash Redis — data persists across restarts and redeploys.');
} else {
  console.log(
    'Storage: using local file storage — this will NOT survive a Render redeploy. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to fix that.'
  );
}

/* ---------------------------------------------------------------------------
 * How storage works now (and why it changed)
 *
 * Before: every command/button/poll did its own `loadData()` (a network round
 * trip to Upstash) and later `saveData()` of its own private copy. Two things
 * happening at once — e.g. a poll that takes 20s while someone clicks
 * Favorite — meant whoever saved LAST silently overwrote the other's changes,
 * and the Upstash round trip before replying ate into Discord's 3-second
 * interaction window (an expired interaction that then threw was one of the
 * crash → restart causes).
 *
 * Now: the whole blob is loaded ONCE at boot and kept in memory. Every
 * `loadData()` returns that same object instantly, so all code mutates one
 * shared copy and nothing can be lost to a stale snapshot. `saveData()`
 * schedules a write-through to Upstash: writes are debounced (bursts of
 * clicks become one write), strictly one at a time (no out-of-order writes),
 * and flushed on shutdown so a Render redeploy never drops the last change.
 *
 * Safety: if Upstash can't be reached at boot, we do NOT pretend the data is
 * empty and then save that empty blob over the real one (the old code could
 * wipe everything that way). We retry, and saves stay disabled until a real
 * load has succeeded.
 * ------------------------------------------------------------------------- */

let cache = null;
let loadedOk = false;
let loadPromise = null;

let saveTimer = null;
let saveInFlight = null;
let dirty = false;

// Ensures every top-level field the dashboard (and the rest of the bot)
// relies on exists, even for data blobs saved before these fields existed.
function ensureTopLevel(data) {
  if (!data || typeof data !== 'object') data = {};
  if (!data.guilds) data.guilds = {};
  if (typeof data.botPaused !== 'boolean') data.botPaused = false;
  // watchStats: legacy counter from the AniList version (no longer written) of how many times each root anime/manga has
  // shown up in a posted activity update (dashboard "Most Watched").
  if (!data.watchStats) data.watchStats = {};
  // globalRecommendations: cross-server "Recommend" tally, one vote per user.
  if (!data.globalRecommendations) data.globalRecommendations = {};
  // linkedAccounts: Discord user id -> { token, simklId, name, avatar, siteUrl, linkedAt }.
  // Filled by /signin (Simkl device code). The token lets the bot read that
  // person's watch history. Tokens are stored as-is; keep the storage private.
  if (!data.linkedAccounts) data.linkedAccounts = {};
  // trackingOptOut: Discord user id -> { since, by }. Set by /tracking off.
  // The poller skips these profiles everywhere until turned back on.
  if (!data.trackingOptOut) data.trackingOptOut = {};
  // userLists: Discord user id -> { watchlist: [], favorites: [] }. One list
  // per person across every server (used to be per-server — see migrate()).
  if (!data.userLists) data.userLists = {};
  // feedback: submissions from the /feedback command, newest first.
  if (!Array.isArray(data.feedback)) data.feedback = [];
  // feedbackStatus: feedback id -> 'resolved' | 'disputed' | 'later'.
  if (!data.feedbackStatus) data.feedbackStatus = {};
  // bootHistory: recent process starts/stops, so restarts can be diagnosed
  // from the dashboard (graceful deploy vs. crash / out-of-memory kill).
  if (!Array.isArray(data.bootHistory)) data.bootHistory = [];
  if (typeof data.lastRelaunchNoticeAt !== 'number') data.lastRelaunchNoticeAt = 0;
  migrate(data);
  return data;
}

// One-time data migrations, guarded by schemaVersion so they never re-run.
function migrate(data) {
  const version = data.schemaVersion || 1;

  if (version < 2) {
    // v2: Watch Later + Favorites move from per-server lists to one list per
    // person. Union every server's list (deduped by mediaId) so nothing is lost.
    for (const guildData of Object.values(data.guilds)) {
      for (const field of ['watchlist', 'favorites']) {
        for (const [userId, list] of Object.entries(guildData[field] || {})) {
          if (!Array.isArray(list)) continue;
          if (!data.userLists[userId]) data.userLists[userId] = { watchlist: [], favorites: [] };
          const target = data.userLists[userId][field];
          for (const entry of list) {
            if (entry && entry.mediaId && !target.some((e) => e.mediaId === entry.mediaId)) target.push(entry);
          }
        }
        delete guildData[field];
      }
    }
    data.schemaVersion = 2;
  }
}

function trimCollections(data) {
  if (data.feedback.length > MAX_FEEDBACK) data.feedback.length = MAX_FEEDBACK;
  if (data.bootHistory.length > MAX_BOOT_HISTORY) data.bootHistory.splice(0, data.bootHistory.length - MAX_BOOT_HISTORY);
}

async function readFromBackend() {
  if (redis) {
    const raw = await redis.get(STORAGE_KEY);
    if (raw === null || raw === undefined) return null; // key genuinely doesn't exist yet
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  if (!fs.existsSync(LOCAL_PATH)) return null;
  return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
}

async function writeToBackend(data) {
  if (redis) {
    await redis.set(STORAGE_KEY, JSON.stringify(data));
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function initialLoad() {
  const delays = [0, 1000, 3000, 7000, 15000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      const raw = await readFromBackend();
      cache = ensureTopLevel(raw || { guilds: {} });
      loadedOk = true;
      if (attempt > 0) console.log(`Storage: loaded on attempt ${attempt + 1}.`);
      return cache;
    } catch (e) {
      console.error(`Storage: load attempt ${attempt + 1} failed:`, e.message);
    }
  }

  // Couldn't reach storage at all. Run with an empty in-memory blob so the
  // bot still answers, but keep saves DISABLED — saving now would overwrite
  // the real data with this empty placeholder. Keep retrying in the background.
  console.error('Storage: could not load data. Running read-only (no saves) until storage is reachable again.');
  cache = ensureTopLevel({ guilds: {} });
  retryInBackground();
  return cache;
}

function retryInBackground() {
  const timer = setInterval(async () => {
    try {
      const raw = await readFromBackend();
      // Merge rather than replace the object, so references other code is
      // holding stay valid.
      const fresh = ensureTopLevel(raw || { guilds: {} });
      for (const key of Object.keys(cache)) delete cache[key];
      Object.assign(cache, fresh);
      loadedOk = true;
      clearInterval(timer);
      console.log('Storage: reconnected and loaded real data. Saves re-enabled.');
    } catch (e) {
      console.error('Storage: background reload still failing:', e.message);
    }
  }, 30000);
  timer.unref?.();
}

async function loadData() {
  if (cache) return cache;
  if (!loadPromise) loadPromise = initialLoad();
  return loadPromise;
}

async function runSave() {
  if (!loadedOk || !cache) return true;
  dirty = false;
  trimCollections(cache);
  try {
    await writeToBackend(cache);
    return true;
  } catch (e) {
    console.error('Storage: save failed, retrying in 10s:', e.message);
    dirty = true;
    setTimeout(() => {
      if (dirty && !saveTimer) pumpSaves();
    }, 10000).unref?.();
    return false;
  }
}

function pumpSaves() {
  if (saveInFlight) return saveInFlight;
  saveInFlight = (async () => {
    try {
      let ok = true;
      do {
        ok = await runSave();
      } while (ok && dirty && loadedOk && !saveTimer);
    } finally {
      saveInFlight = null;
    }
  })();
  return saveInFlight;
}

// Schedules a write of the shared in-memory data. The `data` argument is
// accepted for backwards compatibility (every caller passes the object it
// got from loadData(), which is the same shared object).
let waiters = [];

function saveData(data) {
  if (data && cache && data !== cache) Object.assign(cache, data);
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  const done = new Promise((resolve) => waiters.push(resolve));
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const batch = waiters;
    waiters = [];
    if (saveInFlight) await saveInFlight; // let the current write finish, then write the newest state
    await pumpSaves();
    batch.forEach((r) => r());
  }, SAVE_DEBOUNCE_MS);
  return done;
}

// Writes anything pending right now — called on shutdown.
async function flushData() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const batch = waiters;
  waiters = [];
  if (saveInFlight) await saveInFlight;
  if (dirty) await runSave();
  batch.forEach((r) => r());
}

function isStorageHealthy() {
  return loadedOk;
}

module.exports = { loadData, saveData, flushData, isStorageHealthy, backend: redis ? 'upstash' : 'local-file' };
