/* ---------------------------------------------------------------------------
 * Images with real text: the profile "In Rotation" cards and leaderboard
 * boards. Uses @napi-rs/canvas (prebuilt, no system libraries) with
 * Montserrat bundled in assets/fonts, so it renders the same on Render.
 *
 *  Rotation card (one per show, 3–4 in a row):
 *        ╭──────╮
 *       │ cover │   ← progress ring in the cover's own colour
 *        ╰──────╯
 *     Cyberpunk: Edgerunners
 *        [▭] S1 | [≋] 3 / 10
 *          ( ▶ Watching )
 *
 *  Leaderboard: one row per person — rank badge, AniList avatar, name, a
 *  progress bar against the leader, the value, and a small detail line.
 * ------------------------------------------------------------------------- */

const path = require('path');

let canvasLib = null;
function lib() {
  if (canvasLib !== null) return canvasLib;
  try {
    canvasLib = require('@napi-rs/canvas');
    const dir = path.join(__dirname, '..', 'assets', 'fonts');
    for (const f of ['Montserrat_500Medium.ttf', 'Montserrat_600SemiBold.ttf', 'Montserrat_700Bold.ttf', 'Montserrat_800ExtraBold.ttf']) {
      canvasLib.GlobalFonts.registerFromPath(path.join(dir, f), 'Montserrat');
    }
  } catch (e) {
    console.warn('Canvas unavailable — image cards fall back to text:', e.message);
    canvasLib = false;
  }
  return canvasLib;
}
const available = () => Boolean(lib());

const FONT = 'Montserrat, sans-serif';
const f = (weight, size) => `${weight} ${Math.round(size)}px ${FONT}`;

/* --------------------------------- colour -------------------------------- */

const rgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const css = (n, a = 1) => {
  const [r, g, b] = rgb(n);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
};
const mix = (a, b, t) => {
  const A = rgb(a);
  const B = rgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return (c[0] << 16) | (c[1] << 8) | c[2];
};
function lum(n) {
  const [r, g, b] = rgb(n).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Make an accent bright enough to read on a dark card.
function vivid(n) {
  let c = n;
  for (let i = 0; i < 6 && lum(c) < 0.18; i++) c = mix(c, 0xffffff, 0.22);
  return c;
}

const STATUS = {
  CURRENT: { label: 'Watching', color: 0x3ddc84 },
  REPEATING: { label: 'Rewatching', color: 0xa78bfa },
  PAUSED: { label: 'Paused', color: 0xfbbf24 },
  COMPLETED: { label: 'Completed', color: 0x60a5fa },
  PLANNING: { label: 'Planning', color: 0x94a3b8 },
  DROPPED: { label: 'Dropped', color: 0xf87171 },
  MANUAL: { label: 'In rotation', color: 0x94a3b8 },
};

// Text the bundled font can draw: drops emoji, and falls back when a name is
// mostly in a script Montserrat doesn't have (CJK, Arabic…), so nothing
// renders as empty boxes.
function safeText(s, fallback = '') {
  const t = String(s || '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const unsupported = [...t].filter((ch) => !/[\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF]/u.test(ch)).length;
  if (!t || unsupported > t.length / 3) return fallback ? safeText(fallback) : t.replace(/[^\u0000-\u024F\u2000-\u206F]/gu, '') || '?';
  return t.replace(/[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF]/gu, '');
}

/* --------------------------------- images -------------------------------- */

const imgCache = new Map(); // url -> Image (small LRU)
let misses = 0; // images that could not be loaded (artRoutes uses this to avoid caching a broken card)
const missCount = () => misses;

// Decode with canvas; if that fails (odd JPEG/GIF/WebP variants), convert
// through Jimp first.
async function decode(buf) {
  try {
    return await lib().loadImage(buf);
  } catch {
    const Jimp = require('jimp');
    const img = await Jimp.read(buf);
    return lib().loadImage(await img.getBufferAsync(Jimp.MIME_PNG));
  }
}

async function loadOne(url, timeout) {
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (imgCache.has(url)) return imgCache.get(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'AniTracker (Discord bot)', Accept: 'image/*' }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 404 || res.status === 403) return null; // gone: no point retrying
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 15 * 1024 * 1024) return null;
      const img = await decode(buf);
      imgCache.set(url, img);
      if (imgCache.size > 120) imgCache.delete(imgCache.keys().next().value);
      return img;
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

// First image that loads from a list of candidates (e.g. extraLarge → large
// → medium → banner), so one bad URL never leaves a blank circle.
async function loadRemote(urls, timeout = 10000) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  for (const u of [...new Set(list)]) {
    const img = await loadOne(u, timeout);
    if (img) return img;
  }
  if (list.length) misses++;
  return null;
}

/* -------------------------------- drawing -------------------------------- */

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// Image cropped to fill a circle (or rounded rect), focus a bit above centre.
function drawCover(c, img, x, y, w, h, { circle = false, radius = 0, focusY = 0.35 } = {}) {
  c.save();
  if (circle) {
    c.beginPath();
    c.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
    c.closePath();
  } else roundRect(c, x, y, w, h, radius);
  c.clip();
  if (img) {
    const s = Math.max(w / img.width, h / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    const dx = x + (w - dw) / 2;
    const dy = y + Math.max(h - dh, Math.min(0, h / 2 - dh * focusY));
    c.drawImage(img, dx, dy, dw, dh);
  } else {
    c.fillStyle = '#2b2d31';
    c.fillRect(x, y, w, h);
  }
  c.restore();
}

function ellipsize(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

// Up to `maxLines` lines, last one ellipsized.
function wrap(c, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (c.measureText(next).width <= maxW) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines - 1) {
      cur = words.slice(i).join(' ');
      break;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  lines[lines.length - 1] = ellipsize(c, lines[lines.length - 1] || '', maxW);
  return lines;
}

// Small line icons (stroke), sized `s`, top-left at x,y.
function iconScreen(c, x, y, s, color) {
  c.save();
  c.strokeStyle = color;
  c.lineWidth = s * 0.11;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  roundRect(c, x + s * 0.05, y + s * 0.12, s * 0.9, s * 0.6, s * 0.1);
  c.stroke();
  c.beginPath();
  c.moveTo(x + s * 0.3, y + s * 0.9);
  c.lineTo(x + s * 0.7, y + s * 0.9);
  c.moveTo(x + s * 0.5, y + s * 0.72);
  c.lineTo(x + s * 0.5, y + s * 0.9);
  c.stroke();
  c.restore();
}
function iconLayers(c, x, y, s, color) {
  c.save();
  c.strokeStyle = color;
  c.lineWidth = s * 0.1;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const dia = (yy) => {
    c.beginPath();
    c.moveTo(x + s * 0.5, yy);
    c.lineTo(x + s * 0.95, yy + s * 0.22);
    c.lineTo(x + s * 0.5, yy + s * 0.44);
    c.lineTo(x + s * 0.05, yy + s * 0.22);
    c.closePath();
    c.stroke();
  };
  dia(y + s * 0.05);
  c.beginPath();
  c.moveTo(x + s * 0.05, y + s * 0.5);
  c.lineTo(x + s * 0.5, y + s * 0.72);
  c.lineTo(x + s * 0.95, y + s * 0.5);
  c.moveTo(x + s * 0.05, y + s * 0.72);
  c.lineTo(x + s * 0.5, y + s * 0.94);
  c.lineTo(x + s * 0.95, y + s * 0.72);
  c.stroke();
  c.restore();
}
function iconPlay(c, x, y, s, color) {
  c.save();
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x + s * 0.15, y + s * 0.08);
  c.lineTo(x + s * 0.92, y + s * 0.5);
  c.lineTo(x + s * 0.15, y + s * 0.92);
  c.closePath();
  c.fill();
  c.restore();
}
function iconPause(c, x, y, s, color) {
  c.save();
  c.fillStyle = color;
  roundRect(c, x + s * 0.15, y + s * 0.1, s * 0.25, s * 0.8, s * 0.06);
  c.fill();
  roundRect(c, x + s * 0.6, y + s * 0.1, s * 0.25, s * 0.8, s * 0.06);
  c.fill();
  c.restore();
}
function iconRepeat(c, x, y, s, color) {
  c.save();
  c.strokeStyle = color;
  c.lineWidth = s * 0.13;
  c.lineCap = 'round';
  c.beginPath();
  c.arc(x + s / 2, y + s / 2, s * 0.36, Math.PI * 0.15, Math.PI * 1.75);
  c.stroke();
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x + s * 0.95, y + s * 0.18);
  c.lineTo(x + s * 0.95, y + s * 0.52);
  c.lineTo(x + s * 0.62, y + s * 0.4);
  c.closePath();
  c.fill();
  c.restore();
}

// A pill with optional leading icon. Returns its width (draw=false to measure).
function pill(c, x, y, { text, h, font, fg, bg, border, icon, draw = true }) {
  c.font = font;
  const padX = h * 0.48;
  const iconS = icon ? h * 0.46 : 0;
  const gap = icon ? h * 0.26 : 0;
  const w = padX * 2 + iconS + gap + c.measureText(text).width;
  if (!draw) return w;
  roundRect(c, x, y, w, h, h / 2);
  if (bg) {
    c.fillStyle = bg;
    c.fill();
  }
  if (border) {
    c.lineWidth = Math.max(2, h * 0.06);
    c.strokeStyle = border;
    c.stroke();
  }
  if (icon) icon(c, x + padX, y + (h - iconS) / 2, iconS, fg);
  c.fillStyle = fg;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillText(text, x + padX + iconS + gap, y + h / 2 + h * 0.03);
  return w;
}

/* ------------------------------ rotation row ------------------------------ */

/**
 * @param items [{ title, cover, progress, total, aired, status, season, format, tags[], accent }]
 *   season: number|null · format: 'TV'|'MOVIE'|… · status: CURRENT|REPEATING|PAUSED|MANUAL
 * @returns PNG buffer
 */
async function paintRotation(items, { cardW = 460, gap = 26 } = {}) {
  const { createCanvas } = lib();
  const n = Math.max(1, items.length);
  const CW = cardW;
  const pad = CW * 0.075;
  const ringR = CW * 0.33;
  const ringW = CW * 0.045;
  const titleSize = CW * 0.088;
  const metaSize = CW * 0.07;
  const pillH = CW * 0.12;
  const tagSize = CW * 0.058;
  const tagH = CW * 0.106;
  const ringTop = pad * 1.1;
  const titleTop = ringTop + ringR * 2 + CW * 0.07;
  const titleLineH = titleSize * 1.22;
  const metaTop = titleTop + titleLineH * 2 + CW * 0.035;
  const tagTop = metaTop + pillH + CW * 0.055;
  const CH = Math.round(tagTop + tagH * 1.12 + pad * 0.6);
  const W = n * CW + (n - 1) * gap;

  const canvas = createCanvas(W, CH);
  const c = canvas.getContext('2d');
  const covers = await Promise.all(items.map((it) => loadRemote([].concat(it.cover || []))));

  items.forEach((it, i) => {
    const x0 = i * (CW + gap);
    const accent = vivid(typeof it.accent === 'number' ? it.accent : 0x3db4f2);
    const st = STATUS[it.status] || STATUS.CURRENT;

    // No card background: transparent, so it sits on the profile itself.

    // Progress ring + cover.
    const cx = x0 + CW / 2;
    const cy = ringTop + ringR;
    const pct = it.progress !== null && it.total > 0 ? Math.max(0, Math.min(1, it.progress / it.total)) : it.progress !== null && it.aired > 0 ? Math.max(0, Math.min(1, it.progress / it.aired)) : 0;
    c.lineCap = 'butt';
    c.lineWidth = ringW;
    c.strokeStyle = '#2a2c31';
    c.beginPath();
    c.arc(cx, cy, ringR - ringW / 2, 0, Math.PI * 2);
    c.stroke();
    if (pct > 0) {
      c.strokeStyle = css(accent);
      c.beginPath();
      c.arc(cx, cy, ringR - ringW / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
      c.stroke();
    }
    const coverR = ringR - ringW - CW * 0.03;
    c.fillStyle = '#000';
    c.beginPath();
    c.arc(cx, cy, ringR - ringW, 0, Math.PI * 2);
    c.fill();
    drawCover(c, covers[i], cx - coverR, cy - coverR, coverR * 2, coverR * 2, { circle: true, focusY: 0.3 });

    // Title (2 lines max), centred.
    c.font = f(700, titleSize);
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const lines = wrap(c, safeText(it.title, it.titleRomaji) || 'Untitled', CW - pad * 2, 2);
    const block = lines.length * titleLineH;
    const startY = titleTop + (titleLineH * 2 - block) / 2 + titleSize * 0.95;
    lines.forEach((l, k) => c.fillText(l, cx, startY + k * titleLineH));

    // Meta row: [screen] S1 | [layers] 3 / 10
    const seasonText = it.format && !['TV', 'TV_SHORT'].includes(it.format) ? (it.format === 'MOVIE' ? 'Movie' : it.format.replace('_', ' ')) : `S${it.season || 1}`;
    const progText = it.progress === null ? '—' : it.total ? `${Math.min(it.progress, it.total)} / ${it.total}` : `${it.progress} / ?`;
    let scale = 1;
    const measure = (k) => {
      c.font = f(600, metaSize * k);
      const iconS = metaSize * 1.05 * k;
      const sep = metaSize * 0.9 * k;
      const a = iconS + metaSize * 0.4 * k + c.measureText(seasonText).width;
      const b = iconS + metaSize * 0.4 * k + c.measureText(progText).width;
      return { a, b, sep, iconS, total: a + sep * 2 + b };
    };
    let m = measure(1);
    while (m.total > CW - pad * 1.2 && scale > 0.6) {
      scale -= 0.05;
      m = measure(scale);
    }
    let x = cx - m.total / 2;
    const midY = metaTop + pillH / 2;
    const textCol = '#d9dbe0';
    const drawPart = (icon, text) => {
      icon(c, x, midY - m.iconS / 2, m.iconS, textCol);
      x += m.iconS + metaSize * 0.4 * scale;
      c.font = f(600, metaSize * scale);
      c.fillStyle = textCol;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(text, x, midY + metaSize * 0.05);
      x += c.measureText(text).width;
    };
    drawPart(iconScreen, seasonText);
    x += m.sep;
    c.fillStyle = '#4a4d55';
    c.fillRect(x - 1, midY - metaSize * 0.75 * scale, 2, metaSize * 1.5 * scale);
    x += m.sep;
    drawPart(iconLayers, progText);

    // Status pill (Watching / Rewatching / Paused) underneath, centred.
    const statusIcon = it.status === 'PAUSED' ? iconPause : it.status === 'REPEATING' ? iconRepeat : iconPlay;
    const spH = tagH * 1.12;
    const spFont = f(700, tagSize * 1.12);
    const spW = pill(c, 0, 0, { text: st.label, h: spH, font: spFont, icon: statusIcon, draw: false });
    pill(c, cx - spW / 2, tagTop, { text: st.label, h: spH, font: spFont, fg: css(st.color), bg: css(st.color, 0.12), border: css(st.color, 0.9), icon: statusIcon });
  });

  return canvas.toBuffer('image/png');
}

/* ------------------------------- leaderboard ------------------------------- */

const MEDAL = [0xf5c542, 0xc0c7d1, 0xd38b4d];

/**
 * @param o.title     "Episodes this month"
 * @param o.subtitle  small line under the title
 * @param o.accent    colour
 * @param o.unit      "eps"
 * @param o.rows      [{ name, avatar, value, detail }]
 * @returns PNG buffer
 */
async function paintLeaderboard({ title, subtitle, accent = 0x3db4f2, unit = '', rows }) {
  const { createCanvas } = lib();
  const W = 1200;
  const pad = 40;
  const headH = 172;
  const rowH = 126;
  const gapR = 14;
  const H = headH + rows.length * (rowH + gapR) - (rows.length ? gapR : 0) + pad;
  const canvas = createCanvas(W, Math.max(H, headH + pad));
  const c = canvas.getContext('2d');
  const acc = vivid(accent);
  const avatars = await Promise.all(rows.map((r) => loadRemote(r.avatar)));

  // Background panel.
  roundRect(c, 1, 1, W - 2, canvas.height - 2, 36);
  const bg = c.createLinearGradient(0, 0, W, canvas.height);
  bg.addColorStop(0, css(mix(0x0c0d12, acc, 0.18)));
  bg.addColorStop(1, '#0a0b0f');
  c.fillStyle = bg;
  c.fill();

  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = css(acc);
  c.font = f(700, 26);
  c.fillText('LEADERBOARD', pad, 58);
  c.fillStyle = '#ffffff';
  c.font = f(800, 46);
  c.fillText(ellipsize(c, safeText(title), W - pad * 2), pad, 108);
  if (subtitle) {
    c.fillStyle = '#9ca0aa';
    c.font = f(500, 24);
    c.fillText(ellipsize(c, safeText(subtitle), W - pad * 2), pad, 142);
  }

  const max = rows[0]?.value || 1;
  rows.forEach((r, i) => {
    const y = headH + i * (rowH + gapR);
    const top3 = i < 3;
    roundRect(c, pad, y, W - pad * 2, rowH, 26);
    c.fillStyle = top3 ? css(mix(0x15171d, MEDAL[i], 0.08)) : '#14161b';
    c.fill();
    if (top3) {
      c.lineWidth = 2;
      c.strokeStyle = css(MEDAL[i], 0.45);
      c.stroke();
    }

    // Rank badge.
    const bx = pad + 56;
    const by = y + rowH / 2;
    c.beginPath();
    c.arc(bx, by, 28, 0, Math.PI * 2);
    c.fillStyle = top3 ? css(MEDAL[i]) : '#24262d';
    c.fill();
    c.fillStyle = top3 ? '#15120a' : '#c9ccd3';
    c.font = f(800, 26);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(i + 1), bx, by + 1);

    // Avatar.
    const ar = 38;
    const ax = pad + 112;
    c.beginPath();
    c.arc(ax + ar, by, ar + 4, 0, Math.PI * 2);
    c.fillStyle = top3 ? css(MEDAL[i], 0.9) : '#2c2f37';
    c.fill();
    drawCover(c, avatars[i], ax, by - ar, ar * 2, ar * 2, { circle: true, focusY: 0.5 });

    // Name + detail.
    const tx = ax + ar * 2 + 26;
    const valueW = 230;
    const textW = W - pad * 2 - (tx - pad) - valueW - 20;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#ffffff';
    c.font = f(700, 34);
    c.fillText(ellipsize(c, safeText(r.name, r.fallbackName) || 'Someone', textW), tx, y + 50);
    if (r.detail) {
      c.fillStyle = '#9ca0aa';
      c.font = f(500, 24);
      c.fillText(ellipsize(c, safeText(r.detail), textW), tx, y + 80);
    }

    // Progress bar vs the leader.
    const barY = y + rowH - 30;
    const barW = textW;
    roundRect(c, tx, barY, barW, 12, 6);
    c.fillStyle = '#272a31';
    c.fill();
    const pct = Math.max(0.03, Math.min(1, r.value / max));
    roundRect(c, tx, barY, barW * pct, 12, 6);
    const g = c.createLinearGradient(tx, 0, tx + barW, 0);
    g.addColorStop(0, css(top3 ? MEDAL[i] : acc));
    g.addColorStop(1, css(mix(top3 ? MEDAL[i] : acc, 0xffffff, 0.25)));
    c.fillStyle = g;
    c.fill();

    // Value.
    c.textAlign = 'right';
    c.fillStyle = '#ffffff';
    c.font = f(800, 40);
    const vx = W - pad - 30;
    c.fillText(r.valueText || String(r.value), vx, y + 62);
    c.fillStyle = '#9ca0aa';
    c.font = f(600, 20);
    c.fillText(unit.toUpperCase(), vx, y + 90);
  });

  if (!rows.length) {
    c.fillStyle = '#9ca0aa';
    c.font = f(600, 28);
    c.textAlign = 'left';
    c.fillText('Nobody on the board yet — get watching!', pad, headH + 20);
  }
  return canvas.toBuffer('image/png');
}

/* ------------------------------- banner list ------------------------------ */

/**
 * Anime listed as wide banner strips: rank, title and a detail line on a dark
 * fade over the show's AniList banner (or its cover when it has none).
 * @param items [{ title, banner, cover, detail, accent }]
 */
async function paintBannerList(items, { label = null } = {}) {
  const { createCanvas } = lib();
  const W = 1200;
  const rowH = 168;
  const gap = 14;
  const labelH = label ? 58 : 0;
  const H = labelH + items.length * (rowH + gap) - gap;
  const canvas = createCanvas(W, Math.max(H, 10));
  const c = canvas.getContext('2d');
  const imgs = await Promise.all(
    items.map(async (it) => {
      const b = it.banner ? await loadRemote([it.banner]) : null;
      if (b) return { img: b, isBanner: true };
      return { img: await loadRemote([].concat(it.cover || [])), isBanner: false };
    })
  );
  if (label) {
    c.fillStyle = '#9ca0aa';
    c.font = f(700, 26);
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillText(safeText(label).toUpperCase(), 6, 36);
  }
  items.forEach((it, i) => {
    const y = labelH + i * (rowH + gap);
    const accent = vivid(typeof it.accent === 'number' ? it.accent : 0x3db4f2);
    const { img, isBanner } = imgs[i];
    drawCover(c, img, 0, y, W, rowH, { radius: 26, focusY: isBanner ? 0.45 : 0.25 });
    c.save();
    roundRect(c, 0, y, W, rowH, 26);
    c.clip();
    const fade = c.createLinearGradient(0, 0, W, 0);
    fade.addColorStop(0, 'rgba(8,9,12,0.94)');
    fade.addColorStop(0.45, 'rgba(8,9,12,0.78)');
    fade.addColorStop(1, isBanner ? 'rgba(8,9,12,0.12)' : 'rgba(8,9,12,0.55)');
    c.fillStyle = fade;
    c.fillRect(0, y, W, rowH);
    c.fillStyle = css(accent);
    c.fillRect(0, y, 10, rowH);
    c.restore();

    const rank = it.rank ?? i + 1;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'center';
    c.fillStyle = css(accent);
    c.font = f(800, 56);
    c.fillText(String(rank), 70, y + rowH / 2 + 20);
    c.textAlign = 'left';
    c.fillStyle = '#ffffff';
    c.font = f(700, 40);
    const tx = 130;
    c.fillText(ellipsize(c, safeText(it.title, it.titleRomaji) || 'Unknown title', W * 0.7), tx, y + (it.detail ? 76 : 98));
    if (it.detail) {
      c.fillStyle = '#d0d3d9';
      c.font = f(600, 26);
      c.fillText(ellipsize(c, safeText(it.detail), W * 0.7), tx, y + 118);
    }
  });
  return canvas.toBuffer('image/png');
}

/* -------------------------------- favorites -------------------------------- */

// Four-point sparkle (✦), drawn so it never depends on the font.
function sparkle(c, x, y, r, color) {
  c.save();
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x, y - r);
  c.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
  c.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
  c.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
  c.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
  c.fill();
  c.restore();
}

/**
 * Favorites shelf: "✦ FAVORITES · 5 ─── ✦✦✦", then up to three banner cards
 * (two on top, one wide below) with the title, a coloured bar and an
 * alternate title. Transparent background; glowing border in each anime's
 * colour, or one colour for all (the profile theme).
 * @param items [{ title, subtitle, banner, cover, accent }]
 * @param o.total     favorites count for the header
 * @param o.border    number (one colour for all) or null (each anime's colour)
 */
async function paintFavorites(items, { total = items.length, border = null } = {}) {
  const { createCanvas } = lib();
  const W = 1600;
  const pad = 26;
  const gap = 30;
  const headH = 104;
  const n = Math.min(3, items.length);
  const rows = n === 3 ? [[0, 1], [2]] : n === 2 ? [[0, 1]] : [[0]];
  const rowH = n === 1 ? 420 : 360;
  const H = pad + headH + rows.length * rowH + (rows.length - 1) * gap + pad;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const imgs = await Promise.all(
    items.slice(0, n).map(async (it) => {
      const b = it.banner ? await loadRemote([it.banner]) : null;
      if (b) return { img: b, isBanner: true };
      return { img: await loadRemote([].concat(it.cover || [])), isBanner: false };
    })
  );

  // Header.
  const headCol = '#e9e6f5';
  const hy = pad + 52;
  sparkle(c, pad + 30, hy, 24, headCol);
  c.font = f(600, 58);
  c.fillStyle = headCol;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  const label = 'FAVORITES';
  c.fillText(label, pad + 76, hy + 2);
  let x = pad + 76 + c.measureText(label).width + 22;
  c.font = f(500, 58);
  c.fillStyle = '#b9b5cc';
  c.fillText(`· ${total}`, x, hy + 2);
  x += c.measureText(`· ${total}`).width + 34;
  const starsX = W - pad - 150;
  const line = c.createLinearGradient(x, 0, starsX - 30, 0);
  line.addColorStop(0, 'rgba(233,230,245,0.75)');
  line.addColorStop(1, 'rgba(233,230,245,0.15)');
  c.fillStyle = line;
  c.fillRect(x, hy, Math.max(0, starsX - 30 - x), 3);
  for (let i = 0; i < 3; i++) sparkle(c, starsX + 20 + i * 48, hy, 15, headCol);

  // Cards.
  let y = pad + headH;
  rows.forEach((row) => {
    const cw = (W - pad * 2 - gap * (row.length - 1)) / row.length;
    row.forEach((idx, k) => {
      const it = items[idx];
      const x0 = pad + k * (cw + gap);
      const accent = vivid(typeof it.accent === 'number' ? it.accent : 0x9d7bff);
      const edge = typeof border === 'number' ? vivid(border) : accent;
      const { img, isBanner } = imgs[idx];
      const r = 30;

      // glow + border
      c.save();
      c.shadowColor = css(edge, 0.75);
      c.shadowBlur = 26;
      roundRect(c, x0, y, cw, rowH, r);
      c.fillStyle = '#0d0e13';
      c.fill();
      c.restore();
      drawCover(c, img, x0, y, cw, rowH, { radius: r, focusY: isBanner ? 0.42 : 0.22 });

      // readability fade at the bottom
      c.save();
      roundRect(c, x0, y, cw, rowH, r);
      c.clip();
      const fade = c.createLinearGradient(0, y + rowH * 0.35, 0, y + rowH);
      fade.addColorStop(0, 'rgba(6,7,12,0)');
      fade.addColorStop(1, 'rgba(6,7,12,0.88)');
      c.fillStyle = fade;
      c.fillRect(x0, y, cw, rowH);
      c.restore();

      roundRect(c, x0 + 1.5, y + 1.5, cw - 3, rowH - 3, r);
      c.lineWidth = 3;
      c.strokeStyle = css(edge, 0.95);
      c.stroke();

      // title + subtitle with the coloured bar
      const wide = row.length === 1;
      const tSize = wide ? 56 : 50;
      const sSize = wide ? 30 : 27;
      const tx = x0 + 70;
      const maxW = cw - 110;
      c.font = f(700, tSize);
      const lines = wrap(c, safeText(it.title, it.titleRomaji) || 'Untitled', wide ? Math.min(maxW, cw * 0.5) : maxW, 2);
      const sub = it.subtitle ? safeText(it.subtitle) : '';
      const blockH = lines.length * tSize * 1.12 + (sub ? sSize * 1.5 : 0);
      const by = y + rowH - 40 - blockH;
      c.fillStyle = css(accent);
      roundRect(c, x0 + 40, by + 6, 8, blockH - 8, 4);
      c.fill();
      c.fillStyle = '#ffffff';
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.shadowColor = 'rgba(0,0,0,0.55)';
      c.shadowBlur = 10;
      lines.forEach((l, i) => c.fillText(l, tx, by + i * tSize * 1.12));
      if (sub) {
        c.font = f(500, sSize);
        c.fillStyle = '#d6d3e3';
        c.fillText(ellipsize(c, sub, maxW), tx, by + lines.length * tSize * 1.12 + sSize * 0.35);
      }
      c.shadowBlur = 0;
    });
    y += rowH + gap;
  });
  return canvas.toBuffer('image/png');
}

/* ----------------------------- openings / endings ----------------------------- */

// ♪ drawn as a shape (the font has no music glyphs).
function iconNote(c, x, y, s, color) {
  c.save();
  c.fillStyle = color;
  c.strokeStyle = color;
  c.lineWidth = s * 0.1;
  c.beginPath();
  c.ellipse(x + s * 0.3, y + s * 0.78, s * 0.2, s * 0.15, -0.4, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(x + s * 0.8, y + s * 0.66, s * 0.2, s * 0.15, -0.4, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(x + s * 0.47, y + s * 0.78);
  c.lineTo(x + s * 0.47, y + s * 0.12);
  c.lineTo(x + s * 0.97, y + s * 0.02);
  c.lineTo(x + s * 0.97, y + s * 0.66);
  c.stroke();
  c.lineWidth = s * 0.16;
  c.beginPath();
  c.moveTo(x + s * 0.47, y + s * 0.18);
  c.lineTo(x + s * 0.97, y + s * 0.08);
  c.stroke();
  c.restore();
}

function iconLink(c, x, y, s, color) {
  c.save();
  c.strokeStyle = color;
  c.lineWidth = s * 0.1;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(x + s * 0.55, y + s * 0.1);
  c.lineTo(x + s * 0.9, y + s * 0.1);
  c.lineTo(x + s * 0.9, y + s * 0.45);
  c.moveTo(x + s * 0.9, y + s * 0.1);
  c.lineTo(x + s * 0.45, y + s * 0.55);
  c.moveTo(x + s * 0.75, y + s * 0.62);
  c.lineTo(x + s * 0.75, y + s * 0.9);
  c.lineTo(x + s * 0.1, y + s * 0.9);
  c.lineTo(x + s * 0.1, y + s * 0.25);
  c.lineTo(x + s * 0.38, y + s * 0.25);
  c.stroke();
  c.restore();
}

/**
 * Favorite openings / endings card: label, then one row per song — cover,
 * song title, ♫ artist, anime — with an "OP 1" badge and a link icon.
 * @param kind  'OP' | 'ED'
 * @param songs [{ song, artist, anime, slug, cover }]
 */
async function paintSongs(kind, songs) {
  const { createCanvas } = lib();
  const W = 1200;
  const pad = 34;
  const headH = 78;
  const rowH = 172;
  const H = pad + headH + songs.length * rowH + pad - 14;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const covers = await Promise.all(songs.map((x) => loadRemote([].concat(x.cover || []))));

  roundRect(c, 1.5, 1.5, W - 3, H - 3, 30);
  c.fillStyle = '#060607';
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = '#2b2d33';
  c.stroke();

  const label = kind === 'ED' ? (songs.length > 1 ? 'FAVORITE ENDINGS' : 'FAVORITE ENDING') : songs.length > 1 ? 'FAVORITE OPENINGS' : 'FAVORITE OPENING';
  c.font = f(600, 30);
  c.fillStyle = '#9b9ea6';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(label, pad + 6, pad + 26);

  songs.forEach((x, i) => {
    const y = pad + headH + i * rowH;
    if (i > 0) {
      c.fillStyle = '#1c1d22';
      c.fillRect(pad + 6, y - 14, W - pad * 2 - 12, 2);
    }
    const s = 136;
    drawCover(c, covers[i], pad + 6, y, s, s, { radius: 26, focusY: 0.3 });
    const tx = pad + 6 + s + 34;
    const badge = (x.slug || `${kind}1`).replace(/^(OP|ED)(\d+)/i, (m, k, d) => `${k.toUpperCase()} ${d}`);
    c.font = f(700, 26);
    const bw = c.measureText(badge).width + 34;
    const bx = W - pad - 6 - 92 - 22 - bw;
    const maxW = bx - tx - 20;
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#ffffff';
    c.font = f(700, 44);
    c.fillText(ellipsize(c, safeText(x.song) || 'Untitled', maxW), tx, y + 46);
    iconNote(c, tx, y + 64, 32, '#d4d6db');
    c.fillStyle = '#d4d6db';
    c.font = f(500, 32);
    c.fillText(ellipsize(c, safeText(x.artist) || 'Unknown artist', maxW - 44), tx + 44, y + 94);
    c.fillStyle = '#8b8e96';
    c.font = f(500, 27);
    c.fillText(ellipsize(c, safeText(x.anime) || '', maxW), tx, y + 134);

    // badge
    roundRect(c, bx, y + 2, bw, 44, 12);
    c.fillStyle = 'rgba(61,180,242,0.14)';
    c.fill();
    c.font = f(700, 26);
    c.fillStyle = '#5cbcf5';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(badge, bx + bw / 2, y + 25);
    c.textAlign = 'left';

    // link box
    const lx = W - pad - 6 - 92;
    const ly = y + (s - 92) / 2;
    roundRect(c, lx, ly, 92, 92, 20);
    c.fillStyle = '#1d1e22';
    c.fill();
    iconLink(c, lx + 26, ly + 26, 40, '#e8e9ec');
  });
  return canvas.toBuffer('image/png');
}

/* -------------------------------- featured -------------------------------- */

// The featured anime's banner, cropped taller so it shows bigger.
async function paintFeatured({ banner, cover }) {
  const { createCanvas } = lib();
  const W = 1500;
  const H = 640;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const b = banner ? await loadRemote([banner]) : null;
  const img = b || (await loadRemote([].concat(cover || [])));
  if (!img) throw new Error('no image');
  drawCover(c, img, 0, 0, W, H, { radius: 0, focusY: b ? 0.45 : 0.25 });
  return canvas.toBuffer('image/png');
}

module.exports = { available, paintRotation, paintLeaderboard, paintBannerList, paintFavorites, paintSongs, paintFeatured, safeText, STATUS, vivid, missCount, loadRemote };
