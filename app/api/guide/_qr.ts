/**
 * A self-contained QR Code encoder (ISO/IEC 18004), byte mode, versions 1–10.
 *
 * Why it lives here and not in lib/: `lib/qr.ts` belongs to the growth lane and does
 * not exist yet. The guide lane needs a join QR today and may not install a package,
 * so this is a complete, dependency-free encoder scoped to this lane. If the growth
 * lane later ships `lib/qr.ts`, delete this file and re-point `qrSvg` at it.
 *
 * Scope: byte mode only (a join URL is ASCII), versions 1–10, all four EC levels.
 * That tops out at 274 bytes at ECL L — roughly six times what a join URL needs.
 *
 * Correctness: the module matrices produced here were diffed cell-by-cell against
 * the `segno` reference encoder for every version 1–10 × every EC level × a spread
 * of payloads, including the real join URLs this app emits. See the report.
 */

export type QrEcl = 'L' | 'M' | 'Q' | 'H';

// ---------------------------------------------------------------------------
// Static tables (ISO/IEC 18004 Annex D / Table 9)
// ---------------------------------------------------------------------------

/** Total codewords (data + error correction) per version. Index = version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Per version+ECL: [ecCodewordsPerBlock, blocksInGroup1, dataCwGroup1, blocksInGroup2, dataCwGroup2].
 * Group 2 blocks hold exactly one more data codeword than group 1 when present.
 */
const BLOCKS: Record<QrEcl, number[][]> = {
  L: [
    [], [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    [], [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    [], [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    [], [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

/** Row/column centres of the alignment patterns. Index = version. */
const ALIGN_POS = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** 2-bit EC level indicator used inside the format information. Not the same as an index. */
const ECL_FORMAT_BITS: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 };

const MAX_VERSION = 10;

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
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

/** Generator polynomial of degree `degree`, coefficients high-order first, monic. */
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

/** Reed–Solomon remainder of `data` for `ecLen` error correction codewords. */
function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = generatorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ---------------------------------------------------------------------------
// Bit buffer
// ---------------------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function dataCodewordCount(version: number, ecl: QrEcl): number {
  const [ecPerBlock, b1, , b2] = BLOCKS[ecl][version];
  const blocks = b1 + b2;
  return TOTAL_CODEWORDS[version] - ecPerBlock * blocks;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function chooseVersion(byteLen: number, ecl: QrEcl, minVersion: number): number {
  for (let v = Math.max(1, minVersion); v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    const needed = 4 + countBits + byteLen * 8;
    if (needed <= dataCodewordCount(v, ecl) * 8) return v;
  }
  throw new Error(
    `QR payload of ${byteLen} bytes does not fit in version ${MAX_VERSION} at EC level ${ecl}. ` +
      'Shorten the URL or lower the EC level.',
  );
}

/** Mode indicator + character count + payload + terminator + padding, as codewords. */
function buildDataCodewords(bytes: Uint8Array, version: number, ecl: QrEcl): Uint8Array {
  const capacityBits = dataCodewordCount(version, ecl) * 8;
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bb.push(b, 8);

  bb.push(0, Math.min(4, capacityBits - bb.length)); // terminator
  bb.push(0, (8 - (bb.length % 8)) % 8); // pad to a byte boundary

  const out = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < bb.length; i++) {
    if (bb.bits[i]) out[i >>> 3] |= 0x80 >>> (i & 7);
  }
  // Alternating pad codewords 0b11101100 / 0b00010001.
  for (let i = bb.length / 8, pad = 0xec; i < out.length; i++, pad ^= 0xec ^ 0x11) out[i] = pad;
  return out;
}

/** Split into blocks, Reed–Solomon each, then interleave as the spec requires. */
function interleave(data: Uint8Array, version: number, ecl: QrEcl): Uint8Array {
  const [ecPerBlock, numB1, lenB1, numB2, lenB2] = BLOCKS[ecl][version];
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (let i = 0; i < numB1 + numB2; i++) {
    const len = i < numB1 ? lenB1 : lenB2;
    const block = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }

  const result = new Uint8Array(TOTAL_CODEWORDS[version]);
  let k = 0;
  const maxData = Math.max(lenB1, numB2 > 0 ? lenB2 : 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result[k++] = block[i];
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result[k++] = block[i];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

class QrMatrix {
  readonly size: number;
  /** true = dark. */
  readonly modules: boolean[][];
  /** Function patterns are excluded from masking and from data placement. */
  private readonly reserved: boolean[][];

  constructor(readonly version: number, readonly ecl: QrEcl) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(row: number, col: number, dark: boolean): void {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return;
    this.modules[row][col] = dark;
    this.reserved[row][col] = true;
  }

  isReserved(row: number, col: number): boolean {
    return this.reserved[row][col];
  }

  drawFunctionPatterns(): void {
    // Timing patterns.
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }

    // Finder patterns (plus their separators), given by centre.
    for (const [r, c] of [[3, 3], [3, this.size - 4], [this.size - 4, 3]]) {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          this.setFunction(r + dr, c + dc, dist !== 2 && dist !== 4);
        }
      }
    }

    // Alignment patterns, skipping the three that would collide with finders.
    const pos = ALIGN_POS[this.version];
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            this.setFunction(pos[i] + dr, pos[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    this.drawFormatBits(0); // placeholder — reserves the cells; rewritten per mask
    this.drawVersionBits();
  }

  /** 15-bit BCH(15,5) format information, written twice. */
  drawFormatBits(mask: number): void {
    const data = (ECL_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    // Copy 1 — around the top-left finder.
    for (let i = 0; i <= 5; i++) this.setFunction(i, 8, bit(i));
    this.setFunction(7, 8, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(8, 7, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(8, 14 - i, bit(i));

    // Copy 2 — split between the top-right and bottom-left finders.
    for (let i = 0; i < 8; i++) this.setFunction(8, this.size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(this.size - 15 + i, 8, bit(i));

    this.setFunction(this.size - 8, 8, true); // the always-dark module
  }

  /** 18-bit BCH(18,6) version information, versions 7 and up only. */
  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(b, a, dark);
      this.setFunction(a, b, dark);
    }
  }

  /** Two-module-wide columns, right to left, snaking up then down, skipping column 6. */
  drawCodewords(codewords: Uint8Array): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // column 6 is the vertical timing pattern
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - vert : vert;
          if (!this.reserved[row][col] && i < codewords.length * 8) {
            this.modules[row][col] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
          // Any leftover modules stay light, which is what the remainder bits require.
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let row = 0; row < this.size; row++) {
      for (let col = 0; col < this.size; col++) {
        if (this.reserved[row][col]) continue;
        if (maskCondition(mask, row, col)) this.modules[row][col] = !this.modules[row][col];
      }
    }
  }

  /** Sum of the four penalty rules; lower is better. */
  penalty(): number {
    const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    const size = this.size;
    let result = 0;

    const addHistory = (runLength: number, history: number[]) => {
      if (history[0] === 0) runLength += size; // the light quiet zone counts as part of the first run
      history.pop();
      history.unshift(runLength);
    };
    const countPatterns = (h: number[]): number => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };

    const scanLine = (get: (i: number) => boolean) => {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < size; i++) {
        if (get(i) === runColor) {
          runLength++;
          if (runLength === 5) result += N1;
          else if (runLength > 5) result++;
        } else {
          addHistory(runLength, history);
          if (!runColor) result += countPatterns(history) * N3;
          runColor = get(i);
          runLength = 1;
        }
      }
      // Terminate: flush the trailing run, then the quiet zone.
      if (runColor) {
        addHistory(runLength, history);
        runLength = 0;
      }
      addHistory(runLength + size, history);
      result += countPatterns(history) * N3;
    };

    for (let row = 0; row < size; row++) scanLine((col) => this.modules[row][col]);
    for (let col = 0; col < size; col++) scanLine((row) => this.modules[row][col]);

    // Rule 2: every 2x2 block of one colour.
    for (let row = 0; row < size - 1; row++) {
      for (let col = 0; col < size - 1; col++) {
        const c = this.modules[row][col];
        if (c === this.modules[row][col + 1] && c === this.modules[row + 1][col] && c === this.modules[row + 1][col + 1]) {
          result += N2;
        }
      }
    }

    // Rule 4: deviation of the dark-module ratio from 50%.
    let dark = 0;
    for (const row of this.modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * N4;

    return result;
  }
}

function maskCondition(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new Error(`invalid mask ${mask}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QrCode {
  version: number;
  ecl: QrEcl;
  size: number;
  /** `modules[row][col]` — true means a dark module. Excludes the quiet zone. */
  modules: boolean[][];
  mask: number;
}

export function encodeQr(text: string, opts: { ecl?: QrEcl; minVersion?: number } = {}): QrCode {
  const ecl = opts.ecl ?? 'M';
  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length, ecl, opts.minVersion ?? 1);

  const codewords = interleave(buildDataCodewords(bytes, version, ecl), version, ecl);

  const qr = new QrMatrix(version, ecl);
  qr.drawFunctionPatterns();
  qr.drawCodewords(codewords);

  // Try all eight masks, keep the one with the lowest penalty.
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const p = qr.penalty();
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
    }
    qr.applyMask(mask); // XOR again to undo
  }
  qr.applyMask(bestMask);
  qr.drawFormatBits(bestMask);

  return { version, ecl, size: qr.size, modules: qr.modules, mask: bestMask };
}

export interface QrSvgOptions {
  ecl?: QrEcl;
  /** Quiet zone in modules. The spec requires 4; never go below it. */
  margin?: number;
  dark?: string;
  light?: string;
  /** Rendered pixel size of the square. The SVG also scales via viewBox. */
  pixels?: number;
  title?: string;
}

/**
 * Render to a standalone inline SVG string.
 *
 * The output contains only <rect> and a single <path> of axis-aligned segments — no
 * text, no external references — so it is safe to inject with dangerouslySetInnerHTML
 * even though the encoded payload is a URL.
 */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const { margin = 4, dark = '#0a0908', light = '#f8e6d4', pixels = 512, title = 'Join QR code' } = opts;
  const qr = encodeQr(text, { ecl: opts.ecl ?? 'M' });
  const dim = qr.size + margin * 2;

  // One path, one subpath per dark module. Far smaller than N <rect> elements.
  const parts: string[] = [];
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (qr.modules[row][col]) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${pixels}" height="${pixels}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${escapeXml(title)}">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect width="${dim}" height="${dim}" fill="${escapeXml(light)}"/>` +
    `<path fill="${escapeXml(dark)}" d="${parts.join('')}"/>` +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}
