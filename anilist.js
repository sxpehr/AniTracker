const ANILIST_API = 'https://graphql.anilist.co';
const ANILIST_OAUTH = 'https://anilist.co/api/v2/oauth';
const REQUEST_TIMEOUT_MS = 12000;

// A fetch that can't hang forever. Without a timeout, one stuck AniList
// request would freeze the poll loop indefinitely (and, with the poll
// overlap guard, block every poll after it).
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

// Rate-limit gate. AniList allows ~90 requests/min (sometimes lowered to 30)
// and reports what's left in X-RateLimit-Remaining. When we're nearly out we
// wait for the window to reset instead of firing requests that get a 429 —
// before this, a big poll burned the budget early and the accounts polled
// last kept failing every single poll.
let gateUntil = 0;
function noteRateLimit(res) {
  const remaining = parseInt(res.headers.get('x-ratelimit-remaining'), 10);
  const reset = parseInt(res.headers.get('x-ratelimit-reset'), 10); // unix seconds
  if (Number.isFinite(remaining) && remaining <= 2) {
    const until = Number.isFinite(reset) ? reset * 1000 + 250 : Date.now() + 20000;
    gateUntil = Math.max(gateUntil, Math.min(until, Date.now() + 60000));
  }
}
async function waitForGate() {
  const wait = gateUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function anilistQuery(query, variables, { token, retryOn429 = true } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  await waitForGate();
  const res = await fetchWithTimeout(ANILIST_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  noteRateLimit(res);

  // Rate limited: AniList says how long to wait. Wait once (capped) and retry.
  if (res.status === 429 && retryOn429) {
    const retryAfter = Math.min(parseInt(res.headers.get('retry-after'), 10) || 30, 60);
    gateUntil = Math.max(gateUntil, Date.now() + retryAfter * 1000);
    await waitForGate();
    return anilistQuery(query, variables, { token, retryOn429: false });
  }

  // AniList answers "no such user/media" with HTTP 404 — that's a normal
  // "not found", not a failure, so callers get null instead of an error.
  if (res.status === 404) return { data: {} };

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AniList API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.errors) {
    // "Not Found" is a normal answer (e.g. a username that doesn't exist).
    if (json.errors.every((e) => e.status === 404)) return { data: {} };
    throw new Error(`AniList API returned errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json;
}

async function getUserByName(name) {
  const query = `
    query ($name: String) {
      User(name: $name) {
        id
        name
        siteUrl
        avatar { medium }
      }
    }`;
  const data = await anilistQuery(query, { name });
  return data.data.User || null;
}

// Everything an activity post needs about a show, in the poll request itself.
const ACTIVITY_MEDIA = `
  id
  type
  format
  status
  title { romaji english }
  siteUrl
  description(asHtml: false)
  coverImage { extraLarge large medium color }
  bannerImage
  averageScore
  genres
  isAdult
  episodes
  chapters
  duration
  nextAiringEpisode { episode airingAt }
`;

const ACTIVITY_FRAGMENT = `
          __typename
          ... on ListActivity {
            id
            status
            progress
            createdAt
            media { ${ACTIVITY_MEDIA} }
          }
          ... on TextActivity {
            id
            text
            createdAt
            siteUrl
          }
          ... on MessageActivity {
            id
            message
            createdAt
            siteUrl
          }`;

async function getRecentActivities(userId, perPage = 10) {
  const query = `
    query ($userId: Int, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        activities(userId: $userId, sort: ID_DESC) { ${ACTIVITY_FRAGMENT} }
      }
    }`;
  const data = await anilistQuery(query, { userId, perPage });
  return data.data.Page?.activities || [];
}

// One request per account per poll: the latest activities AND the most
// recently updated list entries. The list entries catch updates that never
// show up as an activity (AniList's "disable list activity" settings, or a
// long "activity merge time" that keeps folding new episodes into one old
// activity). If AniList ever rejects the list part, we fall back to the
// activities-only query and stop asking for it.
let listQueryBroken = false;
async function getRecentFeed(userId, perPage = 25) {
  if (listQueryBroken) return { activities: await getRecentActivities(userId, perPage), entries: null };
  const query = `
    query ($userId: Int, $perPage: Int) {
      acts: Page(page: 1, perPage: $perPage) {
        activities(userId: $userId, sort: ID_DESC) { ${ACTIVITY_FRAGMENT} }
      }
      list: Page(page: 1, perPage: 12) {
        mediaList(userId: $userId, sort: UPDATED_TIME_DESC) {
          id
          status
          progress
          updatedAt
          media { ${ACTIVITY_MEDIA} }
        }
      }
    }`;
  try {
    const data = await anilistQuery(query, { userId, perPage });
    return { activities: data.data.acts?.activities || [], entries: data.data.list?.mediaList || [] };
  } catch (e) {
    if (/AniList API (error 400|returned errors)/.test(e.message) && /mediaList|argument|Unknown|complex|depth|validation/i.test(e.message)) {
      console.warn('AniList rejected the list-entries part of the poll query — polling activities only from now on:', e.message);
      listQueryBroken = true;
      return { activities: await getRecentActivities(userId, perPage), entries: null };
    }
    throw e;
  }
}

// Tags for many shows in ONE request (used to give posts and stats specific
// labels like "Isekai" or "Satire" instead of broad genres). Cached forever-ish
// in memory; tags barely change.
const tagCache = new Map(); // mediaId -> [{ name, rank, category, ... }]
async function getMediaTags(ids) {
  const want = [...new Set(ids.map(Number).filter((n) => n > 0))];
  const missing = want.filter((id) => !tagCache.has(id)).slice(0, 50);
  if (missing.length) {
    const data = await anilistQuery(
      `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids) { id tags { name rank category isMediaSpoiler isGeneralSpoiler isAdult } } } }`,
      { ids: missing }
    );
    for (const m of data.data.Page?.media || []) {
      tagCache.set(m.id, m.tags || []);
      if (tagCache.size > 3000) tagCache.delete(tagCache.keys().next().value);
    }
    for (const id of missing) if (!tagCache.has(id)) tagCache.set(id, []);
  }
  return new Map(want.map((id) => [id, tagCache.get(id) || []]));
}

// Several AniList users' list entries for one show, in one request
// (/watched: who in this server has seen it, how far, what score).
async function getEntriesForMedia(mediaId, userIds) {
  const ids = [...new Set(userIds.map(Number).filter((n) => n > 0))].slice(0, 50);
  if (!ids.length) return [];
  const data = await anilistQuery(
    `query ($m: Int, $ids: [Int]) {
      Page(perPage: 50) {
        mediaList(mediaId: $m, userId_in: $ids) {
          userId
          status
          progress
          repeat
          updatedAt
          score(format: POINT_10_DECIMAL)
        }
      }
    }`,
    { m: Number(mediaId), ids }
  );
  return data.data.Page?.mediaList || [];
}

async function getMediaById(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id) {
        id
        type
        title { romaji english }
        siteUrl
        coverImage { large medium }
      }
    }`;
  const data = await anilistQuery(query, { id });
  return data.data.Media || null;
}

async function getUserFavorites(name) {
  const query = `
    query ($name: String) {
      User(name: $name) {
        id
        name
        siteUrl
        avatar { medium }
        favourites {
          anime(perPage: 10) {
            nodes { title { romaji english } siteUrl }
          }
          manga(perPage: 10) {
            nodes { title { romaji english } siteUrl }
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { name });
  return data.data.User || null;
}

async function getMediaRelations(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id) {
        id
        type
        format
        rankings { rank type allTime }
        relations {
          edges {
            relationType
            node {
              id
              type
              format
              title { romaji english }
              siteUrl
              rankings { rank type allTime }
            }
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { id });
  return data.data.Media || null;
}

// Everything the "More Info" panel shows, in one request.
async function getMediaDetails(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id) {
        id
        idMal
        type
        format
        status
        episodes
        duration
        chapters
        volumes
        season
        seasonYear
        source
        countryOfOrigin
        isAdult
        startDate { year month day }
        endDate { year month day }
        title { romaji english native }
        siteUrl
        description(asHtml: false)
        coverImage { extraLarge large color }
        bannerImage
        averageScore
        meanScore
        popularity
        favourites
        genres
        tags { name rank category isMediaSpoiler isGeneralSpoiler isAdult }
        studios(isMain: true) { nodes { name siteUrl } }
        nextAiringEpisode { episode airingAt }
        trailer { id site }
        externalLinks { site url type isDisabled }
        rankings { rank type allTime context }
        characters(sort: [ROLE, RELEVANCE, ID], perPage: 3) {
          edges {
            role
            node { name { full } image { large } siteUrl }
            voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) { name { full } }
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { id });
  return data.data.Media || null;
}

/* ---------------- OAuth (AniList sign-in) ---------------- */

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });
  return `${ANILIST_OAUTH}/authorize?${params.toString()}`;
}

async function exchangeCodeForToken({ clientId, clientSecret, redirectUri, code }) {
  const res = await fetchWithTimeout(`${ANILIST_OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${body.message || body.error || 'no access_token returned'}`);
  }
  return body.access_token;
}

async function getViewer(token) {
  const query = `
    query {
      Viewer {
        id
        name
        siteUrl
        avatar { medium }
      }
    }`;
  const data = await anilistQuery(query, {}, { token });
  return data.data.Viewer || null;
}

module.exports = {
  anilistQuery,
  getUserByName,
  getRecentActivities,
  getRecentFeed,
  getMediaTags,
  getEntriesForMedia,
  getMediaById,
  getUserFavorites,
  getMediaRelations,
  getMediaDetails,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getViewer,
};
