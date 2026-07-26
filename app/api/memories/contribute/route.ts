import { NextResponse } from 'next/server';

import { insertMemory, logEvent } from '@/lib/db';
import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { normalizeLang } from '@/lib/langs';
import { DEFAULT_MONUMENT_ID, displayName, getMonument } from '@/lib/monuments';
import { STT_MAX_SECONDS, isConfigured, listen, type ListenResult } from '@/lib/sarvam';

import { moderate } from '../_lib/moderation';
import { putAudio } from '../_lib/storage';
import { recordVerdict } from '../_lib/verdicts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/memories/contribute   (multipart/form-data)
 *
 *   audio       Blob   required, <= 30s of speech (the Saaras REST cap)
 *   monument_id string
 *   consented   'true' | 'false'
 *   city        string  optional
 *   session_id  string  optional
 *
 * Saaras runs TWICE over the same bytes:
 *
 *   mode 'verbatim'   — every "umm", every pause, every switch into English. This is
 *                       the authentic record. It is what a grandchild would recognise.
 *   mode 'transcribe' — clean text. This is what retrieval indexes and what gets
 *                       translated for a listener who does not share the language.
 *
 * Storing the two separately is the whole point: one is evidence, one is an index.
 *
 * Consent is a gate, not a flag. Without an explicit 'true' we keep the text record
 * marked unconsented, store no audio at all, and return nothing of what was said.
 * `approved` is false on every path — a human presses the button in /admin.
 */

const MAX_BYTES = 12 * 1024 * 1024; // ~30s of Opus with a very generous margin

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const audio = form.get('audio');
    if (!(audio instanceof Blob) || audio.size === 0) {
      return NextResponse.json(
        { error: 'No audio was uploaded. Send a Blob in the "audio" field.', kind: 'bad_request', status: 400 },
        { status: 400 },
      );
    }
    if (audio.size > MAX_BYTES) {
      return NextResponse.json(
        {
          error: `That recording is larger than we accept. Keep it under ${STT_MAX_SECONDS} seconds.`,
          kind: 'too_large',
          status: 413,
        },
        { status: 413 },
      );
    }

    const monumentId = str(form.get('monument_id')) || DEFAULT_MONUMENT_ID;
    const consented = str(form.get('consented')) === 'true';
    const city = str(form.get('city')).slice(0, 60) || null;
    const sessionId = str(form.get('session_id')) || null;

    // No key: say so plainly rather than storing audio we can never understand.
    if (!isConfigured()) throw new SarvamNotConfigured();

    const mime = audio.type || 'audio/webm';
    const bytes = new Uint8Array(await audio.arrayBuffer());

    // Same bytes, two modes, in parallel. The verbatim pass is the one we cannot lose.
    const [verbatimRes, cleanRes] = await Promise.allSettled([
      listen(bytes, 'verbatim', { filename: filenameFor(mime) }),
      listen(bytes, 'transcribe', { filename: filenameFor(mime) }),
    ]);

    const verbatimOk = verbatimRes.status === 'fulfilled' ? verbatimRes.value : null;
    const cleanOk = cleanRes.status === 'fulfilled' ? cleanRes.value : null;

    if (!verbatimOk && !cleanOk) {
      // Both failed — surface the real reason (auth, rate limit, bad response).
      throw verbatimRes.status === 'rejected' ? verbatimRes.reason : (cleanRes as PromiseRejectedResult).reason;
    }
    if (!verbatimOk || !cleanOk) {
      await logEvent(
        'memory_stt_partial',
        {
          monument_id: monumentId,
          missing: verbatimOk ? 'transcribe' : 'verbatim',
          reason: String(
            (verbatimOk ? (cleanRes as PromiseRejectedResult).reason : (verbatimRes as PromiseRejectedResult).reason) ??
              '',
          ).slice(0, 200),
        },
        sessionId,
      );
    }

    const primary = (cleanOk ?? verbatimOk) as ListenResult;
    const transcript = (cleanOk?.transcript ?? verbatimOk?.transcript ?? '').trim();
    const verbatim = (verbatimOk?.transcript ?? cleanOk?.transcript ?? '').trim();
    const lang = normalizeLang(primary.lang);

    const monument = getMonument(monumentId);
    const moderation = await moderate(transcript, { monumentName: displayName(monument, 'en-IN') });

    // Nothing intelligible on the tape: do not litter the wall with empty rows.
    if (!transcript && !verbatim) {
      await logEvent('memory_empty', { monument_id: monumentId, lang }, sessionId);
      return NextResponse.json({
        id: null,
        stored: false,
        lang,
        transcript: '',
        verbatim: '',
        approved: false,
        consented,
        moderation: { verdict: 'irrelevant', reason: 'No speech was detected in the recording.' },
      });
    }

    // Audio is kept only where consent was actually given.
    const stored = consented ? await putAudio(bytes, mime) : { url: null, backend: 'none' as const };
    if (consented && !stored.url) {
      await logEvent(
        'memory_audio_missing',
        { monument_id: monumentId, reason: 'reason' in stored ? stored.reason : 'no writable audio store' },
        sessionId,
      );
    }

    const memory = await insertMemory({
      monument_id: monumentId,
      lang,
      transcript,
      verbatim,
      audio_url: stored.url,
      city,
      consented,
      // Never true here. Approval is a human act, performed in /admin.
      approved: false,
    });

    await recordVerdict(memory.id, moderation);
    await logEvent(
      'memory_contributed',
      {
        memory_id: memory.id,
        monument_id: monumentId,
        lang,
        consented,
        verdict: moderation.verdict,
        moderation_degraded: moderation.degraded,
        audio_backend: stored.backend,
        chars: { verbatim: verbatim.length, clean: transcript.length },
        stt_latency_ms: primary.latencyMs,
      },
      sessionId,
    );

    if (!consented) {
      // Stored as an unconsented record and never echoed back — not even to the
      // person who just spoke, and not to /admin.
      return NextResponse.json({
        id: memory.id,
        stored: true,
        lang,
        transcript: null,
        verbatim: null,
        approved: false,
        consented: false,
        moderation: { verdict: moderation.verdict, reason: 'Withheld — consent was not given.' },
      });
    }

    return NextResponse.json({
      id: memory.id,
      stored: true,
      lang,
      transcript,
      verbatim,
      approved: false,
      consented: true,
      audio_url: stored.url,
      moderation: { verdict: moderation.verdict, reason: moderation.reason },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v.trim() : '';
}

function filenameFor(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (base.includes('ogg')) return 'memory.ogg';
  if (base.includes('mp4') || base.includes('m4a') || base.includes('aac')) return 'memory.m4a';
  if (base.includes('wav')) return 'memory.wav';
  if (base.includes('mpeg') || base.includes('mp3')) return 'memory.mp3';
  return 'memory.webm';
}
