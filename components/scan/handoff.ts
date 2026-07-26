'use client';

import { computeDepthAndRegions, phaseCopy } from '@/components/upload/depthRegions';
import { identifyPhoto } from '@/components/upload/identify';
import { hashBlob, loadPhoto, savePhoto } from '@/components/upload/photoStore';
import { fallbackRegions } from '@/lib/userMonument';

/**
 * The way out when nothing matched: turn the frame in the viewfinder into the
 * ungrounded Living Photograph that /create already knows how to talk to.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BUILT THIS WAY
 * ---------------------------------------------------------------------------
 *
 * The visitor must never be dead-ended. They pointed a camera at a building,
 * we could not place it among the ten, and "sorry" is not an answer — /create
 * gives them a photograph that moves and speaks and is honest about knowing
 * nothing about itself.
 *
 * /create restores the most recent photograph from IndexedDB on mount, so the
 * handoff is simply: build the same record /create would have built, write it,
 * and navigate. Nothing in the upload lane has to change, and the visitor
 * arrives at a photograph that is already awake instead of at a file picker.
 *
 * Everything here reuses the upload lane's public surface rather than
 * reimplementing it — the same identify call, the same depth-and-regions
 * pipeline, the same store. The one thing this file adds is that the frame
 * comes from a live camera rather than a file input.
 *
 * NEVER THROWS. Every failure still produces a usable photograph, because the
 * fallback regions are fixed thirds and are always geometrically valid.
 */

export interface HandoffOutcome {
  /** IndexedDB key and monument id suffix. */
  hash: string;
  /**
   * False when this browser has no usable IndexedDB (private-mode Safari, some
   * Android WebViews). /create will show its intake screen instead of the
   * photograph, so the visitor has to be told rather than left confused.
   */
  persisted: boolean;
  /** Honest note about what could not be done. Null when everything worked. */
  notice: string | null;
}

/**
 * Prepare the ungrounded photograph and leave it where /create will find it.
 *
 * @param frame  a JPEG already downscaled to the upload lane's 1600px / q0.82.
 * @param onStatus  progress copy for the visitor. This can take several seconds
 *                  on a phone: the depth model is real inference, not a spinner.
 */
export async function prepareUngroundedPhotograph(
  frame: Blob,
  onStatus?: (status: string) => void,
): Promise<HandoffOutcome> {
  const say = (s: string) => onStatus?.(s);

  say('Reading your photograph…');
  const hash = await hashBlob(frame);

  // The same frame again — a visitor who tapped twice, or came back. Everything
  // is already on the device and the depth model must not run a second time.
  const existing = await loadPhoto(hash);
  if (existing) return { hash, persisted: true, notice: null };

  const { width, height } = await measure(frame);
  const heroUrl = URL.createObjectURL(frame);

  try {
    // Concurrent on purpose, exactly as /create does it: depth is seconds of
    // WebGPU inference, identification is a network round trip, and the names
    // are only needed at the very last step when regions are derived.
    const identifying = identifyPhoto(frame);
    const depth = await computeDepthAndRegions(
      heroUrl,
      identifying.then((r) => r.looksLike).catch(() => []),
      (p) => say(phaseCopy(p)),
    );
    const identified = await identifying.catch(() => null);

    const regions = depth.regions.length ? depth.regions : fallbackRegions(identified?.looksLike ?? []);

    say('Waking your photograph…');
    await savePhoto({
      hash,
      blob: frame,
      width,
      height,
      aspect: height > 0 ? width / height : 0.75,
      identifiedAs: identified?.name ?? null,
      // Already sanitised by /api/photo/identify, and sanitised again on the way
      // into /api/photo/answer. This copy is display and cache only.
      description: identified?.description ?? '',
      looksLike: identified?.looksLike ?? [],
      matchedMonumentId: identified?.matchedMonumentId ?? null,
      confidence: identified?.confidence ?? 'low',
      regions,
      depthSource: depth.depthSource,
      createdAt: Date.now(),
    });

    const stored = await loadPhoto(hash);

    const notice =
      identified?.notice ??
      (depth.depthSource === 'none'
        ? depth.webgpu
          ? 'No depth could be found in this frame, so your photograph will move flat, with a slow camera push.'
          : 'This browser has no WebGPU, so no depth could be inferred. Your photograph will still move — flat, with a slow camera push — and it can still talk.'
        : null);

    return { hash, persisted: Boolean(stored), notice };
  } finally {
    // lib/depth has already hashed and cached the map under these bytes, so the
    // renderer on /create will hit its cache rather than this URL.
    URL.revokeObjectURL(heroUrl);
  }
}

/** Pixel dimensions, for the mesh aspect ratio. Never throws. */
async function measure(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      if (size.width && size.height) return size;
    } catch {
      /* fall through to the <img> path */
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('unreadable'));
      el.src = url;
    });
    return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  } catch {
    return { width: 0, height: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}
