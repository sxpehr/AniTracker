const { anilistQuery } = require('../anilist');

// AniList + AnimeThemes lookups used by profiles, collections, reviews and
// stats. Everything is cached briefly so browsing a profile doesn't hammer
// AniList (rate limit: ~90 requests/min, sometimes lowered to 30).

const caches = new Map(); // name -> Map(key -> { at, value })
function cached(name, ttlMs, max = 300) {
  if (!caches.has(name)) caches.set(name, new Map());
  const map = caches.get(name);
  return async (key, loader) => {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await loader();
    map.set(key, { at: Date.now(), value });
    if (map.size > max) map.delete(map.keys().next().value);
    return value;
  };
}

const MEDIA_FIELDS = `
  id
  type
  format
  status
  episodes
  duration
  season
  seasonYear
  averageScore
  genres
  isAdult
  title { romaji english native }
  siteUrl
  coverImage { extraLarge large medium color }
  bannerImage
`;

function titleOf(m) {
  return m?.title?.english || m?.title?.romaji || 'Unknown title';
}

// Compact snapshot stored inside collections/reviews so lists render without
// a lookup per item. AniList stays the source of truth (refreshed when shown
// in detail).
function snapshot(m) {
  return {
    mediaId: m.id,
    title: titleOf(m),
    cover: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
    banner: m.bannerImage || null,
    siteUrl: m.siteUrl || `https://anilist.co/anime/${m.id}`,
    color: m.coverImage?.color || null,
    year: m.seasonYear || null,
    format: m.format || null,
    episodes: m.episodes || null,
  };
}

const searchCache = cached('search', 10 * 60 * 1000, 500);
async function searchAnime(query, perPage = 10) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  return searchCache(`${q.toLowerCase()}|${perPage}`, async () => {
    const data = await anilistQuery(
      `query ($q: String, $n: Int) {
        Page(perPage: $n) {
          media(search: $q, type: ANIME, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_FIELDS} }
        }
      }`,
      { q, n: perPage }
    );
    return data.data.Page?.media || [];
  });
}

const mediaCache = cached('mediaLite', 30 * 60 * 1000, 600);
async function getMediaLite(id) {
  return mediaCache(Number(id), async () => {
    const data = await anilistQuery(`query ($id: Int) { Media(id: $id) { ${MEDIA_FIELDS} } }`, { id: Number(id) });
    return data.data.Media || null;
  });
}

// Lifetime statistics + what they're currently watching, in ONE request.
const snapshotCache = cached('profileSnapshot', 5 * 60 * 1000, 300);
async function getProfileSnapshot(anilistId) {
  return snapshotCache(Number(anilistId), async () => {
    const data = await anilistQuery(
      `query ($id: Int) {
        User(id: $id) {
          id
          name
          siteUrl
          avatar { large medium }
          bannerImage
          statistics {
            anime {
              count
              meanScore
              minutesWatched
              episodesWatched
              statuses { status count }
              genres(limit: 6, sort: COUNT_DESC) { genre count minutesWatched }
            }
          }
        }
        current: Page(perPage: 15) {
          mediaList(userId: $id, type: ANIME, status_in: [CURRENT, REPEATING], sort: UPDATED_TIME_DESC) {
            progress
            updatedAt
            media { ${MEDIA_FIELDS} nextAiringEpisode { episode airingAt } }
          }
        }
        top: Page(perPage: 1) {
          mediaList(userId: $id, type: ANIME, sort: SCORE_DESC) {
            score(format: POINT_10_DECIMAL)
            media { ${MEDIA_FIELDS} }
          }
        }
      }`,
      { id: Number(anilistId) }
    );
    const user = data.data.User;
    if (!user) return null;
    const a = user.statistics?.anime || {};
    const statuses = Object.fromEntries((a.statuses || []).map((s) => [s.status, s.count]));
    const top = data.data.top?.mediaList?.[0];
    return {
      user,
      lifetime: {
        entries: a.count || 0,
        meanScore: a.meanScore || 0,
        minutes: a.minutesWatched || 0,
        episodes: a.episodesWatched || 0,
        completed: statuses.COMPLETED || 0,
        watching: (statuses.CURRENT || 0) + (statuses.REPEATING || 0),
        planning: statuses.PLANNING || 0,
        dropped: statuses.DROPPED || 0,
        paused: statuses.PAUSED || 0,
        genres: (a.genres || []).map((g) => ({ genre: g.genre, count: g.count, minutes: g.minutesWatched })),
        topRated: top && top.score ? { score: top.score, media: top.media } : null,
      },
      current: (data.data.current?.mediaList || []).filter((e) => e.media),
    };
  });
}

// Anime completed between two dates (FuzzyDateInt = YYYYMMDD), with scores.
const completedCache = cached('completed', 10 * 60 * 1000, 300);
async function getCompletedBetween(anilistId, fromInt, toInt) {
  return completedCache(`${anilistId}|${fromInt}|${toInt}`, async () => {
    const data = await anilistQuery(
      `query ($id: Int, $from: FuzzyDateInt, $to: FuzzyDateInt) {
        Page(perPage: 50) {
          mediaList(userId: $id, type: ANIME, status_in: [COMPLETED, REPEATING], completedAt_greater: $from, completedAt_lesser: $to, sort: SCORE_DESC) {
            score(format: POINT_10_DECIMAL)
            completedAt { year month day }
            media { ${MEDIA_FIELDS} }
          }
        }
      }`,
      { id: Number(anilistId), from: fromInt, to: toInt }
    );
    return (data.data.Page?.mediaList || []).filter((e) => e.media);
  });
}

const trendingCache = cached('trending', 30 * 60 * 1000, 20);
async function getTrending(perPage = 10, sort = 'TRENDING_DESC') {
  return trendingCache(`${sort}|${perPage}`, async () => {
    const data = await anilistQuery(
      `query ($n: Int, $sort: [MediaSort]) {
        Page(perPage: $n) { media(type: ANIME, sort: $sort, isAdult: false) { ${MEDIA_FIELDS} } }
      }`,
      { n: perPage, sort: [sort] }
    );
    return data.data.Page?.media || [];
  });
}

// A random pick from the ~2,500 most popular anime (optionally one genre).
async function getRandomAnime(genre = null, retry = false) {
  const page = 1 + Math.floor(Math.random() * (retry ? 10 : genre ? 120 : 500));
  const data = await anilistQuery(
    `query ($page: Int, $genre: String) {
      Page(page: $page, perPage: 5) { media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, genre: $genre) { id } }
    }`,
    { page, genre }
  );
  const list = data.data.Page?.media || [];
  if (!list.length && genre && !retry) return getRandomAnime(genre, true); // rarer genre: stay near the top
  return list.length ? list[Math.floor(Math.random() * list.length)].id : null;
}

/* ------------------------------ AnimeThemes ------------------------------ */
// https://api.animethemes.moe — openings/endings with song, artists, videos.

const themesCache = cached('animethemes', 60 * 60 * 1000, 300);
async function getOpenings(anilistId) {
  return themesCache(Number(anilistId), async () => {
    const include = ['animethemes.animethemeentries.videos', 'animethemes.song', 'animethemes.song.artists'].join(',');
    const url = `https://api.animethemes.moe/anime?filter[has]=resources&filter[site]=AniList&filter[external_id]=${Number(
      anilistId
    )}&include=${include}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`AnimeThemes ${res.status}`);
    const json = await res.json();
    const anime = json.anime?.[0];
    if (!anime) return [];
    return (anime.animethemes || [])
      .filter((t) => t.type === 'OP')
      .sort((a, b) => (a.sequence || 1) - (b.sequence || 1))
      .map((t) => {
        const entry = (t.animethemeentries || [])[0] || {};
        const video = (entry.videos || []).slice().sort((a, b) => (b.resolution || 0) - (a.resolution || 0))[0];
        const artists = (t.song?.artists || t.song?.performances?.map((p) => p.artist).filter(Boolean) || []).map((a) => a.name);
        return {
          slug: t.slug || `OP${t.sequence || 1}`,
          song: t.song?.title || 'Untitled',
          artists,
          episodes: entry.episodes || null,
          videoUrl: video?.link || (video?.basename ? `https://v.animethemes.moe/${video.basename}` : null),
          pageUrl: anime.slug ? `https://animethemes.moe/anime/${anime.slug}/${t.slug || ''}` : null,
        };
      });
  });
}

function fuzzyInt(date) {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

module.exports = {
  titleOf,
  snapshot,
  searchAnime,
  getMediaLite,
  getProfileSnapshot,
  getCompletedBetween,
  getOpenings,
  getTrending,
  getRandomAnime,
  fuzzyInt,
};
