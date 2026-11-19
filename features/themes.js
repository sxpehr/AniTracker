const express = require('express');
const Jimp = require('jimp');
const { getMediaLite } = require('./anilistSocial');

/* ---------------------------------------------------------------------------
 * Profile themes + generated banners
 *
 * Discord cards can't have a background colour — only a thin accent stripe.
 * So each theme also defines a background + two accent colours, and the bot
 * paints a banner image from them (soft diagonal gradient, glow and a faint
 * dot grid). The banner is served by the bot's own web server at a URL that
 * encodes the colours, so Discord fetches it once and caches it — no file
 * uploads on every profile view.
 *
 * "Featured anime" banners take that anime's AniList banner and wash the
 * theme colours over it for a cinematic look.
 * ------------------------------------------------------------------------- */

const THEMES = {
  anilist: { name: 'AniList', emoji: '🟦', bg: 0x0b1622, accent: 0x3db4f2, accent2: 0x7dd3fc, blurb: 'The classic — AniList blue on navy' },
  midnight: { name: 'Midnight', emoji: '🌌', bg: 0x0d0f2b, accent: 0x6c63ff, accent2: 0x2dd4bf, blurb: 'Deep indigo with a teal glow' },
  amoled: { name: 'AMOLED', emoji: '⬛', bg: 0x000000, accent: 0xa855f7, accent2: 0x4c1d95, blurb: 'True black with violet accents' },
  sakura: { name: 'Sakura', emoji: '🌸', bg: 0xfff1f5, accent: 0xff8fab, accent2: 0xffc2d1, blurb: 'Soft white and blossom pink' },
  cyberpunk: { name: 'Cyberpunk', emoji: '🌆', bg: 0x0a0014, accent: 0xfcee0a, accent2: 0xff2a6d, blurb: 'Neon yellow and hot pink at night' },
  crimson: { name: 'Crimson', emoji: '🩸', bg: 0x14070a, accent: 0xdc143c, accent2: 0xff6b6b, blurb: 'Dark with a blood-red edge' },
  ocean: { name: 'Ocean', emoji: '🌊', bg: 0x03203c, accent: 0x00b4d8, accent2: 0x90e0ef, blurb: 'Deep sea blues' },
  lavender: { name: 'Lavender', emoji: '💜', bg: 0x1e1530, accent: 0xb57edc, accent2: 0xe0c3fc, blurb: 'Dusky purple, gentle lilac' },
  minimal: { name: 'Minimal', emoji: '⬜', bg: 0x18191c, accent: 0xb9bbbe, accent2: 0x4f545c, blurb: 'Quiet greys, no fuss' },
};
const DEFAULT_THEME = 'anilist';

function hex(n) {
  return `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase()}`;
}

function parseHex(s) {
  const m = String(s || '').trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return parseInt(h, 16);
}

// The effective palette for a profile: theme preset + any custom overrides.
function paletteFor(profile = {}) {
  const base = THEMES[profile.theme] || THEMES[DEFAULT_THEME];
  const overridden = [profile.background, profile.accent, profile.accent2].some((v) => Number.isInteger(v));
  return {
    key: THEMES[profile.theme] ? profile.theme : DEFAULT_THEME,
    name: overridden || profile.theme === 'custom' ? 'Custom' : base.name,
    bg: Number.isInteger(profile.background) ? profile.background : base.bg,
    accent: Number.isInteger(profile.accent) ? profile.accent : base.accent,
    accent2: Number.isInteger(profile.accent2) ? profile.accent2 : base.accent2,
  };
}

/* ------------------------------ painting ------------------------------ */

const W = 1200;
const H = 300;

function rgb(n) {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  return a + (b - a) * t;
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Gradient banner: background -> accent sweep, a glow in accent2, thin
// orbit rings and a scatter of ✦ sparkles (the AniTracker motif), with a
// touch of dithering so the gradient never bands.
async function paintThemeBanner(bg, accent, accent2) {
  const img = new Jimp(W, H, 0x000000ff);
  const B = rgb(bg);
  const A = rgb(accent);
  const C = rgb(accent2);
  const light = luminance(B) > 0.6;
  const ink = light ? A : [255, 255, 255];
  const data = img.bitmap.data;
  const glowX = W * 0.8;
  const glowY = H * 0.2;
  const glowR = W * 0.55;
  const ringCx = W * 1.02;
  const ringCy = H * 0.55;
  const rings = [170, 260, 360, 470];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const t = Math.max(0, Math.min(1, (x / W) * 0.85 + (1 - y / H) * 0.35 - 0.2));
      const sweep = Math.pow(t, 1.6) * (light ? 0.55 : 0.72);
      let r = mix(B[0], A[0], sweep);
      let g = mix(B[1], A[1], sweep);
      let b = mix(B[2], A[2], sweep);
      const d = Math.hypot(x - glowX, (y - glowY) * 1.6) / glowR;
      const glow = Math.max(0, 1 - d) ** 2 * (light ? 0.5 : 0.55);
      r = mix(r, C[0], glow);
      g = mix(g, C[1], glow);
      b = mix(b, C[2], glow);
      // orbit rings
      const rd = Math.hypot(x - ringCx, (y - ringCy) * 1.15);
      let ring = 0;
      for (const rr of rings) ring += Math.exp(-(((rd - rr) / 1.4) ** 2));
      ring *= (light ? 0.3 : 0.16) * Math.min(1, x / (W * 0.45));
      r = mix(r, ink[0], ring);
      g = mix(g, ink[1], ring);
      b = mix(b, ink[2], ring);
      // bottom vignette for depth
      const v = Math.max(0, (y / H - 0.55) / 0.45) * (light ? 0.06 : 0.35);
      const vt = light ? 255 : 0;
      r = mix(r, vt, v);
      g = mix(g, vt, v);
      b = mix(b, vt, v);
      const n = (rand() - 0.5) * 4;
      data[idx] = clamp(r + n);
      data[idx + 1] = clamp(g + n);
      data[idx + 2] = clamp(b + n);
      data[idx + 3] = 255;
    }
  }

  // ✦ sparkles — more and brighter toward the right
  const sparkles = 26;
  for (let i = 0; i < sparkles; i++) {
    const cx = W * (0.25 + 0.75 * Math.sqrt(rand()));
    const cy = H * rand();
    const size = 4 + rand() * (i < 4 ? 18 : 9);
    const strength = (0.35 + rand() * 0.5) * (cx / W);
    const col = light ? (rand() < 0.5 ? A : [255, 255, 255]) : rand() < 0.5 ? C : [255, 255, 255];
    const reach = Math.ceil(size);
    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(H, cy + reach); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(W, cx + reach); x++) {
        const dx = Math.abs(x - cx) / size;
        const dy = Math.abs(y - cy) / size;
        const arms = Math.max(0, 1 - dx) * Math.max(0, 1 - dy * 7) + Math.max(0, 1 - dy) * Math.max(0, 1 - dx * 7);
        const core = Math.max(0, 1 - Math.hypot(dx, dy) * 3);
        const a = Math.min(1, (arms * 0.8 + core) * strength);
        if (a <= 0) continue;
        const idx = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) data[idx + k] = clamp(mix(data[idx + k], col[k], a));
      }
    }
  }
  return img.quality(90).getBufferAsync(Jimp.MIME_JPEG);
}

// Featured-anime banner: AniList banner (or cover) cropped to 4:1 with the
// theme colours washed over the left and bottom.
async function paintFeaturedBanner(imageUrl, bg, accent) {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const src = await Jimp.read(Buffer.from(await res.arrayBuffer()));
  src.cover(W, H);
  const B = rgb(bg);
  const A = rgb(accent);
  const data = src.bitmap.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const left = Math.max(0, 1 - x / (W * 0.65)) ** 1.5 * 0.85;
      const bottom = Math.max(0, (y / H - 0.35) / 0.65) ** 2 * 0.6;
      const wash = Math.min(0.92, left + bottom);
      const tint = 0.12;
      for (let k = 0; k < 3; k++) {
        let v = mix(data[idx + k], A[k], tint);
        v = mix(v, B[k], wash);
        data[idx + k] = clamp(v);
      }
    }
  }
  return src.quality(86).getBufferAsync(Jimp.MIME_JPEG);
}

/* ------------------------- profile header art ------------------------- */

async function fetchImage(url, timeout = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  return Jimp.read(Buffer.from(await res.arrayBuffer()));
}

// Draws `src` into `dst` as a circle (anti-aliased edge) centred at cx,cy.
function drawCircle(dst, src, cx, cy, r) {
  src.cover(Math.ceil(r * 2), Math.ceil(r * 2));
  const D = dst.bitmap;
  const S = src.bitmap;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(D.height, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(D.width, Math.ceil(cx + r)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      if (a <= 0) continue;
      const sx = Math.min(S.width - 1, Math.max(0, Math.floor(x - (cx - r))));
      const sy = Math.min(S.height - 1, Math.max(0, Math.floor(y - (cy - r))));
      const si = (sy * S.width + sx) * 4;
      const di = (y * D.width + x) * 4;
      const sa = (S.data[si + 3] / 255) * a;
      const da = D.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) D.data[di + k] = oa ? clamp((S.data[si + k] * sa + D.data[di + k] * da * (1 - sa)) / oa) : 0;
      D.data[di + 3] = clamp(oa * 255);
    }
  }
}

// Filled ring (annulus) in one colour, anti-aliased, optional arc (0..1 from 12 o'clock, clockwise).
function drawRing(dst, cx, cy, rOuter, rInner, color, alpha = 1, arc = 1) {
  const D = dst.bitmap;
  const [cr, cg, cb] = rgb(color);
  for (let y = Math.max(0, Math.floor(cy - rOuter)); y < Math.min(D.height, Math.ceil(cy + rOuter)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rOuter)); x < Math.min(D.width, Math.ceil(cx + rOuter)); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      let a = Math.max(0, Math.min(1, rOuter - d + 0.5)) * Math.max(0, Math.min(1, d - rInner + 0.5));
      if (a <= 0) continue;
      if (arc < 1) {
        const ang = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1; // 0 at top, clockwise
        if (ang > arc) continue;
      }
      a *= alpha;
      const di = (y * D.width + x) * 4;
      const da = D.data[di + 3] / 255;
      const oa = a + da * (1 - a);
      D.data[di] = clamp((cr * a + D.data[di] * da * (1 - a)) / oa);
      D.data[di + 1] = clamp((cg * a + D.data[di + 1] * da * (1 - a)) / oa);
      D.data[di + 2] = clamp((cb * a + D.data[di + 2] * da * (1 - a)) / oa);
      D.data[di + 3] = clamp(oa * 255);
    }
  }
}

// Profile header: the banner, with the avatar overlapping its bottom edge.
// Everything below the banner is transparent, so the avatar sits on the
// card itself in both light and dark Discord themes.
const HEADER_BAND = 140;
const AVATAR_R = 112;
async function paintProfileHeader({ bannerBuf, avatarUrl, accent }) {
  const banner = await Jimp.read(bannerBuf);
  banner.cover(W, H);
  const img = new Jimp(W, H + HEADER_BAND, 0x00000000);
  img.composite(banner, 0, 0);
  const cx = 64 + AVATAR_R;
  const cy = H; // centred on the banner's bottom edge
  // soft shadow, accent ring, then the avatar
  drawRing(img, cx, cy + 4, AVATAR_R + 18, 0, 0x000000, 0.25);
  drawRing(img, cx, cy, AVATAR_R + 12, 0, accent, 1);
  try {
    const av = await fetchImage(avatarUrl);
    drawCircle(img, av, cx, cy, AVATAR_R);
  } catch {
    drawRing(img, cx, cy, AVATAR_R, 0, 0x5865f2, 1);
  }
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// Progress ring: the cover in a circle, wrapped by an accent arc over a muted track.
async function paintRing({ coverUrl, progress, total, accent }) {
  const S = 256;
  const img = new Jimp(S, S, 0x00000000);
  const c = S / 2;
  const ratio = total > 0 ? Math.max(0, Math.min(1, progress / total)) : 0;
  drawRing(img, c, c, c - 2, c - 22, 0x80848e, 0.35);
  if (ratio > 0) drawRing(img, c, c, c - 2, c - 22, accent, 1, ratio);
  try {
    const cover = await fetchImage(coverUrl);
    drawCircle(img, cover, c, c, c - 32);
  } catch {
    drawRing(img, c, c, c - 32, 0, 0x2b2d31, 1);
  }
  return img.getBufferAsync(Jimp.MIME_PNG);
}

/* -------------------------- serving + caching -------------------------- */

const bannerCache = new Map(); // key -> Buffer
const inflight = new Map();
const MAX_BANNERS = 120;
const MAX_CACHE_BYTES = 30 * 1024 * 1024;
let cacheBytes = 0;

async function cachedBanner(key, paint) {
  if (bannerCache.has(key)) return bannerCache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = paint()
    .then((buf) => {
      bannerCache.set(key, buf);
      cacheBytes += buf.length;
      // bounded by count AND total size (header PNGs can be a few hundred KB)
      while (bannerCache.size > MAX_BANNERS || cacheBytes > MAX_CACHE_BYTES) {
        const k = bannerCache.keys().next().value;
        cacheBytes -= bannerCache.get(k).length;
        bannerCache.delete(k);
      }
      return buf;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const hex6 = (n) => (n >>> 0).toString(16).padStart(6, '0').slice(-6);

function publicUrl() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
}

const BANNER_VERSION = 'v1'; // bump to make Discord fetch fresh copies after a design change

// URL of the banner image for a profile, or a custom image URL, or null.
function bannerUrlFor(profile = {}) {
  const pal = paletteFor(profile);
  const mode = profile.bannerMode || 'theme';
  if (mode === 'none') return null;
  if (mode === 'url' && /^https:\/\/\S+$/i.test(profile.bannerUrl || '')) return profile.bannerUrl;
  const base = publicUrl();
  if (!base) return null;
  if (mode === 'featured' && profile.featured?.mediaId) {
    return `${base}/banner/${BANNER_VERSION}/anime/${Number(profile.featured.mediaId)}/${hex6(pal.bg)}-${hex6(pal.accent)}.jpg`;
  }
  return `${base}/banner/${BANNER_VERSION}/theme/${hex6(pal.bg)}-${hex6(pal.accent)}-${hex6(pal.accent2)}.jpg`;
}

function hdCover(url) {
  // AniList CDN sizes: small < medium < large. Always ask for the largest.
  return typeof url === 'string' ? url.replace('/cover/small/', '/cover/large/').replace('/cover/medium/', '/cover/large/') : url;
}

// Header image (banner + overlapping avatar) for painted/featured banners.
// Custom image links (incl. GIFs) are shown as-is, so they return null here.
function headerUrlFor(profile = {}, user) {
  const base = publicUrl();
  const mode = profile.bannerMode || 'theme';
  if (!base || !user || mode === 'url' || mode === 'none') return null;
  const pal = paletteFor(profile);
  const v = encodeURIComponent((user.avatar || 'default').slice(0, 40));
  const colors = `${hex6(pal.bg)}-${hex6(pal.accent)}-${hex6(pal.accent2)}`;
  const anime = mode === 'featured' && profile.featured?.mediaId ? `&anime=${Number(profile.featured.mediaId)}` : '';
  return `${base}/header/v1/${user.id}.png?c=${colors}&av=${v}${anime}`;
}

function ringUrl(mediaId, progress, total, accent) {
  const base = publicUrl();
  if (!base) return null;
  return `${base}/ring/v1/${Number(mediaId)}/${Math.max(0, progress | 0)}-${Math.max(0, total | 0)}/${hex6(accent)}.png`;
}

// giphy.com/gifs/name-ID page links → the direct GIF, so they animate.
function normalizeImageUrl(url) {
  const u = String(url || '').trim();
  const g = u.match(/^https?:\/\/(?:www\.)?giphy\.com\/gifs\/(?:[\w-]*-)?([A-Za-z0-9]+)\/?$/);
  if (g) return `https://media.giphy.com/media/${g[1]}/giphy.gif`;
  const gm = u.match(/^https?:\/\/media\d*\.giphy\.com\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9]+)\//);
  if (gm) return `https://media.giphy.com/media/${gm[1]}/giphy.gif`;
  return u;
}

function buildBannerRouter() {
  const router = express.Router();
  const sendImage = (res, buf, type) => {
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.type(type).send(buf);
  };

  router.get('/banner/:ver/theme/:colors.jpg', async (req, res) => {
    const m = String(req.params.colors).match(/^([0-9a-f]{6})-([0-9a-f]{6})-([0-9a-f]{6})$/i);
    if (!m) return res.status(400).end();
    try {
      const [bg, a, a2] = m.slice(1).map((h) => parseInt(h, 16));
      sendImage(res, await cachedBanner(`t:${m[0]}`, () => paintThemeBanner(bg, a, a2)), 'jpeg');
    } catch (e) {
      console.error('Theme banner failed:', e.message);
      res.status(500).end();
    }
  });

  router.get('/banner/:ver/anime/:id/:colors.jpg', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = String(req.params.colors).match(/^([0-9a-f]{6})-([0-9a-f]{6})$/i);
    if (!id || !m) return res.status(400).end();
    const [bg, a] = m.slice(1).map((h) => parseInt(h, 16));
    try {
      const buf = await cachedBanner(`a:${id}:${m[0]}`, async () => {
        const media = await getMediaLite(id);
        const src = media?.bannerImage || media?.coverImage?.extraLarge;
        if (!src) return paintThemeBanner(bg, a, a);
        return paintFeaturedBanner(src, bg, a);
      });
      sendImage(res, buf, 'jpeg');
    } catch (e) {
      console.error('Featured banner failed:', e.message);
      try {
        sendImage(res, await cachedBanner(`t:${hex6(bg)}-${hex6(a)}-${hex6(a)}`, () => paintThemeBanner(bg, a, a)), 'jpeg');
      } catch {
        res.status(500).end();
      }
    }
  });

  // Profile header: banner + overlapping avatar (avatar looked up from Discord).
  router.get('/header/v1/:userId.png', async (req, res) => {
    const userId = String(req.params.userId);
    const m = String(req.query.c || '').match(/^([0-9a-f]{6})-([0-9a-f]{6})-([0-9a-f]{6})$/i);
    const animeId = parseInt(req.query.anime, 10) || null;
    if (!/^\d{5,25}$/.test(userId) || !m) return res.status(400).end();
    const [bg, a, a2] = m.slice(1).map((h) => parseInt(h, 16));
    try {
      const key = `h:${userId}:${m[0]}:${animeId || ''}:${req.query.av || ''}`;
      const buf = await cachedBanner(key, async () => {
        let bannerBuf;
        if (animeId) {
          const media = await getMediaLite(animeId).catch(() => null);
          const src = media?.bannerImage || media?.coverImage?.extraLarge;
          bannerBuf = src ? await paintFeaturedBanner(src, bg, a).catch(() => null) : null;
        }
        if (!bannerBuf) bannerBuf = await cachedBanner(`t:${m[0]}`, () => paintThemeBanner(bg, a, a2));
        let avatarUrl = `https://cdn.discordapp.com/embed/avatars/0.png`;
        try {
          const { ctx } = require('./ctx');
          const user = ctx.client?.users.cache.get(userId) || (await ctx.client?.users.fetch(userId));
          if (user) avatarUrl = user.displayAvatarURL({ extension: 'png', size: 256 });
        } catch {
          /* default avatar */
        }
        return paintProfileHeader({ bannerBuf, avatarUrl, accent: a });
      });
      sendImage(res, buf, 'png');
    } catch (e) {
      console.error('Header image failed:', e.message);
      res.status(500).end();
    }
  });

  // Progress ring thumbnail for "In Rotation".
  router.get('/ring/v1/:id/:pt/:accent.png', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const pt = String(req.params.pt).match(/^(\d{1,5})-(\d{1,5})$/);
    const acc = String(req.params.accent).match(/^[0-9a-f]{6}$/i);
    if (!id || !pt || !acc) return res.status(400).end();
    try {
      const buf = await cachedBanner(`r:${id}:${pt[0]}:${acc[0]}`, async () => {
        const media = await getMediaLite(id).catch(() => null);
        const coverUrl = hdCover(media?.coverImage?.extraLarge || media?.coverImage?.large);
        return paintRing({ coverUrl, progress: Number(pt[1]), total: Number(pt[2]), accent: parseInt(acc[0], 16) });
      });
      sendImage(res, buf, 'png');
    } catch (e) {
      console.error('Ring image failed:', e.message);
      res.status(500).end();
    }
  });

  return router;
}

module.exports = {
  hdCover,
  headerUrlFor,
  ringUrl,
  normalizeImageUrl,
  paintProfileHeader,
  paintRing,
  THEMES,
  DEFAULT_THEME,
  paletteFor,
  parseHex,
  hex,
  bannerUrlFor,
  buildBannerRouter,
  paintThemeBanner,
  paintFeaturedBanner,
  publicUrl,
};
