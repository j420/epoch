/**
 * Procedural placeholder assets for the Living Photograph engine.
 *
 * WHY THIS EXISTS: the build environment's network policy blocks every image host
 * (Wikimedia included), so no real photograph of any of the ten monuments can be
 * fetched here. Rather than ship ten grey rectangles, this renders a structurally
 * faithful stand-in for each — together with a depth map that is *actually correct
 * for that image*.
 *
 * That matters: the parallax, the region camera moves and the focus spotlight are
 * all genuinely demonstrable right now, with no ML depth inference and no network.
 *
 * The geometry lives in scripts/monument-shapes.mjs. Every shape exposes exactly one
 * function, `hit(u, v, out)`, and BOTH renderers below call it and nothing else —
 * which is why the depth map cannot drift out of agreement with the picture.
 *
 * SWAP THESE BEFORE THE DEMO. Drop a real photo at hero.png (<=2048px long edge)
 * and a Depth Anything V2 map at depth.png for any monument and nothing in the code
 * needs to change — the filenames and the `aspect` in content/<id>.json are the only
 * contract. The aspect is derived from W/H here, so the two can never disagree.
 *
 * THAT SWAP HAS NOW HAPPENED for some of the ten. `scripts/fetch-photos.mjs` pulls
 * real, licensed photographs and records them in public/monuments/photo-lock.json.
 * This script refuses to overwrite a locked monument's hero and era plates, because
 * doing so would silently replace a licensed photograph with a drawing and nobody
 * would notice until the demo. Pass --force if that is genuinely what you want.
 *
 *   node scripts/gen-assets.mjs              # every monument still on placeholders
 *   node scripts/gen-assets.mjs taj-mahal    # just one
 *   node scripts/gen-assets.mjs --force      # ignore the photo lock (destructive)
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { SHAPES, clamp, lerp, smoothstep, hash2, fbm } from './monument-shapes.mjs';

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
// Shared shading. The key light sits high and to the left for every monument, so
// the ten heroes read as one set rather than ten unrelated pictures.
// ---------------------------------------------------------------------------

const newSurface = () => ({ z: 0, nx: 0, nz: 1, r: 0, g: 0, b: 0, k: 1 });

function litColour(s, u, v, dst) {
  const light = clamp(0.36 + 0.72 * clamp(s.nz * 0.86 - s.nx * 0.42));
  // Weathered stone grain — the cheapest thing that stops a render reading as CAD.
  const grain = 0.93 + fbm(u * 46, v * 150, 4) * 0.16;
  const kk = light * s.k * grain;
  dst[0] = s.r * kk;
  dst[1] = s.g * kk;
  dst[2] = s.b * kk;
  return dst;
}

function skyColour(shape, u, v, dst) {
  const t = smoothstep(0, 0.95, v);
  const { top, horizon, cloud } = shape.sky;
  let r = lerp(top[0], horizon[0], t);
  let g = lerp(top[1], horizon[1], t);
  let b = lerp(top[2], horizon[2], t);
  const c = fbm(u * 3.2, v * 5 + 11, 5);
  const mask = smoothstep(0.45, 0.75, c) * smoothstep(0.05, 0.5, v) * cloud;
  dst[0] = r + mask;
  dst[1] = g + mask * 0.95;
  dst[2] = b + mask * 0.9;
  return dst;
}

function groundColour(shape, u, v, dst) {
  const gy = shape.ground.y;
  const t = smoothstep(gy, 1, v);
  const tex = fbm(u * 18, v * 60 + 5, 4);
  dst[0] = lerp(shape.ground.far[0], shape.ground.near[0], t) + tex * 26;
  dst[1] = lerp(shape.ground.far[1], shape.ground.near[1], t) + tex * 30;
  dst[2] = lerp(shape.ground.far[2], shape.ground.near[2], t) + tex * 16;
  return dst;
}

// ---------------------------------------------------------------------------
// Colour render
// ---------------------------------------------------------------------------

function renderHero(shape, { sepia = false } = {}) {
  const { W, H } = shape;
  const px = Buffer.alloc(W * H * 3);
  const surf = newSurface();
  const mirror = newSurface();
  const c = [0, 0, 0];
  const m = [0, 0, 0];
  const wide = W >= H;
  const vigX = wide ? 1.0 : 1.25;
  const vigY = wide ? 1.25 : 1.0;
  const water = shape.water ?? null;
  const step = sepia ? 4 : 3;

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let r;
      let g;
      let b;

      if (shape.hit(u, v, surf)) {
        litColour(surf, u, v, c);
        r = c[0]; g = c[1]; b = c[2];
      } else if (water && v >= water.y) {
        // ---- the tank / the harbour ----
        const t = smoothstep(water.y, 1, v);
        // Reflections are compressed and broken up by a slow swell.
        const swell = Math.sin(v * 190 + fbm(u * 5, v * 26, 3) * 8) * water.ripple * (0.35 + t);
        const mv = water.y - (v - water.y) * 0.86 + swell;
        const mu = u + swell * 0.6;
        r = lerp(shape.sky.horizon[0], 76, t * 0.5) * 0.84;
        g = lerp(shape.sky.horizon[1], 96, t * 0.5) * 0.86;
        b = lerp(shape.sky.horizon[2], 112, t * 0.5) * 0.9;
        if (mv > 0 && shape.hit(mu, mv, mirror)) {
          litColour(mirror, mu, mv, m);
          const s = water.strength * (1 - t * 0.3);
          r = lerp(r, m[0] * 0.9, s);
          g = lerp(g, m[1] * 0.9, s);
          b = lerp(b, m[2] * 0.92, s);
        }
        // Specular glitter on the ripples.
        const gl = smoothstep(0.62, 0.95, fbm(u * 70, v * 210, 3)) * 34 * (0.3 + t);
        r += gl; g += gl; b += gl * 0.9;
      } else if (v >= shape.ground.y) {
        groundColour(shape, u, v, c);
        r = c[0]; g = c[1]; b = c[2];
      } else {
        skyColour(shape, u, v, c);
        r = c[0]; g = c[1]; b = c[2];
      }

      // ---- atmosphere: haze rising from the base, then vignette ----
      const hz = shape.haze;
      const haze = smoothstep(hz.start, 1, v) * hz.amount;
      r = lerp(r, hz.col[0], haze);
      g = lerp(g, hz.col[1], haze);
      b = lerp(b, hz.col[2], haze);

      const cx = (u - 0.5) * vigX;
      const cy = (v - 0.5) * vigY;
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
        const age = (hash2(x >> 1, y >> 1) - 0.5) * 20;
        r += age;
        g += age;
        b += age;
      }

      // Film grain — the single cheapest thing that makes a render read as a photograph.
      // Sampled at half resolution and quantised: full per-pixel noise is incompressible
      // and pushed the PNG past the page budget for no visible gain at phone DPI.
      const grain = (Math.round(hash2(x >> 1, y >> 1) * 4) / 4 - 0.5) * 9;
      // Quantise to 3-value steps (4 for the flat sepia plate). Invisible on a phone,
      // roughly halves the PNG.
      const q = (n) => Math.round((clamp((n + grain) / 255) * 255) / step) * step;
      const o = (y * W + x) * 3;
      px[o] = q(r);
      px[o + 1] = q(g);
      px[o + 2] = q(b);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Depth render — cannot disagree with the colour render, because it asks the same
// `hit` the same question and simply reads a different field off the answer.
// ---------------------------------------------------------------------------

function renderDepth(shape) {
  const { W, H } = shape;
  const buf = new Float32Array(W * H);
  const surf = newSurface();
  const water = shape.water ?? null;

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let d;
      if (shape.hit(u, v, surf)) {
        d = surf.z;
      } else if (water && v >= water.y) {
        // Water is a plane sweeping toward the viewer. Note it takes the plane's
        // depth, NOT the depth of whatever it happens to be reflecting — that is
        // what makes a reflection behave like a reflection under parallax.
        d = lerp(0.34, 0.98, smoothstep(water.y, 1, v));
      } else if (v >= shape.ground.y) {
        d = lerp(0.3, 0.96, smoothstep(shape.ground.y, 1, v));
      } else {
        // Sky: effectively at infinity, with a whisper of cloud relief so the dust
        // motes and the drift have something to parallax against.
        d = 0.02 + fbm(u * 3.2, v * 5 + 11, 3) * 0.05;
      }
      buf[y * W + x] = clamp(d);
    }
  }

  // A two-pass box blur softens every silhouette at once, so displacement never
  // tears a hard edge. Two pixels at this resolution is well under a millimetre
  // of apparent blur on a phone, and it compresses better besides.
  const R = 2;
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let i = -R; i <= R; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= W) continue;
        s += buf[y * W + xx];
        n++;
      }
      tmp[y * W + x] = s / n;
    }
  }
  const px = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let i = -R; i <= R; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= H) continue;
        s += tmp[yy * W + x];
        n++;
      }
      px[y * W + x] = Math.round(clamp(s / n) * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const ids = only.length ? only : Object.keys(SHAPES);

/**
 * Monuments whose hero is a real photograph. Written by scripts/fetch-photos.mjs.
 * Missing file simply means nothing is locked yet.
 */
const locked = (() => {
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'public', 'monuments', 'photo-lock.json'), 'utf8'),
    );
    return new Set(Object.keys(lock.plates ?? {}));
  } catch {
    return new Set();
  }
})();

let total = 0;
for (const id of ids) {
  const shape = SHAPES[id];
  if (!shape) {
    console.error(`  ! unknown monument "${id}" — known: ${Object.keys(SHAPES).join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const outDir = path.join(process.cwd(), 'public', 'monuments', id);
  fs.mkdirSync(outDir, { recursive: true });

  const aspect = (shape.W / shape.H).toFixed(4).replace(/0+$/, '');
  const note = locked.has(id) && !force ? '  (procedural geometry only — hero is a photograph)' : '';
  console.log(`\n${id}  ${shape.W}x${shape.H}  aspect ${aspect}${note}`);

  const write = (name, buf) => {
    fs.writeFileSync(path.join(outDir, name), buf);
    total += buf.length;
    console.log(`  ${name.padEnd(16)} ${(buf.length / 1024).toFixed(0)} KB`);
  };

  const photographed = locked.has(id) && !force;
  if (photographed) {
    // The hero and the era plate are a licensed photograph. Leave them alone.
    console.log('  hero.png / era-1900.png  KEPT — real photograph (see photo-lock.json)');
  } else {
    write('hero.png', encodePng(shape.W, shape.H, renderHero(shape), 2));
    write('era-1900.png', encodePng(shape.W, shape.H, renderHero(shape, { sepia: true }), 2));
  }
  // depth.png is always regenerated: `public/sw.js` precaches the path and
  // `scripts/smoke.ts` asserts it, so the file has to exist. For a photographed
  // monument content/<id>.json sets `"depth": ""`, so the app never loads it —
  // it is a stale artefact of the procedural set, not a map of the photograph.
  write('depth.png', encodePng(shape.W, shape.H, renderDepth(shape), 0));
}

console.log(`\nDone — ${(total / 1024 / 1024).toFixed(2)} MB total.`);
if (locked.size && !force) {
  console.log(
    `${locked.size} monument(s) have real photographs and were left alone: ` +
      `${[...locked].join(', ')}. See public/monuments/CREDITS.md.`,
  );
}
console.log('Anything else here is a PLACEHOLDER — swap in real photographs before the demo.');
