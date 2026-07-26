import type { Region } from '@/lib/types';
import { clamp, lerp, resolveEase, type EaseFn } from './easing';

/**
 * The cinematic camera rig.
 *
 * Everything here is deliberately small. This is a shallow diorama built from
 * one photograph — the moment the camera travels far enough to expect real
 * occlusion data, the illusion dies. So: gentle lateral moves, a dolly range of
 * roughly 60-100% of the framing distance, and offsets measured in hundredths
 * of a world unit.
 *
 * Final camera position is
 *
 *     base (tweened by `to`)  +  drift (Ken Burns)  +  orbit (idle life)
 *                             +  parallax (gyro / mouse)  +  listening pull-back
 *
 * and it always looks at the base point, so the offsets produce genuine
 * parallax rotation rather than a flat 2D slide.
 */

export interface RigFrame {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}

interface Move {
  fromX: number;
  fromY: number;
  fromZoom: number;
  fromLookZ: number;
  toX: number;
  toY: number;
  toZoom: number;
  toLookZ: number;
  elapsed: number;
  duration: number;
  ease: EaseFn;
}

export interface ToOptions {
  duration?: number;
  ease?: string;
}

export interface DriftOptions {
  amount?: number;
  duration?: number;
}

export interface OrbitOptions {
  amplitude?: number;
}

/** Hard ceiling on parallax displacement, in world units. From the brief. */
export const PARALLAX_CLAMP = 0.06;

const DEFAULT_DRIFT_AMOUNT = 0.12;
const DEFAULT_DRIFT_DURATION = 8000;
const DEFAULT_ORBIT_AMPLITUDE = 0.03;
const DEFAULT_TO_DURATION = 2400;

/**
 * Zoom multiplier applied at region.z = 0 and at region.z = 1 respectively.
 *
 * The floor is deliberately not lower. The hero is 1024x1365; on a phone the
 * cover framing already upscales it ~1.3x, and pushing past roughly 0.55 turns
 * sandstone into mush. A soft photograph stops being a photograph.
 */
const REGION_ZOOM_WIDE = 0.92;
const REGION_ZOOM_TIGHT = 0.55;

/** While the visitor is speaking we pull back this much and hold. */
const LISTENING_PULL = 1.075;

export class CameraRig {
  /** Distance at which the photograph exactly frames the viewport. */
  private framingDistance = 2;

  /** Half-extents of the plane in world units, used to clamp the framing. */
  private halfW = 0.375;
  private halfH = 0.5;

  /** Vertical half-FOV tangent, refreshed on resize. */
  private tanHalfFov = Math.tan((32 * Math.PI) / 180 / 2);
  private viewportAspect = 1;

  // Base framing, in plane coordinates. zoom multiplies framingDistance.
  private baseX = 0;
  private baseY = 0;
  private baseZoom = 1;
  private baseLookZ = 0;

  private move: Move | null = null;

  // Ken Burns push. `driftT` ping-pongs 0..1 so the push never runs out of road.
  private driftAmount = DEFAULT_DRIFT_AMOUNT;
  private driftDuration = DEFAULT_DRIFT_DURATION;
  private driftT = 0;
  private driftDir = 1;
  private driftOn = true;

  private orbitAmplitude = DEFAULT_ORBIT_AMPLITUDE;
  private orbitT = 0;
  private orbitOn = true;

  private parallaxX = 0;
  private parallaxY = 0;

  private listeningTarget = 0;
  private listeningNow = 0;

  private reducedMotion = false;

  constructor(planeWidth: number, planeHeight: number, fovDeg: number) {
    this.halfW = planeWidth / 2;
    this.halfH = planeHeight / 2;
    this.tanHalfFov = Math.tan((fovDeg * Math.PI) / 180 / 2);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    if (on) {
      // Keep the framing, drop the movement. Cross-fades still run.
      this.driftT = 0;
      this.orbitT = 0;
      this.parallaxX = 0;
      this.parallaxY = 0;
    }
  }

  /**
   * Recompute the opening framing distance.
   *
   * `contain`, not `cover`. A visitor scans a QR code and must see the whole
   * monument before the camera goes anywhere — cover framing on a 0.75-aspect
   * photograph puts a landscape viewport inside the tower's midsection, which
   * reads as a crop accident rather than as direction. Whatever falls outside
   * the plane is filled by the blurred backdrop layer, so letterboxing never
   * shows the clear colour.
   *
   * The 1.06 is breathing room: the monument should not touch the frame edge.
   */
  resize(viewportAspect: number): void {
    this.viewportAspect = viewportAspect;
    const byHeight = this.halfH / this.tanHalfFov;
    const byWidth = this.halfW / (this.tanHalfFov * viewportAspect);
    this.framingDistance = Math.max(byHeight, byWidth) * 1.06;
  }

  /**
   * How far the camera is ever allowed to stray from the plane's centre.
   *
   * The old rule — never let the view window leave the photograph — is
   * meaningless once the framing contains the whole plane, and it silently
   * clamped every region move to nothing on a tall viewport. The backdrop is
   * sized against this budget instead, so the only job left here is to stop
   * absurd excursions.
   */
  private maxExcursion(): { x: number; y: number } {
    return { x: this.halfW * 0.95, y: this.halfH * 0.95 };
  }

  /** Largest distance the camera can sit at, for sizing the backdrop. */
  get maxDistance(): number {
    return this.framingDistance * LISTENING_PULL;
  }

  get excursion(): { x: number; y: number } {
    return this.maxExcursion();
  }

  get distance(): number {
    return this.framingDistance;
  }

  /** Plane-space position of a region. Region coords are 0..1 from top-left. */
  regionPoint(r: Region): { x: number; y: number } {
    return { x: (r.x - 0.5) * this.halfW * 2, y: (0.5 - r.y) * this.halfH * 2 };
  }

  /**
   * Frame a named region.
   *
   * `region.z` is the content's *dolly* hint, not its depth: 0.15 for "the sky
   * above me" (stay wide), 0.7 for "the courtyard at my feet" (come close).
   * `surfaceZ` is the displaced height of the mesh there, so the camera
   * converges on the actual surface and parallax pivots about the subject.
   */
  to(r: Region, surfaceZ: number, opts: ToOptions = {}): void {
    const pt = this.regionPoint(r);
    const zoom = lerp(REGION_ZOOM_WIDE, REGION_ZOOM_TIGHT, clamp(r.z, 0, 1));
    this.startMove(pt.x, pt.y, zoom, surfaceZ, opts.duration ?? DEFAULT_TO_DURATION, opts.ease);
  }

  /** Return to the full frame. */
  home(opts: ToOptions = {}): void {
    this.startMove(0, 0, 1, 0, opts.duration ?? 1600, opts.ease);
  }

  private startMove(
    x: number,
    y: number,
    zoom: number,
    lookZ: number,
    duration: number,
    ease?: string,
  ): void {
    if (duration <= 0 || this.reducedMotion) {
      // Reduced motion still honours the *destination* — only the travel is cut.
      this.baseX = x;
      this.baseY = y;
      this.baseZoom = zoom;
      this.baseLookZ = lookZ;
      this.move = null;
      return;
    }
    this.move = {
      fromX: this.baseX,
      fromY: this.baseY,
      fromZoom: this.baseZoom,
      fromLookZ: this.baseLookZ,
      toX: x,
      toY: y,
      toZoom: zoom,
      toLookZ: lookZ,
      elapsed: 0,
      duration,
      ease: resolveEase(ease),
    };
  }

  driftIn(opts: DriftOptions = {}): void {
    this.driftAmount = clamp(opts.amount ?? DEFAULT_DRIFT_AMOUNT, 0, 0.4);
    this.driftDuration = Math.max(1000, opts.duration ?? DEFAULT_DRIFT_DURATION);
    this.driftOn = this.driftAmount > 0;
  }

  orbitMicro(opts: OrbitOptions = {}): void {
    this.orbitAmplitude = clamp(opts.amplitude ?? DEFAULT_ORBIT_AMPLITUDE, 0, 0.12);
    this.orbitOn = this.orbitAmplitude > 0;
  }

  setParallax(x: number, y: number): void {
    if (this.reducedMotion) {
      this.parallaxX = 0;
      this.parallaxY = 0;
      return;
    }
    this.parallaxX = clamp(x, -PARALLAX_CLAMP, PARALLAX_CLAMP);
    this.parallaxY = clamp(y, -PARALLAX_CLAMP, PARALLAX_CLAMP);
  }

  setListening(on: boolean): void {
    this.listeningTarget = on ? 1 : 0;
  }

  get listeningAmount(): number {
    return this.listeningNow;
  }

  reset(): void {
    this.move = null;
    this.baseX = 0;
    this.baseY = 0;
    this.baseZoom = 1;
    this.baseLookZ = 0;
    this.driftAmount = DEFAULT_DRIFT_AMOUNT;
    this.driftDuration = DEFAULT_DRIFT_DURATION;
    this.driftOn = true;
    this.driftT = 0;
    this.driftDir = 1;
    this.orbitAmplitude = DEFAULT_ORBIT_AMPLITUDE;
    this.orbitOn = true;
    this.listeningTarget = 0;
  }

  /** Advance the rig and produce this frame's camera placement. */
  update(dt: number): RigFrame {
    if (this.move) {
      this.move.elapsed += dt * 1000;
      const t = clamp(this.move.elapsed / this.move.duration, 0, 1);
      const e = this.move.ease(t);
      this.baseX = lerp(this.move.fromX, this.move.toX, e);
      this.baseY = lerp(this.move.fromY, this.move.toY, e);
      this.baseZoom = lerp(this.move.fromZoom, this.move.toZoom, e);
      this.baseLookZ = lerp(this.move.fromLookZ, this.move.toLookZ, e);
      if (t >= 1) this.move = null;
    }

    // Listening pull-back is a short, always-running smoothing rather than a
    // tween, so it can be interrupted mid-flight by the visitor stopping.
    this.listeningNow = lerp(this.listeningNow, this.listeningTarget, clamp(dt * 4.5, 0, 1));

    let driftK = 1;
    if (this.driftOn && !this.reducedMotion) {
      this.driftT += (dt * 1000 * this.driftDir) / this.driftDuration;
      if (this.driftT >= 1) {
        this.driftT = 1;
        this.driftDir = -1;
      } else if (this.driftT <= 0) {
        this.driftT = 0;
        this.driftDir = 1;
      }
      // Sine-eased ping-pong: the reversal at each end is invisible because the
      // velocity is already zero there.
      const s = 0.5 - 0.5 * Math.cos(Math.PI * this.driftT);
      driftK = 1 - this.driftAmount * s;
    }

    let orbitX = 0;
    let orbitY = 0;
    if (this.orbitOn && !this.reducedMotion) {
      this.orbitT += dt;
      // Two incommensurate periods (~30s and ~43s) so the idle motion never
      // visibly loops during a conversation.
      orbitX = Math.sin(this.orbitT * 0.21) * this.orbitAmplitude;
      orbitY = Math.cos(this.orbitT * 0.147) * this.orbitAmplitude * 0.6;
    }

    const listenPull = lerp(1, LISTENING_PULL, this.listeningNow);
    const dist = this.framingDistance * this.baseZoom * driftK * listenPull;

    let camX = this.baseX + orbitX + this.parallaxX;
    let camY = this.baseY + orbitY + this.parallaxY;

    const limit = this.maxExcursion();
    camX = clamp(camX, -limit.x, limit.x);
    camY = clamp(camY, -limit.y, limit.y);

    return {
      x: camX,
      y: camY,
      z: dist + this.baseLookZ,
      lookX: this.baseX,
      lookY: this.baseY,
      lookZ: this.baseLookZ,
    };
  }
}
