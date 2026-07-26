import * as THREE from 'three';
import { DUST_FRAG, DUST_VERT } from './shaders';
import { clamp } from './easing';

/**
 * The atmosphere layer is what turns a displaced photograph into a place.
 *
 * Without it the eye immediately notices that nothing in the frame is moving
 * except the camera, and the whole thing collapses back into a still. Three
 * cheap ingredients: dust in the light, a bird every half-minute or so, and (in
 * the main shader) heat haze off the ground.
 */

export interface AtmosphereOptions {
  planeWidth: number;
  planeHeight: number;
  pixelRatio: number;
  /** Mote count. Trimmed automatically on low-core devices. */
  count?: number;
  birds?: boolean;
}

const BIRD_FRAMES = 4;
const BIRD_FRAME_PX = 32;

/** Seconds between bird crossings, one at a time. */
const BIRD_MIN_GAP = 20;
const BIRD_MAX_GAP = 40;

function moteCount(requested?: number): number {
  if (requested && requested > 0) return Math.round(clamp(requested, 40, 600));
  // The brief says 200-400. A 4-core phone gets the floor, a desktop the ceiling.
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return cores <= 4 ? 200 : cores <= 8 ? 300 : 380;
}

/**
 * Four frames of a bird silhouette drawn as one horizontal strip.
 *
 * Generated rather than shipped as an asset: it is a dozen lines of canvas, it
 * costs one texture upload, and it keeps the component free of binary
 * dependencies that another lane would have to remember to deploy.
 */
function makeBirdTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = BIRD_FRAME_PX * BIRD_FRAMES;
  canvas.height = BIRD_FRAME_PX;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Wing phase across the flap cycle: up, level, down, level.
    const phases = [-1, 0.1, 0.85, 0.1];
    for (let f = 0; f < BIRD_FRAMES; f++) {
      const cx = f * BIRD_FRAME_PX + BIRD_FRAME_PX / 2;
      const cy = BIRD_FRAME_PX / 2;
      const p = phases[f];
      const tip = p * 6;
      const mid = -3 - p * 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - 11, cy + tip);
      ctx.quadraticCurveTo(cx - 5.5, cy + mid, cx, cy);
      ctx.quadraticCurveTo(cx + 5.5, cy + mid, cx + 11, cy + tip);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.repeat.set(1 / BIRD_FRAMES, 1);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

interface BirdFlight {
  from: number;
  to: number;
  y: number;
  z: number;
  arc: number;
  duration: number;
  elapsed: number;
}

export class Atmosphere {
  readonly group = new THREE.Group();

  private dust: THREE.Points;
  private dustGeometry: THREE.BufferGeometry;
  private dustMaterial: THREE.ShaderMaterial;

  private bird: THREE.Sprite | null = null;
  private birdTexture: THREE.CanvasTexture | null = null;
  private birdMaterial: THREE.SpriteMaterial | null = null;
  private flight: BirdFlight | null = null;
  private nextBirdIn: number;

  private opacity = 1;
  private reducedMotion = false;
  private elapsed = 0;

  /** Half the displacement amplitude — i.e. how far back the sky sits. */
  private skyZ = -0.175;

  /** Number of motes actually allocated, after the device-class trim. */
  readonly count: number;

  private readonly planeWidth: number;
  private readonly planeHeight: number;

  constructor(opts: AtmosphereOptions) {
    this.planeWidth = opts.planeWidth;
    this.planeHeight = opts.planeHeight;

    const count = moteCount(opts.count);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    const halfW = opts.planeWidth * 0.75;
    const halfH = opts.planeHeight * 0.62;

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() * 2 - 1) * halfW;
      positions[i * 3 + 1] = (Math.random() * 2 - 1) * halfH;
      // Motes live in front of the plane, between the photograph and the lens,
      // so they catch parallax and never clip into the displaced geometry.
      positions[i * 3 + 2] = 0.06 + Math.random() * 0.5;

      seeds[i * 3] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();

      // A wide size spread is what sells scale: a few big near motes, many tiny ones.
      sizes[i] = 0.9 + Math.pow(Math.random(), 2.4) * 5.5;
    }

    this.dustGeometry = new THREE.BufferGeometry();
    this.dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.dustMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.34 },
        uPixelRatio: { value: opts.pixelRatio },
        uHalfHeight: { value: halfH },
        uColor: { value: new THREE.Color(0xffe7c9) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.count = count;
    this.dust = new THREE.Points(this.dustGeometry, this.dustMaterial);
    // The mote cloud is always around the camera; culling it by its (huge,
    // shader-displaced) bounding box would pop the whole layer in and out.
    this.dust.frustumCulled = false;
    // Must draw after the photograph. The motes write no depth, so if they were
    // sorted first the opaque-ish mesh would simply paint over them.
    this.dust.renderOrder = 5;
    this.group.add(this.dust);

    if (opts.birds !== false && typeof document !== 'undefined') {
      this.birdTexture = makeBirdTexture();
      this.birdMaterial = new THREE.SpriteMaterial({
        map: this.birdTexture,
        color: new THREE.Color(0x171310),
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      this.bird = new THREE.Sprite(this.birdMaterial);
      this.bird.scale.set(0.075, 0.075, 1);
      this.bird.visible = false;
      this.bird.renderOrder = 5;
      this.group.add(this.bird);
    }

    this.nextBirdIn = BIRD_MIN_GAP + Math.random() * (BIRD_MAX_GAP - BIRD_MIN_GAP);
  }

  setPixelRatio(ratio: number): void {
    this.dustMaterial.uniforms.uPixelRatio.value = ratio;
  }

  /**
   * Tell the layer how deep the diorama currently is, so birds can be flown just
   * in front of the sky plane. That is what lets the tower occlude them as they
   * cross — a bird that is always in front reads as a sticker on the lens.
   */
  setDepthScale(depthScale: number): void {
    this.skyZ = -depthScale * 0.5;
  }

  /**
   * Atmosphere presence, driven by the grade's luminance: moonlight has almost
   * no visible dust, midday has plenty. Called by the scene on every grade change.
   */
  setOpacity(v: number): void {
    this.opacity = clamp(v, 0, 1);
    this.dustMaterial.uniforms.uOpacity.value = this.opacity * 0.34;
  }

  /** Takes raw components rather than a Color so the caller allocates nothing. */
  setTint(r: number, g: number, b: number): void {
    (this.dustMaterial.uniforms.uColor.value as THREE.Color).setRGB(r, g, b);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    // Drifting motes and a bird crossing the frame are both motion. Reduced
    // motion means the photograph holds still; only cross-fades survive.
    this.group.visible = !on;
  }

  update(dt: number): void {
    if (this.reducedMotion) return;
    this.elapsed += dt;
    this.dustMaterial.uniforms.uTime.value = this.elapsed;
    this.updateBird(dt);
  }

  private updateBird(dt: number): void {
    if (!this.bird || !this.birdMaterial || !this.birdTexture) return;

    if (!this.flight) {
      this.nextBirdIn -= dt;
      if (this.nextBirdIn > 0) return;
      const leftToRight = Math.random() < 0.5;
      const span = this.planeWidth * 1.25;
      this.flight = {
        from: leftToRight ? -span : span,
        to: leftToRight ? span : -span,
        // Upper half only — a bird at the base of the tower reads as a bug.
        y: this.planeHeight * (0.08 + Math.random() * 0.34),
        // Just off the sky plane: far enough back that the monument occludes it,
        // near enough that it is never clipped through the sky itself.
        z: this.skyZ + 0.02 + Math.random() * 0.05,
        arc: (Math.random() * 2 - 1) * 0.05,
        duration: 7 + Math.random() * 4,
        elapsed: 0,
      };
      this.bird.visible = true;
      return;
    }

    const f = this.flight;
    f.elapsed += dt;
    const p = f.elapsed / f.duration;

    if (p >= 1) {
      this.flight = null;
      this.bird.visible = false;
      this.birdMaterial.opacity = 0;
      this.nextBirdIn = BIRD_MIN_GAP + Math.random() * (BIRD_MAX_GAP - BIRD_MIN_GAP);
      return;
    }

    this.bird.position.set(
      f.from + (f.to - f.from) * p,
      // A shallow rise-and-fall: real birds do not fly on rails.
      f.y + Math.sin(p * Math.PI) * f.arc,
      f.z,
    );
    // Mirror the sprite so the bird is never flying backwards.
    this.bird.scale.x = f.to > f.from ? 0.075 : -0.075;

    // ~9 wingbeats a second.
    const frame = Math.floor(f.elapsed * 9) % BIRD_FRAMES;
    this.birdTexture.offset.x = frame / BIRD_FRAMES;

    // Fade in and out at the frame edges so it enters and leaves like distance,
    // not like a sprite being switched on.
    const fade = Math.min(1, p / 0.14, (1 - p) / 0.14);
    this.birdMaterial.opacity = 0.62 * this.opacity * clamp(fade, 0, 1);
  }

  dispose(): void {
    this.dustGeometry.dispose();
    this.dustMaterial.dispose();
    this.birdTexture?.dispose();
    this.birdMaterial?.dispose();
    this.group.clear();
  }
}
