import { NextResponse } from 'next/server';

import { logEvent } from '@/lib/db';
import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { DEFAULT_LANG, info, normalizeLang, resolveVoice, voiceGapNotice } from '@/lib/langs';
import { MODELS, chat, isConfigured, readDocument, speak, translate } from '@/lib/sarvam';
import { DEFAULT_MONUMENT_ID, getMonument } from '@/lib/monuments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/plaque — the plaque reader.
 *
 * A visitor photographs an ASI signboard, a plaque, or a page of a printed
 * guidebook. Sarvam Vision (lib/sarvam.ts readDocument) does the OCR — it
 * handles Indic scripts, tables, reading order, handwriting, and faded or
 * stamped documents from 1800 onward. sarvam-105b then rewrites it into three
 * short sentences in the visitor's own language, and Bulbul speaks it.
 *
 * The raw OCR is returned UNEDITED and shown beside the plain-language version.
 * That side-by-side is the proof that the model actually read the Devanagari or
 * the Urdu; it is not decoration, so this route must never "clean up" rawOcr.
 *
 * Honest limit (surfaced in the UI, not hidden here): this reads modern and
 * colonial-era signage from 1800 onward. It does not read Brahmi or Grantha.
 *
 * multipart in : image (Blob, required), lang, monument_id?, session_id?
 * 200 out      : { rawOcr, plain, audio, voiceLang, degraded, ms:{ocr,rewrite,tts} }
 */

/** 15MB — a downscaled 1600px JPEG is ~300KB, so anything past this is a client bug. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const VISION_PROMPT =
  'Extract every word of text visible in this photograph of a monument signboard, plaque or ' +
  'printed page, exactly as printed. Preserve the original script, the line breaks and the ' +
  'reading order. Do not translate. Do not summarise. Do not add anything that is not printed.';

/**
 * "I could not read that clearly, try better light" — the brief's words, spoken,
 * never a stack trace. Pre-written where we can; translated at runtime otherwise.
 */
const UNREADABLE: Record<string, string> = {
  'en-IN': 'I could not read that clearly. Please try again in better light.',
  'hi-IN': 'मैं इसे साफ़ नहीं पढ़ पाया। कृपया बेहतर रोशनी में फिर से कोशिश कीजिए।',
  'mr-IN': 'मला ते स्पष्ट वाचता आले नाही. कृपया चांगल्या उजेडात पुन्हा प्रयत्न करा.',
  'bn-IN': 'আমি এটি স্পষ্টভাবে পড়তে পারিনি। দয়া করে ভালো আলোয় আবার চেষ্টা করুন।',
  'gu-IN': 'હું તે સ્પષ્ટ વાંચી શક્યો નહીં. કૃપા કરીને સારા પ્રકાશમાં ફરી પ્રયાસ કરો.',
  'kn-IN': 'ನನಗೆ ಅದನ್ನು ಸ್ಪಷ್ಟವಾಗಿ ಓದಲು ಆಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಉತ್ತಮ ಬೆಳಕಿನಲ್ಲಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
  'ml-IN': 'എനിക്ക് അത് വ്യക്തമായി വായിക്കാൻ കഴിഞ്ഞില്ല. ദയവായി നല്ല വെളിച്ചത്തിൽ വീണ്ടും ശ്രമിക്കൂ.',
  'od-IN': 'ମୁଁ ତାହା ସ୍ପଷ୍ଟ ଭାବେ ପଢ଼ି ପାରିଲି ନାହିଁ। ଦୟାକରି ଭଲ ଆଲୋକରେ ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
  'pa-IN': 'ਮੈਂ ਇਹ ਸਾਫ਼ ਨਹੀਂ ਪੜ੍ਹ ਸਕਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਚੰਗੀ ਰੌਸ਼ਨੀ ਵਿੱਚ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।',
  'ta-IN': 'என்னால் அதைத் தெளிவாகப் படிக்க முடியவில்லை. தயவுசெய்து நல்ல வெளிச்சத்தில் மீண்டும் முயற்சி செய்யுங்கள்.',
  'te-IN': 'నేను దాన్ని స్పష్టంగా చదవలేకపోయాను. దయచేసి మంచి వెలుతురులో మళ్లీ ప్రయత్నించండి.',
  'ur-IN': 'میں اسے صاف نہیں پڑھ سکا۔ براہِ کرم بہتر روشنی میں دوبارہ کوشش کریں۔',
  'as-IN': 'মই ইয়াক স্পষ্টকৈ পঢ়িব নোৱাৰিলোঁ। অনুগ্ৰহ কৰি ভাল পোহৰত পুনৰ চেষ্টা কৰক।',
  'sa-IN': 'अहं तत् स्पष्टं पठितुं न शक्नोमि। कृपया उत्तमे प्रकाशे पुनः प्रयत्नं करोतु।',
  'ne-IN': 'मैले त्यो स्पष्ट पढ्न सकिनँ। कृपया राम्रो उज्यालोमा फेरि प्रयास गर्नुहोस्।',
};

/** The rewrite model failed but the OCR did not — say exactly that; the raw text still stands. */
const REWRITE_FAILED: Record<string, string> = {
  'en-IN': 'I read the board, but I could not put it into simple words just now. The original text is beside this.',
  'hi-IN': 'मैंने बोर्ड पढ़ लिया, पर अभी उसे आसान शब्दों में नहीं कह पाया। मूल पाठ साथ में दिख रहा है।',
  'mr-IN': 'मी फलक वाचला, पण आत्ता तो सोप्या शब्दांत सांगू शकलो नाही. मूळ मजकूर शेजारी आहे.',
  'bn-IN': 'আমি বোর্ডটি পড়েছি, কিন্তু এখনই সহজ ভাষায় বলতে পারলাম না। মূল লেখাটি পাশেই রয়েছে।',
  'ta-IN': 'நான் பலகையைப் படித்தேன், ஆனால் இப்போது எளிய சொற்களில் சொல்ல முடியவில்லை. மூல வாசகம் அருகில் உள்ளது.',
  'te-IN': 'నేను బోర్డును చదివాను, కానీ ఇప్పుడే సులభమైన మాటల్లో చెప్పలేకపోయాను. అసలు వచనం పక్కనే ఉంది.',
  'ur-IN': 'میں نے تختی پڑھ لی، مگر ابھی اسے آسان الفاظ میں نہیں کہہ سکا۔ اصل عبارت ساتھ موجود ہے۔',
};

/**
 * Pre-written where we have it; a live translation otherwise; English as the last
 * resort. Never an English fallback silently labelled as the visitor's language —
 * the UI gets whatever this returns and the voice speaks the same string.
 */
async function localize(table: Record<string, string>, lang: string): Promise<string> {
  const code = normalizeLang(lang);
  if (table[code]) return table[code];
  const english = table['en-IN'];
  try {
    const out = await translate(english, code);
    return out || english;
  } catch {
    return english;
  }
}

/**
 * Vision can succeed at the HTTP level and still hand back nothing usable: a
 * blank string, three specks of noise, or an English apology ("No text detected")
 * regardless of the plaque's script. All three mean the same thing to a visitor
 * standing in bad light, so all three take the honest spoken path.
 */
function isUsableOcr(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 4) return false;
  const glyphs = t.match(/[\p{L}\p{N}]/gu);
  if ((glyphs?.length ?? 0) < 4) return false;
  if (t.length < 140 && /^\W*(no\s+(readable\s+|visible\s+)?text|nothing\s+(is\s+)?(visible|readable|legible)|unable\s+to\s+(read|extract)|could\s+not\s+(read|detect))/i.test(t)) {
    return false;
  }
  return true;
}

export async function POST(req: Request) {
  const t0 = Date.now();
  const ms = { ocr: 0, rewrite: 0, tts: 0 };
  let lang = DEFAULT_LANG;

  try {
    // No key in this environment yet: say so in one round trip rather than
    // spinning forever. toErrorPayload maps this to 503 { kind:'not_configured' }.
    if (!isConfigured()) {
      const payload = toErrorPayload(new SarvamNotConfigured());
      return NextResponse.json(payload, { status: payload.status });
    }

    const form = await req.formData();
    const image = form.get('image');
    lang = normalizeLang((form.get('lang') as string | null) ?? DEFAULT_LANG);
    const monumentId = getMonument(((form.get('monument_id') as string | null) ?? DEFAULT_MONUMENT_ID) || DEFAULT_MONUMENT_ID).id;
    const sessionId = ((form.get('session_id') as string | null) ?? '') || null;

    if (!(image instanceof Blob) || image.size === 0) {
      return NextResponse.json(
        { error: 'Send a photograph of the plaque as multipart field "image".', kind: 'no_image', status: 400 },
        { status: 400 },
      );
    }
    if (image.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        {
          error: `That photograph is ${(image.size / 1048576).toFixed(1)}MB. Downscale it to 1600px before uploading.`,
          kind: 'image_too_large',
          status: 413,
        },
        { status: 413 },
      );
    }

    const voice = resolveVoice(lang);

    // ---- 1. OCR ------------------------------------------------------------
    // readDocument() already walks the candidate Vision endpoint paths, because
    // the path differs across Sarvam versions. Never hand-roll that fetch.
    let rawOcr = '';
    let ocrError: string | null = null;
    const tOcr = Date.now();
    try {
      rawOcr = await readDocument(image, VISION_PROMPT, { filename: 'plaque.jpg' });
    } catch (err) {
      // A hard OCR failure is not a 500 for the visitor — it is "try better light",
      // spoken. We only rethrow when the whole account is unusable (auth/not configured),
      // which the outer catch turns into an honest, specific payload.
      const name = (err as Error)?.name;
      if (name === 'SarvamAuth' || name === 'SarvamNotConfigured') throw err;
      ocrError = (err as Error)?.message ?? 'vision failed';
      console.warn('[plaque] OCR failed:', ocrError);
    }
    ms.ocr = Date.now() - tOcr;

    const usable = isUsableOcr(rawOcr);

    // ---- 2. Plain-language rewrite ----------------------------------------
    let plain: string;
    let rewriteError: string | null = null;

    if (!usable) {
      // Contract: unusable OCR returns rawOcr:'' so the left column shows the
      // honest empty state rather than a line of noise dressed up as evidence.
      rawOcr = '';
      plain = await localize(UNREADABLE, lang);
    } else {
      const tRewrite = Date.now();
      try {
        plain = await chat(
          [
            {
              role: 'system',
              content:
                'You rewrite monument signboards for ordinary visitors. You never add a fact, a date, ' +
                'a name or a number that is not already in the text you are given. If the text is ' +
                'thin, your rewrite is thin too.',
            },
            {
              role: 'user',
              content:
                `Rewrite this monument signboard for a visitor who is not a historian. Three short sentences. ` +
                `Reply in ${info(lang).english}. Add nothing that is not in the text.\n\n---\n${rawOcr}\n---`,
            },
          ],
          { model: MODELS.chatDeep, maxTokens: 320, temperature: 0.3, think: false },
        );
      } catch (err) {
        rewriteError = (err as Error)?.message ?? 'rewrite failed';
        console.warn('[plaque] rewrite failed:', rewriteError);
        // The OCR is the proof and it survived — say honestly that only the
        // simplification failed, and let the raw column carry the value.
        plain = await localize(REWRITE_FAILED, lang);
      }
      ms.rewrite = Date.now() - tRewrite;
    }

    // ---- 3. Voice ----------------------------------------------------------
    // TTS is the most optional stage: if Bulbul is down the visitor still reads
    // large warm text. audio:null is a contract value, not an error.
    let audio: string | null = null;
    const tTts = Date.now();
    try {
      const spoken = await speak(plain, lang);
      audio = spoken.url;
    } catch (err) {
      console.warn('[plaque] TTS failed, returning audio:null:', (err as Error)?.message);
    }
    ms.tts = Date.now() - tTts;

    void logEvent(
      'plaque_read',
      {
        monument_id: monumentId,
        lang,
        usable,
        ocrChars: rawOcr.length,
        bytes: image.size,
        ocrError,
        rewriteError,
        ttsOk: audio !== null,
        ms,
        totalMs: Date.now() - t0,
      },
      sessionId,
    );

    return NextResponse.json({
      rawOcr,
      plain,
      audio,
      voiceLang: voice.voiceLang,
      degraded: voice.degraded,
      ms,
      // Extras beyond the shared contract — safe to ignore in other lanes.
      usable,
      voiceNote: voice.degraded ? voiceGapNotice(lang) : null,
      lang,
      monumentId,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    void logEvent('plaque_error', { kind: payload.kind, error: payload.error, lang });
    return NextResponse.json(payload, { status: payload.status });
  }
}
