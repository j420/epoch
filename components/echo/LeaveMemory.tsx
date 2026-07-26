'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { echoCopy } from './copy';

/**
 * The contribute half of the echo wall.
 *
 * Three deliberate constraints, all from the brief:
 *
 *  1. The invitation does not exist until the visitor has had a real conversation.
 *     `turnCount` below `minTurns` renders nothing at all — no greyed-out button, no
 *     teaser. You are asked for a memory only once the monument has earned one.
 *  2. Thirty seconds, hard, shown as a countdown ring rather than a number, because
 *     a ring closing is legible at arm's length in sunlight and a digit is not.
 *     Thirty is not a design choice: it is the Saaras REST cap.
 *  3. Consent is an explicit, unticked checkbox, in the visitor's own language, and
 *     the send button does not work until it is ticked. Never pre-checked, never
 *     implied by the act of sending.
 *
 * This is a client component: it talks to /api/memories/contribute and never imports
 * lib/sarvam or lib/db.
 */

const MAX_SECONDS = 30;
const TICK_MS = 100;

export interface ContributeResult {
  id: string | null;
  stored: boolean;
  lang: string;
  transcript: string | null;
  verbatim: string | null;
  approved: boolean;
  consented: boolean;
  moderation: { verdict: string; reason: string };
}

export interface LeaveMemoryProps {
  monumentId: string;
  /** The visitor's language, as detected by Saaras. Never chosen from a list. */
  lang: string;
  sessionId?: string | null;
  /** How many turns of conversation have happened so far. */
  turnCount: number;
  /** The affordance appears at this many turns and never before. */
  minTurns?: number;
  onStored?: (result: ContributeResult) => void;
  /** Called when the recorder opens/closes, so the stage can duck the photograph. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

type Phase = 'invite' | 'recording' | 'review' | 'sending' | 'done' | 'error';

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* Safari throws rather than returning false. */
    }
  }
  return '';
}

export default function LeaveMemory({
  monumentId,
  lang,
  sessionId = null,
  turnCount,
  minTurns = 3,
  onStored,
  onOpenChange,
  className = '',
}: LeaveMemoryProps) {
  const t = useMemo(() => echoCopy(lang), [lang]);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('invite');
  const [elapsed, setElapsed] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [consented, setConsented] = useState(false); // never, ever true by default
  const [city, setCity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sarvamReady, setSarvamReady] = useState<boolean | null>(null);
  const [result, setResult] = useState<ContributeResult | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const unlocked = turnCount >= minTurns;

  // Ask once whether speech recognition is actually available on this deployment,
  // so we can say so before the visitor spends thirty seconds talking to nothing.
  useEffect(() => {
    if (!open || sarvamReady !== null) return;
    let alive = true;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { sarvamConfigured?: boolean }) => {
        if (alive) setSarvamReady(Boolean(d?.sarvamConfigured));
      })
      .catch(() => {
        if (alive) setSarvamReady(null);
      });
    return () => {
      alive = false;
    };
  }, [open, sarvamReady]);

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopping */
      }
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') rec.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(t.micUnsupported);
      setPhase('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) {
          setError(t.failed);
          setPhase('error');
          return;
        }
        setClip({ blob, url: URL.createObjectURL(blob) });
        setPhase('review');
      };

      startedAtRef.current = Date.now();
      setElapsed(0);
      rec.start(250);
      setPhase('recording');

      timerRef.current = setInterval(() => {
        const secs = (Date.now() - startedAtRef.current) / 1000;
        setElapsed(secs);
        if (secs >= MAX_SECONDS) stop();
      }, TICK_MS);
    } catch (err) {
      const name = (err as { name?: string }).name;
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? t.micDenied : t.micUnsupported);
      setPhase('error');
      teardown();
    }
  }, [clip, stop, t, teardown]);

  const send = useCallback(async () => {
    if (!clip || !consented) return;
    setPhase('sending');
    setError(null);

    try {
      const form = new FormData();
      const ext = clip.blob.type.includes('mp4') ? 'm4a' : clip.blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.append('audio', clip.blob, `memory.${ext}`);
      form.append('monument_id', monumentId);
      form.append('consented', consented ? 'true' : 'false');
      if (city.trim()) form.append('city', city.trim());
      if (sessionId) form.append('session_id', sessionId);

      const res = await fetch('/api/memories/contribute', { method: 'POST', body: form });
      const data = (await res.json().catch(() => ({}))) as ContributeResult & { error?: string; kind?: string };

      if (!res.ok) {
        setError(data?.kind === 'not_configured' ? t.notConfigured : data?.error || t.failed);
        setPhase('error');
        return;
      }

      setResult(data);
      setPhase('done');
      onStored?.(data);
    } catch (err) {
      setError((err as Error).message || t.failed);
      setPhase('error');
    }
  }, [city, clip, consented, monumentId, onStored, sessionId, t]);

  const close = useCallback(() => {
    teardown();
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
    setConsented(false);
    setCity('');
    setElapsed(0);
    setError(null);
    setResult(null);
    setPhase('invite');
    setOpen(false);
  }, [clip, teardown]);

  if (!unlocked) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`bol-chip indic-text gap-2 border-sandstone-300/40 px-4 py-2 text-sm text-sandstone-100 transition hover:border-sandstone-300/70 hover:bg-black/55 ${className}`}
        data-echo="invite"
      >
        <span aria-hidden className="h-2 w-2 rounded-full bg-sandstone-300 animate-breathe" />
        {t.invite}
      </button>
    );
  }

  const remaining = Math.max(0, Math.ceil(MAX_SECONDS - elapsed));

  return (
    <section
      className={`bol-glass indic-text w-full max-w-sm p-4 text-sandstone-100 ${className}`}
      aria-label={t.invite}
      data-echo="panel"
    >
      <header className="mb-3">
        <h2 className="text-base font-medium">{t.invite}</h2>
        <p className="mt-1 text-xs leading-relaxed text-sandstone-200/80">{t.inviteHint}</p>
      </header>

      {sarvamReady === false && (
        <p
          role="status"
          className="mb-3 rounded-xl border border-sandstone-400/30 bg-sandstone-900/50 px-3 py-2 text-xs leading-relaxed text-sandstone-200"
        >
          {t.notConfigured}
        </p>
      )}

      {(phase === 'invite' || phase === 'recording' || phase === 'error') && (
        <div className="flex flex-col items-center gap-3 py-2">
          <CountdownRing
            elapsed={elapsed}
            max={MAX_SECONDS}
            active={phase === 'recording'}
            onClick={phase === 'recording' ? stop : start}
            label={phase === 'recording' ? t.stop : t.start}
          />
          <p className="text-xs text-sandstone-200/75" aria-live="polite">
            {phase === 'recording' ? `${t.recording} · ${t.remaining(remaining)}` : t.limitNote}
          </p>
        </div>
      )}

      {phase === 'review' && clip && (
        <div className="space-y-3">
          <audio src={clip.url} controls className="w-full" preload="metadata" />

          <div className="flex items-center justify-between text-xs">
            <span className="text-sandstone-200/75">{t.ready}</span>
            <button type="button" onClick={start} className="underline underline-offset-4 hover:text-sandstone-50">
              {t.again}
            </button>
          </div>

          <label className="block text-xs text-sandstone-200/80">
            {t.cityLabel}
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder={t.cityPlaceholder}
              maxLength={60}
              autoComplete="address-level2"
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-sandstone-50 outline-none placeholder:text-sandstone-200/40 focus:border-sandstone-300/60"
            />
          </label>

          {/* The consent gate. Unticked on every render, every time. */}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/10 bg-black/25 p-3">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5 h-4 w-4 flex-none accent-sandstone-400"
              data-echo="consent"
            />
            <span className="text-xs leading-relaxed text-sandstone-100">{t.consent}</span>
          </label>

          <button
            type="button"
            onClick={send}
            disabled={!consented}
            className="w-full rounded-xl bg-sandstone-500 px-4 py-2.5 text-sm font-medium text-night-950 transition disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-sandstone-200/50"
          >
            {t.send}
          </button>
          {!consented && <p className="text-center text-[11px] text-sandstone-200/60">{t.consentRequired}</p>}
        </div>
      )}

      {phase === 'sending' && (
        <p className="py-6 text-center text-sm text-sandstone-200" role="status">
          {t.sending}
        </p>
      )}

      {phase === 'done' && (
        <div className="space-y-2 py-2 text-center">
          <p className="text-sm text-sandstone-50">{t.thanks}</p>
          <p className="text-xs leading-relaxed text-sandstone-200/70">{t.pending}</p>
          {result?.verbatim && (
            <p className="mt-2 max-h-24 overflow-y-auto rounded-lg bg-black/30 p-2 text-left text-[11px] leading-relaxed text-sandstone-200/80">
              {result.verbatim}
            </p>
          )}
        </div>
      )}

      {phase === 'error' && error && (
        <p role="alert" className="mt-2 rounded-xl border border-red-400/30 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-100">
          {error}
        </p>
      )}

      <footer className="mt-3 flex justify-end">
        <button type="button" onClick={close} className="text-xs text-sandstone-200/60 underline underline-offset-4">
          {t.cancel}
        </button>
      </footer>
    </section>
  );
}

/**
 * The thirty-second limit, drawn. The ring empties as the seconds go; the last five
 * seconds turn warm so it is obvious in peripheral vision that time is nearly up.
 */
function CountdownRing({
  elapsed,
  max,
  active,
  onClick,
  label,
}: {
  elapsed: number;
  max: number;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const progress = Math.min(1, elapsed / max);
  const nearlyDone = max - elapsed <= 5 && active;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`relative grid h-28 w-28 place-items-center rounded-full transition ${active ? 'animate-listen-pulse' : ''}`}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(248,230,212,0.12)" strokeWidth="4" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={nearlyDone ? '#d47f4c' : '#e2a271'}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * progress}
          style={{ transition: 'stroke-dashoffset 120ms linear, stroke 300ms ease' }}
        />
      </svg>
      <span
        className={`grid h-16 w-16 place-items-center rounded-full text-xs font-medium ${
          active ? 'bg-sandstone-400 text-night-950' : 'bg-sandstone-500/90 text-night-950'
        }`}
      >
        {active ? <span className="block h-4 w-4 rounded-[3px] bg-night-950" aria-hidden /> : label}
      </span>
    </button>
  );
}
