import { NextResponse } from 'next/server';

import { insertReport, logEvent } from '@/lib/db';
import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { DEFAULT_LANG, normalizeLang, resolveVoice, voiceGapNotice } from '@/lib/langs';
import { MODELS, chat, isConfigured, listen, readDocument, speak, translate } from '@/lib/sarvam';
import { DEFAULT_MONUMENT_ID, getMonument } from '@/lib/monuments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/report — the conservation report.
 *
 * A visitor speaks what they see ("someone has scratched their name into the
 * pillar") and optionally photographs it. Saaras transcribes in whatever of the
 * 22 languages they used and we translate that to English for the caretaker
 * record; Vision describes the photograph; sarvam-105b classifies the damage.
 * The row goes into the reports table and the growth lane's dashboard surfaces
 * it as a geotagged list. Footfall counters cannot do this.
 *
 * multipart in : audio? (Blob), image? (Blob), lang?, monument_id, session_id?, lat?, lon?
 * 200 out      : { id, kind, severity, transcript, english, photoDescription,
 *                  confirmation, audio }
 *
 * The citizen's report is the thing being protected here. Every downstream stage
 * — translation, photo description, classification, voice — is allowed to fail
 * without losing the row.
 */

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const REPORT_KINDS = ['graffiti', 'structural', 'water', 'litter', 'hazard'] as const;
type ReportKind = (typeof REPORT_KINDS)[number] | 'unknown';
type Severity = 1 | 2 | 3 | 4 | 5;

const PHOTO_PROMPT =
  'Describe only the physical condition of the monument surface in this photograph: any writing ' +
  'or scratching on the stone, cracks, missing pieces, water stains or seepage, plant growth, ' +
  'rubbish, or anything unsafe. Two or three factual sentences in English. Do not guess at ' +
  'history and do not describe people.';

/** "Thank you. I have told my caretakers." — the monument's own voice, first person. */
const CONFIRMATION: Record<string, string> = {
  'en-IN': 'Thank you. I have told my caretakers.',
  'hi-IN': 'धन्यवाद। मैंने अपने रखवालों को बता दिया है।',
  'mr-IN': 'धन्यवाद. मी माझ्या रक्षकांना सांगितले आहे.',
  'bn-IN': 'ধন্যবাদ। আমি আমার রক্ষকদের জানিয়ে দিয়েছি।',
  'gu-IN': 'આભાર. મેં મારા સંભાળ રાખનારાઓને જણાવી દીધું છે.',
  'kn-IN': 'ಧನ್ಯವಾದಗಳು. ನಾನು ನನ್ನ ಪಾಲಕರಿಗೆ ತಿಳಿಸಿದ್ದೇನೆ.',
  'ml-IN': 'നന്ദി. ഞാൻ എന്റെ പരിപാലകരോട് പറഞ്ഞിട്ടുണ്ട്.',
  'od-IN': 'ଧନ୍ୟବାଦ। ମୁଁ ମୋର ରକ୍ଷକମାନଙ୍କୁ ଜଣାଇ ଦେଇଛି।',
  'pa-IN': 'ਧੰਨਵਾਦ। ਮੈਂ ਆਪਣੇ ਰਖਵਾਲਿਆਂ ਨੂੰ ਦੱਸ ਦਿੱਤਾ ਹੈ।',
  'ta-IN': 'நன்றி. நான் என் காப்பாளர்களிடம் சொல்லிவிட்டேன்.',
  'te-IN': 'ధన్యవాదాలు. నేను నా సంరక్షకులకు తెలియజేశాను.',
  'ur-IN': 'شکریہ۔ میں نے اپنے نگہبانوں کو بتا دیا ہے۔',
  'as-IN': 'ধন্যবাদ। মই মোৰ ৰক্ষকসকলক জনাই দিছোঁ।',
  'sa-IN': 'धन्यवादः। अहं मम रक्षकेभ्यः अकथयम्।',
  'ne-IN': 'धन्यवाद। मैले मेरा संरक्षकहरूलाई बताएको छु।',
  'kok-IN': 'देव बरें करूं. हांवें म्हज्या राखणदारांक सांगलां.',
  'mai-IN': 'धन्यवाद। हम अपन रखवारक कहि देलहुँ।',
};

/** Pre-blocked at the door, so no Sarvam call is spent on it — table only, no translate. */
const NEED_SOMETHING: Record<string, string> = {
  'en-IN': 'Please speak what you see, or take a photograph. I need at least one of the two.',
  'hi-IN': 'कृपया जो दिख रहा है वह बोलिए, या एक तस्वीर लीजिए। दोनों में से कम से कम एक चाहिए।',
  'mr-IN': 'कृपया जे दिसते ते सांगा, किंवा एक फोटो काढा. दोनपैकी किमान एक हवे.',
  'bn-IN': 'যা দেখছেন তা বলুন, অথবা একটি ছবি তুলুন। দুটির অন্তত একটি প্রয়োজন।',
  'ta-IN': 'நீங்கள் பார்ப்பதைச் சொல்லுங்கள், அல்லது ஒரு புகைப்படம் எடுங்கள். இரண்டில் ஒன்றாவது தேவை.',
  'te-IN': 'మీరు చూస్తున్నది చెప్పండి, లేదా ఒక ఫోటో తీయండి. రెండిటిలో కనీసం ఒకటి కావాలి.',
  'ur-IN': 'جو نظر آ رہا ہے وہ بولیے، یا ایک تصویر لیجیے۔ دونوں میں سے کم از کم ایک درکار ہے۔',
};

async function localize(table: Record<string, string>, lang: string, allowTranslate = true): Promise<string> {
  const code = normalizeLang(lang);
  if (table[code]) return table[code];
  const english = table['en-IN'];
  if (!allowTranslate) return english;
  try {
    const out = await translate(english, code);
    return out || english;
  } catch {
    return english;
  }
}

// ---------------------------------------------------------------------------
// Defensive classification parsing
// ---------------------------------------------------------------------------

/**
 * Find the first balanced {...} block, aware of strings and escapes.
 *
 * WHY not a regex: /\{[\s\S]*\}/ is greedy across two objects and
 * /\{[\s\S]*?\}/ stops at the first '}' inside a nested object or, worse, at a
 * '}' that lives inside a quoted string. Models routinely emit prose, then the
 * JSON, then more prose; a brace counter that skips over string literals is the
 * only version that survives all of those.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

interface Classification {
  kind: ReportKind;
  severity: Severity;
  /** False when we had to fall back — the caller logs it, the row is written either way. */
  parsed: boolean;
}

const FALLBACK: Classification = { kind: 'unknown', severity: 3, parsed: false };

/**
 * Parse the classifier's reply without ever throwing.
 *
 * WHY this is so paranoid: a malformed classification must never lose a
 * citizen's report. The model has three failure habits — wrapping JSON in ```
 * fences, prefixing "Here is the JSON:", and inventing a type outside the
 * allowed set ("vandalism", "damage") or a severity outside 1-5 ("high", 7).
 * So: strip fences, take the first balanced object, then validate EVERY field
 * against the allowed set rather than trusting the shape. Anything we cannot
 * vouch for becomes kind:'unknown', severity:3 and the row still gets written —
 * an unclassified report a caretaker can read beats a 500 the citizen sees.
 */
function parseClassification(raw: string): Classification {
  if (!raw) return FALLBACK;
  try {
    // Strip markdown code fences wherever they sit (leading, trailing, both).
    const unfenced = raw
      .replace(/```[a-zA-Z]*\s*/g, ' ')
      .replace(/```/g, ' ')
      .trim();

    const block = firstJsonObject(unfenced);
    if (!block) return FALLBACK;

    const obj = JSON.parse(block) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return FALLBACK;

    const kindRaw = obj.type ?? obj.kind ?? obj.category ?? obj.damage_type;
    const kind =
      typeof kindRaw === 'string' && (REPORT_KINDS as readonly string[]).includes(kindRaw.trim().toLowerCase())
        ? (kindRaw.trim().toLowerCase() as ReportKind)
        : 'unknown';

    // An unrecognised type ("vandalism", "damage") means the model did not follow
    // the contract at all, so we do not trust its severity either — full fallback.
    if (kind === 'unknown') return FALLBACK;

    const sevRaw = obj.severity ?? obj.level ?? obj.score;
    const sevNum = typeof sevRaw === 'number' ? sevRaw : Number(String(sevRaw ?? '').trim());
    const severity: Severity = Number.isFinite(sevNum)
      ? (Math.min(5, Math.max(1, Math.round(sevNum))) as Severity)
      : 3;

    // A recognised type with a garbage severity is still a useful classification —
    // the severity has already been clamped to a sane 3.
    return { kind, severity, parsed: true };
  } catch {
    return FALLBACK;
  }
}

// ---------------------------------------------------------------------------

function numberField(form: FormData, key: string): number | null {
  const raw = form.get(key);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let lang = DEFAULT_LANG;

  try {
    if (!isConfigured()) {
      const payload = toErrorPayload(new SarvamNotConfigured());
      return NextResponse.json(payload, { status: payload.status });
    }

    const form = await req.formData();
    const audioIn = form.get('audio');
    const imageIn = form.get('image');
    const hasAudio = audioIn instanceof Blob && audioIn.size > 0;
    const hasImage = imageIn instanceof Blob && imageIn.size > 0;

    lang = normalizeLang((form.get('lang') as string | null) ?? DEFAULT_LANG);
    const monumentId = getMonument(((form.get('monument_id') as string | null) ?? DEFAULT_MONUMENT_ID) || DEFAULT_MONUMENT_ID).id;
    const sessionId = ((form.get('session_id') as string | null) ?? '') || null;
    const lat = numberField(form, 'lat');
    const lon = numberField(form, 'lon');

    if (!hasAudio && !hasImage) {
      return NextResponse.json(
        {
          error: await localize(NEED_SOMETHING, lang, false),
          kind: 'nothing_to_report',
          status: 400,
        },
        { status: 400 },
      );
    }
    if (hasImage && (imageIn as Blob).size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: 'That photograph is too large. Downscale it to 1600px before uploading.', kind: 'image_too_large', status: 413 },
        { status: 413 },
      );
    }
    if (hasAudio && (audioIn as Blob).size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: 'That recording is too long. Keep it under 30 seconds.', kind: 'audio_too_large', status: 413 },
        { status: 413 },
      );
    }

    // ---- 1. Saaras: transcribe in the visitor's own language ---------------
    // Language comes from detection, never from a picker. A `lang` field is only
    // the session's earlier detection and loses to a fresh detection here.
    let transcript = '';
    let sttError: string | null = null;
    if (hasAudio) {
      try {
        const heard = await listen(audioIn as Blob, 'transcribe');
        transcript = heard.transcript;
        if (heard.rawLang) lang = heard.lang;
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === 'SarvamAuth' || name === 'SarvamNotConfigured') throw err;
        sttError = (err as Error)?.message ?? 'stt failed';
        console.warn('[report] STT failed:', sttError);
        // Degrade rather than die: with a photograph we can still file a real
        // report. With neither words nor picture there is nothing to file.
        if (!hasImage) throw err;
      }
    }

    // ---- 2. English for the caretaker record --------------------------------
    let english = '';
    if (transcript) {
      if (normalizeLang(lang) === 'en-IN') {
        english = transcript;
      } else {
        try {
          english = await translate(transcript, 'en-IN', { from: lang });
        } catch (err) {
          console.warn('[report] translate failed, keeping the original words:', (err as Error)?.message);
          // Honest degradation: the caretaker gets the visitor's own words
          // untranslated rather than an empty field.
          english = transcript;
        }
      }
    }

    // ---- 3. Vision describes the photograph ---------------------------------
    let photoDescription: string | null = null;
    if (hasImage) {
      try {
        const desc = await readDocument(imageIn as Blob, PHOTO_PROMPT, { filename: 'damage.jpg' });
        photoDescription = desc.trim() || null;
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === 'SarvamAuth' || name === 'SarvamNotConfigured') throw err;
        console.warn('[report] photo description failed:', (err as Error)?.message);
        photoDescription = null;
      }
    }

    // ---- 4. Classify ---------------------------------------------------------
    let classification: Classification = FALLBACK;
    let classifyError: string | null = null;
    const evidence = [
      english ? `Visitor report (English): ${english}` : null,
      transcript && english !== transcript ? `Visitor's own words: ${transcript}` : null,
      photoDescription ? `Photograph: ${photoDescription}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    if (evidence) {
      try {
        const reply = await chat(
          [
            {
              role: 'system',
              content:
                'You triage conservation damage reports at Indian heritage monuments for the ' +
                'Archaeological Survey of India. You reply with one JSON object and nothing else — ' +
                'no prose, no markdown, no code fences.',
            },
            {
              role: 'user',
              content:
                `${evidence}\n\n` +
                'Reply with exactly this shape:\n' +
                '{"type":"graffiti|structural|water|litter|hazard","severity":1}\n' +
                'type must be exactly one of: graffiti, structural, water, litter, hazard.\n' +
                'severity is an integer 1 to 5, where 1 is cosmetic and 5 is dangerous to people or ' +
                'to the structure itself.',
            },
          ],
          // temperature 0 makes this deterministic AND cacheable in lib/sarvam.ts,
          // so a repeated demo report does not pay for the model twice.
          { model: MODELS.chatDeep, maxTokens: 120, temperature: 0, think: false },
        );
        classification = parseClassification(reply);
        if (!classification.parsed) {
          console.warn('[report] classifier reply did not validate, using unknown/3:', reply.slice(0, 200));
        }
      } catch (err) {
        classifyError = (err as Error)?.message ?? 'classify failed';
        console.warn('[report] classification failed, using unknown/3:', classifyError);
      }
    }

    // ---- 5. Write the row. ALWAYS. -------------------------------------------
    // This happens before TTS on purpose: if Bulbul times out, the caretaker
    // record must already exist.
    const record =
      transcript || (photoDescription ? `[photograph only] ${photoDescription}` : '[photograph only, not described]');

    const row = await insertReport({
      monument_id: monumentId,
      lang,
      transcript: record,
      severity: String(classification.severity),
      kind: classification.kind,
      // No blob storage in this build — the photograph is described, not stored.
      photo_url: null,
      lat,
      lon,
    });

    // ---- 6. Confirm in the visitor's language --------------------------------
    const confirmation = await localize(CONFIRMATION, lang);
    const voice = resolveVoice(lang);
    let audio: string | null = null;
    try {
      const spoken = await speak(confirmation, lang);
      audio = spoken.url;
    } catch (err) {
      console.warn('[report] TTS failed, returning audio:null:', (err as Error)?.message);
    }

    void logEvent(
      'report_filed',
      {
        report_id: row.id,
        monument_id: monumentId,
        lang,
        kind: classification.kind,
        severity: classification.severity,
        classified: classification.parsed,
        hasAudio,
        hasImage,
        geotagged: lat !== null && lon !== null,
        sttError,
        classifyError,
        ttsOk: audio !== null,
        totalMs: Date.now() - t0,
      },
      sessionId,
    );

    return NextResponse.json({
      id: row.id,
      kind: classification.kind,
      severity: classification.severity,
      transcript,
      english,
      photoDescription,
      confirmation,
      audio,
      // Extras beyond the shared contract — safe to ignore in other lanes.
      lang,
      voiceLang: voice.voiceLang,
      degraded: voice.degraded,
      voiceNote: voice.degraded ? voiceGapNotice(lang) : null,
      classified: classification.parsed,
      monumentId,
      lat,
      lon,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    void logEvent('report_error', { kind: payload.kind, error: payload.error, lang });
    return NextResponse.json(payload, { status: payload.status });
  }
}
