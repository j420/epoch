import { NextResponse, type NextRequest } from 'next/server';

import { SarvamBadResponse, SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { isConfigured, listen, translate } from '@/lib/sarvam';
import { dubFanout, type FanoutTarget } from '@/lib/dub';
import { logEvent, logTurn } from '@/lib/db';
import type { LangCode } from '@/lib/langs';
import { getRoom, languageCounts, publish, recordChunkStats } from '../_room';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One sentence of the guide, on its way to the whole room.
 *
 * Saaras transcribes it, sarvam-translate renders it once per distinct listener
 * language, and each rendering is voiced and pushed to that language's subscribers
 * the moment it is ready — the Tamil listeners do not wait on Malayalam.
 *
 * Order matters for latency: languages are handed to `dubFanout` sorted by listener
 * count so the two biggest groups are generated first, which is what the brief asks
 * for and what keeps the median listener under the 3s budget.
 */
export async function POST(req: NextRequest) {
  const receivedAt = Date.now();
  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const form = await req.formData();
    const code = String(form.get('code') ?? '').trim();
    const room = getRoom(code);
    if (!room) {
      return NextResponse.json({ error: `No live session for code ${code || '(none)'}`, kind: 'no_room', status: 404 }, { status: 404 });
    }
    if (room.endedAt) {
      return NextResponse.json({ error: 'That session has already ended.', kind: 'room_ended', status: 410 }, { status: 410 });
    }

    const file = form.get('audio');
    if (!(file instanceof Blob) || file.size === 0) {
      throw new SarvamBadResponse('chunk requires a non-empty `audio` part');
    }

    // The recorded length of the guide's chunk. Duration control uses it to keep the
    // dubbed line close to the original so the group does not drift apart.
    const declaredMs = Number(form.get('ms') ?? 0);
    const targetMs = Number.isFinite(declaredMs) && declaredMs > 400 ? Math.round(declaredMs) : undefined;

    const heard = await listen(file, 'transcribe');
    const transcript = heard.transcript.trim();
    const sttMs = heard.latencyMs;

    // VAD is not perfect. A chunk of breath and room tone is normal and is not an
    // error — swallow it quietly rather than pushing silence at the room.
    if (!transcript) {
      return NextResponse.json({ transcript: '', targets: [], skipped: 'silence', sttMs, totalMs: Date.now() - receivedAt });
    }

    // The guide's language is whatever they consented in; a single mis-detection on
    // one chunk should not flip the whole tour's source language.
    const sourceLang: LangCode = room.consent?.lang ?? room.guideLang;

    const audience = languageCounts(room); // already sorted, most listeners first
    if (audience.length === 0) {
      void logTurn({ session_id: room.sessionId ?? room.code, role: 'visitor', text: transcript, lang: sourceLang, latency_ms: sttMs });
      return NextResponse.json({
        transcript,
        targets: [],
        skipped: 'no_listeners',
        sttMs,
        totalMs: Date.now() - receivedAt,
      });
    }

    // --- translate, once per distinct language -----------------------------------
    const translateStarted = Date.now();
    const targets: FanoutTarget[] = await Promise.all(
      audience.map(async ({ lang }): Promise<FanoutTarget> => {
        if (lang === sourceLang) return { lang, text: transcript };
        try {
          const text = await translate(transcript, lang, { from: sourceLang, colloquial: true });
          return { lang, text: text || transcript };
        } catch (err) {
          console.warn(`[guide] translate ${sourceLang}->${lang} failed: ${(err as Error).message}`);
          // Better the guide's own words than silence: the listener still gets audio,
          // and the UI marks the language as untranslated.
          return { lang, text: transcript };
        }
      }),
    );
    const translateMs = Date.now() - translateStarted;

    // --- voice + push, streaming each language out as it lands -------------------
    const emitted: { lang: LangCode; ms: number; engine: string; ok: boolean; seq: number | null; degradedReason: string | null; voiceDegraded: boolean }[] = [];

    const outcomes = await dubFanout(targets, {
      voice: room.voice, // null until consent is recorded — no consent, no clone
      sourceLang,
      targetMs,
      priorityCount: 2,
      onResult: (outcome) => {
        const target = targets.find((t) => t.lang === outcome.lang);
        const chunk = publish(room, {
          lang: outcome.lang,
          text: target?.text ?? transcript,
          sourceText: transcript,
          audio: outcome.result?.url ?? null,
          mime: outcome.result?.mime ?? null,
          engine: outcome.result?.engine ?? 'none',
          ms: outcome.ms,
          totalMs: Date.now() - receivedAt,
          voiceDegraded: outcome.result?.degraded ?? false,
          degradedReason: outcome.result?.degradedReason ?? outcome.error,
        });
        emitted.push({
          lang: outcome.lang,
          ms: outcome.ms,
          engine: chunk.engine,
          ok: outcome.ok,
          seq: chunk.seq,
          degradedReason: chunk.degradedReason,
          voiceDegraded: chunk.voiceDegraded,
        });
      },
    });

    recordChunkStats(
      room,
      outcomes.map((o) => ({ ok: o.ok, engine: o.result?.engine ?? 'none', ms: o.ms })),
    );

    const totalMs = Date.now() - receivedAt;

    void logTurn({
      session_id: room.sessionId ?? room.code,
      role: 'visitor',
      text: transcript,
      lang: sourceLang,
      latency_ms: totalMs,
    });
    void logEvent(
      'guide_chunk',
      {
        code: room.code,
        chars: transcript.length,
        languages: targets.map((t) => t.lang),
        sttMs,
        translateMs,
        totalMs,
        engines: outcomes.map((o) => o.result?.engine ?? 'none'),
        chunkMs: targetMs ?? null,
      },
      room.sessionId,
    );

    return NextResponse.json({
      transcript,
      lang: sourceLang,
      // Spec shape: [{ lang, ms, engine }], plus the honesty fields the UI needs.
      targets: emitted.sort((a, b) => a.ms - b.ms),
      sttMs,
      translateMs,
      totalMs,
      listeners: audience.reduce((n, a) => n + a.count, 0),
      consented: Boolean(room.consent),
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}
