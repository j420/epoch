import type { Grade, Monument } from '@/lib/types';
import type { DepthPhase, DepthSource } from '@/lib/depth';

/**
 * The contract between the visual lane and everything else in Bol.
 *
 * This interface is frozen in `docs/BUILD-CONTRACT.md` — the director, the voice
 * loop and the debug page all drive the photograph through exactly these eight
 * methods. Every one of them is safe to call before the scene has finished
 * loading and safe to call after unmount; nothing here throws.
 */
export interface LivingPhotoHandle {
  /** Frame a named region from the monument JSON. */
  to(region: string, opts?: { duration?: number; ease?: string }): void;
  /** Continuous slow Ken Burns push. */
  driftIn(opts?: { amount?: number; duration?: number }): void;
  /** Idle life. Never stops. */
  orbitMicro(opts?: { amplitude?: number }): void;
  /** Cross-fade the time-of-day grade. */
  grade(g: Grade, ms?: number): void;
  /** Cross-fade to an archival era layer, or back to the present with `null`. */
  era(year: string | null, ms?: number): void;
  /** Spotlight a region by desaturating and darkening everything else. */
  focus(region: string | null, radius?: number): void;
  /** While the visitor speaks: pull back slightly + desaturate a touch. */
  listening(on: boolean): void;
  /** Back to the opening frame, present day, neutral grade. */
  reset(): void;
}

/** Diagnostics surfaced through the optional `onStatus` prop. Debug UI only. */
export interface LivingPhotoStatus {
  ready: boolean;
  webgl: boolean;
  depthSource: DepthSource;
  depthPhase: DepthPhase | 'loading';
  reducedMotion: boolean;
  fps: number;
  pixelRatio: number;
  moteCount: number;
}

export interface LivingPhotoProps {
  monument: Monument;
  className?: string;
  /** Displacement amplitude in world units. 0.35 is the tuned default. */
  depthScale?: number;
  onReady?: () => void;
  onError?: (e: Error) => void;

  // --- additive, optional; the mandatory contract above is unchanged ---------
  /** Vignette strength 0..1. Default 0.35. */
  vignette?: number;
  /** Depth-gradient threshold for the silhouette discard. Default 0.06. */
  edgeThreshold?: number;
  /** Set false to skip dust and birds entirely (debug / very low-end). */
  atmosphere?: boolean;
  /** Grade to open on. Default 'noon'. */
  initialGrade?: Grade;
  /** Set false to never run the in-browser depth model. */
  allowDepthCompute?: boolean;
  /** Diagnostics poll, ~4 Hz. Only wire this up in the debug route. */
  onStatus?: (s: LivingPhotoStatus) => void;
}
