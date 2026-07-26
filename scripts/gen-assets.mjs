/**
 * Procedural placeholder assets for the Living Photograph engine.
 *
 * WHY THIS EXISTS: the build environment's network policy blocks every image host
 * (Wikimedia included), so no real photograph of Qutub Minar can be fetched here.
 * Rather than ship a grey rectangle, this renders a structurally faithful stand-in
 * — a tapering, fluted, five-storey tower with balconies — together with a depth
 * map that is *actually correct for that image*.
 *
 * That matters: the parallax, the region camera moves and the focus spotlight are
 * all genuinely demonstrable right now, with no ML depth inference and no network.
 *
 * SWAP THESE BEFORE THE DEMO. Drop a real photo at hero.webp (<=2048px long edge,
 * <400KB) and a Depth Anything V2 map at depth.png (1024px, <200KB). Nothing in the
 * code needs to change — the filenames and the aspect in content/qutub-minar.json
 * are the only contract.
 *
 *   node scripts/gen-assets.mjs
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const W = 896;
const H = 1792; // aspect 0.50 — a phone viewport, so `contain` framing fills it
                // rather than letterboxing. A tower must never be cropped top or
                // bottom, so the frame is matched to the phone instead.
const OUT = path.join(process.cwd(), 'public', 'monuments', 'qutub-minar');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (no dependencies — sharp/canvas are not installed)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** colorType 2 = RGB, 0 = greyscale */
function encodePng(width, height, pixels, colorType) {
  const channels = colorType === 2 ? 3 : 1;
  const stride = width * channels;
  // Filter byte 0 (None) per scanline. Adaptive filtering would compress better but
  // these assets are placeholders; clarity beats 20KB here.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;         // deflate
  ihdr[11] = 0;         // adaptive filtering
  ihdr[12] = 0;         // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Deterministic noise — same output every run, so the depth map always matches
// ---------------------------------------------------------------------------

function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf);
  const v = s(yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
}

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Tower geometry — shared by the colour render and the depth render so they agree
// ---------------------------------------------------------------------------

const TOP = 0.11;    // v of the crown
const BASE = 0.93;   // v where the tower meets the ground
const W_TOP = 0.062; // half-width at the crown
const W_BASE = 0.178;// half-width at the base

/** Five storeys, each ending in a projecting balcony. */
const STOREYS = [0.11, 0.30, 0.475, 0.625, 0.775, 0.93];

function halfWidthAt(v) {
  const t = clamp((v - TOP) / (BASE - TOP));
  // Slight entasis: the real minar swells a little rather than tapering as a pure cone.
  const base = lerp(W_TOP, W_BASE, Math.pow(t, 1.18));

  // Balcony flanges at every storey boundary.
  let flange = 0;
  for (let i = 1; i < STOREYS.length - 1; i++) {
    const b = STOREYS[i];
    const d = Math.abs(v - b);
    if (d < 0.018) flange = Math.max(flange, (1 - d / 0.018) * 0.030);
  }
  return base + flange;
}

/** -1..1 across the tower, or null outside it. */
function towerU(u, v) {
  if (v < TOP || v > BASE) return null;
  const hw = halfWidthAt(v);
  const dx = (u - 0.5) / hw;
  return Math.abs(dx) <= 1 ? dx : null;
}

function storeyIndex(v) {
  for (let i = 0; i < STOREYS.length - 1; i++) if (v >= STOREYS[i] && v < STOREYS[i + 1]) return i;
  return STOREYS.length - 2;
}

// ---------------------------------------------------------------------------
// Colour render
// ---------------------------------------------------------------------------

function renderHero({ sepia = false } = {}) {
  const px = Buffer.alloc(W * H * 3);

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let r;
      let g;
      let b;

      const dx = towerU(u, v);

      if (dx === null) {
        // ---- sky and ground ----
        if (v < 0.955) {
          // Late-afternoon sky: warm near the horizon, deeper blue overhead.
          const t = smoothstep(0.0, 0.95, v);
          r = lerp(96, 214, t);
          g = lerp(126, 178, t);
          b = lerp(168, 148, t);
          // Soft cloud banding
          const cloud = fbm(u * 3.2, v * 5.0 + 11, 5);
          const cloudMask = smoothstep(0.45, 0.75, cloud) * smoothstep(0.05, 0.5, v) * 40;
          r += cloudMask;
          g += cloudMask * 0.95;
          b += cloudMask * 0.9;
        } else {
          // ---- ground ----
          const t = smoothstep(0.955, 1.0, v);
          const grass = fbm(u * 18, v * 60 + 5, 4);
          r = lerp(96, 66, t) + grass * 26;
          g = lerp(92, 62, t) + grass * 30;
          b = lerp(70, 46, t) + grass * 16;
        }
      } else {
        // ---- the tower ----
        const s = storeyIndex(v);
        // Firoz Shah rebuilt the top two storeys in marble — they read lighter.
        const marble = s >= 4 ? 0 : s >= 3 ? 0.35 : 0;
        const upper = s >= 3 ? 1 : 0;

        // 24 flutes, alternating angular and rounded, wrapped round a cylinder.
        const theta = Math.asin(clamp(dx, -1, 1));
        const ribs = upper ? 16 : 24;
        const flute = Math.cos(theta * ribs);
        const fluteShade = 0.86 + 0.14 * Math.pow(Math.abs(flute), 0.6);

        // Cylindrical form shading: lit from the upper left.
        const nz = Math.sqrt(clamp(1 - dx * dx));
        const light = clamp(0.36 + 0.72 * clamp(nz * 0.86 - dx * 0.42));

        // Sandstone base colour, marble mixed in for the upper storeys.
        const sandR = lerp(176, 226, marble);
        const sandG = lerp(104, 196, marble);
        const sandB = lerp(74, 168, marble);

        // Carved inscription bands: darker horizontal ribbons.
        let band = 1;
        for (let i = 1; i < STOREYS.length - 1; i++) {
          const d = Math.abs(v - (STOREYS[i] - 0.030));
          if (d < 0.011) band = Math.min(band, 0.72 + 0.28 * (d / 0.011));
        }
        // Balcony undersides (muqarnas) throw a hard shadow.
        let balconyShadow = 1;
        for (let i = 1; i < STOREYS.length - 1; i++) {
          const d = v - STOREYS[i];
          if (d > 0 && d < 0.014) balconyShadow = Math.min(balconyShadow, 0.42 + 0.58 * (d / 0.014));
        }

        // Weathered stone grain.
        const grain = 0.93 + fbm(u * 46, v * 150, 4) * 0.16;

        const k = light * fluteShade * band * balconyShadow * grain;
        r = sandR * k;
        g = sandG * k;
        b = sandB * k;
      }

      // ---- atmosphere: haze rising from the base, then vignette ----
      const haze = smoothstep(0.62, 1.0, v) * 0.20;
      r = lerp(r, 208, haze);
      g = lerp(g, 190, haze);
      b = lerp(b, 168, haze);

      const cx = (u - 0.5) * 1.25;
      const cy = (v - 0.5) * 1.0;
      const vig = 1 - clamp(Math.sqrt(cx * cx + cy * cy) - 0.34) * 0.85;
      r *= vig;
      g *= vig;
      b *= vig;

      if (sepia) {
        // The 1900 layer: an albumen print, not a filter — flatter, warmer, grainier.
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const flat = lerp(lum, 128, 0.22);
        r = clamp((flat * 1.07 + 26) / 255) * 255;
        g = clamp((flat * 0.96 + 14) / 255) * 255;
        b = clamp((flat * 0.74 + 6) / 255) * 255;
        const age = (hash2(x >> 1, y >> 1) - 0.5) * 22;
        r += age;
        g += age;
        b += age;
      }

      // Film grain — the single cheapest thing that makes a render read as a photograph.
      // Sampled at half resolution and quantised: full per-pixel noise is incompressible
      // and pushed the PNG past the 400KB page budget for no visible gain at phone DPI.
      const grain = (Math.round(hash2(x >> 1, y >> 1) * 4) / 4 - 0.5) * 9;
      // Quantise to 3-value steps. Invisible on a phone, roughly halves the PNG.
      const q = (n) => Math.round((clamp((n + grain) / 255) * 255) / 3) * 3;
      const o = (y * W + x) * 3;
      px[o] = q(r);
      px[o + 1] = q(g);
      px[o + 2] = q(b);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Depth render — MUST agree with the colour render pixel for pixel
// ---------------------------------------------------------------------------

function renderDepth() {
  const px = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let d;
      const dx = towerU(u, v);

      if (dx !== null) {
        // Cylindrical roundness: the centre of the shaft is nearest the camera.
        // This is what makes the parallax read as a solid round tower rather than
        // a flat cut-out, and it is the whole reason a matching depth map matters.
        const round = Math.sqrt(clamp(1 - dx * dx));
        d = 0.70 + round * 0.30;
        // The crown is further away than the base — the tower recedes as it rises.
        d -= smoothstep(BASE, TOP, v) * 0.18;
      } else if (v >= 0.955) {
        // Ground plane sweeping toward the viewer.
        d = lerp(0.30, 0.96, smoothstep(0.955, 1.0, v));
      } else {
        // Sky: effectively at infinity, with a whisper of cloud relief so the
        // dust motes and drift have something to parallax against.
        d = 0.02 + fbm(u * 3.2, v * 5.0 + 11, 3) * 0.05;
      }

      // Slight blur at the silhouette so displacement does not tear a hard edge.
      const edgeSoft = dx !== null ? smoothstep(1.0, 0.86, Math.abs(dx)) : 1;
      d = lerp(0.12, d, 0.25 + 0.75 * edgeSoft);

      px[y * W + x] = clamp(d) * 255;
    }
  }
  return px;
}

// ---------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });

const write = (name, buf) => {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name.padEnd(16)} ${(buf.length / 1024).toFixed(0)} KB`);
};

console.log(`Generating placeholder assets in ${OUT}`);
write('hero.png', encodePng(W, H, renderHero(), 2));
write('era-1900.png', encodePng(W, H, renderHero({ sepia: true }), 2));
write('depth.png', encodePng(W, H, renderDepth(), 0));
console.log('Done. These are PLACEHOLDERS — swap in a real photograph before the demo.');
