import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BolEvent, ConservationReport, Memory, Session, Turn } from './types';

/**
 * One repository surface, two backends.
 *
 * Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set. Otherwise a
 * file-backed JSON store under .data/ so the app boots and demos with zero
 * infrastructure. The fallback is deliberate: on demo day a database outage
 * must not be able to take the experience down, and `npm run dev` on a fresh
 * clone must just work.
 *
 * The fallback is single-process and not durable across Vercel lambda instances.
 * Set the Supabase env vars in production — /api/health reports which backend is live.
 */

export type Backend = 'supabase' | 'file';

let _client: SupabaseClient | null = null;

export function backend(): Backend {
  return process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'file';
}

export function supabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// File fallback
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.BOL_DATA_DIR ?? path.join(process.cwd(), '.data');

interface FileStore {
  sessions: Session[];
  turns: Turn[];
  memories: Memory[];
  reports: ConservationReport[];
  events: BolEvent[];
}

const EMPTY: FileStore = { sessions: [], turns: [], memories: [], reports: [], events: [] };
let memoryStore: FileStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadStore(): Promise<FileStore> {
  if (memoryStore) return memoryStore;
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'store.json'), 'utf8');
    memoryStore = { ...EMPTY, ...(JSON.parse(raw) as Partial<FileStore>) };
  } catch {
    memoryStore = structuredClone(EMPTY);
  }
  return memoryStore;
}

/** Serialised writes — concurrent requests must not interleave read-modify-write. */
function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    if (!memoryStore) return;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, 'store.json'), JSON.stringify(memoryStore, null, 2), 'utf8');
    } catch (err) {
      // Read-only FS (Vercel). In-memory store still serves the request.
      if ((err as NodeJS.ErrnoException).code !== 'EROFS' && (err as NodeJS.ErrnoException).code !== 'EACCES') {
        console.warn('[db] persist failed:', (err as Error).message);
      }
    }
  });
  return writeQueue;
}

async function fileInsert<T extends { id: string }>(table: keyof FileStore, row: T): Promise<T> {
  const store = await loadStore();
  (store[table] as unknown as T[]).unshift(row);
  void persist();
  return row;
}

// ---------------------------------------------------------------------------
// Public repository API — every feature uses these, never raw SQL.
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

export async function createSession(input: {
  monument_id: string;
  detected_lang?: string | null;
  user_agent?: string | null;
}): Promise<Session> {
  const row: Session = {
    id: randomUUID(),
    monument_id: input.monument_id,
    detected_lang: (input.detected_lang as Session['detected_lang']) ?? null,
    started_at: nowIso(),
    user_agent: input.user_agent ?? null,
  };
  if (backend() === 'supabase') {
    const { data, error } = await supabase().from('sessions').insert(row).select().single();
    if (error) throw new Error(`createSession: ${error.message}`);
    return data as Session;
  }
  return fileInsert('sessions', row);
}

/** The first utterance sets the session language. Never asked, always detected. */
export async function setSessionLang(sessionId: string, lang: string): Promise<void> {
  if (backend() === 'supabase') {
    await supabase().from('sessions').update({ detected_lang: lang }).eq('id', sessionId);
    return;
  }
  const store = await loadStore();
  const s = store.sessions.find((x) => x.id === sessionId);
  if (s) {
    s.detected_lang = lang as Session['detected_lang'];
    void persist();
  }
}

export async function logTurn(input: {
  session_id: string;
  role: 'visitor' | 'monument';
  text: string;
  lang?: string | null;
  latency_ms?: number | null;
}): Promise<Turn> {
  const row: Turn = {
    id: randomUUID(),
    session_id: input.session_id,
    role: input.role,
    text: input.text,
    lang: (input.lang as Turn['lang']) ?? null,
    latency_ms: input.latency_ms ?? null,
    created_at: nowIso(),
  };
  if (backend() === 'supabase') {
    const { data, error } = await supabase().from('turns').insert(row).select().single();
    if (error) throw new Error(`logTurn: ${error.message}`);
    return data as Turn;
  }
  return fileInsert('turns', row);
}

export async function logEvent(kind: string, payload: Record<string, unknown> = {}, sessionId?: string | null): Promise<void> {
  const row: BolEvent = {
    id: randomUUID(),
    session_id: sessionId ?? null,
    kind,
    payload,
    created_at: nowIso(),
  };
  try {
    if (backend() === 'supabase') {
      await supabase().from('events').insert(row);
      return;
    }
    await fileInsert('events', row);
  } catch (err) {
    // Analytics must never break the experience.
    console.warn('[db] logEvent failed:', (err as Error).message);
  }
}

export async function insertMemory(input: Omit<Memory, 'id' | 'created_at'>): Promise<Memory> {
  const row: Memory = { ...input, id: randomUUID(), created_at: nowIso() };
  if (backend() === 'supabase') {
    const { data, error } = await supabase().from('memories').insert(row).select().single();
    if (error) throw new Error(`insertMemory: ${error.message}`);
    return data as Memory;
  }
  return fileInsert('memories', row);
}

export async function listMemories(opts: {
  monument_id: string;
  approvedOnly?: boolean;
  limit?: number;
}): Promise<Memory[]> {
  const { monument_id, approvedOnly = true, limit = 100 } = opts;
  if (backend() === 'supabase') {
    let q = supabase().from('memories').select('*').eq('monument_id', monument_id).order('created_at', { ascending: false }).limit(limit);
    if (approvedOnly) q = q.eq('approved', true).eq('consented', true);
    const { data, error } = await q;
    if (error) throw new Error(`listMemories: ${error.message}`);
    return (data ?? []) as Memory[];
  }
  const store = await loadStore();
  return store.memories
    .filter((m) => m.monument_id === monument_id && (!approvedOnly || (m.approved && m.consented)))
    .slice(0, limit);
}

export async function approveMemory(id: string, approved: boolean): Promise<void> {
  if (backend() === 'supabase') {
    const { error } = await supabase().from('memories').update({ approved }).eq('id', id);
    if (error) throw new Error(`approveMemory: ${error.message}`);
    return;
  }
  const store = await loadStore();
  const m = store.memories.find((x) => x.id === id);
  if (m) {
    m.approved = approved;
    void persist();
  }
}

export async function insertReport(input: Omit<ConservationReport, 'id' | 'created_at'>): Promise<ConservationReport> {
  const row: ConservationReport = { ...input, id: randomUUID(), created_at: nowIso() };
  if (backend() === 'supabase') {
    const { data, error } = await supabase().from('reports').insert(row).select().single();
    if (error) throw new Error(`insertReport: ${error.message}`);
    return data as ConservationReport;
  }
  return fileInsert('reports', row);
}

export async function listReports(monument_id?: string, limit = 100): Promise<ConservationReport[]> {
  if (backend() === 'supabase') {
    let q = supabase().from('reports').select('*').order('created_at', { ascending: false }).limit(limit);
    if (monument_id) q = q.eq('monument_id', monument_id);
    const { data, error } = await q;
    if (error) throw new Error(`listReports: ${error.message}`);
    return (data ?? []) as ConservationReport[];
  }
  const store = await loadStore();
  return store.reports.filter((r) => !monument_id || r.monument_id === monument_id).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Dashboard aggregates. Real rows only — a judge will spot-check these.
// ---------------------------------------------------------------------------

export interface LiveStats {
  backend: Backend;
  sessionsLastHour: number;
  languages: { code: string; count: number }[];
  questions: number;
  memories: number;
  reports: number;
  rupees: number;
  recent: { text: string; lang: string | null; at: string }[];
  generatedAt: string;
}

export async function liveStats(monumentId?: string): Promise<LiveStats> {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();

  if (backend() === 'supabase') {
    const sb = supabase();
    const [sessions, turnsRes, memoriesRes, reportsRes, donationsRes] = await Promise.all([
      sb.from('sessions').select('id, detected_lang, started_at').gte('started_at', hourAgo),
      sb.from('turns').select('text, lang, created_at').eq('role', 'visitor').order('created_at', { ascending: false }).limit(10),
      sb.from('memories').select('id', { count: 'exact', head: true }).eq('consented', true),
      sb.from('reports').select('id', { count: 'exact', head: true }),
      sb.from('events').select('payload').eq('kind', 'donation_paid'),
    ]);

    const rows = sessions.data ?? [];
    const langCounts = tally(rows.map((r) => (r as any).detected_lang));
    const { count: questions } = await sb
      .from('turns')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'visitor');

    return {
      backend: 'supabase',
      sessionsLastHour: rows.length,
      languages: langCounts,
      questions: questions ?? 0,
      memories: memoriesRes.count ?? 0,
      reports: reportsRes.count ?? 0,
      rupees: (donationsRes.data ?? []).reduce((n, e: any) => n + Number(e?.payload?.amount ?? 0), 0),
      recent: (turnsRes.data ?? []).map((t: any) => ({ text: t.text, lang: t.lang, at: t.created_at })),
      generatedAt: nowIso(),
    };
  }

  const store = await loadStore();
  const scoped = <T extends { monument_id?: string }>(rows: T[]) =>
    monumentId ? rows.filter((r) => r.monument_id === monumentId) : rows;

  const recentSessions = scoped(store.sessions).filter((s) => s.started_at >= hourAgo);
  const visitorTurns = store.turns.filter((t) => t.role === 'visitor');

  return {
    backend: 'file',
    sessionsLastHour: recentSessions.length,
    languages: tally(recentSessions.map((s) => s.detected_lang)),
    questions: visitorTurns.length,
    memories: scoped(store.memories).filter((m) => m.consented).length,
    reports: scoped(store.reports).length,
    rupees: store.events
      .filter((e) => e.kind === 'donation_paid')
      .reduce((n, e) => n + Number((e.payload as any)?.amount ?? 0), 0),
    recent: visitorTurns.slice(0, 10).map((t) => ({ text: t.text, lang: t.lang, at: t.created_at })),
    generatedAt: nowIso(),
  };
}

function tally(values: (string | null | undefined)[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

/**
 * Wait for every queued file-store write to reach disk.
 *
 * `logEvent` and friends deliberately do NOT await `persist()` — analytics must
 * never sit in the latency budget of a voice turn. The cost is that a reader
 * hitting store.json immediately after a write can miss it, which made the
 * language suite flake at roughly one run in eight: eight event assertions
 * failing together with "0 lang_switch events", then passing on a re-run.
 *
 * Anything that reads the store directly rather than through this module must
 * await this first. Production never needs it; test harnesses always do.
 */
export async function flushStore(): Promise<void> {
  // Two turns: the second awaits any write that the first one's completion queued.
  await writeQueue;
  await writeQueue;
}

/** Used by scripts/seed.ts and the demo reset key. */
export async function resetFileStore(): Promise<void> {
  memoryStore = structuredClone(EMPTY);
  await persist();
}
