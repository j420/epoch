import type { LangCode } from './langs';

// ---------------------------------------------------------------------------
// Monument content
// ---------------------------------------------------------------------------

export interface SourceChunk {
  id: string;
  text: string;
  /** Every factual claim the monument makes must be traceable to one of these. */
  citation: string;
  /** Optional public-domain / licence note. */
  license?: string;
}

export interface Region {
  id: string;
  /** Normalised image coordinates, 0..1 from top-left. */
  x: number;
  y: number;
  /** Camera dolly depth for this region, 0..1. */
  z: number;
  label: Record<string, string>;
}

export interface EraLayer {
  /** e.g. "1900" */
  year: string;
  image: string;
  caption?: Record<string, string>;
}

export interface Monument {
  id: string;
  displayName: Record<string, string>;
  city: string;
  hero: string;
  depth: string;
  /** Photo aspect ratio width/height, so the mesh is built before the image loads. */
  aspect: number;
  credit: string;
  regions: Region[];
  eras?: EraLayer[];
  sources: SourceChunk[];
  /** Fallback intro line per language, pre-generated for the offline demo path. */
  intro?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The visual directive the monument emits after every answer (Prompt 3 -> 4)
// ---------------------------------------------------------------------------

export type Grade = 'dawn' | 'noon' | 'dusk' | 'night' | 'sepia';

export interface VisualDirective {
  focus: string | null;
  grade: Grade | null;
  era: string | null;
}

export const EMPTY_DIRECTIVE: VisualDirective = { focus: null, grade: null, era: null };

/** A timestamped cue for pre-rendered narration. Driven off audio `timeupdate`. */
export interface Cue extends Partial<VisualDirective> {
  t: number;
}

/**
 * The imperative surface of the Living Photograph engine.
 *
 * Declared here rather than in the component so the director, the debug tools and
 * the page shell can all depend on the contract without importing WebGL code.
 * The engine's own handle is structurally identical and therefore assignable.
 */
export interface LivingPhotoHandle {
  to(region: string, opts?: { duration?: number; ease?: string }): void;
  driftIn(opts?: { amount?: number; duration?: number }): void;
  orbitMicro(opts?: { amplitude?: number }): void;
  grade(g: Grade, ms?: number): void;
  era(year: string | null, ms?: number): void;
  focus(region: string | null, radius?: number): void;
  /** While the visitor speaks: pull back and desaturate, so the world listens. */
  listening(on: boolean): void;
  reset(): void;
}

/** What the voice loop is doing right now. The director maps this onto camera behaviour. */
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

// ---------------------------------------------------------------------------
// Voice loop
// ---------------------------------------------------------------------------

export type Intent = 'SIMPLE' | 'DEEP' | 'MEMORY' | 'REPORT' | 'VISUAL';

export interface StageTimings {
  stt?: number;
  route?: number;
  retrieve?: number;
  generate?: number;
  tts?: number;
  total?: number;
}

export interface AnswerResult {
  /** Spoken text with the trailing JSON directive stripped out. */
  text: string;
  directive: VisualDirective;
  intent: Intent;
  lang: LangCode;
  sources: SourceChunk[];
  model: string;
  timings: StageTimings;
  /** True when retrieval found nothing and the monument admits it does not remember. */
  admittedIgnorance?: boolean;
}

// ---------------------------------------------------------------------------
// Echo wall
// ---------------------------------------------------------------------------

export interface Memory {
  id: string;
  monument_id: string;
  lang: LangCode;
  transcript: string;
  verbatim: string;
  audio_url: string | null;
  city: string | null;
  consented: boolean;
  approved: boolean;
  created_at: string;
}

export interface ConservationReport {
  id: string;
  monument_id: string;
  lang: LangCode;
  transcript: string;
  severity: string;
  kind: string | null;
  photo_url: string | null;
  lat: number | null;
  lon: number | null;
  created_at: string;
}

export interface Session {
  id: string;
  monument_id: string;
  detected_lang: LangCode | null;
  started_at: string;
  user_agent: string | null;
}

export interface Turn {
  id: string;
  session_id: string;
  role: 'visitor' | 'monument';
  text: string;
  lang: LangCode | null;
  latency_ms: number | null;
  created_at: string;
}

export interface BolEvent {
  id: string;
  session_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}
