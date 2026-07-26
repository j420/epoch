/**
 * Language coverage reality.
 *
 * Saaras understands 23 (22 Indian + English). Bulbul speaks 11.
 * When a visitor speaks something Bulbul cannot voice we do NOT pretend the gap
 * does not exist: we answer in text in their language, voice it in the nearest
 * supported relative, tell them honestly, and log it to the events table.
 *
 * There is no language picker anywhere in this product. Everything here is
 * driven by Saaras auto-detection on the visitor's first utterance.
 */

export type LangCode = string; // Sarvam BCP-47-ish, e.g. "ta-IN"

export interface LangInfo {
  code: LangCode;
  /** Endonym — how the language names itself. Used in UI chips. */
  native: string;
  english: string;
  script: string;
  /** Bulbul v3 can voice this language directly. */
  speakable: boolean;
  /** If not speakable, the closest language Bulbul can voice. */
  voiceFallback?: LangCode;
  /** Default Bulbul speaker for this language. */
  speaker?: string;
}

/** The 11 languages Bulbul v3 can voice. */
export const SPEAKABLE: LangCode[] = [
  'en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
];

export const LANGS: Record<LangCode, LangInfo> = {
  // ---- Bulbul-speakable ----
  'en-IN': { code: 'en-IN', native: 'English', english: 'English', script: 'Latin', speakable: true, speaker: 'anushka' },
  'hi-IN': { code: 'hi-IN', native: 'हिन्दी', english: 'Hindi', script: 'Devanagari', speakable: true, speaker: 'anushka' },
  'bn-IN': { code: 'bn-IN', native: 'বাংলা', english: 'Bengali', script: 'Bengali', speakable: true, speaker: 'anushka' },
  'gu-IN': { code: 'gu-IN', native: 'ગુજરાતી', english: 'Gujarati', script: 'Gujarati', speakable: true, speaker: 'anushka' },
  'kn-IN': { code: 'kn-IN', native: 'ಕನ್ನಡ', english: 'Kannada', script: 'Kannada', speakable: true, speaker: 'anushka' },
  'ml-IN': { code: 'ml-IN', native: 'മലയാളം', english: 'Malayalam', script: 'Malayalam', speakable: true, speaker: 'anushka' },
  'mr-IN': { code: 'mr-IN', native: 'मराठी', english: 'Marathi', script: 'Devanagari', speakable: true, speaker: 'anushka' },
  'od-IN': { code: 'od-IN', native: 'ଓଡ଼ିଆ', english: 'Odia', script: 'Odia', speakable: true, speaker: 'anushka' },
  'pa-IN': { code: 'pa-IN', native: 'ਪੰਜਾਬੀ', english: 'Punjabi', script: 'Gurmukhi', speakable: true, speaker: 'anushka' },
  'ta-IN': { code: 'ta-IN', native: 'தமிழ்', english: 'Tamil', script: 'Tamil', speakable: true, speaker: 'anushka' },
  'te-IN': { code: 'te-IN', native: 'తెలుగు', english: 'Telugu', script: 'Telugu', speakable: true, speaker: 'anushka' },

  // ---- Saaras understands, Bulbul cannot voice. Honest degradation. ----
  'as-IN':  { code: 'as-IN',  native: 'অসমীয়া',   english: 'Assamese',  script: 'Bengali-Assamese', speakable: false, voiceFallback: 'bn-IN' },
  'ur-IN':  { code: 'ur-IN',  native: 'اردو',      english: 'Urdu',      script: 'Perso-Arabic',     speakable: false, voiceFallback: 'hi-IN' },
  'sa-IN':  { code: 'sa-IN',  native: 'संस्कृतम्',  english: 'Sanskrit',  script: 'Devanagari',       speakable: false, voiceFallback: 'hi-IN' },
  'ne-IN':  { code: 'ne-IN',  native: 'नेपाली',    english: 'Nepali',    script: 'Devanagari',       speakable: false, voiceFallback: 'hi-IN' },
  'kok-IN': { code: 'kok-IN', native: 'कोंकणी',    english: 'Konkani',   script: 'Devanagari',       speakable: false, voiceFallback: 'mr-IN' },
  'mai-IN': { code: 'mai-IN', native: 'मैथिली',    english: 'Maithili',  script: 'Devanagari',       speakable: false, voiceFallback: 'hi-IN' },
  'doi-IN': { code: 'doi-IN', native: 'डोगरी',     english: 'Dogri',     script: 'Devanagari',       speakable: false, voiceFallback: 'hi-IN' },
  'ks-IN':  { code: 'ks-IN',  native: 'کٲشُر',     english: 'Kashmiri',  script: 'Perso-Arabic',     speakable: false, voiceFallback: 'ur-IN' },
  'sd-IN':  { code: 'sd-IN',  native: 'سنڌي',      english: 'Sindhi',    script: 'Perso-Arabic',     speakable: false, voiceFallback: 'hi-IN' },
  'mni-IN': { code: 'mni-IN', native: 'ꯃꯤꯇꯩꯂꯣꯟ',   english: 'Manipuri',  script: 'Meetei Mayek',     speakable: false, voiceFallback: 'bn-IN' },
  // Bodo's endonym is written बड़ो or बर' (the apostrophe marks a schwa). An earlier
  // value here was mangled to "बर-ा", which is not a word — it rendered as visible
  // nonsense the moment the coverage panel showed every language in its own script.
  'brx-IN': { code: 'brx-IN', native: 'बड़ो',   english: 'Bodo',      script: 'Devanagari',       speakable: false, voiceFallback: 'hi-IN' },
  'sat-IN': { code: 'sat-IN', native: 'ᱥᱟᱱᱛᱟᱲᱤ',   english: 'Santali',   script: 'Ol Chiki',         speakable: false, voiceFallback: 'hi-IN' },
};

export const DEFAULT_LANG: LangCode = 'hi-IN';

/** Normalise anything Saaras hands back ("ta", "ta-IN", "tam", "unknown") to a code we hold. */
export function normalizeLang(raw: string | null | undefined): LangCode {
  if (!raw) return DEFAULT_LANG;
  const s = raw.trim();
  if (LANGS[s]) return s;
  const lower = s.toLowerCase();
  if (LANGS[lower]) return lower;

  const base = lower.split(/[-_]/)[0];
  const byBase = Object.keys(LANGS).find((k) => k.split('-')[0] === base);
  if (byBase) return byBase;

  // ISO 639-2/3 three-letter forms Saaras sometimes returns.
  const iso3: Record<string, LangCode> = {
    hin: 'hi-IN', ben: 'bn-IN', guj: 'gu-IN', kan: 'kn-IN', mal: 'ml-IN', mar: 'mr-IN',
    ori: 'od-IN', ory: 'od-IN', pan: 'pa-IN', tam: 'ta-IN', tel: 'te-IN', eng: 'en-IN',
    asm: 'as-IN', urd: 'ur-IN', san: 'sa-IN', nep: 'ne-IN', kok: 'kok-IN', mai: 'mai-IN',
    doi: 'doi-IN', kas: 'ks-IN', snd: 'sd-IN', mni: 'mni-IN', brx: 'brx-IN', sat: 'sat-IN',
  };
  if (iso3[base]) return iso3[base];

  // Full English names, in case Saaras ever returns "Tamil" rather than "ta-IN".
  const byName = Object.values(LANGS).find((l) => l.english.toLowerCase() === lower);
  if (byName) return byName.code;

  /**
   * Falling through to Hindi silently is the dangerous path: if Saaras changes its
   * response shape, EVERY visitor gets answered in Hindi and nothing anywhere says
   * why. The value is still returned so the product degrades rather than crashes,
   * but it is now loud, and `isRecognisedLang` lets callers tell a real detection
   * from a fallback.
   */
  if (s && s.toLowerCase() !== 'unknown') {
    console.warn(`[langs] unrecognised language "${s}" — falling back to ${DEFAULT_LANG}. ` + `If this fires in production, Saaras' response shape has changed; check /api/sarvam/selftest.`);
  }
  return DEFAULT_LANG;
}

/** True when `raw` actually names a language we hold, rather than hitting the default. */
export function isRecognisedLang(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  const normalised = normalizeLang(raw);
  if (normalised !== DEFAULT_LANG) return true;
  // Distinguish a genuine Hindi detection from a fallback that merely landed there.
  const lower = raw.trim().toLowerCase();
  return lower === 'hi-in' || lower === 'hi' || lower === 'hin' || lower === 'hindi';
}

export function info(code: LangCode): LangInfo {
  return LANGS[normalizeLang(code)] ?? LANGS[DEFAULT_LANG];
}

export function isSpeakable(code: LangCode): boolean {
  return info(code).speakable;
}

export interface VoiceTarget {
  /** The language code we will actually hand to Bulbul. */
  voiceLang: LangCode;
  /** The language the visitor actually spoke — text is always rendered in this. */
  textLang: LangCode;
  /** True when we had to substitute a relative. UI must say so. */
  degraded: boolean;
  speaker: string;
}

/**
 * Resolve the voice we will use. Follows voiceFallback chains (ks-IN -> ur-IN -> hi-IN)
 * with a cycle guard, and never returns an unspeakable code.
 */
export function resolveVoice(code: LangCode, speakerOverride?: string): VoiceTarget {
  const textLang = normalizeLang(code);
  let cur = textLang;
  const seen = new Set<LangCode>();
  while (!LANGS[cur]?.speakable && LANGS[cur]?.voiceFallback && !seen.has(cur)) {
    seen.add(cur);
    cur = LANGS[cur].voiceFallback!;
  }
  const voiceLang = LANGS[cur]?.speakable ? cur : DEFAULT_LANG;
  return {
    voiceLang,
    textLang,
    degraded: voiceLang !== textLang,
    speaker: speakerOverride ?? LANGS[voiceLang]?.speaker ?? 'anushka',
  };
}

/**
 * The honest line the monument says when it cannot speak the visitor's tongue.
 * Written in the *visitor's* language where we have it, English otherwise.
 * Deliberately in the monument's first-person voice.
 */
export const VOICE_GAP_NOTICE: Record<string, string> = {
  'as-IN': 'মই আপোনাৰ ভাষা বুজি পাওঁ, কিন্তু মোৰ কণ্ঠ এতিয়াও অসমীয়া ক’ব নোৱাৰে — মই বাংলাত ক’ম।',
  'ur-IN': 'میں آپ کی زبان سمجھتا ہوں، مگر میری آواز ابھی اردو نہیں بول پاتی — میں ہندی میں بولوں گا۔',
  'sa-IN': 'तव भाषां जानामि, किन्तु मम कण्ठः संस्कृतं वक्तुं न शक्नोति — हिन्द्यां वदामि।',
  'ne-IN': 'म तपाईंको भाषा बुझ्छु, तर मेरो स्वरले अझै नेपाली बोल्न सक्दैन — म हिन्दीमा बोल्नेछु।',
  'kok-IN': 'हांव तुजी भास समजतां, पूण म्हजो आवाज अजून कोंकणी उलोवंक शकना — हांव मराठींत उलयतां.',
  'mai-IN': 'हम अहाँक भाषा बुझैत छी, मुदा हमर स्वर एखनो मैथिली नहि बाजि सकैत अछि — हम हिन्दीमे बाजब।',
  'ks-IN': 'میہ زانہٕ تُہنٛز زبان، مگر میۆن آواز چھُ نہٕ وُنی کٲشُر ونان — بہٕ ونہٕ ہِندی۔',
  'sd-IN': 'مان توهان جي ٻولي سمجهان ٿو، پر منهنجو آواز اڃا سنڌي نٿو ڳالهائي سگهي — مان هندي ۾ ڳالهائيندس.',
  'mni-IN': 'ꯑꯩꯅ ꯅꯍꯥꯛꯀꯤ ꯂꯣꯟ ꯈꯉꯏ, ꯑꯗꯨꯕꯨ ꯑꯩꯒꯤ ꯈꯣꯟꯅ ꯍꯧꯖꯤꯛ ꯃꯤꯇꯩꯂꯣꯟ ꯉꯥꯡꯕ ꯉꯃꯗꯦ — ꯑꯩ ꯕꯥꯡꯂꯥꯗ ꯉꯥꯡꯒꯅꯤ꯫',
  'brx-IN': 'आं नोंथांनि राव मिथिगौ, नाथाय आंनि गोरै दानि बर-ा बुङनो हायै — आं हिन्दियाव बुङगोन।',
  'sat-IN': 'ᱤᱬ ᱟᱢᱟᱜ ᱯᱟᱹᱨᱥᱤ ᱵᱩᱡᱷᱟᱹᱣᱟᱜ-ᱟ, ᱢᱮᱱᱠᱷᱟᱱ ᱤᱧᱟᱜ ᱨᱟᱲ ᱫᱚ ᱱᱤᱛᱚᱜ ᱥᱟᱱᱛᱟᱲᱤ ᱵᱟᱝ ᱨᱚᱲ ᱫᱟᱲᱮᱭᱟᱜ-ᱟ — ᱤᱧ ᱦᱤᱱᱫᱤ ᱛᱮ ᱨᱚᱲᱟ.',
};

export function voiceGapNotice(code: LangCode): string {
  const c = normalizeLang(code);
  if (VOICE_GAP_NOTICE[c]) return VOICE_GAP_NOTICE[c];
  const i = info(c);
  const fb = info(resolveVoice(c).voiceLang);
  return `I understand your ${i.english}, but my voice cannot speak it yet — I will answer in ${fb.english}.`;
}

/** "Tamil detected" chip copy. Shown AFTER the first utterance, never as a choice. */
export function detectedChip(code: LangCode): { native: string; english: string } {
  const i = info(code);
  return { native: i.native, english: i.english };
}

export const ALL_LANGS = Object.values(LANGS);
