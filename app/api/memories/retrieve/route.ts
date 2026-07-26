import { NextResponse } from 'next/server';

import { listMemories, logEvent } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';
import { normalizeLang } from '@/lib/langs';
import { DEFAULT_MONUMENT_ID } from '@/lib/monuments';
import { isConfigured, translate } from '@/lib/sarvam';
import type { Memory, VisualDirective } from '@/lib/types';

import { buildAttribution } from '../_lib/attribution';
import { assertPublishable, pickMemories } from '../_lib/select';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/memories/retrieve   { monument_id, query, lang }
 *
 * `lang` is the LISTENER's language, as detected by Saaras on their first utterance.
 *
 * Returns 1–2 memories, each already turned into something the monument can say:
 *
 *   sameLanguage  — the listener speaks what the visitor spoke, so they get the
 *                   ORIGINAL AUDIO. Someone else's actual voice, not a synthesis of it.
 *   otherwise     — the clean transcript is translated into the listener's language and
 *                   handed to the voice lane to speak, prefaced by the monument itself.
 *
 * When Sarvam is unreachable this route still answers: it serves the stored transcript
 * as spokenText with playbackUrl null, so a seeded wall demos with no key at all. The
 * listener is never told a translation happened when it did not.
 *
 * The visual directive is the point of the whole lane: grade 'sepia', no focus change,
 * no era change. The photograph should look like it is remembering too.
 */

const SEPIA: VisualDirective = { focus: null, grade: 'sepia', era: null };

interface RetrievedMemory {
  id: string;
  lang: string;
  city: string | null;
  created_at: string;
  sameLanguage: boolean;
  playbackUrl: string | null;
  spokenText: string;
  attribution: string;
}

export async function POST(req: Request) {
  const started = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      monument_id?: string;
      query?: string;
      lang?: string;
    };

    const monumentId = body.monument_id?.trim() || DEFAULT_MONUMENT_ID;
    const query = (body.query ?? '').trim();
    const listener = normalizeLang(body.lang);

    // approvedOnly filters on approved AND consented in both backends.
    const rows = await listMemories({ monument_id: monumentId, approvedOnly: true, limit: 200 });
    const wall = rows.filter((m) => m.approved && m.consented && (m.transcript?.trim() || m.verbatim?.trim()));

    if (wall.length === 0) {
      return NextResponse.json({ memories: [], directive: null });
    }

    const translatedQueries = await translateQuery(query, listener, wall);
    const picks = pickMemories(wall, query, listener, translatedQueries, 2);
    if (picks.length === 0) {
      return NextResponse.json({ memories: [], directive: null });
    }

    const memories: RetrievedMemory[] = [];
    for (const pick of picks) {
      memories.push(await render(assertPublishable(pick.memory), listener));
    }

    await logEvent('memory_retrieved', {
      monument_id: monumentId,
      listener_lang: listener,
      count: memories.length,
      match: picks[0].match,
      same_language: memories.filter((m) => m.sameLanguage).length,
      with_original_audio: memories.filter((m) => m.playbackUrl).length,
      latency_ms: Date.now() - started,
    });

    return NextResponse.json({ memories, directive: SEPIA });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

/**
 * A Tamil question shares no characters with a Bengali memory, so the lexical ranker
 * needs the question restated in each language on the wall. Cheap: at most four calls,
 * all hitting lib/sarvam's translate cache after the first visitor asks.
 */
async function translateQuery(query: string, listener: string, wall: Memory[]): Promise<string[]> {
  if (!query || !isConfigured()) return [];
  const others = [...new Set(wall.map((m) => normalizeLang(m.lang)))].filter((l) => l !== listener).slice(0, 4);
  if (others.length === 0) return [];

  const settled = await Promise.allSettled(others.map((l) => translate(query, l, { from: listener })));
  const out: string[] = [];
  for (const r of settled) if (r.status === 'fulfilled' && r.value.trim()) out.push(r.value.trim());
  if (out.length === 0 && settled.some((r) => r.status === 'rejected')) {
    console.warn('[echo] cross-language query translation failed; ranking on the raw query only.');
  }
  return out;
}

async function render(memory: Memory, listener: string): Promise<RetrievedMemory> {
  const spoken = normalizeLang(memory.lang);
  const sameLanguage = spoken === listener;

  let text = (memory.transcript || memory.verbatim || '').trim();

  if (!sameLanguage && isConfigured()) {
    try {
      // Colloquial (mayura) rather than formal: a retold memory should not read
      // like a government notice.
      const t = await translate(text, listener, { from: spoken, colloquial: true });
      if (t.trim()) text = t.trim();
    } catch (err) {
      console.warn('[echo] memory translation failed, speaking the original text:', (err as Error).message);
      await logEvent('memory_translate_failed', {
        memory_id: memory.id,
        from: spoken,
        to: listener,
        reason: (err as Error).message.slice(0, 160),
      });
    }
  }

  const { attribution, preface } = await buildAttribution({
    spokenLang: spoken,
    listenerLang: listener,
    city: memory.city,
    createdAt: memory.created_at,
  });

  return {
    id: memory.id,
    lang: spoken,
    city: memory.city,
    created_at: memory.created_at,
    sameLanguage,
    // The original voice, only ever to someone who can actually understand it.
    playbackUrl: sameLanguage ? memory.audio_url : null,
    spokenText: `${preface} ${text}`.trim(),
    attribution,
  };
}
