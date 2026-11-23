const express = require('express');
const crypto = require('crypto');
const art = require('./canvasArt');
const { publicUrl } = require('./themes');
const { getMediaBatch, titleOf } = require('./anilistSocial');
const { pickTags } = require('./tags');
const { ctx } = require('./ctx');

/* ---------------------------------------------------------------------------
 * URLs Discord fetches for the generated cards (features/canvasArt.js).
 *
 *   /art/v1/rotation.png?d=<id.progress.status~…>        profile "In Rotation"
 *   /art/v1/banners.png?d=<base64url [[id,"detail"],…]>&l=<label>
 *   /art/v1/lb/<guildId>/<board>.png?v=<hash>            leaderboard
 *   /art/v1/recap/<guildId>/<kind>/<key>.png?v=<hash>    recap "most hours" board
 *
 * Inputs are in the URL (small: ids and numbers), so an old message still
 * renders after a restart. Leaderboard / recap boards are rebuilt from live
 * data; `v` only changes the URL so Discord fetches a fresh copy when the
 * numbers change. Every builder returns null when images aren't possible
 * (no public URL, canvas missing) and callers fall back to text.
 * ------------------------------------------------------------------------- */

const VERSION = 'v1';
const ROTATION_CARDS = 3; // 4 across is unreadable on phones; 3 keeps text legible

const cache = new Map(); // key -> { buf, until }
const inflight = new Map();
let bytes = 0;
const MAX_BYTES = 40 * 1024 * 1024;
// A card where an image failed to load is only kept for a minute, so the
// next request tries again instead of serving the gap forever.
function cached(key, paint) {
  const hit = cache.get(key);
  if (hit && (!hit.until || hit.until > Date.now())) return Promise.resolve(hit.buf);
  if (inflight.has(key)) return inflight.get(key);
  const missesBefore = art.missCount();
  const p = paint()
    .then((buf) => {
      const complete = art.missCount() === missesBefore;
      if (cache.has(key)) bytes -= cache.get(key).buf.length;
      cache.set(key, { buf, until: complete ? 0 : Date.now() + 60 * 1000 });
      bytes += buf.length;
      while (cache.size > 150 || bytes > MAX_BYTES) {
        const k = cache.keys().next().value;
        bytes -= cache.get(k).buf.length;
        cache.delete(k);
      }
      return buf;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const enabled = () => Boolean(publicUrl()) && art.available();
const shortHash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 10);
const coverColor = (m) => (typeof m?.coverImage?.color === 'string' ? parseInt(m.coverImage.color.replace('#', ''), 16) : null);

/* -------------------------------- rotation -------------------------------- */

const STATUS_CODE = { CURRENT: 'c', REPEATING: 'r', PAUSED: 'p', MANUAL: 'm' };
const CODE_STATUS = Object.fromEntries(Object.entries(STATUS_CODE).map(([k, v]) => [v, k]));

// entries: collections.rotationEntries().all
function rotationUrl(entries) {
  if (!enabled() || !entries?.length) return null;
  const d = entries
    .slice(0, ROTATION_CARDS)
    .map((e) => `${Number(e.mediaId)}.${e.progress === null || e.progress === undefined ? 'x' : Math.max(0, e.progress | 0)}.${e.manual ? 'm' : STATUS_CODE[e.listStatus] || 'c'}`)
    .join('~');
  return `${publicUrl()}/art/${VERSION}/rotation.png?d=${d}`;
}

function parseRotation(d) {
  return String(d || '')
    .split('~')
    .slice(0, ROTATION_CARDS)
    .map((part) => {
      const [id, prog, st] = part.split('.');
      return { id: parseInt(id, 10), progress: prog === 'x' ? null : parseInt(prog, 10) || 0, status: CODE_STATUS[st] || 'CURRENT' };
    })
    .filter((x) => x.id > 0);
}

async function seasonNumber(m) {
  if (!ctx.resolveSeasonInfo || !['TV', 'TV_SHORT'].includes(m.format)) return null;
  try {
    const si = await Promise.race([ctx.resolveSeasonInfo(m.id, titleOf(m), m.siteUrl, m.type), new Promise((r) => setTimeout(() => r(null), 6000))]);
    return si?.season || 1;
  } catch {
    return 1;
  }
}

function renderRotation(d) {
  const list = parseRotation(d);
  if (!list.length) return Promise.reject(new Error('empty'));
  return cached(`rot:${d}`, async () => {
    const media = await getMediaBatch(list.map((x) => x.id));
    const items = await Promise.all(
      list.map(async (x) => {
        const m = media.get(x.id) || {};
        const aired = m.nextAiringEpisode?.episode ? m.nextAiringEpisode.episode - 1 : null;
        return {
          title: m.title?.english || m.title?.romaji || 'Unknown title',
          titleRomaji: m.title?.romaji,
          cover: [m.coverImage?.extraLarge, m.coverImage?.large, m.coverImage?.medium, m.bannerImage].filter(Boolean),
          progress: x.progress,
          total: m.episodes || null,
          aired,
          status: x.status,
          format: m.format || 'TV',
          season: await seasonNumber(m),
          tags: pickTags(m.tags, m.genres, 3),
          accent: coverColor(m),
        };
      })
    );
    return art.paintRotation(items, { cardW: 500 });
  });
}

/* ------------------------------- banner list ------------------------------- */

// items: [{ mediaId, detail }]
function bannerListUrl(items, label = null, { start = 1 } = {}) {
  if (!enabled() || !items?.length) return null;
  const d = Buffer.from(JSON.stringify(items.slice(0, 5).map((x) => [Number(x.mediaId), String(x.detail || '').slice(0, 70)]))).toString('base64url');
  return `${publicUrl()}/art/${VERSION}/banners.png?d=${d}${label ? `&l=${encodeURIComponent(String(label).slice(0, 40))}` : ''}${start > 1 ? `&r=${start | 0}` : ''}`;
}

function renderBannerList(d, label, start = 1) {
  let rows;
  try {
    rows = JSON.parse(Buffer.from(String(d), 'base64url').toString('utf8'));
  } catch {
    return Promise.reject(new Error('bad data'));
  }
  if (!Array.isArray(rows) || !rows.length) return Promise.reject(new Error('empty'));
  rows = rows.slice(0, 5).filter((r) => Array.isArray(r) && Number(r[0]) > 0);
  start = Math.max(1, Math.min(50, parseInt(start, 10) || 1));
  return cached(`bl:${d}:${label || ''}:${start}`, async () => {
    const media = await getMediaBatch(rows.map((r) => r[0])).catch(() => new Map());
    const st = ctx.loadStats ? await ctx.loadStats().catch(() => null) : null;
    const items = rows.map(([id, detail], i) => {
      const m = media.get(Number(id));
      const sm = st?.media?.[id] || {};
      return {
        title: m ? m.title?.english || m.title?.romaji : sm.t || 'Unknown title',
        titleRomaji: m?.title?.romaji,
        banner: m?.bannerImage || sm.b || null,
        cover: [m?.coverImage?.extraLarge, m?.coverImage?.large, sm.c].filter(Boolean),
        detail: String(detail || ''),
        accent: coverColor(m),
        rank: start + i,
      };
    });
    return art.paintBannerList(items, { label });
  });
}

/* -------------------------------- favorites -------------------------------- */

// ids: favorite media ids (first 3 shown) · total: count for the header ·
// border: a colour (number) for every card, or null for each anime's colour.
function favoritesUrl(ids, total, border = null) {
  if (!enabled() || !ids?.length) return null;
  const b = typeof border === 'number' ? border.toString(16).padStart(6, '0') : 'a';
  return `${publicUrl()}/art/${VERSION}/favorites.png?d=${ids.slice(0, 3).map(Number).join('-')}&n=${Math.max(0, total | 0)}&b=${b}`;
}

function renderFavorites(d, n, b) {
  const ids = String(d || '')
    .split('-')
    .map((x) => parseInt(x, 10))
    .filter((x) => x > 0)
    .slice(0, 3);
  if (!ids.length) return Promise.reject(new Error('empty'));
  const border = /^[0-9a-f]{6}$/i.test(String(b || '')) ? parseInt(b, 16) : null;
  const total = Math.max(ids.length, parseInt(n, 10) || ids.length);
  return cached(`fav:${ids.join('-')}:${total}:${border ?? 'a'}`, async () => {
    const media = await getMediaBatch(ids);
    const items = ids.map((id) => {
      const m = media.get(id) || {};
      const title = m.title?.english || m.title?.romaji || 'Unknown title';
      const alt = m.title?.english && m.title?.romaji && m.title.romaji.toLowerCase() !== m.title.english.toLowerCase() ? m.title.romaji : null;
      return { title, titleRomaji: m.title?.romaji, subtitle: alt, banner: m.bannerImage || null, cover: [m.coverImage?.extraLarge, m.coverImage?.large].filter(Boolean), accent: coverColor(m) };
    });
    return art.paintFavorites(items, { total, border });
  });
}

/* ----------------------------- openings / endings ----------------------------- */

// songs: [{ mediaId, slug, song, artists[], animeTitle }]
function songsUrl(kind, songs) {
  if (!enabled() || !songs?.length) return null;
  const d = Buffer.from(JSON.stringify(songs.slice(0, 3).map((x) => [Number(x.mediaId), String(x.slug || '').slice(0, 8), String(x.song || '').slice(0, 60), String((x.artists || []).join(', ')).slice(0, 60), String(x.animeTitle || '').slice(0, 60)]))).toString('base64url');
  return `${publicUrl()}/art/${VERSION}/songs.png?k=${kind === 'ED' ? 'ED' : 'OP'}&d=${d}`;
}

function renderSongs(kind, d) {
  let rows;
  try {
    rows = JSON.parse(Buffer.from(String(d), 'base64url').toString('utf8'));
  } catch {
    return Promise.reject(new Error('bad data'));
  }
  if (!Array.isArray(rows) || !rows.length) return Promise.reject(new Error('empty'));
  rows = rows.slice(0, 3).filter((r) => Array.isArray(r) && Number(r[0]) > 0);
  const k = kind === 'ED' ? 'ED' : 'OP';
  return cached(`songs:${k}:${d}`, async () => {
    const media = await getMediaBatch(rows.map((r) => r[0])).catch(() => new Map());
    const songs = rows.map(([id, slug, song, artist, anime]) => {
      const m = media.get(Number(id));
      return { slug, song, artist, anime: anime || m?.title?.english || m?.title?.romaji || '', cover: [m?.coverImage?.extraLarge, m?.coverImage?.large, m?.coverImage?.medium].filter(Boolean) };
    });
    return art.paintSongs(k, songs);
  });
}

/* -------------------------------- featured -------------------------------- */

function featuredUrl(mediaId) {
  if (!enabled() || !mediaId) return null;
  return `${publicUrl()}/art/${VERSION}/featured/${Number(mediaId)}.png`;
}

function renderFeatured(mediaId) {
  const id = Number(mediaId);
  return cached(`feat:${id}`, async () => {
    const m = (await getMediaBatch([id])).get(id);
    if (!m) throw new Error('empty');
    return art.paintFeatured({ banner: m.bannerImage, cover: [m.coverImage?.extraLarge, m.coverImage?.large].filter(Boolean) });
  });
}

/* ------------------------- leaderboards & recap boards ------------------------- */

function leaderboardUrl(guildId, board, rows) {
  if (!enabled() || !rows?.length) return null;
  return `${publicUrl()}/art/${VERSION}/lb/${guildId}/${board}.png?v=${shortHash(rows.map((r) => [r.name, r.value, r.detail, r.avatar]))}`;
}

async function renderLeaderboard(guildId, board, v) {
  return cached(`lb:${guildId}:${board}:${v}`, async () => {
    const statsUi = require('./statsUi');
    const res = await statsUi.leaderboardRows(guildId, board);
    const meta = statsUi.BOARDS[res.board] || {};
    return art.paintLeaderboard({ title: meta.label || 'Leaderboard', subtitle: res.subtitle, unit: meta.unit || '', accent: meta.accent || 0x3db4f2, rows: res.rows });
  });
}

function recapBoardUrl(guildId, kind, key, rows) {
  if (!enabled() || !rows?.length) return null;
  return `${publicUrl()}/art/${VERSION}/recap/${guildId}/${kind}/${key}.png?v=${shortHash(rows.map((r) => [r.name, r.value, r.detail]))}`;
}

async function renderRecapBoard(guildId, kind, key, v) {
  return cached(`rc:${guildId}:${kind}:${key}:${v}`, async () => {
    const recaps = require('./recaps');
    const b = await recaps.hoursBoard(guildId, kind, key);
    if (!b) throw new Error('empty');
    return art.paintLeaderboard(b);
  });
}

/* ---------------------------------- warm ---------------------------------- */

// Start painting before Discord asks (so the image is ready when it does).
function warm(url) {
  if (!url) return;
  try {
    const u = new URL(url);
    const p = u.pathname;
    let job = null;
    if (p.endsWith('/rotation.png')) job = renderRotation(u.searchParams.get('d'));
    else if (p.endsWith('/favorites.png')) job = renderFavorites(u.searchParams.get('d'), u.searchParams.get('n'), u.searchParams.get('b'));
    else if (p.endsWith('/songs.png')) job = renderSongs(u.searchParams.get('k'), u.searchParams.get('d'));
    else if (/\/featured\/\d+\.png$/.test(p)) job = renderFeatured(p.match(/\/featured\/(\d+)\.png$/)[1]);
    else if (p.endsWith('/banners.png')) job = renderBannerList(u.searchParams.get('d'), u.searchParams.get('l'), u.searchParams.get('r'));
    else {
      const lb = p.match(/\/lb\/(\d+)\/(\w+)\.png$/);
      const rc = p.match(/\/recap\/(\d+)\/(week|month)\/([\d-]+)\.png$/);
      if (lb) job = renderLeaderboard(lb[1], lb[2], u.searchParams.get('v') || '');
      if (rc) job = renderRecapBoard(rc[1], rc[2], rc[3], u.searchParams.get('v') || '');
    }
    if (job) job.catch(() => {});
  } catch {
    /* ignore */
  }
}

// Every art URL inside a payload, warmed and waited for together.
async function warmPayload(payload, ms = 4500) {
  if (!enabled()) return;
  let json = '';
  try {
    json = JSON.stringify((payload?.components || []).map((c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c)));
  } catch {
    return;
  }
  const base = publicUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urls = [...new Set(json.match(new RegExp(`${base}/art/[^"\\s]+`, 'g')) || [])].map((u) => u.replace(/\\u0026/g, '&'));
  if (!urls.length) return;
  urls.forEach(warm);
  const jobs = [...inflight.values()];
  if (jobs.length) await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, ms))]);
}

// Same, but wait (up to `ms`) so the image is ready — and any failed cover
// retried — before the message that shows it is sent.
async function warmWait(url, ms = 6000) {
  if (!url) return;
  warm(url);
  const jobs = [...inflight.values()];
  if (!jobs.length) return;
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, ms))]);
}

/* --------------------------------- router --------------------------------- */

function buildArtRouter() {
  const router = express.Router();
  const send = (res, buf) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('png').send(buf);
  };
  const fail = (res, what, e) => {
    if (e.message !== 'empty') console.error(`${what} image failed:`, e.message);
    res.status(e.message === 'empty' || e.message === 'bad data' ? 404 : 500).end();
  };
  const guard = (res) => {
    if (art.available()) return true;
    res.status(503).end();
    return false;
  };

  router.get(`/art/${VERSION}/rotation.png`, async (req, res) => {
    if (!guard(res)) return;
    try {
      send(res, await renderRotation(String(req.query.d || '').slice(0, 200)));
    } catch (e) {
      fail(res, 'Rotation', e);
    }
  });
  router.get(`/art/${VERSION}/favorites.png`, async (req, res) => {
    if (!guard(res)) return;
    try {
      send(res, await renderFavorites(String(req.query.d || '').slice(0, 60), req.query.n, String(req.query.b || 'a').slice(0, 6)));
    } catch (e) {
      fail(res, 'Favorites', e);
    }
  });
  router.get(`/art/${VERSION}/songs.png`, async (req, res) => {
    if (!guard(res)) return;
    try {
      send(res, await renderSongs(String(req.query.k || 'OP'), String(req.query.d || '').slice(0, 1500)));
    } catch (e) {
      fail(res, 'Songs', e);
    }
  });
  router.get(`/art/${VERSION}/featured/:id.png`, async (req, res) => {
    if (!guard(res)) return;
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).end();
    try {
      send(res, await renderFeatured(req.params.id));
    } catch (e) {
      fail(res, 'Featured', e);
    }
  });
  router.get(`/art/${VERSION}/banners.png`, async (req, res) => {
    if (!guard(res)) return;
    try {
      send(res, await renderBannerList(String(req.query.d || '').slice(0, 1500), req.query.l ? String(req.query.l).slice(0, 40) : null, req.query.r));
    } catch (e) {
      fail(res, 'Banner list', e);
    }
  });
  router.get(`/art/${VERSION}/lb/:guildId/:board.png`, async (req, res) => {
    if (!guard(res)) return;
    if (!/^\d{5,25}$/.test(req.params.guildId) || !/^\w{2,20}$/.test(req.params.board)) return res.status(400).end();
    try {
      send(res, await renderLeaderboard(req.params.guildId, req.params.board, String(req.query.v || '').slice(0, 20)));
    } catch (e) {
      fail(res, 'Leaderboard', e);
    }
  });
  router.get(`/art/${VERSION}/recap/:guildId/:kind/:key.png`, async (req, res) => {
    if (!guard(res)) return;
    const { guildId, kind, key } = req.params;
    if (!/^\d{5,25}$/.test(guildId) || !['week', 'month'].includes(kind) || !/^\d{4}-\d{2}(-\d{2})?$/.test(key)) return res.status(400).end();
    try {
      send(res, await renderRecapBoard(guildId, kind, key, String(req.query.v || '').slice(0, 20)));
    } catch (e) {
      fail(res, 'Recap board', e);
    }
  });
  return router;
}

module.exports = { buildArtRouter, rotationUrl, bannerListUrl, favoritesUrl, songsUrl, featuredUrl, leaderboardUrl, recapBoardUrl, warm, warmWait, warmPayload, enabled, cached, coverColor, ROTATION_CARDS, _render: { renderRotation, renderBannerList, renderLeaderboard, renderRecapBoard, renderFavorites, renderSongs, renderFeatured } };
