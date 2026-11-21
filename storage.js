const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 400;
const MAX_FEEDBACK = 500;
const MAX_BOOT_HISTORY = 20;

const hasUpstash = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let redis = null;
if (hasUpstash) {
  // Lazy require so the package is only touched when actually configured.
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
 * How storage works
 *
 * Data lives in a few named DOCUMENTS, each its own Redis key:
 *   core   (anitracker:data)   — servers, tracked users, posts, feedback… (unchanged key)
 *   social (anitracker:social) — profiles, themes, collections, reviews, settings
 *   stats  (anitracker:stats)  — per-AniList-user watch history for stats/streaks
 *
 * Splitting keeps each write small (a stats update doesn't re-upload every
 * review) and keeps any single key well under Upstash's request-size limit.
 *
 * Each document is loaded ONCE at boot and kept in memory. load() returns the
 * same shared object instantly, so all code mutates one copy and nothing is
 * lost to a stale snapshot. save() schedules a debounced, strictly sequential
 * write-through, and everything is flushed on shutdown.
 *
 * Safety: if a document can't be loaded at boot we never save an empty
 * placeholder over the real data — saves for that document stay disabled
 * until a real load succeeds (retried in the background).
 * ------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Document {
  constructor({ name, key, localFile, ensure, beforeSave }) {
    this.name = name;
    this.key = key;
    this.localPath = path.join(__dirname, 'data', localFile);
    this.ensure = ensure;
    this.beforeSave = beforeSave || (() => {});
    this.cache = null;
    this.loadedOk = false;
    this.loadPromise = null;
    this.saveTimer = null;
    this.saveInFlight = null;
    this.dirty = false;
    this.waiters = [];
  }

  async read() {
    if (redis) {
      const raw = await redis.get(this.key);
      if (raw === null || raw === undefined) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    if (!fs.existsSync(this.localPath)) return null;
    return JSON.parse(fs.readFileSync(this.localPath, 'utf8'));
  }

  async write(data) {
    if (redis) {
      await redis.set(this.key, JSON.stringify(data));
      return;
    }
    fs.mkdirSync(path.dirname(this.localPath), { recursive: true });
    fs.writeFileSync(this.localPath, JSON.stringify(data, null, 2));
  }

  async initialLoad() {
    const delays = [0, 1000, 3000, 7000, 15000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await sleep(delays[attempt]);
      try {
        const raw = await this.read();
        this.cache = this.ensure(raw || {});
        this.loadedOk = true;
        if (attempt > 0) console.log(`Storage[${this.name}]: loaded on attempt ${attempt + 1}.`);
        return this.cache;
      } catch (e) {
        console.error(`Storage[${this.name}]: load attempt ${attempt + 1} failed:`, e.message);
      }
    }
    console.error(`Storage[${this.name}]: could not load. Running read-only (no saves) until storage is reachable again.`);
    this.cache = this.ensure({});
    this.retryInBackground();
    return this.cache;
  }

  retryInBackground() {
    const timer = setInterval(async () => {
      try {
        const fresh = this.ensure((await this.read()) || {});
        for (const k of Object.keys(this.cache)) delete this.cache[k];
        Object.assign(this.cache, fresh);
        this.loadedOk = true;
        clearInterval(timer);
        console.log(`Storage[${this.name}]: reconnected and loaded real data. Saves re-enabled.`);
      } catch (e) {
        console.error(`Storage[${this.name}]: background reload still failing:`, e.message);
      }
    }, 30000);
    timer.unref?.();
  }

  async load() {
    if (this.cache) return this.cache;
    if (!this.loadPromise) this.loadPromise = this.initialLoad();
    return this.loadPromise;
  }

  async runSave() {
    if (!this.loadedOk || !this.cache) return true;
    this.dirty = false;
    this.beforeSave(this.cache);
    try {
      await this.write(this.cache);
      return true;
    } catch (e) {
      console.error(`Storage[${this.name}]: save failed, retrying in 10s:`, e.message);
      this.dirty = true;
      setTimeout(() => {
        if (this.dirty && !this.saveTimer) this.pump();
      }, 10000).unref?.();
      return false;
    }
  }

  pump() {
    if (this.saveInFlight) return this.saveInFlight;
    this.saveInFlight = (async () => {
      try {
        let ok = true;
        do {
          ok = await this.runSave();
        } while (ok && this.dirty && this.loadedOk && !this.saveTimer);
      } finally {
        this.saveInFlight = null;
      }
    })();
    return this.saveInFlight;
  }

  // `data` is accepted for backwards compatibility (callers pass the object
  // they got from load(), which is the same shared object).
  save(data) {
    if (data && this.cache && data !== this.cache) Object.assign(this.cache, data);
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const done = new Promise((resolve) => this.waiters.push(resolve));
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      const batch = this.waiters;
      this.waiters = [];
      if (this.saveInFlight) await this.saveInFlight;
      await this.pump();
      batch.forEach((r) => r());
    }, SAVE_DEBOUNCE_MS);
    return done;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const batch = this.waiters;
    this.waiters = [];
    if (this.saveInFlight) await this.saveInFlight;
    if (this.dirty) await this.runSave();
    batch.forEach((r) => r());
  }
}

/* ----------------------------- core document ----------------------------- */

function ensureCore(data) {
  if (!data || typeof data !== 'object') data = {};
  if (!data.guilds) data.guilds = {};
  if (typeof data.botPaused !== 'boolean') data.botPaused = false;
  if (!data.watchStats) data.watchStats = {}; // dashboard "Most Watched"
  if (!data.globalRecommendations) data.globalRecommendations = {}; // one vote per user per title
  if (!data.linkedAccounts) data.linkedAccounts = {}; // Discord id -> AniList account (/signin)
  if (!data.trackingOptOut) data.trackingOptOut = {}; // AniList id -> { since, by } (/tracking off)
  if (!Array.isArray(data.feedback)) data.feedback = [];
  if (!data.feedbackStatus) data.feedbackStatus = {};
  if (!Array.isArray(data.bootHistory)) data.bootHistory = [];
  if (typeof data.lastRelaunchNoticeAt !== 'number') data.lastRelaunchNoticeAt = 0;
  if (!data.feedState) data.feedState = {}; // AniList id -> merged/list-update detection memory (features/feed.js)
  migrateCore(data);
  return data;
}

function migrateCore(data) {
  const version = data.schemaVersion || 1;
  if (version < 2) {
    // v2: Watch Later + Favorites became one list per person (union across servers).
    if (!data.userLists) data.userLists = {};
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
  // v3 (moving userLists into the social document) runs in migrateListsToSocial(),
  // because it needs both documents loaded.
}

function trimCore(data) {
  if (data.feedback.length > MAX_FEEDBACK) data.feedback.length = MAX_FEEDBACK;
  if (data.bootHistory.length > MAX_BOOT_HISTORY) data.bootHistory.splice(0, data.bootHistory.length - MAX_BOOT_HISTORY);
}

/* ---------------------------- social document ---------------------------- */

function ensureSocial(data) {
  if (!data || typeof data !== 'object') data = {};
  if (!data.users) data.users = {}; // Discord id -> profile, settings, collections…
  if (!data.reviews) data.reviews = {}; // review id -> review
  if (!data.guildConfig) data.guildConfig = {}; // guild id -> server settings (see features/serverSettings.js)
  if (!data.ratings) data.ratings = {}; // Discord id -> { mediaId: { s, at, t, c, u } } quick 1-10 ratings
  if (!data.schemaVersion) data.schemaVersion = 1;
  return data;
}

/* ----------------------------- stats document ---------------------------- */

const MAX_DAY_HISTORY = 400;
function ensureStats(data) {
  if (!data || typeof data !== 'object') data = {};
  if (!data.users) data.users = {}; // AniList id -> history
  if (!data.media) data.media = {}; // media id -> { t: title, c: cover, g: genres }
  if (!data.schemaVersion) data.schemaVersion = 1;
  return data;
}

function trimStats(data) {
  // Keep ~13 months of daily history per user; monthly totals are kept forever.
  for (const u of Object.values(data.users)) {
    const days = Object.keys(u.days || {});
    if (days.length > MAX_DAY_HISTORY) {
      days.sort();
      for (const d of days.slice(0, days.length - MAX_DAY_HISTORY)) delete u.days[d];
    }
    // Per-show breakdowns are only needed for recent weekly recaps.
    const cutoff = new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10);
    for (const [d, v] of Object.entries(u.days || {})) {
      if (d < cutoff && Array.isArray(v) && v.length > 3) u.days[d] = v.slice(0, 3);
    }
  }
}

const core = new Document({ name: 'core', key: 'anitracker:data', localFile: 'storage.json', ensure: ensureCore, beforeSave: trimCore });
const social = new Document({ name: 'social', key: 'anitracker:social', localFile: 'social.json', ensure: ensureSocial });
const stats = new Document({ name: 'stats', key: 'anitracker:stats', localFile: 'stats.json', ensure: ensureStats, beforeSave: trimStats });

// One-time move of the per-person Watch Later / Favorites lists from core
// into the social document, where all collections now live.
async function migrateListsToSocial() {
  const c = await core.load();
  const s = await social.load();
  if (!c.userLists || !core.loadedOk || !social.loadedOk) return false;
  for (const [userId, lists] of Object.entries(c.userLists)) {
    if (!s.users[userId]) s.users[userId] = {};
    const u = s.users[userId];
    for (const field of ['watchlist', 'favorites']) {
      if (!Array.isArray(u[field])) u[field] = [];
      for (const e of lists[field] || []) {
        if (e?.mediaId && !u[field].some((x) => x.mediaId === e.mediaId)) u[field].push(e);
      }
    }
  }
  delete c.userLists;
  c.schemaVersion = 3;
  await Promise.all([social.save(), core.save()]);
  console.log('Storage: moved Watch Later / Favorites lists into the social document.');
  return true;
}

module.exports = {
  // core (unchanged API)
  loadData: () => core.load(),
  saveData: (d) => core.save(d),
  isStorageHealthy: () => core.loadedOk && social.loadedOk && stats.loadedOk,
  backend: redis ? 'upstash' : 'local-file',
  // social + stats
  loadSocial: () => social.load(),
  saveSocial: (d) => social.save(d),
  loadStats: () => stats.load(),
  saveStats: (d) => stats.save(d),
  migrateListsToSocial,
  flushData: async () => {
    await Promise.all([core.flush(), social.flush(), stats.flush()]);
  },
};
