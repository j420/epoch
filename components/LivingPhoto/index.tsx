'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Grade } from '@/lib/types';
import type { DepthPhase } from '@/lib/depth';
import { PhotoScene } from './scene';
import type { LivingPhotoHandle, LivingPhotoProps } from './types';

export type { LivingPhotoHandle, LivingPhotoProps, LivingPhotoStatus } from './types';

/** className values that already establish a containing block for the overlays. */
const POSITIONED = /(^|\s)(absolute|fixed|relative|sticky)(\s|$)/;

/**
 * A real photograph, given depth, motion, atmosphere and direction.
 *
 * This component is a thin shell. All the WebGL lives in `PhotoScene`, which is
 * constructed synchronously, so every method on the handle is safe to call from
 * the very first render — the director does not have to wait for `onReady`
 * before issuing `grade()` or `to()`.
 *
 * Failure ladder, and none of these rungs is a blank screen:
 *   WebGL + depth map      -> full 2.5D diorama
 *   WebGL, no depth map    -> flat plane, Ken Burns, atmosphere, grades  (+ onError)
 *   no WebGL               -> static <img> with a CSS Ken Burns          (+ onError)
 *   no image either        -> honest text card with the monument's name  (+ onError)
 */
const LivingPhoto = forwardRef<LivingPhotoHandle, LivingPhotoProps>(function LivingPhoto(
  {
    monument,
    className,
    depthScale = 0.35,
    onReady,
    onError,
    vignette = 0.35,
    edgeThreshold = 0.06,
    atmosphere = true,
    initialGrade = 'noon',
    allowDepthCompute = true,
    onStatus,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PhotoScene | null>(null);

  // Callbacks live in refs so a parent re-render with fresh inline handlers can
  // never tear down and rebuild the GL context.
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onStatusRef = useRef(onStatus);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onStatusRef.current = onStatus;

  const [fallback, setFallback] = useState<'none' | 'image' | 'text'>('none');
  const [revealed, setRevealed] = useState(false);
  const [phase, setPhase] = useState<DepthPhase | 'loading'>('loading');

  const report = useCallback((e: Error) => {
    onErrorRef.current?.(e);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let scene: PhotoScene | null = null;
    try {
      scene = new PhotoScene(host, monument, {
        depthScale,
        vignette,
        edgeThreshold,
        atmosphere,
        initialGrade,
        allowDepthCompute,
        onReady: () => {
          setRevealed(true);
          onReadyRef.current?.();
        },
        onPhase: setPhase,
        onError: report,
        onFatal: () => {
          setFallback('image');
          setRevealed(true);
        },
      });
    } catch (err) {
      // WebGLRenderer throws when no context can be created at all: an old
      // WebView, a blocklisted driver, or too many live contexts on the page.
      const e = err instanceof Error ? err : new Error(String(err));
      report(new Error(`WebGL unavailable: ${e.message}`, { cause: e }));
      setFallback('image');
      setRevealed(true);
      return;
    }

    sceneRef.current = scene;
    scene.start();
    void scene.load();

    return () => {
      sceneRef.current = null;
      scene?.dispose();
    };
    // Rebuild only when the monument itself changes. Everything else is applied
    // live through the setters below; `atmosphere` and `allowDepthCompute` are
    // construction-time choices, so change them with a React `key` if you must.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monument, report]);

  // --- live prop updates, no remount ----------------------------------------
  useEffect(() => {
    sceneRef.current?.setDepthScale(depthScale);
  }, [depthScale]);

  useEffect(() => {
    sceneRef.current?.setVignette(vignette);
  }, [vignette]);

  useEffect(() => {
    sceneRef.current?.setEdgeThreshold(edgeThreshold);
  }, [edgeThreshold]);

  // --- diagnostics poll, only when someone is listening ----------------------
  useEffect(() => {
    if (!onStatus) return;
    const id = window.setInterval(() => {
      const s = sceneRef.current?.status();
      if (s) onStatusRef.current?.(s);
    }, 250);
    return () => window.clearInterval(id);
  }, [onStatus]);

  useImperativeHandle(
    ref,
    (): LivingPhotoHandle => ({
      to: (region, opts) => sceneRef.current?.to(region, opts ?? {}),
      driftIn: (opts) => sceneRef.current?.driftIn(opts ?? {}),
      orbitMicro: (opts) => sceneRef.current?.orbitMicro(opts ?? {}),
      grade: (g: Grade, ms?: number) => sceneRef.current?.grade(g, ms),
      era: (year, ms) => sceneRef.current?.era(year, ms),
      focus: (region, radius) => sceneRef.current?.focus(region, radius),
      listening: (on) => sceneRef.current?.listening(on),
      reset: () => sceneRef.current?.reset(),
    }),
    [],
  );

  const alt = monument.displayName['en-IN'] ?? monument.id;
  const computing = phase === 'model-download' || phase === 'model-run';
  const positioned = POSITIONED.test(className ?? '');

  return (
    <div
      className={className ?? 'relative h-full w-full overflow-hidden bg-night-900'}
      // Only forced when the caller's own classes do not already establish one —
      // otherwise an `absolute inset-0` className would be silently overridden.
      style={positioned ? undefined : { position: 'relative' }}
    >
      {/* Scoped keyframes: this lane touches no global stylesheet. */}
      <style>{KEN_BURNS_CSS}</style>

      {/* three.js owns every child of this node. Keeping it separate from the
          React-rendered overlays means the two never fight over the DOM. */}
      <div ref={hostRef} className="absolute inset-0" />

      {fallback === 'image' && (
        <img
          src={monument.hero}
          alt={alt}
          className="bol-kenburns absolute inset-0 h-full w-full object-cover"
          onError={() => setFallback('text')}
        />
      )}

      {fallback === 'text' && (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-center">
          <div className="bol-glass max-w-sm p-6">
            <p className="indic-text text-sm text-sandstone-100">
              I am {alt}. My picture will not load right now, but I can still hear you.
            </p>
          </div>
        </div>
      )}

      {/* Before the photograph arrives: a full shimmer. */}
      {!revealed && fallback === 'none' && (
        <div className="bol-shimmer pointer-events-none absolute inset-0" aria-hidden="true" />
      )}

      {/* While depth is being inferred in the browser: a hairline shimmer at the
          foot of the frame. The photograph is already moving, so covering it
          would be a downgrade — this just admits that more is coming. */}
      {revealed && computing && fallback === 'none' && (
        <div
          className="bol-shimmer pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
          aria-hidden="true"
        />
      )}
    </div>
  );
});

/**
 * A slow push and drift for the no-WebGL path, timed to match the rig's
 * `driftIn` defaults so the fallback reads as the same film without the depth.
 */
const KEN_BURNS_CSS = `
@keyframes bol-kenburns {
  0%   { transform: scale(1.06) translate3d(0, 0, 0); }
  50%  { transform: scale(1.18) translate3d(-1.2%, -1.6%, 0); }
  100% { transform: scale(1.06) translate3d(0, 0, 0); }
}
.bol-kenburns {
  animation: bol-kenburns 32s ease-in-out infinite;
  will-change: transform;
}
@media (prefers-reduced-motion: reduce) {
  .bol-kenburns { animation: none; }
}
`;

export default LivingPhoto;
