'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';

import PhotoIntake from '@/components/upload/PhotoIntake';
import { computeDepthAndRegions, phaseCopy } from '@/components/upload/depthRegions';
import { identifyPhoto } from '@/components/upload/identify';
import { deletePhoto, hashBlob, loadLatestPhoto, loadPhoto, savePhoto, type StoredPhoto } from '@/components/upload/photoStore';
import { buildUserMonument, type UserMonument } from '@/lib/userMonument';

/**
 * /create — a visitor's own photograph, turned into a Living Photograph.
 *
 * The whole pipeline in order, and why it is in this order:
 *
 *   1. CAPTURE. `CameraCapture` downscales to a 1600px long edge at JPEG q0.82
 *      on the device, before anything is sent. Non-negotiable on 4G.
 *   2. HASH. Content-addressed, so the same photograph twice — or a reload — is
 *      instant and never re-runs the depth model.
 *   3. DEPTH and IDENTIFY, concurrently. Depth is the slow half (seconds of
 *      WebGPU inference); Vision is a network round trip. Running them in series
 *      would double the wait for no benefit, since the names Vision supplies are
 *      only needed at the very last step, when regions are derived.
 *   4. REGIONS, from the depth map. The camera needs somewhere to go and there is
 *      no author to tell it where.
 *   5. PERSIST to IndexedDB — on the device, never to a server.
 *   6. TALK, through the same voice loop the monuments use.
 *
 * The depth path is entirely client-side, so steps 1-2, 4-5 and the entire
 * Living Photograph work with no API key at all. Only steps 3 and 6 need Sarvam,
 * and both degrade to something honest and visible rather than to a dead page.
 */

/**
 * three.js is ~600KB. The intake screen must not carry it — a visitor on 4G is
 * looking at a file picker, not a WebGL scene, and may never get past it.
 */
const PhotoConversation = dynamic(() => import('@/components/upload/PhotoConversation'), {
  ssr: false,
  loading: () => (
    <main className="flex h-dvh w-full items-center justify-center bg-night-950">
      <div className="bol-shimmer h-1 w-40 rounded-full" aria-hidden />
    </main>
  ),
});

type Phase = 'intake' | 'preparing' | 'live';

export default function CreateClient() {
  const [phase, setPhase] = useState<Phase>('intake');
  const [monument, setMonument] = useState<UserMonument | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);

  /** The blob: URL currently backing `monument.hero`. Revoked only on replace. */
  const heroUrlRef = useRef<string | null>(null);

  const setHero = useCallback((blob: Blob): string => {
    if (heroUrlRef.current) URL.revokeObjectURL(heroUrlRef.current);
    const url = URL.createObjectURL(blob);
    heroUrlRef.current = url;
    return url;
  }, []);

  useEffect(() => {
    return () => {
      if (heroUrlRef.current) URL.revokeObjectURL(heroUrlRef.current);
      heroUrlRef.current = null;
    };
  }, []);

  const restore = useCallback(
    (stored: StoredPhoto) => {
      const heroUrl = setHero(stored.blob);
      setMonument(
        buildUserMonument({
          hash: stored.hash,
          heroUrl,
          aspect: stored.aspect,
          regions: stored.regions,
          description: stored.description,
          looksLike: stored.looksLike,
          identifiedAs: stored.identifiedAs,
          matchedMonumentId: stored.matchedMonumentId,
          confidence: stored.confidence,
          depthSource: stored.depthSource,
        }),
      );
      setPhase('live');
    },
    [setHero],
  );

  // -------------------------------------------------------------------------
  // Restore across a reload
  // -------------------------------------------------------------------------

  /**
   * A phone browser will happily discard this tab while the visitor answers a
   * message. Coming back to a file picker instead of the photograph they made
   * would be the feature quietly failing, so the last one is restored in place —
   * and because lib/depth caches its map under a hash of the same bytes, the
   * depth model does not run again either.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadLatestPhoto();
      if (cancelled || !stored) return;
      restore(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [restore]);

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  const handleCapture = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setStatus('Reading your photograph…');
      setPhase('preparing');

      try {
        const hash = await hashBlob(file);

        // The same photograph again: everything is already on the device.
        const existing = await loadPhoto(hash);
        if (existing) {
          restore(existing);
          return;
        }

        const heroUrl = setHero(file);
        const { width, height } = await measure(file);

        // Concurrent on purpose — see the header comment.
        const identifying = identifyPhoto(file);
        const depth = await computeDepthAndRegions(
          heroUrl,
          identifying.then((r) => r.looksLike),
          (p) => setStatus(phaseCopy(p)),
        );
        const identified = await identifying;

        if (identified.notice) setNotice(identified.notice);
        else if (depth.depthSource === 'none') {
          setNotice(
            depth.webgpu
              ? 'A depth map could not be made for this photograph, so it will move flat, with a slow camera push.'
              : 'This browser has no WebGPU, so no depth could be inferred. Your photograph will still move — flat, with a slow camera push — and it can still talk.',
          );
        }

        const built = buildUserMonument({
          hash,
          heroUrl,
          aspect: height > 0 ? width / height : 0.75,
          regions: depth.regions,
          description: identified.description,
          looksLike: identified.looksLike,
          identifiedAs: identified.name,
          matchedMonumentId: identified.matchedMonumentId,
          confidence: identified.confidence,
          depthSource: depth.depthSource,
        });

        // On the device, keyed by the hash. Never to a server.
        await savePhoto({
          hash,
          blob: file,
          width,
          height,
          aspect: built.aspect,
          identifiedAs: built.identifiedAs,
          // The already-sanitised copy, so a reload cannot resurrect a raw
          // Vision description that mentioned a date.
          description: built.description,
          looksLike: built.looksLike,
          matchedMonumentId: built.matchedMonumentId,
          confidence: built.confidence,
          regions: built.regions,
          depthSource: built.depthSource,
          createdAt: Date.now(),
        });

        setMonument(built);
        setPhase('live');
      } catch (err) {
        setError(
          `${(err as Error)?.message ?? 'Something went wrong preparing that photograph.'} — try another photograph, or a smaller one.`,
        );
        setPhase('intake');
        setResetToken((t) => t + 1);
      }
    },
    [restore, setHero],
  );

  const handleNewPhoto = useCallback(() => {
    setMonument(null);
    setNotice(null);
    setError(null);
    setStatus(null);
    setPhase('intake');
    setResetToken((t) => t + 1);
  }, []);

  const handleForget = useCallback(async () => {
    const hash = monument?.hash;
    setMonument(null);
    setPhase('intake');
    setResetToken((t) => t + 1);
    if (hash) await deletePhoto(hash);
    if (heroUrlRef.current) {
      URL.revokeObjectURL(heroUrlRef.current);
      heroUrlRef.current = null;
    }
    setNotice('That photograph has been deleted from this device.');
  }, [monument?.hash]);

  if (phase === 'live' && monument) {
    return <PhotoConversation monument={monument} onNewPhoto={handleNewPhoto} onForget={handleForget} />;
  }

  return (
    <PhotoIntake
      onCapture={handleCapture}
      busy={phase === 'preparing'}
      status={status}
      error={error}
      notice={notice}
      resetToken={resetToken}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pixel dimensions of the downscaled JPEG, for the mesh aspect ratio.
 *
 * `CameraCapture` has already baked EXIF rotation into the pixels, so these are
 * the upright dimensions and no orientation flag needs consulting here.
 */
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
      el.onerror = () => reject(new Error('That file could not be read as an image.'));
      el.src = url;
    });
    return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
