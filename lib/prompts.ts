/**
 * Every prompt Bol sends to a model lives in this one file so the voice can be
 * tuned in one place. Nothing here calls Sarvam; these are pure functions of
 * (monument, language, sources) and are cheap to unit test.
 *
 * Two prompts matter:
 *
 *   1. classificationMessages() — one tiny sarvam-30b call that returns a single
 *      token. This is the router. Keeping it to one token is what keeps the
 *      200ms routing budget realistic.
 *
 *   2. answerSystemPrompt() — the monument itself. First person, two sentences,
 *      sources only, plus the trailing JSON directive that drives the camera.
 *
 * Plus the honest fallback lines the monument speaks when a stage fails. They
 * are pre-written per language rather than generated, because the situations
 * they cover are exactly the situations in which a model call is unavailable
 * or has just returned nothing.
 */

import { info, normalizeLang, type LangCode } from './langs';
import { displayName } from './monuments';
import { formatSources } from './retrieval';
import type { Intent, Monument, SourceChunk } from './types';

/**
 * Structurally identical to `ChatMessage` in lib/sarvam.ts. Declared locally so
 * this module never imports the server-only client — prompts must stay
 * importable from anywhere, including a test script.
 */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const INTENTS: readonly Intent[] = ['SIMPLE', 'DEEP', 'MEMORY', 'REPORT', 'VISUAL'] as const;

// ---------------------------------------------------------------------------
// 1. Routing
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM = `You are a router for a talking monument. Classify the visitor's utterance into exactly ONE label.

SIMPLE  - a plain factual question about the monument (how tall, who built it, how old)
DEEP    - needs several facts joined together, a comparison, a "why", or a story across centuries
MEMORY  - asks what other visitors have said, or about stories, voices or memories left here
REPORT  - reports damage, graffiti, litter, cracks, or something broken or unsafe
VISUAL  - asks about something they can see right now ("what is that", "the thing on top", "these carvings")

Reply with the label only. One word. No punctuation, no explanation.`;

/**
 * The routing call. Temperature 0 on purpose: it makes routing deterministic AND
 * lets lib/sarvam's chat cache serve repeats for free, which matters during a
 * demo where the same three questions get asked forty times.
 */
export function classificationMessages(transcript: string, monument: Monument, lang: LangCode): PromptMessage[] {
  const name = displayName(monument, 'en-IN');
  return [
    { role: 'system', content: CLASSIFIER_SYSTEM },
    {
      role: 'user',
      content: `Monument: ${name}\nVisitor language: ${info(normalizeLang(lang)).english}\nUtterance: ${transcript.trim()}\n\nLabel:`,
    },
  ];
}

/**
 * Pull an Intent out of whatever the router said. It is asked for one token but
 * may return "Label: DEEP" or "**SIMPLE**"; anything unrecognisable falls back
 * to SIMPLE, which is the cheap, fast, safe branch.
 */
export function parseIntent(raw: string | null | undefined): Intent {
  if (!raw) return 'SIMPLE';
  const upper = raw.toUpperCase();
  for (const intent of INTENTS) {
    if (new RegExp(`\\b${intent}\\b`).test(upper)) return intent;
  }
  return 'SIMPLE';
}

/** How many chunks each intent deserves. DEEP earns a wider window; it also costs more. */
export function retrievalDepth(intent: Intent): number {
  switch (intent) {
    case 'DEEP':
      return 6;
    case 'VISUAL':
      return 4;
    default:
      return 3;
  }
}

// ---------------------------------------------------------------------------
// 2. The monument
// ---------------------------------------------------------------------------

export interface AnswerPromptOptions {
  intent?: Intent;
  /** Extra instruction appended to the rules block (used by the VISUAL branch). */
  extraRule?: string;
  /**
   * How the SOURCES block was assembled. In 'full-context' mode the model is
   * handed the entire corpus rather than a pre-filtered top 3, so relevance is
   * now its judgement to make — and the refusal rule has to be spelled out.
   */
  retrievalMode?: 'full-context' | 'ranked';
}

/**
 * The system prompt for the answering call.
 *
 * Two additions beyond the literal brief, both required for the directive to be
 * usable rather than decorative:
 *   - the list of valid region ids (with their English labels) — without it the
 *     model invents ids and every focus gets nulled by the validator;
 *   - the list of era years the monument actually has an image layer for.
 */
export function answerSystemPrompt(
  monument: Monument,
  lang: LangCode,
  sources: SourceChunk[],
  opts: AnswerPromptOptions = {},
): string {
  const code = normalizeLang(lang);
  const li = info(code);
  const name = displayName(monument, code);

  const regionList = monument.regions
    .map((r) => `${r.id} (${r.label['en-IN'] ?? r.id})`)
    .join(', ');
  const eraList = (monument.eras ?? []).map((e) => e.year).join(', ');

  /**
   * LANGUAGE COMES FIRST, AND IT COMES TWICE.
   *
   * The failure this guards against is specific and was the whole reason the
   * voice loop was audited: Saaras detects Tamil, the SOURCES block is in
   * English, and the model — pulled by the language of the context it can see —
   * answers in English anyway. The visitor then hears a language they did not
   * speak, which is the one thing this product cannot do.
   *
   * Two levers, both cheap: state the rule first (it is the constraint the rest
   * of the prompt is subordinate to), and state it again immediately before the
   * model starts generating, after the SOURCES (see the closing line below).
   * The mismatch is also detected after the fact in app/api/answer — a prompt is
   * a request, not a guarantee.
   */
  const rules = [
    `- Reply in ${li.english} (${li.native}), written in the ${li.script} script.`,
    code === 'en-IN'
      ? '- The visitor spoke to me in English, so I answer in English.'
      : `- The visitor spoke to me in ${li.english}. Every word I say back must be in ${li.english}, in the ${li.script} script. The SOURCES below are written in English — my answer must NOT be. Do not answer in English, do not answer in Hindi, and do not mix English sentences into the reply.`,
    '- Answer ONLY from the SOURCES below. If the answer is not there, say you do not remember it.',
    '- Maximum two sentences. Warm, plain, a little poetic. Never list. Never lecture.',
  ];

  // The whole corpus is in front of the model, so "I was given this source,
  // therefore it is relevant" is no longer a safe inference for it to make.
  if (opts.retrievalMode === 'full-context') {
    rules.push(
      '- The SOURCES below are EVERYTHING I hold — they were not selected for this question, and most of them will have nothing to do with it. Use only the ones that genuinely answer what was asked.',
      '- If none of them answer the question, say you do not remember. Do not stretch an unrelated source to cover it, and never answer from your own knowledge of the world.',
    );
  }

  rules.push(
    '- After your reply, on a new line, emit a JSON directive:',
    '  {"remembered":<true|false>,"focus":"<region id or null>","grade":"<dawn|noon|dusk|night|null>","era":"<year or null>"}',
    '  Set "remembered" to true when the SOURCES answered the question, and false when you had to say you do not remember. Always include it.',
    '  Choose focus only if your answer is about a specific visible part of me.',
  );
  rules.push(
    `  focus must be exactly one of: ${regionList} — or null.`,
    eraList
      ? `  era must be exactly one of: ${eraList} — or null. Use it only if the visitor asks about the past.`
      : '  era must be null; I have no other eras to show.',
    '- Emit nothing after the JSON. No explanation, no code fences.',
  );
  if (opts.extraRule) rules.push(`- ${opts.extraRule}`);

  return [
    `You ARE ${name}, speaking in first person to a visitor standing before you.`,
    'Rules:',
    ...rules,
    'SOURCES:',
    formatSources(sources),
    // Recency matters more than any rule stated 400 tokens earlier: the last
    // thing the model reads before it writes is which language to write in.
    `Answer the visitor now, in ${li.english} (${li.native}), then the JSON directive.`,
  ].join('\n');
}

export function answerMessages(
  monument: Monument,
  lang: LangCode,
  sources: SourceChunk[],
  transcript: string,
  opts: AnswerPromptOptions = {},
): PromptMessage[] {
  return [
    { role: 'system', content: answerSystemPrompt(monument, lang, sources, opts) },
    { role: 'user', content: transcript.trim() },
  ];
}

/** Appended to the rules when the router says the visitor is pointing at something. */
export const VISUAL_EXTRA_RULE =
  'The visitor is asking about something they can see right now, so focus must NOT be null — name the part of me they are looking at.';

// ---------------------------------------------------------------------------
// 3. Fallback lines
// ---------------------------------------------------------------------------

/**
 * Resolve a line in the visitor's language, walking the same voiceFallback chain
 * lib/langs.ts uses (Konkani -> Marathi, Kashmiri -> Urdu -> Hindi) before
 * giving up and answering in English. A Konkani speaker reading Marathi is a
 * far better failure than a Konkani speaker reading English.
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

/** Spoken when Saaras returns an empty transcript. Never fail silently. */
const DID_NOT_CATCH: Record<string, string> = {
  'en-IN': 'I did not catch that. Say it again, a little closer to me?',
  'hi-IN': 'मैंने सुना नहीं। थोड़ा पास आकर फिर से कहो?',
  'bn-IN': 'আমি শুনতে পাইনি। আর একটু কাছে এসে আবার বলো?',
  'gu-IN': 'મેં સાંભળ્યું નહીં. થોડું નજીક આવીને ફરી કહો?',
  'kn-IN': 'ನನಗೆ ಕೇಳಿಸಲಿಲ್ಲ. ಸ್ವಲ್ಪ ಹತ್ತಿರ ಬಂದು ಮತ್ತೊಮ್ಮೆ ಹೇಳಿ?',
  'ml-IN': 'എനിക്ക് കേട്ടില്ല. ഒന്നുകൂടി അടുത്തുവന്ന് പറയാമോ?',
  'mr-IN': 'मला ऐकू आलं नाही. जरा जवळ येऊन पुन्हा सांगा?',
  'od-IN': 'ମୁଁ ଶୁଣିପାରିଲି ନାହିଁ। ଟିକେ ପାଖକୁ ଆସି ପୁଣି କୁହନ୍ତୁ?',
  'pa-IN': 'ਮੈਂ ਸੁਣ ਨਹੀਂ ਸਕਿਆ। ਥੋੜ੍ਹਾ ਨੇੜੇ ਆ ਕੇ ਫਿਰ ਕਹੋ?',
  'ta-IN': 'எனக்குக் கேட்கவில்லை. கொஞ்சம் அருகில் வந்து மீண்டும் சொல்லுங்கள்?',
  'te-IN': 'నాకు వినిపించలేదు. కొంచెం దగ్గరగా వచ్చి మళ్లీ చెప్పండి?',
  'ur-IN': 'میں سن نہیں سکا۔ ذرا قریب آ کر دوبارہ کہیے؟',
};

/** Spoken when retrieval clears nothing. Constraint 4: never invent history. */
const DO_NOT_REMEMBER: Record<string, string> = {
  'en-IN': 'I do not remember that. Ask me something else about myself.',
  'hi-IN': 'यह मुझे याद नहीं। मेरे बारे में कुछ और पूछो।',
  'bn-IN': 'এটা আমার মনে নেই। আমার সম্পর্কে অন্য কিছু জিজ্ঞেস করো।',
  'gu-IN': 'એ મને યાદ નથી. મારા વિશે બીજું કંઈ પૂછો.',
  'kn-IN': 'ಅದು ನನಗೆ ನೆನಪಿಲ್ಲ. ನನ್ನ ಬಗ್ಗೆ ಬೇರೆ ಏನಾದರೂ ಕೇಳಿ.',
  'ml-IN': 'അത് എനിക്ക് ഓർമ്മയില്ല. എന്നെക്കുറിച്ച് മറ്റെന്തെങ്കിലും ചോദിക്കൂ.',
  'mr-IN': 'ते मला आठवत नाही. माझ्याबद्दल दुसरं काही विचारा.',
  'od-IN': 'ତାହା ମୋର ମନେ ନାହିଁ। ମୋ ବିଷୟରେ ଅନ୍ୟ କିଛି ପଚାରନ୍ତୁ।',
  'pa-IN': 'ਇਹ ਮੈਨੂੰ ਯਾਦ ਨਹੀਂ। ਮੇਰੇ ਬਾਰੇ ਕੁਝ ਹੋਰ ਪੁੱਛੋ।',
  'ta-IN': 'அது எனக்கு நினைவில் இல்லை. என்னைப் பற்றி வேறு ஏதாவது கேளுங்கள்.',
  'te-IN': 'అది నాకు గుర్తులేదు. నా గురించి మరేదైనా అడగండి.',
  'ur-IN': 'یہ مجھے یاد نہیں۔ میرے بارے میں کچھ اور پوچھیے۔',
};

/** Spoken when the router says REPORT — the vision lane takes it from here. */
const REPORT_ACK: Record<string, string> = {
  'en-IN': 'I hear you, and it matters. Show me what you see, and I will pass it to those who care for me.',
  'hi-IN': 'मैंने सुन लिया, और यह ज़रूरी है। जो दिख रहा है वह मुझे दिखाओ, मैं अपने रखवालों तक पहुँचा दूँगा।',
  'bn-IN': 'আমি শুনেছি, আর এটা জরুরি। যা দেখছ আমাকে দেখাও, আমি আমার রক্ষকদের কাছে পৌঁছে দেব।',
  'gu-IN': 'મેં સાંભળ્યું, અને એ મહત્વનું છે. જે દેખાય છે તે મને બતાવો, હું મારા રખેવાળો સુધી પહોંચાડીશ.',
  'kn-IN': 'ನಾನು ಕೇಳಿದೆ, ಮತ್ತು ಅದು ಮುಖ್ಯ. ಕಾಣುತ್ತಿರುವುದನ್ನು ತೋರಿಸಿ, ನನ್ನ ಪಾಲಕರಿಗೆ ತಲುಪಿಸುತ್ತೇನೆ.',
  'ml-IN': 'ഞാൻ കേട്ടു, അതു പ്രധാനമാണ്. കാണുന്നത് എന്നെ കാണിക്കൂ, ഞാൻ എന്റെ കാവൽക്കാരിലേക്ക് എത്തിക്കാം.',
  'mr-IN': 'मी ऐकलं, आणि ते महत्त्वाचं आहे. जे दिसतंय ते मला दाखवा, मी माझ्या राखणदारांपर्यंत पोहोचवीन.',
  'od-IN': 'ମୁଁ ଶୁଣିଲି, ଏହା ଗୁରୁତ୍ୱପୂର୍ଣ୍ଣ। ଯାହା ଦେଖୁଛନ୍ତି ମୋତେ ଦେଖାନ୍ତୁ, ମୁଁ ମୋ ରକ୍ଷକଙ୍କ ପାଖରେ ପହଞ୍ଚାଇବି।',
  'pa-IN': 'ਮੈਂ ਸੁਣ ਲਿਆ, ਤੇ ਇਹ ਜ਼ਰੂਰੀ ਹੈ। ਜੋ ਦਿਸ ਰਿਹਾ ਹੈ ਮੈਨੂੰ ਵਿਖਾਓ, ਮੈਂ ਆਪਣੇ ਰਾਖਿਆਂ ਤੱਕ ਪਹੁੰਚਾ ਦਿਆਂਗਾ।',
  'ta-IN': 'நான் கேட்டேன், அது முக்கியம். தெரிவதை எனக்குக் காட்டுங்கள், என் காவலர்களிடம் சேர்ப்பிக்கிறேன்.',
  'te-IN': 'నేను విన్నాను, అది ముఖ్యం. కనిపిస్తున్నది నాకు చూపించండి, నా సంరక్షకులకు చేరవేస్తాను.',
  'ur-IN': 'میں نے سن لیا، اور یہ اہم ہے۔ جو نظر آ رہا ہے مجھے دکھائیں، میں اپنے رکھوالوں تک پہنچا دوں گا۔',
};

/** Spoken just before the echo wall plays a visitor's recorded memory. */
const MEMORY_LEAD_IN: Record<string, string> = {
  'en-IN': 'Someone stood where you stand and left this behind. Listen.',
  'hi-IN': 'जहाँ तुम खड़े हो, वहीं कोई खड़ा था और यह छोड़ गया। सुनो।',
  'bn-IN': 'তুমি যেখানে দাঁড়িয়ে আছ, সেখানে কেউ দাঁড়িয়ে এটা রেখে গেছে। শোনো।',
  'gu-IN': 'તમે જ્યાં ઊભા છો ત્યાં કોઈ ઊભું હતું અને આ મૂકી ગયું. સાંભળો.',
  'kn-IN': 'ನೀವು ನಿಂತಲ್ಲಿ ಯಾರೋ ನಿಂತು ಇದನ್ನು ಬಿಟ್ಟು ಹೋದರು. ಕೇಳಿ.',
  'ml-IN': 'നിങ്ങൾ നിൽക്കുന്നിടത്ത് ആരോ നിന്ന് ഇത് ബാക്കിവെച്ചു. കേൾക്കൂ.',
  'mr-IN': 'तुम्ही जिथे उभे आहात तिथे कोणीतरी उभं होतं आणि हे ठेवून गेलं. ऐका.',
  'od-IN': 'ଆପଣ ଠିଆ ହୋଇଥିବା ସ୍ଥାନରେ କେହି ଠିଆ ହୋଇ ଏହା ଛାଡ଼ି ଯାଇଛନ୍ତି। ଶୁଣନ୍ତୁ।',
  'pa-IN': 'ਜਿੱਥੇ ਤੁਸੀਂ ਖੜ੍ਹੇ ਹੋ, ਉੱਥੇ ਕੋਈ ਖੜ੍ਹਾ ਸੀ ਤੇ ਇਹ ਛੱਡ ਗਿਆ। ਸੁਣੋ।',
  'ta-IN': 'நீங்கள் நிற்கும் இடத்தில் யாரோ நின்று இதை விட்டுச் சென்றார். கேளுங்கள்.',
  'te-IN': 'మీరు నిలబడిన చోట ఎవరో నిలబడి దీన్ని వదిలి వెళ్లారు. వినండి.',
  'ur-IN': 'جہاں آپ کھڑے ہیں، وہیں کوئی کھڑا تھا اور یہ چھوڑ گیا۔ سنیے۔',
};

/** Spoken when the echo wall has nothing yet for this monument. */
const NO_MEMORIES: Record<string, string> = {
  'en-IN': 'No one has left a memory with me yet. Yours could be the first.',
  'hi-IN': 'अब तक किसी ने मेरे पास कोई याद नहीं छोड़ी। तुम्हारी पहली हो सकती है।',
  'bn-IN': 'এখনও কেউ আমার কাছে কোনো স্মৃতি রেখে যায়নি। তোমারটাই প্রথম হতে পারে।',
  'gu-IN': 'હજી સુધી કોઈએ મારી પાસે યાદ મૂકી નથી. તમારી પહેલી હોઈ શકે.',
  'kn-IN': 'ಇಲ್ಲಿಯವರೆಗೆ ಯಾರೂ ನನ್ನ ಬಳಿ ನೆನಪು ಬಿಟ್ಟಿಲ್ಲ. ನಿಮ್ಮದೇ ಮೊದಲಾಗಬಹುದು.',
  'ml-IN': 'ഇതുവരെ ആരും എന്നിൽ ഒരു ഓർമ്മ വെച്ചിട്ടില്ല. നിങ്ങളുടേത് ആദ്യത്തേതാകാം.',
  'mr-IN': 'अजून कोणीही माझ्याजवळ आठवण ठेवलेली नाही. तुमची पहिली असू शकते.',
  'od-IN': 'ଏପର୍ଯ୍ୟନ୍ତ କେହି ମୋ ପାଖରେ ସ୍ମୃତି ଛାଡ଼ି ନାହାଁନ୍ତି। ଆପଣଙ୍କଟି ପ୍ରଥମ ହୋଇପାରେ।',
  'pa-IN': 'ਹਾਲੇ ਤੱਕ ਕਿਸੇ ਨੇ ਮੇਰੇ ਕੋਲ ਯਾਦ ਨਹੀਂ ਛੱਡੀ। ਤੁਹਾਡੀ ਪਹਿਲੀ ਹੋ ਸਕਦੀ ਹੈ।',
  'ta-IN': 'இதுவரை யாரும் என்னிடம் ஒரு நினைவை விட்டுச் செல்லவில்லை. உங்களுடையது முதலாவதாக இருக்கலாம்.',
  'te-IN': 'ఇప్పటివరకు ఎవరూ నా దగ్గర జ్ఞాపకం వదిలి వెళ్లలేదు. మీదే మొదటిది కావచ్చు.',
  'ur-IN': 'ابھی تک کسی نے میرے پاس کوئی یاد نہیں چھوڑی۔ آپ کی پہلی ہو سکتی ہے۔',
};

export const didNotCatch = (lang: LangCode) => localized(DID_NOT_CATCH, lang);
export const doNotRemember = (lang: LangCode) => localized(DO_NOT_REMEMBER, lang);
export const reportAcknowledgement = (lang: LangCode) => localized(REPORT_ACK, lang);
export const memoryLeadIn = (lang: LangCode) => localized(MEMORY_LEAD_IN, lang);
export const noMemoriesYet = (lang: LangCode) => localized(NO_MEMORIES, lang);

/** The pre-written intro line from the monument JSON, in the visitor's language. */
export function introLine(monument: Monument, lang: LangCode): string {
  const code = normalizeLang(lang);
  const table = monument.intro ?? {};
  const fallback = info(code).voiceFallback;
  return table[code] ?? (fallback ? table[fallback] : undefined) ?? table['en-IN'] ?? '';
}

// ---------------------------------------------------------------------------
// 4. Script detection — for the typed fallback only
// ---------------------------------------------------------------------------

const SCRIPT_RANGES: [RegExp, LangCode][] = [
  [/[஀-௿]/, 'ta-IN'],
  [/[ఀ-౿]/, 'te-IN'],
  [/[ಀ-೿]/, 'kn-IN'],
  [/[ഀ-ൿ]/, 'ml-IN'],
  [/[઀-૿]/, 'gu-IN'],
  [/[਀-੿]/, 'pa-IN'],
  [/[଀-୿]/, 'od-IN'],
  [/[ঀ-৿]/, 'bn-IN'],
  [/[؀-ۿݐ-ݿ]/, 'ur-IN'],
  [/[᱐-᱿]/, 'sat-IN'],
  [/[ꯀ-꯿]/, 'mni-IN'],
  [/[ऀ-ॿ]/, 'hi-IN'],
];

/**
 * When Saaras is unavailable the UI falls back to a text box, and a typed
 * question has no detected language attached to it. Rather than showing a
 * language picker — which rule 2 forbids outright — we read the script the
 * visitor typed in. It cannot separate Hindi from Marathi (both Devanagari) or
 * Assamese from Bengali, so it is only ever used when there is no Saaras result
 * to trust, and any later utterance overrides it.
 *
 * Returns null for plain Latin text so the caller can keep the last known
 * language instead of forcing English on someone mid-conversation.
 */
export function guessLangFromScript(text: string): LangCode | null {
  for (const [re, code] of SCRIPT_RANGES) if (re.test(text)) return code;
  return null;
}

/**
 * The typed-fallback resolver: what language do we answer a keyboard in when
 * there is no Saaras detection to obey and no earlier utterance to remember?
 *
 * `guessLangFromScript` deliberately returns null for Latin text so that a
 * visitor mid-conversation keeps the language they were already speaking. But at
 * the very first typed question there is nothing to keep, and `normalizeLang`
 * would then hand back DEFAULT_LANG — answering a plainly English question in
 * Hindi. Latin letters are the one script we can read as a language of their
 * own, so we do, and only here.
 *
 * Romanised Indic ("Qutub kitna purana hai") lands on English by this route, and
 * that is the accepted cost: it is only ever reached when Saaras is unavailable,
 * and any later utterance overrides it. When Saaras IS available its detection
 * arrives on the request and this function is never called.
 */
export function guessLangFromText(text: string): LangCode | null {
  const byScript = guessLangFromScript(text);
  if (byScript) return byScript;
  return /[A-Za-z]{2}/.test(text) ? 'en-IN' : null;
}

// ---------------------------------------------------------------------------
// 5. Reply-language verification
// ---------------------------------------------------------------------------

/** One matcher per `LangInfo.script` value in lib/langs.ts. */
const SCRIPT_MATCHERS: Record<string, RegExp> = {
  Latin: /[A-Za-z]/,
  Devanagari: /[ऀ-ॿ]/,
  Bengali: /[ঀ-৿]/,
  'Bengali-Assamese': /[ঀ-৿]/,
  Gujarati: /[઀-૿]/,
  Gurmukhi: /[਀-੿]/,
  Kannada: /[ಀ-೿]/,
  Malayalam: /[ഀ-ൿ]/,
  Odia: /[଀-୿]/,
  Tamil: /[஀-௿]/,
  Telugu: /[ఀ-౿]/,
  'Perso-Arabic': /[؀-ۿݐ-ݿﭐ-﷿ﹰ-ﻼ]/,
  'Meetei Mayek': /[ꯀ-꯿ꫠ-꫿]/,
  'Ol Chiki': /[᱐-᱿]/,
};

/**
 * 'match'     the reply is written in the script the visitor's language uses
 * 'mismatch'  it is confidently NOT — enough letters of the wrong script and
 *             none of the right one to rule out a stray loanword
 * 'unknown'   too little text to judge (numerals, a single word, an emoji)
 */
export type ScriptCheck = 'match' | 'mismatch' | 'unknown';

const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, 'gu')) ?? []).length;

/**
 * A cheap, dependency-free sanity check on the one thing the visitor will notice
 * instantly: did the monument answer in a script they can read?
 *
 * It verifies the SCRIPT, not the language — Hindi, Marathi, Sanskrit, Nepali,
 * Konkani, Maithili, Dogri and Bodo all share Devanagari, and Bengali and
 * Assamese share their script, so a Hindi reply to a Marathi speaker passes this
 * check. It catches the failure that actually happens in production (the model
 * defaulting to the English of the SOURCES block) and it never fires on a
 * correct reply, which is what makes it safe to act on.
 */
export function checkReplyScript(text: string, lang: LangCode): ScriptCheck {
  const clean = text.trim();
  if (!clean) return 'unknown';

  const expectedScript = info(lang).script;
  const matcher = SCRIPT_MATCHERS[expectedScript];
  if (!matcher) return 'unknown';

  const expected = count(clean, matcher);
  if (expected > 0 && expectedScript !== 'Latin') return 'match';

  const latin = count(clean, SCRIPT_MATCHERS.Latin);

  if (expectedScript === 'Latin') {
    // English expected. A stray Indic proper noun is fine; a whole Indic
    // sentence is not.
    let indic = 0;
    for (const [name, re] of Object.entries(SCRIPT_MATCHERS)) {
      if (name === 'Latin') continue;
      indic += count(clean, re);
    }
    if (indic === 0) return latin >= 2 ? 'match' : 'unknown';
    return indic >= 8 && indic > latin ? 'mismatch' : 'unknown';
  }

  // An Indic language was expected and not one letter of its script came back.
  return latin >= 8 ? 'mismatch' : 'unknown';
}
