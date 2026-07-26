'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { LANGS, normalizeLang } from '@/lib/langs';

/**
 * The public dashboard. No auth, designed to be opened on a judge's own phone
 * while the demo is running.
 *
 * The rule for this page: every number is a count of real rows in the database.
 * Nothing here is seeded, estimated or animated upwards for effect. When a number
 * cannot be read it shows a dash — a zero would be a claim, and a claim we cannot
 * back is exactly what this product refuses to make. The backend the numbers came
 * from and the moment they were computed are printed at the bottom on purpose.
 */

interface LiveData {
  ok: boolean;
  backend?: 'file' | 'supabase';
  sessionsLastHour?: number;
  languages?: { code: string; count: number }[];
  questions?: number;
  memories?: number;
  reports?: number;
  rupees?: number;
  recent?: { text: string; lang: string | null; at: string }[];
  generatedAt?: string;
  error?: string;
  kind?: string;
}

const POLL_MS = 3000;

export default function LivePage() {
  const [data, setData] = useState<LiveData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const res = await fetch('/live/data', { cache: 'no-store', signal: controller.signal });
      const json = (await res.json()) as LiveData;
      if (!res.ok || !json.ok) {
        setError(json.error ?? `The dashboard route answered ${res.status}.`);
      } else {
        setData(json);
        setError(null);
        setFetchedAt(Date.now());
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message || 'Could not reach /live/data.');
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => {
      void poll();
      setTick((t) => t + 1);
    }, POLL_MS);
    return () => {
      clearInterval(id);
      inflight.current?.abort();
    };
  }, [poll]);

  const stale = fetchedAt !== null && Date.now() - fetchedAt > POLL_MS * 3;

  return (
    <main className="fixed inset-0 overflow-y-auto overscroll-contain bg-night-900 text-sandstone-100">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6">
        <Header live={!error && !stale} error={error} tick={tick} />

        <Hero value={data?.sessionsLastHour} label="people talking to a monument, this hour" />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Stat value={data?.questions} label="questions asked" />
          <Stat value={data?.memories} label="memories left" />
          <Stat value={data?.reports} label="damage reports" />
          <Stat value={data?.rupees} label="rupees donated" prefix="₹" />
        </div>

        <Languages languages={data?.languages} loaded={Boolean(data)} />

        <Feed recent={data?.recent} loaded={Boolean(data)} />

        <Footer data={data} error={error} fetchedAt={fetchedAt} stale={stale} />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Header({ live, error, tick }: { live: boolean; error: string | null; tick: number }) {
  return (
    <header className="mb-5 flex items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Bol <span className="text-sandstone-300">live</span>
        </h1>
        <p className="mt-0.5 text-xs text-sandstone-200/60">Real rows only. Refreshed every 3 seconds.</p>
      </div>
      <span className="bol-chip" aria-live="polite">
        <span
          key={tick}
          className={`h-2 w-2 rounded-full ${live ? 'animate-breathe bg-emerald-400' : 'bg-red-400'}`}
          aria-hidden
        />
        {error ? 'no data' : live ? 'live' : 'stale'}
      </span>
    </header>
  );
}

function Hero({ value, label }: { value: number | undefined; label: string }) {
  return (
    <section className="bol-glass px-5 py-6">
      <div className="text-[4.25rem] font-semibold leading-none tracking-tighter tabular-nums text-sandstone-50">
        {fmt(value)}
      </div>
      <div className="mt-2 text-sm text-sandstone-200/75">{label}</div>
    </section>
  );
}

function Stat({ value, label, prefix = '' }: { value: number | undefined; label: string; prefix?: string }) {
  const shown = fmt(value);
  return (
    <div className="bol-glass px-4 py-4">
      <div className="text-3xl font-semibold leading-none tabular-nums text-sandstone-50">
        {shown === '—' ? shown : `${prefix}${shown}`}
      </div>
      <div className="mt-1.5 text-xs text-sandstone-200/70">{label}</div>
    </div>
  );
}

function Languages({ languages, loaded }: { languages: { code: string; count: number }[] | undefined; loaded: boolean }) {
  const total = (languages ?? []).reduce((n, l) => n + l.count, 0);

  return (
    <section className="bol-glass mt-3 px-4 py-4">
      <h2 className="text-xs uppercase tracking-[0.14em] text-sandstone-200/60">
        Languages detected — never chosen
      </h2>

      {!loaded ? (
        <p className="mt-3 text-sm text-sandstone-200/50">—</p>
      ) : (languages ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-sandstone-200/50">
          No sessions in the last hour yet. This list fills itself the moment somebody speaks.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {(languages ?? []).map((l) => {
            const meta = LANGS[normalizeLang(l.code)];
            const pct = total > 0 ? Math.round((l.count / total) * 100) : 0;
            return (
              <li key={l.code}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="indic-text text-lg text-sandstone-50">{meta?.native ?? l.code}</span>
                  <span className="text-xs text-sandstone-200/60">
                    {meta?.english ?? l.code} · <span className="tabular-nums text-sandstone-100">{l.count}</span>
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-sandstone-300" style={{ width: `${Math.max(pct, 3)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Feed({ recent, loaded }: { recent: { text: string; lang: string | null; at: string }[] | undefined; loaded: boolean }) {
  return (
    <section className="bol-glass mt-3 px-4 py-4">
      <h2 className="text-xs uppercase tracking-[0.14em] text-sandstone-200/60">
        The last ten questions, in the script they were asked in
      </h2>

      {!loaded ? (
        <p className="mt-3 text-sm text-sandstone-200/50">—</p>
      ) : (recent ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-sandstone-200/50">Nobody has asked anything yet.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {(recent ?? []).map((t, i) => {
            const meta = t.lang ? LANGS[normalizeLang(t.lang)] : null;
            return (
              <li key={`${t.at}-${i}`} className="border-l border-sandstone-300/25 pl-3">
                <p className="indic-text text-[15px] text-sandstone-50">{t.text}</p>
                <p className="mt-1 text-[11px] text-sandstone-200/50">
                  {meta ? `${meta.native} · ${meta.english}` : 'language not recorded'} · {ago(t.at)}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Footer({
  data,
  error,
  fetchedAt,
  stale,
}: {
  data: LiveData | null;
  error: string | null;
  fetchedAt: number | null;
  stale: boolean;
}) {
  return (
    <footer className="mt-4 space-y-2 px-1 text-[11px] leading-relaxed text-sandstone-200/50">
      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-red-200">
          {error} Every figure above is showing a dash or its last known value rather than a zero, because we do not
          know the real number right now.
        </p>
      )}
      {!error && stale && <p className="text-amber-200/70">The last poll did not come back. These figures are stale.</p>}

      <p>
        backend: <span className="text-sandstone-100">{data?.backend ?? '—'}</span>
        {data?.backend === 'file' && ' (zero-config JSON store, .data/store.json)'}
        {data?.backend === 'supabase' && ' (Postgres)'}
      </p>
      <p>
        generated at: <span className="text-sandstone-100">{data?.generatedAt ?? '—'}</span>
        {fetchedAt !== null && ` · fetched ${ago(new Date(fetchedAt).toISOString())}`}
      </p>
      <p className="pt-1">
        Every number on this page is a count of rows written by real visits — sessions, turns, memories, reports and
        paid Razorpay webhooks. Nothing here is seeded or simulated. A dash means we could not read that number; it
        never means zero.
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------------------

/** A real zero prints as 0. Anything we could not read prints as a dash. */
function fmt(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-IN');
}

function ago(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'just now';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
