'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The live rear camera, and the promise that it is switched off.
 *
 * ---------------------------------------------------------------------------
 * THE TRUST PROPERTY
 * ---------------------------------------------------------------------------
 *
 * A camera light still on after the visitor has walked away from this page is
 * not a bug, it is a betrayal — and it is the single most likely way this
 * feature loses a judge. So `stop()` is idempotent, and it is wired to every
 * exit a browser has:
 *
 *   - unmount            (covers client-side route changes in the App Router,
 *                         which unmount the page component)
 *   - visibilitychange   (tab hidden, app backgrounded, screen locked)
 *   - pagehide           (bfcache, iOS Safari's real "leaving" event)
 *   - beforeunload       (desktop close / reload)
 *   - track 'ended'      (the OS or another app took the camera)
 *   - the caller, explicitly, the moment a monument is matched
 *
 * `pagehide` rather than only `beforeunload` matters: iOS Safari fires
 * `beforeunload` unreliably and puts the page in the bfcache instead, which is
 * exactly the case where a live MediaStream would keep the LED on.
 *
 * ---------------------------------------------------------------------------
 * getUserMedia REALITY
 * ---------------------------------------------------------------------------
 *
 *   - HTTPS only. `localhost` is exempt; a laptop on http://192.168.x.x is not,
 *     and that is precisely where a demo tends to live. Detected up front and
 *     said plainly rather than surfaced as a mystery permission failure.
 *   - Needs a user gesture. `start()` is never called from an effect.
 *   - iOS Safari needs `playsInline` AND `muted` on the <video> or it hijacks
 *     the screen with a fullscreen player and the overlay is gone.
 *   - It can simply be refused, or there can be no camera at all. Both are
 *     ordinary outcomes here, not errors, and both have a way forward.
 */

export type CameraStatus =
  | 'idle'
  | 'starting'
  | 'live'
  /** Stopped by us — tab hidden, or the visitor paused. Resumable. */
  | 'paused'
  /** Permission refused. */
  | 'denied'
  /** No camera on this device, or none that satisfies the constraints. */
  | 'unavailable'
  /** Not a secure context, so getUserMedia does not exist. */
  | 'insecure'
  /** Camera busy, hardware error, anything else. */
  | 'error';

export interface CameraState {
  status: CameraStatus;
  /** Honest, specific, and fixable where a fix exists. */
  message: string | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  /** MUST be called from a user gesture. */
  start: () => Promise<void>;
  stop: () => void;
  /** True when this browser could even try. */
  supported: boolean;
}

const CONSTRAINTS: MediaStreamConstraints = {
  // `ideal`, not `exact`: on a laptop there is no environment camera and an
  // exact constraint would throw OverconstrainedError instead of quietly using
  // the only camera there is. The visitor gets a working scanner either way.
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
  audio: false,
};

function describe(err: unknown): { status: CameraStatus; message: string } {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        status: 'denied',
        message:
          'The camera was not allowed. You can turn it on again in the address bar (the camera icon), or just take one photograph instead — that works exactly as well.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return {
        status: 'unavailable',
        message: 'This device has no camera we can open. Take one photograph instead, or pick a monument from the list.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        status: 'error',
        message: 'Another app is using the camera. Close it and try again, or take one photograph instead.',
      };
    case 'SecurityError':
      return {
        status: 'insecure',
        message: 'This page is not on a secure connection, so the browser will not open a camera here.',
      };
    default:
      return {
        status: 'error',
        message: `The camera would not open (${name || 'unknown reason'}). Take one photograph instead.`,
      };
  }
}

export function useCamera(): CameraState {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Set while a getUserMedia promise is in flight, so a mid-flight stop wins. */
  const abandonedRef = useRef(false);

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const ok =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      (typeof window === 'undefined' || window.isSecureContext !== false);
    setSupported(ok);
    if (!ok && typeof navigator !== 'undefined') {
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
      setStatus(insecure ? 'insecure' : 'unavailable');
      setMessage(
        insecure
          ? 'A live camera needs a secure (https) connection. This page is not on one, so the browser will not open the camera. You can still photograph the monument, or pick it from the list.'
          : 'This browser cannot open a live camera. You can still photograph the monument, or pick it from the list.',
      );
    }
  }, []);

  /**
   * Idempotent. Called from six different places, including twice in a row on
   * a fast unmount, and must be safe every time.
   */
  const stop = useCallback(() => {
    abandonedRef.current = true;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* a track already ended by the OS throws on some Androids */
        }
      }
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    }
    setStatus((s) => (s === 'live' || s === 'starting' ? 'paused' : s));
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable');
      setMessage('This browser cannot open a live camera. You can still photograph the monument, or pick it from the list.');
      return;
    }

    abandonedRef.current = false;
    setStatus('starting');
    setMessage(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    } catch (err) {
      const { status: s, message: m } = describe(err);
      setStatus(s);
      setMessage(m);
      return;
    }

    // The visitor navigated, hid the tab or hit cancel while the permission
    // prompt was up. The stream still arrived, and it must not survive.
    if (abandonedRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    streamRef.current = stream;

    // The OS handed the camera to something else, or the user revoked it from
    // the browser chrome. Reflect it instead of showing a frozen last frame.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (streamRef.current !== stream) return;
        streamRef.current = null;
        setStatus('paused');
        setMessage('The camera stopped. Tap to start it again.');
      });
    }

    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      // iOS Safari refuses to autoplay a stream unless both of these are set on
      // the element itself; the JSX sets them too, belt and braces.
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
      } catch {
        /* A rejected play() still shows frames once the element is visible. */
      }
    }

    setStatus('live');
    setMessage(null);
  }, []);

  // --- every exit a browser has --------------------------------------------

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    const onPageHide = () => stop();

    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      // Unmount — a client-side route change lands here. Stop the tracks
      // directly rather than through `stop()`, because setState on an unmounted
      // component is pointless and the tracks are the only thing that matters.
      abandonedRef.current = true;
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) for (const track of stream.getTracks()) track.stop();
    };
  }, [stop]);

  return { status, message, videoRef, start, stop, supported };
}
