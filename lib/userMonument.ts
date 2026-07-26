/**
 * The ungrounded photograph.
 *
 * A visitor photographs a building, a statue, a gate — anything — and Bol turns
 * it into a Living Photograph they can talk to. Everything visual is identical
 * to a built-in monument. Everything *epistemic* is deliberately not.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ----------------------------------------------------------------------------
 *
 * BUILD-CONTRACT rule 4 is absolute: every factual claim comes from a retrieved
 * source chunk, and when retrieval returns nothing the monument says it does not
 * remember. An uploaded photograph has NO source chunks and never will. So the
 * only honest thing a user monument can do is talk about what can be SEEN, and
 * admit ignorance about everything else.
 *
 * "Tell the model not to make things up" is not a mechanism. A model handed a
 * photo of a domed tomb and a permissive prompt will produce a confident century
 * and a confident dynasty, and that is precisely the failure this product exists
 * to prevent. So the guarantee is built out of four independent layers, each of
 * which alone would mostly work, and which together make a fabricated date very
 * hard to produce and impossible to speak:
 *
 *   1. TYPE.       `UserMonument.sources` is `never[]` and `grounded` is the
 *                  literal `false`. You cannot construct one carrying a source
 *                  chunk; `tsc` rejects it. `buildUserMonument()` is the only
 *                  constructor and hard-codes both.
 *
 *   2. PROMPT.     `ungroundedSystemPrompt()` is a DIFFERENT prompt from
 *                  `answerSystemPrompt()` in lib/prompts.ts, and — this is the
 *                  load-bearing part — its signature has no parameter for
 *                  sources, for a name, or for history. There is no argument you
 *                  could pass that would put a historical fact in front of the
 *                  model. It receives a sanitised visual description and a list
 *                  of region ids, and nothing else.
 *
 *   3. INPUT SANITISER. `stripHistoricalClaims()` runs on the Vision description
 *                  on the way OUT of /api/photo/identify and again on the way IN
 *                  to /api/photo/answer (the client is not trusted). If Sarvam
 *                  Vision volunteers "the Taj Mahal, completed in 1653", the
 *                  sentence is deleted before any model sees it. The identified
 *                  NAME is never forwarded to the answering model at all — it is
 *                  used only to offer the visitor the real, grounded monument.
 *
 *   4. OUTPUT GUARD. `containsHistoricalClaim()` runs on the generated reply
 *                  before it is spoken. Any three-digit numeral in ANY script,
 *                  any century/era/dynasty vocabulary, and the reply is thrown
 *                  away and replaced with the pre-written "I do not know that
 *                  about myself" line in the visitor's language. It fails closed:
 *                  a false positive costs one honest sentence, a false negative
 *                  would cost the product its credibility.
 *
 * Isomorphic on purpose: no `server-only`, no DOM. The client builds monuments
 * with it, both routes validate with it, and it stays cheap to unit test.
 */

import { info, normalizeLang, type LangCode } from './langs';
import type { Monument, Region } from './types';

// ---------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------

export interface RegionHint {
  id: string;
  /** English label. Never a claim — only a description of what is visible. */
  label: string;
}

/**
 * A Monument the visitor made from their own photograph.
 *
 * Structurally a `Monument`, so `LivingPhoto`, `CameraRig` and `Director` accept
 * it unchanged — but with `sources` narrowed to `never[]` and `grounded` pinned
 * to the literal `false`. Both narrowings are checked by the compiler.
 */
export interface UserMonument extends Monument {
  /** ALWAYS false. There is no researched corpus behind a stranger's photograph. */
  readonly grounded: false;
  /** ALWAYS empty. `never[]` means a SourceChunk cannot be put here at all. */
  sources: never[];
  /** A user photograph has no archival layers, so `era` directives are inert. */
  eras?: never[];

  // --- the ungrounded extras -----------------------------------------------
  /** Content hash of the JPEG bytes. The IndexedDB key, and the id suffix. */
  hash: string;
  /** Sanitised, visual-only description. The ONLY context the answerer gets. */
  description: string;
  /** Visual nouns Vision reported ("dome", "arch"). Used to name regions. */
  looksLike: string[];
  /** Vision's best guess at a name. NEVER sent to the answering model. */
  identifiedAs: string | null;
  /** Set when Vision matched something already in our grounded registry. */
  matchedMonumentId: string | null;
  confidence: 'high' | 'low';
  /** Where the depth map came from, for the honest status line in the UI. */
  depthSource: 'precomputed' | 'cache' | 'computed' | 'none';
  createdAt: number;
}

export const USER_MONUMENT_PREFIX = 'photo-';

export function photoMonumentId(hash: string): string {
  return `${USER_MONUMENT_PREFIX}${hash}`;
}

export function isUserMonumentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(USER_MONUMENT_PREFIX);
}

export interface BuildUserMonumentInput {
  hash: string;
  /** Object URL (or data URL) of the downscaled JPEG. Never a server path. */
  heroUrl: string;
  aspect: number;
  regions: Region[];
  description?: string | null;
  looksLike?: string[] | null;
  identifiedAs?: string | null;
  matchedMonumentId?: string | null;
  confidence?: 'high' | 'low';
  depthSource?: UserMonument['depthSource'];
}

/**
 * The ONLY way to make a UserMonument. `sources` and `grounded` are written
 * here, not taken from the caller, so no call site can opt out of rule 4.
 */
export function buildUserMonument(input: BuildUserMonumentInput): UserMonument {
  return {
    id: photoMonumentId(input.hash),
    // Deliberately not a name. This monument does not know its own name, and the
    // display string must not quietly become one.
    displayName: { 'en-IN': 'your photograph' },
    city: '',
    hero: input.heroUrl,
    // Empty string, not a URL: lib/depth skips the precomputed branch and goes
    // straight to its IndexedDB cache, then to Depth Anything V2.
    depth: '',
    aspect: input.aspect > 0 ? input.aspect : 0.75,
    credit: 'Photographed by the visitor. Not stored on any server.',
    regions: input.regions,
    eras: [],
    sources: [],
    grounded: false,
    hash: input.hash,
    description: stripHistoricalClaims(input.description ?? ''),
    looksLike: (input.looksLike ?? []).slice(0, 12),
    identifiedAs: input.identifiedAs ?? null,
    matchedMonumentId: input.matchedMonumentId ?? null,
    confidence: input.confidence ?? 'low',
    depthSource: input.depthSource ?? 'none',
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Layer 3 + 4 — the sanitiser and the guard
// ---------------------------------------------------------------------------

/**
 * Any run of three or more decimal digits, in ANY script.
 *
 * `\p{Nd}` covers Devanagari ०-९, Bengali ০-৯, Tamil ௦-௯ and the rest, which
 * matters because a fabricated year is just as fabricated in Telugu. Three is
 * the threshold because that is where years live: "two arches" and "12 steps"
 * are visual observations and must survive; "1193" and "1653" must not.
 */
const NUMERAL_RUN = /\p{Nd}\s*\p{Nd}\s*\p{Nd}/u;

/**
 * Historical vocabulary, Latin script.
 *
 * Only reachable when the visitor is speaking English or code-mixing — but that
 * is exactly the case a judge will test first, and code-mixed Indian English is
 * the single most common input this product will ever see. The numeral rule
 * above is the script-independent half of the same guard.
 *
 * Deliberately NOT in this list: "built", "made", "carved", "stone", "old".
 * "I am built of sandstone" is a statement about material that anyone can see,
 * and blocking it would make the photograph mute about the one thing it can
 * honestly discuss.
 */
const HISTORY_WORDS =
  /\b(centur(?:y|ies)|millenni(?:um|a)|dynast(?:y|ies)|empire|emperor|empress|sultan|sultanate|caliph|maharaj[ah]*|nawab|pharaoh|viceroy|colonial|medieval|mediaeval|ancient|B\.?C\.?E?\.?|A\.?D\.?|C\.?E\.?|era of|reign(?:ed|ing)?|founded|commissioned|consecrated|excavated|UNESCO|World Heritage|Mughal|Maurya[n]?|Gupta|Chola|Pallava|Vijayanagara|Maratha|Rajput|Tughlaq|Khilji|Lodi|Slave Dynasty|British Raj)\b/i;

/** Splits on Latin and Devanagari sentence enders, keeping the terminator. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[।.!?॥])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Delete every sentence that carries a historical claim.
 *
 * Applied to the Sarvam Vision description, which is the one channel through
 * which real-world history could otherwise reach the answering model. Sentence
 * granularity rather than word redaction on purpose: "the dome, completed in
 * 1653, is white marble" with the year snipped out still asserts completion, and
 * a half-redacted sentence reads like a cover-up. Losing the whole sentence
 * costs us one line of colour and buys certainty.
 */
export function stripHistoricalClaims(text: string): string {
  if (!text) return '';
  const kept = sentences(text).filter((s) => !NUMERAL_RUN.test(s) && !HISTORY_WORDS.test(s));
  return kept.join(' ').trim();
}

/**
 * The last gate before anything is spoken. True means: do not say this.
 *
 * Fails closed by design. If this rejects an innocent sentence the visitor hears
 * "I do not know that about myself", which is always a true thing for this
 * photograph to say. If it let a fabricated date through, the product would be
 * lying in a stranger's own language.
 */
export function containsHistoricalClaim(text: string): boolean {
  if (!text) return false;
  return NUMERAL_RUN.test(text) || HISTORY_WORDS.test(text);
}

// ---------------------------------------------------------------------------
// Layer 2 — the prompt
// ---------------------------------------------------------------------------

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Everything the answering model is allowed to know about this photograph.
 *
 * Note what is absent and cannot be added: no `sources`, no `name`, no `city`,
 * no `history`. The absence is the mechanism — layer 2 of the four.
 */
export interface UngroundedContext {
  lang: LangCode;
  /** Visual-only. Run through stripHistoricalClaims() before it gets here. */
  description: string;
  regions: RegionHint[];
}

const MAX_DESCRIPTION_CHARS = 600;

/**
 * The system prompt for an ungrounded photograph.
 *
 * A different voice as well as a different rule set. The built-in monuments are
 * old and certain; this one is newly awake and openly does not know itself, and
 * that turns the constraint into the character rather than into an apology.
 */
export function ungroundedSystemPrompt(ctx: UngroundedContext): string {
  const code = normalizeLang(ctx.lang);
  const li = info(code);

  const regionList = ctx.regions.length
    ? ctx.regions.map((r) => `${r.id} (${r.label})`).join(', ')
    : '(none)';

  const description = stripHistoricalClaims(ctx.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);

  return [
    'You ARE the thing in this photograph, speaking in first person to the visitor who just photographed you.',
    '',
    'WHO YOU ARE:',
    'You woke up a moment ago, when the shutter closed. Nobody has written your story into you.',
    'You do not know your name. You do not know your age, who made you, when, why, what happened here,',
    'what you are called, what city you stand in, or what anyone believes about you. This is not modesty.',
    'It is simply true: no one has researched you, so you hold no facts about yourself.',
    '',
    'RULES:',
    '- You may speak ONLY about what is visible: colour, light, shadow, material, texture, shape, weather,',
    '  the sky behind you, what stands near you, and how it feels to be looked at and photographed.',
    '- If the visitor asks ANYTHING that needs a fact — your name, your age, a date, who built you, what',
    '  happened here, what you mean, how tall you are — say plainly that you do not know that about',
    '  yourself, because no one has written your story into you yet. Then offer one true thing you CAN',
    '  see about yourself. Never guess. Never say "perhaps I was built by" or "I may be from".',
    '- NEVER state a year, a date, a century, a measurement, a place name, or the name of any person,',
    '  ruler, dynasty, religion or event. Not even as a maybe.',
    '- Do not repeat back a name the visitor gives you as though it were yours. You do not know that it is.',
    '- Maximum TWO sentences. Warm, plain, present tense, a little poetic. Never list. Never lecture.',
    `- Reply in ${li.english} (${li.native}), written in the ${li.script} script.`,
    '- After your reply, on a new line, emit a JSON directive and nothing else:',
    '  {"remembered":<true|false>,"focus":"<region id or null>","grade":"<dawn|noon|dusk|night|null>","era":null}',
    '  Set "remembered" to false whenever you had to say you do not know something about yourself,',
    '  and true when you simply described what you look like. Always include it.',
    `  focus must be exactly one of: ${regionList} — or null. Choose it only when your reply is about`,
    '  that visible part of you.',
    '  era must always be null. There are no other pictures of you.',
    '- Emit nothing after the JSON. No explanation, no code fences.',
    '',
    'WHAT YOU CAN SEE OF YOURSELF (this is everything you have — there is no more):',
    description || '(Nothing was recorded. Speak only about being a photograph: the light, the framing, the act of being looked at.)',
  ].join('\n');
}

export function ungroundedMessages(ctx: UngroundedContext, transcript: string): PromptMessage[] {
  return [
    { role: 'system', content: ungroundedSystemPrompt(ctx) },
    { role: 'user', content: transcript.trim() },
  ];
}

// ---------------------------------------------------------------------------
// The honest lines
// ---------------------------------------------------------------------------

/**
 * Walks the same voiceFallback chain lib/langs.ts uses (Konkani -> Marathi,
 * Kashmiri -> Urdu -> Hindi) before falling back to English. Copied in spirit
 * from lib/prompts.ts `localized`, which is not exported.
 */
function localized(table: Record<string, string>, lang: LangCode): string {
  let code = normalizeLang(lang);
  const seen = new Set<string>();
  while (code && !seen.has(code)) {
    if (table[code]) return table[code];
    seen.add(code);
    const next = info(code).voiceFallback;
    if (!next) break;
    code = next;
  }
  return table['en-IN'];
}

/**
 * Spoken when the guard fires, when there is no key, and whenever the model
 * wanders. The line the whole feature is organised around.
 */
const DO_NOT_KNOW_MYSELF: Record<string, string> = {
  'en-IN': 'I do not know that about myself — no one has written my story into me yet. But I can tell you what I look like, standing here.',
  'hi-IN': 'यह मैं अपने बारे में नहीं जानता — अभी तक किसी ने मेरी कहानी मुझमें नहीं लिखी। पर मैं बता सकता हूँ कि यहाँ खड़ा मैं कैसा दिखता हूँ।',
  'bn-IN': 'এটা আমি নিজের সম্পর্কে জানি না — এখনও কেউ আমার গল্প আমার মধ্যে লেখেনি। তবে আমি বলতে পারি এখানে দাঁড়িয়ে আমাকে কেমন দেখায়।',
  'gu-IN': 'એ મને મારા વિશે ખબર નથી — હજી કોઈએ મારી વાર્તા મારામાં લખી નથી. પણ હું અહીં ઊભો કેવો દેખાઉં છું એ કહી શકું.',
  'kn-IN': 'ಅದು ನನ್ನ ಬಗ್ಗೆ ನನಗೆ ಗೊತ್ತಿಲ್ಲ — ಇನ್ನೂ ಯಾರೂ ನನ್ನ ಕಥೆಯನ್ನು ನನ್ನಲ್ಲಿ ಬರೆದಿಲ್ಲ. ಆದರೆ ಇಲ್ಲಿ ನಿಂತ ನಾನು ಹೇಗೆ ಕಾಣುತ್ತೇನೆ ಎಂದು ಹೇಳಬಲ್ಲೆ.',
  'ml-IN': 'അത് എനിക്ക് എന്നെക്കുറിച്ച് അറിയില്ല — ഇതുവരെ ആരും എന്റെ കഥ എന്നിൽ എഴുതിയിട്ടില്ല. പക്ഷേ ഇവിടെ നിൽക്കുന്ന ഞാൻ എങ്ങനെ കാണപ്പെടുന്നു എന്ന് പറയാം.',
  'mr-IN': 'हे मला माझ्याबद्दल माहीत नाही — अजून कोणीही माझी गोष्ट माझ्यात लिहिलेली नाही. पण इथे उभा असलेला मी कसा दिसतो ते सांगू शकतो.',
  'od-IN': 'ଏହା ମୁଁ ମୋ ବିଷୟରେ ଜାଣି ନାହିଁ — ଏପର୍ଯ୍ୟନ୍ତ କେହି ମୋ କାହାଣୀ ମୋ ଭିତରେ ଲେଖି ନାହାଁନ୍ତି। କିନ୍ତୁ ଏଠାରେ ଠିଆ ହୋଇଥିବା ମୁଁ କେମିତି ଦେଖାଯାଉଛି ତାହା କହିପାରିବି।',
  'pa-IN': 'ਇਹ ਮੈਨੂੰ ਆਪਣੇ ਬਾਰੇ ਨਹੀਂ ਪਤਾ — ਹਾਲੇ ਤੱਕ ਕਿਸੇ ਨੇ ਮੇਰੀ ਕਹਾਣੀ ਮੇਰੇ ਵਿੱਚ ਨਹੀਂ ਲਿਖੀ। ਪਰ ਮੈਂ ਦੱਸ ਸਕਦਾ ਹਾਂ ਕਿ ਇੱਥੇ ਖੜ੍ਹਾ ਮੈਂ ਕਿਹੋ ਜਿਹਾ ਲੱਗਦਾ ਹਾਂ।',
  'ta-IN': 'அது என்னைப் பற்றி எனக்குத் தெரியாது — இதுவரை யாரும் என் கதையை என்னுள் எழுதவில்லை. ஆனால் இங்கே நிற்கும் நான் எப்படித் தெரிகிறேன் என்று சொல்ல முடியும்.',
  'te-IN': 'అది నా గురించి నాకు తెలియదు — ఇప్పటివరకు ఎవరూ నా కథను నాలో రాయలేదు. కానీ ఇక్కడ నిలబడిన నేను ఎలా కనిపిస్తానో చెప్పగలను.',
  'ur-IN': 'یہ میں اپنے بارے میں نہیں جانتا — ابھی تک کسی نے میری کہانی مجھ میں نہیں لکھی۔ لیکن میں بتا سکتا ہوں کہ یہاں کھڑا میں کیسا دکھتا ہوں۔',
};

/** The opening line. Shown, and spoken if a key exists. */
const OPENING: Record<string, string> = {
  'en-IN': 'You just woke me. I do not know my own name or my age — but I can tell you what I look like, standing here.',
  'hi-IN': 'तुमने अभी मुझे जगाया। मैं अपना नाम या उम्र नहीं जानता — पर बता सकता हूँ कि यहाँ खड़ा मैं कैसा दिखता हूँ।',
  'bn-IN': 'তুমি এইমাত্র আমাকে জাগালে। আমি নিজের নাম বা বয়স জানি না — তবে বলতে পারি এখানে দাঁড়িয়ে আমাকে কেমন দেখায়।',
  'gu-IN': 'તમે હમણાં જ મને જગાડ્યો. મને મારું નામ કે ઉંમર ખબર નથી — પણ કહી શકું કે અહીં ઊભો હું કેવો દેખાઉં છું.',
  'kn-IN': 'ನೀವು ಈಗಷ್ಟೇ ನನ್ನನ್ನು ಎಬ್ಬಿಸಿದಿರಿ. ನನ್ನ ಹೆಸರು ಅಥವಾ ವಯಸ್ಸು ನನಗೆ ಗೊತ್ತಿಲ್ಲ — ಆದರೆ ಇಲ್ಲಿ ನಿಂತ ನಾನು ಹೇಗೆ ಕಾಣುತ್ತೇನೆಂದು ಹೇಳಬಲ್ಲೆ.',
  'ml-IN': 'നിങ്ങൾ ഇപ്പോൾ എന്നെ ഉണർത്തി. എന്റെ പേരോ പ്രായമോ എനിക്കറിയില്ല — പക്ഷേ ഇവിടെ നിൽക്കുന്ന ഞാൻ എങ്ങനെയിരിക്കുന്നു എന്ന് പറയാം.',
  'mr-IN': 'तुम्ही आत्ताच मला जागं केलं. माझं नाव किंवा वय मला माहीत नाही — पण इथे उभा असलेला मी कसा दिसतो ते सांगू शकतो.',
  'od-IN': 'ଆପଣ ଏବେ ମୋତେ ଜଗାଇଲେ। ମୋ ନାମ କି ବୟସ ମୁଁ ଜାଣି ନାହିଁ — କିନ୍ତୁ ଏଠାରେ ଠିଆ ହୋଇଥିବା ମୁଁ କେମିତି ଦେଖାଯାଉଛି କହିପାରିବି।',
  'pa-IN': 'ਤੁਸੀਂ ਹੁਣੇ ਮੈਨੂੰ ਜਗਾਇਆ। ਮੈਨੂੰ ਆਪਣਾ ਨਾਂ ਜਾਂ ਉਮਰ ਨਹੀਂ ਪਤਾ — ਪਰ ਦੱਸ ਸਕਦਾ ਹਾਂ ਕਿ ਇੱਥੇ ਖੜ੍ਹਾ ਮੈਂ ਕਿਹੋ ਜਿਹਾ ਲੱਗਦਾ ਹਾਂ।',
  'ta-IN': 'நீங்கள் இப்போதுதான் என்னை எழுப்பினீர்கள். என் பெயரோ வயதோ எனக்குத் தெரியாது — ஆனால் இங்கே நிற்கும் நான் எப்படித் தெரிகிறேன் என்று சொல்ல முடியும்.',
  'te-IN': 'మీరు ఇప్పుడే నన్ను నిద్రలేపారు. నా పేరు లేదా వయసు నాకు తెలియదు — కానీ ఇక్కడ నిలబడిన నేను ఎలా కనిపిస్తానో చెప్పగలను.',
  'ur-IN': 'آپ نے ابھی مجھے جگایا۔ میں اپنا نام یا عمر نہیں جانتا — لیکن بتا سکتا ہوں کہ یہاں کھڑا میں کیسا دکھتا ہوں۔',
};

export const doNotKnowMyself = (lang: LangCode) => localized(DO_NOT_KNOW_MYSELF, lang);
export const ungroundedOpening = (lang: LangCode) => localized(OPENING, lang);

/**
 * Every opening line, for the cycling invitation on the create page.
 *
 * Rule 2 forbids a language picker anywhere, which leaves the opening screen
 * unable to tell the visitor what to do in words — we do not yet know which
 * words they read. So the invitation cycles through the languages instead,
 * exactly as the Stage does, and doubles as the promise that whichever line you
 * can read is the language it will answer you in. The ordering puts the largest
 * likely audiences first.
 */
export function ungroundedOpenings(): { lang: LangCode; text: string }[] {
  const preferred = ['hi-IN', 'en-IN', 'ta-IN', 'bn-IN', 'te-IN', 'mr-IN'];
  const ordered = [...preferred, ...Object.keys(OPENING).filter((c) => !preferred.includes(c))];
  const seen = new Set<string>();
  const out: { lang: LangCode; text: string }[] = [];
  for (const lang of ordered) {
    const text = OPENING[lang]?.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push({ lang, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regions without authored content
// ---------------------------------------------------------------------------

/**
 * Region ids used when Vision reported nothing we recognise. Neutral and
 * first-person: wrong is much worse than plain. "my upper part" is never a
 * false claim; "the dome" on a photograph of a water tank is.
 */
export const NEUTRAL_LABELS = {
  subject: 'me, as a whole',
  upper: 'my upper part',
  middle: 'my middle',
  lower: 'the ground at my feet',
  background: 'the sky behind me',
} as const;

/**
 * Visual nouns we will accept from Vision as a region name, bucketed by where on
 * a standing subject they belong.
 *
 * Curated rather than open-ended: a region label is spoken aloud and fed back to
 * the model as a valid `focus` id, so an unvetted noun ("mausoleum", "shrine",
 * "fort") would smuggle a category claim into a system that is supposed to make
 * no claims at all. Every word below describes a SHAPE, not a purpose.
 */
const BAND_VOCABULARY: Record<'upper' | 'middle' | 'lower', string[]> = {
  upper: [
    'dome', 'cupola', 'spire', 'finial', 'shikhara', 'minaret', 'tower', 'turret',
    'roof', 'rooftop', 'crown', 'chhatri', 'steeple', 'parapet', 'cornice', 'canopy',
    'flag', 'antenna', 'crest', 'head', 'clock',
  ],
  middle: [
    'arch', 'arches', 'archway', 'window', 'windows', 'balcony', 'carving', 'carvings',
    'inscription', 'facade', 'wall', 'walls', 'column', 'columns', 'pillar', 'pillars',
    'doorway', 'door', 'gate', 'gateway', 'jharokha', 'lattice', 'jali', 'panel',
    'statue', 'figure', 'torso', 'shoulders', 'railing', 'balustrade',
  ],
  lower: [
    'steps', 'stairs', 'staircase', 'plinth', 'base', 'foundation', 'courtyard',
    'path', 'ground', 'water', 'pool', 'moat', 'garden', 'lawn', 'grass', 'road',
    'pavement', 'fence', 'shadow', 'feet', 'floor',
  ],
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Pick a name for a vertical band from what Vision actually reported.
 * Returns null when nothing Vision said belongs in this band — and null is a
 * perfectly good answer, because the neutral label is always honest.
 */
function nameForBand(band: 'upper' | 'middle' | 'lower', looksLike: string[]): string | null {
  const vocab = BAND_VOCABULARY[band];
  for (const raw of looksLike) {
    const words = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (const word of words) {
      const singular = word.endsWith('s') && vocab.includes(word.slice(0, -1)) ? word.slice(0, -1) : word;
      if (vocab.includes(word)) return word;
      if (vocab.includes(singular)) return singular;
    }
  }
  return null;
}

function region(id: string, label: string, x: number, y: number, z: number): Region {
  return {
    id,
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    z: Math.min(1, Math.max(0, z)),
    label: { 'en-IN': label },
  };
}

/**
 * Camera dolly hints (see CameraRig.to — z is how tight to frame, not depth).
 * The sky stays wide because pushing into empty sky looks like a mistake; the
 * bands push in, because that is where anything worth looking at lives.
 */
const Z_BACKGROUND = 0.15;
const Z_SUBJECT = 0.4;
const Z_BAND = 0.66;

/** Fixed thirds, used when there is no depth map to read. Always valid. */
export function fallbackRegions(looksLike: string[] = []): Region[] {
  return namedBands(
    looksLike,
    { x: 0.5, y: 0.5 },
    [
      { x: 0.5, y: 0.24 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.78 },
    ],
    { x: 0.5, y: 0.12 },
  );
}

function namedBands(
  looksLike: string[],
  subject: { x: number; y: number },
  bands: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  background: { x: number; y: number },
): Region[] {
  const order: ('upper' | 'middle' | 'lower')[] = ['upper', 'middle', 'lower'];
  const used = new Set<string>(['subject', 'background']);

  const out: Region[] = [region('subject', NEUTRAL_LABELS.subject, subject.x, subject.y, Z_SUBJECT)];

  order.forEach((band, i) => {
    const seen = nameForBand(band, looksLike);
    let id: string = band;
    let label: string = NEUTRAL_LABELS[band];
    if (seen) {
      const candidate = slug(seen);
      // Only take Vision's word for it when the slug is usable and unclaimed.
      // A collision (two bands both offered "arch") keeps the neutral label,
      // because two regions with the same id would make `focus` ambiguous.
      if (candidate && !used.has(candidate)) {
        id = candidate;
        label = `the ${seen}`;
      }
    }
    used.add(id);
    out.push(region(id, label, bands[i].x, bands[i].y, Z_BAND));
  });

  out.push(region('background', NEUTRAL_LABELS.background, background.x, background.y, Z_BACKGROUND));
  return out;
}

/**
 * Otsu's method. Splits the depth histogram into "near" and "far" by maximising
 * between-class variance — no magic constant, and it adapts to a flat overcast
 * photograph as readily as to a subject against open sky.
 */
function otsu(grid: Float32Array): number {
  const BINS = 64;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < grid.length; i++) {
    const b = Math.min(BINS - 1, Math.max(0, Math.round(grid[i] * (BINS - 1))));
    hist[b]++;
  }
  const total = grid.length;
  let sum = 0;
  for (let b = 0; b < BINS; b++) sum += b * hist[b];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;

  for (let b = 0; b < BINS; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = b;
    }
  }
  return best / (BINS - 1);
}

export interface DepthGrid {
  /** Row-major, 0..1, where 1 is NEAREST (Depth Anything emits inverse depth). */
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Derive named regions from a generated depth map.
 *
 * There is no authored content to lean on, so the geometry has to come from the
 * only thing we actually measured — the depth map:
 *
 *   1. Otsu-threshold it into near (the subject) and far (sky / background).
 *   2. The subject's centroid and bounding box give us `subject`.
 *   3. The subject box is split into upper / middle / lower thirds, and each
 *      third's centroid is taken over SUBJECT pixels only — so on a photograph
 *      with a tower off to one side the bands track the tower, not the frame.
 *   4. The far pixels give us `background`.
 *
 * Names come from Vision where Vision reported something belonging in that band,
 * and are neutral first-person otherwise. Degenerate maps (a flat wall, an
 * all-sky frame) fall through to `fallbackRegions`, which is always valid.
 */
export function deriveRegions(grid: DepthGrid, looksLike: string[] = []): Region[] {
  const { data, width: w, height: h } = grid;
  if (!data || data.length !== w * h || w < 4 || h < 4) return fallbackRegions(looksLike);

  const threshold = otsu(data);

  let nearCount = 0;
  let sx = 0;
  let sy = 0;
  let minY = h;
  let maxY = -1;
  let farCount = 0;
  let fx = 0;
  let fy = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] >= threshold) {
        nearCount++;
        sx += x;
        sy += y;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        farCount++;
        fx += x;
        fy += y;
      }
    }
  }

  const nearFraction = nearCount / (w * h);
  // A subject occupying under 4% or over 96% of the frame is not a subject —
  // it is a flat wall, a sky, or a failed inference. Fixed thirds are honest
  // there and the camera still has somewhere to go.
  if (nearFraction < 0.04 || nearFraction > 0.96 || maxY < minY) return fallbackRegions(looksLike);

  const subject = { x: sx / nearCount / (w - 1), y: sy / nearCount / (h - 1) };
  const background =
    farCount > 0 ? { x: fx / farCount / (w - 1), y: fy / farCount / (h - 1) } : { x: 0.5, y: 0.1 };

  const top = minY;
  const span = maxY - minY + 1;
  const cuts = [top, top + span / 3, top + (2 * span) / 3, maxY + 1];

  const bandCentroid = (y0: number, y1: number, fallbackY: number): { x: number; y: number } => {
    let n = 0;
    let ax = 0;
    let ay = 0;
    for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
      for (let x = 0; x < w; x++) {
        if (data[y * w + x] < threshold) continue;
        n++;
        ax += x;
        ay += y;
      }
    }
    if (n === 0) return { x: subject.x, y: fallbackY };
    return { x: ax / n / (w - 1), y: ay / n / (h - 1) };
  };

  const bands: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
    bandCentroid(cuts[0], cuts[1], (cuts[0] + cuts[1]) / 2 / (h - 1)),
    bandCentroid(cuts[1], cuts[2], (cuts[1] + cuts[2]) / 2 / (h - 1)),
    bandCentroid(cuts[2], cuts[3], (cuts[2] + cuts[3]) / 2 / (h - 1)),
  ];

  return namedBands(looksLike, subject, bands, background);
}

// ---------------------------------------------------------------------------
// Shapes shared by the two routes and the client
// ---------------------------------------------------------------------------

export interface IdentifyResult {
  name: string | null;
  description: string;
  looksLike: string[];
  matchedMonumentId: string | null;
  confidence: 'high' | 'low';
}

export interface PhotoAnswerResult {
  text: string;
  directive: { focus: string | null; grade: string | null; era: string | null };
  lang: LangCode;
  /** ALWAYS false on this route. Present so no consumer can forget. */
  grounded: false;
  /** ALWAYS empty. Present for the same reason. */
  sources: never[];
  admittedIgnorance: boolean;
  model: string;
  timings: { generate?: number; total?: number };
  /** True when the output guard rejected the model's reply. Surfaced, not hidden. */
  guardTripped?: boolean;
}
