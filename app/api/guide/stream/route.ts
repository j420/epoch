import { type NextRequest } from 'next/server';

import { toErrorPayload } from '@/lib/errors';
import { normalizeLang, type LangCode } from '@/lib/langs';
import {
  GUIDE_SSE_MAX_MS,
  SSE_PING_MS,
  chunksSince,
  getRoom,
  roster,
  subscribe,
  touchListener,
  type GuideChunk,
  type GuideStats,
  type RosterSnapshot,
} from '../_room';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The listener's downstream, over Server-Sent Events.
 *
 * WHY SSE AND NOT A WEBSOCKET: this app deploys to Vercel, where a serverless
 * function cannot hold a socket open. SSE runs on the Node runtime, reconnects on its
 * own, and is one-directional — which is exactly a listener's need. The full
 * rationale is in the header of lib/dub.ts.
 *
 * CONTRACT
 *   GET /api/guide/stream?code=4821&lang=ta-IN[&lid=<listenerId>]
 *   Pass lang=* for the guide's monitor view: every language, audio stripped.
 *
 *   event: ready   data: { code, lang, seq, listeners, languages, consented, guideLang, ended }
 *   event: chunk   data: GuideChunk  — { seq, lang, text, sourceText, audio, mime, engine, ms, ... }
 *                  each carries `id: <seq>`, so a reconnect resumes via Last-Event-ID
 *   event: roster  data: { listeners, languages[] }
 *   event: end     data: { ended: true, stats }
 *   `: ping` comment every 15s — without it proxies and venue wifi drop the response
 *
 * The connection closes itself after GUIDE_SSE_MAX_MS. That is intentional: platform
 * timeouts would otherwise kill it at an arbitrary moment, and EventSource's built-in
 * reconnect plus Last-Event-ID replay makes the rollover invisible.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const code = (params.get('code') ?? '').trim();
    const rawLang = (params.get('lang') ?? '').trim();
    const listenerId = (params.get('lid') ?? '').trim() || null;
    const room = getRoom(code);

    if (!room) {
      return sseError('no_room', `No live session for code ${code || '(none)'}`, 404);
    }
    if (!rawLang) {
      return sseError('no_lang', 'lang is required — it comes from the join step, never from a picker.', 400);
    }

    const lang: LangCode | '*' = rawLang === '*' ? '*' : normalizeLang(rawLang);

    // Resume point: an explicit ?since= wins, else the browser's Last-Event-ID.
    const lastEventId = Number(req.headers.get('last-event-id') ?? NaN);
    const sinceParam = Number(params.get('since') ?? NaN);
    const since = Number.isFinite(sinceParam) ? sinceParam : Number.isFinite(lastEventId) ? lastEventId : room.seq;

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let ping: ReturnType<typeof setInterval> | null = null;
        let lifetime: ReturnType<typeof setTimeout> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let unsubscribe: (() => void) | null = null;

        const send = (event: string, data: unknown, id?: number) => {
          if (closed) return;
          try {
            const payload =
              (id !== undefined ? `id: ${id}\n` : '') +
              `event: ${event}\n` +
              `data: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            close();
          }
        };

        const close = () => {
          if (closed) return;
          closed = true;
          if (ping) clearInterval(ping);
          if (heartbeat) clearInterval(heartbeat);
          if (lifetime) clearTimeout(lifetime);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already torn down */
          }
        };

        // Some proxies buffer until they have seen a few hundred bytes. This padding
        // comment forces the response through immediately.
        controller.enqueue(encoder.encode(`:${' '.repeat(2048)}\n\n`));
        controller.enqueue(encoder.encode(`retry: 2000\n\n`));

        const snapshot = roster(room);
        send('ready', {
          code: room.code,
          lang,
          seq: room.seq,
          since,
          listeners: snapshot.listeners,
          languages: snapshot.languages,
          consented: Boolean(room.consent),
          guideLang: room.guideLang,
          ended: Boolean(room.endedAt),
          maxMs: GUIDE_SSE_MAX_MS,
        });

        // Anything this listener missed while reconnecting.
        for (const missed of chunksSince(room, lang, since)) send('chunk', missed, missed.seq);

        if (room.endedAt) {
          send('end', { ended: true, stats: room.stats });
          close();
          return;
        }

        unsubscribe = subscribe(room, {
          lang,
          onChunk: (chunk: GuideChunk) => send('chunk', chunk, chunk.seq),
          onRoster: (r: RosterSnapshot) => send('roster', r),
          onEnd: (stats: GuideStats) => {
            send('end', { ended: true, stats });
            close();
          },
        });

        // A held-open stream is proof of presence; keep the roster count honest.
        touchListener(room, listenerId);
        heartbeat = setInterval(() => touchListener(room, listenerId), 30_000);

        ping = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
          } catch {
            close();
          }
        }, SSE_PING_MS);

        lifetime = setTimeout(() => {
          // Tell the client where to resume, then let EventSource reconnect.
          send('bye', { reason: 'max_lifetime', seq: room.seq });
          close();
        }, GUIDE_SSE_MAX_MS);

        req.signal.addEventListener('abort', close, { once: true });
        if (req.signal.aborted) close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
        Connection: 'keep-alive',
        // nginx and a good few venue proxies buffer text/* by default; this disables it.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return sseError(payload.kind, payload.error, payload.status);
  }
}

/**
 * Errors go back as JSON with the right status rather than as a stream. EventSource
 * cannot read a body, but the client's polling fallback and any human with curl can.
 */
function sseError(kind: string, error: string, status: number): Response {
  return new Response(JSON.stringify({ error, kind, status }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
