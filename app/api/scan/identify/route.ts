import { NextResponse, type NextRequest } from 'next/server';

import { logEvent } from '@/lib/db';
import { SarvamAuth, SarvamNotConfigured, SarvamRateLimit, toErrorPayload } from '@/lib/errors';
import { normalizeLang } from '@/lib/langs';
import { allMonuments, displayName, getMonument } from '@/lib/monuments';
import { MODELS, chat, isConfigured, readDocument } from '@/lib/sarvam';

import {
  decide,
  matchByName,
  nounsIn,
  parseChoice,
  visionGuess,
  type Choice,
  type ScanConfidence,
} from './_match';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/scan/identify — one frame from the live camera, against the ten.
 *
 *   multipart/form-data: frame (Blob, JPEG, ~640px long edge), lang?, sessionId?
 *   -> 200 { matchedMonumentId, name, confidence, looksLike, ms }
 *   -> 503 { kind: 'not_configured' }  when no Sarvam key exists
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT /api/photo/identify
 * ---------------------------------------------------------------------------
 *
 * That route answers "describe this photograph so it can talk about itself".
 * This one answers a strictly smaller and much more dangerous question: "is the
 * thing in front of this camera one of the ten monuments we actually hold
 * researched, cited sources for?"
 *
 * Dangerous because the cost of a wrong YES is not a bad answer — it is the
 * WRONG MONUMENT'S CITED HISTORY presented as fact about the building the
 * visitor is standing in front of. Every design decision below is bent towards
 * making a false positive hard:
 *
 *   1. The model is given a CLOSED LIST and is told NONE is the usual answer.
 *      It may only emit an id copied from that list.
 *   2. Whatever it emits is validated with `hasMonument()`. `getMonument()` is
 *      never used to derive a match — it silently substitutes the default, so
 *      deriving from it would turn every miss into a confident "Qutub Minar".
 *   3. A SECOND, entirely deterministic matcher reads the raw Vision text for a
 *      monument's own name (a signboard, or Vision naming it outright). It uses
 *      no model at all, so it cannot hallucinate.
 *   4. `confidence: 'high'` — the only value the client will auto-navigate on —
 *      requires the two to agree, or the model to be certain while the text
 *      names nothing at all. Disagreement is downgraded, never averaged.
 *
 * The frame is read into memory, sent to Sarvam Vision, and dropped. It is not
 * written to disk, not stored, and not logged. It is a live camera frame of
 * wherever a stranger is standing.
 *
 * The matching itself lives in ./_match.ts — pure, synchronous, and free of the
 * `server-only` import chain, so the logic that decides whether to send a
 * visitor somewhere can be exercised directly rather than only through a live
 * Sarvam key.
 *
 * Deliberately NOT sharing helpers with /api/photo/identify. The two routes
 * look similar and have opposite failure preferences: that one wants a
 * description at almost any cost, this one wants NONE at almost any cost. A
 * shared matcher would have to be tuned for both, and the tuning that is right
 * there is exactly the tuning that produces false positives here.
 */

export interface ScanIdentifyResult {
  /** Validated against hasMonument(). Never a guess, never a fallback. */
  matchedMonumentId: string | null;
  /** English display name when matched; Vision's untrusted guess otherwise. */
  name: string | null;
  confidence: ScanConfidence;
  /** Visual nouns actually present in the frame. Drives the live "I can see…" line. */
  looksLike: string[];
  ms: number;
}

/**
 * A 640px q0.7 JPEG is ~40KB. 512KB is a generous ceiling that still catches a
 * client that skipped the downscale — on a live loop that would be the
 * difference between 40KB and 5MB every two seconds.
 */
const MAX_BYTES = 512 * 1024;

/**
 * Description first, name last — the same ordering discipline as the photo
 * route. Asking "what is this?" first makes everything after it a
 * rationalisation of the guess.
 *
 * Kept to two or three sentences because this runs on a loop: the classifier
 * below only needs enough to discriminate ten buildings, and every extra token
 * is latency on a live viewfinder.
 */
const VISION_PROMPT = [
  'This is a single frame from a phone camera pointed at a building or place in India.',
  'In two or three sentences describe ONLY what is visibly present: the main structure and its',
  'overall shape, its material and colour, its distinctive visible features (dome, minaret, spire,',
  'arches, columns, carvings, gateway, towers, steps, water, gardens), and the setting and light.',
  'Transcribe exactly any signboard, plaque, lettering or inscription that is legible in the frame.',
  'Then, on a final separate line beginning "NAME:", give the name of the place if you genuinely',
  'recognise it, or "NAME: unknown" if you do not.',
].join(' ');

/**
 * The classifier prompt. One line out, nothing else.
 *
 * Note the explicit statement that NONE is the common answer. Without it a
 * closed-list classifier behaves like a forced-choice quiz and always picks its
 * nearest entry — which for a camera pointed at an ordinary street means a
 * confident "Red Fort" for every red wall in India.
 */
function classifierSystem(): string {
  const list = allMonuments()
    .map((m) => {
      const name = displayName(m, 'en-IN');
      return `${m.id} = ${name}${m.city ? `, ${m.city}` : ''}`;
    })
    .join('\n');

  return `You match a description of a photograph against a FIXED, CLOSED list of ten Indian monuments.

KNOWN LIST (id = name):
${list}

Answer with ONE line and nothing else, in exactly one of these two forms:
<id> SURE
<id> UNSURE
NONE

Rules:
- <id> must be copied EXACTLY, character for character, from the KNOWN LIST above.
  Never invent an id. Never answer with a name, a city, a sentence or an explanation.
- NONE is the correct answer for almost every photograph. The world is full of buildings and
  only ten of them are on this list. Answer NONE unless the description genuinely matches one.
- Answer SURE only when the description NAMES the monument, transcribes its name from a sign,
  or reports a feature that belongs to no other entry on the list. Otherwise answer UNSURE.
- Do not use code fences, punctuation, markdown or any other text.`;
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: 'multipart/form-data is required', kind: 'bad_request' }, { status: 400 });
    }

    const frame = form.get('frame');
    if (!(frame instanceof Blob) || frame.size === 0) {
      return NextResponse.json({ error: 'frame is required', kind: 'bad_request' }, { status: 400 });
    }
    if (frame.size > MAX_BYTES) {
      return NextResponse.json(
        {
          error: 'That frame is too large. The scanner downscales to a 640px long edge before upload.',
          kind: 'bad_request',
        },
        { status: 413 },
      );
    }

    const lang = normalizeLang(typeof form.get('lang') === 'string' ? String(form.get('lang')) : undefined);
    const sessionId = typeof form.get('sessionId') === 'string' ? String(form.get('sessionId')) : null;

    // ---- 1. Sarvam Vision reads the frame ----------------------------------
    let raw = '';
    try {
      // 'large' rather than 'small' on purpose. This is the accurate model, and
      // accuracy is the entire safety property here — a weaker read produces
      // vaguer text, and vague text is what makes a closed-list classifier
      // start guessing. The frame rate is governed client-side, so the cost of
      // the accurate model is bounded at a dozen calls per scan.
      raw = await readDocument(frame, VISION_PROMPT, { filename: 'frame.jpg', mode: 'large' });
    } catch (err) {
      // Auth, rate limit and missing key are real and reportable — the scanner
      // must stop rather than hammer a throttled account. Anything else is a
      // frame we simply could not read: answer "no match" and let the visitor
      // move the camera.
      if (err instanceof SarvamAuth || err instanceof SarvamRateLimit || err instanceof SarvamNotConfigured) throw err;
      console.warn('[api/scan/identify] vision unavailable:', (err as Error).message);
      await logEvent('scan_frame_degraded', { reason: (err as Error).message.slice(0, 200) }, sessionId);
      return NextResponse.json(none(started));
    }

    // ---- 2. Two independent matchers ---------------------------------------
    const choice = await classify(raw);
    const textId = matchByName(raw);

    const { matchedMonumentId, confidence } = decide(choice, textId);

    // ---- 3. Name and visible nouns -----------------------------------------
    // getMonument() is used ONLY after hasMonument() has already approved the id
    // — never to derive the match itself.
    const name = matchedMonumentId
      ? displayName(getMonument(matchedMonumentId), 'en-IN')
      : visionGuess(raw);

    const looksLike = nounsIn(raw);

    await logEvent(
      'scan_frame',
      {
        lang,
        matchedMonumentId,
        confidence,
        modelSaid: choice.id,
        modelSure: choice.sure,
        textSaid: textId,
        looksLike,
        bytes: frame.size,
        ms: Date.now() - started,
        // Never the frame, never the raw Vision text — it can contain a
        // signboard with a stranger's name or a street address on it.
      },
      sessionId,
    );

    const result: ScanIdentifyResult = {
      matchedMonumentId,
      name,
      confidence,
      looksLike,
      ms: Date.now() - started,
    };
    return NextResponse.json(result);
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/scan/identify] failed:', err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

// ---------------------------------------------------------------------------
// The classifier — sarvam-105b over a closed list
// ---------------------------------------------------------------------------

function none(started: number): ScanIdentifyResult {
  return { matchedMonumentId: null, name: null, confidence: 'none', looksLike: [], ms: Date.now() - started };
}

async function classify(raw: string): Promise<Choice> {
  try {
    const out = await chat(
      [
        { role: 'system', content: classifierSystem() },
        { role: 'user', content: raw.slice(0, 2000) },
      ],
      {
        model: MODELS.chatDeep,
        // One short line. Enough headroom for a leading newline and nothing more.
        maxTokens: 24,
        // Zero, which also makes lib/sarvam cache the answer: a phone held on
        // the same view producing the same description costs nothing the second
        // time. Temperature is what invents an eleventh monument.
        temperature: 0,
        // NEVER true — the reasoning_effort trap returns empty content with
        // finish_reason "length". See lib/sarvam.ts.
        think: false,
      },
    );
    return parseChoice(out);
  } catch (err) {
    // A failed classifier is a frame with no model opinion, not an error page.
    // The deterministic matcher may still have something.
    console.warn('[api/scan/identify] classifier failed:', (err as Error).message);
    return { id: null, sure: false };
  }
}
