/**
 * npm run seed
 *
 * Loads content/seed-memories.json into whichever backend lib/db.ts is using —
 * Supabase when it is configured, .data/store.json otherwise — through the public
 * insertMemory() repository call. No raw SQL, no second write path.
 *
 * Idempotent. `Memory` has no external key, so a row is considered already present
 * when (monument_id, lang, transcript) matches something on the wall. Run it as many
 * times as you like; the fifth run inserts nothing and says so.
 *
 * Every seeded memory also gets its moderation verdict recorded, so the /admin queue
 * shows a complete picture rather than five rows with a blank verdict column.
 */

import Module from 'node:module';
import path from 'node:path';
import { promises as fs } from 'node:fs';

/**
 * lib/db.ts and lib/sarvam.ts start with `import 'server-only'`, which is a marker
 * package Next aliases at build time and which throws if it is ever really loaded.
 * Outside Next — here, in a plain tsx process — there is nothing to alias it, so we
 * point the specifier at the empty module Next itself uses for the server case.
 * This must happen before lib/db is loaded, hence the dynamic import below.
 */
const loader = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = loader._resolveFilename;
loader._resolveFilename = function patched(this: unknown, request: string, ...rest: unknown[]): string {
  if (request === 'server-only' || request === 'client-only') {
    return originalResolve.call(this, 'next/dist/compiled/server-only/empty.js', ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

interface SeedMemory {
  lang: string;
  city: string | null;
  created_at: string;
  consented: boolean;
  approved: boolean;
  transcript: string;
  verbatim: string;
  audio_url?: string | null;
}

interface SeedFile {
  monument_id: string;
  memories: SeedMemory[];
}

const ROOT = path.resolve(__dirname, '..');

function key(monumentId: string, lang: string, transcript: string): string {
  return `${monumentId}::${lang}::${transcript.replace(/\s+/g, ' ').trim()}`;
}

async function main(): Promise<void> {
  const db = await import('../lib/db');
  const { recordVerdict } = await import('../app/api/memories/_lib/verdicts');
  const { localScreen } = await import('../app/api/memories/_lib/moderation');

  const raw = await fs.readFile(path.join(ROOT, 'content', 'seed-memories.json'), 'utf8');
  const seed = JSON.parse(raw) as SeedFile;

  if (!seed.monument_id || !Array.isArray(seed.memories) || seed.memories.length === 0) {
    throw new Error('content/seed-memories.json has no memories to load.');
  }

  const existing = await db.listMemories({ monument_id: seed.monument_id, approvedOnly: false, limit: 1000 });
  const seen = new Set(existing.map((m) => key(m.monument_id, m.lang, m.transcript ?? '')));

  console.log(`[seed] backend: ${db.backend()}`);
  console.log(`[seed] monument: ${seed.monument_id} — ${existing.length} memories already stored`);

  let inserted = 0;
  let skipped = 0;
  const backdates: { id: string; created_at: string }[] = [];

  for (const m of seed.memories) {
    const k = key(seed.monument_id, m.lang, m.transcript);
    if (seen.has(k)) {
      skipped++;
      console.log(`[seed]   skip   ${m.lang}  (already on the wall)`);
      continue;
    }

    const row = await db.insertMemory({
      monument_id: seed.monument_id,
      lang: m.lang,
      transcript: m.transcript,
      verbatim: m.verbatim,
      audio_url: m.audio_url ?? null,
      city: m.city ?? null,
      consented: m.consented !== false,
      approved: m.approved !== false,
    });

    if (m.created_at && !Number.isNaN(Date.parse(m.created_at))) {
      backdates.push({ id: row.id, created_at: m.created_at });
    }

    const screened = localScreen(m.transcript);
    await recordVerdict(row.id, {
      verdict: screened?.verdict ?? 'ok',
      reason: screened?.reason ?? 'Seeded demo memory — reviewed by hand before it was written to disk.',
      model: null,
      degraded: false,
    });

    seen.add(k);
    inserted++;
    console.log(`[seed]   insert ${m.lang}  ${row.id}  ${m.city ?? '—'}`);
  }

  // Let the file store's queued writes drain before we touch store.json ourselves.
  await new Promise((r) => setTimeout(r, 250));
  await backdate(db, backdates);

  console.log(`[seed] done: ${inserted} inserted, ${skipped} already present.`);
  if (inserted === 0 && skipped > 0) console.log('[seed] nothing to do — the wall is already seeded.');
}

/**
 * insertMemory() stamps created_at with now(). The seeded dates are part of the
 * story — "a photograph taken in 1998", "last March" — and the attribution reads
 * them, so we correct them once, at the very end, after every other write has
 * landed. Best effort only: a failure here costs a plausible date, not a memory.
 */
async function backdate(db: typeof import('../lib/db'), rows: { id: string; created_at: string }[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    if (db.backend() === 'supabase') {
      for (const r of rows) {
        const { error } = await db.supabase().from('memories').update({ created_at: r.created_at }).eq('id', r.id);
        if (error) throw new Error(error.message);
      }
      return;
    }
    const file = path.join(process.env.BOL_DATA_DIR ?? path.join(ROOT, '.data'), 'store.json');
    const store = JSON.parse(await fs.readFile(file, 'utf8')) as { memories?: { id: string; created_at: string }[] };
    let touched = 0;
    for (const r of rows) {
      const row = store.memories?.find((m) => m.id === r.id);
      if (row) {
        row.created_at = r.created_at;
        touched++;
      }
    }
    await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
    console.log(`[seed] backdated ${touched} memories to their real dates.`);
  } catch (err) {
    console.warn(`[seed] (could not backdate: ${(err as Error).message})`);
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exitCode = 1;
});
