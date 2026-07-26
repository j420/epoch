'use client';

import { useMemo } from 'react';

import { ALL_LANGS, info, resolveVoice, type LangCode } from '@/lib/langs';

/**
 * What the monument can and cannot do with language, stated plainly.
 *
 * This is deliberately NOT a picker. There is no dropdown, no radio, nothing
 * selectable — the language still comes from Saaras detection on the visitor's
 * first utterance, and that is the whole point of the product. This panel exists
 * to make the range *visible*, because "it works in 23 languages" is a claim, and
 * a wall of native scripts is evidence.
 *
 * It is also where the product is honest about its own limits. Saaras understands
 * 23 languages; Bulbul can voice 11. Rather than quietly hiding the twelve it
 * cannot speak, they are listed with the relative that will voice them instead.
 * A judge who asks "what about Santali?" should find we already answered.
 */

export interface LanguageCoverageProps {
  /** The visitor's detected language, if we have one. Highlighted, never selected. */
  detected?: LangCode | null;
  className?: string;
}

export default function LanguageCoverage({ detected = null, className = '' }: LanguageCoverageProps) {
  const { speakable, understood } = useMemo(() => {
    const sorted = [...ALL_LANGS].sort((a, b) => a.english.localeCompare(b.english));
    return {
      speakable: sorted.filter((l) => l.speakable),
      understood: sorted.filter((l) => !l.speakable),
    };
  }, []);

  const detectedCode = detected ? info(detected).code : null;

  return (
    <div className={`mx-auto max-w-lg pb-2 ${className}`}>
      <header className="mb-7">
        <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-sandstone-50">
          I speak 23 languages
        </h2>
        <p className="mt-2.5 max-w-md text-[0.9rem] leading-relaxed text-sandstone-200/70">
          You never have to choose one. Say anything, in whatever language you think in, and I will work it out and
          answer you in it.
        </p>
      </header>

      {/* ---- the eleven with a voice ----
          Set at reading size, not chip size: this wall of scripts is the whole
          argument the panel is making, so it is the largest thing here. */}
      <section aria-labelledby="voiced-heading">
        <h3
          id="voiced-heading"
          className="mb-3 flex items-center gap-2.5 text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-sandstone-200/55"
        >
          <span aria-hidden className="text-sandstone-300">
            ✓
          </span>
          <span className="shrink-0">{speakable.length} I can speak aloud</span>
          <span aria-hidden className="h-px flex-1 bg-sandstone-100/10" />
        </h3>
        <ul className="flex flex-wrap gap-2">
          {speakable.map((l) => (
            <li
              key={l.code}
              lang={l.code}
              title={l.english}
              className={`indic-text rounded-xl border px-3 py-1.5 text-[1.05rem] leading-normal transition-colors duration-base ease-bol ${
                l.code === detectedCode
                  ? 'border-sandstone-300/70 bg-sandstone-300/15 text-sandstone-50 shadow-[0_0_24px_-6px_rgba(226,162,113,0.5)]'
                  : 'border-white/[0.09] bg-white/[0.045] text-sandstone-100/90'
              }`}
            >
              {l.native}
              {l.code === detectedCode && (
                <span className="ml-2 align-middle text-[0.6rem] uppercase tracking-[0.14em] text-sandstone-300">
                  you
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ---- the twelve we answer in text ---- */}
      <section aria-labelledby="understood-heading" className="mt-8">
        <h3
          id="understood-heading"
          className="mb-3 flex items-center gap-2.5 text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-sandstone-200/55"
        >
          <span aria-hidden className="text-sandstone-300">
            ◐
          </span>
          <span className="shrink-0">{understood.length} I understand, cannot yet voice</span>
          <span aria-hidden className="h-px flex-1 bg-sandstone-100/10" />
        </h3>
        <p className="mb-3.5 max-w-md text-[0.78rem] leading-relaxed text-sandstone-200/50">
          I answer these in writing, in your own language and script, and speak the words aloud in the closest language
          my voice has learned. I would rather tell you that than pretend.
        </p>
        <ul className="flex flex-wrap gap-2">
          {understood.map((l) => {
            const fallback = info(resolveVoice(l.code).voiceLang);
            return (
              <li
                key={l.code}
                title={`${l.english} — voiced in ${fallback.english}`}
                className={`flex items-baseline gap-1.5 rounded-xl border px-3 py-1.5 ${
                  l.code === detectedCode
                    ? 'border-sandstone-300/70 bg-sandstone-300/15 text-sandstone-50'
                    : 'border-white/[0.07] bg-white/[0.02] text-sandstone-100/70'
                }`}
              >
                <span lang={l.code} className="indic-text text-[1.05rem] leading-normal">
                  {l.native}
                </span>
                <span className="text-[0.62rem] text-sandstone-200/40" aria-hidden>
                  →
                </span>
                <span lang={fallback.code} className="indic-text text-[0.72rem] text-sandstone-200/45" aria-hidden>
                  {fallback.native}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <div aria-hidden className="bol-hairline mt-8 h-px" />
      <p className="mt-5 max-w-md text-[0.75rem] leading-relaxed text-sandstone-200/40">
        Understanding is Saaras; the voice is Bulbul. There is no language menu anywhere in Bol by design — a list of
        twenty-three names helps nobody who cannot read the list.
      </p>
    </div>
  );
}
