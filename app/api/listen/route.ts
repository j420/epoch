import { NextResponse, type NextRequest } from 'next/server';

import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { logEvent, logTurn, setSessionLang } from '@/lib/db';
import { detectedChip, normalizeLang } from '@/lib/langs';
import { didNotCatch } from '@/lib/prompts';
import { STT_MAX_SECONDS, isConfigured, listen, type SttMode } from '@/lib/sarvam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Speech in, transcript + language out.
 *
 * This is the ONLY place the product decides what language the visitor speaks.
 * Nothing downstream may override it, and nothing anywhere may ask. Saaras runs
 * in 'codemix' mode because real visitors say "Qutub kitna purana hai" — a
 * transcribe-only mode mangles that into one script or the other.
 */

/** ~30s of Opus at 32kbps is under 150KB; 8MB is a generous ceiling that still stops abuse. */
const MAX_BYTES = 8 * 1024 * 1024;

const VALID_MODES: SttMode[] = ['transcribe', 'translate', 'verbatim', 'transliterate', 'codemix'];

export async function POST(req: NextRequest) {
  const started = Date.now();
  let sessionId: string | null = null;

  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const form = await req.formData();
    const file = form.get('audio') ?? form.get('file');

    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: 'No audio uploaded. Send multipart/form-data with an "audio" field.', kind: 'bad_request' },
        { status: 400 },
      );
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'Empty audio upload.', kind: 'bad_request' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `Audio too large (${file.size} bytes). Saaras accepts at most ${STT_MAX_SECONDS}s.`, kind: 'too_large' },
        { status: 413 },
      );
    }

    sessionId = str(form.get('sessionId'));
    const lastLang = str(form.get('lastLang'));
    const requestedMode = str(form.get('mode')) as SttMode | null;
    const mode: SttMode = requestedMode && VALID_MODES.includes(requestedMode) ? requestedMode : 'codemix';

    // Pass the Blob straight through: lib/sarvam derives the upload filename from
    // its mime type, and that matters — iOS Safari sends audio/mp4, not webm.
    const result = await listen(file, mode);

    // --- Empty transcript: the visitor breathed, or the mic caught nothing. ---
    // Rule: say "I did not catch that" in the LAST KNOWN language rather than
    // failing silently. Saaras's guess on silence is noise, so we do not trust it.
    if (!result.transcript) {
      const lang = normalizeLang(lastLang || undefined);
      await logEvent(
        'stt_empty',
        { bytes: file.size, mime: file.type, rawLang: result.rawLang, sttMs: result.latencyMs },
        sessionId,
      );
      return NextResponse.json({
        transcript: '',
        lang,
        rawLang: result.rawLang,
        empty: true,
        switched: false,
        chip: detectedChip(lang),
        fallbackText: didNotCatch(lang),
        mode,
        timings: { stt: result.latencyMs, total: Date.now() - started },
      });
    }

    const lang = result.lang;
    const previous = lastLang ? normalizeLang(lastLang) : null;
    const switched = previous !== null && previous !== lang;

    if (sessionId) {
      // Follow the visitor if they change language mid-session — always.
      await setSessionLang(sessionId, lang);
      await logTurn({
        session_id: sessionId,
        role: 'visitor',
        text: result.transcript,
        lang,
        latency_ms: result.latencyMs,
      });
      if (switched) await logEvent('lang_switch', { from: previous, to: lang }, sessionId);
    }

    return NextResponse.json({
      transcript: result.transcript,
      lang,
      rawLang: result.rawLang,
      empty: false,
      switched,
      chip: detectedChip(lang),
      mode,
      bytes: file.size,
      timings: { stt: result.latencyMs, total: Date.now() - started },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/listen] failed:', err);
    await logEvent('stt_error', { kind: payload.kind, error: payload.error }, sessionId);
    return NextResponse.json(payload, { status: payload.status });
  }
}

function str(v: FormDataEntryValue | null): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}
