import 'server-only';

import { LRU } from './lru';
import { SarvamAuth, SarvamBadResponse, SarvamNotConfigured } from './errors';
import { info, normalizeLang, resolveVoice, type LangCode } from './langs';
import { MODELS, isConfigured, readAudioB64, sarvamFetch, speak } from './sarvam';
import { b64ToBytes, bytesToB64, concatAudio } from './wav';
import { logEvent } from './db';

/* ===========================================================================
 * ARCHITECTURAL DEVIATION FROM THE BRIEF — READ THIS FIRST
 * ===========================================================================
 *
 * The product brief says the guide lane pushes dubbed audio "to the matching
 * listeners over WebSocket". This app deploys to Vercel, where a serverless
 * function cannot hold a WebSocket open. Nothing in `ws` survives that runtime.
 * So the guide lane uses:
 *
 *   - Listener downstream : Server-Sent Events. `GET /api/guide/stream?code=&lang=`
 *                           driving an `EventSource` in the browser. SSE runs on the
 *                           Vercel Node runtime, reconnects on its own, and is
 *                           one-directional — which is the whole of a listener's need.
 *   - Guide upstream      : an ordinary multipart POST per audio chunk.
 *   - Polling fallback    : `GET /api/guide/poll?code=&lang=&since=` returns the same
 *                           payloads for any proxy or browser that kills a long-lived
 *                           response. Venue wifi does exactly this.
 *   - Session state       : an in-process Map keyed by join code (see
 *                           `app/api/guide/_room.ts`). Correct for a single-room demo
 *                           on a single instance. A multi-instance deploy needs Redis
 *                           or Supabase Realtime as the fan-out bus; the room module
 *                           documents the exact seam where that swap goes.
 *
 * ===========================================================================
 * UNVERIFIED SARVAM DUB ASSUMPTIONS — EVERY ONE OF THEM LIVES IN THIS BLOCK
 * ===========================================================================
 *
 * docs.sarvam.ai is blocked by network policy from this build environment, so the
 * Dub endpoint path, its request payload and its response shape could NOT be checked
 * against the real API. Rather than scatter guesses through the file, all of them are
 * declared here and consumed below. If any is wrong, the Dub path fails and the code
 * silently degrades to Bulbul — see `dub()`. Nothing else needs to change.
 *
 *   A1. Endpoint path. Unknown. Tried in order from `SARVAM_DUB_PATHS`, exactly the
 *       pattern `readDocument()` in lib/sarvam.ts uses for Sarvam Vision.
 *   A2. Speaker-registration path. Unknown. Tried in order from `SARVAM_DUB_VOICE_PATHS`.
 *       If every candidate fails we keep the raw reference audio and pass it inline
 *       instead (A4), which is the other plausible API shape.
 *   A3. Request field names. Guessed: `input` / `text`, `source_language_code`,
 *       `target_language_code`, `model`, `speaker_id`, `output_audio_codec`,
 *       `duration_control`, `target_duration_ms`. Sent as a superset — unknown fields
 *       are usually ignored by Sarvam's validators, and if they are not, we degrade.
 *   A4. Reference audio may be accepted inline as base64 under `reference_audio` /
 *       `speaker_audio`. Also a guess.
 *   A5. Response shape. Assumed to expose base64 audio through one of the keys
 *       `readAudioB64()` already tolerates (`audio`, `audios`, `data.audio`, ...).
 *       That reader is shared with Bulbul, so if Dub matches any known Sarvam
 *       convention it will be read correctly.
 *   A6. Model id. `SARVAM_DUB_MODEL`, default `bulbul:v3-dub`. A guess.
 *   A7. Duration control. Assumed to be a boolean-ish flag plus a target length in ms.
 *
 * The feature flag `SARVAM_DUB_ENABLED` is OFF by default. With it off, none of the
 * above executes and the lane is green end to end on Bulbul alone.
 * =========================================================================== */

export type DubEngine = 'dub' | 'bulbul';

export interface VoiceProfile {
  /** Speaker handle returned by Sarvam Dub registration, when that path works (A2). */
  id: string | null;
  /** The guide's consent recording, base64. The reference for voice preservation. */
  referenceB64: string | null;
  referenceMime: string;
  /** Language the guide consented in. */
  lang: LangCode;
  /** ISO timestamp of the consent recording. Rendered on the guide's badge. */
  consentedAt: string;
}

export interface DubOptions {
  /** Omit, or pass null, and the Dub path is skipped entirely — no consent, no clone. */
  voice?: VoiceProfile | null;
  sourceLang?: string;
  /** Length of the guide's original chunk, in ms. Drives duration control. */
  targetMs?: number;
  signal?: AbortSignal;
  bypassCache?: boolean;
  /** Bulbul speaker override for the fallback path. */
  speaker?: string;
}

export interface DubResult {
  /** data: URL, playable straight from an <audio> element. */
  url: string;
  base64: string;
  mime: string;
  bytes: number;
  engine: DubEngine;
  /** Language of the text we voiced. */
  lang: LangCode;
  /** Language actually handed to the voice model (may differ — see langs.ts). */
  voiceLang: LangCode;
  /** True when Bulbul cannot voice `lang` and a relative was substituted. */
  degraded: boolean;
  speaker: string;
  latencyMs: number;
  cached: boolean;
  /** Populated only when Dub was attempted and lost. Surfaced in the UI, honestly. */
  degradedReason: string | null;
  /** Playback rate we asked for, to hold the group in sync with the guide. */
  pace: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Beyond this, Dub has already cost us the latency budget. Abandon and use Bulbul. */
export const DUB_TIMEOUT_MS = Number(process.env.DUB_TIMEOUT_MS ?? 4000);

/** Assumption A6. */
const DUB_MODEL = process.env.SARVAM_DUB_MODEL ?? 'bulbul:v3-dub';

/** Assumption A1. */
const DUB_PATHS = (process.env.SARVAM_DUB_PATHS ?? '/speech-to-speech,/v1/dub,/dub,/text-to-speech/dub')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Assumption A2. */
const DUB_VOICE_PATHS = (process.env.SARVAM_DUB_VOICE_PATHS ?? '/speaker/register,/v1/speakers,/voice-clone')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isDubEnabled(): boolean {
  return process.env.SARVAM_DUB_ENABLED === '1';
}

/**
 * Once a candidate path 404s we stop paying for it on every single chunk. Reset when
 * the process restarts, which on Vercel is often enough to pick up a fixed env var.
 */
const deadPaths = new Set<string>();

// ---------------------------------------------------------------------------
// Cache — "guides repeat themselves constantly" is the single biggest latency win
// available here. A tour guide says the same eight sentences at every stop.
// ---------------------------------------------------------------------------

const dubCache = new LRU<DubResult>(600, 128 * 1024 * 1024);

function cacheKey(text: string, lang: string, engine: DubEngine, voiceKey: string, pace: number): string {
  // Pace is bucketed so near-identical duration targets still share a cache entry.
  return JSON.stringify([text.trim(), lang, engine, voiceKey, Math.round(pace * 20) / 20]);
}

export const dubCacheControls = {
  stats: () => dubCache.stats,
  clear: () => dubCache.clear(),
};

// ---------------------------------------------------------------------------
// Duration control — keep the dubbed line close to the guide's original length so
// the room stays together. A listener two sentences behind has lost the tour.
// ---------------------------------------------------------------------------

/** Rough speaking rates in characters per second, measured per script family. */
function charsPerSecond(lang: LangCode): number {
  const script = info(lang).script;
  if (script === 'Latin') return 14.5;
  if (script === 'Perso-Arabic') return 11.5;
  return 10.5; // Indic abugidas pack more phonemes into fewer glyphs
}

/**
 * Bulbul's `pace` is a speed multiplier — above 1.0 is faster. Clamped hard: a demo
 * where the translation sounds like a chipmunk is worse than one a second behind.
 */
export function paceFor(text: string, lang: LangCode, targetMs?: number): number {
  if (!targetMs || targetMs < 400) return 1;
  const estimatedMs = (text.trim().length / charsPerSecond(lang)) * 1000;
  if (estimatedMs < 200) return 1;
  const ratio = estimatedMs / targetMs;
  return Math.max(0.85, Math.min(1.18, Math.round(ratio * 100) / 100));
}

// ---------------------------------------------------------------------------
// STEP 1 — the fallback. Built first, on purpose. Everything below can fail and
// this still carries the demo: a preset Bulbul voice per language. The experience
// survives intact; it loses only the guide's own timbre.
// ---------------------------------------------------------------------------

async function viaBulbul(
  text: string,
  targetLang: string,
  opts: DubOptions,
  degradedReason: string | null,
): Promise<DubResult> {
  const started = Date.now();
  const lang = normalizeLang(targetLang);
  const pace = paceFor(text, lang, opts.targetMs);

  const key = cacheKey(text, lang, 'bulbul', opts.speaker ?? 'preset', pace);
  if (!opts.bypassCache) {
    const hit = dubCache.get(key);
    if (hit) return { ...hit, cached: true, latencyMs: Date.now() - started, degradedReason };
  }

  const spoken = await speak(text, lang, opts.speaker, { pace, signal: opts.signal });

  const result: DubResult = {
    url: spoken.url,
    base64: spoken.base64,
    mime: spoken.mime,
    bytes: spoken.bytes,
    engine: 'bulbul',
    lang,
    voiceLang: spoken.voiceLang,
    degraded: spoken.degraded,
    speaker: spoken.speaker,
    latencyMs: Date.now() - started,
    cached: false,
    degradedReason,
    pace,
  };
  dubCache.set(key, result, result.bytes);
  return result;
}

// ---------------------------------------------------------------------------
// STEP 2 — Sarvam Dub, behind SARVAM_DUB_ENABLED. Every assumption it rests on is
// declared in the block at the top of this file. Any failure falls through.
// ---------------------------------------------------------------------------

/**
 * Register the guide's consent recording as a reusable speaker handle (A2).
 * Best effort: a null return is not an error, it just means we will pass the
 * reference audio inline on every request instead (A4).
 */
export async function registerVoiceProfile(
  referenceB64: string,
  lang: LangCode,
  opts: { mime?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (!isDubEnabled() || !isConfigured()) return null;

  for (const path of DUB_VOICE_PATHS) {
    if (deadPaths.has(path)) continue;
    try {
      const body = await sarvamFetch<any>(path, {
        json: {
          // A3 — superset of plausible field names.
          model: DUB_MODEL,
          language_code: lang,
          reference_audio: referenceB64,
          speaker_audio: referenceB64,
          audio_format: opts.mime ?? 'audio/wav',
          consent: true,
        },
        attempts: 1,
        timeoutMs: 20_000,
        signal: opts.signal,
      });
      const id =
        body?.speaker_id ?? body?.id ?? body?.voice_id ?? body?.data?.speaker_id ?? body?.data?.id ?? null;
      if (typeof id === 'string' && id) return id;
      deadPaths.add(path);
    } catch (err) {
      if (err instanceof SarvamAuth || err instanceof SarvamNotConfigured) throw err;
      deadPaths.add(path);
      console.warn(`[dub] speaker registration path ${path} unusable: ${(err as Error).message}`);
    }
  }
  return null;
}

async function viaSarvamDub(text: string, targetLang: LangCode, opts: DubOptions): Promise<DubResult> {
  const started = Date.now();
  const voice = opts.voice!;
  const pace = paceFor(text, targetLang, opts.targetMs);

  // One deadline across every candidate path, not per attempt. The brief's number is
  // wall-clock from the guide's mouth, so retrying past it helps nobody.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DUB_TIMEOUT_MS);
  const onOuterAbort = () => deadline.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let lastErr: unknown = null;
    for (const path of DUB_PATHS) {
      if (deadPaths.has(path)) continue;
      if (deadline.signal.aborted) break;
      try {
        // A3 + A4 + A7 — everything guessed, all in one payload.
        const payload: Record<string, unknown> = {
          input: text,
          text,
          model: DUB_MODEL,
          source_language_code: normalizeLang(opts.sourceLang ?? voice.lang),
          target_language_code: targetLang,
          output_audio_codec: 'wav',
          duration_control: true,
          target_duration_ms: opts.targetMs ?? null,
          pace,
        };
        if (voice.id) payload.speaker_id = voice.id;
        if (voice.referenceB64) {
          payload.reference_audio = voice.referenceB64;
          payload.speaker_audio = voice.referenceB64;
        }

        const body = await sarvamFetch<any>(path, {
          json: payload,
          attempts: 1,
          timeoutMs: DUB_TIMEOUT_MS,
          signal: deadline.signal,
        });

        // A5 — reuse the tolerant Bulbul reader.
        const b64s = readAudioB64(body);
        if (b64s.length === 0) {
          deadPaths.add(path);
          throw new SarvamBadResponse('Dub returned no audio field', { endpoint: path, body: Object.keys(body ?? {}) });
        }

        const { bytes, mime } = concatAudio(b64s.map(b64ToBytes));
        if (bytes.length === 0) throw new SarvamBadResponse('Dub returned empty audio', { endpoint: path });
        const base64 = bytesToB64(bytes);

        return {
          url: `data:${mime};base64,${base64}`,
          base64,
          mime,
          bytes: bytes.length,
          engine: 'dub',
          lang: targetLang,
          voiceLang: targetLang, // the guide's own voice — no Bulbul language gap applies
          degraded: false,
          speaker: voice.id ?? 'guide-voice',
          latencyMs: Date.now() - started,
          cached: false,
          degradedReason: null,
          pace,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof SarvamAuth || err instanceof SarvamNotConfigured) throw err;
        console.warn(`[dub] path ${path} failed: ${(err as Error).message}`);
      }
    }
    throw lastErr ?? new SarvamBadResponse('No Sarvam Dub endpoint responded');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// The one entry point everything else uses.
// ---------------------------------------------------------------------------

/**
 * Voice `text` in `targetLang`, in the guide's own voice when that is possible and
 * consented, and in a preset Bulbul voice when it is not.
 *
 * This never throws for a Dub-side problem. Dub is best-effort by construction: a
 * missing endpoint, a bad payload guess, a slow response past DUB_TIMEOUT_MS, all
 * land in the same place — a Bulbul render with `degradedReason` set so the UI can
 * be honest about what the listener is hearing. It only throws when Bulbul itself
 * fails, which is a real outage worth surfacing.
 */
export async function dub(text: string, targetLang: string, opts: DubOptions = {}): Promise<DubResult> {
  const clean = text.trim();
  if (!clean) throw new SarvamBadResponse('dub() called with empty text');
  const lang = normalizeLang(targetLang);

  const useDub = isDubEnabled() && Boolean(opts.voice) && isConfigured();
  if (!useDub) {
    // No consent recorded means no voice clone. That is the point of consent.
    const reason = !isDubEnabled()
      ? null // flag off: Bulbul is the intended engine, not a degradation
      : !opts.voice
        ? 'no_consented_voice'
        : null;
    return viaBulbul(clean, lang, opts, reason);
  }

  const voice = opts.voice!;
  const voiceKey = voice.id ?? `ref:${(voice.referenceB64 ?? '').length}:${voice.consentedAt}`;
  const pace = paceFor(clean, lang, opts.targetMs);
  const key = cacheKey(clean, lang, 'dub', voiceKey, pace);

  if (!opts.bypassCache) {
    const hit = dubCache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  const started = Date.now();
  try {
    const result = await viaSarvamDub(clean, lang, opts);
    dubCache.set(key, result, result.bytes);
    return result;
  } catch (err) {
    if (err instanceof SarvamAuth || err instanceof SarvamNotConfigured) throw err;

    const elapsed = Date.now() - started;
    const timedOut = elapsed >= DUB_TIMEOUT_MS || (err as Error)?.name === 'AbortError';
    const reason = timedOut ? 'dub_timeout' : 'dub_failed';

    // Fire and forget: analytics must never sit in the latency path.
    void logEvent('dub_degraded', {
      reason,
      lang,
      elapsedMs: elapsed,
      timeoutMs: DUB_TIMEOUT_MS,
      chars: clean.length,
      message: (err as Error)?.message?.slice(0, 300) ?? null,
      pathsTried: DUB_PATHS.filter((p) => !deadPaths.has(p)),
    });

    return viaBulbul(clean, lang, opts, reason);
  }
}

// ---------------------------------------------------------------------------
// Pre-warm — the brief asks for a throwaway phrase at session start so the first
// real sentence does not pay for connection setup and a cold model.
// ---------------------------------------------------------------------------

/** Short, neutral, and different per language so we warm the right text pipeline. */
const WARMUP_PHRASES: Record<string, string> = {
  'hi-IN': 'नमस्ते, हम शुरू करते हैं।',
  'en-IN': 'Hello, we are ready to begin.',
  'bn-IN': 'নমস্কার, আমরা শুরু করছি।',
  'gu-IN': 'નમસ્તે, અમે શરૂ કરીએ છીએ.',
  'kn-IN': 'ನಮಸ್ಕಾರ, ನಾವು ಪ್ರಾರಂಭಿಸೋಣ.',
  'ml-IN': 'നമസ്കാരം, നമുക്ക് തുടങ്ങാം.',
  'mr-IN': 'नमस्कार, आपण सुरुवात करूया.',
  'od-IN': 'ନମସ୍କାର, ଆମେ ଆରମ୍ଭ କରୁଛୁ।',
  'pa-IN': 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਅਸੀਂ ਸ਼ੁਰੂ ਕਰਦੇ ਹਾਂ।',
  'ta-IN': 'வணக்கம், நாம் தொடங்குவோம்.',
  'te-IN': 'నమస్కారం, మనం ప్రారంభిద్దాం.',
};

export function warmupPhrase(lang: LangCode): string {
  return WARMUP_PHRASES[normalizeLang(lang)] ?? WARMUP_PHRASES['en-IN'];
}

export interface PrewarmReport {
  lang: LangCode;
  engine: DubEngine | null;
  ms: number;
  ok: boolean;
  error: string | null;
}

/**
 * Open the connection and pay the cold-start cost now, while the guide is still
 * reading the consent card, instead of on the first sentence of the tour. The
 * result is deliberately left in the cache: if the guide opens with a greeting it
 * is already paid for.
 */
export async function prewarm(langs: string[], opts: DubOptions = {}): Promise<PrewarmReport[]> {
  if (!isConfigured()) {
    return langs.map((l) => ({ lang: normalizeLang(l), engine: null, ms: 0, ok: false, error: 'not_configured' }));
  }
  const unique = [...new Set(langs.map(normalizeLang))];
  return Promise.all(
    unique.map(async (lang): Promise<PrewarmReport> => {
      const started = Date.now();
      try {
        const r = await dub(warmupPhrase(lang), lang, { ...opts, targetMs: undefined });
        return { lang, engine: r.engine, ms: Date.now() - started, ok: true, error: null };
      } catch (err) {
        return { lang, engine: null, ms: Date.now() - started, ok: false, error: (err as Error).message };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Fan-out — one guide sentence to every listener language at once.
// ---------------------------------------------------------------------------

export interface FanoutTarget {
  lang: LangCode;
  /** Already translated into `lang`. */
  text: string;
}

export interface FanoutOutcome {
  lang: LangCode;
  ok: boolean;
  result: DubResult | null;
  error: string | null;
  ms: number;
}

/**
 * Voice one sentence into every listener language.
 *
 * `targets` must arrive sorted by listener count, most common first — the brief asks
 * for "the two most common listener languages first, then the rest". The head pair is
 * dispatched immediately and the tail follows as soon as the head settles, so the
 * majority of the room hears the guide at the earliest possible moment instead of
 * every language contending for the same rate limit at once.
 *
 * `onResult` fires the instant each language is ready, so the SSE hub can push audio
 * to the Tamil listeners without waiting on Malayalam.
 */
export async function dubFanout(
  targets: FanoutTarget[],
  opts: DubOptions & { priorityCount?: number; onResult?: (outcome: FanoutOutcome) => void } = {},
): Promise<FanoutOutcome[]> {
  const { priorityCount = 2, onResult, ...dubOpts } = opts;
  const outcomes = new Map<LangCode, FanoutOutcome>();

  const run = async (t: FanoutTarget): Promise<void> => {
    const started = Date.now();
    try {
      const result = await dub(t.text, t.lang, dubOpts);
      const outcome: FanoutOutcome = { lang: t.lang, ok: true, result, error: null, ms: Date.now() - started };
      outcomes.set(t.lang, outcome);
      onResult?.(outcome);
    } catch (err) {
      const outcome: FanoutOutcome = {
        lang: t.lang,
        ok: false,
        result: null,
        error: (err as Error).message,
        ms: Date.now() - started,
      };
      outcomes.set(t.lang, outcome);
      onResult?.(outcome);
    }
  };

  const head = targets.slice(0, Math.max(0, priorityCount));
  const tail = targets.slice(head.length);

  await Promise.all(head.map(run));
  if (tail.length) await Promise.all(tail.map(run));

  return targets.map(
    (t) => outcomes.get(t.lang) ?? { lang: t.lang, ok: false, result: null, error: 'not_attempted', ms: 0 },
  );
}

export { resolveVoice, normalizeLang, MODELS };
export type { LangCode };
