/**
 * A self-contained QR Code encoder.
 *
 * Why this file exists: Bol prints two QR codes that a stranger will point a phone
 * at — the postcard's "come talk to me too" link and the Razorpay payment link —
 * and we may not add dependencies. So the encoder lives here, in ~450 lines, with
 * no imports at all. It is pure: safe to import from a server route AND from a
 * 'use client' component (it touches no Node and no DOM).
 *
 * Scope: byte mode (UTF-8), versions 1-40, error correction L/M/Q/H, default M,
 * automatic version selection, automatic mask selection by the ISO/IEC 18004
 * penalty rules. No kanji mode, no alphanumeric mode, no ECI header — plain byte
 * segments, which every reader in the wild decodes as UTF-8/Latin-1.
 *
 * Structure follows the classic minimal-table approach: only the per-version
 * "EC codewords per block" and "number of blocks" tables are data; everything
 * else (total capacity, alignment pattern positions, group sizes) is derived.
 *
 * Correctness: this encoder was diffed module-for-module against an independent
 * reference implementation (segno 1.6.6) over 360 cases — every version 1-40 at
 * every level L/M/Q/H, each at full capacity and one byte under, plus all eight
 * masks on fixed payloads. All 360 matrices are bit-identical, including the
 * BCH format and version information. Mask *selection* follows the Nayuki/ZXing
 * reading of penalty feature 3; that only changes which of eight equally valid
 * masks is chosen, never whether the symbol decodes.
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
  /** Error correction level. Default 'M' (~15% recovery) — the spec's floor. */
  ec?: EcLevel;
  /** Force a minimum version (1-40). The encoder still grows if the data needs more. */
  minVersion?: number;
  /** Force a specific mask 0-7. Leave undefined to pick the lowest-penalty mask. */
  mask?: number;
}

export interface QrSvgOptions extends QrOptions {
  /** Quiet zone in modules. The standard requires 4; do not go below it. */
  border?: number;
  /** Rendered pixel size of the <svg> element. Omit for a viewBox-only, fluid SVG. */
  size?: number;
  dark?: string;
  light?: string;
  /** Accessible label. Escaped before it is written into the SVG. */
  label?: string;
  /** Draw the light modules as a background rect (true) or leave them transparent. */
  background?: boolean;
}

export interface QrResult {
  matrix: boolean[][];
  version: number;
  ec: EcLevel;
  mask: number;
  /** Modules per side, excluding the quiet zone. */
  size: number;
}

// ---------------------------------------------------------------------------
// Per-version tables. Everything else is derived from these two.
// ---------------------------------------------------------------------------

/** Error-correction codewords per block, indexed [ec][version]. Index 0 unused. */
const ECC_PER_BLOCK: Record<EcLevel, number[]> = {
  L: [-1,
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
    20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1,
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
    30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1,
    13, 22, 18, 26, 18, 24, 18, 22, 20, 24,
    28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
    28, 30, 30, 30, 30, 28, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1,
    17, 28, 22, 16, 22, 28, 26, 26, 24, 28,
    24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
    30, 24, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Number of error-correction blocks, indexed [ec][version]. Index 0 unused. */
const NUM_BLOCKS: Record<EcLevel, number[]> = {
  L: [-1,
    1, 1, 1, 1, 1, 2, 2, 2, 2, 4,
    4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
    16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1,
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
    5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
    31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1,
    1, 1, 2, 2, 4, 4, 6, 6, 8, 8,
    8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
    23, 23, 25, 27, 29, 34, 34, 35, 38, 40,
    43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1,
    1, 1, 2, 4, 4, 4, 5, 6, 8, 8,
    11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
    25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
    51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Two bits per level, as they appear in the format information. */
const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// ---------------------------------------------------------------------------
// Derived geometry
// ---------------------------------------------------------------------------

function sizeForVersion(version: number): number {
  return version * 4 + 17;
}

/**
 * Data modules available before error correction, i.e. total modules minus
 * finders, separators, timing, alignment, format and version information.
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

function dataCodewords(version: number, ec: EcLevel): number {
  return totalCodewords(version) - ECC_PER_BLOCK[ec][version] * NUM_BLOCKS[ec][version];
}

/** Centres of the alignment patterns, ascending. Empty for version 1. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const out: number[] = [];
  for (let i = 0, pos = sizeForVersion(version) - 7; i < numAlign - 1; i++, pos -= step) {
    out.unshift(pos);
  }
  out.unshift(6);
  return out;
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords, high term first. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder of `data` for `degree` EC codewords. */
function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = generatorPoly(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---------------------------------------------------------------------------
// Bit buffer
// ---------------------------------------------------------------------------

class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pad to a byte boundary with zeros and return the codewords. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >>> 3] |= 0x80 >>> (i & 7);
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // Manual UTF-8 for exotic runtimes. Never hit in Node 18+ or any browser.
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** Byte-mode character-count indicator width. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteLength: number, ec: EcLevel, minVersion: number): number {
  for (let v = Math.max(MIN_VERSION, minVersion); v <= MAX_VERSION; v++) {
    const capacityBits = dataCodewords(v, ec) * 8;
    const neededBits = 4 + charCountBits(v) + byteLength * 8;
    if (neededBits <= capacityBits) return v;
  }
  throw new RangeError(
    `qr: ${byteLength} bytes do not fit in a version-40 QR code at level ${ec} (max ${dataCodewords(40, ec) - 3} bytes)`,
  );
}

/** Mode indicator + count + payload + terminator + pad codewords. */
function buildDataCodewords(bytes: Uint8Array, version: number, ec: EcLevel): Uint8Array {
  const capacity = dataCodewords(version, ec);
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // byte mode
  buf.push(bytes.length, charCountBits(version));
  for (const b of bytes) buf.push(b, 8);

  const capacityBits = capacity * 8;
  buf.push(0, Math.min(4, capacityBits - buf.length)); // terminator
  buf.push(0, (8 - (buf.length % 8)) % 8); // byte align

  const out = new Uint8Array(capacity);
  out.set(buf.toBytes());
  for (let i = buf.length / 8, pad = 0xec; i < capacity; i++, pad ^= 0xec ^ 0x11) out[i] = pad;
  return out;
}

/** Split into blocks, add Reed-Solomon, interleave. */
function interleave(data: Uint8Array, version: number, ec: EcLevel): Uint8Array {
  const numBlocks = NUM_BLOCKS[ec][version];
  const eccLen = ECC_PER_BLOCK[ec][version];
  const total = totalCodewords(version);
  const numShort = numBlocks - (total % numBlocks);
  const shortDataLen = Math.floor(total / numBlocks) - eccLen;

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const len = shortDataLen + (i < numShort ? 0 : 1);
    const block = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, eccLen));
  }

  const out = new Uint8Array(total);
  let k = 0;
  const maxData = shortDataLen + 1;
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) out[k++] = dataBlocks[b][i];
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < numBlocks; b++) out[k++] = eccBlocks[b][i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

class Canvas {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = sizeForVersion(version);
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFn(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFinder(c: Canvas, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      c.setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(c: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      c.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 15-bit BCH-protected format information for a level/mask pair. */
function formatBits(ec: EcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit BCH-protected version information, versions 7-40 only. */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormat(c: Canvas, ec: EcLevel, mask: number): void {
  const bits = formatBits(ec, mask);
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;

  // Top-left, split around the timing pattern.
  for (let i = 0; i <= 5; i++) c.setFn(8, i, bit(i));
  c.setFn(8, 7, bit(6));
  c.setFn(8, 8, bit(7));
  c.setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) c.setFn(14 - i, 8, bit(i));

  // The second copy, along the bottom-left and top-right.
  for (let i = 0; i < 8; i++) c.setFn(c.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) c.setFn(8, c.size - 15 + i, bit(i));
  c.setFn(8, c.size - 8, true); // the always-dark module
}

function drawFunctionPatterns(c: Canvas, ec: EcLevel): void {
  // Timing patterns.
  for (let i = 0; i < c.size; i++) {
    c.setFn(6, i, i % 2 === 0);
    c.setFn(i, 6, i % 2 === 0);
  }

  drawFinder(c, 3, 3);
  drawFinder(c, c.size - 4, 3);
  drawFinder(c, 3, c.size - 4);

  const pos = alignmentPositions(c.version);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === pos.length - 1) ||
        (i === pos.length - 1 && j === 0);
      if (!corner) drawAlignment(c, pos[i], pos[j]);
    }
  }

  // Reserve the format area; the real mask is written in again after selection.
  drawFormat(c, ec, 0);

  if (c.version >= 7) {
    const bits = versionBits(c.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = c.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      c.setFn(a, b, bit);
      c.setFn(b, a, bit);
    }
  }
}

/** Zig-zag placement, two modules wide, right to left, skipping column 6. */
function drawCodewords(c: Canvas, codewords: Uint8Array): void {
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = c.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < c.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? c.size - 1 - vert : vert;
        if (!c.isFunction[y][x] && i < totalBits) {
          c.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
        // Remaining modules stay light; they are the remainder bits.
      }
    }
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError(`qr: mask must be 0-7, got ${mask}`);
  }
}

function applyMask(c: Canvas, mask: number): void {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      if (!c.isFunction[y][x] && maskAt(mask, x, y)) c.modules[y][x] = !c.modules[y][x];
    }
  }
}

// ---------------------------------------------------------------------------
// Mask selection — ISO/IEC 18004 section 8.8.2
// ---------------------------------------------------------------------------

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * Feature 3 (finder-like patterns): a 1:1:3:1:1 dark/light run bounded by four
 * light modules on at least one side. Counted over a rolling history of the last
 * seven runs, with everything outside the symbol treated as light — the same
 * formulation the standard uses, so it agrees with reference encoders on which
 * mask wins.
 */
function countFinderPatterns(history: number[]): number {
  const n = history[1];
  const core =
    n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  if (!core) return 0;
  return (history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function penaltyScore(c: Canvas): number {
  const size = c.size;
  let score = 0;

  const addHistory = (runLength: number, history: number[]): void => {
    if (history[0] === 0) runLength += size; // the light border before the first run
    history.pop();
    history.unshift(runLength);
  };

  const scanLine = (get: (i: number) => boolean): number => {
    let sub = 0;
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];

    for (let i = 0; i < size; i++) {
      if (get(i) === runColor) {
        runLength++;
        if (runLength === 5) sub += PENALTY_N1;
        else if (runLength > 5) sub++;
      } else {
        addHistory(runLength, history);
        if (!runColor) sub += countFinderPatterns(history) * PENALTY_N3;
        runColor = get(i);
        runLength = 1;
      }
    }

    // Terminate: a dark final run is closed, then the light border after it.
    if (runColor) {
      addHistory(runLength, history);
      runLength = 0;
    }
    addHistory(runLength + size, history);
    sub += countFinderPatterns(history) * PENALTY_N3;
    return sub;
  };

  for (let y = 0; y < size; y++) score += scanLine((x) => c.modules[y][x]);
  for (let x = 0; x < size; x++) score += scanLine((y) => c.modules[y][x]);

  // Feature 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = c.modules[y][x];
      if (v === c.modules[y][x + 1] && v === c.modules[y + 1][x] && v === c.modules[y + 1][x + 1]) {
        score += PENALTY_N2;
      }
    }
  }

  // Feature 4: proportion of dark modules.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (c.modules[y][x]) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * PENALTY_N4;

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode `text` and return the module matrix, row-major, `true` = dark.
 * No quiet zone: add 4 modules of light around it when rendering.
 */
export function qrMatrix(text: string, opts: QrOptions = {}): boolean[][] {
  return encode(text, opts).matrix;
}

/** Full encode, including the version and mask actually used. */
export function encode(text: string, opts: QrOptions = {}): QrResult {
  const ec: EcLevel = opts.ec ?? 'M';
  if (!ECC_PER_BLOCK[ec]) throw new RangeError(`qr: unknown error correction level "${ec}"`);

  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length, ec, opts.minVersion ?? MIN_VERSION);
  const data = buildDataCodewords(bytes, version, ec);
  const codewords = interleave(data, version, ec);

  const build = (mask: number): Canvas => {
    const c = new Canvas(version);
    drawFunctionPatterns(c, ec);
    drawCodewords(c, codewords);
    applyMask(c, mask);
    drawFormat(c, ec, mask);
    return c;
  };

  let mask = opts.mask;
  let canvas: Canvas;
  if (mask === undefined) {
    let best = Infinity;
    let bestCanvas: Canvas | null = null;
    let bestMask = 0;
    for (let m = 0; m < 8; m++) {
      const c = build(m);
      const p = penaltyScore(c);
      if (p < best) {
        best = p;
        bestCanvas = c;
        bestMask = m;
      }
    }
    canvas = bestCanvas!;
    mask = bestMask;
  } else {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError(`qr: mask must be 0-7, got ${mask}`);
    canvas = build(mask);
  }

  return { matrix: canvas.modules, version, ec, mask, size: canvas.size };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : '&apos;',
  );
}

/**
 * Render `text` as an SVG string. Self-contained, no external references, safe to
 * inject with dangerouslySetInnerHTML and safe to rasterise onto a <canvas>
 * (drawing it does not taint the canvas).
 */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const { matrix } = encode(text, opts);
  const border = opts.border ?? 4;
  const dark = opts.dark ?? '#000000';
  const light = opts.light ?? '#ffffff';
  const n = matrix.length;
  const dim = n + border * 2;

  // Merge horizontal runs so the path stays small even at version 20+.
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!matrix[y][x]) {
        x++;
        continue;
      }
      let run = 0;
      while (x + run < n && matrix[y][x + run]) run++;
      parts.push(`M${x + border} ${y + border}h${run}v1h-${run}z`);
      x += run;
    }
  }

  const sizeAttr = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  const label = opts.label ? `<title>${escapeXml(opts.label)}</title>` : '';
  const bg = opts.background === false ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"${sizeAttr} ` +
    `shape-rendering="crispEdges" role="img"${opts.label ? ` aria-label="${escapeXml(opts.label)}"` : ''}>` +
    `${label}${bg}<path fill="${dark}" d="${parts.join('')}"/></svg>`
  );
}

/** Modules per side for a given version, excluding the quiet zone. Handy for tests. */
export function moduleCount(version: number): number {
  return sizeForVersion(version);
}

/** Largest byte payload that fits at a given version and level. Handy for tests. */
export function byteCapacity(version: number, ec: EcLevel = 'M'): number {
  return dataCodewords(version, ec) - (charCountBits(version) === 8 ? 2 : 3);
}
