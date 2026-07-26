'use client';

/**
 * Everything the scanner does to a camera frame BEFORE it costs money.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE LANE
 * ---------------------------------------------------------------------------
 *
 * A live viewfinder produces 30 frames a second. Sending them would burn the
 * account's Sarvam quota in about a minute — and because Sarvam's rate limits
 * are per-ACCOUNT across every key, that does not throttle this page, it
 * throttles the whole team mid-demo. So a frame has to earn its upload by
 * passing four gates, all of which run locally on a canvas in well under a
 * millisecond:
 *
 *   1. CADENCE     at most one sample every SAMPLE_INTERVAL_MS (see useScan).
 *   2. DEDUP       a 16x16 luma signature compared against the last SENT frame.
 *                  A phone held still generates no traffic at all.
 *   3. LIGHT       mean luma outside [DARK, BRIGHT] is unreadable, and we say
 *                  which — "too dark to see" is a fixable instruction, a silent
 *                  failure is not.
 *   4. FOCUS       variance-of-Laplacian on a centre crop. Motion blur is the
 *                  single most common reason a scanned frame is worthless.
 *
 * Plus a hard cap on total calls, enforced by the caller.
 *
 * NOTE ON THE FOCUS MEASUREMENT: the Laplacian is taken on a 128x128 CENTRE
 * CROP, not on a downscale of the whole frame. Downscaling is itself a low-pass
 * filter — it destroys exactly the high-frequency detail that distinguishes a
 * sharp frame from a blurred one, so a whole-frame thumbnail scores a tripod
 * shot and a smeared pan almost identically. Cropping keeps the pixels near
 * their native scale, and the centre is where the subject is when someone
 * points a phone at a building.
 */

/** Long edge of what we actually upload. ~40KB at q0.7 — under a second on 4G. */
export const SAMPLE_EDGE = 640;
export const SAMPLE_QUALITY = 0.7;

/** Perceptual signature grid. 16x16 = 256 cells, enough to notice a re-frame. */
export const SIGNATURE_SIZE = 16;
/** Centre-crop grid for the focus measure. */
export const SHARPNESS_SIZE = 128;
/** Fraction of the frame (per axis) used for the centre crop. */
export const SHARPNESS_CROP = 0.5;

/**
 * Mean absolute difference, in 0..255 luma units, below which two frames are
 * "the same view". Sensor noise on a still phone runs 1-3 units; the smallest
 * deliberate re-frame moves edges across cells and lands far above 6.
 */
export const DEDUP_MAD = 6;

/** Mean luma bounds. Below DARK nothing is legible; above BRIGHT it is blown out. */
export const DARK_MEAN_LUMA = 40;
export const BRIGHT_MEAN_LUMA = 240;

/**
 * Variance-of-Laplacian floor on the centre crop. Empirical: a handheld but
 * settled outdoor frame scores in the hundreds to low thousands, a frame taken
 * mid-pan scores in the tens. 60 is deliberately generous — a slightly soft
 * frame still identifies a building perfectly well, and the cost of being too
 * strict is a visitor who can never scan anything. `useScan` also relaxes this
 * gate after a few consecutive rejections, so it can never dead-end.
 */
export const BLUR_MIN_VARIANCE = 60;

export type FrameVerdict = 'ok' | 'dark' | 'bright' | 'blurry' | 'duplicate';

export interface FrameStats {
  /** 0..255. */
  meanLuma: number;
  /** Variance of the Laplacian over the centre crop. Higher is sharper. */
  sharpness: number;
  /** SIGNATURE_SIZE^2 luma cells, 0..255, row-major. */
  signature: Uint8Array;
}

/** Reusable canvases. Allocating one per frame would churn the GC on a phone. */
export interface FrameScratch {
  signature: HTMLCanvasElement;
  sharpness: HTMLCanvasElement;
  sample: HTMLCanvasElement;
}

export function createScratch(): FrameScratch {
  const make = (w: number, h: number) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  return {
    signature: make(SIGNATURE_SIZE, SIGNATURE_SIZE),
    sharpness: make(SHARPNESS_SIZE, SHARPNESS_SIZE),
    sample: make(SAMPLE_EDGE, SAMPLE_EDGE),
  };
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { willReadFrequently: true });
}

function lumaOf(data: Uint8ClampedArray, out: Float32Array): void {
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
}

/** True once the camera has actually produced pixels. */
export function frameReady(video: HTMLVideoElement | null): video is HTMLVideoElement {
  return Boolean(video && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2);
}

/**
 * Measure a frame. Never throws — a canvas that will not read back returns null
 * and the caller treats it as "cannot judge", which fails OPEN (the frame is
 * sent) rather than silently stalling the scanner forever.
 */
export function analyseFrame(video: HTMLVideoElement, scratch: FrameScratch): FrameStats | null {
  if (!frameReady(video)) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  try {
    // --- whole frame -> signature + mean luma ------------------------------
    const sctx = ctx2d(scratch.signature);
    if (!sctx) return null;
    sctx.drawImage(video, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
    const sImage = sctx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
    const cells = SIGNATURE_SIZE * SIGNATURE_SIZE;
    const sLuma = new Float32Array(cells);
    lumaOf(sImage.data, sLuma);

    const signature = new Uint8Array(cells);
    let sum = 0;
    for (let i = 0; i < cells; i++) {
      sum += sLuma[i];
      signature[i] = Math.max(0, Math.min(255, Math.round(sLuma[i])));
    }
    const meanLuma = sum / cells;

    // --- centre crop -> variance of Laplacian ------------------------------
    const cw = Math.max(1, Math.round(vw * SHARPNESS_CROP));
    const ch = Math.max(1, Math.round(vh * SHARPNESS_CROP));
    const cx = Math.round((vw - cw) / 2);
    const cy = Math.round((vh - ch) / 2);

    const bctx = ctx2d(scratch.sharpness);
    if (!bctx) return null;
    bctx.drawImage(video, cx, cy, cw, ch, 0, 0, SHARPNESS_SIZE, SHARPNESS_SIZE);
    const bImage = bctx.getImageData(0, 0, SHARPNESS_SIZE, SHARPNESS_SIZE);
    const bLuma = new Float32Array(SHARPNESS_SIZE * SHARPNESS_SIZE);
    lumaOf(bImage.data, bLuma);

    return { meanLuma, sharpness: laplacianVariance(bLuma, SHARPNESS_SIZE, SHARPNESS_SIZE), signature };
  } catch {
    // Tainted or oversized surface. Cannot judge — say so.
    return null;
  }
}

/** 4-neighbour Laplacian over the interior, then its variance. Exported to be testable. */
export function laplacianVariance(luma: Float32Array, w: number, h: number): number {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w];
      // Welford, so a 16k-sample pass stays numerically honest.
      n++;
      const delta = l - mean;
      mean += delta / n;
      m2 += delta * (l - mean);
    }
  }
  return n > 1 ? m2 / (n - 1) : 0;
}

/** Mean absolute difference between two signatures, in 0..255 luma units. */
export function meanAbsDiff(a: Uint8Array | null, b: Uint8Array | null): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

export interface GateOptions {
  /** Signature of the last frame we actually SENT, not the last one we looked at. */
  lastSent: Uint8Array | null;
  /** Set when a candidate is awaiting a second opinion on the same view. */
  ignoreDuplicate?: boolean;
  /** Set after repeated blur rejections, so a mis-tuned threshold cannot dead-end. */
  ignoreBlur?: boolean;
}

/**
 * The gate. Order matters: light and focus are things the VISITOR can fix and
 * so are reported first; "duplicate" is a thing the visitor is doing right
 * (holding still) and needs no instruction at all.
 */
export function gate(stats: FrameStats | null, opts: GateOptions): FrameVerdict {
  // Could not measure. Fail open — one wasted call beats a scanner that never
  // sends anything on a device whose canvas we cannot read.
  if (!stats) return 'ok';

  if (stats.meanLuma < DARK_MEAN_LUMA) return 'dark';
  if (stats.meanLuma > BRIGHT_MEAN_LUMA) return 'bright';
  if (!opts.ignoreBlur && stats.sharpness < BLUR_MIN_VARIANCE) return 'blurry';
  if (!opts.ignoreDuplicate && meanAbsDiff(stats.signature, opts.lastSent) < DEDUP_MAD) return 'duplicate';
  return 'ok';
}

/** Plain-language, fixable. Never "error", never silence. */
export function verdictCopy(verdict: FrameVerdict): string | null {
  switch (verdict) {
    case 'dark':
      return 'Too dark to see — more light, or step out of the shade.';
    case 'bright':
      return 'Too bright — the sun is washing the frame out.';
    case 'blurry':
      // Covers both causes of a low Laplacian: a smeared frame, and a frame
      // with nothing in it (a blank wall scores zero as surely as a fast pan).
      return 'Hold still — there is not enough detail to read yet.';
    case 'duplicate':
      // Not a problem and not the visitor's fault. Saying "waiting" here would
      // read as a stall, so the caller keeps the previous line instead.
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

function fit(canvas: HTMLCanvasElement, w: number, h: number) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

/**
 * Draw the live frame at `longEdge` and encode as JPEG. Never a full-resolution
 * upload: a 1080p frame is ~250KB as JPEG and 640px q0.7 is ~40KB, and at one
 * frame every couple of seconds that difference is the whole data budget of the
 * feature on a 4G phone.
 */
export async function encodeFrame(
  video: HTMLVideoElement,
  scratch: FrameScratch,
  longEdge = SAMPLE_EDGE,
  quality = SAMPLE_QUALITY,
): Promise<Blob | null> {
  if (!frameReady(video)) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, longEdge / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  fit(scratch.sample, w, h);
  const c = ctx2d(scratch.sample);
  if (!c) return null;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'medium';
  c.drawImage(video, 0, 0, w, h);
  return toBlob(scratch.sample, quality);
}

/**
 * A better still, for the moment the visitor gives up on matching and takes the
 * ungrounded path. Same 1600px / q0.82 the upload lane uses, so the photograph
 * that ends up on /create is indistinguishable from a photographed one.
 */
export async function captureStill(
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
): Promise<Blob | null> {
  if (!frameReady(video)) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, longEdge / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  if (!c) return null;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(video, 0, 0, w, h);
  return toBlob(canvas, quality);
}
