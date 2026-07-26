import 'server-only';

import { info, normalizeLang, type LangCode } from '@/lib/langs';
import { isConfigured, translate } from '@/lib/sarvam';

/**
 * How a memory is introduced and credited.
 *
 * Three rules, all absolute:
 *   1. Never a name. We attribute a language, a month, and a city if one was given.
 *   2. Both lines are written in the LISTENER's language, not the speaker's.
 *   3. The preface is the monument's own first-person voice ("someone once told me"),
 *      because the monument is the one doing the remembering.
 *
 * Month names and the endonym of the speaker's language come from Intl, which means
 * all 23 languages get a correct month and a correct language name for free, with no
 * API call and no key. Only the sentence frame is hand-written, for the ten languages
 * most likely at a Delhi monument; anything else is translated at request time, and
 * falls back to English if translation is unavailable. Nothing here can throw.
 */

export interface Attribution {
  /** "a Bengali-speaking visitor from Kolkata, March 2026" */
  attribution: string;
  /** "A visitor from Kolkata once told me this, in Bengali." */
  preface: string;
  /** True when we could not render it in the listener's language and used English. */
  degraded: boolean;
}

/** Sarvam codes that are not the BCP-47 tag Intl expects. */
const INTL_ALIAS: Record<string, string> = { od: 'or' };

function intlLocale(code: LangCode): string {
  const c = normalizeLang(code);
  const [base, region] = c.split('-');
  const mapped = INTL_ALIAS[base] ?? base;
  return region ? `${mapped}-${region}` : mapped;
}

function baseTag(code: LangCode): string {
  const base = normalizeLang(code).split('-')[0];
  return INTL_ALIAS[base] ?? base;
}

/** The speaker's language, named in the listener's language. Falls back to English. */
export function languageName(spoken: LangCode, listener: LangCode): string {
  const tag = baseTag(spoken);
  for (const locale of [intlLocale(listener), 'en-IN', 'en']) {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(tag);
      if (name) return name;
    } catch {
      /* Intl does not know this locale — try the next one. */
    }
  }
  return info(spoken).english;
}

/** "March 2026", localised. English gets "last March" when it is genuinely recent. */
export function monthLabel(createdAt: string, listener: LangCode): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  const listenerCode = normalizeLang(listener);
  const monthsAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);

  for (const locale of [intlLocale(listenerCode), 'en-IN']) {
    try {
      if (locale.startsWith('en') && monthsAgo >= 0 && monthsAgo < 11) {
        return `last ${new Intl.DateTimeFormat(locale, { month: 'long' }).format(d)}`;
      }
      return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(d);
    } catch {
      /* next */
    }
  }
  return '';
}

interface Frame {
  attribution: (lang: string, city: string | null, when: string) => string;
  preface: (lang: string, city: string | null) => string;
}

const join = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ');

/**
 * Hand-written sentence frames. Only the frame is fixed — the language name, the
 * city and the month are substituted in, already localised.
 */
const FRAMES: Record<string, Frame> = {
  'en-IN': {
    attribution: (l, c, w) => join([`a ${l}-speaking visitor`, c ? `from ${c}` : null, w]),
    preface: (l, c) => (c ? `A visitor from ${c} once told me this, in ${l}.` : `A visitor once told me this, in ${l}.`),
  },
  'hi-IN': {
    attribution: (l, c, w) => join([`${l} बोलने वाला एक यात्री`, c, w]),
    preface: (l, c) =>
      c ? `${c} से आए एक यात्री ने मुझे ${l} में यह सुनाया था।` : `एक यात्री ने मुझे ${l} में यह सुनाया था।`,
  },
  'bn-IN': {
    attribution: (l, c, w) => join([`${l}-ভাষী একজন দর্শনার্থী`, c, w]),
    preface: (l, c) =>
      c
        ? `${c} থেকে আসা একজন দর্শনার্থী একদিন ${l} ভাষায় আমাকে এই কথা বলেছিলেন।`
        : `একজন দর্শনার্থী একদিন ${l} ভাষায় আমাকে এই কথা বলেছিলেন।`,
  },
  'ta-IN': {
    attribution: (l, c, w) => join([`${l} பேசிய ஒரு பயணி`, c, w]),
    preface: (l, c) =>
      c
        ? `${c}லிருந்து வந்த ஒரு பயணி ஒருமுறை ${l} மொழியில் இதை என்னிடம் சொன்னார்.`
        : `ஒரு பயணி ஒருமுறை ${l} மொழியில் இதை என்னிடம் சொன்னார்.`,
  },
  'te-IN': {
    attribution: (l, c, w) => join([`${l} మాట్లాడే ఒక సందర్శకుడు`, c, w]),
    preface: (l, c) =>
      c
        ? `${c} నుండి వచ్చిన ఒక సందర్శకుడు ఒకసారి ${l}లో ఇది నాకు చెప్పారు.`
        : `ఒక సందర్శకుడు ఒకసారి ${l}లో ఇది నాకు చెప్పారు.`,
  },
  'mr-IN': {
    attribution: (l, c, w) => join([`${l} बोलणारा एक प्रवासी`, c, w]),
    preface: (l, c) =>
      c
        ? `${c}हून आलेल्या एका प्रवाशाने एकदा ${l}मध्ये मला हे सांगितले होते.`
        : `एका प्रवाशाने एकदा ${l}मध्ये मला हे सांगितले होते.`,
  },
  'kn-IN': {
    attribution: (l, c, w) => join([`${l} ಮಾತನಾಡುವ ಒಬ್ಬ ಪ್ರವಾಸಿ`, c, w]),
    preface: (l, c) =>
      c
        ? `${c}ಯಿಂದ ಬಂದ ಒಬ್ಬ ಪ್ರವಾಸಿ ಒಮ್ಮೆ ${l}ನಲ್ಲಿ ಇದನ್ನು ನನಗೆ ಹೇಳಿದರು.`
        : `ಒಬ್ಬ ಪ್ರವಾಸಿ ಒಮ್ಮೆ ${l}ನಲ್ಲಿ ಇದನ್ನು ನನಗೆ ಹೇಳಿದರು.`,
  },
  'ml-IN': {
    attribution: (l, c, w) => join([`${l} സംസാരിക്കുന്ന ഒരു സന്ദർശകൻ`, c, w]),
    preface: (l, c) =>
      c
        ? `${c}ൽ നിന്നു വന്ന ഒരു സന്ദർശകൻ ഒരിക്കൽ ${l} ഭാഷയിൽ ഇത് എന്നോട് പറഞ്ഞു.`
        : `ഒരു സന്ദർശകൻ ഒരിക്കൽ ${l} ഭാഷയിൽ ഇത് എന്നോട് പറഞ്ഞു.`,
  },
  'gu-IN': {
    attribution: (l, c, w) => join([`${l} બોલતા એક પ્રવાસી`, c, w]),
    preface: (l, c) =>
      c
        ? `${c}થી આવેલા એક પ્રવાસીએ એક વાર ${l}માં મને આ કહ્યું હતું.`
        : `એક પ્રવાસીએ એક વાર ${l}માં મને આ કહ્યું હતું.`,
  },
  'pa-IN': {
    attribution: (l, c, w) => join([`${l} ਬੋਲਣ ਵਾਲਾ ਇੱਕ ਯਾਤਰੀ`, c, w]),
    preface: (l, c) =>
      c
        ? `${c} ਤੋਂ ਆਏ ਇੱਕ ਯਾਤਰੀ ਨੇ ਇੱਕ ਵਾਰ ${l} ਵਿੱਚ ਮੈਨੂੰ ਇਹ ਦੱਸਿਆ ਸੀ।`
        : `ਇੱਕ ਯਾਤਰੀ ਨੇ ਇੱਕ ਵਾਰ ${l} ਵਿੱਚ ਮੈਨੂੰ ਇਹ ਦੱਸਿਆ ਸੀ।`,
  },
};

export async function buildAttribution(opts: {
  spokenLang: LangCode;
  listenerLang: LangCode;
  city: string | null;
  createdAt: string;
}): Promise<Attribution> {
  const listener = normalizeLang(opts.listenerLang);
  const city = opts.city?.trim() ? opts.city.trim().slice(0, 60) : null;
  const when = monthLabel(opts.createdAt, listener);

  const frame = FRAMES[listener];
  if (frame) {
    const name = languageName(opts.spokenLang, listener);
    return { attribution: frame.attribution(name, city, when), preface: frame.preface(name, city), degraded: false };
  }

  // No hand-written frame for this language. Build it in English, then translate.
  const en = FRAMES['en-IN'];
  const enName = languageName(opts.spokenLang, 'en-IN');
  const enWhen = monthLabel(opts.createdAt, 'en-IN');
  const english: Attribution = {
    attribution: en.attribution(enName, city, enWhen),
    preface: en.preface(enName, city),
    degraded: true,
  };

  if (!isConfigured()) return english;

  try {
    const [attribution, preface] = await Promise.all([
      translate(english.attribution, listener, { from: 'en-IN' }),
      translate(english.preface, listener, { from: 'en-IN' }),
    ]);
    return { attribution: attribution || english.attribution, preface: preface || english.preface, degraded: false };
  } catch (err) {
    console.warn('[echo] attribution translation failed, using English:', (err as Error).message);
    return english;
  }
}
