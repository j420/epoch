import { NextResponse, type NextRequest } from 'next/server';

import { toErrorPayload } from '@/lib/errors';
import { normalizeLang, type LangCode } from '@/lib/langs';
import { chunksSince, getRoom, roster, summarise, touchListener } from '../_room';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The polling fallback for the SSE stream. Same payloads, no long-lived connection.
 *
 * Build this before you need it: conference wifi, corporate proxies and a couple of
 * in-app browsers will happily terminate a streaming response, and the failure looks
 * exactly like "the tour went silent". The listener client watches for that and
 * switches here without the audience noticing.
 *
 * It is also what the guide's own screen uses (`lang=*`) — the guide wants the roster
 * and the transcript, not the audio, and a 2s poll is simpler and steadier for that
 * than a second stream.
 *
 *   GET /api/guide/poll?code=4821&lang=ta-IN&since=12[&lid=<listenerId>]
 *   -> { chunks: GuideChunk[], seq, listeners, languages, ended, stats }
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const code = (params.get('code') ?? '').trim();
    const rawLang = (params.get('lang') ?? '').trim();
    const listenerId = (params.get('lid') ?? '').trim() || null;

    const room = getRoom(code);
    if (!room) {
      return NextResponse.json({ error: `No live session for code ${code || '(none)'}`, kind: 'no_room', status: 404 }, { status: 404 });
    }
    if (!rawLang) {
      return NextResponse.json(
        { error: 'lang is required — it comes from the join step, never from a picker.', kind: 'no_lang', status: 400 },
        { status: 400 },
      );
    }

    const lang: LangCode | '*' = rawLang === '*' ? '*' : normalizeLang(rawLang);
    const sinceRaw = Number(params.get('since') ?? 0);
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;

    // Polling is proof of presence too, exactly as holding a stream open is.
    touchListener(room, listenerId);

    const chunks = chunksSince(room, lang, since);
    const snapshot = roster(room);

    return NextResponse.json(
      {
        chunks,
        seq: room.seq,
        listeners: snapshot.listeners,
        languages: snapshot.languages,
        consented: Boolean(room.consent),
        consentAt: room.consent?.at ?? null,
        guideLang: room.guideLang,
        ended: Boolean(room.endedAt),
        stats: summarise(room).stats,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}
