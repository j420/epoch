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
    <div className={`flex flex-col items-start gap-2 ${className}`}>
      <span
        className="bol-chip animate-fade-in border-sandstone-200/30 bg-black/55 py-1.5 pl-2.5 pr-3.5"
        role="status"
        aria-live="polite"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sandstone-300 shadow-[0_0_8px_rgba(226,162,113,0.9)]" />
        <span lang={lang} className="indic-text text-sm text-sandstone-50">
          {native}
        </span>
        <span className="text-[0.7rem] uppercase tracking-[0.1em] text-sandstone-200/55">{english} detected</span>
      </span>

      {notice ? (
        <span className="bol-glass indic-text animate-fade-in max-w-[17rem] px-3.5 py-2.5 text-[11px] leading-relaxed text-sandstone-200/80">
          {notice}
        </span>
      ) : null}
    </div>
  );
}

export default LanguageChip;
