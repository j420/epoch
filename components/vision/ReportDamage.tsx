'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_LANG, info, normalizeLang } from '@/lib/langs';

import CameraCapture from './CameraCapture';

/**
 * "Report damage": the visitor speaks what they see and optionally photographs it.
 *
 * Saaras transcribes in whatever language they used, the server translates to
 * English for the caretaker record, Vision describes the photograph, and
 * sarvam-105b classifies the damage. The severity comes straight back to the
 * visitor so the report does not feel like it fell into a hole, and the monument
 * confirms in their own language: "Thank you. I have told my caretakers."
 *
 * Client component: no lib/sarvam.ts, no lib/db.ts. Everything goes to /api/report.
 */

export type ReportKind = 'graffiti' | 'structural' | 'water' | 'litter' | 'hazard' | 'unknown';

export interface ReportResult {
  id: string;
  kind: ReportKind;
  severity: 1 | 2 | 3 | 4 | 5;
  transcript: string;
  english: string;
  photoDescription: string | null;
  confirmation: string;
  audio: string | null;
  lang?: string;
  voiceLang?: string;
  degraded?: boolean;
  voiceNote?: string | null;
  classified?: boolean;
  lat?: number | null;
  lon?: number | null;
}

export interface ReportDamageProps {
  /** Detected by Saaras upstream; a fresh detection on this recording wins over it. */
  lang?: string;
  monumentId?: string;
  sessionId?: string;
  /** Ask the browser for a location so the dashboard can plot the report. */
  geotag?: boolean;
  onFiled?: (r: ReportResult) => void;
  className?: string;
}

type Phase = 'idle' | 'recording' | 'sending' | 'done' | 'error';

const KIND_LABEL: Record<ReportKind, string> = {
  graffiti: 'Graffiti / scratching',
  structural: 'Structural damage',
  water: 'Water damage / seepage',
  litter: 'Litter',
  hazard: 'Hazard',
  unknown: 'Needs a human look',
};

const SEVERITY_WORD = ['', 'cosmetic', 'minor', 'notable', 'serious', 'urgent'];

function honestError(kind: string, message: string): string {
  switch (kind) {
    case 'not_configured':
      return 'No Sarvam API key is configured in this build yet, so nothing can be transcribed. Your report was not filed — this message is the honest failure.';
    case 'nothing_to_report':
    case 'audio_too_large':
    case 'image_too_large':
      return message;
    case 'rate_limit':
      return 'Sarvam is rate limiting us right now. Wait a few seconds and send it again.';
    case 'auth':
      return 'Sarvam rejected our credentials. Your report was not filed; the key needs fixing.';
    default:
      return message || 'Your report did not reach the caretakers. Try sending it again.';
  }
}

/** Pick a container this browser will actually record. Safari only does mp4/aac. */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
  return candidates.find((c) => {
    try {
      return MediaRecorder.isTypeSupported(c);
    } catch {
      return false;
    }
  });
}

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** Saaras caps a single REST call at 30 seconds of audio; stop before we waste the visitor's words. */
const MAX_SECONDS = 28;

async function currentPosition(): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    // Never block the report on a permission prompt the visitor ignores.
    const timer = setTimeout(() => resolve(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60_000 },
    );
  });
}

export default function ReportDamage({
  lang = DEFAULT_LANG,
  monumentId = 'qutub-minar',
  sessionId,
  geotag = true,
  onFiled,
  className = '',
}: ReportDamageProps) {
  const code = normalizeLang(lang);

  const [phase, setPhase] = useState<Phase>('idle');
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRecord, setCanRecord] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const confirmRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setCanRecord(
      typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined',
    );
  }, []);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const setRecording = useCallback((blob: Blob | null) => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = blob ? URL.createObjectURL(blob) : null;
    setAudioBlob(blob);
    setAudioUrl(audioUrlRef.current);
  }, []);

  const stop = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setPhase('idle');
  }, []);

  const record = useCallback(async () => {
    setError(null);
    setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size > 0) setRecording(blob);
      };

      rec.start();
      setSeconds(0);
      setPhase('recording');
      tickRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) {
            // Hard stop at the Saaras limit rather than sending 40 seconds it will refuse.
            stop();
            return MAX_SECONDS;
          }
          return s + 1;
        });
      }, 1000);
    } catch {
      setError('This device would not give us the microphone. You can still send a photograph on its own.');
      setPhase('idle');
    }
  }, [setRecording, stop]);

  const send = useCallback(async () => {
    if (!audioBlob && !photo) return;
    setPhase('sending');
    setError(null);
    try {
      const form = new FormData();
      if (audioBlob) {
        form.append('audio', audioBlob, `report.${extFor(audioBlob.type || 'audio/webm')}`);
      }
      if (photo) form.append('image', photo, photo.name || 'damage.jpg');
      form.append('lang', code);
      form.append('monument_id', monumentId);
      if (sessionId) form.append('session_id', sessionId);

      if (geotag) {
        const pos = await currentPosition();
        if (pos) {
          form.append('lat', String(pos.lat));
          form.append('lon', String(pos.lon));
        }
      }

      const res = await fetch('/api/report', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({ error: 'The server sent something that was not JSON.', kind: 'unknown' }));

      if (!res.ok) {
        setError(honestError(String(body.kind ?? 'unknown'), String(body.error ?? '')));
        setPhase('error');
        return;
      }

      const filed = body as ReportResult;
      setResult(filed);
      setPhase('done');
      onFiled?.(filed);

      // Try to speak the confirmation immediately; browsers that block autoplay
      // simply leave the play button, and the text is already on screen.
      requestAnimationFrame(() => {
        void confirmRef.current?.play().catch(() => undefined);
      });
    } catch (err) {
      setError(honestError('network', (err as Error)?.message ?? ''));
      setPhase('error');
    }
  }, [audioBlob, code, geotag, monumentId, onFiled, photo, sessionId]);

  const startOver = useCallback(() => {
    setRecording(null);
    setPhoto(null);
    setResult(null);
    setError(null);
    setSeconds(0);
    setPhase('idle');
    setResetToken((n) => n + 1);
  }, [setRecording]);

  const langName = info(code);
  const ready = Boolean(audioBlob || photo);

  if (phase === 'done' && result) {
    const resultLang = info(normalizeLang(result.lang ?? code));
    return (
      <section className={`mx-auto w-full max-w-xl ${className}`} aria-live="polite">
        <div className="bol-glass p-5">
          <p dir="auto" className="indic-text text-2xl font-medium text-sandstone-50">
            {result.confirmation}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {result.audio ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const el = confirmRef.current;
                    if (!el) return;
                    el.currentTime = 0;
                    void el.play().catch(() => undefined);
                  }}
                  className="rounded-full bg-sandstone-300 px-4 py-2 text-sm font-semibold text-night-900"
                >
                  ▶ hear it again
                </button>
                <audio ref={confirmRef} src={result.audio} preload="auto" className="hidden" />
              </>
            ) : (
              <span className="bol-chip">my voice is unavailable right now — the words are large instead</span>
            )}
            <span className="bol-chip">{resultLang.native}</span>
            {result.degraded && (
              <span className="bol-chip" title={result.voiceNote ?? undefined}>
                spoken in {info(result.voiceLang ?? code).english}
              </span>
            )}
          </div>

          <hr className="my-4 border-white/10" />

          <h3 className="text-xs font-semibold uppercase tracking-widest text-sandstone-200/70">what the caretakers received</h3>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="bol-chip">{KIND_LABEL[result.kind] ?? KIND_LABEL.unknown}</span>
            <span className="flex items-center gap-1" aria-label={`Severity ${result.severity} of 5`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 rounded-full ${n <= result.severity ? 'bg-sandstone-300' : 'bg-white/15'}`}
                />
              ))}
              <span className="ml-1 text-xs text-sandstone-200/70">
                {result.severity}/5 {SEVERITY_WORD[result.severity]}
              </span>
            </span>
            {result.lat != null && result.lon != null && (
              <span className="bol-chip" title="Sent with the report so the dashboard can plot it.">
                📍 {result.lat.toFixed(4)}, {result.lon.toFixed(4)}
              </span>
            )}
          </div>

          {result.classified === false && (
            <p className="mt-2 text-[11px] leading-relaxed text-sandstone-200/60">
              The classifier could not agree on a category, so this is filed for a human to look at. Nothing was lost — the
              record is saved either way.
            </p>
          )}

          {result.transcript && (
            <p dir="auto" className="indic-text mt-3 text-sm text-sandstone-100/90">
              “{result.transcript}”
            </p>
          )}
          {result.english && result.english !== result.transcript && (
            <p className="mt-1 text-sm text-sandstone-200/70">English record: {result.english}</p>
          )}
          {result.photoDescription && (
            <p className="mt-2 text-xs leading-relaxed text-sandstone-200/60">Photograph: {result.photoDescription}</p>
          )}
          <p className="mt-3 text-[10px] text-sandstone-200/40">Report {result.id}</p>

          <button type="button" onClick={startOver} className="mt-4 rounded-lg border border-white/15 px-3 py-2 text-xs">
            Report something else
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`mx-auto w-full max-w-xl ${className}`} aria-live="polite">
      <header className="mb-3">
        <h2 className="text-lg font-semibold text-sandstone-100">Tell me what you see</h2>
        <p className="text-xs leading-relaxed text-sandstone-200/70">
          Speak in {langName.native} — graffiti, a crack, water seeping, rubbish, anything unsafe. A photograph helps but is
          not required.
        </p>
      </header>

      <div className="bol-glass p-4">
        {canRecord ? (
          <button
            type="button"
            onClick={phase === 'recording' ? stop : record}
            disabled={phase === 'sending'}
            className={`w-full rounded-xl px-4 py-4 text-base font-semibold text-night-900 disabled:opacity-40 ${
              phase === 'recording' ? 'animate-listen-pulse bg-sandstone-200' : 'bg-sandstone-400'
            }`}
          >
            {phase === 'recording' ? `● listening — ${seconds}s (tap to stop)` : audioBlob ? 'Record again' : 'Hold nothing — just speak'}
          </button>
        ) : (
          <p className="rounded-lg border border-white/10 p-3 text-xs text-sandstone-200/70">
            This browser will not record audio. Send a photograph on its own and a caretaker will still see it.
          </p>
        )}

        {audioUrl && phase !== 'recording' && (
          <div className="mt-3 flex items-center gap-2">
            <audio src={audioUrl} controls className="w-full" />
            <button
              type="button"
              onClick={() => setRecording(null)}
              className="rounded-lg border border-white/15 px-2 py-1 text-xs text-sandstone-200/70"
            >
              clear
            </button>
          </div>
        )}
      </div>

      <CameraCapture
        className="mt-3"
        label="Photograph it (optional)"
        hint="One clear picture of the damage. It is described, not stored."
        onCapture={setPhoto}
        onClear={() => setPhoto(null)}
        resetToken={resetToken}
        disabled={phase === 'sending'}
      />

      <button
        type="button"
        onClick={send}
        disabled={!ready || phase === 'sending' || phase === 'recording'}
        className="mt-3 w-full rounded-xl bg-sandstone-300 px-4 py-3 text-base font-semibold text-night-900 disabled:opacity-40 active:scale-[0.99]"
      >
        {phase === 'sending' ? 'Telling the caretakers…' : 'Send this to the caretakers'}
      </button>
      {!ready && (
        <p className="mt-2 text-center text-[11px] text-sandstone-200/50">
          Speak what you see, or take a photograph. At least one of the two.
        </p>
      )}

      {phase === 'error' && error && (
        <div role="alert" className="bol-glass mt-3 border-sandstone-500/40 p-4 text-sm leading-relaxed text-sandstone-100">
          {error}
        </div>
      )}
    </section>
  );
}
