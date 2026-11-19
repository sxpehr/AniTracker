const ANILIST_API = 'https://graphql.anilist.co';
const ANILIST_OAUTH = 'https://anilist.co/api/v2/oauth';
const REQUEST_TIMEOUT_MS = 12000;

// A fetch that can't hang forever. Without a timeout, one stuck AniList
// request would freeze the poll loop indefinitely (and, with the poll
// overlap guard, block every poll after it).
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function anilistQuery(query, variables, { token, retryOn429 = true } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchWithTimeout(ANILIST_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  // Rate limited: AniList says how long to wait. Wait once (capped) and retry.
  if (res.status === 429 && retryOn429) {
    const retryAfter = Math.min(parseInt(res.headers.get('retry-after'), 10) || 30, 60);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
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

async function getRecentActivities(userId, perPage = 10) {
  const query = `
    query ($userId: Int, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        activities(userId: $userId, sort: ID_DESC) {
          __typename
          ... on ListActivity {
            id
            status
            progress
            createdAt
            media {
              id
              type
              format
              title { romaji english }
              siteUrl
              description(asHtml: false)
              coverImage { extraLarge large medium }
              bannerImage
              averageScore
              genres
              isAdult
              episodes
              duration
            }
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
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { userId, perPage });
  return data.data.Page?.activities || [];
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
        tags { name rank isMediaSpoiler isGeneralSpoiler }
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
  getMediaById,
  getUserFavorites,
  getMediaRelations,
  getMediaDetails,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getViewer,
};
