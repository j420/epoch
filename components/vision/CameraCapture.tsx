'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The shared capture surface for both vision features.
 *
 * The file input with capture="environment" is the PRIMARY path, not a fallback.
 * It is the only thing that reliably opens a camera on a mid-range Android and on
 * iOS Safari without permission theatre — getUserMedia asks for a scary prompt,
 * dies inside in-app browsers (Instagram, Gmail), and needs HTTPS with a real
 * certificate. The live preview is offered second, for laptops and for anyone who
 * wants to frame the shot.
 *
 * This component never talks to lib/sarvam.ts or lib/db.ts — it is a client
 * component and hands a Blob upward to a parent that POSTs to /api/*.
 */

/** Long edge, in CSS pixels, of what we actually upload. */
export const MAX_EDGE = 1600;
/** JPEG quality. 0.82 is the knee of the curve — below it plaque text starts to smear. */
export const JPEG_QUALITY = 0.82;

export interface CameraCaptureProps {
  onCapture: (file: File) => void;
  /** Called when the visitor clears the shot. */
  onClear?: () => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  maxEdge?: number;
  quality?: number;
  /** Change this value to clear the preview from the parent (e.g. after a reset). */
  resetToken?: number;
  className?: string;
}

interface Decoded {
  width: number;
  height: number;
  source: CanvasImageSource;
  release: () => void;
}

async function decode(file: Blob): Promise<Decoded> {
  // createImageBitmap with imageOrientation:'from-image' is the only decode path
  // that respects the EXIF rotation phones write instead of rotating pixels —
  // without it, half of all portrait plaque photos reach the OCR sideways.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { width: bmp.width, height: bmp.height, source: bmp, release: () => bmp.close() };
    } catch {
      /* Safari < 16.4 lacks the option; fall through to the <img> path. */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file could not be read as an image.'));
      el.src = url;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      source: img,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/**
 * Downscale to `maxEdge` on the long side and re-encode as JPEG BEFORE upload.
 *
 * WHY this is not optional: a 12MP phone photo is 4-6MB, and 6MB over an Indian
 * 4G uplink is a five- to eight-second wait before the OCR has even started —
 * that alone wrecks the demo and the visitor's patience. 1600px is well above
 * what Sarvam Vision needs to resolve Devanagari or Nastaliq on a signboard, and
 * it lands at roughly 250-400KB, which uploads in well under a second.
 * We never upscale, and if re-encoding somehow produces a bigger file than an
 * already-small original JPEG we keep the original.
 */
export async function downscaleToJpeg(file: Blob, maxEdge = MAX_EDGE, quality = JPEG_QUALITY): Promise<Blob> {
  const decoded = await decode(file);
  try {
    const { width, height, source } = decoded;
    if (!width || !height) return file;

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);

    const out = await canvasToBlob(canvas, quality);
    if (!out) return file;
    if (scale === 1 && file.type === 'image/jpeg' && out.size >= file.size) return file;
    return out;
  } finally {
    decoded.release();
  }
}

function asFile(blob: Blob, name = 'capture.jpg'): File {
  if (blob instanceof File && blob.type === 'image/jpeg') return blob;
  return new File([blob], name, { type: blob.type || 'image/jpeg' });
}

export default function CameraCapture({
  onCapture,
  onClear,
  label = 'Photograph the plaque',
  hint = 'Point the camera at the signboard. Fill the frame with the text.',
  disabled = false,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
  resetToken = 0,
  className = '',
}: CameraCaptureProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<string | null>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedKb, setSavedKb] = useState<{ before: number; after: number } | null>(null);
  const [canGoLive, setCanGoLive] = useState(false);

  useEffect(() => {
    setCanGoLive(typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia));
  }, []);

  const setPreviewUrl = useCallback((url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreview(url);
  }, []);

  const stopLive = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  useEffect(() => {
    if (resetToken === 0) return;
    setPreviewUrl(null);
    setSavedKb(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [resetToken, setPreviewUrl]);

  const handleBlob = useCallback(
    async (blob: Blob, name: string) => {
      setBusy(true);
      setError(null);
      try {
        const before = blob.size;
        const small = await downscaleToJpeg(blob, maxEdge, quality);
        setSavedKb({ before: Math.round(before / 1024), after: Math.round(small.size / 1024) });
        setPreviewUrl(URL.createObjectURL(small));
        onCapture(asFile(small, name));
      } catch (err) {
        setError((err as Error)?.message ?? 'That image could not be read on this device.');
      } finally {
        setBusy(false);
      }
    },
    [maxEdge, onCapture, quality, setPreviewUrl],
  );

  const onFile = useCallback(
    async (ev: React.ChangeEvent<HTMLInputElement>) => {
      const f = ev.target.files?.[0];
      if (!f) return;
      await handleBlob(f, f.name.replace(/\.[^.]+$/, '') + '.jpg');
    },
    [handleBlob],
  );

  const startLive = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      setLive(true);
      // The <video> only exists after `live` flips, so attach on the next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      });
    } catch {
      setError('This device would not open a live camera. Use the shutter button below instead.');
      setLive(false);
    }
  }, []);

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const blob = await canvasToBlob(canvas, 0.95);
    stopLive();
    if (blob) await handleBlob(blob, 'capture.jpg');
  }, [handleBlob, stopLive]);

  const clear = useCallback(() => {
    setPreviewUrl(null);
    setSavedKb(null);
    if (fileRef.current) fileRef.current.value = '';
    onClear?.();
  }, [onClear, setPreviewUrl]);

  return (
    <div className={`bol-glass p-4 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-wide text-sandstone-100">{label}</h3>
        {savedKb && (
          <span className="bol-chip" title="Resized on your phone before upload, so it sends in under a second on 4G.">
            {savedKb.before}KB → {savedKb.after}KB
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-sandstone-200/70">{hint}</p>

      {live ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-black">
          <video ref={videoRef} playsInline muted className="h-56 w-full object-cover" />
          <div className="flex gap-2 p-2">
            <button
              type="button"
              onClick={shoot}
              className="flex-1 rounded-lg bg-sandstone-300 px-3 py-2 text-sm font-semibold text-night-900 active:scale-[0.99]"
            >
              Take the photo
            </button>
            <button
              type="button"
              onClick={stopLive}
              className="rounded-lg border border-white/15 px-3 py-2 text-sm text-sandstone-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : preview ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-white/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="The photograph you just took" className="max-h-64 w-full object-contain bg-black/40" />
          <div className="flex gap-2 p-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || busy}
              className="flex-1 rounded-lg border border-white/15 px-3 py-2 text-sm text-sandstone-100 disabled:opacity-40"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={clear}
              disabled={disabled || busy}
              className="rounded-lg border border-white/15 px-3 py-2 text-sm text-sandstone-200/70 disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy}
            className="w-full rounded-xl bg-sandstone-300 px-4 py-3 text-base font-semibold text-night-900 disabled:opacity-40 active:scale-[0.99]"
          >
            {busy ? 'Preparing the photo…' : 'Open camera'}
          </button>
          {canGoLive && (
            <button
              type="button"
              onClick={startLive}
              disabled={disabled || busy}
              className="w-full rounded-xl border border-white/15 px-4 py-2 text-sm text-sandstone-100 disabled:opacity-40"
            >
              Use a live preview instead
            </button>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFile}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-sandstone-500/40 bg-sandstone-900/40 p-2 text-xs text-sandstone-100">
          {error}
        </p>
      )}
    </div>
  );
}
