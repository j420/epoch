import { clamp, smoothing } from './easing';
import { PARALLAX_CLAMP } from './rig';

/**
 * Parallax input: phone gyroscope where available, mouse everywhere else.
 *
 * The output is heavily smoothed on purpose. Raw `deviceorientation` is noisy
 * and instantaneous; feeding it straight to the camera makes an 800-year-old
 * tower feel like it is taped to the phone. Lerping at 0.06 per 60 Hz frame
 * gives the world perceptible weight — it lags your hand and settles.
 */

export interface ParallaxOptions {
  clampUnits?: number;
  /** Fraction of the remaining distance closed per 60 Hz frame. */
  lerpFactor?: number;
  /** Degrees of tilt that map to full deflection. */
  tiltRange?: number;
  onPermissionChange?: (state: GyroPermission) => void;
}

export type GyroPermission = 'unsupported' | 'prompt' | 'granted' | 'denied';

/** iOS 13+ adds a static `requestPermission` that lib.dom does not declare. */
type GatedDeviceOrientation = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<PermissionState | 'granted' | 'denied'>;
};

export class ParallaxInput {
  private targetX = 0;
  private targetY = 0;
  private smoothX = 0;
  private smoothY = 0;

  private readonly clampUnits: number;
  private readonly lerpFactor: number;
  private readonly tiltRange: number;

  private enabled = true;
  private disposed = false;

  /** The visitor's natural holding angle, captured on the first gyro event. */
  private baseBeta: number | null = null;
  private baseGamma: number | null = null;

  private permission: GyroPermission = 'unsupported';
  private gyroAttached = false;

  private readonly el: HTMLElement;
  private readonly onPermissionChange?: (state: GyroPermission) => void;

  constructor(el: HTMLElement, opts: ParallaxOptions = {}) {
    this.el = el;
    this.clampUnits = opts.clampUnits ?? PARALLAX_CLAMP;
    this.lerpFactor = opts.lerpFactor ?? 0.06;
    this.tiltRange = opts.tiltRange ?? 22;
    this.onPermissionChange = opts.onPermissionChange;

    this.el.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.el.addEventListener('pointerleave', this.onPointerLeave, { passive: true });

    if (typeof DeviceOrientationEvent !== 'undefined') {
      const gated = DeviceOrientationEvent as GatedDeviceOrientation;
      if (typeof gated.requestPermission === 'function') {
        // iOS: the gyro is gated behind a user gesture. Ask on the first tap
        // anywhere on the photograph — never with a modal of our own, because
        // the brief allows no chrome the visitor did not ask for.
        this.setPermission('prompt');
        this.el.addEventListener('pointerdown', this.onFirstGesture, { once: true });
      } else {
        this.setPermission('granted');
        this.attachGyro();
      }
    }
  }

  private setPermission(state: GyroPermission): void {
    if (this.permission === state) return;
    this.permission = state;
    this.onPermissionChange?.(state);
  }

  get permissionState(): GyroPermission {
    return this.permission;
  }

  get usingGyro(): boolean {
    return this.gyroAttached;
  }

  private onFirstGesture = (): void => {
    void this.requestGyroPermission();
  };

  /** Safe to call from a click handler; resolves false if refused or absent. */
  async requestGyroPermission(): Promise<boolean> {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    const gated = DeviceOrientationEvent as GatedDeviceOrientation;
    if (typeof gated.requestPermission !== 'function') {
      this.attachGyro();
      return true;
    }
    try {
      const res = await gated.requestPermission();
      if (res === 'granted') {
        this.setPermission('granted');
        this.attachGyro();
        return true;
      }
      // Declining the gyro is not an error: mouse/touch parallax still works.
      this.setPermission('denied');
      return false;
    } catch {
      this.setPermission('denied');
      return false;
    }
  }

  private attachGyro(): void {
    if (this.gyroAttached || this.disposed) return;
    window.addEventListener('deviceorientation', this.onOrientation, { passive: true });
    this.gyroAttached = true;
  }

  private onPointerMove = (e: PointerEvent): void => {
    // Once the gyro is live it owns the parallax; a stray touch must not fight it.
    if (!this.enabled || this.gyroAttached) return;
    const rect = this.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    // Negated: moving the pointer right should swing the camera left, the way
    // leaning right reveals the right-hand side of a real object.
    this.targetX = clamp(-nx, -1, 1) * this.clampUnits;
    this.targetY = clamp(ny, -1, 1) * this.clampUnits;
  };

  private onPointerLeave = (): void => {
    this.targetX = 0;
    this.targetY = 0;
  };

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (!this.enabled) return;
    const { beta, gamma } = e;
    if (beta === null || gamma === null) return;

    // Calibrate against however the visitor happens to be holding the phone,
    // rather than assuming it is upright. Nobody holds a phone at beta = 90.
    if (this.baseBeta === null || this.baseGamma === null) {
      this.baseBeta = beta;
      this.baseGamma = gamma;
      return;
    }

    const dBeta = clamp(beta - this.baseBeta, -this.tiltRange, this.tiltRange) / this.tiltRange;
    const dGamma = clamp(gamma - this.baseGamma, -this.tiltRange, this.tiltRange) / this.tiltRange;

    this.targetX = clamp(dGamma, -1, 1) * this.clampUnits;
    // Tilting the top of the phone away from you (beta up) should look upward.
    this.targetY = clamp(-dBeta, -1, 1) * this.clampUnits;

    // Slowly re-centre the baseline so a visitor who walks around, or hands the
    // phone to a friend, is not stuck at the rail.
    this.baseBeta += (beta - this.baseBeta) * 0.0015;
    this.baseGamma += (gamma - this.baseGamma) * 0.0015;
  };

  /** Drop the calibration so the next gyro event re-zeroes on the current pose. */
  recentre(): void {
    this.baseBeta = null;
    this.baseGamma = null;
    this.targetX = 0;
    this.targetY = 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.targetX = 0;
      this.targetY = 0;
    }
  }

  update(dt: number): { x: number; y: number } {
    const k = smoothing(this.lerpFactor, dt);
    this.smoothX += (this.targetX - this.smoothX) * k;
    this.smoothY += (this.targetY - this.smoothY) * k;
    return { x: this.smoothX, y: this.smoothY };
  }

  dispose(): void {
    this.disposed = true;
    this.el.removeEventListener('pointermove', this.onPointerMove);
    this.el.removeEventListener('pointerleave', this.onPointerLeave);
    this.el.removeEventListener('pointerdown', this.onFirstGesture);
    if (this.gyroAttached) {
      window.removeEventListener('deviceorientation', this.onOrientation);
      this.gyroAttached = false;
    }
  }
}
