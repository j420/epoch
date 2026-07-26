'use client';

/**
 * Dev-only latency HUD: the build contract's budget against what actually
 * happened, per stage, every turn.
 *
 *   Saaras 150ms | routing 200ms | retrieval 50ms | generation 600ms | Bulbul 200ms
 *   target: under 1.2s speech to speech
 *
 * It renders nothing in a production build unless `force` is set, so it can
 * safely be left mounted in the Stage.
 */

import { LATENCY_BUDGET } from '@/hooks/useVoiceLoop';
import type { StageTimings } from '@/lib/types';

const STAGES: { key: keyof StageTimings; label: string }[] = [
  { key: 'stt', label: 'Saaras' },
  { key: 'route', label: 'routing' },
  { key: 'retrieve', label: 'retrieval' },
  { key: 'generate', label: 'generation' },
  { key: 'tts', label: 'Bulbul' },
];

export interface LatencyHUDProps {
  timings: StageTimings;
  budget?: Record<string, number>;
  /** Render even in production (the debug page uses this). */
  force?: boolean;
  className?: string;
}

export function LatencyHUD({ timings, budget = LATENCY_BUDGET, force = false, className = '' }: LatencyHUDProps) {
  if (!force && process.env.NODE_ENV === 'production') return null;

  const total = timings.total ?? 0;
  const totalBudget = budget.total ?? LATENCY_BUDGET.total;
  const overall = total > 0 ? total <= totalBudget : true;

  return (
    <div className={`bol-glass w-56 p-3 font-mono text-[10px] leading-tight text-sandstone-100/85 ${className}`}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="tracking-widest text-sandstone-200/50">LATENCY</span>
        <span className={overall ? 'text-emerald-300' : 'text-amber-300'}>
          {total ? `${total}ms` : '—'} / {totalBudget}ms
        </span>
      </div>

      <ul className="space-y-1.5">
        {STAGES.map(({ key, label }) => {
          const actual = timings[key];
          const target = budget[key] ?? 0;
          const has = typeof actual === 'number';
          // Bars are scaled against 2x budget so an overrun is visibly an overrun
          // rather than just a full bar.
          const pct = has && target ? Math.min(100, (actual / (target * 2)) * 100) : 0;
          const over = has && target > 0 && actual > target;

          return (
            <li key={key}>
              <div className="flex items-baseline justify-between">
                <span className="text-sandstone-200/60">{label}</span>
                <span className={over ? 'text-amber-300' : 'text-sandstone-100/80'}>
                  {has ? `${Math.round(actual)}` : '—'}
                  <span className="text-sandstone-200/35">/{target}</span>
                </span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${over ? 'bg-amber-400/80' : 'bg-sandstone-300/80'}`}
                  style={{ width: `${pct}%` }}
                />
                {/* The 50% mark is exactly the budget, given the 2x scale. */}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default LatencyHUD;
