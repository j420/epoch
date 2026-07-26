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
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN JOB HERE IS CREDIBILITY, not delight. So: one enormous honest
 * figure at the top and four smaller ones under it in a single ruled block
 * rather than four floating cards — a ruled table reads as an instrument, four
 * rounded cards read as a marketing page. Numerals are tabular and lining so
 * nothing shifts between three-second polls, section headings are set as small
 * caps rules, and the mixed-script feed gets the full Indic leading treatment
 * because half of what a judge sees here will be in a script they cannot read
 * and it still has to look composed.
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
      {/* One warm gradient at the head of the page. Costs nothing, and stops the
          dashboard opening on a flat black rectangle. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{
          background:
            'radial-gradient(80% 55% at 50% 0%, rgba(193,98,47,0.14) 0%, rgba(90,40,25,0.05) 50%, rgba(0,0,0,0) 80%)',
        }}
      />

      <div
        className="relative mx-auto w-full max-w-2xl px-5 pt-8 sm:px-7"
        style={{ paddingBottom: 'calc(4rem + var(--bol-safe-b))' }}
      >
        <Header live={!error && !stale} error={error} tick={tick} />

        <Hero value={data?.sessionsLastHour} label="people talking to a monument, this hour" />

        <Figures data={data} />

        <Languages languages={data?.languages} loaded={Boolean(data)} />

        <Feed recent={data?.recent} loaded={Boolean(data)} />

        <Footer data={data} error={error} fetchedAt={fetchedAt} stale={stale} />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

/** A section heading: small, wide-tracked, sitting on a hairline rule. */
function Rule({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[0.66rem] font-semibold uppercase leading-relaxed tracking-[0.16em] text-sandstone-200/55">
        {children}
      </h2>
      <span aria-hidden className="mt-2 block h-px w-full bg-sandstone-100/10" />
    </div>
  );
}

function Header({ live, error, tick }: { live: boolean; error: string | null; tick: number }) {
  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-[1.75rem] font-semibold leading-none tracking-tight text-sandstone-50">
          Bol <span className="font-normal text-sandstone-300">live</span>
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-sandstone-200/55">
          Real rows only. Refreshed every 3&nbsp;seconds.
        </p>
      </div>
      <span
        className="bol-chip shrink-0 border-white/10 bg-white/[0.05] text-[0.7rem] uppercase tracking-[0.12em]"
        aria-live="polite"
      >
        <span
          key={tick}
          className={`h-1.5 w-1.5 rounded-full ${
            error ? 'bg-red-400' : live ? 'animate-breathe bg-emerald-400' : 'bg-amber-400'
          }`}
          aria-hidden
        />
        {error ? 'no data' : live ? 'live' : 'stale'}
      </span>
    </header>
  );
}

function Hero({ value, label }: { value: number | undefined; label: string }) {
  return (
    <section className="mb-8">
      <div className="bol-numeral text-figure font-semibold text-sandstone-50">{fmt(value)}</div>
      <div className="mt-3 max-w-xs text-[0.95rem] leading-snug text-sandstone-200/80">{label}</div>
    </section>
  );
}

/**
 * Four counts in one ruled block. The hairlines are drawn with a background
 * grid gap rather than borders per cell, so there is never a doubled rule.
 */
function Figures({ data }: { data: LiveData | null }) {
  const items: { value: number | undefined; label: string; prefix?: string }[] = [
    { value: data?.questions, label: 'questions asked' },
    { value: data?.memories, label: 'memories left' },
    { value: data?.reports, label: 'damage reports' },
    { value: data?.rupees, label: 'rupees donated', prefix: '₹' },
  ];

  return (
    <section className="mb-9">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/[0.09] ring-1 ring-white/[0.09]">
        {items.map((it) => {
          const shown = fmt(it.value);
          return (
            <div key={it.label} className="bg-night-900 px-4 py-5">
              <div className="bol-numeral text-[2rem] font-semibold leading-none text-sandstone-50">
                {shown === '—' ? shown : `${it.prefix ?? ''}${shown}`}
              </div>
              <div className="mt-2 text-[0.75rem] leading-snug text-sandstone-200/60">{it.label}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Languages({ languages, loaded }: { languages: { code: string; count: number }[] | undefined; loaded: boolean }) {
  const total = (languages ?? []).reduce((n, l) => n + l.count, 0);

  return (
    <section className="mb-9">
      <Rule>Languages detected — never chosen</Rule>

      {!loaded ? (
        <p className="text-sm text-sandstone-200/45">—</p>
      ) : (languages ?? []).length === 0 ? (
        <p className="max-w-sm text-sm leading-relaxed text-sandstone-200/55">
          No sessions in the last hour yet. This list fills itself the moment somebody speaks.
        </p>
      ) : (
        <ul className="space-y-4">
          {(languages ?? []).map((l) => {
            const meta = LANGS[normalizeLang(l.code)];
            const pct = total > 0 ? Math.round((l.count / total) * 100) : 0;
            return (
              <li key={l.code}>
                <div className="flex items-baseline justify-between gap-4">
                  <span lang={l.code} className="indic-text text-[1.3rem] font-medium text-sandstone-50">
                    {meta?.native ?? l.code}
                  </span>
                  <span className="shrink-0 text-[0.72rem] uppercase tracking-[0.1em] text-sandstone-200/55">
                    {meta?.english ?? l.code}
                    <span className="bol-numeral ml-2 text-sm normal-case tracking-normal text-sandstone-100">
                      {l.count}
                    </span>
                  </span>
                </div>
                <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sandstone-400 to-sandstone-200
                               transition-[width] duration-slow ease-bol"
                    style={{ width: `${Math.max(pct, 3)}%` }}
                  />
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
    <section className="mb-9">
      <Rule>The last ten questions, in the script they were asked in</Rule>

      {!loaded ? (
        <p className="text-sm text-sandstone-200/45">—</p>
      ) : (recent ?? []).length === 0 ? (
        <p className="text-sm text-sandstone-200/55">Nobody has asked anything yet.</p>
      ) : (
        <ol className="space-y-5">
          {(recent ?? []).map((t, i) => {
            const meta = t.lang ? LANGS[normalizeLang(t.lang)] : null;
            return (
              <li key={`${t.at}-${i}`} className="relative pl-4">
                <span
                  aria-hidden
                  className="absolute left-0 top-1.5 h-[calc(100%-0.5rem)] w-px rounded bg-gradient-to-b
                             from-sandstone-300/45 to-sandstone-300/0"
                />
                <p lang={t.lang ?? undefined} className="indic-text text-[1.02rem] text-sandstone-50">
                  {t.text}
                </p>
                <p className="mt-1.5 text-[0.68rem] uppercase tracking-[0.11em] text-sandstone-200/45">
                  {meta ? (
                    <>
                      <span lang={t.lang ?? undefined} className="indic-text normal-case tracking-normal">
                        {meta.native}
                      </span>{' '}
                      · {meta.english}
                    </>
                  ) : (
                    'language not recorded'
                  )}{' '}
                  · {ago(t.at)}
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
    <footer className="space-y-3 text-[0.7rem] leading-relaxed text-sandstone-200/45">
      {error && (
        <p className="rounded-xl border border-red-400/25 bg-red-500/[0.08] px-3.5 py-3 text-[0.72rem] leading-relaxed text-red-200/90">
          {error} Every figure above is showing a dash or its last known value rather than a zero, because we do not
          know the real number right now.
        </p>
      )}
      {!error && stale && (
        <p className="rounded-xl border border-amber-300/25 bg-amber-400/[0.07] px-3.5 py-3 text-amber-100/80">
          The last poll did not come back. These figures are stale.
        </p>
      )}

      <div aria-hidden className="bol-hairline h-px" />

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 pt-1 font-mono-bol text-[0.68rem]">
        <dt className="text-sandstone-200/40">backend</dt>
        <dd className="text-sandstone-100/80">
          {data?.backend ?? '—'}
          {data?.backend === 'file' && <span className="text-sandstone-200/40"> · JSON store, .data/store.json</span>}
          {data?.backend === 'supabase' && <span className="text-sandstone-200/40"> · Postgres</span>}
        </dd>
        <dt className="text-sandstone-200/40">generated</dt>
        <dd className="break-all text-sandstone-100/80">
          {data?.generatedAt ?? '—'}
          {fetchedAt !== null && (
            <span className="text-sandstone-200/40"> · fetched {ago(new Date(fetchedAt).toISOString())}</span>
          )}
        </dd>
      </dl>

      <p className="max-w-lg pt-1">
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
