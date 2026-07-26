'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * /admin — the human in the loop.
 *
 * Nothing a visitor records reaches another visitor until someone here presses a
 * button. The screen is built for that one act and nothing else: the verbatim record
 * beside the clean transcript (that difference is how you tell a real memory from a
 * microphone test in two seconds), the automatic verdict and why, and two buttons.
 *
 * The token is entered once and kept in sessionStorage — it dies with the tab. It is
 * sent as `x-bol-admin` on every request and never put in a URL.
 *
 * Memories from visitors who did not consent appear in the counts but their words are
 * not shown, here or anywhere. Consent was not given for storage and playback; it was
 * not withheld from visitors only.
 */

interface Verdict {
  verdict: 'ok' | 'abuse' | 'personal_data' | 'irrelevant' | 'unreviewed';
  reason: string;
  model: string | null;
  degraded: boolean;
  at: string;
}

interface AdminRow {
  id: string;
  monument_id: string;
  lang: string;
  langLabel: { native: string; english: string };
  city: string | null;
  created_at: string;
  consented: boolean;
  approved: boolean;
  redacted: boolean;
  transcript: string | null;
  verbatim: string | null;
  audio_url: string | null;
  moderation: Verdict | null;
}

interface ListResponse {
  monument_id: string;
  backend: string;
  counts: { total: number; pending: number; approved: number; unconsented: number };
  memories: AdminRow[];
}

const VERDICT_STYLE: Record<Verdict['verdict'], string> = {
  ok: 'border-emerald-400/40 bg-emerald-950/40 text-emerald-100',
  abuse: 'border-red-400/40 bg-red-950/40 text-red-100',
  personal_data: 'border-amber-400/40 bg-amber-950/40 text-amber-100',
  irrelevant: 'border-slate-400/30 bg-slate-900/50 text-slate-200',
  unreviewed: 'border-sandstone-400/40 bg-sandstone-900/50 text-sandstone-100',
};

const VERDICT_LABEL: Record<Verdict['verdict'], string> = {
  ok: 'ok',
  abuse: 'abuse',
  personal_data: 'personal data',
  irrelevant: 'irrelevant',
  unreviewed: 'not screened',
};

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [entered, setEntered] = useState(false);
  const [monumentId, setMonumentId] = useState('qutub-minar');
  const [pendingOnly, setPendingOnly] = useState(true);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem('bol-admin-token');
    if (saved) {
      setToken(saved);
      setEntered(true);
    }
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const url = `/api/memories/list?monument_id=${encodeURIComponent(monumentId)}${pendingOnly ? '&pending=1' : ''}`;
      const res = await fetch(url, { headers: { 'x-bol-admin': token }, cache: 'no-store' });
      const body = (await res.json()) as ListResponse & { error?: string };
      if (!res.ok) {
        setError(body?.error ?? `Request failed (${res.status})`);
        setData(null);
        if (res.status === 401) {
          sessionStorage.removeItem('bol-admin-token');
          setEntered(false);
        }
        return;
      }
      setData(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [monumentId, pendingOnly, token]);

  useEffect(() => {
    if (entered) void load();
  }, [entered, load]);

  const decide = useCallback(
    async (id: string, approved: boolean) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch('/api/memories/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-bol-admin': token },
          body: JSON.stringify({ id, approved, monument_id: monumentId }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(body?.error ?? `Could not update (${res.status})`);
          return;
        }
        setData((prev) =>
          prev
            ? {
                ...prev,
                memories: prev.memories.map((m) => (m.id === id ? { ...m, approved } : m)),
                counts: {
                  ...prev.counts,
                  approved: prev.counts.approved + (approved ? 1 : -1),
                  pending: prev.counts.pending + (approved ? -1 : 1),
                },
              }
            : prev,
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [monumentId, token],
  );

  if (!entered) {
    return (
      <main className="fixed inset-0 grid place-items-center overflow-y-auto bg-night-900 p-6">
        <form
          className="bol-glass w-full max-w-sm space-y-3 p-5 text-sandstone-100"
          onSubmit={(e) => {
            e.preventDefault();
            if (!token.trim()) return;
            sessionStorage.setItem('bol-admin-token', token.trim());
            setEntered(true);
          }}
        >
          <h1 className="text-base font-medium">Echo wall — moderation</h1>
          <p className="text-xs leading-relaxed text-sandstone-200/70">
            Enter the shared admin token (<code>BOL_ADMIN_TOKEN</code>). It is kept for this tab only.
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-sandstone-300/60"
            placeholder="token"
          />
          <button type="submit" className="w-full rounded-lg bg-sandstone-500 px-4 py-2 text-sm font-medium text-night-950">
            Open the queue
          </button>
          {error && <p className="text-xs text-red-300">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 overflow-y-auto bg-night-900 px-4 py-6 text-sandstone-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-medium">Echo wall — moderation</h1>
            {data && (
              <p className="mt-1 text-xs text-sandstone-200/70">
                {data.counts.pending} waiting · {data.counts.approved} live · {data.counts.total} total
                {data.counts.unconsented > 0 && <> · {data.counts.unconsented} without consent (hidden)</>} ·{' '}
                <span className="opacity-60">store: {data.backend}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <input
              value={monumentId}
              onChange={(e) => setMonumentId(e.target.value)}
              className="w-36 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 outline-none focus:border-sandstone-300/60"
              aria-label="Monument id"
            />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={pendingOnly}
                onChange={(e) => setPendingOnly(e.target.checked)}
                className="h-3.5 w-3.5 accent-sandstone-400"
              />
              pending only
            </label>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-white/15 px-2.5 py-1.5 hover:bg-white/5"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </header>

        {error && (
          <p role="alert" className="rounded-xl border border-red-400/30 bg-red-950/30 px-3 py-2 text-xs text-red-100">
            {error}
          </p>
        )}

        {data && data.memories.length === 0 && (
          <p className="bol-glass p-6 text-center text-sm text-sandstone-200/70">
            {pendingOnly ? 'Nothing waiting. The queue is empty.' : 'No memories on this wall yet.'}
          </p>
        )}

        {data?.memories.map((m) => (
          <article key={m.id} className="bol-glass space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-sandstone-200/70">
              <span className="bol-chip px-2 py-0.5 text-[10px]">
                {m.langLabel.native} · {m.langLabel.english}
              </span>
              {m.city && <span>{m.city}</span>}
              <span>{new Date(m.created_at).toLocaleString()}</span>
              <span
                className={`rounded-full border px-2 py-0.5 ${
                  VERDICT_STYLE[m.moderation?.verdict ?? 'unreviewed']
                }`}
                title={m.moderation?.reason ?? 'No automatic screening on record.'}
              >
                {VERDICT_LABEL[m.moderation?.verdict ?? 'unreviewed']}
              </span>
              {m.approved && <span className="rounded-full border border-emerald-400/40 px-2 py-0.5 text-emerald-200">live</span>}
              {!m.consented && (
                <span className="rounded-full border border-red-400/40 px-2 py-0.5 text-red-200">no consent</span>
              )}
            </div>

            {m.moderation && (
              <p className="text-[11px] leading-relaxed text-sandstone-200/60">
                {m.moderation.reason}
                {m.moderation.model && <span className="opacity-60"> · {m.moderation.model}</span>}
                {m.moderation.degraded && <span className="text-amber-200/80"> · screening degraded, judge it yourself</span>}
              </p>
            )}

            {m.redacted ? (
              <p className="rounded-lg border border-red-400/25 bg-red-950/20 p-3 text-xs leading-relaxed text-red-100/90">
                This visitor did not consent. The recording was never stored and the words are not shown — not to
                visitors and not here. It cannot be approved.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-[10px] uppercase tracking-wider text-sandstone-200/50">
                    verbatim — what was actually said
                  </h3>
                  <p className="indic-text rounded-lg bg-black/30 p-3 text-[13px] leading-relaxed">{m.verbatim || '—'}</p>
                </div>
                <div>
                  <h3 className="mb-1 text-[10px] uppercase tracking-wider text-sandstone-200/50">
                    clean — what retrieval indexes
                  </h3>
                  <p className="indic-text rounded-lg bg-black/20 p-3 text-[13px] leading-relaxed">{m.transcript || '—'}</p>
                </div>
              </div>
            )}

            {m.audio_url && <audio src={m.audio_url} controls preload="none" className="w-full" />}

            <div className="flex gap-2">
              <button
                type="button"
                disabled={busyId === m.id || m.approved || m.redacted}
                onClick={() => void decide(m.id, true)}
                className="rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-medium text-night-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-sandstone-200/40"
              >
                {m.approved ? 'Approved' : 'Approve'}
              </button>
              <button
                type="button"
                disabled={busyId === m.id || !m.approved}
                onClick={() => void decide(m.id, false)}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                Take down
              </button>
              <span className="ml-auto self-center font-mono text-[10px] text-sandstone-200/30">{m.id.slice(0, 8)}</span>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
