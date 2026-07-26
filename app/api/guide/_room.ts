import 'server-only';

import { randomUUID } from 'node:crypto';
import { detectedChip, normalizeLang, type LangCode } from '@/lib/langs';
import type { DubEngine, VoiceProfile } from '@/lib/dub';

/**
 * Guide-session state: an in-process Map keyed by the 4-digit join code.
 *
 * WHY IN-PROCESS, AND WHAT IT COSTS
 * ---------------------------------
 * The brief called for WebSocket fan-out. Vercel's serverless functions cannot hold
 * a socket, so the lane uses SSE downstream (see the header of lib/dub.ts) and this
 * module as the hub the SSE handlers subscribe to.
 *
 * A Map lives inside one Node process. That is CORRECT for the demo — one guide, one
 * room, one instance — and it has far fewer moving parts than a broker. It is NOT
 * correct for a multi-instance deploy: a listener whose SSE request lands on instance
 * B will never see chunks published on instance A.
 *
 * THE SEAM: everything crosses this boundary through exactly four functions —
 * `publish`, `subscribe`, `chunksSince` and `getRoom`. Swapping the transport for
 * Redis pub/sub or Supabase Realtime means reimplementing those four and nothing
 * else. No route and no page reaches past them into the Map. To make that swap:
 * publish -> PUBLISH on channel `guide:<code>`, subscribe -> SUBSCRIBE, chunksSince
 * -> a capped Redis list, getRoom -> a hash. The shapes below are already the wire
 * format.
 *
 * Set `vercel.json` `maxDuration` and pin the deployment to one region if you keep
 * this as-is; `GUIDE_SSE_MAX_MS` below bounds each connection so EventSource's own
 * reconnect covers the rollover.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface GuideListener {
  id: string;
  lang: LangCode;
  joinedAt: number;
  lastSeen: number;
}

/** One dubbed sentence, addressed to one language. This is the SSE `chunk` payload. */
export interface GuideChunk {
  seq: number;
  lang: LangCode;
  /** The translation the listener is hearing. */
  text: string;
  /** What the guide actually said, in the guide's language. */
  sourceText: string;
  /** data: URL. Null when audio generation failed but we still have the text. */
  audio: string | null;
  mime: string | null;
  engine: DubEngine | 'none';
  /** Voice-model latency for this language, ms. */
  ms: number;
  /** Guide-speech-to-ready wall clock for the whole chunk, ms. */
  totalMs: number;
  /** True when Bulbul had to substitute a related language's voice. */
  voiceDegraded: boolean;
  degradedReason: string | null;
  at: number;
}

export interface GuideStats {
  chunks: number;
  targets: number;
  viaDub: number;
  viaBulbul: number;
  failed: number;
  totalLatencyMs: number;
  bestMs: number | null;
  worstMs: number | null;
}

type Subscriber = {
  id: string;
  /** A concrete language code, or `*` for the guide's monitor view. */
  lang: LangCode | '*';
  onChunk: (chunk: GuideChunk) => void;
  onRoster: (roster: RosterSnapshot) => void;
  onEnd: (stats: GuideStats) => void;
};

export interface RosterSnapshot {
  listeners: number;
  languages: { lang: LangCode; count: number; native: string; english: string }[];
}

export interface GuideRoom {
  code: string;
  /** Row id in the sessions table, so turns and events join up. */
  sessionId: string | null;
  guideLang: LangCode;
  createdAt: number;
  endedAt: number | null;
  consent: {
    at: string;
    transcript: string;
    lang: LangCode;
    /** Length of the consent recording in ms, for the audit line on the badge. */
    ms: number;
    /** Whether Sarvam accepted a reusable speaker handle, vs inline reference audio. */
    registered: boolean;
  } | null;
  voice: VoiceProfile | null;
  listeners: Map<string, GuideListener>;
  /** Capped ring of recent chunks across all languages. Feeds polling + SSE replay. */
  history: GuideChunk[];
  seq: number;
  stats: GuideStats;
  subscribers: Set<Subscriber>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Keep-alive comment interval. Proxies drop an idle response well before 60s. */
export const SSE_PING_MS = 15_000;
/** Bound each SSE connection; EventSource reconnects and Last-Event-ID replays. */
export const GUIDE_SSE_MAX_MS = Number(process.env.GUIDE_SSE_MAX_MS ?? 9 * 60_000);
/** A listener that has neither polled nor held a stream for this long has walked off. */
const LISTENER_TTL_MS = 90_000;
/** Chunks retained per room. Enough for a reconnect to catch up, bounded in memory. */
const HISTORY_LIMIT = 40;
/** Rooms are swept this long after they end, or after going completely idle. */
const ENDED_GRACE_MS = 10 * 60_000;
const IDLE_ROOM_MS = 4 * 60 * 60_000;

// ---------------------------------------------------------------------------
// The Map. Hung off globalThis so Next's dev-mode module reloading does not drop a
// live room mid-demo.
// ---------------------------------------------------------------------------

const store = ((globalThis as any).__bolGuideRooms ??= new Map<string, GuideRoom>()) as Map<string, GuideRoom>;

function emptyStats(): GuideStats {
  return { chunks: 0, targets: 0, viaDub: 0, viaBulbul: 0, failed: 0, totalLatencyMs: 0, bestMs: null, worstMs: null };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Four digits, never leading zero, never colliding with a live room. */
function newCode(): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!store.has(code)) return code;
  }
  throw new Error('Could not allocate a free join code — end some sessions first.');
}

export function createRoom(opts: { guideLang?: string; sessionId?: string | null } = {}): GuideRoom {
  sweep();
  const room: GuideRoom = {
    code: newCode(),
    sessionId: opts.sessionId ?? null,
    guideLang: normalizeLang(opts.guideLang ?? 'hi-IN'),
    createdAt: Date.now(),
    endedAt: null,
    consent: null,
    voice: null,
    listeners: new Map(),
    history: [],
    seq: 0,
    stats: emptyStats(),
    subscribers: new Set(),
  };
  store.set(room.code, room);
  return room;
}

/** THE SEAM: the only read path into session state. */
export function getRoom(code: string | null | undefined): GuideRoom | null {
  if (!code) return null;
  return store.get(code.trim()) ?? null;
}

export function endRoom(code: string): GuideStats | null {
  const room = getRoom(code);
  if (!room) return null;
  room.endedAt = Date.now();
  for (const sub of room.subscribers) {
    try {
      sub.onEnd(room.stats);
    } catch {
      /* a dead connection must not block the others */
    }
  }
  room.subscribers.clear();
  return room.stats;
}

/** Drops stale listeners and finished rooms. Cheap; called on every room mutation. */
export function sweep(now = Date.now()): void {
  for (const [code, room] of store) {
    for (const [id, listener] of room.listeners) {
      if (now - listener.lastSeen > LISTENER_TTL_MS) room.listeners.delete(id);
    }
    const dead = room.endedAt !== null && now - room.endedAt > ENDED_GRACE_MS;
    const idle = now - Math.max(room.createdAt, lastActivity(room)) > IDLE_ROOM_MS;
    if (dead || idle) store.delete(code);
  }
}

function lastActivity(room: GuideRoom): number {
  const lastChunk = room.history.length ? room.history[room.history.length - 1].at : 0;
  let lastSeen = 0;
  for (const l of room.listeners.values()) lastSeen = Math.max(lastSeen, l.lastSeen);
  return Math.max(lastChunk, lastSeen);
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

/**
 * Register a listener under the language Saaras detected from their one sentence.
 * Re-joining with the same id updates the language rather than double-counting —
 * a listener who reconnects on flaky wifi must not inflate the roster.
 */
export function addListener(room: GuideRoom, lang: string, listenerId?: string | null): GuideListener {
  const now = Date.now();
  const id = listenerId?.trim() || randomUUID();
  const existing = room.listeners.get(id);
  const listener: GuideListener = {
    id,
    lang: normalizeLang(lang),
    joinedAt: existing?.joinedAt ?? now,
    lastSeen: now,
  };
  room.listeners.set(id, listener);
  broadcastRoster(room);
  return listener;
}

export function touchListener(room: GuideRoom, listenerId: string | null | undefined): void {
  if (!listenerId) return;
  const listener = room.listeners.get(listenerId);
  if (listener) listener.lastSeen = Date.now();
}

/** Listener languages, most common first. Drives both the roster UI and Dub priority. */
export function languageCounts(room: GuideRoom): { lang: LangCode; count: number; native: string; english: string }[] {
  const counts = new Map<LangCode, number>();
  const cutoff = Date.now() - LISTENER_TTL_MS;
  for (const listener of room.listeners.values()) {
    if (listener.lastSeen < cutoff) continue;
    counts.set(listener.lang, (counts.get(listener.lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([lang, count]) => ({ lang, count, ...detectedChip(lang) }))
    .sort((a, b) => b.count - a.count || a.lang.localeCompare(b.lang));
}

export function roster(room: GuideRoom): RosterSnapshot {
  const languages = languageCounts(room);
  return { listeners: languages.reduce((n, l) => n + l.count, 0), languages };
}

function broadcastRoster(room: GuideRoom): void {
  const snapshot = roster(room);
  for (const sub of room.subscribers) {
    try {
      sub.onRoster(snapshot);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// THE SEAM: publish / subscribe / replay
// ---------------------------------------------------------------------------

/** Assigns the sequence number, records it, and pushes to every matching subscriber. */
export function publish(room: GuideRoom, chunk: Omit<GuideChunk, 'seq' | 'at'>): GuideChunk {
  const full: GuideChunk = { ...chunk, seq: ++room.seq, at: Date.now() };

  room.history.push(full);
  if (room.history.length > HISTORY_LIMIT) room.history.splice(0, room.history.length - HISTORY_LIMIT);

  for (const sub of room.subscribers) {
    if (sub.lang !== '*' && sub.lang !== full.lang) continue;
    try {
      // The guide's monitor view does not need the audio, and it is by far the
      // largest part of the payload. Strip it rather than ship it twice.
      sub.onChunk(sub.lang === '*' ? { ...full, audio: null } : full);
    } catch (err) {
      console.warn('[guide] subscriber threw, dropping it:', (err as Error).message);
      room.subscribers.delete(sub);
    }
  }
  return full;
}

export function subscribe(room: GuideRoom, sub: Omit<Subscriber, 'id'>): () => void {
  const entry: Subscriber = { ...sub, id: randomUUID() };
  room.subscribers.add(entry);
  return () => {
    room.subscribers.delete(entry);
  };
}

/**
 * Replay. Used by the polling fallback and by SSE reconnects carrying Last-Event-ID.
 * `lang` of `*` returns every language with audio stripped, for the guide's monitor.
 */
export function chunksSince(room: GuideRoom, lang: LangCode | '*', since: number): GuideChunk[] {
  return room.history
    .filter((c) => c.seq > since && (lang === '*' || c.lang === lang))
    .map((c) => (lang === '*' ? { ...c, audio: null } : c));
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function recordChunkStats(
  room: GuideRoom,
  outcomes: { ok: boolean; engine: DubEngine | 'none'; ms: number }[],
): void {
  room.stats.chunks += 1;
  for (const o of outcomes) {
    room.stats.targets += 1;
    if (!o.ok) {
      room.stats.failed += 1;
      continue;
    }
    if (o.engine === 'dub') room.stats.viaDub += 1;
    else if (o.engine === 'bulbul') room.stats.viaBulbul += 1;
    room.stats.totalLatencyMs += o.ms;
    room.stats.bestMs = room.stats.bestMs === null ? o.ms : Math.min(room.stats.bestMs, o.ms);
    room.stats.worstMs = room.stats.worstMs === null ? o.ms : Math.max(room.stats.worstMs, o.ms);
  }
}

export interface RoomSummary {
  code: string;
  guideLang: LangCode;
  startedAt: string;
  endedAt: string | null;
  consented: boolean;
  consentAt: string | null;
  listeners: number;
  languages: { lang: LangCode; count: number; native: string; english: string }[];
  seq: number;
  stats: GuideStats & { averageMs: number | null };
}

export function summarise(room: GuideRoom): RoomSummary {
  const snapshot = roster(room);
  const voiced = room.stats.viaDub + room.stats.viaBulbul;
  return {
    code: room.code,
    guideLang: room.guideLang,
    startedAt: new Date(room.createdAt).toISOString(),
    endedAt: room.endedAt ? new Date(room.endedAt).toISOString() : null,
    consented: Boolean(room.consent),
    consentAt: room.consent?.at ?? null,
    listeners: snapshot.listeners,
    languages: snapshot.languages,
    seq: room.seq,
    stats: {
      ...room.stats,
      averageMs: voiced > 0 ? Math.round(room.stats.totalLatencyMs / voiced) : null,
    },
  };
}
