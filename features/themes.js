const express = require('express');
const Jimp = require('jimp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { getMediaLite } = require('./anilistSocial');
const gifLib = require('./gif');

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

// Downloads an image a user pointed us at. Only public https hosts, with a
// size cap and timeout, so a banner link can't be used to poke at internal
// addresses or exhaust memory.
const MAX_DOWNLOAD = 15 * 1024 * 1024;
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function fetchUserImage(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('https only');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('blocked host');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((x) => isPrivateIp(x.address))) throw new Error('blocked address');
  const res = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'follow', headers: { 'User-Agent': 'AniTrackerBot/1.0', Accept: 'image/*' } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error(`not an image (${type || 'unknown'})`);
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD) throw new Error('image too large');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DOWNLOAD) {
      reader.cancel().catch(() => {});
      throw new Error('image too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

async function fetchBuffer(url, timeout = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

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

// Profile header: the banner with the avatar composited onto it, overlapping
// the banner's bottom-left edge. Everything below the banner is transparent,
// so the avatar sits on the card itself in light and dark Discord themes.
//
// Works for static banners (PNG out) and animated GIF banners and/or
// animated avatars (GIF out): every frame gets the avatar in exactly the
// same spot, timing follows the banner (or the avatar if only it moves).
const HEADER_BAND = 140;
const AVATAR_R = 112;
const BORDER = 9;
const GIF_SCALE = 2 / 3; // animated output is 800px wide to keep file sizes sane
const MAX_GIF_BYTES = 7.5 * 1024 * 1024;

function headerCanvas(scale) {
  const w = Math.round(W * scale);
  const h = Math.round(H * scale);
  return { w, h, band: Math.round(HEADER_BAND * scale), r: AVATAR_R * scale, border: BORDER * scale, cx: Math.round((64 + AVATAR_R) * scale) };
}

function composeFrame(bannerImg, avatarImg, scale) {
  const g = headerCanvas(scale);
  const banner = bannerImg.clone().cover(g.w, g.h);
  const img = new Jimp(g.w, g.h + g.band, 0x00000000);
  img.composite(banner, 0, 0);
  const cy = g.h;
  drawRing(img, g.cx, cy + 3 * scale, g.r + g.border + 6 * scale, 0, 0x000000, 0.18); // soft shadow
  drawRing(img, g.cx, cy, g.r + g.border, 0, 0x111214, 0.92); // subtle dark border
  if (avatarImg) drawCircle(img, avatarImg.clone(), g.cx, cy, g.r);
  else drawRing(img, g.cx, cy, g.r, 0, 0x5865f2, 1);
  return img;
}

async function paintProfileHeader({ bannerBuf, avatarBuf }) {
  const banner = await gifLib.decodeAny(bannerBuf);
  let avatar = null;
  if (avatarBuf) avatar = await gifLib.decodeAny(avatarBuf).catch(() => null);
  const animated = banner.frames.length > 1 || (avatar && avatar.frames.length > 1);

  if (!animated) {
    const img = composeFrame(gifLib.frameToJimp(banner, banner.frames[0]), avatar ? gifLib.frameToJimp(avatar, avatar.frames[0]) : null, 1);
    return { buf: await img.getBufferAsync(Jimp.MIME_PNG), type: 'png' };
  }

  // Animated: follow the banner's timeline, or the avatar's if the banner is static.
  const driver = banner.frames.length > 1 ? banner : avatar;
  const avatarCache = new Map();
  const avatarFrame = (t) => {
    if (!avatar) return null;
    const i = gifLib.frameAt(avatar, t);
    if (!avatarCache.has(i)) avatarCache.set(i, gifLib.frameToJimp(avatar, avatar.frames[i]));
    return avatarCache.get(i);
  };
  const staticBanner = banner.frames.length === 1 ? gifLib.frameToJimp(banner, banner.frames[0]) : null;

  for (const scale of [GIF_SCALE, 0.5]) {
    const out = [];
    let t = 0;
    for (let i = 0; i < driver.frames.length; i++) {
      const f = driver.frames[i];
      const bImg = staticBanner || gifLib.frameToJimp(banner, banner.frames[i]);
      out.push({ image: composeFrame(bImg, avatarFrame(t), scale), delay: f.delay || 100 });
      t += f.delay || 100;
    }
    const buf = await gifLib.encodeAnimation(out);
    if (buf.length <= MAX_GIF_BYTES || scale === 0.5) return { buf, type: 'gif' };
  }
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

// Progress bar for In Rotation: rounded track, continuous accent fill, and
// three faint checkpoint ticks at 25 / 50 / 75 %.
function roundedRect(img, x0, y0, w, h, r, color, alpha = 1) {
  const D = img.bitmap;
  const [cr, cg, cb] = rgb(color);
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(D.height, Math.ceil(y0 + h)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(D.width, Math.ceil(x0 + w)); x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const qx = Math.max(x0 + r - px, 0, px - (x0 + w - r));
      const qy = Math.max(y0 + r - py, 0, py - (y0 + h - r));
      const d = Math.hypot(qx, qy) - r; // signed distance to the rounded rect
      let a = Math.max(0, Math.min(1, 0.5 - d)) * Math.max(0, Math.min(1, px - x0 + 0.5)) * Math.max(0, Math.min(1, x0 + w - px + 0.5));
      if (a <= 0) continue;
      a *= alpha;
      const i = (y * D.width + x) * 4;
      const da = D.data[i + 3] / 255;
      const oa = a + da * (1 - a);
      D.data[i] = clamp((cr * a + D.data[i] * da * (1 - a)) / oa);
      D.data[i + 1] = clamp((cg * a + D.data[i + 1] * da * (1 - a)) / oa);
      D.data[i + 2] = clamp((cb * a + D.data[i + 2] * da * (1 - a)) / oa);
      D.data[i + 3] = clamp(oa * 255);
    }
  }
}

const BAR_W = 1200;
const BAR_H = 30;
async function paintBar({ progress, total, accent }) {
  const img = new Jimp(BAR_W, BAR_H, 0x00000000);
  const r = BAR_H / 2;
  const pct = total > 0 ? Math.max(0, Math.min(1, progress / total)) : 0;
  roundedRect(img, 0, 0, BAR_W, BAR_H, r, 0x80848e, 0.32); // muted track
  if (pct > 0) roundedRect(img, 0, 0, Math.max(BAR_H, BAR_W * pct), BAR_H, r, accent, 1); // continuous fill
  for (const c of [0.25, 0.5, 0.75]) {
    const x = BAR_W * c;
    const onFill = c <= pct;
    roundedRect(img, x - 2, BAR_H * 0.3, 4, BAR_H * 0.4, 2, onFill ? 0xffffff : 0xb5bac1, onFill ? 0.45 : 0.55); // small checkpoint tick
  }
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// Favorites collage from banner art: 1 → full width; 2 → side by side;
// 3 → two on top, one full-width below. Rounded tiles, transparent gaps.
const COLLAGE_GAP = 14;
const TILE_R = 20;
async function bannerArt(mediaId) {
  const m = await getMediaLite(mediaId).catch(() => null);
  if (!m) return null;
  if (m.bannerImage) return { img: await fetchImage(m.bannerImage), focusY: 0.42 };
  const cover = m.coverImage?.extraLarge || m.coverImage?.large;
  return cover ? { img: await fetchImage(cover), focusY: 0.28 } : null; // portrait fallback: keep faces (upper third)
}

function coverCrop(src, w, h, focusY) {
  const s = Math.max(w / src.bitmap.width, h / src.bitmap.height);
  const img = src.clone().resize(Math.ceil(src.bitmap.width * s), Math.ceil(src.bitmap.height * s));
  const x = Math.round((img.bitmap.width - w) / 2);
  const y = Math.round(Math.max(0, Math.min(img.bitmap.height - h, img.bitmap.height * focusY - h / 2)));
  return img.crop(x, y, w, h);
}

function maskRounded(tile, r) {
  const D = tile.bitmap;
  for (let y = 0; y < D.height; y++) {
    for (let x = 0; x < D.width; x++) {
      const qx = Math.max(r - (x + 0.5), 0, x + 0.5 - (D.width - r));
      const qy = Math.max(r - (y + 0.5), 0, y + 0.5 - (D.height - r));
      if (!qx && !qy) continue;
      const a = Math.max(0, Math.min(1, 0.5 - (Math.hypot(qx, qy) - r)));
      D.data[(y * D.width + x) * 4 + 3] *= a;
    }
  }
  return tile;
}

async function paintCollage(ids) {
  const arts = (await Promise.all(ids.slice(0, 3).map((id) => bannerArt(id).catch(() => null)))).filter(Boolean);
  if (!arts.length) throw new Error('no artwork');
  const half = (W - COLLAGE_GAP) / 2;
  let tiles;
  if (arts.length === 1) tiles = [{ x: 0, y: 0, w: W, h: 300 }];
  else if (arts.length === 2) tiles = [{ x: 0, y: 0, w: half, h: 200 }, { x: half + COLLAGE_GAP, y: 0, w: half, h: 200 }];
  else tiles = [{ x: 0, y: 0, w: half, h: 190 }, { x: half + COLLAGE_GAP, y: 0, w: half, h: 190 }, { x: 0, y: 190 + COLLAGE_GAP, w: W, h: 260 }];
  const height = Math.max(...tiles.map((t) => t.y + t.h));
  const out = new Jimp(W, height, 0x00000000);
  tiles.forEach((t, i) => {
    const tile = maskRounded(coverCrop(arts[i].img, Math.round(t.w), Math.round(t.h), arts[i].focusY), TILE_R);
    out.composite(tile, Math.round(t.x), Math.round(t.y));
  });
  return out.getBufferAsync(Jimp.MIME_PNG);
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
      cacheBytes += buf.length || buf.buf?.length || 0;
      // bounded by count AND total size (header PNGs can be a few hundred KB)
      while (bannerCache.size > MAX_BANNERS || cacheBytes > MAX_CACHE_BYTES) {
        const k = bannerCache.keys().next().value;
        const v = bannerCache.get(k);
        cacheBytes -= v.length || v.buf?.length || 0;
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

// Header image: banner + avatar composited into ONE image, for every banner
// style (painted, featured anime, or the user's own image / GIF).
function headerUrlFor(profile = {}, user) {
  const base = publicUrl();
  const mode = profile.bannerMode || 'theme';
  if (!base || !user || mode === 'none') return null;
  const pal = paletteFor(profile);
  const av = encodeURIComponent((user.avatar || 'default').slice(0, 40));
  const colors = `${hex6(pal.bg)}-${hex6(pal.accent)}-${hex6(pal.accent2)}`;
  let extra = '';
  let animated = Boolean(user.avatar && user.avatar.startsWith('a_'));
  if (mode === 'featured' && profile.featured?.mediaId) extra = `&anime=${Number(profile.featured.mediaId)}`;
  if (mode === 'url' && /^https:\/\/\S+$/i.test(profile.bannerUrl || '')) {
    extra = `&u=${Buffer.from(profile.bannerUrl).toString('base64url')}`;
    if (/\.gif(\?|$)/i.test(profile.bannerUrl) || /giphy\.com/i.test(profile.bannerUrl)) animated = true;
  }
  return `${base}/header/v2/${user.id}.${animated ? 'gif' : 'png'}?c=${colors}&av=${av}${extra}`;
}

function barUrl(progress, total, accent) {
  const base = publicUrl();
  if (!base || !(total > 0)) return null;
  return `${base}/bar/v1/${Math.min(Math.max(0, progress | 0), total | 0)}-${total | 0}/${hex6(accent)}.png`;
}

function collageUrl(mediaIds) {
  const base = publicUrl();
  const ids = mediaIds.filter(Boolean).slice(0, 3).map(Number);
  if (!base || !ids.length) return null;
  return `${base}/collage/v1/${ids.join('-')}.png`;
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

// Generated headers are also kept on disk (GIFs are expensive), so a
// re-view or a restart without redeploy doesn't redo the work.
const DISK_DIR = path.join(os.tmpdir(), 'anitracker-art');
function diskGet(key) {
  try {
    const h = crypto.createHash('sha1').update(key).digest('hex');
    for (const type of ['gif', 'png']) {
      const f = path.join(DISK_DIR, `${h}.${type}`);
      if (fs.existsSync(f)) return { buf: fs.readFileSync(f), type };
    }
  } catch {
    /* ignore */
  }
  return null;
}
function diskPut(key, out) {
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    const h = crypto.createHash('sha1').update(key).digest('hex');
    fs.writeFileSync(path.join(DISK_DIR, `${h}.${out.type}`), out.buf);
  } catch {
    /* ignore */
  }
}

async function avatarBufferFor(userId) {
  try {
    const { ctx } = require('./ctx');
    const user = ctx.client?.users.cache.get(userId) || (await ctx.client?.users.fetch(userId));
    if (user) {
      const animated = user.avatar && user.avatar.startsWith('a_');
      return await fetchBuffer(user.displayAvatarURL({ extension: animated ? 'gif' : 'png', forceStatic: !animated, size: 256 }));
    }
  } catch {
    /* fall through */
  }
  return fetchBuffer('https://cdn.discordapp.com/embed/avatars/0.png').catch(() => null);
}

// Regenerates only when the inputs change (banner source, colours, avatar).
function renderHeader({ userId, bg, a, a2, colors, animeId, customUrl, avatarKey }) {
  const key = `hdr:${userId}:${colors}:${animeId || ''}:${customUrl || ''}:${avatarKey}`;
  return cachedBanner(key, async () => {
    const fromDisk = diskGet(key);
    if (fromDisk) return fromDisk;
    let bannerBuf = null;
    if (customUrl) {
      try {
        bannerBuf = await fetchUserImage(customUrl);
      } catch (e) {
        console.warn(`Custom banner unusable (${e.message}) — falling back to theme art`);
      }
    }
    if (!bannerBuf && animeId) {
      const media = await getMediaLite(animeId).catch(() => null);
      const src = media?.bannerImage || media?.coverImage?.extraLarge;
      bannerBuf = src ? await paintFeaturedBanner(src, bg, a).catch(() => null) : null;
    }
    if (!bannerBuf) bannerBuf = await cachedBanner(`t:${colors}`, () => paintThemeBanner(bg, a, a2));
    const avatarBuf = await avatarBufferFor(userId);
    let out;
    try {
      out = await paintProfileHeader({ bannerBuf, avatarBuf });
    } catch (e) {
      // e.g. a broken/huge GIF: fall back to a still of the theme art
      console.warn('Header compositing failed, using fallback:', e.message);
      out = await paintProfileHeader({ bannerBuf: await cachedBanner(`t:${colors}`, () => paintThemeBanner(bg, a, a2)), avatarBuf: avatarBuf && !gifLib.isGif(avatarBuf) ? avatarBuf : null });
    }
    diskPut(key, out);
    return out;
  });
}

// Start building someone's header before Discord asks for it (big GIFs can
// take a few seconds) — called when a profile is opened or settings saved.
function warmHeader(profile, user) {
  const url = headerUrlFor(profile, user);
  if (!url) return;
  try {
    const q = new URL(url);
    const m = (q.searchParams.get('c') || '').match(/^([0-9a-f]{6})-([0-9a-f]{6})-([0-9a-f]{6})$/i);
    if (!m) return;
    const [bg, a, a2] = m.slice(1).map((h) => parseInt(h, 16));
    const u = q.searchParams.get('u');
    renderHeader({
      userId: user.id,
      bg,
      a,
      a2,
      colors: m[0],
      animeId: parseInt(q.searchParams.get('anime'), 10) || null,
      customUrl: u ? Buffer.from(u, 'base64url').toString('utf8') : null,
      avatarKey: q.searchParams.get('av') || '',
    }).catch(() => {});
  } catch {
    /* ignore */
  }
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

  // Profile header: banner + avatar composited into one image (PNG, or an
  // animated GIF when the banner and/or avatar is animated).
  const headerHandler = async (req, res) => {
    const userId = String(req.params.userId);
    const m = String(req.query.c || '').match(/^([0-9a-f]{6})-([0-9a-f]{6})-([0-9a-f]{6})$/i);
    const animeId = parseInt(req.query.anime, 10) || null;
    let customUrl = null;
    if (req.query.u) {
      try {
        customUrl = Buffer.from(String(req.query.u), 'base64url').toString('utf8');
      } catch {
        customUrl = null;
      }
    }
    if (!/^\d{5,25}$/.test(userId) || !m) return res.status(400).end();
    const [bg, a, a2] = m.slice(1).map((h) => parseInt(h, 16));
    try {
      const out = await renderHeader({ userId, bg, a, a2, colors: m[0], animeId, customUrl, avatarKey: String(req.query.av || '') });
      sendImage(res, out.buf, out.type === 'gif' ? 'gif' : 'png');
    } catch (e) {
      console.error('Header image failed:', e.message);
      res.status(500).end();
    }
  };
  router.get('/header/v1/:userId.png', headerHandler);
  router.get('/header/v2/:userId.:ext', headerHandler);

  router.get('/bar/v1/:pt/:accent.png', async (req, res) => {
    const pt = String(req.params.pt).match(/^(\d{1,5})-(\d{1,5})$/);
    const acc = String(req.params.accent).match(/^[0-9a-f]{6}$/i);
    if (!pt || !acc || Number(pt[2]) === 0) return res.status(400).end();
    try {
      const buf = await cachedBanner(`bar:${pt[0]}:${acc[0]}`, () => paintBar({ progress: Number(pt[1]), total: Number(pt[2]), accent: parseInt(acc[0], 16) }));
      sendImage(res, buf, 'png');
    } catch (e) {
      console.error('Bar image failed:', e.message);
      res.status(500).end();
    }
  });

  router.get('/collage/v1/:ids.png', async (req, res) => {
    const ids = String(req.params.ids)
      .split('-')
      .map((x) => parseInt(x, 10))
      .filter((x) => x > 0)
      .slice(0, 3);
    if (!ids.length) return res.status(400).end();
    try {
      const buf = await cachedBanner(`col:${ids.join('-')}`, () => paintCollage(ids));
      sendImage(res, buf, 'png');
    } catch (e) {
      console.error('Collage failed:', e.message);
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
  barUrl,
  collageUrl,
  warmHeader,
  fetchUserImage,
  paintBar,
  paintCollage,
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
