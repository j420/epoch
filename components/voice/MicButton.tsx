'use client';

/**
 * The only control in the product.
 *
 * Two gestures, one button:
 *   - press and HOLD  -> records while held, sends on release (walkie-talkie)
 *   - quick TAP       -> starts recording and leaves it running; tap again to send
 *
 * They are distinguished purely by how long the pointer was down, so a visitor
 * who does not read instructions gets sensible behaviour either way.
 *
 * The live waveform is drawn straight from the AnalyserNode the voice loop owns,
 * on an animation frame, without going through React state — a 60fps waveform
 * driven by setState would re-render the whole Stage sixty times a second.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { VoiceState } from '@/hooks/useVoiceLoop';

/** Below this a pointer-down/up pair is a tap; above it, a hold. */
const HOLD_THRESHOLD_MS = 260;
const RING_BARS = 56;

export interface MicButtonProps {
  state: VoiceState;
  onStart: () => void | Promise<void>;
  onStop: () => void;
  /** From useVoiceLoop().getAnalyser — may return null before the first press. */
  getAnalyser?: () => AnalyserNode | null;
  /** Fallback meter value 0..1 when no analyser is available. */
  level?: number;
  disabled?: boolean;
  /** Diameter in px. */
  size?: number;
  /** Accessible label; defaults are English and should be overridden if you have copy. */
  label?: string;
  className?: string;
}

export function MicButton({
  state,
  onStart,
  onStop,
  getAnalyser,
  level = 0,
  disabled = false,
  size = 96,
  label,
  className = '',
}: MicButtonProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pressAtRef = useRef(0);
  /** True when the pointer went down while already recording — that press was a stop. */
  const consumedRef = useRef(false);
  const stateRef = useRef(state);
  const levelRef = useRef(level);

  stateRef.current = state;
  levelRef.current = level;

  // ---- waveform -----------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const px = size * dpr;
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }

    ctx.clearRect(0, 0, px, px);

    const active = stateRef.current === 'listening';
    const analyser = getAnalyser?.() ?? null;

    const cx = px / 2;
    const cy = px / 2;
    const base = px * 0.34;
    const maxLen = px * 0.14;

    let samples: Float32Array | null = null;
    if (analyser && active) {
      samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
    }

    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, px * 0.012);

    for (let i = 0; i < RING_BARS; i++) {
      const angle = (i / RING_BARS) * Math.PI * 2 - Math.PI / 2;

      let amp: number;
      if (samples) {
        // Bucket the time-domain window into one RMS value per bar.
        const per = Math.floor(samples.length / RING_BARS);
        let sum = 0;
        for (let j = 0; j < per; j++) {
          const v = samples[i * per + j];
          sum += v * v;
        }
        amp = Math.min(1, Math.sqrt(sum / Math.max(1, per)) * 7);
      } else {
        // No analyser yet (or not recording): a calm breathing ring, so the
        // control never looks broken.
        const t = performance.now() / 700;
        amp = active ? Math.max(0.08, levelRef.current) : 0.06 + 0.04 * Math.sin(t + i * 0.35);
      }

      const len = maxLen * (0.15 + amp * 0.85);
      const x1 = cx + Math.cos(angle) * base;
      const y1 = cy + Math.sin(angle) * base;
      const x2 = cx + Math.cos(angle) * (base + len);
      const y2 = cy + Math.sin(angle) * (base + len);

      ctx.strokeStyle = active
        ? `rgba(226, 162, 113, ${0.35 + amp * 0.6})`
        : 'rgba(248, 230, 212, 0.18)';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }, [getAnalyser, size]);

  useEffect(() => {
    // Honour reduced motion: draw one static frame instead of animating.
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      draw();
      return;
    }
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      draw();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [draw]);

  // ---- gestures -----------------------------------------------------------

  const handleDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pressAtRef.current = performance.now();

      if (stateRef.current === 'listening') {
        // Second tap of a tap-to-toggle. Send it.
        consumedRef.current = true;
        onStop();
        return;
      }
      consumedRef.current = false;
      void onStart();
    },
    [disabled, onStart, onStop],
  );

  const handleUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      event.preventDefault();
      if (consumedRef.current) {
        consumedRef.current = false;
        return;
      }
      // Held long enough to be a hold -> release ends the utterance.
      // Too short -> it was a tap, so leave the mic open until the next tap.
      if (performance.now() - pressAtRef.current >= HOLD_THRESHOLD_MS) onStop();
    },
    [disabled, onStop],
  );

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (event.repeat) return;
      if (stateRef.current === 'listening') onStop();
      else void onStart();
    },
    [disabled, onStart, onStop],
  );

  const listening = state === 'listening';
  const busy = state === 'thinking';

  return (
    <div className={`relative inline-flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ width: size, height: size }}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={label ?? (listening ? 'Stop and send' : 'Hold to speak')}
        aria-pressed={listening}
        data-state={state}
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onKeyDown={handleKey}
        onContextMenu={(e) => e.preventDefault()}
        className={[
          'relative flex items-center justify-center rounded-full border transition-transform duration-150',
          'touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-sandstone-200/70',
          listening
            ? 'scale-95 border-sandstone-300/70 bg-sandstone-500/85 animate-listen-pulse'
            : 'border-white/15 bg-black/45 backdrop-blur-md',
          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer active:scale-95',
        ].join(' ')}
        style={{ width: size * 0.62, height: size * 0.62 }}
      >
        {busy ? <ThinkingDots /> : <MicGlyph size={size * 0.28} listening={listening} />}
      </button>
    </div>
  );
}

function MicGlyph({ size, listening }: { size: number; listening: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={listening ? '#1a0f08' : '#f8e6d4'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  );
}

function ThinkingDots() {
  return (
    <span className="flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-sandstone-100/80 animate-breathe"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

export default MicButton;
