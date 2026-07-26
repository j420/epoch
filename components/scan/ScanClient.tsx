'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { JPEG_QUALITY, MAX_EDGE, downscaleToJpeg } from '@/components/vision/CameraCapture';

import { SAMPLE_EDGE, SAMPLE_QUALITY, captureStill } from './frame';
import { prepareUngroundedPhotograph } from './handoff';
import { useCamera } from './useCamera';
import { CONFIRM_MS, MAX_CALLS_PER_RUN, useScan } from './useScan';

/**
 * /scan — point the phone at a monument and let Bol place it.
 *
 * The three outcomes, and the promise attached to each:
 *
 *   MATCHED      the visitor SEES the name, with a countdown and a way out,
 *                before anything navigates. Then /m/<id> and the real, cited,
 *                grounded monument.
 *   NOT MATCHED  after a bounded number of looks we stop and offer the
 *                ungrounded photograph instead. Nobody is dead-ended.
 *   NO CAMERA    a refused permission, a device without one, or a page that is
 *                not on https. All three say exactly what happened and hand
 *                over the file-picker path, which identifies just as well.
 *
 * The camera is stopped the instant it is not needed — on a match, on unmount,
 * on tab hide, on page hide. See useCamera for the full list.
 */

export interface ScanClientProps {
  /** Resolved on the server from lib/sarvam's isConfigured(). */
  configured: boolean;
}

export default function ScanClient({ configured }: ScanClientProps) {
  const router = useRouter();
  const camera = useCamera();
  const { videoRef, stop: stopCamera } = camera;

  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [pickBusy, setPickBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  /** The full-quality still from the file picker, kept for the ungrounded path. */
  const pickedRef = useRef<Blob | null>(null);

  const onMatch = useCallback(
    (id: string) => {
      // Stop the camera BEFORE navigating. The unmount cleanup would do it too,
      // but a camera light that stays on for even one extra beat is the kind of
      // thing a visitor remembers about this product.
      stopCamera();
      router.push(`/m/${id}`);
    },
    [router, stopCamera],
  );

  const scan = useScan({ videoRef, onMatch });
  const { phase, stopReason, hint, notice, candidate, confirmRemaining, looksLike, calls, busy, begin, halt, submitFrame, accept, reject, again, canScanAgain, lastFrame } = scan;

  // -------------------------------------------------------------------------
  // Keep the loop in step with the camera
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!configured) return;
    if (camera.status !== 'live') {
      // Tab hidden, permission revoked, camera taken by another app. There is
      // nothing to look at, so stop looking — and stop paying for it. 'paused'
      // is the ONLY reason that auto-resumes; a cap, a rate limit or a rejected
      // still must never restart the loop behind the visitor's back.
      if (phase === 'scanning') halt('paused');
      return;
    }
    if (phase === 'idle' || (phase === 'stopped' && stopReason === 'paused')) begin();
  }, [begin, camera.status, configured, halt, phase, stopReason]);

  // -------------------------------------------------------------------------
  // The ungrounded way out
  // -------------------------------------------------------------------------

  const talkAnyway = useCallback(async () => {
    setHandoffError(null);
    setHandoffBusy(true);
    setHandoffStatus('Taking the picture…');
    try {
      // Prefer a fresh, full-quality still off the live video; fall back to the
      // picked file, then to the last frame we already uploaded. One of these
      // always exists by the time this button is reachable.
      let still: Blob | null = null;
      const video = videoRef.current;
      if (video) still = await captureStill(video, MAX_EDGE, JPEG_QUALITY);
      if (!still) still = pickedRef.current;
      if (!still) still = lastFrame;
      if (!still) {
        setHandoffError('There is no picture to carry over yet. Let the camera run for a moment first.');
        return;
      }

      halt('manual');
      stopCamera();

      const outcome = await prepareUngroundedPhotograph(still, setHandoffStatus);
      if (!outcome.persisted) {
        setHandoffError(
          'This browser would not keep the photograph (private mode blocks the storage /create reads). Open /create and take the photograph there instead.',
        );
        return;
      }
      router.push('/create');
    } catch (err) {
      setHandoffError(
        `${(err as Error)?.message ?? 'That did not work.'} — you can still open /create and photograph it there.`,
      );
    } finally {
      setHandoffBusy(false);
    }
  }, [halt, lastFrame, router, stopCamera, videoRef]);

  // -------------------------------------------------------------------------
  // The file-picker path — for a refused camera, or a device without one
  // -------------------------------------------------------------------------

  const onFile = useCallback(
    async (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      if (!file) return;
      setPickBusy(true);
      setHandoffError(null);
      try {
        // 1600px q0.82 for the ungrounded path (EXIF-correct, via the upload
        // lane's decoder), then 640px q0.7 for the identification itself.
        const big = await downscaleToJpeg(file, MAX_EDGE, JPEG_QUALITY);
        pickedRef.current = big;
        const small = await downscaleToJpeg(big, SAMPLE_EDGE, SAMPLE_QUALITY);
        await submitFrame(small);
      } catch (err) {
        setHandoffError((err as Error)?.message ?? 'That image could not be read on this device.');
      } finally {
        setPickBusy(false);
      }
    },
    [submitFrame],
  );

  // -------------------------------------------------------------------------
  // No key — say so plainly and get out of the way
  // -------------------------------------------------------------------------

  if (!configured) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold leading-tight text-sandstone-50">Recognition is unavailable here</h1>
        <p className="mt-3 text-sm leading-relaxed text-sandstone-200/75">
          This deployment has no Sarvam key configured, so Bol cannot look through the camera and tell you which
          monument you are standing in front of. Nothing is broken and nothing is being hidden — there is simply
          no key to ask.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-sandstone-200/75">Both of these still work:</p>
        <div className="mt-5 flex flex-col gap-2">
          <Link
            href="/monuments"
            className="w-full rounded-xl bg-sandstone-300 px-4 py-3 text-center text-base font-semibold text-night-900"
          >
            Pick your monument from the ten
          </Link>
          <Link
            href="/create"
            className="w-full rounded-xl border border-white/15 px-4 py-3 text-center text-sm text-sandstone-100"
          >
            Photograph anything and talk to it
          </Link>
        </div>
      </Shell>
    );
  }

  const cameraBroken =
    camera.status === 'denied' ||
    camera.status === 'unavailable' ||
    camera.status === 'insecure' ||
    camera.status === 'error';

  const confirming = phase === 'confirming' && candidate;
  const secondsLeft = Math.max(1, Math.ceil(confirmRemaining / 1000));
  const progress = Math.min(100, Math.max(0, ((CONFIRM_MS - confirmRemaining) / CONFIRM_MS) * 100));

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-black">
      {/*
        playsInline AND muted are both required or iOS Safari opens a fullscreen
        player over the whole layout the moment play() is called. autoPlay keeps
        the first frame arriving without a second gesture.
      */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        aria-label="Live camera"
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
          camera.status === 'live' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/70 via-black/10 to-black/85" />

      {/* Framing brackets — the centre is where the focus measurement is taken. */}
      {camera.status === 'live' && !confirming && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
          <div
            className={`h-56 w-56 rounded-2xl border transition-colors duration-500 sm:h-72 sm:w-72 ${
              busy ? 'border-sandstone-300/70' : 'border-white/20'
            }`}
          />
        </div>
      )}

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-4">
        <Link href="/monuments" className="bol-chip">
          ← the ten monuments
        </Link>
        {phase !== 'idle' && (
          <span
            className="bol-chip"
            title="Bol samples the camera at most once every 1.8 seconds, skips frames that have not changed, and stops after a dozen looks."
          >
            {busy ? <span className="h-1.5 w-1.5 animate-listen-pulse rounded-full bg-sandstone-300" /> : null}
            {calls}/{MAX_CALLS_PER_RUN} looks
          </span>
        )}
      </div>

      {/* Everything else lives at the bottom, over the picture. */}
      <div className="absolute inset-x-0 bottom-0 max-h-[78dvh] overflow-y-auto p-4 pb-6">
        <div className="mx-auto flex w-full max-w-md flex-col gap-3">
          {handoffBusy ? (
            <div className="bol-glass p-4">
              <div className="bol-shimmer h-1 w-full rounded-full" aria-hidden />
              <p className="mt-3 text-sm text-sandstone-100" role="status" aria-live="polite">
                {handoffStatus ?? 'Waking your photograph…'}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-sandstone-200/55">
                The depth is found on your device. The picture is not stored on any server.
              </p>
            </div>
          ) : (
            <>
              {candidate && (
                <div className="bol-glass p-4">
                  <p className="text-xs uppercase tracking-widest text-sandstone-200/60">
                    {confirming ? 'This looks like' : 'This might be'}
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold leading-tight text-sandstone-50">{candidate.name}</h2>

                  {confirming ? (
                    <>
                      <p className="mt-2 text-sm text-sandstone-200/80" role="status" aria-live="polite">
                        Taking you to it in {secondsLeft}s.
                      </p>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full bg-sandstone-300 transition-[width] duration-100 ease-linear"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-sm leading-relaxed text-sandstone-200/80">
                      Not certain enough to take you there on its own. If that is right, tap below — you will get its
                      real, sourced history. If it is wrong, keep the camera moving.
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={accept}
                      className="flex-1 rounded-lg bg-sandstone-300 px-3 py-2.5 text-sm font-semibold text-night-900 active:scale-[0.99]"
                    >
                      {confirming ? 'Go now' : `Yes — talk to ${candidate.name}`}
                    </button>
                    <button
                      type="button"
                      onClick={reject}
                      className="rounded-lg border border-white/20 px-3 py-2.5 text-sm text-sandstone-100 active:scale-[0.99]"
                    >
                      Not this one
                    </button>
                  </div>
                </div>
              )}

              {/* The status panel */}
              <div className="bol-glass p-4">
                {camera.status === 'idle' && (
                  <>
                    <h1 className="text-lg font-semibold leading-tight text-sandstone-50">
                      Point your camera at the monument
                    </h1>
                    <p className="mt-2 text-xs leading-relaxed text-sandstone-200/70">
                      Bol looks at the picture about once every two seconds — never continuously — and stops as soon
                      as it recognises one of the ten. Frames that have not changed are never sent.
                    </p>
                    <button
                      type="button"
                      onClick={() => void camera.start()}
                      className="mt-3 w-full rounded-xl bg-sandstone-300 px-4 py-3 text-base font-semibold text-night-900 active:scale-[0.99]"
                    >
                      Start the camera
                    </button>
                  </>
                )}

                {camera.status === 'starting' && (
                  <p className="text-sm text-sandstone-100" role="status" aria-live="polite">
                    Asking for the camera…
                  </p>
                )}

                {camera.status === 'paused' && (
                  <>
                    <p className="text-sm text-sandstone-100">
                      {camera.message ?? 'The camera is off. It stops whenever you leave this page or hide this tab.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => void camera.start()}
                      className="mt-3 w-full rounded-xl bg-sandstone-300 px-4 py-3 text-base font-semibold text-night-900"
                    >
                      Start the camera again
                    </button>
                  </>
                )}

                {cameraBroken && (
                  <>
                    <p className="text-sm leading-relaxed text-sandstone-100">{camera.message}</p>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={pickBusy || busy}
                      className="mt-3 w-full rounded-xl bg-sandstone-300 px-4 py-3 text-base font-semibold text-night-900 disabled:opacity-40"
                    >
                      {pickBusy || busy ? 'Looking at your photograph…' : 'Take one photograph instead'}
                    </button>
                    {phase === 'stopped' && stopReason && stopReason !== 'paused' && stopReason !== 'manual' && (
                      <p className="mt-3 text-sm leading-relaxed text-sandstone-100" role="status" aria-live="polite">
                        {stoppedCopy(stopReason, calls)}
                      </p>
                    )}
                  </>
                )}

                {camera.status === 'live' && !confirming && (
                  <>
                    <p className="text-sm leading-relaxed text-sandstone-100" role="status" aria-live="polite">
                      {phase === 'stopped' ? stoppedCopy(stopReason, calls) : hint}
                    </p>

                    {looksLike.length > 0 && phase === 'scanning' && (
                      <p className="mt-2 text-xs text-sandstone-200/60">I can see: {looksLike.join(', ')}.</p>
                    )}

                    {phase === 'stopped' && canScanAgain && stopReason === 'exhausted' && (
                      <button
                        type="button"
                        onClick={again}
                        className="mt-3 w-full rounded-xl border border-white/20 px-4 py-2.5 text-sm text-sandstone-100"
                      >
                        Look again
                      </button>
                    )}
                  </>
                )}

                {/*
                  Only while running. Once the loop has stopped, `stoppedCopy`
                  already says the same thing in the visitor's terms, and two
                  boxes repeating one failure reads like two failures.
                */}
                {notice && phase !== 'stopped' && (
                  <p className="mt-3 rounded-lg border border-sandstone-500/40 bg-sandstone-900/40 p-2 text-xs leading-relaxed text-sandstone-100">
                    {notice}
                  </p>
                )}

                {handoffError && (
                  <p
                    role="alert"
                    className="mt-3 rounded-lg border border-red-400/40 bg-red-950/40 p-2 text-xs leading-relaxed text-red-100"
                  >
                    {handoffError}
                  </p>
                )}

                {/* The escapes. Always here, in every state, never hidden behind a menu. */}
                <div className="mt-4 flex flex-col gap-2 border-t border-white/10 pt-3">
                  {camera.status === 'live' || lastFrame ? (
                    <button
                      type="button"
                      onClick={() => void talkAnyway()}
                      disabled={handoffBusy || pickBusy || busy}
                      className="w-full rounded-xl border border-white/20 px-4 py-2.5 text-sm text-sandstone-100 disabled:opacity-40"
                    >
                      Not one of the ten — talk to it anyway
                    </button>
                  ) : (
                    // Nothing has been captured yet, so there is no frame to
                    // carry over. Offer the same destination honestly instead of
                    // a button that can only fail.
                    <Link
                      href="/create"
                      className="w-full rounded-xl border border-white/20 px-4 py-2.5 text-center text-sm text-sandstone-100"
                    >
                      Photograph anything and talk to it
                    </Link>
                  )}
                  <Link
                    href="/monuments"
                    className="w-full rounded-xl px-4 py-2 text-center text-xs text-sandstone-200/70 underline underline-offset-4"
                  >
                    Or choose the monument yourself
                  </Link>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

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
    </main>
  );
}

// ---------------------------------------------------------------------------

function stoppedCopy(reason: string | null, calls: number): string {
  switch (reason) {
    case 'exhausted':
      return `I looked ${calls} times and could not place this among the ten. It may not be one of them — you can still talk to it.`;
    case 'rate_limit':
      return 'Sarvam is rate limiting us, so I have stopped looking rather than making it worse. Try again in a minute.';
    case 'not_configured':
      return 'Recognition is not available on this deployment — no Sarvam key is configured.';
    case 'no_match':
      return 'That photograph is not one of the ten I hold. You can still talk to it, or choose a monument yourself.';
    case 'fatal':
      return 'Recognition is not working on this deployment. Choose a monument yourself, or talk to the photograph.';
    case 'paused':
      return 'Paused — the camera is off.';
    default:
      return 'Stopped looking.';
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh w-full overflow-y-auto bg-night-950">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
        <Link href="/" className="bol-chip self-start">
          ← back to the monument
        </Link>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
