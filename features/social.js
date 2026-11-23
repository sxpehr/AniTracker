const crypto = require('crypto');

/* ---------------------------------------------------------------------------
 * Per-person data: profile look, what to showcase, activity-post style,
 * privacy, and every collection. Stored in the "social" storage document.
 *
 * Every field has a default that reproduces the bot's original look, so
 * someone who never opens /settings sees exactly what they always did.
 * ------------------------------------------------------------------------- */

const SECTIONS = {
  bio: { label: 'About me', emoji: '📝', description: 'Your bio' },
  stats: { label: 'Stats strip', emoji: '📊', description: 'Streak, episodes, completed, hours' },
  featured: { label: 'Featured anime', emoji: '🎞️', description: 'One anime front and centre' },
  favorites: { label: 'Favorites shelf', emoji: '⭐', description: 'Cover gallery of your favorites' },
  rotation: { label: 'In Rotation', emoji: '🔄', description: "What you're watching, with progress" },
  opening: { label: 'Favorite openings', emoji: '🎵', description: 'Up to 3 anime OPs' },
  ending: { label: 'Favorite endings', emoji: '🎶', description: 'Up to 3 anime EDs' },
  review: { label: 'Latest review', emoji: '✍️', description: 'Your newest (or featured) review' },
  recommendations: { label: 'Recommendations', emoji: '💜', description: 'What you recommend' },
  collections: { label: 'Collections', emoji: '🗂️', description: 'Your custom lists' },
};
const DEFAULT_SECTIONS = ['bio', 'stats', 'featured', 'favorites', 'rotation', 'opening', 'ending', 'review'];

// Layouts decide the ORDER; the showcase picks decide WHICH sections appear.
const LAYOUTS = {
  classic: { label: 'Classic', emoji: '🪪', description: 'About me first, then your anime', order: ['bio', 'stats', 'featured', 'favorites', 'rotation', 'opening', 'ending', 'review', 'recommendations', 'collections'] },
  showcase: { label: 'Showcase', emoji: '🖼️', description: 'Lead with your featured anime + favorites', order: ['featured', 'favorites', 'opening', 'ending', 'bio', 'rotation', 'review', 'stats', 'recommendations', 'collections'] },
  stats: { label: 'Stats first', emoji: '📈', description: 'Numbers up top for the grinders', order: ['stats', 'rotation', 'bio', 'featured', 'favorites', 'review', 'opening', 'ending', 'recommendations', 'collections'] },
  minimal: { label: 'Minimal', emoji: '🤍', description: 'Just the essentials, lots of breathing room', order: ['bio', 'featured', 'favorites', 'opening', 'ending', 'stats', 'rotation', 'review', 'recommendations', 'collections'] },
};

const ACTIVITY_FIELDS = {
  description: { label: 'Synopsis', emoji: '📄' },
  genres: { label: 'Tags (Isekai, Satire…)', emoji: '🏷️' },
  rating: { label: 'Score', emoji: '⭐' },
  popularity: { label: 'Popularity rank', emoji: '❤️' },
  cover: { label: 'Cover image', emoji: '🖼️' },
  streak: { label: 'Streak counter', emoji: '🔥' },
  progress: { label: 'Season progress bar', emoji: '📶' },
  status: { label: 'My profile status', emoji: '💬' },
};
const DEFAULT_ACTIVITY_FIELDS = Object.keys(ACTIVITY_FIELDS);

const PRIVACY_PARTS = {
  stats: { label: 'Stats & streaks', emoji: '📊' },
  collections: { label: 'Collections', emoji: '🗂️' },
  watchlist: { label: 'Watch Later', emoji: '📌' },
  activity: { label: 'Recent activity', emoji: '📡' },
  reviews: { label: 'Reviews', emoji: '✍️' },
  recommendations: { label: 'Recommendations', emoji: '💜' },
};

const TIMEZONES = [
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/Toronto', 'Eastern (Toronto / New York)'],
  ['America/Sao_Paulo', 'Brasília (São Paulo)'],
  ['Europe/London', 'UK (London)'],
  ['Europe/Berlin', 'Central Europe (Berlin / Paris)'],
  ['Europe/Moscow', 'Moscow'],
  ['Asia/Dubai', 'Gulf (Dubai)'],
  ['Asia/Tehran', 'Iran (Tehran)'],
  ['Asia/Kolkata', 'India (Kolkata)'],
  ['Asia/Manila', 'Philippines (Manila)'],
  ['Asia/Tokyo', 'Japan (Tokyo)'],
  ['Australia/Sydney', 'Australia East (Sydney)'],
  ['UTC', 'UTC'],
];
const DEFAULT_TZ = 'America/Toronto';

// Special profile tags, by Discord user id.
const BADGES = {
  '557814169903300639': [{ key: 'creator', label: '✦ CREATOR' }],
};
function badgesFor(userId) {
  return BADGES[userId] || [];
}

const LIMITS = { favorites: 50, watchlist: 200, recommendations: 100, collections: 15, collectionItems: 100, bio: 400, tagline: 80, note: 140 };

function defaults() {
  return {
    profile: {
      theme: 'anilist',
      accent: null,
      accent2: null,
      background: null,
      bannerMode: 'theme',
      bannerUrl: null,
      displayName: null,
      tagline: null,
      bio: null,
      featured: null,
      opening: null, // first of `openings` (kept for older code)
      openings: [],
      endings: [],
      favBorder: 'anime', // favorites card border: 'anime' (each show's colour) · 'theme'
      layout: 'classic',
      sections: [...DEFAULT_SECTIONS],
      featuredReviewId: null,
      customizedAt: null,
    },
    activity: { style: 'full', color: 'cover', show: [...DEFAULT_ACTIVITY_FIELDS] },
    privacy: { profile: 'public', hide: [] },
    prefs: { timezone: DEFAULT_TZ, recapDm: false, spoilerDefault: false, lastRecapSent: null },
    favorites: [],
    watchlist: [],
    recommendations: [],
    collections: [],
    rotation: { pinned: [], extra: [], hidden: [] },
    guilds: [],
    createdAt: null,
  };
}

// Fills in any missing fields without touching existing ones.
function fill(target, defs) {
  for (const [k, v] of Object.entries(defs)) {
    if (target[k] === undefined || target[k] === null) {
      if (v !== null && typeof v === 'object') target[k] = Array.isArray(v) ? [...v] : fill({}, v);
      else if (target[k] === undefined) target[k] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      fill(target[k], v);
    }
  }
  return target;
}

function getUser(social, userId) {
  if (!social.users[userId]) social.users[userId] = { createdAt: new Date().toISOString() };
  return fill(social.users[userId], defaults());
}

// Read-only view for someone who may never have used the bot (no write).
function peekUser(social, userId) {
  return social.users[userId] ? getUser(social, userId) : fill({}, defaults());
}

function isCustomized(u) {
  return Boolean(u?.profile?.customizedAt);
}

function markGuild(u, guildId) {
  if (!guildId) return;
  if (!u.guilds.includes(guildId)) {
    u.guilds.push(guildId);
    if (u.guilds.length > 50) u.guilds.shift();
  }
}

// Which AniList account represents this Discord user: the one they signed in
// with, otherwise a profile they personally started tracking.
function anilistFor(core, userId) {
  const linked = core.linkedAccounts?.[userId];
  if (linked) return { id: linked.anilistId, name: linked.anilistName, siteUrl: linked.siteUrl, avatar: linked.avatar, linked: true };
  for (const g of Object.values(core.guilds || {})) {
    const u = (g.users || []).find((x) => x.addedBy === userId);
    if (u) return { id: u.id, name: u.username, siteUrl: `https://anilist.co/user/${encodeURIComponent(u.username)}`, avatar: u.avatar, linked: false };
  }
  return null;
}

// Reverse: which Discord user owns an AniList account.
function discordFor(core, anilistId) {
  for (const [discordId, acct] of Object.entries(core.linkedAccounts || {})) if (acct.anilistId === anilistId) return discordId;
  for (const g of Object.values(core.guilds || {})) {
    const u = (g.users || []).find((x) => x.id === anilistId && x.addedBy);
    if (u) return u.addedBy;
  }
  return null;
}

function canView(u, viewerId, ownerId, part) {
  if (viewerId === ownerId) return true;
  if (u.privacy.profile === 'private') return false;
  return !part || !u.privacy.hide.includes(part);
}

/* ------------------------------ collections ------------------------------ */

function newId(prefix) {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

// Resolves a collection key to { list, meta } for a user.
//   'favorites' | 'watchlist' | 'recommendations' | <custom id>
function getList(u, key) {
  if (key === 'favorites' || key === 'watchlist' || key === 'recommendations') return { list: u[key], meta: BUILTIN[key], builtin: true };
  const c = u.collections.find((x) => x.id === key);
  return c ? { list: c.items, meta: c, builtin: false } : null;
}

const BUILTIN = {
  favorites: { name: 'Favorites', emoji: '⭐', description: 'All-time favorites, in your order' },
  watchlist: { name: 'Watch Later', emoji: '📌', description: 'Your backlog' },
  recommendations: { name: 'Recommendations', emoji: '💜', description: 'Anime you recommend to everyone' },
};

function listLimit(key) {
  return LIMITS[key] || LIMITS.collectionItems;
}

function addItem(list, snap, key, extra = {}) {
  if (list.some((e) => e.mediaId === snap.mediaId)) return { ok: false, reason: 'exists' };
  if (list.length >= listLimit(key)) return { ok: false, reason: 'full' };
  list.push({ ...snap, ...extra, addedAt: new Date().toISOString() });
  return { ok: true };
}

function removeItem(list, mediaId) {
  const i = list.findIndex((e) => e.mediaId === mediaId);
  if (i === -1) return null;
  return list.splice(i, 1)[0];
}

function moveItem(list, mediaId, where) {
  const i = list.findIndex((e) => e.mediaId === mediaId);
  if (i === -1) return false;
  const [item] = list.splice(i, 1);
  let j = i;
  if (where === 'up') j = Math.max(0, i - 1);
  else if (where === 'down') j = Math.min(list.length, i + 1);
  else if (where === 'top') j = 0;
  else if (where === 'bottom') j = list.length;
  list.splice(j, 0, item);
  return true;
}

/* -------------------------------- reviews -------------------------------- */

function reviewsBy(social, userId) {
  return Object.values(social.reviews)
    .filter((r) => r.authorId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function reviewFor(social, userId, mediaId) {
  return Object.values(social.reviews).find((r) => r.authorId === userId && r.mediaId === mediaId) || null;
}

// Favorite openings / endings (older profiles stored a single `opening`).
const MAX_SONGS = 3;
function songsOf(profile, kind) {
  if (kind === 'ED') return Array.isArray(profile?.endings) ? profile.endings : [];
  if (Array.isArray(profile?.openings) && profile.openings.length) return profile.openings;
  return profile?.opening ? [profile.opening] : [];
}
function setSongs(profile, kind, list) {
  const clean = list.filter(Boolean).slice(0, MAX_SONGS);
  if (kind === 'ED') profile.endings = clean;
  else {
    profile.openings = clean;
    profile.opening = clean[0] || null;
  }
}

module.exports = {
  songsOf,
  setSongs,
  MAX_SONGS,
  BADGES,
  badgesFor,
  SECTIONS,
  DEFAULT_SECTIONS,
  LAYOUTS,
  ACTIVITY_FIELDS,
  DEFAULT_ACTIVITY_FIELDS,
  PRIVACY_PARTS,
  TIMEZONES,
  DEFAULT_TZ,
  LIMITS,
  BUILTIN,
  defaults,
  getUser,
  peekUser,
  isCustomized,
  markGuild,
  anilistFor,
  discordFor,
  canView,
  newId,
  getList,
  addItem,
  removeItem,
  moveItem,
  reviewsBy,
  reviewFor,
};
