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

/* -------------------------- serving + caching -------------------------- */

const bannerCache = new Map(); // key -> Buffer
const inflight = new Map();
const MAX_BANNERS = 40;

async function cachedBanner(key, paint) {
  if (bannerCache.has(key)) return bannerCache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = paint()
    .then((buf) => {
      bannerCache.set(key, buf);
      if (bannerCache.size > MAX_BANNERS) bannerCache.delete(bannerCache.keys().next().value);
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

  return router;
}

module.exports = {
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
