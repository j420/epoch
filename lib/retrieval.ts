/**
 * Retrieval over monument sources and visitor memories.
 *
 * Constraint 4 is absolute: every factual claim must come from a retrieved chunk,
 * and if nothing relevant comes back the monument says it does not remember.
 * That means retrieval must be able to return NOTHING. A ranker that always
 * returns its top 3 no matter how bad the match will make the monument
 * hallucinate confidently, so we score, then threshold.
 *
 * The scorer is a character-n-gram TF-IDF cosine. Character n-grams rather than
 * words because the corpus is English while queries arrive in 22 languages and
 * a dozen scripts — word tokenisation would be useless and we would need a
 * different tokenizer per script. N-grams also survive transliteration and
 * code-mixing ("Qutub kitna purana hai"), which is exactly what Saaras hands us
 * in codemix mode.
 *
 * `embed` is pluggable: swap in a real embedding model by calling
 * setEmbedder() and rank() will use it instead, with the same thresholding.
 */

import type { SourceChunk } from './types';

// ---------------------------------------------------------------------------
// Vectorisation
// ---------------------------------------------------------------------------

const NGRAM = 3;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ngrams(text: string, n = NGRAM): string[] {
  const s = ` ${normalize(text)} `;
  if (s.length <= n) return [s];
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  // Whole words too — they carry more signal than any single trigram.
  for (const w of normalize(text).split(' ')) if (w.length > 2) out.push(`#${w}`);
  return out;
}

type Vec = Map<string, number>;

function termFreq(text: string): Vec {
  const v: Vec = new Map();
  for (const g of ngrams(text)) v.set(g, (v.get(g) ?? 0) + 1);
  return v;
}

function cosine(a: Vec, b: Vec, idf: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, va] of a) {
    const w = idf.get(k) ?? 1;
    const x = va * w;
    na += x * x;
    const vb = b.get(k);
    if (vb !== undefined) dot += x * vb * w;
  }
  for (const [k, vb] of b) {
    const w = idf.get(k) ?? 1;
    const y = vb * w;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface Ranked<T> {
  item: T;
  score: number;
}

export class TextIndex<T> {
  private vecs: Vec[] = [];
  private idf = new Map<string, number>();

  constructor(
    private readonly items: T[],
    private readonly textOf: (item: T) => string,
  ) {
    this.vecs = items.map((i) => termFreq(textOf(i)));
    const df = new Map<string, number>();
    for (const v of this.vecs) for (const k of v.keys()) df.set(k, (df.get(k) ?? 0) + 1);
    const N = Math.max(1, this.vecs.length);
    for (const [k, d] of df) this.idf.set(k, Math.log(1 + N / d));
  }

  /**
   * @param minScore Below this, a chunk is treated as irrelevant and NOT returned.
   *                 0.06 is tuned so an off-topic question ("what is the wifi password")
   *                 returns nothing at all rather than the least-bad chunk.
   */
  search(query: string, topK = 3, minScore = 0.06): Ranked<T>[] {
    if (!query.trim() || this.items.length === 0) return [];
    const q = termFreq(query);
    // Query terms unseen in the corpus get an IDF so they still contribute.
    const idf = new Map(this.idf);
    for (const k of q.keys()) if (!idf.has(k)) idf.set(k, Math.log(1 + this.items.length));

    return this.items
      .map((item, i) => ({ item, score: cosine(q, this.vecs[i], idf) }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// Optional real embeddings
// ---------------------------------------------------------------------------

export type Embedder = (texts: string[]) => Promise<number[][]>;
let embedder: Embedder | null = null;

/** Swap the lexical ranker for a real embedding model without touching callers. */
export function setEmbedder(fn: Embedder | null) {
  embedder = fn;
}

export function hasEmbedder(): boolean {
  return embedder !== null;
}

function dot(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

// ---------------------------------------------------------------------------
// Monument sources
// ---------------------------------------------------------------------------

const indexCache = new Map<string, TextIndex<SourceChunk>>();

export function sourceIndex(monumentId: string, sources: SourceChunk[]): TextIndex<SourceChunk> {
  let idx = indexCache.get(monumentId);
  if (!idx) {
    idx = new TextIndex(sources, (s) => s.text);
    indexCache.set(monumentId, idx);
  }
  return idx;
}

export interface RetrievalResult {
  chunks: SourceChunk[];
  scores: number[];
  /** True when nothing cleared the threshold — the monument must admit ignorance. */
  empty: boolean;
}

export async function retrieveSources(
  monumentId: string,
  sources: SourceChunk[],
  query: string,
  topK = 3,
  minScore = 0.06,
): Promise<RetrievalResult> {
  if (embedder) {
    try {
      const [qv, ...svs] = await embedder([query, ...sources.map((s) => s.text)]);
      const ranked = sources
        .map((s, i) => ({ item: s, score: dot(qv, svs[i]) }))
        .filter((r) => r.score >= 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { chunks: ranked.map((r) => r.item), scores: ranked.map((r) => r.score), empty: ranked.length === 0 };
    } catch (err) {
      console.warn('[retrieval] embedder failed, falling back to lexical:', (err as Error).message);
    }
  }

  const ranked = sourceIndex(monumentId, sources).search(query, topK, minScore);
  return { chunks: ranked.map((r) => r.item), scores: ranked.map((r) => r.score), empty: ranked.length === 0 };
}

/** Renders retrieved chunks into the numbered SOURCES block the system prompt expects. */
export function formatSources(chunks: SourceChunk[]): string {
  if (chunks.length === 0) return '(no sources retrieved — you do not remember this)';
  return chunks.map((c, i) => `[${i + 1}] ${c.text}\n    — ${c.citation}`).join('\n');
}
