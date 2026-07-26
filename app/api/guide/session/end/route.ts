import { NextResponse, type NextRequest } from 'next/server';

import { toErrorPayload } from '@/lib/errors';
import { logEvent } from '@/lib/db';
import { endRoom, getRoom, summarise } from '../../_room';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Close the tour. Every open SSE connection gets an `end` event and is shut down
 * cleanly, so listener phones stop reconnecting instead of retrying into a void.
 *
 * Like `session/create` this touches no Sarvam endpoint, so it stays available even
 * with no key configured — ending a session must never be the thing that fails.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const code = String(body?.code ?? '').trim();

    const room = getRoom(code);
    if (!room) {
      return NextResponse.json({ error: `No live session for code ${code || '(none)'}`, kind: 'no_room', status: 404 }, { status: 404 });
    }

    // Snapshot before ending: `endRoom` clears the subscriber set.
    const summary = summarise(room);
    endRoom(code);

    void logEvent(
      'guide_session_ended',
      {
        code,
        chunks: summary.stats.chunks,
        targets: summary.stats.targets,
        viaDub: summary.stats.viaDub,
        viaBulbul: summary.stats.viaBulbul,
        averageMs: summary.stats.averageMs,
        listeners: summary.listeners,
        languages: summary.languages.map((l) => l.lang),
      },
      room.sessionId,
    );

    return NextResponse.json({
      ended: true,
      stats: {
        ...summary.stats,
        code: summary.code,
        startedAt: summary.startedAt,
        endedAt: new Date().toISOString(),
        listeners: summary.listeners,
        languages: summary.languages,
        consented: summary.consented,
        consentAt: summary.consentAt,
      },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}
