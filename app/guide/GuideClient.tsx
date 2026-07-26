'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceChunker, isChunkerSupported, pickRecorderMime, type ChunkMeta } from './vad';

/**
 * The guide's screen.
 *
 * Never imports lib/sarvam or lib/db — it is a client component and talks only to
 * /api/guide/*. Configuration facts arrive as props from the server shell.
 */

type Phase = 'idle' | 'creating' | 'consent' | 'live' | 'ended';

interface SessionInfo {
  code: string;
  joinUrl: string;
  guideUrl: string;
  qrSvg: string;
  sarvamConfigured: boolean;
  dubEnabled: boolean;
  notice: string | null;
}

interface ConsentInfo {
  at: string;
  transcript: string;
  lang: string;
  chip: { native: string; english: string };
  registered: boolean;
  inlineReference: boolean;
}

interface TargetReadout {
  lang: string;
  ms: number;
  engine: string;
  ok: boolean;
  degradedReason: string | null;
  voiceDegraded: boolean;
}

interface ChunkReadout {
  id: number;
  transcript: string;
  targets: TargetReadout[];
  totalMs: number;
  sttMs: number;
  translateMs: number;
  roundTripMs: number;
  at: number;
  error: string | null;
  skipped: string | null;
}

interface LanguageRow {
  lang: string;
  count: number;
  native: string;
  english: string;
}

const CONSENT_PHRASE_HI = 'मैं इस दौरे के लिए अपनी आवाज़ के उपयोग की सहमति देता हूँ।';
const CONSENT_PHRASE_EN = 'I consent to my voice being used for this tour.';

export default function GuideClient({
  sarvamConfigured,
  dubEnabled,
}: {
  sarvamConfigured: boolean;
  dubEnabled: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [chunks, setChunks] = useState<ChunkReadout[]>([]);
  const [languages, setLanguages] = useState<LanguageRow[]>([]);
  const [listeners, setListeners] = useState(0);
  const [micState, setMicState] = useState<'off' | 'listening' | 'speaking' | 'error'>('off');
  const [level, setLevel] = useState(0);
  const [queueDepth, setQueueDepth] = useState(0);
  const [endStats, setEndStats] = useState<Record<string, unknown> | null>(null);

  const [consentRecording, setConsentRecording] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);

  const chunkerRef = useRef<VoiceChunker | null>(null);
  const consentRecorderRef = useRef<MediaRecorder | null>(null);
  const consentStreamRef = useRef<MediaStream | null>(null);
  const consentStartRef = useRef(0);
  const sessionRef = useRef<SessionInfo | null>(null);
  const chunkIdRef = useRef(0);

  /**
   * Chunks are POSTed strictly in order. A tour is a narrative: a sentence arriving
   * before the one it follows is worse than a sentence arriving a beat late. In
   * practice the guide's own pauses keep this queue at depth 0 or 1.
   */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const supported = useMemo(() => isChunkerSupported(), []);

  // --- session lifecycle -----------------------------------------------------

  const startSession = useCallback(async () => {
    setError(null);
    setPhase('creating');
    try {
      const res = await fetch('/api/guide/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guideLang: 'hi-IN' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Could not start a session.');
      setSession(body as SessionInfo);
      setPhase('consent');
    } catch (err) {
      setError((err as Error).message);
      setPhase('idle');
    }
  }, []);

  const endSession = useCallback(async () => {
    const current = sessionRef.current;
    chunkerRef.current?.stop();
    chunkerRef.current = null;
    setMicState('off');
    if (!current) return;
    try {
      const res = await fetch('/api/guide/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: current.code }),
      });
      const body = await res.json();
      if (res.ok) setEndStats(body.stats ?? null);
    } catch {
      /* the room is going away regardless */
    }
    setPhase('ended');
  }, []);

  // --- consent ---------------------------------------------------------------

  const beginConsentRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      consentStreamRef.current = stream;
      const mime = pickRecorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const parts: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        consentStreamRef.current = null;
        setConsentRecording(false);
        const ms = Math.round(performance.now() - consentStartRef.current);
        const blob = new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' });
        await submitConsent(blob, ms);
      };
      consentRecorderRef.current = recorder;
      consentStartRef.current = performance.now();
      recorder.start();
      setConsentRecording(true);
    } catch (err) {
      setError(`Microphone unavailable: ${(err as Error).message}`);
    }
    // submitConsent reads the session through sessionRef, so it never goes stale and
    // does not belong in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopConsentRecording = useCallback(() => {
    const recorder = consentRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  async function submitConsent(blob: Blob, ms: number) {
    const current = sessionRef.current;
    if (!current) return;
    setConsentBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('audio', blob, 'consent.webm');
      form.append('code', current.code);
      form.append('ms', String(ms));
      const res = await fetch('/api/guide/session/consent', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Consent could not be recorded.');
      setConsent({
        at: body.at,
        transcript: body.transcript,
        lang: body.lang,
        chip: body.chip,
        registered: Boolean(body.voice?.registered),
        inlineReference: Boolean(body.voice?.inlineReference),
      });
      setPhase('live');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConsentBusy(false);
    }
  }

  // --- the live loop ---------------------------------------------------------

  const sendChunk = useCallback((blob: Blob, meta: ChunkMeta) => {
    const current = sessionRef.current;
    if (!current) return;

    pendingRef.current += 1;
    setQueueDepth(pendingRef.current);

    const id = ++chunkIdRef.current;
    setChunks((prev) =>
      [
        {
          id,
          transcript: '',
          targets: [],
          totalMs: 0,
          sttMs: 0,
          translateMs: 0,
          roundTripMs: 0,
          at: meta.cutAt,
          error: null,
          skipped: null,
        },
        ...prev,
      ].slice(0, 25),
    );

    queueRef.current = queueRef.current.then(async () => {
      try {
        const form = new FormData();
        form.append('audio', blob, `chunk-${meta.index}.webm`);
        form.append('code', current.code);
        form.append('ms', String(meta.ms));
        const res = await fetch('/api/guide/chunk', { method: 'POST', body: form });
        const body = await res.json();
        const roundTripMs = Date.now() - meta.cutAt;

        setChunks((prev) =>
          prev.map((c) =>
            c.id !== id
              ? c
              : {
                  ...c,
                  transcript: body?.transcript ?? '',
                  targets: (body?.targets ?? []) as TargetReadout[],
                  totalMs: body?.totalMs ?? 0,
                  sttMs: body?.sttMs ?? 0,
                  translateMs: body?.translateMs ?? 0,
                  roundTripMs,
                  error: res.ok ? null : (body?.error ?? 'Chunk failed'),
                  skipped: body?.skipped ?? null,
                },
          ),
        );
      } catch (err) {
        setChunks((prev) => prev.map((c) => (c.id === id ? { ...c, error: (err as Error).message } : c)));
      } finally {
        pendingRef.current -= 1;
        setQueueDepth(pendingRef.current);
      }
    });
  }, []);

  const startMic = useCallback(async () => {
    if (chunkerRef.current) return;
    setError(null);
    const chunker = new VoiceChunker({
      onChunk: sendChunk,
      onLevel: (l) => setLevel(l),
      onStateChange: (s) => {
        if (s === 'speaking') setMicState('speaking');
        else if (s === 'listening') setMicState('listening');
        else if (s === 'error') setMicState('error');
        else if (s === 'stopped') setMicState('off');
      },
      onError: (err) => setError(`Microphone: ${err.message}`),
    });
    chunkerRef.current = chunker;
    try {
      await chunker.start();
    } catch (err) {
      chunkerRef.current = null;
      setMicState('off');
      setError(`Microphone unavailable: ${(err as Error).message}`);
    }
  }, [sendChunk]);

  const stopMic = useCallback(() => {
    chunkerRef.current?.stop();
    chunkerRef.current = null;
    setMicState('off');
  }, []);

  useEffect(() => () => chunkerRef.current?.stop(), []);

  // --- roster ----------------------------------------------------------------
  // The guide polls rather than holding a second SSE stream: the roster and the
  // transcript are all this screen needs, a 2s poll delivers them steadily, and it
  // keeps one less long-lived connection between the laptop and the venue wifi.
  useEffect(() => {
    if (!session || phase === 'ended') return;
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch(`/api/guide/poll?code=${encodeURIComponent(session.code)}&lang=*&since=999999`, {
          cache: 'no-store',
        });
        if (!res.ok || !alive) return;
        const body = await res.json();
        setLanguages(body.languages ?? []);
        setListeners(body.listeners ?? 0);
      } catch {
        /* transient; the next tick retries */
      }
    };
    void pull();
    const timer = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, phase]);

  // -------------------------------------------------------------------------

  const latest = chunks.find((c) => c.targets.length > 0);
  const bestMs = latest ? Math.min(...latest.targets.map((t) => t.ms)) : null;

  return (
    <main className="h-dvh overflow-y-auto bg-night-900 text-sandstone-100">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <Header phase={phase} code={session?.code ?? null} onEnd={endSession} />

        {/* The badge. Once consent exists it never leaves the screen. */}
        {consent && <ConsentBadge consent={consent} dubEnabled={dubEnabled} />}

        {!sarvamConfigured && <NotConfiguredBanner />}
        {error && (
          <div className="bol-glass mt-4 border-red-500/30 bg-red-950/30 p-4 text-sm text-red-200">
            <strong className="font-semibold">Something failed, honestly reported:</strong> {error}
          </div>
        )}

        {phase === 'idle' || phase === 'creating' ? (
          <Intro onStart={startSession} busy={phase === 'creating'} supported={supported} dubEnabled={dubEnabled} />
        ) : null}

        {session && phase !== 'idle' && phase !== 'creating' && (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
            <div className="space-y-6">
              <JoinCard session={session} listeners={listeners} />
              <RosterCard languages={languages} listeners={listeners} />
            </div>

            <div className="space-y-6">
              {phase === 'consent' && (
                <ConsentCard
                  recording={consentRecording}
                  busy={consentBusy}
                  disabled={!sarvamConfigured}
                  onStart={beginConsentRecording}
                  onStop={stopConsentRecording}
                />
              )}

              {phase === 'live' && (
                <>
                  <MicCard
                    micState={micState}
                    level={level}
                    queueDepth={queueDepth}
                    supported={supported}
                    onStart={startMic}
                    onStop={stopMic}
                    bestMs={bestMs}
                  />
                  <TranscriptCard chunks={chunks} />
                </>
              )}

              {phase === 'ended' && <EndedCard stats={endStats} />}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Header({ phase, code, onEnd }: { phase: Phase; code: string | null; onEnd: () => void }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Bol <span className="text-sandstone-300">· Guide Amplifier</span>
        </h1>
        <p className="mt-1 text-sm text-sandstone-100/60">
          You speak once. Everyone hears it in their own language, in your voice.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {code && <span className="bol-chip font-mono">Room {code}</span>}
        {(phase === 'live' || phase === 'consent') && (
          <button
            onClick={onEnd}
            className="rounded-full border border-red-400/30 bg-red-950/40 px-4 py-1.5 text-sm font-medium text-red-200 transition hover:bg-red-900/50"
          >
            End tour
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * Impossible to miss, by construction: full width, high contrast, pinned above the
 * working area, and it stays for the whole session. An audience of enterprise and
 * government buyers should be able to read it from the back of the room.
 */
function ConsentBadge({ consent, dubEnabled }: { consent: ConsentInfo; dubEnabled: boolean }) {
  const at = new Date(consent.at);
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border-2 border-emerald-400/60 bg-emerald-950/50 shadow-[0_0_40px_-12px_rgba(52,211,153,0.5)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-xl">
          🔒
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold uppercase tracking-wide text-emerald-200 sm:text-lg">
            Voice cloned with consent
          </p>
          <p className="mt-0.5 text-sm text-emerald-100/80">
            Recorded {at.toLocaleTimeString()} · {consent.chip?.english ?? consent.lang} ·{' '}
            {consent.registered ? 'speaker profile registered' : 'reference audio held for this session only'}
            {!dubEnabled && ' · voice preservation is currently off, preset voices in use'}
          </p>
        </div>
      </div>
      <p className="border-t border-emerald-400/20 bg-emerald-950/40 px-5 py-2 indic-text text-sm text-emerald-100/70">
        “{consent.transcript}”
      </p>
    </div>
  );
}

function NotConfiguredBanner() {
  return (
    <div className="bol-glass mt-4 border-amber-400/30 bg-amber-950/25 p-4 text-sm text-amber-100">
      <strong className="font-semibold">No Sarvam API key is configured.</strong> The room, the join code and the QR all
      work, so you can see the whole flow. Transcription, translation and voice stay offline until{' '}
      <code className="rounded bg-black/40 px-1">SARVAM_API_KEY</code> is set — those routes return a plain 503 rather
      than pretending.
    </div>
  );
}

function Intro({
  onStart,
  busy,
  supported,
  dubEnabled,
}: {
  onStart: () => void;
  busy: boolean;
  supported: boolean;
  dubEnabled: boolean;
}) {
  return (
    <div className="bol-glass mt-6 p-6 sm:p-8">
      <h2 className="text-lg font-semibold">Start a tour</h2>
      <ol className="mt-4 space-y-3 text-sm text-sandstone-100/75">
        <li>
          <strong className="text-sandstone-100">1.</strong> You record a short consent phrase. Nothing is cloned before
          that, and a badge stays on this screen for the whole tour.
        </li>
        <li>
          <strong className="text-sandstone-100">2.</strong> Your group scans one QR. They speak a single sentence, and
          their language is detected from it. No menus, no picker.
        </li>
        <li>
          <strong className="text-sandstone-100">3.</strong> You talk normally. Sentences are cut on natural pauses and
          arrive in every listener&apos;s language {dubEnabled ? 'in your own voice' : 'in a clear preset voice'}.
        </li>
      </ol>

      {!supported && (
        <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-950/25 p-3 text-sm text-amber-100">
          This browser has no MediaRecorder, so continuous capture will not run here. Chrome, Edge, Firefox and Safari
          16.4+ all work.
        </p>
      )}

      <button
        onClick={onStart}
        disabled={busy}
        className="mt-6 rounded-full bg-sandstone-400 px-6 py-3 text-base font-semibold text-night-950 transition hover:bg-sandstone-300 disabled:opacity-50"
      >
        {busy ? 'Opening the room…' : 'Start a session'}
      </button>
    </div>
  );
}

function JoinCard({ session, listeners }: { session: SessionInfo; listeners: number }) {
  return (
    <div className="bol-glass p-5">
      <p className="text-xs uppercase tracking-widest text-sandstone-100/50">Join code</p>
      <p className="mt-1 font-mono text-6xl font-bold leading-none tracking-[0.15em] text-sandstone-200 sm:text-7xl">
        {session.code}
      </p>

      <div className="mt-4 overflow-hidden rounded-xl bg-sandstone-100 p-2 [&>svg]:h-auto [&>svg]:w-full">
        {/* Self-generated: the SVG contains only <rect> and one <path>, no text. */}
        <div dangerouslySetInnerHTML={{ __html: session.qrSvg }} />
      </div>

      <p className="mt-3 break-all text-center text-xs text-sandstone-100/60">{session.joinUrl}</p>
      <p className="mt-2 text-center text-sm text-sandstone-100/70">
        {listeners === 0 ? 'Waiting for the first listener' : `${listeners} listening`}
      </p>
    </div>
  );
}

function RosterCard({ languages, listeners }: { languages: LanguageRow[]; listeners: number }) {
  return (
    <div className="bol-glass p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-sandstone-100/50">In the room</h3>
        <span className="text-sm text-sandstone-100/60">{listeners}</span>
      </div>
      {languages.length === 0 ? (
        <p className="mt-3 text-sm text-sandstone-100/50">
          Nobody yet. Each language appears here the moment someone speaks their first sentence.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {languages.map((l) => (
            <li key={l.lang} className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-3 py-2">
              <span className="min-w-0">
                <span className="indic-text text-base text-sandstone-100">{l.native}</span>
                <span className="ml-2 text-xs text-sandstone-100/50">{l.english}</span>
              </span>
              <span className="shrink-0 rounded-full bg-sandstone-400/20 px-2.5 py-0.5 text-sm font-semibold text-sandstone-200">
                {l.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConsentCard({
  recording,
  busy,
  disabled,
  onStart,
  onStop,
}: {
  recording: boolean;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div className="bol-glass p-6">
      <h2 className="text-lg font-semibold">Record your consent</h2>
      <p className="mt-2 text-sm text-sandstone-100/70">
        Read this aloud. It is stored with a timestamp for this session and it is what your voice profile is built from.
        Until it exists, nothing is cloned — the server refuses the voice-preservation path outright.
      </p>

      <blockquote className="mt-4 rounded-xl border border-sandstone-200/20 bg-black/30 p-4">
        <p className="indic-text text-xl text-sandstone-100">{CONSENT_PHRASE_HI}</p>
        <p className="mt-2 text-sm text-sandstone-100/50">{CONSENT_PHRASE_EN}</p>
      </blockquote>

      {disabled ? (
        <p className="mt-5 text-sm text-amber-200/80">
          Consent needs Saaras to transcribe it, so this step waits for an API key.
        </p>
      ) : (
        <button
          onClick={recording ? onStop : onStart}
          disabled={busy}
          className={`mt-5 flex items-center gap-3 rounded-full px-6 py-3 text-base font-semibold transition disabled:opacity-50 ${
            recording
              ? 'animate-listen-pulse bg-red-500 text-white hover:bg-red-400'
              : 'bg-sandstone-400 text-night-950 hover:bg-sandstone-300'
          }`}
        >
          <span className={`h-3 w-3 rounded-full ${recording ? 'bg-white' : 'bg-night-950'}`} />
          {busy ? 'Storing consent…' : recording ? 'Stop and submit' : 'Record consent phrase'}
        </button>
      )}
    </div>
  );
}

function MicCard({
  micState,
  level,
  queueDepth,
  supported,
  onStart,
  onStop,
  bestMs,
}: {
  micState: 'off' | 'listening' | 'speaking' | 'error';
  level: number;
  queueDepth: number;
  supported: boolean;
  onStart: () => void;
  onStop: () => void;
  bestMs: number | null;
}) {
  const on = micState !== 'off' && micState !== 'error';
  const meter = Math.min(100, Math.round(level * 900));
  return (
    <div className="bol-glass p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Speak</h2>
          <p className="mt-1 text-sm text-sandstone-100/60">
            Talk normally. Sentences are cut on a 1.2 second pause — you never have to stop for the system.
          </p>
        </div>
        <button
          onClick={on ? onStop : onStart}
          disabled={!supported}
          className={`rounded-full px-6 py-3 text-base font-semibold transition disabled:opacity-40 ${
            on ? 'bg-red-500 text-white hover:bg-red-400' : 'bg-emerald-400 text-night-950 hover:bg-emerald-300'
          }`}
        >
          {on ? 'Pause microphone' : 'Start speaking'}
        </button>
      </div>

      <div className="mt-5 flex items-center gap-4">
        <span
          className={`bol-chip ${
            micState === 'speaking'
              ? 'border-emerald-300/50 text-emerald-200'
              : micState === 'listening'
                ? 'border-sandstone-200/30'
                : ''
          }`}
        >
          {micState === 'speaking' ? '● capturing' : micState === 'listening' ? '○ waiting for speech' : micState === 'error' ? '⚠ microphone error' : '○ microphone off'}
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/40">
          <div
            className={`h-full rounded-full transition-[width] duration-75 ${micState === 'speaking' ? 'bg-emerald-400' : 'bg-sandstone-400/50'}`}
            style={{ width: `${meter}%` }}
          />
        </div>
        {queueDepth > 0 && <span className="bol-chip">{queueDepth} in flight</span>}
      </div>

      {bestMs !== null && (
        <p className="mt-4 text-sm text-sandstone-100/60">
          Fastest language on the last sentence:{' '}
          <strong className={bestMs < 3000 ? 'text-emerald-300' : 'text-amber-300'}>{bestMs} ms</strong>
          <span className="text-sandstone-100/40"> · target is under 3000 ms</span>
        </p>
      )}
    </div>
  );
}

function TranscriptCard({ chunks }: { chunks: ChunkReadout[] }) {
  return (
    <div className="bol-glass p-6">
      <h3 className="text-sm font-semibold uppercase tracking-widest text-sandstone-100/50">What you said</h3>
      {chunks.length === 0 ? (
        <p className="mt-3 text-sm text-sandstone-100/50">Nothing yet. Start speaking and sentences appear here.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {chunks.map((c) => (
            <li key={c.id} className="rounded-xl bg-black/25 p-3">
              {c.transcript ? (
                <p className="indic-text text-base text-sandstone-100">{c.transcript}</p>
              ) : c.error ? (
                <p className="text-sm text-red-300">{c.error}</p>
              ) : c.skipped ? (
                <p className="text-sm text-sandstone-100/40">
                  {c.skipped === 'silence' ? 'Silence — nothing sent' : 'No listeners yet — nothing sent'}
                </p>
              ) : (
                <p className="bol-shimmer h-5 w-2/3 rounded" />
              )}

              {c.targets.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {c.targets.map((t) => (
                    <span
                      key={t.lang}
                      title={t.degradedReason ? `Degraded: ${t.degradedReason}` : undefined}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                        !t.ok
                          ? 'border-red-400/40 bg-red-950/40 text-red-200'
                          : t.engine === 'dub'
                            ? 'border-emerald-400/40 bg-emerald-950/40 text-emerald-200'
                            : 'border-sandstone-200/25 bg-black/40 text-sandstone-100/80'
                      }`}
                    >
                      {t.lang} · {t.ms}ms · {t.engine === 'dub' ? 'your voice' : t.engine === 'bulbul' ? 'preset' : 'failed'}
                      {t.voiceDegraded && ' ⚠'}
                    </span>
                  ))}
                  <span className="text-xs text-sandstone-100/40">
                    round trip {c.roundTripMs}ms · stt {c.sttMs}ms · translate {c.translateMs}ms
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EndedCard({ stats }: { stats: Record<string, unknown> | null }) {
  return (
    <div className="bol-glass p-6">
      <h2 className="text-lg font-semibold">Tour ended</h2>
      {stats ? (
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          {(
            [
              ['Sentences', 'chunks'],
              ['Language renders', 'targets'],
              ['In your voice', 'viaDub'],
              ['Preset voice', 'viaBulbul'],
              ['Failed', 'failed'],
              ['Average', 'averageMs'],
            ] as const
          ).map(([label, key]) => (
            <div key={key} className="rounded-xl bg-black/25 p-3">
              <dt className="text-xs uppercase tracking-wide text-sandstone-100/45">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold text-sandstone-100">
                {String(stats[key] ?? 0)}
                {key === 'averageMs' && stats[key] != null ? <span className="text-sm"> ms</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-sandstone-100/60">The room is closed and every listener has been told.</p>
      )}
      <a
        href="/guide"
        className="mt-6 inline-block rounded-full bg-sandstone-400 px-6 py-3 text-base font-semibold text-night-950 transition hover:bg-sandstone-300"
      >
        Start another tour
      </a>
    </div>
  );
}
