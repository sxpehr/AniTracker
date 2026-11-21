/* ---------------------------------------------------------------------------
 * Specific "what is this show actually like" labels.
 *
 * AniList genres are broad (Comedy, Adventure, Action…). Its TAGS are the
 * specific ones people actually recognise — Isekai, Satire, Time Loop,
 * Iyashikei, Found Family — each with a relevance rank (0-100) voted by users.
 * We pick the most relevant tags, skip spoilers and the bland "cast" /
 * "technical" ones, and only fall back to genres when a show has few tags.
 * ------------------------------------------------------------------------- */

// Categories that say little about what a show is like.
const SKIP_CATEGORIES = [/^Cast-Main Cast/i, /^Technical/i, /^Demographic/i, /^Sexual Content/i];
// Individually bland tags (they show up on half of all anime).
const SKIP_NAMES = new Set([
  'Male Protagonist',
  'Female Protagonist',
  'Ensemble Cast',
  'Primarily Adult Cast',
  'Primarily Teen Cast',
  'Primarily Child Cast',
  'Primarily Female Cast',
  'Primarily Male Cast',
  'Episodic',
  'Full CGI',
  'CGI',
  'Anthology',
  'Japan',
  'Urban',
  'Rural',
  'Heterosexual',
  'Love Triangle',
  'Nudity',
  'Ecchi',
]);

// Ecchi/fan-service signals, used only by the opt-in "freaky" leaderboard.
const FREAKY_GENRES = new Set(['Ecchi', 'Hentai']);
const FREAKY_TAGS = new Set(['Nudity', 'Fan Service', 'Large Breasts', 'Harem', 'Reverse Harem', 'Boobs in Your Face', 'Exhibitionism', 'Ero Guro', 'Bondage']);

function usable(t, minRank) {
  if (!t || !t.name) return false;
  if (t.isMediaSpoiler || t.isGeneralSpoiler || t.isAdult) return false;
  if ((t.rank || 0) < minRank) return false;
  if (SKIP_NAMES.has(t.name)) return false;
  if (SKIP_CATEGORIES.some((re) => re.test(t.category || ''))) return false;
  return true;
}

// Up to `n` labels for a show: best tags first, genres only to fill gaps.
function pickTags(tags, genres = [], n = 3, { minRank = 55 } = {}) {
  const picked = (tags || [])
    .filter((t) => usable(t, minRank))
    .sort((a, b) => (b.rank || 0) - (a.rank || 0))
    .map((t) => t.name);
  const out = [];
  for (const name of picked) if (!out.includes(name) && out.length < n) out.push(name);
  for (const g of genres || []) if (out.length < n && !out.includes(g) && g !== 'Hentai') out.push(g);
  return out;
}

// What stats remember per show: the top few tags (strongest signals only).
function statTags(tags, genres) {
  return pickTags(tags, genres, 4, { minRank: 60 });
}

// How "freaky" a show is (0, 1): ecchi genre or strong fan-service tags.
function isFreaky(tags, genres) {
  if ((genres || []).some((g) => FREAKY_GENRES.has(g))) return true;
  return (tags || []).some((t) => FREAKY_TAGS.has(t.name) && (t.rank || 0) >= 60);
}

module.exports = { pickTags, statTags, isFreaky, FREAKY_GENRES };
