import 'server-only';

import { normalizeLang } from '@/lib/langs';
import { TextIndex } from '@/lib/retrieval';
import type { Memory } from '@/lib/types';

/**
 * Picking which memories to play back.
 *
 * The hard part is that the question and the memory are almost never in the same
 * script. A Tamil listener asking "இங்கே யாராவது குடும்பத்துடன் வந்திருக்கிறார்களா?"
 * shares not one character with a Bengali memory about a grandmother, so the lexical
 * ranker in lib/retrieval scores it at zero. Two tiers, therefore:
 *
 *   TOPICAL — the query (and, when Sarvam is reachable, machine translations of it
 *             into each language present in the wall) scored against transcript and
 *             verbatim. This is the real similarity match the brief asks for.
 *
 *   RESONANT — when nothing clears the threshold we fall back to the listener's own
 *             language first, then recency. This is not a fudge: this route is only
 *             ever called for MEMORY intent, and "what do people remember here?" has
 *             no topic to match — every memory on the wall is a correct answer to it.
 *
 * The empty case is real and reachable: a monument with no approved, consented
 * memories returns nothing at all, and the voice lane says the wall is still bare.
 */

export type MatchKind = 'topical' | 'resonant';

export interface Pick {
  memory: Memory;
  score: number;
  match: MatchKind;
}

const MIN_SCORE = 0.05;

function textOf(m: Memory): string {
  return `${m.transcript ?? ''} ${m.verbatim ?? ''}`.trim();
}

export function pickMemories(
  memories: Memory[],
  query: string,
  listenerLang: string,
  translatedQueries: string[] = [],
  limit = 2,
): Pick[] {
  if (memories.length === 0) return [];

  const listener = normalizeLang(listenerLang);
  const queries = [query, ...translatedQueries].map((q) => q?.trim()).filter((q): q is string => Boolean(q));

  if (queries.length > 0) {
    const index = new TextIndex(memories, textOf);
    const best = new Map<string, number>();
    for (const q of queries) {
      for (const hit of index.search(q, limit + 3, MIN_SCORE)) {
        const prev = best.get(hit.item.id) ?? 0;
        if (hit.score > prev) best.set(hit.item.id, hit.score);
      }
    }
    if (best.size > 0) {
      const byId = new Map(memories.map((m) => [m.id, m]));
      const topical = [...best.entries()]
        .map(([id, score]) => ({ memory: byId.get(id)!, score, match: 'topical' as const }))
        // A memory the listener can hear in the original voice is worth a nudge.
        .sort((a, b) => {
          const bump = (p: Pick) => p.score + (normalizeLang(p.memory.lang) === listener ? 0.02 : 0);
          return bump(b) - bump(a);
        })
        .slice(0, limit);
      if (topical.length > 0) return topical;
    }
  }

  const resonant = [...memories]
    .sort((a, b) => {
      const same = (m: Memory) => (normalizeLang(m.lang) === listener ? 1 : 0);
      if (same(b) !== same(a)) return same(b) - same(a);
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    })
    .slice(0, limit)
    .map((memory) => ({ memory, score: 0, match: 'resonant' as const }));

  return resonant;
}

/**
 * The last gate before anything is serialised. listMemories() already filters, but
 * consent is not the kind of thing you check once. Anything that reaches a response
 * body passes through here or it does not go out.
 */
export function assertPublishable(m: Memory): Memory {
  if (!m.consented) throw new Error(`Refusing to serve memory ${m.id}: no consent on record.`);
  if (!m.approved) throw new Error(`Refusing to serve memory ${m.id}: not approved by a human.`);
  return m;
}
