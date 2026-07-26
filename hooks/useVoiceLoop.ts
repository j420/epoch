'use client';

/**
 * useVoiceLoop — the client half of Bol's voice lane.
 *
 * One hook owns the whole speech-to-speech turn:
 *
 *   mic (press-and-hold or auto-VAD)
 *     -> MediaRecorder, mono, 16kHz, opus where the browser has it
 *     -> POST /api/listen   (Saaras, codemix)  -> { transcript, lang }
 *     -> POST /api/answer   (route -> retrieve -> generate) -> { text, directive }
 *     -> POST /api/speak    (Bulbul, target = detected lang) -> audio bytes
 *     -> play, while listening for barge-in
 *
 * It exposes exactly what the UI needs and nothing about how any of it works, so
 * the integration lane can drop it into the Stage without importing anything
 * server-side. Nothing in this file (or anything it imports) touches
 * lib/sarvam.ts or lib/db.ts — those are server-only and importing them here
 * would be a build error.
 *
 * Language is never asked for. It arrives from Saaras on the first utterance and
 * every later stage follows it, including a mid-session switch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { detectedChip } from '@/lib/langs';
import { EMPTY_DIRECTIVE, type Intent, type SourceChunk, type StageTimings, type VisualDirective } from '@/lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceTurn {
  id: string;
  role: 'visitor' | 'monument';
  text: string;
  lang: string | null;
  at: number;
  /** True for the monument's line while its audio is still being fetched. */
  pending?: boolean;
}

export interface VoiceError {
  stage: 'mic' | 'stt' | 'answer' | 'tts' | 'session';
  kind: string;
  message: string;
}

export interface VoiceCapabilities {
  /** The browser can record at all (MediaRecorder + getUserMedia + permission). */
  mic: boolean;
  /** /api/listen is usable. False -> the UI must show a text input instead. */
  stt: boolean;
  /** /api/answer is usable. False -> nothing can be answered; say so plainly. */
  answer: boolean;
  /** /api/speak is usable. False -> the UI must show the answer as large text. */
  tts: boolean;
  /** Mirrors isConfigured() on the server. */
  configured: boolean;
}

export interface VoiceDebug {
  mime: string;
  recorderState: string;
  noiseFloor: number;
  speechThreshold: number;
  bargeThreshold: number;
  sawSpeech: boolean;
  recordingMs: number;
  turnEpoch: number;
}

export interface UseVoiceLoopOptions {
  monumentId?: string;
  /** Auto-stop on silence. When false the mic only stops when the UI says so. */
  autoVad?: boolean;
  /** Keep the mic open during playback so the visitor can interrupt. Default true. */
  bargeIn?: boolean;
  /** Called with a validated directive after every answered turn. */
  onDirective?: (directive: VisualDirective) => void;
  onStateChange?: (state: VoiceState) => void;
  /** Fires the first time a language is detected and on every mid-session switch. */
  onLanguage?: (lang: string) => void;
  onError?: (error: VoiceError) => void;
}

export interface VoiceLoop {
  // --- state ---
  state: VoiceState;
  /** Session created and capabilities known. */
  ready: boolean;
  sessionId: string | null;
  /** Detected language code, null until the first utterance. NEVER user-chosen. */
  lang: string | null;
  /** { native, english } for the confirmation chip. Null before detection. */
  langChip: { native: string; english: string } | null;
  /** The monument's pre-written greeting in the detected language. */
  intro: string;
  /** Latest visitor transcript. */
  transcript: string;
  /** Latest monument reply (spoken text, directive already stripped). */
  answer: string;
  turns: VoiceTurn[];
  directive: VisualDirective;
  intent: Intent | null;
  sources: SourceChunk[];
  admittedIgnorance: boolean;
  /** Bulbul could not voice the detected language; this is the honest line. */
  voiceNotice: string | null;
  /** Smoothed input level 0..1 for simple meters. Updated ~12fps. */
  level: number;
  timings: StageTimings;
  budget: typeof LATENCY_BUDGET;
  error: VoiceError | null;
  capabilities: VoiceCapabilities;
  /** Autoplay was blocked; call playPending() from a user gesture. */
  needsTapToPlay: boolean;

  // --- actions ---
  /** Begin recording. Safe to call while speaking — it barges in. */
  start: () => Promise<void>;
  /** Stop recording and run the turn. */
  stop: () => void;
  /** start() when idle, stop() when listening. */
  toggle: () => Promise<void>;
  /** Abort everything in flight and go idle. Used by barge-in and unmount. */
  cancel: () => void;
  /** The no-STT fallback: run a turn from typed text. */
  submitText: (text: string) => Promise<void>;
  /** Speak an arbitrary line as the monument (the intro, a memory lead-in). */
  say: (text: string, lang?: string) => Promise<void>;
  playPending: () => Promise<void>;
  /** Clear the transcript rail and error, keep the session and language. */
  reset: () => void;

  // --- for the waveform / HUD, deliberately not React state ---
  getAnalyser: () => AnalyserNode | null;
  getDebug: () => VoiceDebug;
}

/** The budget from the build contract, in milliseconds. LatencyHUD renders against it. */
export const LATENCY_BUDGET = {
  stt: 150,
  route: 200,
  retrieve: 50,
  generate: 600,
  tts: 200,
  total: 1200,
} as const;

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Saaras REST caps one call at 30 seconds. The recorder hard-stops a shade under
 * that so a slow flush cannot push the upload over the line. /api/session
 * reports the server's value and we take the smaller of the two.
 */
const DEFAULT_MAX_RECORD_MS = 29_000;

/** Silence this long after speech ends the utterance. Shorter feels twitchy mid-sentence. */
const SILENCE_HOLD_MS = 900;
/** Below this we assume a cough or a bumped button, not a question. */
const MIN_SPEECH_MS = 350;
/** Auto-VAD gives up if nobody says anything at all. */
const PRE_SPEECH_TIMEOUT_MS = 6_000;
/** A webm/mp4 container header alone is a few hundred bytes; below this there is no audio. */
const MIN_BLOB_BYTES = 1_000;

/**
 * Barge-in thresholds are deliberately meaner than the VAD ones.
 *
 * While the monument speaks, the mic hears the monument. echoCancellation on the
 * capture stream removes most of it, but not on every Android build, so we also
 * (a) require a much louder signal than normal speech detection, (b) require it
 * to persist, and (c) ignore the first moments of playback entirely, which is
 * when the speaker ramps and the AEC filter has not converged. Together these
 * make the monument interrupting itself essentially impossible while a visitor
 * speaking over it still gets through in about a quarter of a second.
 */
const BARGE_GRACE_MS = 500;
const BARGE_SUSTAIN_MS = 220;
const BARGE_FLOOR = 0.055;
const BARGE_FLOOR_MULT = 5;

/** Adaptive VAD floor: threshold = noiseFloor * MULT + FLOOR, clamped. */
const VAD_FLOOR = 0.012;
const VAD_FLOOR_MULT = 3;
const VAD_MIN = 0.015;
const VAD_MAX = 0.2;

/**
 * MediaRecorder mime support is genuinely different everywhere. iOS Safari does
 * NOT support audio/webm at all and silently produces an empty blob if you ask
 * for it, so we probe rather than assume, and fall back to the browser default
 * (passing no mimeType) as the last resort.
 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
];

/** A valid zero-length WAV. Playing it inside a user gesture unlocks <audio> on iOS. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* Safari has thrown from isTypeSupported before; keep probing. */
    }
  }
  return '';
}

function filenameFor(mime: string): string {
  if (mime.includes('webm')) return 'utterance.webm';
  if (mime.includes('ogg')) return 'utterance.ogg';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'utterance.m4a';
  if (mime.includes('wav')) return 'utterance.wav';
  return 'utterance.webm';
}

type StopReason = 'manual' | 'vad' | 'max' | 'no-speech' | 'cancel';

let turnCounter = 0;
const nextTurnId = () => `t${++turnCounter}-${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useVoiceLoop(options: UseVoiceLoopOptions = {}): VoiceLoop {
  const { monumentId = 'qutub-minar' } = options;

  // Latest callbacks without re-creating every handler on each render.
  const optsRef = useRef(options);
  optsRef.current = options;

  // ---- React state (what the UI paints) ----
  const [state, setStateRaw] = useState<VoiceState>('idle');
  const [ready, setReady] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lang, setLangState] = useState<string | null>(null);
  const [intro, setIntro] = useState('');
  const [transcript, setTranscript] = useState('');
  const [answer, setAnswer] = useState('');
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [directive, setDirective] = useState<VisualDirective>({ ...EMPTY_DIRECTIVE });
  const [intent, setIntent] = useState<Intent | null>(null);
  const [sources, setSources] = useState<SourceChunk[]>([]);
  const [admittedIgnorance, setAdmittedIgnorance] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [timings, setTimings] = useState<StageTimings>({});
  const [error, setErrorState] = useState<VoiceError | null>(null);
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
  const [capabilities, setCapabilities] = useState<VoiceCapabilities>({
    mic: true,
    stt: true,
    answer: true,
    tts: true,
    configured: true,
  });

  // ---- Refs (what the audio machinery reads, without re-rendering) ----
  const stateRef = useRef<VoiceState>('idle');
  const sessionIdRef = useRef<string | null>(null);
  const langRef = useRef<string | null>(null);
  const capsRef = useRef(capabilities);
  const maxRecordMsRef = useRef(DEFAULT_MAX_RECORD_MS);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sampleBufRef = useRef<Float32Array | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const mimeRef = useRef('');
  const chunksRef = useRef<Blob[]>([]);
  const stopReasonRef = useRef<StopReason>('manual');
  const recStartRef = useRef(0);
  const hardStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rafRef = useRef<number | null>(null);
  const noiseFloorRef = useRef(0.01);
  const sawSpeechRef = useRef(false);
  const speechStartRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const bargeSinceRef = useRef(0);
  const levelPushedAtRef = useRef(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objUrlRef = useRef<string | null>(null);
  const playStartRef = useRef(0);
  const unlockedRef = useRef(false);

  /**
   * Monotonic turn id. EVERY async continuation checks it before touching state.
   * This is what makes barge-in safe: cancel() bumps the epoch synchronously, so
   * a /api/speak response that was already in flight for turn N can never set an
   * audio source after turn N+1 has started listening.
   */
  const turnEpochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const setState = useCallback((next: VoiceState) => {
    if (stateRef.current === next) return;
    stateRef.current = next;
    setStateRaw(next);
    optsRef.current.onStateChange?.(next);
  }, []);

  const setError = useCallback((err: VoiceError | null) => {
    setErrorState(err);
    if (err) optsRef.current.onError?.(err);
  }, []);

  const setCaps = useCallback((patch: Partial<VoiceCapabilities>) => {
    capsRef.current = { ...capsRef.current, ...patch };
    setCapabilities(capsRef.current);
  }, []);

  const pushTurn = useCallback((turn: VoiceTurn) => {
    setTurns((prev) => [...prev, turn].slice(-40));
  }, []);

  const setLang = useCallback((next: string | null) => {
    if (!next || langRef.current === next) return;
    langRef.current = next;
    setLangState(next);
    optsRef.current.onLanguage?.(next);
  }, []);

  // -------------------------------------------------------------------------
  // Session bootstrap
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ monumentId }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (!res.ok) {
          setError({ stage: 'session', kind: data?.kind ?? 'unknown', message: data?.error ?? 'Could not start a session.' });
          setReady(true);
          return;
        }

        sessionIdRef.current = data.sessionId ?? null;
        setSessionId(data.sessionId ?? null);
        setIntro(typeof data.intro === 'string' ? data.intro : '');
        if (typeof data.sttMaxSeconds === 'number' && data.sttMaxSeconds > 0) {
          maxRecordMsRef.current = Math.min(DEFAULT_MAX_RECORD_MS, data.sttMaxSeconds * 1000 - 1000);
        }

        const configured = Boolean(data.sarvamConfigured);
        setCaps({
          configured,
          stt: Boolean(data.capabilities?.stt) && configured,
          answer: Boolean(data.capabilities?.answer) && configured,
          tts: Boolean(data.capabilities?.tts) && configured,
          mic: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined',
        });
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError({ stage: 'session', kind: 'network', message: (err as Error).message });
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [monumentId, setCaps, setError]);

  // -------------------------------------------------------------------------
  // Audio graph
  // -------------------------------------------------------------------------

  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    const existing = streamRef.current;
    // A track can end on its own (device unplugged, OS revoked it) — re-acquire.
    if (existing && existing.getAudioTracks().some((t) => t.readyState === 'live')) return existing;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot record audio.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // A hint, not a guarantee — most browsers ignore it and capture at 48kHz.
        // Saaras resamples server-side, so this costs bandwidth at worst.
        sampleRate: 16_000,
        // echoCancellation is what makes barge-in possible at all: without it the
        // mic hears the monument's own voice and interrupts every reply.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    streamRef.current = stream;
    return stream;
  }, []);

  const ensureAudioGraph = useCallback(async (stream: MediaStream) => {
    if (!ctxRef.current) {
      const Ctor =
        typeof window !== 'undefined'
          ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;
      if (!Ctor) return;
      ctxRef.current = new Ctor();
    }
    const ctx = ctxRef.current;
    // Created before any gesture on some browsers; a gesture is what resumes it.
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

    if (!analyserRef.current) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // No smoothing: we want the raw envelope for VAD, not a prettied curve.
      analyser.smoothingTimeConstant = 0;
      analyserRef.current = analyser;
      sampleBufRef.current = new Float32Array(analyser.fftSize);
    }

    // Rebuild the source node when the stream changes.
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        /* already gone */
      }
    }
    const node = ctx.createMediaStreamSource(stream);
    node.connect(analyserRef.current!);
    sourceNodeRef.current = node;
    // Deliberately NOT connected to ctx.destination — that would feed the mic
    // straight back out of the speaker.
  }, []);

  const unlockAudio = useCallback(() => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'auto';
      el.autoplay = false;
      el.onended = () => {
        if (stateRef.current === 'speaking') setState('idle');
      };
      el.onerror = () => {
        if (stateRef.current === 'speaking') setState('idle');
      };
      audioRef.current = el;
    }
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    // iOS will not play audio that was not started inside a user gesture. Playing
    // a silent clip on the first mic press marks the element as user-activated so
    // the monument's reply, which arrives a second later, is allowed to play.
    const el = audioRef.current;
    try {
      el.src = SILENT_WAV;
      void el.play().catch(() => undefined);
    } catch {
      /* nothing to do; the tap-to-play fallback covers it */
    }
  }, [setState]);

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  const releaseObjectUrl = useCallback(() => {
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      try {
        el.pause();
        el.currentTime = 0;
      } catch {
        /* pausing an unstarted element throws on some browsers */
      }
    }
    releaseObjectUrl();
    setNeedsTapToPlay(false);
  }, [releaseObjectUrl]);

  // -------------------------------------------------------------------------
  // The monitor loop: level meter, VAD and barge-in all read the same analyser
  // -------------------------------------------------------------------------

  const stopRecording = useCallback((reason: StopReason) => {
    if (hardStopTimerRef.current) {
      clearTimeout(hardStopTimerRef.current);
      hardStopTimerRef.current = null;
    }
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    stopReasonRef.current = reason;
    try {
      rec.stop();
    } catch {
      /* already stopping */
    }
  }, []);

  const runTurnRef = useRef<(blob: Blob) => Promise<void>>(async () => undefined);
  const startRef = useRef<() => Promise<void>>(async () => undefined);

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const buf = sampleBufRef.current;
    if (!analyser || !buf) return;

    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    const now = performance.now();
    const st = stateRef.current;

    // Track the room. Only while we are NOT actively hearing speech, otherwise the
    // floor creeps up to the speaker's own volume and the VAD goes deaf.
    if (st !== 'speaking' && !(st === 'listening' && sawSpeechRef.current)) {
      noiseFloorRef.current = noiseFloorRef.current * 0.95 + rms * 0.05;
    }

    if (now - levelPushedAtRef.current > 80) {
      levelPushedAtRef.current = now;
      setLevel(Math.min(1, rms * 6));
    }

    if (st === 'listening') {
      const threshold = Math.min(VAD_MAX, Math.max(VAD_MIN, noiseFloorRef.current * VAD_FLOOR_MULT + VAD_FLOOR));

      if (rms > threshold) {
        lastVoiceAtRef.current = now;
        if (!sawSpeechRef.current) {
          sawSpeechRef.current = true;
          speechStartRef.current = now;
        }
      }

      const elapsed = now - recStartRef.current;
      if (elapsed >= maxRecordMsRef.current) {
        stopRecording('max');
        return;
      }
      if (!optsRef.current.autoVad) return;

      if (sawSpeechRef.current) {
        const spokenFor = lastVoiceAtRef.current - speechStartRef.current;
        if (now - lastVoiceAtRef.current > SILENCE_HOLD_MS && spokenFor >= MIN_SPEECH_MS) stopRecording('vad');
      } else if (elapsed > PRE_SPEECH_TIMEOUT_MS) {
        stopRecording('no-speech');
      }
      return;
    }

    if (st === 'speaking' && optsRef.current.bargeIn !== false) {
      if (now - playStartRef.current < BARGE_GRACE_MS) {
        bargeSinceRef.current = 0;
        return;
      }
      const threshold = noiseFloorRef.current * BARGE_FLOOR_MULT + BARGE_FLOOR;
      if (rms > threshold) {
        if (!bargeSinceRef.current) bargeSinceRef.current = now;
        else if (now - bargeSinceRef.current > BARGE_SUSTAIN_MS) {
          bargeSinceRef.current = 0;
          // Interrupting is a first-class action, not an error: kill the audio and
          // start listening in the same breath.
          void startRef.current();
        }
      } else {
        bargeSinceRef.current = 0;
      }
    }
  }, [stopRecording]);

  const startMonitor = useCallback(() => {
    if (rafRef.current !== null) return;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      try {
        tick();
      } catch {
        /* never let a bad frame kill the loop */
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [tick]);

  const stopMonitor = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLevel(0);
  }, []);

  // -------------------------------------------------------------------------
  // Network stages
  // -------------------------------------------------------------------------

  const failFromResponse = useCallback(
    async (stage: VoiceError['stage'], res: Response) => {
      const payload = (await res.json().catch(() => ({}))) as { error?: string; kind?: string };
      const kind = payload.kind ?? `http_${res.status}`;

      // Honest degradation: turn off exactly the capability that is missing so the
      // UI can swap in its fallback, rather than showing a generic failure.
      if (kind === 'not_configured') {
        if (stage === 'stt') setCaps({ stt: false, configured: false });
        if (stage === 'tts') setCaps({ tts: false, configured: false });
        if (stage === 'answer') setCaps({ answer: false, configured: false });
      }

      setError({ stage, kind, message: payload.error ?? `${stage} failed (${res.status})` });
      return kind;
    },
    [setCaps, setError],
  );

  /** Fetch and play the monument's voice. Returns false when nothing was played. */
  const playSpeech = useCallback(
    async (text: string, speakLang: string | null, epoch: number, signal: AbortSignal): Promise<boolean> => {
      if (!capsRef.current.tts) return false;

      const t0 = performance.now();
      let res: Response;
      try {
        res = await fetch('/api/speak?raw=1', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, lang: speakLang ?? undefined, sessionId: sessionIdRef.current ?? undefined }),
          signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return false;
        setError({ stage: 'tts', kind: 'network', message: (err as Error).message });
        return false;
      }
      if (epoch !== turnEpochRef.current) return false;
      if (!res.ok) {
        await failFromResponse('tts', res);
        return false;
      }

      const encodedNotice = res.headers.get('x-bol-notice') ?? '';
      setVoiceNotice(encodedNotice ? safeDecode(encodedNotice) : null);

      const blob = await res.blob();
      if (epoch !== turnEpochRef.current) return false;

      setTimings((prev) => ({ ...prev, tts: Math.round(performance.now() - t0) }));

      releaseObjectUrl();
      const url = URL.createObjectURL(blob);
      objUrlRef.current = url;

      const el = audioRef.current;
      if (!el) return false;
      el.src = url;
      playStartRef.current = performance.now();
      setState('speaking');
      // The mic stays hot through playback; that is what barge-in listens on.
      startMonitor();

      try {
        await el.play();
        setNeedsTapToPlay(false);
      } catch {
        // Autoplay policy said no. Do not pretend it played.
        setNeedsTapToPlay(true);
        setState('idle');
        return false;
      }
      return true;
    },
    [failFromResponse, releaseObjectUrl, setError, setState, startMonitor],
  );

  /** POST /api/answer and paint the result. Returns the spoken text, or null. */
  const runAnswer = useCallback(
    async (text: string, answerLang: string | null, epoch: number, signal: AbortSignal, startedAt: number) => {
      if (!capsRef.current.answer) {
        setError({
          stage: 'answer',
          kind: 'not_configured',
          message: 'The monument cannot answer yet — no Sarvam key is configured.',
        });
        setState('error');
        return null;
      }

      let res: Response;
      try {
        res = await fetch('/api/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            transcript: text,
            lang: answerLang ?? undefined,
            monumentId,
            sessionId: sessionIdRef.current ?? undefined,
            elapsedMs: Math.round(performance.now() - startedAt),
          }),
          signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return null;
        setError({ stage: 'answer', kind: 'network', message: (err as Error).message });
        setState('error');
        return null;
      }
      if (epoch !== turnEpochRef.current) return null;

      if (!res.ok) {
        await failFromResponse('answer', res);
        setState('error');
        return null;
      }

      const data = await res.json();
      if (epoch !== turnEpochRef.current) return null;

      const replyLang: string = data.lang ?? answerLang ?? '';
      const nextDirective: VisualDirective = data.directive ?? { ...EMPTY_DIRECTIVE };

      setAnswer(data.text ?? '');
      setIntent((data.intent ?? null) as Intent | null);
      setSources(Array.isArray(data.sources) ? data.sources : []);
      setAdmittedIgnorance(Boolean(data.admittedIgnorance));
      setDirective(nextDirective);
      setLang(replyLang || null);
      setTimings((prev) => ({ ...prev, ...(data.timings ?? {}) }));
      pushTurn({ id: nextTurnId(), role: 'monument', text: data.text ?? '', lang: replyLang || null, at: Date.now() });

      // Hand the camera its instruction the moment we have it, before the audio
      // round-trip — the photograph should already be moving as the voice starts.
      optsRef.current.onDirective?.(nextDirective);

      return { text: data.text as string, lang: replyLang || null };
    },
    [failFromResponse, monumentId, pushTurn, setError, setLang, setState],
  );

  // -------------------------------------------------------------------------
  // The turn
  // -------------------------------------------------------------------------

  const runTurn = useCallback(
    async (blob: Blob) => {
      const epoch = ++turnEpochRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const startedAt = performance.now();
      setError(null);
      setTimings({});
      setAdmittedIgnorance(false);
      setState('thinking');

      try {
        // --- 1. Saaras ---
        if (!capsRef.current.stt) {
          setError({ stage: 'stt', kind: 'not_configured', message: 'Speech recognition is unavailable — type instead.' });
          setState('error');
          return;
        }

        const form = new FormData();
        form.append('audio', blob, filenameFor(blob.type || mimeRef.current));
        form.append('mode', 'codemix');
        if (sessionIdRef.current) form.append('sessionId', sessionIdRef.current);
        if (langRef.current) form.append('lastLang', langRef.current);

        let sttRes: Response;
        try {
          sttRes = await fetch('/api/listen', { method: 'POST', body: form, signal: controller.signal });
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          setError({ stage: 'stt', kind: 'network', message: (err as Error).message });
          setState('error');
          return;
        }
        if (epoch !== turnEpochRef.current) return;

        if (!sttRes.ok) {
          await failFromResponse('stt', sttRes);
          setState('error');
          return;
        }

        const stt = await sttRes.json();
        if (epoch !== turnEpochRef.current) return;

        setTimings((prev) => ({ ...prev, stt: stt?.timings?.stt ?? Math.round(performance.now() - startedAt) }));

        // --- Empty transcript: say so, do not fail silently. ---
        if (stt.empty || !stt.transcript) {
          const fallbackLang: string | null = stt.lang ?? langRef.current;
          const line: string = stt.fallbackText ?? '';
          setTranscript('');
          if (line) {
            setAnswer(line);
            pushTurn({ id: nextTurnId(), role: 'monument', text: line, lang: fallbackLang, at: Date.now() });
            const played = await playSpeech(line, fallbackLang, epoch, controller.signal);
            if (epoch !== turnEpochRef.current) return;
            if (!played) setState('idle');
          } else {
            setState('idle');
          }
          return;
        }

        setTranscript(stt.transcript);
        setLang(stt.lang ?? null);
        pushTurn({ id: nextTurnId(), role: 'visitor', text: stt.transcript, lang: stt.lang ?? null, at: Date.now() });

        // --- 2. Answer ---
        const reply = await runAnswer(stt.transcript, stt.lang ?? null, epoch, controller.signal, startedAt);
        if (epoch !== turnEpochRef.current || !reply) return;

        // --- 3. Bulbul ---
        const played = await playSpeech(reply.text, reply.lang, epoch, controller.signal);
        if (epoch !== turnEpochRef.current) return;

        setTimings((prev) => ({ ...prev, total: Math.round(performance.now() - startedAt) }));
        if (!played && stateRef.current !== 'error') setState('idle');
      } finally {
        if (epoch === turnEpochRef.current && stateRef.current === 'thinking') setState('idle');
      }
    },
    [failFromResponse, playSpeech, pushTurn, runAnswer, setError, setLang, setState],
  );
  runTurnRef.current = runTurn;

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  const handleRecorderStop = useCallback(() => {
    const reason = stopReasonRef.current;
    const parts = chunksRef.current;
    chunksRef.current = [];
    stopMonitor();

    if (reason === 'cancel') {
      setState('idle');
      return;
    }
    if (reason === 'no-speech') {
      // Auto-VAD armed, nobody spoke. Silently return to idle — this is not a
      // failure and the monument should not announce it.
      setState('idle');
      return;
    }

    const blob = new Blob(parts, { type: mimeRef.current || 'audio/webm' });
    if (blob.size < MIN_BLOB_BYTES) {
      setState('idle');
      return;
    }
    void runTurnRef.current(blob);
  }, [setState, stopMonitor]);

  const start = useCallback(async () => {
    // Ordering here is the barge-in race. All three of these happen synchronously
    // before the first await, so a reply still in flight cannot resurrect itself
    // between "stop the audio" and "start the mic".
    turnEpochRef.current++;
    abortRef.current?.abort();
    stopPlayback();

    if (stateRef.current === 'listening') return;

    setError(null);
    unlockAudio();

    let stream: MediaStream;
    try {
      stream = await ensureStream();
    } catch (err) {
      const denied = (err as Error).name === 'NotAllowedError' || (err as Error).name === 'SecurityError';
      setCaps({ mic: false });
      setError({
        stage: 'mic',
        kind: denied ? 'permission_denied' : 'mic_unavailable',
        message: denied
          ? 'I cannot hear you without microphone permission. Type your question instead.'
          : (err as Error).message,
      });
      setState('error');
      return;
    }

    await ensureAudioGraph(stream);

    if (typeof MediaRecorder === 'undefined') {
      setCaps({ mic: false });
      setError({ stage: 'mic', kind: 'unsupported', message: 'This browser cannot record audio. Type your question instead.' });
      setState('error');
      return;
    }

    const mime = pickRecorderMime();
    mimeRef.current = mime;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    } catch {
      // Some Android builds reject the options object outright; the default works.
      recorder = new MediaRecorder(stream);
      mimeRef.current = recorder.mimeType ?? '';
    }

    chunksRef.current = [];
    stopReasonRef.current = 'manual';
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = handleRecorderStop;
    recorderRef.current = recorder;

    sawSpeechRef.current = false;
    speechStartRef.current = 0;
    lastVoiceAtRef.current = 0;
    bargeSinceRef.current = 0;
    recStartRef.current = performance.now();

    // A timeslice guarantees we hold data even if stop() never fires cleanly,
    // which happens on iOS when the page is backgrounded mid-utterance.
    recorder.start(250);

    // rAF is throttled to ~1Hz in a background tab, so the 30s Saaras ceiling
    // gets a real timer as well as the VAD check.
    if (hardStopTimerRef.current) clearTimeout(hardStopTimerRef.current);
    hardStopTimerRef.current = setTimeout(() => stopRecording('max'), maxRecordMsRef.current);

    setState('listening');
    startMonitor();
  }, [ensureAudioGraph, ensureStream, handleRecorderStop, setCaps, setError, setState, startMonitor, stopPlayback, stopRecording, unlockAudio]);
  startRef.current = start;

  const stop = useCallback(() => {
    stopRecording('manual');
  }, [stopRecording]);

  const toggle = useCallback(async () => {
    if (stateRef.current === 'listening') stop();
    else await start();
  }, [start, stop]);

  const cancel = useCallback(() => {
    turnEpochRef.current++;
    abortRef.current?.abort();
    stopRecording('cancel');
    stopPlayback();
    stopMonitor();
    setState('idle');
  }, [setState, stopMonitor, stopPlayback, stopRecording]);

  // -------------------------------------------------------------------------
  // Fallback paths
  // -------------------------------------------------------------------------

  const submitText = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;

      const epoch = ++turnEpochRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const startedAt = performance.now();
      unlockAudio();
      stopPlayback();
      setError(null);
      setTimings({});
      setAdmittedIgnorance(false);
      setTranscript(clean);
      setState('thinking');
      pushTurn({ id: nextTurnId(), role: 'visitor', text: clean, lang: langRef.current, at: Date.now() });

      // No Saaras result to trust here, so lang may be null; /api/answer reads the
      // script the visitor typed in rather than showing them a picker.
      const reply = await runAnswer(clean, langRef.current, epoch, controller.signal, startedAt);
      if (epoch !== turnEpochRef.current || !reply) {
        if (epoch === turnEpochRef.current && stateRef.current === 'thinking') setState('idle');
        return;
      }

      const played = await playSpeech(reply.text, reply.lang, epoch, controller.signal);
      if (epoch !== turnEpochRef.current) return;
      setTimings((prev) => ({ ...prev, total: Math.round(performance.now() - startedAt) }));
      if (!played && stateRef.current !== 'error') setState('idle');
    },
    [playSpeech, pushTurn, runAnswer, setError, setState, stopPlayback, unlockAudio],
  );

  const say = useCallback(
    async (text: string, speakLang?: string) => {
      const clean = text.trim();
      if (!clean) return;
      const epoch = ++turnEpochRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      unlockAudio();
      stopPlayback();
      setAnswer(clean);
      pushTurn({ id: nextTurnId(), role: 'monument', text: clean, lang: speakLang ?? langRef.current, at: Date.now() });

      const played = await playSpeech(clean, speakLang ?? langRef.current, epoch, controller.signal);
      if (epoch === turnEpochRef.current && !played && stateRef.current !== 'error') setState('idle');
    },
    [playSpeech, pushTurn, setState, stopPlayback, unlockAudio],
  );

  const playPending = useCallback(async () => {
    const el = audioRef.current;
    if (!el || !objUrlRef.current) return;
    unlockedRef.current = true;
    try {
      playStartRef.current = performance.now();
      await el.play();
      setNeedsTapToPlay(false);
      setState('speaking');
      startMonitor();
    } catch {
      setNeedsTapToPlay(true);
    }
  }, [setState, startMonitor]);

  const reset = useCallback(() => {
    cancel();
    setTurns([]);
    setTranscript('');
    setAnswer('');
    setDirective({ ...EMPTY_DIRECTIVE });
    setIntent(null);
    setSources([]);
    setAdmittedIgnorance(false);
    setTimings({});
    setErrorState(null);
  }, [cancel]);

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      turnEpochRef.current++;
      abortRef.current?.abort();
      if (hardStopTimerRef.current) clearTimeout(hardStopTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

      try {
        recorderRef.current?.stop();
      } catch {
        /* already inactive */
      }
      const el = audioRef.current;
      if (el) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
      }
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
      // Release the mic: leaving it live keeps the browser's recording indicator
      // on after the visitor has walked away from the page.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      sourceNodeRef.current?.disconnect();
      void ctxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  const getDebug = useCallback(
    (): VoiceDebug => ({
      mime: mimeRef.current || '(browser default)',
      recorderState: recorderRef.current?.state ?? 'none',
      noiseFloor: noiseFloorRef.current,
      speechThreshold: Math.min(VAD_MAX, Math.max(VAD_MIN, noiseFloorRef.current * VAD_FLOOR_MULT + VAD_FLOOR)),
      bargeThreshold: noiseFloorRef.current * BARGE_FLOOR_MULT + BARGE_FLOOR,
      sawSpeech: sawSpeechRef.current,
      recordingMs: stateRef.current === 'listening' ? Math.round(performance.now() - recStartRef.current) : 0,
      turnEpoch: turnEpochRef.current,
    }),
    [],
  );

  return {
    state,
    ready,
    sessionId,
    lang,
    langChip: lang ? detectedChip(lang) : null,
    intro,
    transcript,
    answer,
    turns,
    directive,
    intent,
    sources,
    admittedIgnorance,
    voiceNotice,
    level,
    timings,
    budget: LATENCY_BUDGET,
    error,
    capabilities,
    needsTapToPlay,
    start,
    stop,
    toggle,
    cancel,
    submitText,
    say,
    playPending,
    reset,
    getAnalyser,
    getDebug,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default useVoiceLoop;
