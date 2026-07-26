export type EaseFn = (t: number) => number;

/**
 * The camera never snaps. Every one of these starts and ends at zero velocity
 * except the deliberately linear one, because a photograph that jerks stops
 * being a photograph.
 */
export const EASES: Record<string, EaseFn> = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};

export const DEFAULT_EASE = 'easeInOutCubic';

export function resolveEase(name?: string | null): EaseFn {
  return (name && EASES[name]) || EASES[DEFAULT_EASE];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `factor` is the fraction to close per 60 Hz frame, which is how the brief
 * specifies the gyro damping (0.06). Converting through dt keeps the same
 * physical feel on a 120 Hz phone and on a stuttering 30 fps one — without
 * this, a dropped frame makes the world lurch.
 */
export function smoothing(factor: number, dt: number): number {
  return 1 - Math.pow(1 - clamp(factor, 0, 1), Math.max(dt, 0) * 60);
}
