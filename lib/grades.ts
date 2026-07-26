import type { Grade } from './types';

/**
 * Time-of-day colour grades.
 *
 * Shared by the shader, the director and the debug UI so there is exactly one
 * definition of what "dusk" looks like. Values are deliberately gentle: the
 * brief is a photograph that breathes, and a heavy grade instantly reads as a
 * filter rather than as light.
 *
 * - `tint`       per-channel multiply applied to the sampled photo.
 * - `lift`       raises the shadows toward the tint without clipping highlights,
 *                the way real atmospheric haze fills in blacks.
 * - `brightness` overall exposure trim applied last.
 */
export interface GradeDef {
  tint: [number, number, number];
  lift: number;
  brightness: number;
}

export const GRADES: Record<Grade, GradeDef> = {
  // Low sun through morning haze: warm on red, cool-ish blue, shadows lifted.
  dawn: { tint: [1.1, 0.94, 0.92], lift: 0.07, brightness: 0.97 },
  // Reference white. Slightly hot because midday Delhi is genuinely blown out.
  noon: { tint: [1.0, 1.0, 1.0], lift: 0.0, brightness: 1.06 },
  // Sandstone at golden hour — the monument's signature look.
  dusk: { tint: [1.16, 0.87, 0.63], lift: 0.05, brightness: 0.94 },
  // Moonlight is not "dark blue", it is dim and blue-biased with crushed reds.
  night: { tint: [0.6, 0.73, 1.12], lift: 0.04, brightness: 0.52 },
  // Archival paper: warm, flat, low contrast. Pairs with era('1900').
  sepia: { tint: [1.14, 0.99, 0.74], lift: 0.09, brightness: 0.9 },
};

/**
 * Saturation multiplier per grade, kept out of `GradeDef` because the public
 * contract for `GRADES` is exactly `{ tint, lift, brightness }`. Sepia and
 * moonlight both need desaturation that a tint alone cannot express.
 */
export const GRADE_SATURATION: Record<Grade, number> = {
  dawn: 0.98,
  noon: 1.0,
  dusk: 1.04,
  night: 0.72,
  sepia: 0.22,
};

export const GRADE_IDS: Grade[] = ['dawn', 'noon', 'dusk', 'night', 'sepia'];

export const DEFAULT_GRADE: Grade = 'noon';

export function isGrade(value: unknown): value is Grade {
  return typeof value === 'string' && (GRADE_IDS as string[]).includes(value);
}

export function gradeDef(g: Grade | null | undefined): GradeDef {
  return GRADES[g && isGrade(g) ? g : DEFAULT_GRADE];
}

/** Perceived brightness of a grade, 0..~1.2. Atmosphere opacity rides on this. */
export function gradeLuminance(g: Grade | null | undefined): number {
  const d = gradeDef(g);
  const [r, gr, b] = d.tint;
  // Rec. 709 luma of the tint, scaled by the exposure trim.
  return (0.2126 * r + 0.7152 * gr + 0.0722 * b) * d.brightness;
}

/** Grades where a heat shimmer in the lower third is physically plausible. */
export function gradeShimmer(g: Grade | null | undefined): number {
  switch (g) {
    case 'noon':
      return 0.6;
    case 'dusk':
      return 0.26;
    case 'dawn':
      return 0.12;
    default:
      // No shimmer at night, none on archival stock.
      return 0.0;
  }
}
