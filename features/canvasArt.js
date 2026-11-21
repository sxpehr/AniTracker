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
 *   [▭] S1 | [≋] 3 / 10 | ( ▶ Watching )
 *      ( Cyberpunk ) ( Tragedy )        ← AniList tags, not genres
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
async function loadRemote(url, timeout = 8000) {
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (imgCache.has(url)) return imgCache.get(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return null;
    const img = await lib().loadImage(buf);
    imgCache.set(url, img);
    if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value);
    return img;
  } catch {
    return null;
  }
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
  const CH = Math.round(tagTop + tagH + pad);
  const W = n * CW + (n - 1) * gap;

  const canvas = createCanvas(W, CH);
  const c = canvas.getContext('2d');
  const covers = await Promise.all(items.map((it) => loadRemote(it.cover)));

  items.forEach((it, i) => {
    const x0 = i * (CW + gap);
    const accent = vivid(typeof it.accent === 'number' ? it.accent : 0x3db4f2);
    const st = STATUS[it.status] || STATUS.CURRENT;

    // Card: near-black, washed with the cover's colour at the top.
    roundRect(c, x0 + 1, 1, CW - 2, CH - 2, CW * 0.07);
    const bg = c.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, css(mix(0x0b0c10, accent, 0.2)));
    bg.addColorStop(0.55, '#0c0d11');
    bg.addColorStop(1, '#09090c');
    c.fillStyle = bg;
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = css(accent, 0.22);
    c.stroke();

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

    // Meta row: [screen] S1 | [layers] 3 / 10 | (▶ Watching)
    const seasonText = it.format && !['TV', 'TV_SHORT'].includes(it.format) ? (it.format === 'MOVIE' ? 'Movie' : it.format.replace('_', ' ')) : `S${it.season || 1}`;
    const progText = it.progress === null ? '—' : it.total ? `${Math.min(it.progress, it.total)} / ${it.total}` : `${it.progress} / ?`;
    const statusIcon = it.status === 'PAUSED' ? iconPause : it.status === 'REPEATING' ? iconRepeat : iconPlay;
    let scale = 1;
    const measure = (s) => {
      c.font = f(600, metaSize * s);
      const iconS = metaSize * 1.05 * s;
      const sep = metaSize * 0.9 * s;
      const a = iconS + metaSize * 0.4 * s + c.measureText(seasonText).width;
      const b = iconS + metaSize * 0.4 * s + c.measureText(progText).width;
      const p = pill(c, 0, 0, { text: st.label, h: pillH * s, font: f(600, metaSize * s), icon: statusIcon, draw: false });
      return { a, b, p, sep, iconS, total: a + sep * 2 + b + sep * 2 + p };
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
    const divider = () => {
      x += m.sep;
      c.fillStyle = '#4a4d55';
      c.fillRect(x - 1, midY - metaSize * 0.75 * scale, 2, metaSize * 1.5 * scale);
      x += m.sep;
    };
    drawPart(iconScreen, seasonText);
    divider();
    drawPart(iconLayers, progText);
    divider();
    pill(c, x, midY - (pillH * scale) / 2, {
      text: st.label,
      h: pillH * scale,
      font: f(600, metaSize * scale),
      fg: css(st.color),
      bg: css(st.color, 0.1),
      border: css(st.color, 0.9),
      icon: statusIcon,
    });

    // Tag pills: as many as fit on one line (max 3), centred.
    const tagFont = f(600, tagSize);
    const tags = [];
    let used = 0;
    const gapT = CW * 0.025;
    for (const raw of (it.tags || []).slice(0, 3)) {
      const t = safeText(raw);
      if (!t) continue;
      const label = t.length > 18 ? `${t.slice(0, 17)}…` : t;
      const w = pill(c, 0, 0, { text: label, h: tagH, font: tagFont, draw: false });
      if (used + (tags.length ? gapT : 0) + w > CW - pad * 1.4) break;
      used += (tags.length ? gapT : 0) + w;
      tags.push({ label, w });
    }
    let tx = cx - used / 2;
    for (const t of tags) {
      pill(c, tx, tagTop, { text: t.label, h: tagH, font: tagFont, fg: '#e6e7ea', bg: '#1b1d22', border: '#3b3e46' });
      tx += t.w + gapT;
    }
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
  const imgs = await Promise.all(items.map((it) => loadRemote(it.banner).then((b) => b || loadRemote(it.cover)).then((img) => ({ img, isBanner: Boolean(it.banner) }))));
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

module.exports = { available, paintRotation, paintLeaderboard, paintBannerList, safeText, STATUS, vivid };
