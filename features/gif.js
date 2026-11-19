const { GifReader, GifWriter } = require('omggif');
const Jimp = require('jimp');

/* ---------------------------------------------------------------------------
 * Animated-image helpers (uses omggif, which Jimp already ships).
 *
 * decodeAnimation(): turns a GIF into full-size RGBA frames, applying each
 * frame's disposal method (keep / clear to transparent / restore previous)
 * so partial frames and transparency come out exactly as a browser shows
 * them. Long GIFs are thinned out (durations merged) to stay fast.
 *
 * encodeAnimation(): RGBA frames -> looping GIF with one shared palette
 * (median cut over all frames, so colours don't flicker between frames), light
 * ordered dithering against banding, and hard-edged transparency. Hand-rolled
 * because general-purpose quantizers take ~1s per frame — this is ~20ms.
 * ------------------------------------------------------------------------- */

const MAX_FRAMES = 90;
const MAX_SOURCE_PIXELS = 1200 * 1200 * 40; // decode budget (w * h * frames)

function isGif(buf) {
  return buf && buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8';
}

function decodeAnimation(buf) {
  const reader = new GifReader(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
  const { width, height } = reader;
  const count = reader.numFrames();
  // Thin out very long / very large GIFs: keep every k-th frame.
  const budgetFrames = Math.max(1, Math.floor(MAX_SOURCE_PIXELS / (width * height)));
  const keepEvery = Math.max(1, Math.ceil(count / Math.min(MAX_FRAMES, budgetFrames)));

  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let pendingDelay = 0;
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    const previous = info.disposal === 3 ? canvas.slice() : null;
    reader.decodeAndBlitFrameRGBA(i, canvas);
    // browsers treat tiny delays (<= 10ms) as 100ms
    const delay = info.delay && info.delay > 1 ? info.delay * 10 : 100;
    pendingDelay += delay;
    if (i % keepEvery === 0 || i === count - 1) {
      frames.push({ data: canvas.slice(), delay: pendingDelay });
      pendingDelay = 0;
    }
    if (info.disposal === 2) {
      for (let y = info.y; y < Math.min(height, info.y + info.height); y++) {
        canvas.fill(0, (y * width + info.x) * 4, (y * width + Math.min(width, info.x + info.width)) * 4);
      }
    } else if (info.disposal === 3 && previous) {
      canvas.set(previous);
    }
  }
  return { width, height, frames, loops: reader.loopCount ? reader.loopCount() : 0 };
}

// Any image buffer -> { width, height, frames: [{ data, delay }] } (1 frame if static).
async function decodeAny(buf) {
  if (isGif(buf)) {
    try {
      const anim = decodeAnimation(buf);
      if (anim.frames.length) return anim;
    } catch (e) {
      console.warn('GIF decode failed, using first frame:', e.message);
    }
  }
  const img = await Jimp.read(buf);
  return { width: img.bitmap.width, height: img.bitmap.height, frames: [{ data: new Uint8Array(img.bitmap.data), delay: 0 }], loops: 0 };
}

function frameToJimp(anim, frame) {
  return new Jimp({ data: Buffer.from(frame.data), width: anim.width, height: anim.height });
}

// Picks the frame showing at time t (ms) in a looping animation.
function frameAt(anim, t) {
  if (anim.frames.length === 1) return 0;
  const total = anim.frames.reduce((a, f) => a + f.delay, 0) || 1;
  let x = t % total;
  for (let i = 0; i < anim.frames.length; i++) {
    if (x < anim.frames[i].delay) return i;
    x -= anim.frames[i].delay;
  }
  return anim.frames.length - 1;
}

// Median-cut palette from sampled opaque pixels.
function medianCut(samples, maxColors) {
  let boxes = [samples];
  const range = (box, c) => {
    let lo = 255;
    let hi = 0;
    for (let i = c; i < box.length; i += 3) {
      if (box[i] < lo) lo = box[i];
      if (box[i] > hi) hi = box[i];
    }
    return hi - lo;
  };
  while (boxes.length < maxColors) {
    let best = -1;
    let bestRange = -1;
    let bestC = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 6) return;
      for (let c = 0; c < 3; c++) {
        const r = range(box, c);
        if (r > bestRange) {
          bestRange = r;
          best = bi;
          bestC = c;
        }
      }
    });
    if (best === -1 || bestRange <= 0) break;
    const box = boxes[best];
    const n = box.length / 3;
    const idx = Array.from({ length: n }, (_, i) => i).sort((x, y) => box[x * 3 + bestC] - box[y * 3 + bestC]);
    const mid = n >> 1;
    const left = new Uint8Array(mid * 3);
    const right = new Uint8Array((n - mid) * 3);
    idx.forEach((p, k) => {
      const dst = k < mid ? left : right;
      const o = (k < mid ? k : k - mid) * 3;
      dst[o] = box[p * 3];
      dst[o + 1] = box[p * 3 + 1];
      dst[o + 2] = box[p * 3 + 2];
    });
    boxes.splice(best, 1, left, right);
  }
  return boxes.map((box) => {
    const n = box.length / 3 || 1;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < box.length; i += 3) {
      r += box[i];
      g += box[i + 1];
      b += box[i + 2];
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5) * 10);

// frames: [{ image: Jimp, delay }] -> GIF Buffer
async function encodeAnimation(frames) {
  const w = frames[0].image.bitmap.width;
  const h = frames[0].image.bitmap.height;

  // 1) sample opaque pixels across all frames
  const total = w * h * frames.length;
  const step = Math.max(1, Math.floor(total / 90000));
  const samples = [];
  let k = 0;
  for (const { image } of frames) {
    const d = image.bitmap.data;
    for (let i = 0; i < d.length; i += 4, k++) {
      if (k % step === 0 && d[i + 3] >= 128) samples.push(d[i], d[i + 1], d[i + 2]);
    }
  }
  const palette = medianCut(Uint8Array.from(samples.length ? samples : [0, 0, 0]), 255);
  while (palette.length < 255) palette.push([0, 0, 0]);
  const TRANSPARENT = 255;
  palette.push([0, 0, 0]);

  // 2) 15-bit lookup table: nearest palette colour for every 5-5-5 colour
  const lut = new Uint8Array(32768);
  for (let c = 0; c < 32768; c++) {
    const r = ((c >> 10) & 31) * 8 + 4;
    const g = ((c >> 5) & 31) * 8 + 4;
    const b = (c & 31) * 8 + 4;
    let best = 0;
    let bd = Infinity;
    for (let p = 0; p < 255; p++) {
      const [pr, pg, pb] = palette[p];
      const dd = (pr - r) * (pr - r) * 2 + (pg - g) * (pg - g) * 4 + (pb - b) * (pb - b) * 3;
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    }
    lut[c] = best;
  }

  // 3) map + write
  const out = Buffer.alloc(w * h * frames.length * 2 + 1024 * 64);
  const writer = new GifWriter(out, w, h, { loop: 0, palette: palette.map(([r, g, b]) => (r << 16) | (g << 8) | b) });
  const indexed = new Uint8Array(w * h);
  for (const { image, delay } of frames) {
    const d = image.bitmap.data;
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const i = p * 4;
        if (d[i + 3] < 128) {
          indexed[p] = TRANSPARENT;
          continue;
        }
        const o = BAYER[(y & 3) * 4 + (x & 3)];
        const r = Math.max(0, Math.min(255, d[i] + o)) >> 3;
        const g = Math.max(0, Math.min(255, d[i + 1] + o)) >> 3;
        const b = Math.max(0, Math.min(255, d[i + 2] + o)) >> 3;
        indexed[p] = lut[(r << 10) | (g << 5) | b];
      }
    }
    writer.addFrame(0, 0, w, h, indexed, { delay: Math.max(2, Math.round(delay / 10)), disposal: 2, transparent: TRANSPARENT });
  }
  return Buffer.from(out.subarray(0, writer.end()));
}

module.exports = { isGif, decodeAny, decodeAnimation, frameToJimp, frameAt, encodeAnimation };
