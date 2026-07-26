/**
 * Depth map acquisition for the living photograph.
 *
 * Two paths, picked automatically:
 *
 *  1. **Precomputed** — `/monuments/{id}/depth.png` shipped beside the hero.
 *     Always preferred: zero cost, zero jank, and it is the map the art was
 *     checked against.
 *  2. **In-browser** — Depth Anything V2 Small through `@huggingface/transformers`
 *     on the WebGPU backend, run once and cached in IndexedDB keyed by a hash of
 *     the hero bytes. Used only when the precomputed map is missing or corrupt.
 *
 * If neither works we return `{ source: 'none' }` and the renderer falls back to
 * a flat plane with Ken Burns. Nothing here ever throws at the caller and
 * nothing here ever blocks the first frame.
 *
 * Browser-only module: every DOM/GPU touch is inside a function body so that
 * importing this file from a server component is harmless.
 */

export type DepthSource = 'precomputed' | 'cache' | 'computed' | 'none';

/**
 * Anything three.js will accept as `Texture.image`.
 *
 * Deliberately *not* `ImageBitmap`: three cannot apply `flipY` to a bitmap, so a
 * bitmap-backed depth map silently samples upside down on some browsers. An
 * `<img>` and a `<canvas>` both honour the default `flipY = true`, which keeps
 * the depth texture in the same orientation as the colour photo with no
 * per-path special casing.
 */
export type DepthImage = HTMLImageElement | HTMLCanvasElement;

export interface DepthMap {
  source: DepthSource;
  image: DepthImage | null;
  width: number;
  height: number;
  /** Populated on the failure path so the caller can surface an honest message. */
  error?: Error;
}

export type DepthPhase =
  | 'precomputed'
  | 'cache-hit'
  | 'model-download'
  | 'model-run'
  | 'done'
  | 'unavailable';

export interface LoadDepthOptions {
  /** URL of the precomputed depth PNG, e.g. `monument.depth`. */
  depthUrl?: string | null;
  /** URL of the colour photograph — hashed for the cache key, and the model input. */
  heroUrl: string;
  /** Set false to skip the in-browser model entirely (used by the debug page). */
  allowCompute?: boolean;
  /** Progress hook for the shimmer placeholder. */
  onPhase?: (phase: DepthPhase) => void;
  /** Hard ceiling on the model path. After this we give up and go flat. */
  computeTimeoutMs?: number;
  signal?: AbortSignal;
}

export const DEPTH_MODEL_ID = 'onnx-community/depth-anything-v2-small';

const DB_NAME = 'bol-depth';
const DB_VERSION = 1;
const STORE = 'maps';
const DEFAULT_COMPUTE_TIMEOUT = 45_000;

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Decode an image URL into an `<img>`. `img.decode()` moves the actual decode
 * off the main thread, so this is no more janky than `createImageBitmap` for a
 * 60 KB grayscale PNG, and it keeps three's `flipY` handling on the happy path.
 */
async function decodeImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (!isBrowser()) throw new Error('decodeImage called outside the browser');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';

  const loaded = new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error(`aborted loading ${url}`));
    img.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    img.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`failed to load ${url}`));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  img.src = url;
  await loaded;
  // A proxy that rewrote a 404 into an HTML page yields a 0x0 image, which would
  // otherwise upload as a black depth map and flatten the whole scene.
  if (!img.naturalWidth || !img.naturalHeight) throw new Error(`empty depth image at ${url}`);
  return img;
}

function imageSize(image: DepthImage): { width: number; height: number } {
  if (image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  return { width: image.width, height: image.height };
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** FNV-1a. Used when `crypto.subtle` is missing (any non-secure origin). */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  // Sampling every 7th byte keeps this sub-millisecond on a 700 KB photo while
  // remaining sensitive to any real change in the file.
  for (let i = 0; i < bytes.length; i += 7) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv${h.toString(16)}-${bytes.length.toString(16)}`;
}

async function hashImageBytes(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) throw new Error(`hero ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = Array.from(new Uint8Array(digest).slice(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `sha${hex}`;
    } catch {
      // Non-secure context: subtle exists but rejects. Fall through.
    }
  }
  return fnv1a(bytes);
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

interface CachedDepth {
  key: string;
  width: number;
  height: number;
  /** Single-channel, already normalised to the full 0..255 range. */
  gray: ArrayBuffer;
  model: string;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  if (!isBrowser() || typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Private-mode Safari throws synchronously here.
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readCache(key: string): Promise<CachedDepth | null> {
  return openDb().then(
    (db) =>
      new Promise<CachedDepth | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(key);
          req.onsuccess = () => resolve((req.result as CachedDepth | undefined) ?? null);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
        } catch {
          resolve(null);
        }
      }),
  );
}

function writeCache(record: CachedDepth): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(record);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}

/** Exposed for the debug page so a bad cached map can be thrown away. */
export async function clearDepthCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

// ---------------------------------------------------------------------------
// Grayscale -> canvas
// ---------------------------------------------------------------------------

/**
 * Expand a single-channel depth buffer into an RGBA canvas that three.js can
 * upload directly. We keep the value in all three colour channels so the shader
 * can read `.r` regardless of how the texture format is negotiated.
 */
function grayToCanvas(gray: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for depth canvas');
  const img = ctx.createImageData(width, height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = gray[i];
    img.data[p] = v;
    img.data[p + 1] = v;
    img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Stretch the predicted depth to the full 0..255 range.
 *
 * Depth Anything emits *relative inverse depth* whose absolute range drifts per
 * image; without this the displacement amplitude would change from photo to
 * photo and `depthScale` would stop meaning anything.
 */
function normalise(src: Uint8ClampedArray, channels: number, pixels: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels);
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels; i++) {
    const v = src[i * channels];
    out[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span <= 0 || span >= 254) return out;
  const k = 255 / span;
  for (let i = 0; i < pixels; i++) out[i] = (out[i] - min) * k;
  return out;
}

// ---------------------------------------------------------------------------
// WebGPU probe
// ---------------------------------------------------------------------------

let webgpuProbe: Promise<boolean> | null = null;

export function hasWebGPU(): Promise<boolean> {
  if (webgpuProbe) return webgpuProbe;
  webgpuProbe = (async () => {
    if (!isBrowser()) return false;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try {
      // Presence of `navigator.gpu` is not enough — Linux/Android builds often
      // expose it and then hand back a null adapter.
      return (await gpu.requestAdapter()) != null;
    } catch {
      return false;
    }
  })();
  return webgpuProbe;
}

// ---------------------------------------------------------------------------
// Model path
// ---------------------------------------------------------------------------

/** Guards against two mounts (page + debug overlay) downloading the model twice. */
let inflight: Promise<DepthMap> | null = null;
let inflightKey = '';

async function computeDepth(
  heroUrl: string,
  cacheKey: string,
  onPhase: (p: DepthPhase) => void,
): Promise<DepthMap> {
  onPhase('model-download');
  const { pipeline } = await import('@huggingface/transformers');
  const estimator = await pipeline('depth-estimation', DEPTH_MODEL_ID, {
    device: 'webgpu',
    dtype: 'fp32',
  });
  try {
    onPhase('model-run');
    const out = await estimator(heroUrl);
    const first = Array.isArray(out) ? out[0] : out;
    const raw = first.depth;
    const pixels = raw.width * raw.height;
    const gray = normalise(raw.data, raw.channels || 1, pixels);
    const canvas = grayToCanvas(gray, raw.width, raw.height);
    // Persist a copy so the second visit is instant. Slice because the typed
    // array may be a view onto a larger pooled buffer.
    void writeCache({
      key: cacheKey,
      width: raw.width,
      height: raw.height,
      gray: gray.slice().buffer,
      model: DEPTH_MODEL_ID,
      createdAt: Date.now(),
    });
    onPhase('done');
    return { source: 'computed', image: canvas, width: raw.width, height: raw.height };
  } finally {
    // Free the GPU buffers immediately; a phone cannot afford to hold them.
    await estimator.dispose().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function loadDepthMap(opts: LoadDepthOptions): Promise<DepthMap> {
  const {
    depthUrl,
    heroUrl,
    allowCompute = true,
    onPhase = () => undefined,
    computeTimeoutMs = DEFAULT_COMPUTE_TIMEOUT,
    signal,
  } = opts;

  const failures: string[] = [];

  // ---- 1. precomputed -----------------------------------------------------
  if (depthUrl) {
    try {
      const image = await decodeImage(depthUrl, signal);
      const { width, height } = imageSize(image);
      if (width > 0 && height > 0) {
        onPhase('precomputed');
        return { source: 'precomputed', image, width, height };
      }
      failures.push(`precomputed map at ${depthUrl} decoded to 0x0`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (!isBrowser()) {
    return { source: 'none', image: null, width: 0, height: 0 };
  }

  // ---- 2. cache -----------------------------------------------------------
  let cacheKey = '';
  try {
    cacheKey = await hashImageBytes(heroUrl, signal);
    const hit = await readCache(cacheKey);
    if (hit) {
      onPhase('cache-hit');
      const canvas = grayToCanvas(new Uint8ClampedArray(hit.gray), hit.width, hit.height);
      return { source: 'cache', image: canvas, width: hit.width, height: hit.height };
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  // ---- 3. in-browser model ------------------------------------------------
  if (allowCompute && cacheKey && (await hasWebGPU())) {
    if (inflight && inflightKey === cacheKey) return inflight;
    inflightKey = cacheKey;
    inflight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Race, do not await blindly: a stalled CDN must not leave the visitor
        // staring at a shimmer forever.
        const timeout = new Promise<DepthMap>((_, reject) => {
          timer = setTimeout(() => reject(new Error('depth inference timed out')), computeTimeoutMs);
        });
        return await Promise.race([computeDepth(heroUrl, cacheKey, onPhase), timeout]);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
        onPhase('unavailable');
        return {
          source: 'none' as const,
          image: null,
          width: 0,
          height: 0,
          error: new Error(`depth unavailable: ${failures.join('; ')}`),
        };
      } finally {
        if (timer) clearTimeout(timer);
        inflight = null;
        inflightKey = '';
      }
    })();
    return inflight;
  }

  onPhase('unavailable');
  failures.push(allowCompute ? 'WebGPU unavailable' : 'in-browser inference disabled');
  return {
    source: 'none',
    image: null,
    width: 0,
    height: 0,
    error: new Error(`depth unavailable: ${failures.join('; ')}`),
  };
}
