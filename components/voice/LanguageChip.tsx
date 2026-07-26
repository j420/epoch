'use client';

/**
 * CONFIRMATION, NOT CHOICE.
 *
 * This component exists to tell a visitor "I heard Tamil" after they have
 * already spoken. It has no click handler, no list, no <select>, and it must
 * never grow one — rule 2 of the build contract. If you find yourself adding an
 * onChange here, the correct fix is upstream: Saaras detected the wrong
 * language and the STT call needs looking at.
 *
 * It renders nothing until a language has actually been detected, so the first
 * thing a visitor sees is never a language decision.
 */

import { detectedChip } from '@/lib/langs';

export interface LanguageChipProps {
  /** Detected language code, or null before the first utterance. */
  lang: string | null;
  /**
   * The honest line from voiceGapNotice() when Bulbul cannot speak this
   * language and we substituted a relative. Shown, not hidden.
   */
  notice?: string | null;
  className?: string;
}

export function LanguageChip({ lang, notice = null, className = '' }: LanguageChipProps) {
  if (!lang) return null;
  const { native, english } = detectedChip(lang);

  return (
    <div className={`flex flex-col items-start gap-1.5 ${className}`}>
      <span className="bol-chip indic-text" role="status" aria-live="polite">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sandstone-300" />
        <span>{native}</span>
        <span className="text-sandstone-200/50">· {english} detected</span>
      </span>

      {notice ? (
        <span className="bol-glass indic-text max-w-xs px-3 py-2 text-[11px] leading-relaxed text-sandstone-200/75">
          {notice}
        </span>
      ) : null}
    </div>
  );
}

export default LanguageChip;
