'use client';

/**
 * The running conversation, kept deliberately quiet.
 *
 * The photograph is the interface, so this sits at low contrast and fades the
 * older turns out. It exists mostly so a visitor in a noisy courtyard, or one
 * who did not quite hear the reply, can read it — and so a judge can see that
 * the monument really answered in the visitor's language.
 */

import { useEffect, useRef } from 'react';

import type { VoiceTurn } from '@/hooks/useVoiceLoop';

export interface TranscriptRailProps {
  turns: VoiceTurn[];
  /** Show only the last N turns. The rail is glanceable, not a chat log. */
  limit?: number;
  /**
   * When TTS is unavailable the answer has to carry itself visually — this
   * renders the monument's latest line much larger.
   */
  emphasiseLatestAnswer?: boolean;
  className?: string;
}

export function TranscriptRail({
  turns,
  limit = 6,
  emphasiseLatestAnswer = false,
  className = '',
}: TranscriptRailProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const shown = turns.slice(-limit);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns.length]);

  if (shown.length === 0) return null;

  const lastMonumentId = [...shown].reverse().find((t) => t.role === 'monument')?.id ?? null;

  return (
    <div
      className={`flex max-h-[45dvh] flex-col gap-2 overflow-y-auto pr-1 ${className}`}
      aria-live="polite"
      aria-label="Conversation"
    >
      {shown.map((turn, i) => {
        const visitor = turn.role === 'visitor';
        // Older turns recede rather than disappear, so the rail reads as one thread.
        const fade = Math.max(0.35, 1 - (shown.length - 1 - i) * 0.18);
        const big = emphasiseLatestAnswer && turn.id === lastMonumentId;

        return (
          <div key={turn.id} className={`flex ${visitor ? 'justify-end' : 'justify-start'}`} style={{ opacity: fade }}>
            <p
              lang={turn.lang ?? undefined}
              className={[
                'indic-text animate-fade-in max-w-[85%] px-4 py-2.5',
                // Asymmetric corners so the thread reads as a conversation at a
                // glance without either side needing a label.
                visitor
                  ? 'rounded-[1.25rem] rounded-br-md border border-sandstone-300/20 bg-sandstone-700/45 text-sandstone-50 backdrop-blur-md'
                  : 'bol-glass rounded-[1.25rem] rounded-bl-md text-sandstone-50',
                big ? 'text-xl leading-snug sm:text-2xl' : 'text-[0.9rem]',
              ].join(' ')}
            >
              {turn.text}
              {turn.pending ? <span className="ml-1 inline-block animate-breathe">…</span> : null}
            </p>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

export default TranscriptRail;
