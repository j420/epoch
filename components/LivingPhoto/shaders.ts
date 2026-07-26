/**
 * GLSL for the living photograph.
 *
 * One vertex shader displaces a dense plane by a depth map; one fragment shader
 * does era crossfade, heat shimmer, focus spotlight, time-of-day grade and
 * vignette in a single pass. The same pair is reused for the flat backdrop
 * layer with `uHasDepth = 0` and `uBackdrop = 1`, so both layers are graded
 * identically from one shared uniform block.
 *
 * WebGL1-flavoured GLSL (`texture2D`, `gl_FragColor`) because three's
 * `ShaderMaterial` defaults to GLSL1 and transpiles for WebGL2 — this keeps the
 * component working on the older Android WebViews the brief targets.
 */

export const PHOTO_VERT = /* glsl */ `
uniform sampler2D uDepth;
uniform float uDepthScale;
uniform float uHasDepth;
uniform float uGradStep;
uniform float uEdgeThreshold;

varying vec2 vUv;
varying float vDepth;

void main() {
  vUv = uv;

  float d = texture2D(uDepth, uv).r;

  // Neighbour taps at *vertex* spacing (uGradStep = 1 / segments), not texel
  // spacing. A triangle can only smear as far as its own edge length, so that
  // is the scale at which a depth discontinuity actually produces a stretched
  // silhouette. Sampling at texel spacing would flag fine texture detail the
  // mesh never sees.
  float dl = texture2D(uDepth, uv - vec2(uGradStep, 0.0)).r;
  float dr = texture2D(uDepth, uv + vec2(uGradStep, 0.0)).r;
  float db = texture2D(uDepth, uv - vec2(0.0, uGradStep)).r;
  float dt = texture2D(uDepth, uv + vec2(0.0, uGradStep)).r;

  // Named dFar/dNear rather than far/near: those are HLSL reserved words and
  // ANGLE's D3D backend has historically choked on them.
  float dFar = min(min(dl, dr), min(db, dt));
  float dNear = max(max(dl, dr), max(db, dt));

  // Damp the displacement across discontinuities. A vertex that straddles the
  // tower's edge cannot be in two places at once; left alone it rubber-bands
  // between the stone and the sky and that stretched triangle is the artifact.
  // Collapsing it onto the far side means the gap opens where the backdrop can
  // fill it, instead of a sheet of smeared sandstone spanning the hole.
  float span = (dNear - dFar) * uHasDepth;
  float discontinuity = smoothstep(uEdgeThreshold * 1.5, uEdgeThreshold * 5.0, span);
  float dDisp = mix(d, dFar, discontinuity * 0.8);

  // Flat plane when there is no depth map at all.
  d = d * uHasDepth + (1.0 - uHasDepth) * 0.5;
  dDisp = dDisp * uHasDepth + (1.0 - uHasDepth) * 0.5;

  // Carry the *undamped* depth to the fragment shader. The dissolve downstream
  // measures how far the interpolated surface has drifted from the photograph,
  // and if it saw the damping it would read our own correction as an artifact
  // and fade out the entire tower.
  vDepth = d;

  vec3 p = position;
  // Depth Anything emits inverse depth: 1.0 is nearest. Centring on 0.5 means
  // raising depthScale opens the diorama out around the mid-plane instead of
  // also dollying the entire photograph toward the lens.
  p.z += (dDisp - 0.5) * uDepthScale;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const PHOTO_FRAG = /* glsl */ `
uniform sampler2D uPhotoA;
uniform sampler2D uPhotoB;
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform float uEraMix;

uniform vec3 uTint;
uniform float uLift;
uniform float uBrightness;
uniform float uSaturation;

uniform float uVignette;
uniform vec2 uFocusPoint;
uniform float uFocusRadius;
uniform float uFocusStrength;

uniform float uEdgeThreshold;
uniform float uAspect;
uniform vec2 uResolution;
uniform float uTime;
uniform float uShimmer;
uniform float uOpacity;
uniform float uBackdrop;

varying vec2 vUv;
varying float vDepth;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 applyGrade(vec3 c) {
  // Soft multiply: the tint colours the light, it does not paint over the stone.
  c *= uTint;
  // Lift toward white in proportion to how dark the pixel already is. This is
  // the film "toe" — it fills the blacks the way haze does, without touching
  // the highlights, whereas a flat additive lift washes the whole frame out.
  c += uLift * (1.0 - c);
  c = mix(vec3(dot(c, LUMA)), c, uSaturation);
  return c * uBrightness;
}

void main() {
  // --- silhouette dissolve --------------------------------------------------
  // vDepth is what the *geometry* believes, linearly interpolated across each
  // grid cell. uDepth is what the photograph actually says at this exact
  // fragment. Over smooth stone the two agree. Over a cell that straddles the
  // tower's edge, the interpolation ramps gently while the truth jumps, and the
  // gap between them is precisely the smear.
  //
  // Testing that per fragment rather than per vertex is what removes the
  // staircase: the old test was a contour of a value sampled at 256 points, so
  // its boundary was faceted to the grid. This one follows the real edge in the
  // photograph and fades instead of cutting, so the silhouette dissolves.
  float mismatch = abs(texture2D(uDepth, vUv).r - vDepth) * uHasDepth;
  float edge = smoothstep(uEdgeThreshold, uEdgeThreshold * 2.6, mismatch);
  if (edge > 0.995) discard;

  vec2 uv = vUv;

  // Heat shimmer, lower third only, and weighted toward the *far* samples:
  // rising air distorts what is across the courtyard, not the stone underfoot.
  float band = 1.0 - smoothstep(0.05, 0.34, uv.y);
  float shimmer = band * uShimmer * (1.0 - vDepth * 0.55);
  if (shimmer > 0.001) {
    uv.x += sin(uv.y * 130.0 + uTime * 2.3) * 0.0020 * shimmer;
    uv.y += cos(uv.x * 96.0 + uTime * 1.7) * 0.0012 * shimmer;
  }

  vec3 col = texture2D(uPhotoA, uv).rgb;

  if (uEraMix > 0.001) {
    col = mix(col, texture2D(uPhotoB, uv).rgb, uEraMix);
  }

  if (uBackdrop > 0.5) {
    // The fill layer does two jobs: it shows through the silhouette dissolve,
    // and with contain framing it is the surround the letterboxed photograph
    // sits in. Both want the same thing — the same picture, defocused. A mip
    // bias does the heavy lifting for one tap; the ring of four widens it into
    // something that reads as bokeh rather than as a low-res duplicate.
    vec2 o = vec2(0.016, 0.016 / uAspect);
    vec3 blur = texture2D(uPhotoA, uv, 4.0).rgb * 2.0;
    blur += texture2D(uPhotoA, uv + vec2(o.x, 0.0), 4.0).rgb;
    blur += texture2D(uPhotoA, uv - vec2(o.x, 0.0), 4.0).rgb;
    blur += texture2D(uPhotoA, uv + vec2(0.0, o.y), 4.0).rgb;
    blur += texture2D(uPhotoA, uv - vec2(0.0, o.y), 4.0).rgb;
    col = blur / 6.0;
  }

  // Focus spotlight. Distance is measured in plane units (x scaled by the photo
  // aspect) so the falloff is a circle on screen rather than an ellipse.
  if (uFocusStrength > 0.001) {
    float dist = length((vUv - uFocusPoint) * vec2(uAspect, 1.0));
    float outside = smoothstep(uFocusRadius, uFocusRadius + 0.26, dist) * uFocusStrength;
    col = mix(col, vec3(dot(col, LUMA)), outside * 0.78);
    col *= 1.0 - outside * 0.34;
  }

  col = applyGrade(col);

  // Screen space, not UV space: a vignette is a property of the lens, so it must
  // stay pinned to the frame while the camera drifts across the photograph.
  // Painting it into the image would make it slide around like a printed border.
  vec2 q = (gl_FragCoord.xy / uResolution) - 0.5;
  float vig = 1.0 - smoothstep(0.65, 1.45, length(q * 2.0));
  col *= mix(1.0, vig, uVignette);

  // Hold the surround back so the eye goes to the monument, but not so far that
  // the silhouette dissolve reads as a black outline around the tower.
  if (uBackdrop > 0.5) col *= 0.72;

  // Fade, do not cut. edge is 0 over stone and ramps to 1 across the smear,
  // so the mesh thins out into the backdrop exactly where it was tearing.
  gl_FragColor = vec4(col, uOpacity * (1.0 - edge));

  #include <colorspace_fragment>
}
`;

/**
 * Dust motes.
 *
 * All motion is on the GPU: 300-odd points animated on the CPU would be a
 * per-frame buffer upload we cannot afford on a mid-range phone.
 */
export const DUST_VERT = /* glsl */ `
attribute vec3 aSeed;
attribute float aSize;

uniform float uTime;
uniform float uOpacity;
uniform float uPixelRatio;
uniform float uHalfHeight;

varying float vAlpha;

void main() {
  vec3 p = position;

  // A slow upward rise wrapped with fract(), phase-offset per mote. The fade at
  // both ends hides the wrap, so nothing ever pops.
  float rise = fract(aSeed.x + uTime * 0.0055);
  p.y = mix(-uHalfHeight, uHalfHeight, rise);

  // Three incommensurate sinusoids stand in for a noise field at a fraction of
  // the cost. Motes must never travel in a straight line or they read as snow.
  float t = uTime * 0.06;
  p.x += sin(t * (0.7 + aSeed.y) + aSeed.z * 6.283) * 0.055;
  p.z += sin(t * (0.9 + aSeed.z) + aSeed.y * 6.283) * 0.040;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // Perspective-correct point size, clamped so a mote that drifts near the lens
  // cannot blow up into a visible disc.
  gl_PointSize = clamp(aSize * uPixelRatio / max(-mv.z, 0.15), 1.0, 9.0 * uPixelRatio);

  vAlpha = uOpacity * smoothstep(0.0, 0.14, rise) * (1.0 - smoothstep(0.84, 1.0, rise));
}
`;

export const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;

void main() {
  // Soft round falloff; a hard-edged point sprite instantly looks like a game.
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  if (a * vAlpha < 0.002) discard;
  gl_FragColor = vec4(uColor, a * vAlpha);
}
`;
