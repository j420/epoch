'use client';

/**
 * Depth, and the regions derived from it, for a photograph nobody has authored.
 *
 * DEPTH: we do not reimplement any of it. `lib/depth.ts` already owns the whole
 * policy — precomputed map, then its IndexedDB cache, then Depth Anything V2
 * Small on WebGPU, then an honest `{ source: 'none' }` that the renderer turns
 * into a flat plane with Ken Burns. All this module does is call it with the
 * visitor's blob URL instead of a monument's hero, and read the result.
 *
 * Running it here rather than leaving it to `PhotoScene` is deliberate and costs
 * nothing: we need the depth pixels ourselves to derive regions, and lib/depth
 * caches its result under a hash of the hero bytes — so when `PhotoScene` asks
 * for the same map a moment later it hits `cache-hit` instead of running the
 * model a second time. One inference, two consumers.
 *
 * REGIONS: the camera rig needs named places to go, and there is no author to
 * name them. `deriveRegions` in lib/userMonument reads the depth map for the
 * geometry; Vision supplies names only where it actually reported something.
 */

import { hasWebGPU, loadDepthMap, type DepthPhase, type DepthSource } from '@/lib/depth';
import type { Region } from '@/lib/types';
import { deriveRegions, fallbackRegions } from '@/lib/userMonument';

/** Width of the CPU-side grid we analyse. 64 columns is ~4KB and plenty for a centroid. */
const GRID_W = 64;

export interface DepthOutcome {
  depthSource: DepthSource;
  regions: Region[];
  /** Whether this device could run the model at all. Reported honestly in the UI. */
  webgpu: boolean;
  /** Present when depth could not be produced. Shown, never swallowed. */
  error: string | null;
}

/**
 * Read a depth map back into a small row-major Float32 grid, 0..1, where 1 is
 * nearest. Depth Anything emits relative INVERSE depth and lib/depth normalises
 * it to the full 0..255 range, so "bright is near" — the same convention the
 * vertex shader relies on.
 */
function toGrid(image: HTMLImageElement | HTMLCanvasElement, width: number, height: number) {
  const w = Math.min(GRID_W, Math.max(4, width));
  const h = Math.max(4, Math.round((w * height) / Math.max(width, 1)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4] / 255;
  return { data: out, width: w, height: h };
}

/**
 * Generate a depth map for the visitor's photograph and derive its regions.
 *
 * Never throws. Every failure lands on `fallbackRegions` — fixed thirds, which
 * are always geometrically valid — so the camera always has somewhere to go even
 * when there is no depth at all.
 */
export async function computeDepthAndRegions(
  heroUrl: string,
  /**
   * Accepts a promise so the Sarvam Vision call and the depth inference can run
   * concurrently — the names are only needed at the very end, and inference is
   * the slow half by an order of magnitude.
   */
  looksLike: string[] | Promise<string[]> = [],
  onPhase?: (phase: DepthPhase) => void,
  signal?: AbortSignal,
): Promise<DepthOutcome> {
  const webgpu = await hasWebGPU().catch(() => false);
  const names = async () => {
    try {
      return (await looksLike) ?? [];
    } catch {
      return [];
    }
  };

  let map;
  try {
    map = await loadDepthMap({
      // No precomputed map exists for a photograph taken thirty seconds ago.
      depthUrl: null,
      heroUrl,
      allowCompute: true,
      onPhase,
      signal,
    });
  } catch (err) {
    return {
      depthSource: 'none',
      regions: fallbackRegions(await names()),
      webgpu,
      error: (err as Error)?.message ?? 'depth generation failed',
    };
  }

  if (!map.image) {
    // The documented, expected outcome on a phone without WebGPU. The
    // photograph still moves — flat plane, Ken Burns — and the regions are
    // still real places on the frame for the camera to travel to.
    return {
      depthSource: map.source,
      regions: fallbackRegions(await names()),
      webgpu,
      error: map.error?.message ?? (webgpu ? null : 'This browser has no WebGPU, so no depth map could be made.'),
    };
  }

  const seen = await names();
  try {
    const grid = toGrid(map.image, map.width, map.height);
    if (!grid) {
      return { depthSource: map.source, regions: fallbackRegions(seen), webgpu, error: null };
    }
    return { depthSource: map.source, regions: deriveRegions(grid, seen), webgpu, error: null };
  } catch (err) {
    // Canvas readback can fail on a tainted or oversized surface. We still have
    // a depth map for the renderer; only the region derivation falls back.
    return {
      depthSource: map.source,
      regions: fallbackRegions(seen),
      webgpu,
      error: (err as Error)?.message ?? null,
    };
  }
}

/** Plain-language progress copy for the shimmer, so the wait is never a mystery. */
export function phaseCopy(phase: DepthPhase | 'loading' | null): string {
  switch (phase) {
    case 'cache-hit':
      return 'Found the depth from last time.';
    case 'model-download':
      return 'Fetching the depth model — about 25 MB, once per device.';
    case 'model-run':
      return 'Finding the depth in your photograph…';
    case 'precomputed':
    case 'done':
      return 'Depth ready.';
    case 'unavailable':
      return 'No depth on this device — your photograph will still move, gently and flat.';
    default:
      return 'Waking your photograph…';
  }
}
