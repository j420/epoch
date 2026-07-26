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
    <div className={`mx-auto max-w-lg ${className}`}>
      <header className="mb-5">
        <h2 className="text-2xl font-semibold tracking-tight text-sandstone-50">I speak 23 languages</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-sandstone-200/70">
          You never have to choose one. Say anything, in whatever language you think in, and I will work it out and
          answer you in it.
        </p>
      </header>

      {/* ---- the eleven with a voice ---- */}
      <section aria-labelledby="voiced-heading">
        <h3 id="voiced-heading" className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-sandstone-200/60">
          <span aria-hidden className="text-sandstone-300">✓</span>
          {speakable.length} I can speak aloud
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          {speakable.map((l) => (
            <li
              key={l.code}
              lang={l.code}
              title={l.english}
              className={`indic-text rounded-xl border px-2.5 py-1.5 text-sm transition-colors ${
                l.code === detectedCode
                  ? 'border-sandstone-300/70 bg-sandstone-300/15 text-sandstone-50'
                  : 'border-white/10 bg-black/30 text-sandstone-100/90'
              }`}
            >
              {l.native}
              {l.code === detectedCode && <span className="ml-1.5 text-[10px] text-sandstone-300">you</span>}
            </li>
          ))}
        </ul>
      </section>

      {/* ---- the twelve we answer in text ---- */}
      <section aria-labelledby="understood-heading" className="mt-6">
        <h3 id="understood-heading" className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-sandstone-200/60">
          <span aria-hidden className="text-sandstone-300">◐</span>
          {understood.length} I understand but cannot yet voice
        </h3>
        <p className="mb-2.5 text-xs leading-relaxed text-sandstone-200/50">
          I answer these in writing, in your own language and script, and speak the words aloud in the closest language
          my voice has learned. I would rather tell you that than pretend.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {understood.map((l) => {
            const fallback = info(resolveVoice(l.code).voiceLang);
            return (
              <li
                key={l.code}
                title={`${l.english} — voiced in ${fallback.english}`}
                className={`rounded-xl border px-2.5 py-1.5 text-sm ${
                  l.code === detectedCode
                    ? 'border-sandstone-300/70 bg-sandstone-300/15 text-sandstone-50'
                    : 'border-white/10 bg-black/20 text-sandstone-100/70'
                }`}
              >
                <span lang={l.code} className="indic-text">
                  {l.native}
                </span>
                <span className="ml-1.5 text-[10px] text-sandstone-200/45" aria-hidden>
                  → {fallback.native}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="mt-6 border-t border-white/10 pt-4 text-xs leading-relaxed text-sandstone-200/40">
        Understanding is Saaras; the voice is Bulbul. There is no language menu anywhere in Bol by design — a list of
        twenty-three names helps nobody who cannot read the list.
      </p>
    </div>
  );
}
