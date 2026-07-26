import { NextResponse, type NextRequest } from 'next/server';

import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { logEvent } from '@/lib/db';
import { normalizeLang, resolveVoice, voiceGapNotice } from '@/lib/langs';
import { isConfigured, speak } from '@/lib/sarvam';
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
 */

interface SpeakBody {
  text?: string;
  lang?: string;
  speaker?: string;
  pace?: number;
  sessionId?: string;
  bypassCache?: boolean;
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

    const result = await speak(text, lang, body.speaker, {
      pace: typeof body.pace === 'number' ? body.pace : undefined,
      bypassCache: body.bypassCache === true,
    });

    // Bulbul speaks 11 of the 23 languages Saaras understands. When we had to
    // substitute a relative we say so, out loud, in the visitor's own language.
    const notice = result.degraded ? voiceGapNotice(lang) : null;
    if (result.degraded) {
      await logEvent('voice_gap', { lang, voiceLang: result.voiceLang, speaker: result.speaker }, sessionId);
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
          'x-bol-requested-lang': result.requestedLang,
          'x-bol-speaker': result.speaker,
          'x-bol-degraded': String(result.degraded),
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
      requestedLang: result.requestedLang,
      speaker: result.speaker,
      degraded: result.degraded,
      notice,
      chunks: result.chunks,
      cached: result.cached,
      timings: { tts: result.latencyMs },
      /** What lib/langs would have chosen, so the caller can verify the mapping. */
      target: { voiceLang: target.voiceLang, textLang: target.textLang, degraded: target.degraded },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/speak] failed:', err);
    await logEvent('tts_error', { kind: payload.kind, error: payload.error }, sessionId);
    return NextResponse.json(payload, { status: payload.status });
  }
}
