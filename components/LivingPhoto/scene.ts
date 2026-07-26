import * as THREE from 'three';
import type { Grade, Monument, Region } from '@/lib/types';
import { findRegion } from '@/lib/monuments';
import { loadDepthMap, type DepthMap, type DepthPhase, type DepthSource } from '@/lib/depth';
import {
  DEFAULT_GRADE,
  GRADES,
  GRADE_SATURATION,
  gradeLuminance,
  gradeShimmer,
} from '@/lib/grades';
import { PHOTO_FRAG, PHOTO_VERT } from './shaders';
import { CameraRig, type DriftOptions, type OrbitOptions, type ToOptions } from './rig';
import { ParallaxInput } from './parallax';
import { Atmosphere } from './atmosphere';
import { clamp, lerp, resolveEase } from './easing';
import type { LivingPhotoStatus } from './types';

/**
 * The living photograph.
 *
 * A single high-resolution photograph displaced by a depth map into a shallow
 * 2.5D diorama, with a cinematic rig moving through it. Everything imperative
 * lives here so the React wrapper is a thin mount/unmount shell and disposal is
 * one call rather than a dozen effect cleanups.
 *
 * Layers, back to front:
 *   1. backdrop  — flat, blurred, dimmed copy of the photo. Fills the silhouette
 *                  slivers the displaced mesh discards, so an edge is never a hole.
 *   2. mesh      — 256x256 displaced plane, the photograph proper.
 *   3. atmosphere— dust motes and the occasional bird, additive, in front.
 */

const SEGMENTS = 256;
const FOV_DEG = 32;

const DEFAULT_DEPTH_SCALE = 0.35;
const DEFAULT_VIGNETTE = 0.35;
const DEFAULT_EDGE_THRESHOLD = 0.06;
const DEFAULT_FOCUS_RADIUS = 0.26;

const GRADE_MS = 1400;
const ERA_MS = 1800;
const FOCUS_MS = 900;

/** Resolution of the CPU-side depth copy used to aim the camera at a surface. */
const DEPTH_SAMPLE_W = 96;

export interface SceneOptions {
  depthScale?: number;
  vignette?: number;
  edgeThreshold?: number;
  atmosphere?: boolean;
  initialGrade?: Grade;
  allowDepthCompute?: boolean;
  onReady?: () => void;
  onError?: (e: Error) => void;
  onPhase?: (p: DepthPhase | 'loading') => void;
  /** The GL path cannot produce a picture at all — put up the static fallback. */
  onFatal?: () => void;
}

interface GradeState {
  tint: THREE.Vector3;
  lift: number;
  brightness: number;
  saturation: number;
  shimmer: number;
}

function gradeState(g: Grade): GradeState {
  const def = GRADES[g];
  return {
    tint: new THREE.Vector3(def.tint[0], def.tint[1], def.tint[2]),
    lift: def.lift,
    brightness: def.brightness,
    saturation: GRADE_SATURATION[g],
    shimmer: gradeShimmer(g),
  };
}

type Ticker = (dt: number) => boolean;

export class PhotoScene {
  readonly canvas: HTMLCanvasElement;

  private readonly container: HTMLElement;
  private readonly monument: Monument;
  private readonly opts: SceneOptions;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  private geometry: THREE.PlaneGeometry;
  private backdropGeometry: THREE.PlaneGeometry;
  private material: THREE.ShaderMaterial;
  private backdropMaterial: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private backdrop: THREE.Mesh;

  private rig: CameraRig;
  private parallax: ParallaxInput;
  private atmosphere: Atmosphere | null = null;

  private placeholderPhoto: THREE.DataTexture;
  private placeholderDepth: THREE.DataTexture;
  private photoTexture: THREE.Texture | null = null;
  private depthTexture: THREE.Texture | null = null;
  private eraTextures = new Map<string, THREE.Texture>();

  private planeWidth: number;
  private planeHeight = 1;
  private depthScale: number;

  /** Downsampled depth, row-major, 0..1. Used to aim `to()` at the real surface. */
  private depthSamples: Float32Array | null = null;
  private depthSampleW = 0;
  private depthSampleH = 0;

  private gradeNow: GradeState;
  private currentGrade: Grade;
  private currentEra: string | null = null;

  private tickers = new Map<string, Ticker>();

  private raf = 0;
  private running = false;
  private lastFrame = 0;
  private elapsed = 0;
  private fps = 60;
  private slowFrames = 0;
  private degraded = false;

  private ready = false;
  private disposed = false;
  private webglOk = true;
  private visible = true;
  private inView = true;
  private depthSource: DepthSource = 'none';
  private depthPhase: DepthPhase | 'loading' = 'loading';
  private pixelRatio = 1;
  private moteCount = 0;

  private reducedMotion = false;
  private motionQuery: MediaQueryList | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private abort = new AbortController();

  // -------------------------------------------------------------------------
  // Construction — fully synchronous so the public API works from frame zero.
  // -------------------------------------------------------------------------

  constructor(container: HTMLElement, monument: Monument, opts: SceneOptions = {}) {
    this.container = container;
    this.monument = monument;
    this.opts = opts;

    this.planeWidth = monument.aspect > 0 ? monument.aspect : 0.75;
    this.depthScale = opts.depthScale ?? DEFAULT_DEPTH_SCALE;
    this.currentGrade = opts.initialGrade ?? DEFAULT_GRADE;
    this.gradeNow = gradeState(this.currentGrade);

    this.pixelRatio = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      2,
    );

    this.renderer = new THREE.WebGLRenderer({
      // MSAA on a 66k-vertex displaced plane is not free. Above DPR 1.5 the
      // extra resolution already hides the stair-stepping on the discard edges,
      // so we only pay for antialiasing where it actually shows.
      antialias: this.pixelRatio < 1.5,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.canvas = this.renderer.domElement;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x0a0908, 1);
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'pan-y';
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 40);

    // 1x1 stand-ins so the first frames are the page background rather than a
    // white flash, and so every uniform is valid before any asset resolves.
    this.placeholderPhoto = new THREE.DataTexture(
      new Uint8Array([10, 9, 8, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    this.placeholderPhoto.colorSpace = THREE.SRGBColorSpace;
    this.placeholderPhoto.needsUpdate = true;

    this.placeholderDepth = new THREE.DataTexture(
      new Uint8Array([128, 128, 128, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    this.placeholderDepth.colorSpace = THREE.NoColorSpace;
    this.placeholderDepth.needsUpdate = true;

    const shared = {
      uPhotoA: { value: this.placeholderPhoto as THREE.Texture },
      uPhotoB: { value: this.placeholderPhoto as THREE.Texture },
      uEraMix: { value: 0 },
      uTint: { value: this.gradeNow.tint.clone() },
      uLift: { value: this.gradeNow.lift },
      uBrightness: { value: this.gradeNow.brightness },
      uSaturation: { value: this.gradeNow.saturation },
      uVignette: { value: opts.vignette ?? DEFAULT_VIGNETTE },
      uFocusPoint: { value: new THREE.Vector2(0.5, 0.5) },
      uFocusRadius: { value: DEFAULT_FOCUS_RADIUS },
      uFocusStrength: { value: 0 },
      uEdgeThreshold: { value: opts.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD },
      uAspect: { value: this.planeWidth / this.planeHeight },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uShimmer: { value: this.gradeNow.shimmer },
      // Starts fully transparent and fades up when the photograph arrives.
      uOpacity: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: PHOTO_VERT,
      fragmentShader: PHOTO_FRAG,
      uniforms: {
        ...shared,
        uDepth: { value: this.placeholderDepth as THREE.Texture },
        uDepthScale: { value: this.depthScale },
        uHasDepth: { value: 0 },
        uGradStep: { value: 1 / SEGMENTS },
        uBackdrop: { value: 0 },
      },
      transparent: true,
      depthWrite: true,
    });

    // Spreading `shared` shares the *same uniform objects*, so a grade change
    // reaches both layers with one write and they can never drift apart.
    this.backdropMaterial = new THREE.ShaderMaterial({
      vertexShader: PHOTO_VERT,
      fragmentShader: PHOTO_FRAG,
      uniforms: {
        ...shared,
        uDepth: { value: this.placeholderDepth as THREE.Texture },
        uDepthScale: { value: 0 },
        uHasDepth: { value: 0 },
        uGradStep: { value: 1 / SEGMENTS },
        uBackdrop: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
    });

    this.geometry = new THREE.PlaneGeometry(this.planeWidth, this.planeHeight, SEGMENTS, SEGMENTS);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The vertex shader moves geometry the CPU-side bounding box knows nothing
    // about, so let the GPU decide what is on screen.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;

    // Two triangles, not 131 000. The fill layer is never displaced, so paying
    // the 66k-vertex depth-tap cost twice per frame would be pure waste.
    this.backdropGeometry = new THREE.PlaneGeometry(this.planeWidth, this.planeHeight, 1, 1);
    this.backdrop = new THREE.Mesh(this.backdropGeometry, this.backdropMaterial);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = 0;

    this.scene.add(this.backdrop);
    this.scene.add(this.mesh);

    this.rig = new CameraRig(this.planeWidth, this.planeHeight, FOV_DEG);
    this.parallax = new ParallaxInput(container);

    if (opts.atmosphere !== false) {
      this.atmosphere = new Atmosphere({
        planeWidth: this.planeWidth,
        planeHeight: this.planeHeight,
        pixelRatio: this.pixelRatio,
      });
      this.moteCount = this.atmosphere.count;
      this.atmosphere.setDepthScale(this.depthScale);
      this.scene.add(this.atmosphere.group);
      this.applyAtmosphereGrade();
    }

    this.setupMotionPreference();
    this.setupObservers();

    this.resize();
    this.placeBackdrop();

    // Idle life from the very first frame, per the brief.
    this.rig.driftIn();
    this.rig.orbitMicro();
  }

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  /** Loads the photograph, then the depth map. Never blocks the render loop. */
  async load(): Promise<void> {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    try {
      const tex = await loader.loadAsync(this.monument.hero);
      if (this.disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      this.photoTexture = tex;
      this.material.uniforms.uPhotoA.value = tex;
      this.backdropMaterial.uniforms.uPhotoA.value = tex;

      this.ready = true;
      // Fade the whole diorama up rather than cutting: a hard cut at load reads
      // as a page swap, a fade reads as a shutter opening.
      this.animate('reveal', 900, (e) => {
        this.material.uniforms.uOpacity.value = e;
      }, 'easeOutCubic');
      this.opts.onReady?.();
    } catch (err) {
      // No photograph means there is nothing to render. Say so honestly and let
      // the React shell put up the static fallback rather than a black canvas.
      this.fail(err, `could not load ${this.monument.hero}`);
      this.opts.onFatal?.();
      this.stop();
      return;
    }

    // Depth is a progressive enhancement. Ken Burns is already running.
    try {
      const map = await loadDepthMap({
        depthUrl: this.monument.depth,
        heroUrl: this.monument.hero,
        allowCompute: this.opts.allowDepthCompute !== false,
        signal: this.abort.signal,
        onPhase: (p) => {
          this.depthPhase = p;
          this.opts.onPhase?.(p);
        },
      });
      if (this.disposed) return;
      this.depthSource = map.source;
      if (map.image) {
        this.applyDepth(map);
      } else if (map.error) {
        // Flat plane + Ken Burns. The visitor still gets a cinematic photograph.
        this.opts.onError?.(map.error);
      }
    } catch (err) {
      this.fail(err, 'depth map unavailable');
    }
  }

  private applyDepth(map: DepthMap): void {
    if (!map.image) return;
    const tex = new THREE.Texture(map.image);
    tex.colorSpace = THREE.NoColorSpace;
    // No mipmaps, ever. A mipmapped depth map averages the sky into the tower
    // at silhouettes, which produces phantom geometry exactly where the edge
    // discard is trying to keep things clean.
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    this.depthTexture = tex;
    this.material.uniforms.uDepth.value = tex;
    this.material.uniforms.uHasDepth.value = 1;

    this.buildDepthSamples(map);
    this.placeBackdrop();
    this.depthPhase = 'done';
    this.opts.onPhase?.('done');
  }

  /**
   * Keep a tiny CPU copy of the depth map so `to(region)` can converge the
   * camera on the actual displaced surface instead of on the flat plane. 96px
   * wide is more than enough for a camera target and costs ~16 KB.
   */
  private buildDepthSamples(map: DepthMap): void {
    try {
      const w = DEPTH_SAMPLE_W;
      const h = Math.max(1, Math.round((w * map.height) / Math.max(map.width, 1)));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;
      ctx.drawImage(map.image as CanvasImageSource, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const out = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = data[i * 4] / 255;
      this.depthSamples = out;
      this.depthSampleW = w;
      this.depthSampleH = h;
    } catch {
      // Canvas readback can fail on a tainted or oversized surface. The camera
      // simply aims at the flat plane instead; nothing else depends on this.
      this.depthSamples = null;
    }
  }

  /** Depth at normalised image coords (0..1 from top-left). 0.5 when unknown. */
  private depthAt(x: number, y: number): number {
    if (!this.depthSamples) return 0.5;
    const px = clamp(Math.round(x * (this.depthSampleW - 1)), 0, this.depthSampleW - 1);
    const py = clamp(Math.round(y * (this.depthSampleH - 1)), 0, this.depthSampleH - 1);
    return this.depthSamples[py * this.depthSampleW + px];
  }

  private surfaceZ(r: Region): number {
    return (this.depthAt(r.x, r.y) - 0.5) * this.depthScale;
  }

  // -------------------------------------------------------------------------
  // Public API (mirrors LivingPhotoHandle)
  // -------------------------------------------------------------------------

  to(regionId: string, opts: ToOptions = {}): void {
    const region = findRegion(this.monument, regionId);
    // A malformed directive must never break the frame. Silence is the spec.
    if (!region) return;
    this.rig.to(region, this.surfaceZ(region), opts);
  }

  driftIn(opts: DriftOptions = {}): void {
    this.rig.driftIn(opts);
  }

  orbitMicro(opts: OrbitOptions = {}): void {
    this.rig.orbitMicro(opts);
  }

  grade(g: Grade, ms = GRADE_MS): void {
    if (!GRADES[g]) return;
    this.currentGrade = g;
    const from: GradeState = {
      tint: this.gradeNow.tint.clone(),
      lift: this.gradeNow.lift,
      brightness: this.gradeNow.brightness,
      saturation: this.gradeNow.saturation,
      shimmer: this.gradeNow.shimmer,
    };
    const to = gradeState(g);
    this.animate('grade', ms, (e) => {
      this.gradeNow.tint.lerpVectors(from.tint, to.tint, e);
      this.gradeNow.lift = lerp(from.lift, to.lift, e);
      this.gradeNow.brightness = lerp(from.brightness, to.brightness, e);
      this.gradeNow.saturation = lerp(from.saturation, to.saturation, e);
      this.gradeNow.shimmer = lerp(from.shimmer, to.shimmer, e);
      this.applyAtmosphereGrade();
    });
  }

  era(year: string | null, ms = ERA_MS): void {
    if (!year) {
      this.currentEra = null;
      this.fadeEra(0, ms);
      return;
    }
    const layer = this.monument.eras?.find((e) => e.year === year);
    // Unknown year: ignore silently, exactly like a malformed directive.
    if (!layer) return;
    if (this.currentEra === year) return;

    const swap = (tex: THREE.Texture) => {
      if (this.disposed) return;
      this.material.uniforms.uPhotoB.value = tex;
      this.backdropMaterial.uniforms.uPhotoB.value = tex;
      this.currentEra = year;
      this.fadeEra(1, ms);
    };

    const cached = this.eraTextures.get(year);
    if (cached) {
      // Already showing a different era: dip back to the present first so the
      // texture swap happens at mix 0 and nothing pops.
      if (this.material.uniforms.uEraMix.value > 0.01) {
        this.fadeEra(0, ms / 2, () => swap(cached));
      } else {
        swap(cached);
      }
      return;
    }

    new THREE.TextureLoader()
      .loadAsync(layer.image)
      .then((tex) => {
        if (this.disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        this.eraTextures.set(year, tex);
        if (this.material.uniforms.uEraMix.value > 0.01) {
          this.fadeEra(0, ms / 2, () => swap(tex));
        } else {
          swap(tex);
        }
      })
      .catch((err) => this.fail(err, `could not load era layer ${layer.image}`));
  }

  private fadeEra(target: number, ms: number, done?: () => void): void {
    const from = this.material.uniforms.uEraMix.value as number;
    this.animate(
      'era',
      ms,
      (e) => {
        this.material.uniforms.uEraMix.value = lerp(from, target, e);
        if (e >= 1) done?.();
      },
      'easeInOutSine',
    );
  }

  focus(regionId: string | null, radius = DEFAULT_FOCUS_RADIUS): void {
    const u = this.material.uniforms;
    if (!regionId) {
      const fromStrength = u.uFocusStrength.value as number;
      this.animate('focus', FOCUS_MS, (e) => {
        u.uFocusStrength.value = lerp(fromStrength, 0, e);
      });
      return;
    }
    const region = findRegion(this.monument, regionId);
    if (!region) return;

    const point = u.uFocusPoint.value as THREE.Vector2;
    const fromX = point.x;
    // Region coords are top-left origin; UV is bottom-left. Flip once, here.
    const fromY = point.y;
    const toX = clamp(region.x, 0, 1);
    const toY = clamp(1 - region.y, 0, 1);
    const fromRadius = u.uFocusRadius.value as number;
    const toRadius = clamp(radius, 0.04, 1.2);
    const fromStrength = u.uFocusStrength.value as number;

    this.animate('focus', FOCUS_MS, (e) => {
      point.set(lerp(fromX, toX, e), lerp(fromY, toY, e));
      u.uFocusRadius.value = lerp(fromRadius, toRadius, e);
      u.uFocusStrength.value = lerp(fromStrength, 1, e);
    });
  }

  listening(on: boolean): void {
    this.rig.setListening(on);
  }

  reset(): void {
    this.rig.reset();
    this.rig.driftIn();
    this.rig.orbitMicro();
    this.grade(this.opts.initialGrade ?? DEFAULT_GRADE, 700);
    this.era(null, 700);
    this.focus(null);
    this.listening(false);
    this.parallax.recentre();
  }

  // -------------------------------------------------------------------------
  // Live prop updates
  // -------------------------------------------------------------------------

  setDepthScale(v: number): void {
    this.depthScale = clamp(v, 0, 1.2);
    this.material.uniforms.uDepthScale.value = this.depthScale;
    this.atmosphere?.setDepthScale(this.depthScale);
    this.placeBackdrop();
  }

  setVignette(v: number): void {
    this.material.uniforms.uVignette.value = clamp(v, 0, 1);
  }

  setEdgeThreshold(v: number): void {
    this.material.uniforms.uEdgeThreshold.value = clamp(v, 0.005, 1);
  }

  status(): LivingPhotoStatus {
    return {
      ready: this.ready,
      webgl: this.webglOk,
      depthSource: this.depthSource,
      depthPhase: this.depthPhase,
      reducedMotion: this.reducedMotion,
      fps: Math.round(this.fps),
      pixelRatio: this.pixelRatio,
      moteCount: this.moteCount,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private applyAtmosphereGrade(): void {
    if (!this.atmosphere) return;
    // Dust is only visible where there is light to catch. Moonlight gets almost
    // none; midday gets the full cloud.
    const lum = clamp(gradeLuminance(this.currentGrade), 0, 1.3);
    this.atmosphere.setOpacity(clamp(lum * 0.9, 0.05, 1));
    // Motes are lit by the same light as the stone, biased warm: what you see
    // is sunlight scattering off them, not the particles' own colour.
    this.atmosphere.setTint(
      clamp(this.gradeNow.tint.x, 0, 2),
      clamp(this.gradeNow.tint.y * 0.93, 0, 2),
      clamp(this.gradeNow.tint.z * 0.82, 0, 2),
    );
  }

  private animate(id: string, ms: number, apply: (e: number) => void, ease?: string): void {
    if (ms <= 0) {
      this.tickers.delete(id);
      apply(1);
      return;
    }
    const easeFn = resolveEase(ease);
    let elapsed = 0;
    this.tickers.set(id, (dt) => {
      elapsed += dt * 1000;
      const t = clamp(elapsed / ms, 0, 1);
      apply(easeFn(t));
      return t < 1;
    });
  }

  /**
   * Park the backdrop behind the deepest point the displaced mesh can reach and
   * scale it to cover the frame from there, so a receding sky can never expose
   * the clear colour at the corners.
   */
  private placeBackdrop(): void {
    const z = -(this.depthScale * 0.5 + 0.3);
    this.backdrop.position.z = z;

    // Worst case: the camera at its furthest framing distance *and* at the far
    // end of its excursion budget. Size for that once and the fill can never be
    // caught short mid-move, which would flash the clear colour at an edge.
    const dist = this.rig.maxDistance - z;
    const tanHalf = Math.tan((FOV_DEG * Math.PI) / 180 / 2);
    const halfVisH = dist * tanHalf;
    const halfVisW = halfVisH * (this.camera.aspect || 1);
    const reach = this.rig.excursion;
    const scale =
      Math.max(
        ((halfVisH + reach.y) * 2) / this.planeHeight,
        ((halfVisW + reach.x) * 2) / this.planeWidth,
        1,
      ) * 1.06;
    this.backdrop.scale.set(scale, scale, 1);
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.rig.resize(w / h);
    // gl_FragCoord is in drawing-buffer pixels, so the vignette needs the size
    // *after* the pixel ratio, not the CSS size.
    this.renderer.getDrawingBufferSize(
      this.material.uniforms.uResolution.value as THREE.Vector2,
    );
    this.placeBackdrop();
  }

  private setupMotionPreference(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      this.reducedMotion = this.motionQuery?.matches ?? false;
      this.rig.setReducedMotion(this.reducedMotion);
      this.parallax.setEnabled(!this.reducedMotion);
      this.atmosphere?.setReducedMotion(this.reducedMotion);
    };
    apply();
    // Safari < 14 only has the deprecated listener API.
    if (typeof this.motionQuery.addEventListener === 'function') {
      this.motionQuery.addEventListener('change', apply);
    }
    this.onMotionChange = apply;
  }

  private onMotionChange: (() => void) | null = null;

  private setupObservers(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
    }

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          this.inView = entries.some((e) => e.isIntersecting);
          this.syncRunning();
        },
        { threshold: 0.01 },
      );
      this.intersectionObserver.observe(this.container);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private onWindowResize = (): void => this.resize();

  private onVisibility = (): void => {
    this.visible = !document.hidden;
    this.syncRunning();
  };

  private onContextLost = (e: Event): void => {
    // Preventing the default is what allows the browser to hand the context
    // back; without it the canvas is dead forever.
    e.preventDefault();
    this.stop();
    this.webglOk = false;
    this.fail(new Error('the browser reclaimed the GL context'), 'WebGL context lost');
  };

  private onContextRestored = (): void => {
    this.webglOk = true;
    this.syncRunning();
  };

  private syncRunning(): void {
    const should = this.visible && this.inView && !this.disposed;
    if (should) this.start();
    else this.stop();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (now: number): void => {
    if (!this.running || this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);

    // Cap dt: a tab that was backgrounded for a minute must resume where it
    // left off, not teleport the camera through a minute of drift.
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 0.016;
    this.lastFrame = now;
    this.elapsed += dt;

    this.fps = this.fps * 0.92 + (1 / Math.max(dt, 0.001)) * 0.08;
    this.maybeDegrade();

    // Snapshot first: a finishing tween may install a *new* ticker under the
    // same id from its completion callback (era does exactly this when swapping
    // layers), and deleting blindly would throw that replacement away.
    for (const [id, tick] of Array.from(this.tickers)) {
      if (!tick(dt) && this.tickers.get(id) === tick) this.tickers.delete(id);
    }

    const p = this.parallax.update(dt);
    this.rig.setParallax(p.x, p.y);
    const f = this.rig.update(dt);

    this.camera.position.set(f.x, f.y, f.z);
    this.camera.lookAt(f.lookX, f.lookY, f.lookZ);

    const u = this.material.uniforms;
    u.uTime.value = this.elapsed;
    u.uTint.value.copy(this.gradeNow.tint);
    u.uLift.value = this.gradeNow.lift;
    u.uShimmer.value = this.gradeNow.shimmer;

    // Listening composes on top of whatever the grade is doing: a small pull
    // back (in the rig) plus a touch of desaturation and exposure here.
    const listen = this.rig.listeningAmount;
    u.uBrightness.value = this.gradeNow.brightness * lerp(1, 0.9, listen);
    u.uSaturation.value = this.gradeNow.saturation * lerp(1, 0.7, listen);

    this.atmosphere?.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * One-shot quality drop. If a phone cannot hold ~48fps at DPR 2 it will never
   * get there by itself, and a smooth 60 at DPR 1.5 looks better than a stuttery
   * 35 at DPR 2. We only ever step down once, so this can never oscillate.
   */
  private maybeDegrade(): void {
    if (this.degraded || !this.ready) return;
    if (this.fps < 48) {
      this.slowFrames++;
      if (this.slowFrames > 120) {
        this.degraded = true;
        this.pixelRatio = Math.max(1, this.pixelRatio * 0.75);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.atmosphere?.setPixelRatio(this.pixelRatio);
        this.resize();
      }
    } else if (this.slowFrames > 0) {
      this.slowFrames--;
    }
  }

  private fail(err: unknown, context: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.opts.onError?.(new Error(`${context}: ${e.message}`, { cause: e }));
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.abort.abort();
    this.tickers.clear();

    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onWindowResize);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    if (this.motionQuery && this.onMotionChange) {
      if (typeof this.motionQuery.removeEventListener === 'function') {
        this.motionQuery.removeEventListener('change', this.onMotionChange);
      }
    }
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.parallax.dispose();
    this.atmosphere?.dispose();

    this.geometry.dispose();
    this.backdropGeometry.dispose();
    this.material.dispose();
    this.backdropMaterial.dispose();
    this.placeholderPhoto.dispose();
    this.placeholderDepth.dispose();
    this.photoTexture?.dispose();
    this.depthTexture?.dispose();
    for (const tex of this.eraTextures.values()) tex.dispose();
    this.eraTextures.clear();
    this.scene.clear();

    this.renderer.dispose();
    // Free the GL context immediately. Browsers cap live contexts at ~16 and
    // this component can be remounted repeatedly by the debug route.
    this.renderer.forceContextLoss();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}
