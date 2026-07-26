/**
 * Bulbul voice casting.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FILE EXISTS TO FIX
 * ---------------------------------------------------------------------------
 *
 * Every language in lib/langs.ts shipped with `speaker: 'anushka'`, and
 * lib/sarvam.ts sends `model: 'bulbul:v3'` by default. **`anushka` is a
 * bulbul:v2 speaker.** Speaker names are NOT interchangeable between Bulbul
 * model versions — v2 has 7 voices, v3 has 39, and the two sets do not overlap
 * at all. A v2 name sent to v3 is rejected, `speak()` throws, and the monument
 * goes silent. Silence is the worst outcome this product can produce, so this
 * module owns three things:
 *
 *   1. A typed catalogue of the speakers each model actually has, with the
 *      provenance of every claim recorded (VERIFIED vs ASSUMED — see below).
 *   2. Per-monument casting: ten monuments are ten characters, and an
 *      800-year-old minaret should not sound like a palace lit by a hundred
 *      thousand bulbs.
 *   3. A resolution order that ALWAYS lands on a speaker the configured model
 *      is known to accept, plus `isSpeakerRejection()` so a wrong guess can be
 *      retried once against the model default instead of losing the turn.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED vs ASSUMED — read this before trusting anything here
 * ---------------------------------------------------------------------------
 *
 * `docs.sarvam.ai` is blocked from this environment (network policy) and there
 * is no Sarvam key here, so NOTHING below has been executed against the live
 * API. The provenance of each claim:
 *
 *   VERIFIED (name lists) — the speaker NAMES for bulbul:v2 and bulbul:v3, the
 *     model defaults, and the fact that names are not interchangeable across
 *     versions. Corroborated across three independent third-party sources that
 *     mirror Sarvam's docs (Mastra's `@mastra/voice-sarvam` reference, the
 *     Pipecat `pipecat.services.sarvam.tts` reference, and the LiveKit Sarvam
 *     TTS plugin guide), all of which agree on the same 7 and the same 39 names
 *     and on `shubh` / `anushka` as the respective defaults. Search date
 *     2026-07-26. If Sarvam ships a v4, this list is stale by definition.
 *
 *   VERIFIED (languages) — bulbul speaks exactly the 11 language codes already
 *     in `SPEAKABLE` in lib/langs.ts. Same three sources.
 *
 *   VERIFIED (pace) — v3 accepts pace 0.5–2.0; v2 accepts 0.3–3.0. v3 dropped
 *     `pitch` and `loudness`, which v2 had. Same three sources.
 *
 *   ASSUMED (per-speaker language support) — Sarvam publishes voices per MODEL,
 *     not per language; the language is a separate `target_language_code` on the
 *     request. We therefore assume every speaker of a model can voice all 11 of
 *     that model's languages. If that turns out to be false for some voice, the
 *     failure is a speaker rejection and `isSpeakerRejection()` catches it.
 *
 *   ASSUMED (gender) — one source split the v3 names by gender; `amelia` and
 *     `sophia` were not in either list. Gender is metadata for casting only and
 *     is never sent to the API, so a wrong guess costs character, not audio.
 *
 *   ASSUMED (timbre, age, everything about how a voice actually SOUNDS) — we
 *     have never heard a single one of these voices. Every casting decision in
 *     `MONUMENT_VOICES` is a reasoned guess from the name and the character we
 *     want, and every one of them is wrong until someone listens. That is why
 *     `SARVAM_FORCE_SPEAKER` exists: a bad cast is fixable at the venue with an
 *     env var, with no deploy.
 */

import { SPEAKABLE, info, normalizeLang, type LangCode } from './langs';

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export type BulbulModel = 'bulbul:v2' | 'bulbul:v3';

/** How much we actually know about a given claim. Never silently guess. */
export type Provenance = 'verified' | 'assumed';

export interface BulbulSpeaker {
  id: string;
  model: BulbulModel;
  /** ASSUMED. Metadata for casting; never sent to the API. */
  gender: 'female' | 'male' | 'unknown';
  /** Provenance of the NAME being accepted by `model`. VERIFIED for all of these. */
  name: Provenance;
  /** Provenance of `gender` and of any timbre we imply by casting it. */
  timbre: Provenance;
}

/**
 * The 11 language codes Bulbul can voice, in either model version. VERIFIED.
 * Taken from lib/langs.ts rather than restated, so the two can never drift.
 */
export const BULBUL_LANGS: readonly LangCode[] = SPEAKABLE;

/** True when Bulbul can voice this language at all (any model). */
export function isBulbulLang(code: LangCode): boolean {
  return BULBUL_LANGS.includes(normalizeLang(code));
}

const v2 = (id: string, gender: BulbulSpeaker['gender']): BulbulSpeaker => ({
  id,
  model: 'bulbul:v2',
  gender,
  name: 'verified',
  timbre: 'assumed',
});

const v3 = (id: string, gender: BulbulSpeaker['gender']): BulbulSpeaker => ({
  id,
  model: 'bulbul:v3',
  gender,
  name: 'verified',
  timbre: 'assumed',
});

/** bulbul:v2 — 7 voices. Default `anushka`. NAMES VERIFIED, genders ASSUMED. */
export const V2_SPEAKERS: readonly BulbulSpeaker[] = [
  v2('anushka', 'female'),
  v2('manisha', 'female'),
  v2('vidya', 'female'),
  v2('arya', 'female'),
  v2('abhilash', 'male'),
  v2('karun', 'male'),
  v2('hitesh', 'male'),
];

/**
 * bulbul:v3 — 39 voices. Default `shubh`. NAMES VERIFIED, genders ASSUMED.
 * `amelia` and `sophia` were absent from the gender split we found, so they are
 * recorded as 'unknown' rather than guessed into a bucket.
 */
export const V3_SPEAKERS: readonly BulbulSpeaker[] = [
  v3('shubh', 'male'),
  v3('aditya', 'male'),
  v3('ritu', 'female'),
  v3('priya', 'female'),
  v3('neha', 'female'),
  v3('rahul', 'male'),
  v3('pooja', 'female'),
  v3('rohan', 'male'),
  v3('simran', 'female'),
  v3('kavya', 'female'),
  v3('amit', 'male'),
  v3('dev', 'male'),
  v3('ishita', 'female'),
  v3('shreya', 'female'),
  v3('ratan', 'male'),
  v3('varun', 'male'),
  v3('manan', 'male'),
  v3('sumit', 'male'),
  v3('roopa', 'female'),
  v3('kabir', 'male'),
  v3('aayan', 'male'),
  v3('ashutosh', 'male'),
  v3('advait', 'male'),
  v3('amelia', 'unknown'),
  v3('sophia', 'unknown'),
  v3('anand', 'male'),
  v3('tanya', 'female'),
  v3('tarun', 'male'),
  v3('sunny', 'male'),
  v3('mani', 'male'),
  v3('gokul', 'male'),
  v3('vijay', 'male'),
  v3('shruti', 'female'),
  v3('suhani', 'female'),
  v3('mohit', 'male'),
  v3('kavitha', 'female'),
  v3('rehan', 'male'),
  v3('soham', 'male'),
  v3('rupali', 'female'),
];

export const SPEAKERS: Record<BulbulModel, readonly BulbulSpeaker[]> = {
  'bulbul:v2': V2_SPEAKERS,
  'bulbul:v3': V3_SPEAKERS,
};

/**
 * The speaker each model uses when the request omits `speaker`. VERIFIED.
 * This is the known-good value every fallback path lands on: if the API accepts
 * the model at all, it accepts this name.
 */
export const MODEL_DEFAULT_SPEAKER: Record<BulbulModel, string> = {
  'bulbul:v2': 'anushka',
  'bulbul:v3': 'shubh',
};

/** VERIFIED. v3 narrowed the pace window and dropped pitch/loudness entirely. */
export const PACE_RANGE: Record<BulbulModel, { min: number; max: number }> = {
  'bulbul:v2': { min: 0.3, max: 3.0 },
  'bulbul:v3': { min: 0.5, max: 2.0 },
};

const BY_MODEL: Record<BulbulModel, Set<string>> = {
  'bulbul:v2': new Set(V2_SPEAKERS.map((s) => s.id)),
  'bulbul:v3': new Set(V3_SPEAKERS.map((s) => s.id)),
};

/** True when `speaker` is a name we believe `model` accepts. */
export function isKnownSpeaker(speaker: string | null | undefined, model: BulbulModel): boolean {
  return Boolean(speaker && BY_MODEL[model]?.has(speaker.trim().toLowerCase()));
}

export function speakerInfo(speaker: string, model: BulbulModel): BulbulSpeaker | null {
  const want = speaker.trim().toLowerCase();
  return SPEAKERS[model]?.find((s) => s.id === want) ?? null;
}

/**
 * The model actually in play.
 *
 * lib/sarvam.ts reads `SARVAM_TTS_MODEL` for the same purpose; it is read again
 * here rather than imported because lib/sarvam is `server-only` and this module
 * has to stay importable from /debug/prompts and from a test script. An
 * unrecognised value degrades to v3 — the model lib/sarvam defaults to — so the
 * catalogue we validate against always matches the request we send.
 */
export function configuredModel(raw?: string | null): BulbulModel {
  const value = (raw ?? process.env.SARVAM_TTS_MODEL ?? 'bulbul:v3').trim().toLowerCase();
  return value === 'bulbul:v2' ? 'bulbul:v2' : 'bulbul:v3';
}

/** The speaker we fall back to when everything else is unusable. Always valid. */
export function safeDefaultSpeaker(model: BulbulModel): string {
  return MODEL_DEFAULT_SPEAKER[model];
}

export function clampPace(pace: number, model: BulbulModel): number {
  const { min, max } = PACE_RANGE[model];
  if (!Number.isFinite(pace)) return 1;
  return Math.min(max, Math.max(min, pace));
}

// ---------------------------------------------------------------------------
// Casting — ten monuments, ten characters
// ---------------------------------------------------------------------------

/**
 * What we want a monument to SOUND like, written down before a speaker name is
 * chosen. The intent is the durable part; the speaker mapping under it is a
 * guess that someone with a live key will correct in an afternoon.
 */
export interface VoiceIntent {
  age: 'ancient' | 'old' | 'middle' | 'young';
  warmth: 'cool' | 'even' | 'warm' | 'tender';
  gravity: 'grave' | 'measured' | 'light' | 'bright';
  /** Multiplier on Bulbul's speaking rate. Clamped to the model's window. */
  pace: number;
  /** One line: why this monument sounds like this. Rendered in /debug/prompts. */
  note: string;
}

export interface MonumentVoice {
  intent: VoiceIntent;
  /** ASSUMED casting. One name per model, because the two catalogues are disjoint. */
  speaker: Record<BulbulModel, string>;
}

/**
 * PACE, and why it is never 1.0 by accident.
 *
 * Two sentences of Indic script is a lot of syllables. Slowing a grave voice
 * below 0.9 buys weight; pushing a busy one past 1.0 buys life. Both stay well
 * inside the v3 window (0.5–2.0) so a model swap cannot make them illegal.
 */
export const MONUMENT_VOICES: Record<string, MonumentVoice> = {
  'qutub-minar': {
    intent: {
      age: 'ancient',
      warmth: 'even',
      gravity: 'grave',
      pace: 0.88,
      note: 'Eight hundred years of standing still. Low, unhurried, a little worn — it has said all this before and is in no hurry to say it again.',
    },
    speaker: { 'bulbul:v3': 'ratan', 'bulbul:v2': 'hitesh' },
  },
  'taj-mahal': {
    intent: {
      age: 'old',
      warmth: 'tender',
      gravity: 'measured',
      pace: 0.86,
      note: 'A tomb built by a man for his wife. The one monument that should sound like it is remembering a person, not a date — quiet, close, never grand.',
    },
    speaker: { 'bulbul:v3': 'shreya', 'bulbul:v2': 'vidya' },
  },
  'red-fort': {
    intent: {
      age: 'old',
      warmth: 'cool',
      gravity: 'grave',
      pace: 0.94,
      note: 'It held emperors and then held a flag every August. Straight-backed and public — a voice used to being listened to from a distance.',
    },
    speaker: { 'bulbul:v3': 'vijay', 'bulbul:v2': 'karun' },
  },
  'sanchi-stupa': {
    intent: {
      age: 'ancient',
      warmth: 'warm',
      gravity: 'measured',
      pace: 0.82,
      note: 'The oldest thing in the set and the least ornamented. Slowest pace of the ten: a stupa is a shape for stillness and the voice should not argue with it.',
    },
    speaker: { 'bulbul:v3': 'anand', 'bulbul:v2': 'abhilash' },
  },
  'golden-temple': {
    intent: {
      age: 'old',
      warmth: 'tender',
      gravity: 'measured',
      pace: 0.9,
      note: 'A living place of worship where kirtan has not stopped in centuries. Warm and welcoming rather than monumental — it feeds anyone who comes.',
    },
    speaker: { 'bulbul:v3': 'kabir', 'bulbul:v2': 'karun' },
  },
  'konark-sun-temple': {
    intent: {
      age: 'ancient',
      warmth: 'even',
      gravity: 'grave',
      pace: 0.9,
      note: 'A stone chariot with its tower fallen. Resonant and a little rueful — grandeur that knows it is a ruin.',
    },
    speaker: { 'bulbul:v3': 'advait', 'bulbul:v2': 'hitesh' },
  },
  'hawa-mahal': {
    intent: {
      age: 'middle',
      warmth: 'warm',
      gravity: 'light',
      pace: 1.06,
      note: 'Nine hundred and fifty-three windows built so women could watch the street unseen. Airy, curious, quicker than the rest — this one is looking out, not being looked at.',
    },
    speaker: { 'bulbul:v3': 'simran', 'bulbul:v2': 'manisha' },
  },
  charminar: {
    intent: {
      age: 'middle',
      warmth: 'warm',
      gravity: 'bright',
      pace: 1.08,
      note: 'It stands in the middle of a working bazaar, not a lawn. Conversational and street-level — the fastest of the ten, because it is talking over traffic.',
    },
    speaker: { 'bulbul:v3': 'rehan', 'bulbul:v2': 'abhilash' },
  },
  'gateway-of-india': {
    intent: {
      age: 'young',
      warmth: 'even',
      gravity: 'measured',
      pace: 1.0,
      note: 'The newest here, and it watched the last British troops leave through it. Plain, level, slightly formal — a place of arrivals and departures.',
    },
    speaker: { 'bulbul:v3': 'aditya', 'bulbul:v2': 'karun' },
  },
  'mysore-palace': {
    intent: {
      age: 'young',
      warmth: 'warm',
      gravity: 'bright',
      pace: 1.02,
      note: 'A hundred thousand bulbs on a Sunday evening. Ceremonial and pleased with itself, in the nicest way — this one enjoys being visited.',
    },
    speaker: { 'bulbul:v3': 'kavya', 'bulbul:v2': 'arya' },
  },
};

/**
 * Per-language default speaker, consulted when the monument has no casting.
 *
 * Deliberately every entry is the model default. We have no evidence that any
 * particular v3 voice sounds more native in Malayalam than in Punjabi — Sarvam
 * publishes voices per model, not per language — and inventing a mapping would
 * be exactly the silent guessing this file exists to avoid. The table is here
 * so that when someone with a key DOES listen, there is one obvious place to
 * write the answer down, and the resolution order already reads it.
 */
export const LANGUAGE_DEFAULT_SPEAKER: Record<BulbulModel, Record<LangCode, string>> = {
  'bulbul:v3': Object.fromEntries(
    BULBUL_LANGS.map((c) => [c, info(c).speakerV3 ?? MODEL_DEFAULT_SPEAKER['bulbul:v3']]),
  ),
  'bulbul:v2': Object.fromEntries(
    BULBUL_LANGS.map((c) => [c, info(c).speaker ?? MODEL_DEFAULT_SPEAKER['bulbul:v2']]),
  ),
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Where the chosen speaker came from, in the order they are consulted. */
export type CastSource = 'env-force' | 'caller' | 'monument' | 'language' | 'model-default';

export interface VoiceCast {
  speaker: string;
  pace: number;
  model: BulbulModel;
  source: CastSource;
  /**
   * Set when the name we would have used is not in `model`'s catalogue and we
   * substituted the model default instead. Non-null here means someone wrote a
   * speaker name that will not work — surface it, do not swallow it.
   */
  correctedFrom: string | null;
  /** The character we were aiming at, when a monument was named. */
  intent: VoiceIntent | null;
  monumentId: string | null;
}

export interface CastOptions {
  /** The language actually going to Bulbul (post voiceFallback), not the visitor's. */
  lang: LangCode;
  monumentId?: string | null;
  /** An explicit speaker from the request body. Beaten only by the env override. */
  speaker?: string | null;
  pace?: number | null;
  model?: BulbulModel;
}

/**
 * THE VENUE ESCAPE HATCH.
 *
 * Every casting choice below is a guess made without ever hearing the voice. If
 * one of them is wrong in front of a crowd, `SARVAM_FORCE_SPEAKER=priya` pins
 * every monument to one known name without a deploy and without a code change.
 * It beats everything, including an explicit `speaker` on the request, because
 * the point of it is to be the last word.
 */
export function forcedSpeaker(): string | null {
  const raw = process.env.SARVAM_FORCE_SPEAKER?.trim().toLowerCase();
  return raw ? raw : null;
}

/** Same idea for pace, so a voice that gabbles can be slowed at the venue. */
export function forcedPace(): number | null {
  const raw = Number(process.env.SARVAM_FORCE_PACE);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Resolve a speaker and a pace.
 *
 *   env force -> explicit caller value -> monument casting -> language default
 *             -> model default
 *
 * and then, whatever came out of that chain, it is checked against the
 * catalogue for the model actually configured. A name the model does not have
 * is replaced by the model default and reported in `correctedFrom`. The result
 * of this function is therefore always a name we believe Bulbul accepts, which
 * is the property that keeps a bad cast from turning into silence.
 */
export function castVoice(opts: CastOptions): VoiceCast {
  const model = opts.model ?? configuredModel();
  const lang = normalizeLang(opts.lang);
  const monumentId = opts.monumentId?.trim() || null;
  const cast = monumentId ? MONUMENT_VOICES[monumentId] ?? null : null;

  const force = forcedSpeaker();
  const caller = opts.speaker?.trim().toLowerCase() || null;

  let source: CastSource;
  let wanted: string;
  if (force) {
    source = 'env-force';
    wanted = force;
  } else if (caller) {
    source = 'caller';
    wanted = caller;
  } else if (cast) {
    source = 'monument';
    wanted = cast.speaker[model];
  } else if (LANGUAGE_DEFAULT_SPEAKER[model][lang]) {
    source = 'language';
    wanted = LANGUAGE_DEFAULT_SPEAKER[model][lang];
  } else {
    source = 'model-default';
    wanted = safeDefaultSpeaker(model);
  }

  let speaker = wanted;
  let correctedFrom: string | null = null;
  if (!isKnownSpeaker(speaker, model)) {
    correctedFrom = speaker;
    speaker = safeDefaultSpeaker(model);
    source = 'model-default';
  }

  const pace = clampPace(forcedPace() ?? opts.pace ?? cast?.intent.pace ?? 1, model);

  return { speaker, pace, model, source, correctedFrom, intent: cast?.intent ?? null, monumentId };
}

/** Just the speaker, for callers that only need a safe name. */
export function defaultSpeakerFor(lang: LangCode, model: BulbulModel = configuredModel()): string {
  return castVoice({ lang, model }).speaker;
}

// ---------------------------------------------------------------------------
// Failure detection
// ---------------------------------------------------------------------------

/**
 * Does this error look like Bulbul refusing the speaker we asked for?
 *
 * We cannot test this against the live API, so it is deliberately broad on the
 * SHAPE of the failure and narrow on the STATUS: only a 4xx that mentions the
 * speaker (or the exact name we sent) counts. A 5xx or a timeout is not a
 * casting problem and must not be papered over by silently changing the voice —
 * that would hide a real outage behind a different voice.
 *
 * The cost of a false positive is one line spoken in the default voice. The
 * cost of a false negative is silence. The asymmetry is why the string match is
 * generous.
 */
export function isSpeakerRejection(err: unknown, speaker?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string; body?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined && (status < 400 || status >= 500)) return false;

  const haystack = `${e.message ?? ''} ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '')}`.toLowerCase();
  if (!haystack.trim()) return false;

  if (/speaker|voice[_\s-]?id|invalid_voice/.test(haystack)) return true;
  if (speaker && haystack.includes(speaker.toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Introspection, for /debug/prompts and for the report
// ---------------------------------------------------------------------------

export interface CastRow {
  monumentId: string;
  speaker: string;
  pace: number;
  intent: VoiceIntent;
}

/** The whole casting table for a model, for rendering. Nothing here calls Sarvam. */
export function castingTable(model: BulbulModel = configuredModel()): CastRow[] {
  return Object.entries(MONUMENT_VOICES).map(([monumentId, v]) => ({
    monumentId,
    speaker: isKnownSpeaker(v.speaker[model], model) ? v.speaker[model] : safeDefaultSpeaker(model),
    pace: clampPace(v.intent.pace, model),
    intent: v.intent,
  }));
}
