/**
 * Parameterised procedural silhouettes for Bol's placeholder heroes.
 *
 * WHY THIS EXISTS: every image host is blocked from the build environment, so no
 * real photograph of any of the ten monuments can be fetched. Rather than ship ten
 * identical grey rectangles, this renders a structurally plausible stand-in for each
 * — and, crucially, a depth map that is *actually correct for that image*.
 *
 * THE ONE RULE THAT MAKES THAT TRUE
 * ---------------------------------
 * A shape exposes exactly one geometry function, `hit(u, v, out)`. The colour render
 * and the depth render both call it and nothing else. They therefore cannot disagree:
 * the depth map is not an approximation of the picture, it is the same geometry read
 * through a different channel. Parallax, the region dolly moves and the focus
 * spotlight are all genuinely demonstrable with no ML depth inference and no network.
 *
 * `hit` writes into a caller-owned scratch record and returns true when the pixel is
 * on the monument:
 *
 *   out.z   0..1 depth. 1 = at the camera, 0 = at infinity. Monument solids live in
 *           roughly 0.55..1.00; the ground plane sweeps 0.30..0.96; sky sits near 0.03.
 *   out.nx  surface normal x, -1..1. Drives the directional key light.
 *   out.nz  surface normal z, 0..1 (1 = facing the camera square on).
 *   out.r/g/b  base albedo before light, haze and grain.
 *   out.k   local brightness multiplier for carved detail: flutes, string courses,
 *           balcony undersides, window recesses.
 *
 * PAINTER'S ORDER. Parts inside a `hit` are evaluated strictly back-to-front and a
 * later part simply overwrites an earlier one. Primitives never touch `out` when they
 * miss, so this is safe — but it means the order of the calls inside each `hit` is
 * load-bearing. Draw what is far away first.
 *
 * SWAP THESE BEFORE THE DEMO. Drop a real photo at hero.png and a Depth Anything V2
 * map at depth.png for any monument and nothing in the app changes: the filenames and
 * the `aspect` in content/<id>.json are the only contract.
 */

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Deterministic hash — same output every run, so the depth map always matches. */
export function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf);
  const w = s(yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - w) + b * u * (1 - w) + c * (1 - u) * w + d * u * w;
}

export function fbm(x, y, octaves = 4) {
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

/** Repeating 0..1 phase, safe for negative inputs. */
const phase = (x, period) => (((x % period) + period) % period) / period;

// ---------------------------------------------------------------------------
// Palette — a small shared vocabulary of Indian building stone
// ---------------------------------------------------------------------------

export const MAT = {
  redSandstone: [172, 96, 68],
  buffSandstone: [196, 150, 106],
  pinkSandstone: [206, 108, 88],
  whiteMarble: [231, 226, 216],
  warmMarble: [226, 214, 196],
  pinkMarble: [198, 122, 128],
  greyGranite: [146, 146, 142],
  darkGranite: [104, 102, 100],
  limeStucco: [214, 202, 178],
  khondalite: [128, 116, 100],
  laterite: [138, 104, 82],
  basaltYellow: [190, 168, 122],
  gold: [206, 156, 52],
  brightGold: [232, 186, 78],
  shadow: [56, 46, 40],
  deepShadow: [34, 28, 26],
  water: [72, 96, 112],
};

// ---------------------------------------------------------------------------
// Primitives. Each returns true and writes `out` when the pixel is on the part,
// and returns false without touching `out` otherwise.
// ---------------------------------------------------------------------------

function put(out, z, nx, nz, col, k = 1) {
  out.z = z;
  out.nx = nx;
  out.nz = nz;
  out.r = col[0];
  out.g = col[1];
  out.b = col[2];
  out.k = k;
  return true;
}

/** A flat wall facing the camera. Barrelled very slightly so parallax has something. */
function slab(out, u, v, o) {
  if (u < o.x0 || u > o.x1 || v < o.y0 || v > o.y1) return false;
  const cx = (o.x0 + o.x1) * 0.5;
  const hw = (o.x1 - o.x0) * 0.5;
  const barrel = o.barrel ?? 0.11;
  const nx = ((u - cx) / hw) * barrel * 2.1;
  const nz = Math.sqrt(clamp(1 - nx * nx));
  return put(out, o.z + barrel * 0.30 * nz, nx, nz, o.col, o.k ?? 1);
}

/**
 * A vertical round shaft: minaret, column, turret, drum.
 * `hw` may be a constant half-width or a function of v, which is how tapers and
 * balcony flanges are expressed.
 */
function column(out, u, v, o) {
  if (v < o.y0 || v > o.y1) return false;
  const hw = typeof o.hw === 'function' ? o.hw(v) : o.hw;
  if (hw <= 0) return false;
  const dx = (u - o.cx) / hw;
  if (dx < -1 || dx > 1) return false;
  const nz = Math.sqrt(clamp(1 - dx * dx));
  let k = o.k ?? 1;
  if (o.ribs) {
    const theta = Math.asin(clamp(dx, -1, 1));
    k *= 0.86 + 0.14 * Math.pow(Math.abs(Math.cos(theta * o.ribs)), 0.6);
  }
  return put(out, o.z + (o.bulge ?? 0.15) * nz, dx, nz, o.col, k);
}

/**
 * Dome profiles as half-width against s, where s runs 0 at the spring line to 1 at
 * the apex. `onion` is the Mughal bulb with a pinched neck; `lotus` is the flatter,
 * wider inverted-lotus of a Sikh gurdwara; `hemi` and `shallow` are spherical caps.
 */
const DOME_PROFILE = {
  hemi: (s) => Math.sqrt(clamp(1 - s * s)),
  shallow: (s) => {
    const a = 0.46;
    const t = a + (1 - a) * s;
    return Math.sqrt(clamp(1 - t * t)) / Math.sqrt(1 - a * a);
  },
  onion: (s) =>
    s < 0.32 ? 0.63 + 0.37 * (s / 0.32) : Math.pow(clamp(1 - ((s - 0.32) / 0.68) ** 2), 0.42),
  lotus: (s) =>
    s < 0.26 ? 0.6 + 0.4 * (s / 0.26) : Math.pow(clamp(1 - ((s - 0.26) / 0.74) ** 2), 0.4),
  stupa: (s) => Math.sqrt(clamp(1 - Math.pow(s * 0.97, 1.72))),
};

function dome(out, u, v, o) {
  const s = (o.yBase - v) / o.ry;
  if (s < 0 || s > 1) return false;
  const w = o.rx * DOME_PROFILE[o.profile ?? 'onion'](s);
  if (w <= 0) return false;
  const dx = (u - o.cx) / w;
  if (dx < -1 || dx > 1) return false;
  const nzx = Math.sqrt(clamp(1 - dx * dx));
  const nzy = Math.sqrt(clamp(1 - Math.pow(2 * s - 1, 2) * 0.72));
  const nz = nzx * nzy;
  let k = o.k ?? 1;
  if (o.ribs) {
    const theta = Math.asin(clamp(dx, -1, 1));
    k *= 0.87 + 0.13 * Math.pow(Math.abs(Math.cos(theta * o.ribs)), 0.5);
  }
  return put(out, o.z + (o.bulge ?? 0.15) * nz, dx * 0.92, nz, o.col, k);
}

/** A finial: thin mast with a couple of beads, sitting on top of a dome. */
function finial(out, u, v, o) {
  if (v < o.y0 || v > o.y1) return false;
  const t = (o.y1 - v) / (o.y1 - o.y0);
  let hw = o.hw * (1 - 0.55 * t);
  // Beads at a third and two thirds of the mast.
  for (const b of [0.34, 0.68]) {
    const d = Math.abs(t - b);
    if (d < 0.09) hw += o.hw * 1.9 * (1 - d / 0.09);
  }
  const dx = (u - o.cx) / hw;
  if (dx < -1 || dx > 1) return false;
  const nz = Math.sqrt(clamp(1 - dx * dx));
  return put(out, o.z + 0.1 * nz, dx, nz, o.col, o.k ?? 1);
}

/**
 * Is (u,v) inside an arch aperture? `pointed` gives the Islamic four-centred head,
 * `round` the Roman semicircle. Used to cut recesses out of a wall.
 */
function inArch(u, v, o) {
  if (u < o.x0 || u > o.x1 || v > o.yBottom) return false;
  const cx = (o.x0 + o.x1) * 0.5;
  const hw = (o.x1 - o.x0) * 0.5;
  if (v >= o.ySpring) return true;
  const t = (o.ySpring - v) / o.rise;
  if (t > 1) return false;
  const f = o.round ? Math.sqrt(clamp(1 - t * t)) : 1 - t * t * (1.5 - 0.5 * t);
  return Math.abs(u - cx) <= hw * f;
}

/**
 * How deep into an arch recess this pixel sits, 0 at the jamb to 1 at the centre.
 * Shading the recess by this is what stops an arch reading as a flat black hole.
 */
function archDepth(u, v, o) {
  const cx = (o.x0 + o.x1) * 0.5;
  const hw = (o.x1 - o.x0) * 0.5;
  return smoothstep(1, 0.35, Math.abs(u - cx) / hw) * smoothstep(0.04, 0.16, o.yBottom - v);
}

/** The top edge of a crenellated parapet, as a v value. Merlons peak at y0. */
function merlonTop(u, y0, period, h) {
  const p = phase(u, period);
  const d = Math.abs(p - 0.5) * 2;
  if (d > 0.62) return y0 + h;
  return y0 + h * Math.pow(d / 0.62, 3) * 0.5;
}

/** Half-width of a stepped pyramid (pidha roof, tiered facade) at height v. */
function stepped(v, tiers) {
  for (let i = 0; i < tiers.length - 1; i++) {
    const a = tiers[i];
    const b = tiers[i + 1];
    if (v >= a[0] && v <= b[0]) {
      const t = (v - a[0]) / (b[0] - a[0]);
      return lerp(a[1], b[1], t);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Environments — sky, ground, water. Consumed by the renderer, not by `hit`.
// ---------------------------------------------------------------------------

const SKY_WARM = { top: [96, 126, 168], horizon: [214, 178, 148], cloud: 40 };
const SKY_CLEAR = { top: [78, 118, 174], horizon: [198, 194, 186], cloud: 26 };
const SKY_DAWN = { top: [112, 118, 166], horizon: [232, 176, 132], cloud: 46 };
const SKY_MONSOON = { top: [104, 122, 146], horizon: [186, 184, 176], cloud: 54 };

const GROUND_DUST = { near: [66, 62, 46], far: [122, 112, 88] };
const GROUND_LAWN = { near: [58, 68, 44], far: [102, 112, 74] };
const GROUND_STONE = { near: [96, 92, 86], far: [148, 142, 132] };
const GROUND_STREET = { near: [72, 70, 68], far: [126, 122, 118] };

// ---------------------------------------------------------------------------
// 1. QUTUB MINAR — tapering fluted five-storey minaret
//    (the original hand-tuned geometry, preserved verbatim in behaviour)
// ---------------------------------------------------------------------------

const Q_TOP = 0.11;
const Q_BASE = 0.93;
const Q_STOREYS = [0.11, 0.3, 0.475, 0.625, 0.775, 0.93];

function qHalfWidth(v) {
  const t = clamp((v - Q_TOP) / (Q_BASE - Q_TOP));
  // Slight entasis: the real minar swells a little rather than tapering as a pure cone.
  let hw = lerp(0.062, 0.178, Math.pow(t, 1.18));
  for (let i = 1; i < Q_STOREYS.length - 1; i++) {
    const d = Math.abs(v - Q_STOREYS[i]);
    if (d < 0.018) hw = Math.max(hw, hw + (1 - d / 0.018) * 0.03);
  }
  return hw;
}

const qutubMinar = {
  W: 896,
  H: 1792,
  sky: SKY_WARM,
  ground: { y: 0.955, ...GROUND_LAWN },
  haze: { start: 0.62, amount: 0.2, col: [208, 190, 168] },
  hit(u, v, out) {
    if (v < Q_TOP || v > Q_BASE) return false;
    const hw = qHalfWidth(v);
    const dx = (u - 0.5) / hw;
    if (dx < -1 || dx > 1) return false;

    let s = Q_STOREYS.length - 2;
    for (let i = 0; i < Q_STOREYS.length - 1; i++) {
      if (v >= Q_STOREYS[i] && v < Q_STOREYS[i + 1]) { s = i; break; }
    }
    // Firoz Shah rebuilt the top two storeys in marble — they read lighter.
    const marble = s >= 4 ? 0 : s >= 3 ? 0.35 : 0;
    const upper = s >= 3;

    const theta = Math.asin(clamp(dx, -1, 1));
    const ribs = upper ? 16 : 24;
    let k = 0.86 + 0.14 * Math.pow(Math.abs(Math.cos(theta * ribs)), 0.6);

    // Carved inscription bands, then the hard shadow under each balcony.
    for (let i = 1; i < Q_STOREYS.length - 1; i++) {
      const d = Math.abs(v - (Q_STOREYS[i] - 0.03));
      if (d < 0.011) k = Math.min(k, k * (0.72 + 0.28 * (d / 0.011)));
      const b = v - Q_STOREYS[i];
      if (b > 0 && b < 0.014) k = Math.min(k, k * (0.42 + 0.58 * (b / 0.014)));
    }

    const col = [lerp(176, 226, marble), lerp(104, 196, marble), lerp(74, 168, marble)];
    const nz = Math.sqrt(clamp(1 - dx * dx));
    // The tower recedes as it rises: the crown is further away than the base.
    const z = 0.7 + nz * 0.3 - smoothstep(Q_BASE, Q_TOP, v) * 0.18;
    return put(out, z, dx, nz, col, k);
  },
};

// ---------------------------------------------------------------------------
// 2. TAJ MAHAL — domed mausoleum on a plinth, four flanking minarets, reflecting pool
// ---------------------------------------------------------------------------

const tajMahal = {
  W: 896,
  H: 1792,
  sky: SKY_DAWN,
  ground: { y: 0.664, ...GROUND_STONE },
  water: { y: 0.664, strength: 0.66, ripple: 0.003 },
  haze: { start: 0.44, amount: 0.13, col: [226, 206, 192] },
  hit(u, v, out) {
    const M = MAT.whiteMarble;
    const W2 = MAT.warmMarble;

    // ---- rear pair of minarets (furthest back, so drawn first) ----
    for (const cx of [0.258, 0.742]) {
      if (minaretTaj(out, u, v, cx, 0.336, 0.618, 0.0138, 0.62, W2)) return true;
    }
    // ---- the great dome, its drum, the chhatris and the finial ----
    if (finial(out, u, v, { cx: 0.5, y0: 0.208, y1: 0.262, hw: 0.004, z: 0.86, col: W2 })) return true;
    if (dome(out, u, v, { cx: 0.5, yBase: 0.382, rx: 0.099, ry: 0.108, z: 0.72, col: M, profile: 'onion', ribs: 11, bulge: 0.2 })) return true;
    // Drum under the dome, ringed with a band of blind arcading.
    if (v > 0.376 && v <= 0.424 && Math.abs(u - 0.5) < 0.082) {
      const p = phase(u + 0.041, 0.0164);
      const k = Math.abs(p - 0.5) < 0.28 ? 0.86 : 1.04;
      return slab(out, u, v, { x0: 0.418, x1: 0.582, y0: 0.376, y1: 0.424, z: 0.74, col: W2, k });
    }

    // Four corner chhatris of the roof terrace.
    for (const cx of [0.362, 0.638]) {
      if (finial(out, u, v, { cx, y0: 0.318, y1: 0.344, hw: 0.0026, z: 0.83, col: W2 })) return true;
      if (dome(out, u, v, { cx, yBase: 0.394, rx: 0.036, ry: 0.05, z: 0.76, col: M, profile: 'onion', ribs: 7 })) return true;
      // Kiosk pillars, with the shaded space between them.
      if (v > 0.394 && v < 0.428 && Math.abs(u - cx) < 0.033) {
        const p = phase(u - cx + 0.033, 0.022);
        const solid = Math.abs(p - 0.5) > 0.26;
        return put(out, 0.76, 0, 1, solid ? M : W2, solid ? 1.02 : 0.6);
      }
    }

    // ---- the main block, its corners chamfered off ----
    if (v >= 0.424 && v <= 0.63 && u >= 0.298 && u <= 0.702) {
      // The great central iwan.
      const iw = { x0: 0.436, x1: 0.564, ySpring: 0.518, yBottom: 0.63, rise: 0.058 };
      if (inArch(u, v, iw)) {
        const d = archDepth(u, v, iw);
        return put(out, 0.72 - 0.1 * d, 0.2, 0.94, MAT.shadow, 0.52 + 0.46 * (1 - d));
      }
      // Two tiers of smaller arched niches either side of the iwan.
      for (const cx of [0.348, 0.394, 0.606, 0.652]) {
        for (const yb of [0.524, 0.618]) {
          const a = { x0: cx - 0.0165, x1: cx + 0.0165, ySpring: yb - 0.05, yBottom: yb, rise: 0.026 };
          if (inArch(u, v, a)) {
            const d = archDepth(u, v, a);
            return put(out, 0.8 - 0.06 * d, 0.18, 0.95, MAT.shadow, 0.56 + 0.42 * (1 - d));
          }
        }
      }
      // Pishtaq frame around the iwan, plus the marble face.
      const framed = u > 0.42 && u < 0.58;
      let k = framed ? 1.04 : 1;
      // Chamfered corners read a shade darker as they turn away from the light.
      if (u < 0.324 || u > 0.676) k *= 0.9;
      // Inlaid string course and the calligraphic border of the pishtaq.
      if (Math.abs(v - 0.438) < 0.005) k *= 0.82;
      if (framed && (Math.abs(u - 0.4205) < 0.006 || Math.abs(u - 0.5795) < 0.006)) k *= 0.86;
      return slab(out, u, v, { x0: 0.298, x1: 0.702, y0: 0.424, y1: 0.63, z: 0.82, col: M, k });
    }

    // ---- front pair of minarets ----
    for (const cx of [0.146, 0.854]) {
      if (minaretTaj(out, u, v, cx, 0.312, 0.636, 0.0172, 0.86, M)) return true;
    }

    // ---- the marble plinth the whole thing stands on ----
    if (slab(out, u, v, { x0: 0.098, x1: 0.902, y0: 0.63, y1: 0.664, z: 0.9, col: W2, k: 0.92 })) return true;
    return false;
  },
};

/** A Taj minaret: three balconied drums, a chhatri and a finial. */
function minaretTaj(out, u, v, cx, y0, y1, hw, z, col) {
  const capBase = y0 + 0.036;
  if (finial(out, u, v, { cx, y0: y0 - 0.028, y1: y0 - 0.004, hw: hw * 0.24, z: z + 0.02, col })) return true;
  if (dome(out, u, v, { cx, yBase: capBase, rx: hw * 1.5, ry: 0.032, z, col, profile: 'onion', ribs: 6 })) return true;
  const shaft = (vv) => {
    let w = hw * lerp(1.0, 1.16, clamp((vv - capBase) / (y1 - capBase)));
    for (const b of [0.42, 0.62]) {
      const by = lerp(capBase, y1, b);
      const d = Math.abs(vv - by);
      if (d < 0.009) w += hw * 0.42 * (1 - d / 0.009);
    }
    return w;
  };
  if (v >= capBase && v <= y1) {
    if (column(out, u, v, { cx, y0: capBase, y1, hw: shaft, z, col, ribs: 10 })) {
      for (const b of [0.42, 0.62]) {
        const by = lerp(capBase, y1, b);
        const d = v - by;
        if (d > 0 && d < 0.008) out.k *= 0.48 + 0.52 * (d / 0.008);
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. RED FORT — battlemented sandstone curtain wall with the Lahori Gate
// ---------------------------------------------------------------------------

const redFort = {
  W: 1008,
  H: 1344,
  sky: SKY_WARM,
  ground: { y: 0.87, ...GROUND_DUST },
  haze: { start: 0.55, amount: 0.18, col: [214, 186, 156] },
  hit(u, v, out) {
    const R = MAT.redSandstone;
    const RD = [150, 82, 58];

    // ---- the long curtain wall, crenellated ----
    const wallTop = merlonTop(u, 0.415, 0.0295, 0.026);
    if (v >= wallTop && v <= 0.87) {
      // Semicircular bastions punctuating the wall.
      let onBastion = false;
      for (const bx of [0.075, 0.215, 0.855]) {
        if (Math.abs(u - bx) < 0.036) { onBastion = true; break; }
      }
      // Recessed blind arcading along the wall face.
      let k = 1;
      const p = phase(u, 0.0492);
      if (v > 0.52 && v < 0.74) {
        const a = { x0: 0, x1: 1, ySpring: 0.6, yBottom: 0.74, rise: 0.05 };
        void a;
        const d = Math.abs(p - 0.5) * 2;
        const head = 0.6 - 0.048 * Math.sqrt(clamp(1 - d * d * 1.6));
        if (d < 0.56 && v > head) k = 0.62 + 0.2 * d;
      }
      // String course.
      if (Math.abs(v - 0.5) < 0.006) k *= 0.78;
      if (onBastion) {
        const bx = [0.075, 0.215, 0.855].find((b) => Math.abs(u - b) < 0.036);
        return column(out, u, v, { cx: bx, y0: wallTop, y1: 0.87, hw: 0.036, z: 0.78, col: R, k: k * 1.02, bulge: 0.14 });
      }
      if (u < 0.335 || u > 0.665) {
        return slab(out, u, v, { x0: 0, x1: 1, y0: wallTop, y1: 0.87, z: 0.74, col: R, k });
      }
    }

    // ---- the Lahori Gate: a taller block between two octagonal towers ----
    // Tower cupolas and finials sit furthest up; draw the towers first.
    for (const cx of [0.372, 0.628]) {
      if (finial(out, u, v, { cx, y0: 0.146, y1: 0.176, hw: 0.0038, z: 0.88, col: MAT.whiteMarble })) return true;
      if (dome(out, u, v, { cx, yBase: 0.232, rx: 0.034, ry: 0.058, z: 0.84, col: MAT.whiteMarble, profile: 'onion', ribs: 7 })) return true;
      // Open chhatri pillars beneath the cupola.
      if (v > 0.232 && v < 0.268 && Math.abs(u - cx) < 0.034) {
        const pp = phase(u - cx + 0.034, 0.0227);
        const solid = Math.abs(pp - 0.5) > 0.26;
        return put(out, 0.84, 0, 1, solid ? MAT.whiteMarble : MAT.shadow, solid ? 1 : 0.5);
      }
      const towerTop = merlonTop(u, 0.268, 0.0165, 0.016);
      if (v >= towerTop && v <= 0.87 && Math.abs(u - cx) < 0.041) {
        // Octagonal, so it reads with two chamfer seams rather than a smooth curve.
        const dx = (u - cx) / 0.041;
        const facet = Math.abs(dx) < 0.38 ? 1 : Math.abs(dx) < 0.78 ? 0.9 : 0.74;
        let k = facet;
        if (Math.abs(v - 0.4) < 0.005 || Math.abs(v - 0.56) < 0.005) k *= 0.76;
        return put(out, 0.86 + 0.1 * Math.sqrt(clamp(1 - dx * dx)), dx * 0.8, Math.sqrt(clamp(1 - dx * dx)), R, k);
      }
    }

    // ---- the gate block itself ----
    const gateTop = merlonTop(u, 0.316, 0.0245, 0.022);
    if (v >= gateTop && v <= 0.87 && u >= 0.335 && u <= 0.665) {
      // The great entrance arch.
      const g = { x0: 0.446, x1: 0.554, ySpring: 0.63, yBottom: 0.87, rise: 0.078 };
      if (inArch(u, v, g)) {
        const d = archDepth(u, v, g);
        // The gate is a tunnel: it genuinely recedes, and the depth map says so.
        return put(out, 0.66 - 0.12 * d, 0.16, 0.95, MAT.deepShadow, 0.34 + 0.5 * (1 - d));
      }
      // Row of small arched windows above the gate.
      for (const cx of [0.386, 0.424, 0.576, 0.614]) {
        const a = { x0: cx - 0.0125, x1: cx + 0.0125, ySpring: 0.52, yBottom: 0.575, rise: 0.024 };
        if (inArch(u, v, a)) return put(out, 0.78, 0.15, 0.96, MAT.shadow, 0.5);
      }
      for (const cx of [0.463, 0.5, 0.537]) {
        const a = { x0: cx - 0.0105, x1: cx + 0.0105, ySpring: 0.42, yBottom: 0.47, rise: 0.022 };
        if (inArch(u, v, a)) return put(out, 0.78, 0.15, 0.96, MAT.shadow, 0.5);
      }
      let k = 1;
      // Marble-inlaid framing band around the entrance.
      if (Math.abs(u - 0.4335) < 0.007 || Math.abs(u - 0.5665) < 0.007) k *= 0.88;
      if (Math.abs(v - 0.352) < 0.006 || Math.abs(v - 0.6) < 0.005) k *= 0.8;
      return slab(out, u, v, { x0: 0.335, x1: 0.665, y0: gateTop, y1: 0.87, z: 0.82, col: RD, k });
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// 4. GATEWAY OF INDIA — triumphal arch on the harbour, seen across the water
// ---------------------------------------------------------------------------

const gatewayOfIndia = {
  W: 896,
  H: 1792,
  sky: SKY_MONSOON,
  ground: { y: 0.795, ...GROUND_STONE },
  water: { y: 0.815, strength: 0.42, ripple: 0.006 },
  haze: { start: 0.55, amount: 0.2, col: [204, 202, 194] },
  hit(u, v, out) {
    const B = MAT.basaltYellow;
    const BD = [166, 144, 100];

    // ---- the shallow central dome behind the arch ----
    if (finial(out, u, v, { cx: 0.5, y0: 0.222, y1: 0.256, hw: 0.0042, z: 0.72, col: BD })) return true;
    if (dome(out, u, v, { cx: 0.5, yBase: 0.322, rx: 0.098, ry: 0.07, z: 0.62, col: BD, profile: 'shallow', ribs: 12 })) return true;

    // ---- four corner turrets with their small ribbed cupolas ----
    for (const cx of [0.257, 0.743]) {
      if (finial(out, u, v, { cx, y0: 0.222, y1: 0.244, hw: 0.003, z: 0.86, col: B })) return true;
      if (dome(out, u, v, { cx, yBase: 0.29, rx: 0.032, ry: 0.048, z: 0.8, col: B, profile: 'onion', ribs: 8 })) return true;
      const t = merlonTop(u, 0.29, 0.0132, 0.012);
      if (v >= t && v <= 0.44 && Math.abs(u - cx) < 0.038) {
        let k = 1;
        if (Math.abs(v - 0.35) < 0.005) k *= 0.78;
        return column(out, u, v, { cx, y0: t, y1: 0.44, hw: 0.038, z: 0.84, col: B, k, bulge: 0.12 });
      }
    }

    // ---- side halls, lower than the central mass ----
    for (const [x0, x1] of [[0.208, 0.34], [0.66, 0.792]]) {
      if (v >= 0.408 && v <= 0.786 && u >= x0 && u <= x1) {
        const cx = (x0 + x1) * 0.5;
        // A pair of arched openings in each hall.
        for (const ax of [cx - 0.032, cx + 0.032]) {
          const a = { x0: ax - 0.021, x1: ax + 0.021, ySpring: 0.62, yBottom: 0.786, rise: 0.042 };
          if (inArch(u, v, a)) {
            const d = archDepth(u, v, a);
            return put(out, 0.76 - 0.08 * d, 0.16, 0.96, MAT.shadow, 0.42 + 0.45 * (1 - d));
          }
        }
        let k = 1;
        // Perforated stone screen band.
        if (v > 0.43 && v < 0.49) {
          const j = phase(u, 0.0125) - 0.5;
          const jv = phase(v, 0.0125) - 0.5;
          k *= Math.abs(j) < 0.28 && Math.abs(jv) < 0.28 ? 0.6 : 1.05;
        }
        if (Math.abs(v - 0.418) < 0.006) k *= 0.8;
        return slab(out, u, v, { x0, x1, y0: 0.408, y1: 0.786, z: 0.84, col: B, k });
      }
    }

    // ---- the central mass with the great arch cut through it ----
    if (v >= 0.312 && v <= 0.786 && u >= 0.218 && u <= 0.782) {
      const g = { x0: 0.393, x1: 0.607, ySpring: 0.52, yBottom: 0.786, rise: 0.115 };
      if (inArch(u, v, g)) {
        // You look right through the Gateway to the harbour beyond, so the far
        // wall of the arch sits a long way back and the coffered vault catches
        // a little light near the crown.
        const d = archDepth(u, v, g);
        const vault = smoothstep(0.52, 0.4, v) * 0.5;
        return put(out, 0.58 - 0.14 * d, 0.12, 0.96, MAT.deepShadow, 0.3 + 0.34 * (1 - d) + vault);
      }
      let k = 1;
      // The moulded archivolt, then the cornice and the plinth band.
      const cx = 0.5;
      const rr = Math.hypot((u - cx) / 0.128, (0.52 - v) / 0.138);
      if (v < 0.53 && rr > 1 && rr < 1.13) k *= 0.86;
      if (Math.abs(v - 0.336) < 0.007) k *= 0.78;
      if (Math.abs(v - 0.372) < 0.005) k *= 0.9;
      if (Math.abs(v - 0.756) < 0.006) k *= 0.82;
      // Small niches flanking the arch.
      for (const nx2 of [0.302, 0.698]) {
        const a = { x0: nx2 - 0.024, x1: nx2 + 0.024, ySpring: 0.5, yBottom: 0.6, rise: 0.036 };
        if (inArch(u, v, a)) return put(out, 0.8, 0.14, 0.96, MAT.shadow, 0.48);
      }
      return slab(out, u, v, { x0: 0.218, x1: 0.782, y0: 0.312, y1: 0.786, z: 0.88, col: B, k });
    }

    // ---- the quay the Gateway stands on ----
    if (slab(out, u, v, { x0: 0.14, x1: 0.86, y0: 0.786, y1: 0.815, z: 0.94, col: MAT.greyGranite, k: 0.85 })) return true;
    return false;
  },
};

// ---------------------------------------------------------------------------
// 5. HAWA MAHAL — five-storey honeycomb facade of jharokhas
// ---------------------------------------------------------------------------

// Tiers run bottom to top: [v, halfWidth]. Each boundary throws a cornice flange.
const HM_TIERS = [
  [0.9, 0.428], [0.66, 0.428], [0.655, 0.402], [0.578, 0.402],
  [0.573, 0.354], [0.5, 0.354], [0.495, 0.292], [0.424, 0.292],
  [0.419, 0.213], [0.352, 0.213], [0.347, 0.128], [0.286, 0.128],
];

const hawaMahal = {
  W: 896,
  H: 1792,
  sky: SKY_CLEAR,
  ground: { y: 0.915, ...GROUND_STREET },
  haze: { start: 0.6, amount: 0.15, col: [216, 198, 184] },
  hit(u, v, out) {
    const P = MAT.pinkSandstone;
    const WHITE = [236, 230, 222];

    // Crowning kiosks along the top ridge.
    if (v < 0.288) {
      for (const cx of [0.5, 0.418, 0.582]) {
        const rx = cx === 0.5 ? 0.03 : 0.023;
        if (dome(out, u, v, { cx, yBase: 0.286, rx, ry: rx * 1.35, z: 0.8, col: P, profile: 'onion', ribs: 6 })) return true;
      }
      return false;
    }
    if (v > 0.915) return false;

    const hw = stepped(v, HM_TIERS);
    if (hw <= 0) return false;
    const dx = (u - 0.5) / hw;
    if (dx < -1 || dx > 1) return false;

    // The facade is very slightly convex — Hawa Mahal's screen curves with the street.
    const nx = dx * 0.34;
    const nz = Math.sqrt(clamp(1 - nx * nx));
    const z = 0.78 + 0.13 * nz;

    // Cornice flange at every tier boundary: a bright lip with a shadow beneath.
    let k = 1;
    let col = P;
    for (let i = 1; i < HM_TIERS.length - 1; i += 2) {
      const by = HM_TIERS[i][0];
      const d = v - by;
      if (d > -0.008 && d < 0.002) { k = 1.25; col = WHITE; }
      else if (d >= 0.002 && d < 0.014) k = 0.5 + 0.5 * ((d - 0.002) / 0.012);
    }
    if (k !== 1) return put(out, z + 0.03, nx, nz, col, k);

    // ---- the honeycomb: a grid of arched jharokha windows ----
    // Ground storey is a plain arcade; the five screen storeys above are the lattice.
    if (v > 0.68) {
      const cell = 0.0585;
      const p = phase(u, cell);
      const a = { x0: 0, x1: 1, ySpring: 0.79, yBottom: 0.898, rise: 0.052 };
      void a;
      const d = Math.abs(p - 0.5) * 2;
      const head = 0.79 - 0.05 * (1 - d * d * (1.5 - 0.5 * d));
      if (d < 0.6 && v > head && v < 0.898) {
        const rec = smoothstep(0.6, 0.1, d);
        return put(out, z - 0.09 * rec, nx, nz, MAT.shadow, 0.34 + 0.3 * (1 - rec));
      }
      return put(out, z, nx, nz, P, 1 + (Math.abs(p - 0.5) < 0.06 ? 0.06 : 0));
    }

    const cu = 0.0326;
    const cv = 0.0378;
    const pu = phase(u + cu * 0.5, cu);
    const pv = phase(v + 0.0031, cv);
    const du = Math.abs(pu - 0.5) * 2;

    // Each cell: a small domed canopy over a cusped arched opening, framed in white.
    if (pv < 0.3) {
      // canopy
      const t = pv / 0.3;
      const w = Math.sqrt(clamp(1 - (1 - t) * (1 - t)));
      if (du <= w * 0.86) return put(out, z + 0.02, nx, nz, WHITE, 1.16 - 0.2 * du);
      return put(out, z, nx, nz, P, 0.96);
    }
    // window head and jambs
    const t2 = clamp((pv - 0.3) / 0.24);
    const wOpen = 0.66 * (t2 < 1 ? 1 - (1 - t2) * (1 - t2) * (1.5 - 0.5 * (1 - t2)) : 1);
    if (du <= wOpen && pv < 0.9) {
      const rec = smoothstep(wOpen, 0, du) * smoothstep(0.3, 0.44, pv);
      return put(out, z - 0.075 * rec, nx, nz, MAT.shadow, 0.3 + 0.34 * (1 - rec));
    }
    if (du <= wOpen + 0.14 && pv < 0.93) return put(out, z + 0.012, nx, nz, WHITE, 1.1);
    return put(out, z, nx, nz, P, 0.98 + 0.06 * (1 - du));
  },
};

// ---------------------------------------------------------------------------
// 6. CHARMINAR — square arcaded base carrying four balconied minarets
// ---------------------------------------------------------------------------

const charminar = {
  W: 896,
  H: 1792,
  sky: SKY_WARM,
  ground: { y: 0.905, ...GROUND_STREET },
  haze: { start: 0.62, amount: 0.17, col: [212, 194, 170] },
  hit(u, v, out) {
    const S = MAT.limeStucco;
    const SD = [190, 176, 150];

    // ---- the rear pair of minarets, only their tops clear the roofline ----
    for (const cx of [0.352, 0.648]) {
      if (charMinaret(out, u, v, cx, 0.5, 0.0335, 0.66, SD)) return true;
    }
    // ---- the mosque on the terrace ----
    if (dome(out, u, v, { cx: 0.5, yBase: 0.474, rx: 0.044, ry: 0.05, z: 0.7, col: SD, profile: 'onion', ribs: 8 })) return true;
    for (const cx of [0.418, 0.582]) {
      if (dome(out, u, v, { cx, yBase: 0.482, rx: 0.024, ry: 0.028, z: 0.7, col: SD, profile: 'onion' })) return true;
    }

    // ---- the front pair of minarets, full height ----
    for (const cx of [0.258, 0.742]) {
      if (charMinaret(out, u, v, cx, 0.905, 0.043, 0.9, S)) return true;
    }

    // ---- the terrace parapet ----
    const parTop = merlonTop(u, 0.486, 0.0172, 0.016);
    if (v >= parTop && v <= 0.53 && u >= 0.222 && u <= 0.778) {
      return slab(out, u, v, { x0: 0.222, x1: 0.778, y0: parTop, y1: 0.53, z: 0.82, col: S, k: 1.02 });
    }

    // ---- the square base with its four great arches ----
    if (v >= 0.53 && v <= 0.905 && u >= 0.232 && u <= 0.768) {
      const g = { x0: 0.372, x1: 0.628, ySpring: 0.716, yBottom: 0.905, rise: 0.098 };
      if (inArch(u, v, g)) {
        // You can see straight through Charminar; the far arch is a bright slot
        // low in the opening, and the vault above it is deep shadow.
        const d = archDepth(u, v, g);
        const through = smoothstep(0.83, 0.895, v) * smoothstep(0.42, 0.2, Math.abs(u - 0.5) / 0.128);
        const col = through > 0.5 ? MAT.greyGranite : MAT.deepShadow;
        return put(out, 0.62 - 0.14 * d + through * 0.05, 0.12, 0.96, col, 0.3 + 0.34 * (1 - d) + through * 0.5);
      }
      let k = 1;
      // Corner piers read a shade darker than the recessed arch spandrels.
      if (u < 0.31 || u > 0.69) k *= 0.95;
      // The moulded archivolt and the two string courses.
      const rr = Math.hypot((u - 0.5) / 0.156, (0.716 - v) / 0.126);
      if (v < 0.73 && rr > 1 && rr < 1.1) k *= 0.84;
      if (Math.abs(v - 0.556) < 0.006) k *= 0.78;
      if (Math.abs(v - 0.64) < 0.005) k *= 0.88;
      // The clock faces added in the nineteenth century.
      const cl = Math.hypot((u - 0.5) / 0.03, (v - 0.6) / 0.03);
      if (cl < 1) k *= cl > 0.86 ? 0.7 : 1.24;
      // Small balustraded balconies over the arch.
      for (const bx of [0.318, 0.682]) {
        if (Math.abs(u - bx) < 0.03 && v > 0.66 && v < 0.7) k *= phase(u, 0.0075) < 0.5 ? 1.1 : 0.72;
      }
      return slab(out, u, v, { x0: 0.232, x1: 0.768, y0: 0.53, y1: 0.905, z: 0.86, col: S, k });
    }
    return false;
  },
};

/** A Charminar minaret: four storeys of balconies under a petalled onion dome. */
function charMinaret(out, u, v, cx, yBottom, hw, z, col) {
  const top = 0.148;
  const domeBase = 0.238;
  if (finial(out, u, v, { cx, y0: top - 0.026, y1: top, hw: hw * 0.11, z: z + 0.02, col })) return true;
  if (dome(out, u, v, { cx, yBase: domeBase, rx: hw * 0.86, ry: 0.09, z, col, profile: 'onion', ribs: 9 })) return true;
  const balconies = [0.318, 0.404, 0.5, 0.62, 0.75];
  const shaft = (vv) => {
    let w = hw * lerp(0.62, 1.0, clamp((vv - domeBase) / (yBottom - domeBase)));
    for (const b of balconies) {
      const d = Math.abs(vv - b);
      if (d < 0.011) w += hw * 0.24 * (1 - d / 0.011);
    }
    return w;
  };
  if (v < domeBase || v > yBottom) return false;
  if (!column(out, u, v, { cx, y0: domeBase, y1: yBottom, hw: shaft, z, col, ribs: 12 })) return false;
  for (const b of balconies) {
    const d = v - b;
    if (d > 0 && d < 0.01) out.k *= 0.45 + 0.55 * (d / 0.01);
    if (d < 0 && d > -0.012) out.k *= 1.12;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 7. KONARK SUN TEMPLE — the surviving jagamohana, a stepped pidha roof on the
//    carved chariot plinth with its stone wheels
// ---------------------------------------------------------------------------

const K_TIERS = [
  [0.735, 0.268], [0.505, 0.268], [0.5, 0.252], [0.41, 0.196],
  [0.405, 0.182], [0.335, 0.134], [0.33, 0.122], [0.282, 0.076],
];

const konarkSunTemple = {
  W: 896,
  H: 1792,
  sky: SKY_CLEAR,
  ground: { y: 0.9, ...GROUND_DUST },
  haze: { start: 0.6, amount: 0.16, col: [206, 200, 188] },
  hit(u, v, out) {
    const K = MAT.khondalite;

    // ---- kalasha and amalaka crowning the roof ----
    if (finial(out, u, v, { cx: 0.5, y0: 0.212, y1: 0.248, hw: 0.008, z: 0.78, col: K })) return true;
    if (dome(out, u, v, { cx: 0.5, yBase: 0.282, rx: 0.062, ry: 0.036, z: 0.76, col: K, profile: 'shallow', ribs: 14 })) return true;

    // ---- the pidha roof: three tiers of receding horizontal courses ----
    if (v >= 0.282 && v <= 0.735) {
      const hw = stepped(v, K_TIERS);
      const dx = (u - 0.5) / hw;
      if (dx >= -1 && dx <= 1) {
        const nz = Math.sqrt(clamp(1 - dx * dx * 0.55));
        const z = 0.74 + 0.12 * nz;
        // Each course is a flat step with a shadowed underside — the pidha rhythm.
        const course = 0.0182;
        const p = phase(v, course);
        let k = p < 0.24 ? 1.22 : p < 0.42 ? 0.56 + 0.4 * ((p - 0.24) / 0.18) : 1;
        // Recessed vertical channel up the centre of each face.
        if (Math.abs(dx) < 0.09) k *= 0.9;
        // Tier boundaries carry a heavy moulded band.
        for (const b of [0.5, 0.405, 0.33]) {
          if (Math.abs(v - b) < 0.008) k *= 0.72;
        }
        return put(out, z, dx * 0.7, nz, K, k);
      }
    }

    // ---- the cubic sanctum wall, heavily carved ----
    if (v > 0.735 && v <= 0.815 && u >= 0.212 && u <= 0.788) {
      // Register of niches with standing figures.
      const p = phase(u, 0.0722);
      const d = Math.abs(p - 0.5) * 2;
      let k = 1;
      if (d < 0.5 && v > 0.752 && v < 0.805) k = 0.62 + 0.34 * d;
      if (Math.abs(v - 0.742) < 0.005) k *= 1.14;
      return slab(out, u, v, { x0: 0.212, x1: 0.788, y0: 0.735, y1: 0.815, z: 0.84, col: K, k });
    }

    // ---- the chariot plinth and its wheels ----
    if (v > 0.815 && v <= 0.9 && u >= 0.16 && u <= 0.84) {
      for (const wx of [0.268, 0.5, 0.732]) {
        const dx = (u - wx) / 0.06;
        const dy = (v - 0.858) / 0.06;
        const rr = Math.hypot(dx, dy);
        if (rr <= 1) {
          // A wheel in relief: raised rim, sixteen spokes, a carved hub.
          const ang = Math.atan2(dy, dx);
          const spoke = Math.abs(Math.cos(ang * 8));
          let k;
          if (rr > 0.84) k = 1.24 - 0.3 * Math.abs(rr - 0.92) / 0.08;
          else if (rr < 0.19) k = 1.18;
          else k = spoke > 0.86 ? 1.12 : 0.62 + 0.3 * spoke;
          const bump = Math.sqrt(clamp(1 - rr * rr)) * 0.05;
          return put(out, 0.9 + bump, dx * 0.5, 0.94, K, k);
        }
      }
      const p = phase(u, 0.0181);
      const k = 0.86 + 0.24 * Math.abs(p - 0.5) * 2;
      return slab(out, u, v, { x0: 0.16, x1: 0.84, y0: 0.815, y1: 0.9, z: 0.9, col: MAT.laterite, k });
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// 8. MYSORE PALACE — three-storey granite facade, arcades, pink marble domes
// ---------------------------------------------------------------------------

const mysorePalace = {
  W: 1008,
  H: 1344,
  sky: SKY_DAWN,
  ground: { y: 0.895, ...GROUND_LAWN },
  haze: { start: 0.6, amount: 0.14, col: [214, 200, 190] },
  hit(u, v, out) {
    const G = MAT.greyGranite;
    const GD = [126, 126, 124];
    const PM = MAT.pinkMarble;

    // ---- the five-storey central tower and its gilded dome ----
    if (finial(out, u, v, { cx: 0.5, y0: 0.108, y1: 0.15, hw: 0.005, z: 0.74, col: MAT.gold })) return true;
    if (dome(out, u, v, { cx: 0.5, yBase: 0.256, rx: 0.062, ry: 0.108, z: 0.68, col: PM, profile: 'onion', ribs: 10 })) return true;
    // Open kiosk stage under the dome.
    if (v > 0.256 && v <= 0.304 && Math.abs(u - 0.5) < 0.062) {
      const p = phase(u + 0.031, 0.031);
      const solid = Math.abs(p - 0.5) > 0.28;
      return put(out, 0.7, 0, 1, solid ? PM : MAT.shadow, solid ? 1.05 : 0.5);
    }
    if (v > 0.304 && v <= 0.47 && Math.abs(u - 0.5) < 0.058) {
      let k = 1;
      const p = phase(v, 0.055);
      if (p < 0.14) k *= 1.2;
      const a = { x0: 0.468, x1: 0.532, ySpring: 0.42, yBottom: 0.462, rise: 0.028 };
      if (inArch(u, v, a)) return put(out, 0.7, 0.14, 0.96, MAT.shadow, 0.48);
      return slab(out, u, v, { x0: 0.442, x1: 0.558, y0: 0.304, y1: 0.47, z: 0.74, col: G, k });
    }

    // ---- flanking domes on the wings ----
    for (const cx of [0.196, 0.804]) {
      if (finial(out, u, v, { cx, y0: 0.318, y1: 0.348, hw: 0.0035, z: 0.86, col: MAT.gold })) return true;
      if (dome(out, u, v, { cx, yBase: 0.428, rx: 0.046, ry: 0.076, z: 0.8, col: PM, profile: 'onion', ribs: 9 })) return true;
      if (v > 0.428 && v <= 0.52 && Math.abs(u - cx) < 0.05) {
        const a = { x0: cx - 0.03, x1: cx + 0.03, ySpring: 0.492, yBottom: 0.52, rise: 0.03 };
        if (inArch(u, v, a)) return put(out, 0.82, 0.14, 0.96, MAT.shadow, 0.5);
        return slab(out, u, v, { x0: cx - 0.05, x1: cx + 0.05, y0: 0.428, y1: 0.52, z: 0.84, col: G });
      }
    }
    for (const cx of [0.336, 0.664]) {
      if (dome(out, u, v, { cx, yBase: 0.468, rx: 0.032, ry: 0.05, z: 0.82, col: PM, profile: 'onion', ribs: 8 })) return true;
      if (v > 0.468 && v <= 0.54 && Math.abs(u - cx) < 0.034) {
        return slab(out, u, v, { x0: cx - 0.034, x1: cx + 0.034, y0: 0.468, y1: 0.54, z: 0.86, col: G });
      }
    }

    // ---- the central porch, projecting toward the visitor ----
    if (v >= 0.47 && v <= 0.895 && u >= 0.398 && u <= 0.602) {
      const a = { x0: 0.436, x1: 0.564, ySpring: 0.7, yBottom: 0.895, rise: 0.066 };
      if (inArch(u, v, a)) {
        const d = archDepth(u, v, a);
        return put(out, 0.82 - 0.1 * d, 0.14, 0.96, MAT.deepShadow, 0.34 + 0.4 * (1 - d));
      }
      let k = 1;
      if (Math.abs(v - 0.486) < 0.007) k *= 1.16;
      if (Math.abs(v - 0.63) < 0.006) k *= 0.8;
      // Paired columns either side of the porch arch.
      for (const px of [0.418, 0.582]) {
        if (Math.abs(u - px) < 0.011 && v > 0.63) {
          const dxp = (u - px) / 0.011;
          return put(out, 0.94 + 0.08 * Math.sqrt(clamp(1 - dxp * dxp)), dxp, Math.sqrt(clamp(1 - dxp * dxp)), G, 1.06);
        }
      }
      return slab(out, u, v, { x0: 0.398, x1: 0.602, y0: 0.47, y1: 0.895, z: 0.9, col: GD, k });
    }

    // ---- the long wings: two storeys of arcading ----
    if (v >= 0.52 && v <= 0.895 && u >= 0.052 && u <= 0.948) {
      // Upper arcade, then lower arcade, on a repeating bay.
      for (const [ys, yb, rise] of [[0.6, 0.648, 0.03], [0.76, 0.86, 0.05]]) {
        const bay = 0.0448;
        const p = phase(u + bay * 0.5, bay);
        const d = Math.abs(p - 0.5) * 2;
        const head = ys - rise * (1 - d * d * (1.5 - 0.5 * d));
        if (d < 0.58 && v > head && v < yb) {
          const rec = smoothstep(0.58, 0.05, d);
          return put(out, 0.86 - 0.08 * rec, 0.14, 0.96, MAT.shadow, 0.34 + 0.34 * (1 - rec));
        }
      }
      let k = 1;
      if (Math.abs(v - 0.532) < 0.007) k *= 1.14;
      if (Math.abs(v - 0.69) < 0.006) k *= 0.82;
      if (Math.abs(v - 0.874) < 0.006) k *= 0.86;
      return slab(out, u, v, { x0: 0.052, x1: 0.948, y0: 0.52, y1: 0.895, z: 0.86, col: G, k });
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// 9. GOLDEN TEMPLE — the gilded sanctum standing in the sarovar, seen across water
// ---------------------------------------------------------------------------

const goldenTemple = {
  W: 1008,
  H: 1344,
  sky: SKY_DAWN,
  ground: { y: 0.58, ...GROUND_STONE },
  water: { y: 0.6, strength: 0.62, ripple: 0.0045 },
  haze: { start: 0.3, amount: 0.14, col: [216, 202, 190] },
  hit(u, v, out) {
    const M = MAT.whiteMarble;
    const G = MAT.gold;
    const BG = MAT.brightGold;

    // ---- the far parikrama: the white arcaded walk on the other side of the tank ----
    if (v >= 0.452 && v <= 0.512 && (u < 0.318 || u > 0.682)) {
      const p = phase(u, 0.021);
      const k = Math.abs(p - 0.5) < 0.26 ? 0.68 : 1.06;
      return slab(out, u, v, { x0: 0, x1: 1, y0: 0.452, y1: 0.512, z: 0.4, col: M, k, barrel: 0.02 });
    }

    // ---- the sanctum: gilded dome, chhatris, two storeys, marble plinth ----
    if (finial(out, u, v, { cx: 0.5, y0: 0.166, y1: 0.212, hw: 0.0048, z: 0.78, col: BG })) return true;
    if (dome(out, u, v, { cx: 0.5, yBase: 0.318, rx: 0.062, ry: 0.106, z: 0.72, col: G, profile: 'lotus', ribs: 11 })) return true;

    // Corner and intermediate kiosks on the parapet.
    for (const [cx, rx] of [[0.383, 0.03], [0.617, 0.03], [0.432, 0.019], [0.568, 0.019]]) {
      if (dome(out, u, v, { cx, yBase: 0.372, rx, ry: rx * 1.5, z: 0.76, col: G, profile: 'lotus', ribs: 7 })) return true;
    }

    // Upper storey.
    const parTop = merlonTop(u, 0.368, 0.0132, 0.012);
    if (v >= parTop && v <= 0.478 && u >= 0.394 && u <= 0.606) {
      const a = { x0: 0.462, x1: 0.538, ySpring: 0.44, yBottom: 0.478, rise: 0.03 };
      if (inArch(u, v, a)) return put(out, 0.78, 0.14, 0.96, MAT.shadow, 0.5);
      let k = 1;
      // Repoussé gold panelling catches the light in vertical strips.
      const p = phase(u, 0.0106);
      k *= 0.92 + 0.22 * Math.abs(p - 0.5) * 2;
      if (Math.abs(v - 0.386) < 0.006) k *= 1.2;
      return slab(out, u, v, { x0: 0.394, x1: 0.606, y0: parTop, y1: 0.478, z: 0.8, col: G, k });
    }

    // Lower storey: gold above, marble below the dado line.
    if (v > 0.478 && v <= 0.594 && u >= 0.352 && u <= 0.648) {
      for (const cx of [0.5, 0.408, 0.592]) {
        const w = cx === 0.5 ? 0.036 : 0.024;
        const a = { x0: cx - w, x1: cx + w, ySpring: 0.55, yBottom: 0.594, rise: 0.036 };
        if (inArch(u, v, a)) {
          const d = archDepth(u, v, a);
          // The doorway on each of the four sides — open to everyone, in every direction.
          return put(out, 0.82 - 0.08 * d, 0.14, 0.96, MAT.deepShadow, 0.36 + 0.4 * (1 - d));
        }
      }
      const marbleLine = 0.556;
      const col = v > marbleLine ? M : G;
      let k = 1;
      if (v <= marbleLine) {
        const p = phase(u, 0.0106);
        k *= 0.92 + 0.22 * Math.abs(p - 0.5) * 2;
      } else {
        // Pietra dura inlay panels on the marble dado.
        const p = phase(u, 0.0212);
        k *= Math.abs(p - 0.5) < 0.3 ? 0.94 : 1.04;
      }
      if (Math.abs(v - marbleLine) < 0.005) k *= 1.18;
      if (Math.abs(v - 0.49) < 0.005) k *= 1.16;
      return slab(out, u, v, { x0: 0.352, x1: 0.648, y0: 0.478, y1: 0.594, z: 0.84, col, k });
    }

    // The marble edge where the building meets the water.
    if (slab(out, u, v, { x0: 0.34, x1: 0.66, y0: 0.594, y1: 0.6, z: 0.88, col: M, k: 1.1 })) return true;

    // ---- the causeway running toward the viewer, with its railing lamps ----
    if (v > 0.6 && v <= 0.9) {
      const t = (v - 0.6) / 0.3;
      const hwC = lerp(0.036, 0.108, t * t * 0.9 + t * 0.1);
      const dxC = (u - 0.5) / hwC;
      if (dxC >= -1 && dxC <= 1) {
        const z = lerp(0.72, 0.99, t);
        // Railing posts along both edges.
        const edge = Math.abs(dxC) > 0.82;
        if (edge) {
          const p = phase(v, lerp(0.012, 0.03, t));
          return put(out, z + 0.02, dxC * 0.3, 0.95, M, p < 0.42 ? 1.2 : 0.72);
        }
        const p = phase(v, lerp(0.01, 0.028, t));
        return put(out, z, 0, 1, M, 0.96 + 0.12 * (p < 0.1 ? 1 : 0));
      }
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// 10. SANCHI — the Great Stupa: hemispherical anda, stone railing, a torana in front
// ---------------------------------------------------------------------------

const sanchiStupa = {
  W: 1008,
  H: 1344,
  sky: SKY_CLEAR,
  ground: { y: 0.86, ...GROUND_LAWN },
  haze: { start: 0.62, amount: 0.15, col: [210, 202, 186] },
  hit(u, v, out) {
    const B = MAT.buffSandstone;
    const BD = [172, 130, 92];

    // ---- chhatra: the triple stone parasol on its mast ----
    if (v >= 0.3 && v <= 0.472 && Math.abs(u - 0.5) < 0.006) {
      return put(out, 0.72, 0, 1, B, 1.06);
    }
    for (const [dy, rx] of [[0.402, 0.05], [0.372, 0.037], [0.344, 0.025]]) {
      if (Math.abs(v - dy) < 0.008 && Math.abs(u - 0.5) < rx) {
        const k = v > dy ? 0.62 : 1.18;
        return put(out, 0.73, 0, 1, B, k);
      }
    }
    // ---- harmika: the square railed enclosure crowning the dome ----
    if (v >= 0.44 && v <= 0.492 && Math.abs(u - 0.5) < 0.044) {
      const p = phase(v, 0.017);
      return put(out, 0.76, 0, 1, B, p < 0.6 ? 1.08 : 0.68);
    }

    // ---- the anda: the great hemispherical dome ----
    if (dome(out, u, v, { cx: 0.5, yBase: 0.735, rx: 0.288, ry: 0.245, z: 0.66, col: B, profile: 'stupa', bulge: 0.24 })) {
      // Weathered brick-and-dressed-stone courses wrapping the dome.
      const p = phase(v, 0.0138);
      out.k *= 0.94 + 0.12 * (p < 0.5 ? 1 : 0);
      return true;
    }

    // ---- the medhi: the raised processional terrace and its railing ----
    if (v > 0.7 && v <= 0.79 && Math.abs(u - 0.5) < 0.3) {
      const dx = (u - 0.5) / 0.3;
      const nz = Math.sqrt(clamp(1 - dx * dx * 0.8));
      // Railing: three horizontal rails threaded through upright posts.
      const p = phase(u, 0.0223);
      const post = Math.abs(p - 0.5) < 0.2;
      const railV = phase(v - 0.7, 0.0225);
      const rail = railV < 0.56;
      const solid = post || rail;
      return put(out, 0.76 + 0.14 * nz, dx * 0.6, nz, solid ? B : MAT.shadow, solid ? (post ? 1.1 : 0.98) : 0.4);
    }

    // ---- the ground-level railing (vedika) running across the front ----
    if (v > 0.79 && v <= 0.86) {
      const p = phase(u, 0.0268);
      const post = Math.abs(p - 0.5) < 0.19;
      const railV = phase(v - 0.79, 0.0234);
      const rail = railV < 0.58;
      const solid = post || rail;
      if (!solid) return false;
      return put(out, 0.9, 0, 1, B, post ? 1.12 : 0.96);
    }

    // ---- the torana: the carved gateway standing clear in front, off to the left ----
    if (u > 0.115 && u < 0.385) {
      // Three curved architraves with volute ends, stacked on two square pillars.
      for (const [ay, sag] of [[0.485, 0.016], [0.541, 0.015], [0.597, 0.014]]) {
        const bow = ay - sag * (1 - Math.pow((u - 0.25) / 0.135, 2));
        if (v > bow && v < bow + 0.024) {
          const t = (v - bow) / 0.024;
          return put(out, 0.99, 0, 1, BD, 1.16 - 0.42 * t);
        }
        // The volute scrolls that finish each architrave.
        for (const ex of [0.128, 0.372]) {
          const d = Math.hypot((u - ex) / 0.016, (v - (ay + 0.012)) / 0.016);
          if (d < 1) return put(out, 0.99, 0, 1, BD, d > 0.55 ? 1.14 : 0.66);
        }
      }
      // Small carved blocks between the architraves.
      for (const bx of [0.185, 0.25, 0.315]) {
        if (Math.abs(u - bx) < 0.013 && ((v > 0.509 && v < 0.541) || (v > 0.565 && v < 0.597))) {
          return put(out, 0.99, 0, 1, BD, 0.86);
        }
      }
      // The two pillars.
      for (const px of [0.175, 0.325] ) {
        if (Math.abs(u - px) < 0.023 && v > 0.597 && v < 0.86) {
          const dxp = (u - px) / 0.023;
          const nz = Math.sqrt(clamp(1 - dxp * dxp * 0.6));
          // Four carved faces to each shaft, with a bracket capital at the top.
          let k = Math.abs(dxp) < 0.4 ? 1.08 : 0.84;
          const pv2 = phase(v, 0.0335);
          k *= 0.9 + 0.16 * (pv2 < 0.5 ? 1 : 0);
          if (v < 0.628) k *= 1.16;
          return put(out, 1.0, dxp * 0.6, nz, BD, k);
        }
      }
    }
    return false;
  },
};

// ---------------------------------------------------------------------------

export const SHAPES = {
  'qutub-minar': qutubMinar,
  'taj-mahal': tajMahal,
  'red-fort': redFort,
  'gateway-of-india': gatewayOfIndia,
  'hawa-mahal': hawaMahal,
  charminar,
  'konark-sun-temple': konarkSunTemple,
  'mysore-palace': mysorePalace,
  'golden-temple': goldenTemple,
  'sanchi-stupa': sanchiStupa,
};
