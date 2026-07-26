import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { backend, logEvent, supabase } from '@/lib/db';
import type { Moderation, Verdict } from './moderation';

/**
 * Where the moderation verdict lives.
 *
 * `Memory` in lib/types.ts is frozen and has no verdict column, and lib/schema.sql
 * is not this lane's to change — so the verdict is kept beside the row rather than
 * inside it:
 *
 *   Supabase  -> the existing `events` table, kind = 'memory_moderated'
 *   file      -> .data/moderation.json, owned entirely by this lane
 *
 * Either way every verdict is also written to the shared event stream, so the /live
 * dashboard can count screened contributions without knowing any of this.
 */

export interface StoredVerdict {
  verdict: Verdict;
  reason: string;
  model: string | null;
  degraded: boolean;
  at: string;
}

const FILE = path.join(process.env.BOL_DATA_DIR ?? path.join(process.cwd(), '.data'), 'moderation.json');

let cache: Record<string, StoredVerdict> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<Record<string, StoredVerdict>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8')) as Record<string, StoredVerdict>;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    if (!cache) return;
    try {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      await fs.writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EROFS' && code !== 'EACCES') console.warn('[echo] verdict persist failed:', (err as Error).message);
    }
  });
  return writeQueue;
}

export async function recordVerdict(memoryId: string, m: Moderation): Promise<StoredVerdict> {
  const row: StoredVerdict = {
    verdict: m.verdict,
    reason: m.reason,
    model: m.model,
    degraded: m.degraded,
    at: new Date().toISOString(),
  };

  // Shared event stream, always — this is what /live counts.
  await logEvent('memory_moderated', { memory_id: memoryId, ...row });

  if (backend() === 'file') {
    const store = await load();
    store[memoryId] = row;
    await persist();
  }
  return row;
}

export async function getVerdicts(ids: string[]): Promise<Record<string, StoredVerdict>> {
  if (ids.length === 0) return {};
  const wanted = new Set(ids);

  if (backend() === 'supabase') {
    try {
      const { data, error } = await supabase()
        .from('events')
        .select('payload, created_at')
        .eq('kind', 'memory_moderated')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      const out: Record<string, StoredVerdict> = {};
      for (const row of data ?? []) {
        const p = (row as { payload?: Record<string, unknown> }).payload ?? {};
        const id = typeof p.memory_id === 'string' ? p.memory_id : null;
        if (!id || !wanted.has(id) || out[id]) continue; // newest wins
        out[id] = {
          verdict: (p.verdict as Verdict) ?? 'unreviewed',
          reason: typeof p.reason === 'string' ? p.reason : '',
          model: typeof p.model === 'string' ? p.model : null,
          degraded: Boolean(p.degraded),
          at: typeof p.at === 'string' ? p.at : String((row as { created_at?: string }).created_at ?? ''),
        };
      }
      return out;
    } catch (err) {
      console.warn('[echo] could not read verdicts from events:', (err as Error).message);
      return {};
    }
  }

  const store = await load();
  const out: Record<string, StoredVerdict> = {};
  for (const id of ids) if (store[id]) out[id] = store[id];
  return out;
}
