'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { UnlockedAudioQueue } from './audio';

/**
 * The listener's screen. Three states and no decisions:
 *   enter the code → speak one sentence → listen.
 *
 * There is no language picker here and there is no way to add one: the client never
 * sends a language, and the join route does not accept one. The language comes from
 * Saaras hearing the listener's single sentence, and nothing else.
 */

type Phase = 'code' | 'speak' | 'listening' | 'ended';
type Transport = 'connecting' | 'sse' | 'poll';

interface Line {
  seq: number;
  text: string;
  sourceText: string;
  engine: string;
  ms: number;
  voiceDegraded: boolean;
  hasAudio: boolean;
}

interface VoiceNotice {
  speakable: boolean;
  voiceLang: string;
  degraded: boolean;
  voiceLangName: string;
}

const MAX_UTTERANCE_MS = 8000;

export default function JoinClient({
  initialCode,
  sarvamConfigured,
}: {
  initialCode: string;
  sarvamConfigured: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(initialCode ? 'speak' : 'code');
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const [lang, setLang] = useState<string | null>(null);
  const [chip, setChip] = useState<{ native: string; english: string } | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<VoiceNotice | null>(null);
  const [listenerId, setListenerId] = useState<string | null>(null);
  const [listeners, setListeners] = useState(0);

  const [lines, setLines] = useState<Line[]>([]);
  const [transport, setTransport] = useState<Transport>('connecting');
  const [audioReady, setAudioReady] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<number | null>(null);
  const [queueDepth, setQueueDepth] = useState(0);

  const audioRef = useRef<UnlockedAudioQueue | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeqRef = useRef(0);

  /**
   * Created on demand rather than during render. React StrictMode mounts, unmounts
   * and remounts in development; a queue built in the render body would be disposed
   * by that first unmount and every later chunk would play into a dead element.
   */
  const getAudio = useCallback((): UnlockedAudioQueue | null => {
    if (typeof window === 'undefined') return null;
    if (!audioRef.current) {
      audioRef.current = new UnlockedAudioQueue({
        onPlay: (seq) => setNowPlaying(seq),
        onIdle: () => setNowPlaying(null),
        onDepth: (d) => setQueueDepth(d),
      });
    }
    return audioRef.current;
  }, []);

  useEffect(
    () => () => {
      audioRef.current?.dispose();
      audioRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
    },
    [],
  );

  // --- step 1: the code ------------------------------------------------------

  const submitCode = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPhase('speak');
  }, []);

  // --- step 2: one sentence. THIS TAP IS THE AUDIO UNLOCK. -------------------

  /*
   * Deliberately NOT memoised. It closes over `code` and `listenerId`, and a stale
   * memo here would post the tour's first code after the listener had corrected it.
   * It is a click handler on one button; there is nothing to gain by memoising it.
   */
  function toggleRecording() {
    if (recording) {
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
      return;
    }

    /*
     * Synchronous, first thing, nothing awaited in front of it: this call has to still
     * be inside the browser's user-gesture window or the audio element is never
     * unlocked and the entire tour plays silently. Everything async happens after it.
     */
    void getAudio()?.unlock().then((ok) => setAudioReady(ok));

    setError(null);
    void beginRecording();
  }

  async function beginRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => {
        try {
          return MediaRecorder.isTypeSupported(m);
        } catch {
          return false;
        }
      });
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const parts: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };
      recorder.onstop = () => {
        if (autoStopRef.current) clearTimeout(autoStopRef.current);
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setRecording(false);
        void submitUtterance(new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' }));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      // Nobody needs more than one sentence, and a stuck recorder is a dead join.
      autoStopRef.current = setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, MAX_UTTERANCE_MS);
    } catch (err) {
      setError(`We could not open the microphone: ${(err as Error).message}`);
      setRecording(false);
    }
  }

  async function submitUtterance(blob: Blob) {
    if (blob.size < 1000) {
      setError('That was too short to hear. Try one full sentence.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('audio', blob, 'hello.webm');
      form.append('code', code);
      if (listenerId) form.append('listenerId', listenerId);

      const res = await fetch('/api/guide/join', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Could not join the tour.');

      // Start the stream from where the room is now. A listener joining mid-tour wants
      // what the guide says next, not a replayed backlog and forty queued audio clips.
      lastSeqRef.current = typeof body.seq === 'number' ? body.seq : 0;

      setLang(body.lang);
      setChip(body.chip);
      setListenerId(body.listenerId);
      setListeners(body.listeners ?? 0);
      setVoiceNotice(body.voice ?? null);
      setPhase('listening');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // --- step 3: listen. SSE, with a polling fallback for hostile networks. -----

  useEffect(() => {
    if (phase !== 'listening' || !lang || !code) return;

    let disposed = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let mode: 'sse' | 'poll' = 'sse';
    let errorCount = 0;

    const ingest = (chunk: {
      seq: number;
      text: string;
      sourceText: string;
      engine: string;
      ms: number;
      voiceDegraded: boolean;
      audio: string | null;
    }) => {
      if (disposed || chunk.seq <= lastSeqRef.current) return; // replay after reconnect
      lastSeqRef.current = chunk.seq;
      setLines((prev) =>
        [
          {
            seq: chunk.seq,
            text: chunk.text,
            sourceText: chunk.sourceText,
            engine: chunk.engine,
            ms: chunk.ms,
            voiceDegraded: chunk.voiceDegraded,
            hasAudio: Boolean(chunk.audio),
          },
          ...prev,
        ].slice(0, 40),
      );
      if (chunk.audio) getAudio()?.enqueue({ seq: chunk.seq, url: chunk.audio });
    };

    const finish = () => {
      if (disposed) return;
      setPhase('ended');
    };

    const startPolling = () => {
      if (disposed || mode === 'poll') return;
      mode = 'poll';
      es?.close();
      es = null;
      if (readyTimer) clearTimeout(readyTimer);
      setTransport('poll');

      const tick = async () => {
        if (disposed) return;
        try {
          const url = `/api/guide/poll?code=${encodeURIComponent(code)}&lang=${encodeURIComponent(lang)}&since=${lastSeqRef.current}${
            listenerId ? `&lid=${encodeURIComponent(listenerId)}` : ''
          }`;
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) return;
          const body = await res.json();
          setListeners(body.listeners ?? 0);
          for (const chunk of body.chunks ?? []) ingest(chunk);
          if (body.ended) finish();
        } catch {
          /* the next tick retries */
        }
      };
      void tick();
      pollTimer = setInterval(tick, 1500);
    };

    const startSse = () => {
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      const url = `/api/guide/stream?code=${encodeURIComponent(code)}&lang=${encodeURIComponent(lang)}&since=${lastSeqRef.current}${
        listenerId ? `&lid=${encodeURIComponent(listenerId)}` : ''
      }`;
      es = new EventSource(url);

      // If `ready` never arrives, something between us and the server is eating the
      // stream. Conference wifi does this. Switch over before anyone notices.
      readyTimer = setTimeout(() => startPolling(), 6000);

      es.addEventListener('ready', (evt) => {
        errorCount = 0;
        if (readyTimer) clearTimeout(readyTimer);
        setTransport('sse');
        try {
          const data = JSON.parse((evt as MessageEvent).data);
          setListeners(data.listeners ?? 0);
          if (data.ended) finish();
        } catch {
          /* ignore a malformed frame */
        }
      });

      es.addEventListener('chunk', (evt) => {
        try {
          ingest(JSON.parse((evt as MessageEvent).data));
        } catch {
          /* ignore a malformed frame */
        }
      });

      es.addEventListener('roster', (evt) => {
        try {
          setListeners(JSON.parse((evt as MessageEvent).data).listeners ?? 0);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener('end', () => finish());

      es.onerror = () => {
        // A closed EventSource has given up entirely. Otherwise it is mid-reconnect,
        // which is normal at the server's stream-lifetime rollover — tolerate a few.
        if (es && es.readyState === EventSource.CLOSED) startPolling();
        else if (++errorCount >= 3) startPolling();
      };
    };

    startSse();

    return () => {
      disposed = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (readyTimer) clearTimeout(readyTimer);
    };
  }, [phase, lang, code, listenerId, getAudio]);

  // -------------------------------------------------------------------------

  const latest = lines[0] ?? null;

  return (
    <main className="h-dvh overflow-y-auto bg-night-900 text-sandstone-100">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 py-8">
        <header className="text-center">
          <h1 className="text-lg font-semibold tracking-tight">
            Bol <span className="text-sandstone-300">· join a tour</span>
          </h1>
        </header>

        {error && (
          <div className="bol-glass mt-5 border-red-500/30 bg-red-950/30 p-4 text-sm text-red-200">{error}</div>
        )}

        {phase === 'code' && (
          <CodeStep code={code} setCode={setCode} onSubmit={submitCode} sarvamConfigured={sarvamConfigured} />
        )}

        {phase === 'speak' && (
          <SpeakStep
            code={code}
            recording={recording}
            busy={busy}
            sarvamConfigured={sarvamConfigured}
            onToggle={toggleRecording}
            onBack={() => setPhase('code')}
          />
        )}

        {(phase === 'listening' || phase === 'ended') && (
          <ListenStep
            phase={phase}
            chip={chip}
            voiceNotice={voiceNotice}
            listeners={listeners}
            lines={lines}
            latest={latest}
            transport={transport}
            audioReady={audioReady}
            nowPlaying={nowPlaying}
            queueDepth={queueDepth}
            onRetryAudio={() => void getAudio()?.retryUnlock().then(setAudioReady)}
          />
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function CodeStep({
  code,
  setCode,
  onSubmit,
  sarvamConfigured,
}: {
  code: string;
  setCode: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  sarvamConfigured: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="mt-10 flex flex-1 flex-col items-center">
      <p className="text-center text-base text-sandstone-100/70">
        Type the four digits on the guide&apos;s screen, or scan their QR code.
      </p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
        inputMode="numeric"
        autoComplete="off"
        pattern="\d{4}"
        placeholder="0000"
        aria-label="Four digit join code"
        className="mt-8 w-full max-w-[16rem] rounded-2xl border border-sandstone-200/20 bg-black/40 px-4 py-5 text-center font-mono text-5xl tracking-[0.3em] text-sandstone-100 outline-none focus:border-sandstone-300/60"
      />
      <button
        type="submit"
        disabled={code.length !== 4}
        className="mt-8 w-full max-w-[16rem] rounded-full bg-sandstone-400 px-6 py-4 text-lg font-semibold text-night-950 transition hover:bg-sandstone-300 disabled:opacity-40"
      >
        Continue
      </button>
      {!sarvamConfigured && (
        <p className="mt-8 max-w-sm text-center text-sm text-amber-200/70">
          This deployment has no Sarvam API key yet, so language detection is offline. The screens all work; joining will
          return a plain “not configured” message rather than pretending to hear you.
        </p>
      )}
    </form>
  );
}

function SpeakStep({
  code,
  recording,
  busy,
  sarvamConfigured,
  onToggle,
  onBack,
}: {
  code: string;
  recording: boolean;
  busy: boolean;
  sarvamConfigured: boolean;
  onToggle: () => void;
  onBack: () => void;
}) {
  return (
    <div className="mt-8 flex flex-1 flex-col items-center text-center">
      <span className="bol-chip font-mono">Room {code}</span>
      <h2 className="mt-6 text-2xl font-semibold">Say one sentence</h2>
      <p className="mt-3 max-w-sm text-base text-sandstone-100/70">
        Anything at all, in whichever language you are most comfortable. We listen once to work out your language — you
        are never asked to pick it from a list.
      </p>

      <button
        onClick={onToggle}
        disabled={busy || !sarvamConfigured}
        className={`mt-12 flex h-40 w-40 flex-col items-center justify-center rounded-full text-lg font-semibold transition disabled:opacity-40 ${
          recording
            ? 'animate-listen-pulse bg-red-500 text-white'
            : 'bg-sandstone-400 text-night-950 hover:bg-sandstone-300'
        }`}
      >
        {busy ? 'Listening…' : recording ? 'Tap to finish' : 'Tap and speak'}
      </button>

      <p className="mt-8 max-w-sm text-sm text-sandstone-100/50">
        That tap also switches your speaker on for the rest of the tour, so audio can start playing the moment the guide
        speaks.
      </p>

      <button onClick={onBack} className="mt-auto pt-8 text-sm text-sandstone-100/50 underline">
        Use a different code
      </button>
    </div>
  );
}

function ListenStep({
  phase,
  chip,
  voiceNotice,
  listeners,
  lines,
  latest,
  transport,
  audioReady,
  nowPlaying,
  queueDepth,
  onRetryAudio,
}: {
  phase: Phase;
  chip: { native: string; english: string } | null;
  voiceNotice: VoiceNotice | null;
  listeners: number;
  lines: Line[];
  latest: Line | null;
  transport: Transport;
  audioReady: boolean;
  nowPlaying: number | null;
  queueDepth: number;
  onRetryAudio: () => void;
}) {
  return (
    <div className="mt-6 flex flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {chip && (
          <span className="bol-chip border-emerald-300/40 text-emerald-200">
            <span className="indic-text">{chip.native}</span>
            <span className="text-emerald-200/60">detected</span>
          </span>
        )}
        <span className="bol-chip">{listeners} listening</span>
        <span className="bol-chip" title={transport === 'sse' ? 'Server-Sent Events' : 'Polling fallback'}>
          {transport === 'connecting' ? '○ connecting' : transport === 'sse' ? '● live' : '● live (polling)'}
        </span>
        {queueDepth > 0 && <span className="bol-chip">{queueDepth} queued</span>}
      </div>

      {!audioReady && phase === 'listening' && (
        <button
          onClick={onRetryAudio}
          className="mt-4 rounded-xl border border-amber-400/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
        >
          Your browser has muted this page. Tap here to turn the sound on.
        </button>
      )}

      {voiceNotice?.degraded && (
        <p className="mt-4 rounded-xl border border-sandstone-200/20 bg-black/30 px-4 py-3 text-sm text-sandstone-100/70">
          We understand your language, but we cannot yet voice it. You will hear {voiceNotice.voiceLangName}, and the
          text below stays in your own language.
        </p>
      )}

      <div className="mt-8 flex-1">
        {phase === 'ended' ? (
          <p className="text-center text-lg text-sandstone-100/60">The tour has ended. Thank you for listening.</p>
        ) : latest === null ? (
          <div className="flex flex-col items-center py-16 text-center">
            <span className="flex h-16 w-16 animate-breathe items-center justify-center rounded-full bg-sandstone-400/15 text-2xl">
              👂
            </span>
            <p className="mt-6 text-base text-sandstone-100/60">
              You are in. Put your phone down — the guide&apos;s words will arrive here and start playing on their own.
            </p>
          </div>
        ) : (
          <>
            <p
              className={`indic-text text-2xl leading-relaxed transition-colors ${
                nowPlaying === latest.seq ? 'text-sandstone-100' : 'text-sandstone-100/85'
              }`}
            >
              {latest.text}
            </p>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-sandstone-100/40">
              <span className="bol-chip">
                {latest.engine === 'dub' ? 'the guide’s own voice' : latest.engine === 'bulbul' ? 'preset voice' : 'text only'}
              </span>
              {!latest.hasAudio && <span>audio unavailable — text only</span>}
            </p>

            {lines.length > 1 && (
              <ul className="mt-8 space-y-4 border-t border-white/5 pt-6">
                {lines.slice(1).map((line) => (
                  <li key={line.seq} className="indic-text text-base text-sandstone-100/45">
                    {line.text}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
