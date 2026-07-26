'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { qrMatrix } from '@/lib/qr';

/**
 * The shareable card: the hero photograph with a slow Ken Burns move, the
 * monument's farewell as audio, the caption burned in, and a QR back to the
 * monument. Recorded off a <canvas> with MediaRecorder into a 15-second clip.
 *
 * Everything degrades rather than fails. No MediaRecorder (older iOS Safari, a
 * locked-down webview) means a downloadable PNG of the very same canvas plus the
 * audio file on its own. No audio means a silent clip. No hero image means the
 * card still renders on a sandstone field with the caption and the QR.
 */

/** The brief: after five turns, offer to come with them. */
export const POSTCARD_OFFER_AFTER_TURNS = 5;

export interface PostcardExport {
  blob: Blob;
  url: string;
  mime: string;
  ext: string;
  kind: 'video' | 'image';
  /** Present on the image fallback so the caller can offer the audio separately. */
  audioUrl: string | null;
  file: File;
}

export interface PostcardCardProps {
  /** Photograph to move. Same-origin (e.g. /monuments/qutub-minar/hero.png). */
  heroSrc: string;
  /** Mayura's colloquial caption, in the visitor's language. Burned into the frame. */
  caption: string;
  /** data: URL from speak(). Null renders a silent card. */
  audioUrl?: string | null;
  /** Where the QR points — the monument, so the next person can talk to it too. */
  shareUrl: string;
  monumentName?: string;
  visitorName?: string;
  /** 15 seconds by the brief. */
  durationMs?: number;
  width?: number;
  height?: number;
  onExported?: (result: PostcardExport) => void;
  onError?: (message: string) => void;
  className?: string;
}

type Phase = 'idle' | 'preparing' | 'recording' | 'done' | 'error';

const SANDSTONE = '#0a0908';

export default function PostcardCard({
  heroSrc,
  caption,
  audioUrl = null,
  shareUrl,
  monumentName = '',
  visitorName = '',
  durationMs = 15_000,
  width = 720,
  height = 1280,
  onExported,
  onError,
  className = '',
}: PostcardCardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedRef = useRef<number | null>(null);
  const audioGraph = useRef<{ ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<PostcardExport | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);

  const modules = useMemo(() => {
    try {
      return qrMatrix(shareUrl, { ec: 'M' });
    } catch {
      return null;
    }
  }, [shareUrl]);

  // ---- assets ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      imageRef.current = img;
      setImageReady(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      imageRef.current = null;
      setImageReady(true); // render without the photo rather than never rendering
    };
    img.src = heroSrc;
    return () => {
      cancelled = true;
    };
  }, [heroSrc]);

  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) {
      setFontsReady(true);
      return;
    }
    let cancelled = false;
    void fonts.ready.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- the draw loop -----------------------------------------------------
  const draw = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      paintPostcard(ctx, {
        width,
        height,
        t,
        image: imageRef.current,
        caption,
        monumentName,
        visitorName,
        shareUrl,
        modules,
      });
    },
    [caption, height, modules, monumentName, shareUrl, visitorName, width],
  );

  useEffect(() => {
    const loop = () => {
      const started = startedRef.current;
      const t = started === null ? 0.18 : Math.min(1, (performance.now() - started) / durationMs);
      draw(t);
      if (started !== null) setProgress(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [draw, durationMs, imageReady, fontsReady]);

  // ---- export ------------------------------------------------------------
  const finish = useCallback(
    (exported: PostcardExport) => {
      setResult(exported);
      setPhase('done');
      onExported?.(exported);
    },
    [onExported],
  );

  const fail = useCallback(
    (msg: string) => {
      setMessage(msg);
      setPhase('error');
      onError?.(msg);
    },
    [onError],
  );

  const exportPng = useCallback(
    async (note: string | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return fail('The canvas is not ready.');
      startedRef.current = null;
      draw(0.55);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return fail('The browser refused to render the card to a PNG.');
      const file = new File([blob], fileName('png'), { type: 'image/png' });
      if (note) setMessage(note);
      finish({ blob, url: URL.createObjectURL(blob), mime: 'image/png', ext: 'png', kind: 'image', audioUrl, file });
    },
    [audioUrl, draw, fail, finish],
  );

  const record = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return fail('The canvas is not ready.');

    setMessage(null);
    setResult(null);
    setPhase('preparing');

    const canRecord =
      typeof MediaRecorder !== 'undefined' && typeof canvas.captureStream === 'function';
    if (!canRecord) {
      await exportPng('This browser has no MediaRecorder, so here is the card as an image. The audio downloads separately.');
      return;
    }

    const mime = pickMime();
    if (!mime) {
      await exportPng('This browser records no video format we can share, so here is the card as an image.');
      return;
    }

    let stream: MediaStream;
    try {
      const video = canvas.captureStream(30);
      const tracks = [...video.getVideoTracks()];

      if (audioUrl && audioRef.current) {
        try {
          const graph = ensureAudioGraph(audioRef.current, audioGraph);
          await graph.ctx.resume().catch(() => undefined);
          tracks.push(...graph.dest.stream.getAudioTracks());
        } catch (err) {
          console.warn('[postcard] could not attach the audio track:', (err as Error).message);
          setMessage('The clip is silent — this browser would not let us capture the audio. The voice still plays here.');
        }
      }
      stream = new MediaStream(tracks);
    } catch (err) {
      await exportPng(`Video capture failed (${(err as Error).message}), so here is the card as an image.`);
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    } catch (err) {
      await exportPng(`This browser rejected every video encoder we offered (${(err as Error).message}).`);
      return;
    }

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      void exportPng('The recorder stopped with an error, so here is the card as an image.');
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      startedRef.current = null;
      setProgress(0);
      const type = recorder.mimeType || mime;
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) {
        void exportPng('The recording came back empty, so here is the card as an image.');
        return;
      }
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], fileName(ext), { type });
      finish({ blob, url: URL.createObjectURL(blob), mime: type, ext, kind: 'video', audioUrl, file });
    };

    const audio = audioRef.current;
    if (audio && audioUrl) {
      audio.currentTime = 0;
      await audio.play().catch(() => undefined);
    }

    startedRef.current = performance.now();
    setPhase('recording');
    recorder.start(250);
    window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
      audio?.pause();
    }, durationMs);
  }, [audioUrl, durationMs, exportPng, fail, finish]);

  // ---- chrome ------------------------------------------------------------
  return (
    <div className={`flex w-full flex-col items-center gap-3 ${className}`}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="w-full max-w-[320px] rounded-2xl border border-white/10 shadow-2xl"
        style={{ aspectRatio: `${width} / ${height}`, background: SANDSTONE }}
        aria-label={caption || 'Voice postcard'}
      />

      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" crossOrigin="anonymous" className="hidden" />}

      <div className="flex w-full max-w-[320px] flex-col gap-2">
        <button
          type="button"
          onClick={() => void record()}
          disabled={phase === 'preparing' || phase === 'recording'}
          className="bol-glass w-full px-4 py-3 text-sm font-medium text-sandstone-50 disabled:opacity-60"
        >
          {phase === 'recording'
            ? `Recording… ${Math.ceil((durationMs / 1000) * (1 - progress))}s`
            : phase === 'preparing'
              ? 'Preparing…'
              : result
                ? 'Record it again'
                : 'Make my postcard'}
        </button>

        {phase === 'recording' && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-sandstone-300 transition-[width] duration-100" style={{ width: `${progress * 100}%` }} />
          </div>
        )}

        {message && <p className="text-xs leading-relaxed text-amber-200/80">{message}</p>}

        {result && (
          <div className="flex flex-wrap gap-2 text-xs">
            <a
              href={result.url}
              download={result.file.name}
              className="bol-chip"
            >
              Download {result.ext.toUpperCase()} · {(result.blob.size / 1024 / 1024).toFixed(1)} MB
            </a>
            {result.kind === 'image' && result.audioUrl && (
              <a href={result.audioUrl} download="bol-farewell.wav" className="bol-chip">
                Download the voice
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

interface PaintArgs {
  width: number;
  height: number;
  /** 0..1 through the Ken Burns move. */
  t: number;
  image: HTMLImageElement | null;
  caption: string;
  monumentName: string;
  visitorName: string;
  shareUrl: string;
  modules: boolean[][] | null;
}

function paintPostcard(ctx: CanvasRenderingContext2D, a: PaintArgs): void {
  const { width: W, height: H, t } = a;
  const family = indicFontStack();

  ctx.save();
  ctx.fillStyle = SANDSTONE;
  ctx.fillRect(0, 0, W, H);

  // ---- Ken Burns ---------------------------------------------------------
  if (a.image && a.image.naturalWidth > 0) {
    const eased = t * t * (3 - 2 * t); // smoothstep — no jerk at either end
    const scale = 1.06 + 0.14 * eased;
    const driftY = (eased - 0.5) * H * 0.05;

    const img = a.image;
    const cover = Math.max(W / img.naturalWidth, H / img.naturalHeight) * scale;
    const dw = img.naturalWidth * cover;
    const dh = img.naturalHeight * cover;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2 - driftY, dw, dh);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3a1a11');
    g.addColorStop(1, '#0a0908');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- scrim so the type is always legible -------------------------------
  const scrim = ctx.createLinearGradient(0, H * 0.42, 0, H);
  scrim.addColorStop(0, 'rgba(10,9,8,0)');
  scrim.addColorStop(0.45, 'rgba(10,9,8,0.72)');
  scrim.addColorStop(1, 'rgba(10,9,8,0.96)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, H * 0.42, W, H * 0.58);

  const pad = Math.round(W * 0.067);

  // ---- QR, bottom left ---------------------------------------------------
  const qrBox = Math.round(W * 0.235);
  const qrX = pad;
  const qrY = H - pad - qrBox;
  drawQr(ctx, a.modules, qrX, qrY, qrBox);

  // ---- the line beside the QR -------------------------------------------
  const textX = qrX + qrBox + Math.round(pad * 0.6);
  const textW = W - textX - pad;
  ctx.textBaseline = 'alphabetic';

  if (a.monumentName) {
    ctx.font = `600 ${Math.round(W * 0.042)}px ${family}`;
    ctx.fillStyle = '#f8e6d4';
    ellipsis(ctx, a.monumentName, textX, qrY + Math.round(qrBox * 0.42), textW);
  }
  ctx.font = `400 ${Math.round(W * 0.03)}px ${family}`;
  ctx.fillStyle = 'rgba(248,230,212,0.62)';
  ellipsis(ctx, 'Scan to talk to me', textX, qrY + Math.round(qrBox * 0.66), textW);
  ctx.font = `400 ${Math.round(W * 0.026)}px ${family}`;
  ctx.fillStyle = 'rgba(248,230,212,0.42)';
  ellipsis(ctx, a.shareUrl.replace(/^https?:\/\//, ''), textX, qrY + Math.round(qrBox * 0.9), textW);

  // ---- caption, burned in, wrapped, bottom-up ---------------------------
  const capSize = Math.round(W * 0.047);
  const lineHeight = Math.round(capSize * 1.7); // Indic matras need the room
  ctx.font = `500 ${capSize}px ${family}`;
  const lines = wrap(ctx, a.caption, W - pad * 2, 4);
  let capBaseline = qrY - Math.round(pad * 0.9) - (lines.length - 1) * lineHeight;
  ctx.fillStyle = '#fdf6ef';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10;
  for (const line of lines) {
    ctx.fillText(line, pad, capBaseline);
    capBaseline += lineHeight;
  }
  ctx.shadowBlur = 0;

  // ---- the visitor's name, top left -------------------------------------
  if (a.visitorName) {
    ctx.font = `500 ${Math.round(W * 0.032)}px ${family}`;
    const label = `for ${a.visitorName}`;
    const w = ctx.measureText(label).width;
    const chipH = Math.round(W * 0.062);
    ctx.fillStyle = 'rgba(10,9,8,0.45)';
    roundRect(ctx, pad, pad, w + pad, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(248,230,212,0.9)';
    ctx.fillText(label, pad + pad / 2, pad + chipH * 0.68);
  }

  ctx.restore();
}

function drawQr(
  ctx: CanvasRenderingContext2D,
  modules: boolean[][] | null,
  x: number,
  y: number,
  box: number,
): void {
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, box, box, Math.round(box * 0.06));
  ctx.fill();
  if (!modules || modules.length === 0) return;

  const n = modules.length;
  const quiet = 2; // the printed card sits on a white plate, so 2 modules is enough
  const unit = (box - Math.round(box * 0.1)) / (n + quiet * 2);
  const originX = x + Math.round(box * 0.05) + unit * quiet;
  const originY = y + Math.round(box * 0.05) + unit * quiet;

  ctx.fillStyle = '#0a0908';
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!modules[row][col]) {
        col++;
        continue;
      }
      let run = 0;
      while (col + run < n && modules[row][col + run]) run++;
      ctx.fillRect(
        Math.round(originX + col * unit),
        Math.round(originY + row * unit),
        Math.ceil(unit * run),
        Math.ceil(unit),
      );
      col += run;
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy wrap on spaces, then a hard character wrap for scripts without them. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ');
  const lines: string[] = [];
  let line = '';

  const pushChars = (chunk: string) => {
    let cur = '';
    for (const ch of chunk) {
      if (ctx.measureText(cur + ch).width > maxWidth && cur) {
        lines.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    line = cur;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (ctx.measureText(word).width > maxWidth) pushChars(word);
    else line = word;
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s+\S*$/, '')}…`;
  return kept;
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): void {
  let out = text;
  if (ctx.measureText(out).width > maxWidth) {
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
    out = `${out}…`;
  }
  ctx.fillText(out, x, y);
}

/**
 * Canvas cannot resolve `var(--font-indic)`, so read the family the page actually
 * resolved to. Falls back to the Noto stack that covers every Indian script.
 */
function indicFontStack(): string {
  const fallback = "'Noto Sans', 'Noto Sans Devanagari', 'Noto Sans Tamil', system-ui, sans-serif";
  if (typeof window === 'undefined') return fallback;
  try {
    const resolved = getComputedStyle(document.body).fontFamily;
    return resolved && !resolved.includes('var(') ? resolved : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

/** Safari records mp4 and nothing else; everywhere else vp9/opus is the best clip. */
function pickMime(): string | null {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua) || /iP(hone|ad|od)/i.test(ua);
  const candidates = isSafari
    ? ['video/mp4', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return candidates[0];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? null;
}

/**
 * createMediaElementSource may be called only once per element, so the graph is
 * built lazily and kept. The source is fanned out to both the speakers and the
 * recorder, otherwise the visitor records a clip they cannot hear.
 */
function ensureAudioGraph(
  el: HTMLAudioElement,
  ref: React.MutableRefObject<{ ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null>,
): { ctx: AudioContext; dest: MediaStreamAudioDestinationNode } {
  if (ref.current) return ref.current;
  const Ctor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  const source = ctx.createMediaElementSource(el);
  const dest = ctx.createMediaStreamDestination();
  source.connect(dest);
  source.connect(ctx.destination);
  ref.current = { ctx, dest };
  return ref.current;
}

function fileName(ext: string): string {
  return `bol-postcard-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
