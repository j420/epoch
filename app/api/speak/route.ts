import { NextResponse, type NextRequest } from 'next/server';

import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { logEvent } from '@/lib/db';
import { normalizeLang, resolveVoice, voiceGapNotice } from '@/lib/langs';
import { isConfigured, speak } from '@/lib/sarvam';
import { castVoice, configuredModel } from '@/lib/voices';
import { b64ToBytes } from '@/lib/wav';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Text in, Bulbul audio out, in the language Saaras detected. Never a language
 * the user picked, because there is nowhere to pick one.
 *
 * Two response shapes:
 *   POST /api/speak         -> JSON with a data: URL (easy to embed, easy to debug)
 *   POST /api/speak?raw=1   -> the audio bytes themselves, metadata in headers
 *
 * The voice loop uses ?raw=1. Base64 inflates the payload by a third and the
 * browser has to decode the whole data: URL before the first sample plays, which
 * is exactly the 200ms of first-byte budget we are trying to protect.
 *
 * ---------------------------------------------------------------------------
 * WHICH VOICE
 * ---------------------------------------------------------------------------
 *
 * lib/voices.ts casts it. Ten monuments are ten characters — an 800-year-old
 * minaret and a palace lit by a hundred thousand bulbs must not share a larynx —
 * so a `monumentId` on the request picks up that monument's speaker and pace.
 * The resolution order is:
 *
 *   SARVAM_FORCE_SPEAKER (env) -> `speaker` on this request -> the monument's
 *   casting -> the language default -> the model's own default
 *
 * and whatever comes out is checked against the catalogue for the configured
 * Bulbul model before it is sent. If Bulbul rejects it anyway, `speak()` retries
 * once with the model default and reports it in `speakerFallback`, which this
 * route turns into an event. Silence is the worst outcome available to a talking
 * monument; a line spoken in the wrong voice is a very distant second.
 */

interface SpeakBody {
  text?: string;
  lang?: string;
  speaker?: string;
  pace?: number;
  sessionId?: string;
  bypassCache?: boolean;
  /**
   * Which monument is speaking. Optional, and its absence is safe — the voice
   * falls back to the language default. Accepted in snake_case too, and as a
   * `?monument=` query param, so a caller that cannot easily change its JSON
   * body can still cast the voice.
   */
  monumentId?: string;
  monument_id?: string;
}

const MAX_CHARS = 4000;

export async function POST(req: NextRequest) {
  let sessionId: string | null = null;

  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const body = (await req.json().catch(() => ({}))) as SpeakBody;
    const text = (body.text ?? '').trim();
    sessionId = body.sessionId ?? null;

    if (!text) {
      return NextResponse.json({ error: 'text is required', kind: 'bad_request' }, { status: 400 });
    }
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        { error: `text is too long (${text.length} chars, max ${MAX_CHARS})`, kind: 'bad_request' },
        { status: 400 },
      );
    }

    const lang = normalizeLang(body.lang);
    const target = resolveVoice(lang, body.speaker);

    const monumentId =
      body.monumentId ?? body.monument_id ?? req.nextUrl.searchParams.get('monument') ?? null;

    /**
     * Cast here as well as inside speak(), and for the same reason /api/speak
     * recomputes `degraded` below: this is a pure function of THIS request, so
     * the response can describe what was asked for even when lib/sarvam served
     * the audio from a cache entry another caller warmed. `speak()` performs the
     * identical resolution internally — the two cannot disagree — and the
     * duplicate here is what lets us log the casting decision even on a hit.
     */
    const cast = castVoice({
      lang: target.voiceLang,
      monumentId,
      speaker: body.speaker ?? null,
      pace: typeof body.pace === 'number' ? body.pace : null,
    });

    const result = await speak(text, lang, body.speaker, {
      pace: typeof body.pace === 'number' ? body.pace : undefined,
      bypassCache: body.bypassCache === true,
      monumentId,
    });

    /**
     * Bulbul speaks 11 of the 23 languages Saaras understands. When we had to
     * substitute a relative we say so, out loud, in the visitor's own language.
     *
     * `degraded` and `requestedLang` are taken from resolveVoice() here rather
     * than from the speak() result, and that is deliberate. lib/sarvam's TTS
     * cache is keyed on (text, VOICE language, speaker, pace) — the language the
     * visitor actually spoke is not in the key — but the cached value carries
     * `requestedLang` and `degraded` from whoever missed the cache first. Two
     * languages that share a voice therefore share an entry: a Sanskrit visitor
     * and a Hindi visitor hearing the same Hindi-voiced line collide, and the
     * Hindi visitor gets told their language could not be spoken. resolveVoice()
     * is a pure function of the language on THIS request, so it cannot go stale.
     */
    const degraded = target.degraded;
    const notice = degraded ? voiceGapNotice(lang) : null;
    if (degraded) {
      await logEvent('voice_gap', { lang, voiceLang: result.voiceLang, speaker: result.speaker }, sessionId);
    }

    /**
     * A cast that had to be corrected, or a speaker Bulbul refused outright, is
     * a bug in lib/voices.ts and must never be invisible — the monument still
     * spoke, so nothing else in the system would ever notice.
     */
    if (cast.correctedFrom) {
      await logEvent(
        'voice_cast_corrected',
        { monumentId, lang: target.voiceLang, wanted: cast.correctedFrom, used: cast.speaker, model: cast.model },
        sessionId,
      );
    }
    if (result.speakerFallback) {
      await logEvent(
        'speaker_fallback',
        {
          monumentId,
          lang: target.voiceLang,
          model: configuredModel(),
          from: result.speakerFallback.from,
          to: result.speakerFallback.to,
          reason: result.speakerFallback.reason,
        },
        sessionId,
      );
    }
    if (monumentId && cast.intent && !result.cached) {
      await logEvent(
        'voice_cast',
        { monumentId, speaker: result.speaker, pace: result.pace, source: cast.source, intent: cast.intent },
        sessionId,
      );
    }

    if (req.nextUrl.searchParams.get('raw') === '1') {
      const bytes = b64ToBytes(result.base64);
      // Copy into a fresh ArrayBuffer: a Uint8Array may be backed by a
      // SharedArrayBuffer, which is not a valid BlobPart.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);

      return new NextResponse(new Blob([copy.buffer], { type: result.mime }), {
        status: 200,
        headers: {
          'content-type': result.mime,
          'content-length': String(result.bytes),
          'cache-control': 'no-store',
          // HTTP headers are latin-1 only and these values are in Indic scripts,
          // so the notice is percent-encoded; the client decodeURIComponent()s it.
          'x-bol-voice-lang': result.voiceLang,
          'x-bol-requested-lang': target.textLang,
          'x-bol-speaker': result.speaker,
          'x-bol-pace': String(result.pace),
          'x-bol-voice-source': cast.source,
          'x-bol-speaker-fallback': result.speakerFallback ? result.speakerFallback.from : '',
          'x-bol-degraded': String(degraded),
          'x-bol-notice': notice ? encodeURIComponent(notice) : '',
          'x-bol-chunks': String(result.chunks),
          'x-bol-cached': String(result.cached),
          'x-bol-latency-ms': String(result.latencyMs),
        },
      });
    }

    return NextResponse.json({
      url: result.url,
      mime: result.mime,
      bytes: result.bytes,
      voiceLang: result.voiceLang,
      requestedLang: target.textLang,
      speaker: result.speaker,
      pace: result.pace,
      degraded,
      notice,
      chunks: result.chunks,
      cached: result.cached,
      timings: { tts: result.latencyMs },
      /** What lib/langs would have chosen, so the caller can verify the mapping. */
      target: { voiceLang: target.voiceLang, textLang: target.textLang, degraded: target.degraded },
      /**
       * How the voice was chosen, and whether anything had to be corrected.
       * `correctedFrom`/`fallbackFrom` being non-null means a name in
       * lib/voices.ts is wrong for the configured Bulbul model.
       */
      voice: {
        model: cast.model,
        source: cast.source,
        monumentId,
        intent: cast.intent,
        correctedFrom: cast.correctedFrom,
        fallbackFrom: result.speakerFallback?.from ?? null,
      },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/speak] failed:', err);
    await logEvent('tts_error', { kind: payload.kind, error: payload.error }, sessionId);
    return NextResponse.json(payload, { status: payload.status });
  }
}
