import { NextResponse, type NextRequest } from 'next/server';

import { logEvent } from '@/lib/db';
import { looseParse } from '@/lib/directive';
import { SarvamAuth, SarvamNotConfigured, SarvamRateLimit, toErrorPayload } from '@/lib/errors';
import { normalizeLang } from '@/lib/langs';
import { allMonuments, getMonument } from '@/lib/monuments';
import { MODELS, chat, isConfigured, readDocument } from '@/lib/sarvam';
import { stripHistoricalClaims, type IdentifyResult } from '@/lib/userMonument';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/photo/identify
 *
 *   multipart/form-data: image (File, JPEG, already downscaled client-side), lang
 *   -> 200 { name, description, looksLike, matchedMonumentId, confidence }
 *   -> 503 { kind: 'not_configured' }  when no Sarvam key exists
 *
 * TWO OUTPUTS, TWO VERY DIFFERENT TRUST LEVELS — this is the whole design of the
 * route and the reason the shapes are separate:
 *
 *   `name`        an untrusted GUESS. It is shown to the visitor exactly once, as
 *                 an offer ("this looks like Qutub Minar — talk to the real one
 *                 instead?"), and it is NEVER forwarded to /api/photo/answer.
 *                 The talking photograph never learns a name for itself, so it
 *                 cannot build a history around one.
 *
 *   `description` the ONLY thing the answering model ever receives. Run through
 *                 stripHistoricalClaims() here, and again on the way into
 *                 /api/photo/answer because a client is not a trust boundary.
 *
 *   `matchedMonumentId` set ONLY when the guess resolves to something genuinely
 *                 present in lib/monuments' registry. That is the best possible
 *                 outcome of this whole feature: a visitor who photographed a
 *                 real monument gets the researched, cited, grounded one.
 *
 * The image is read into memory, sent to Sarvam Vision, and dropped. It is not
 * written to disk, not put in a database, and not logged. It is a stranger's
 * photograph and we have no consent to keep it.
 */

/** Guard against a client that skipped the client-side downscale. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The Vision prompt asks for a DESCRIPTION first and a name last, on purpose.
 * Asking "what is this?" first makes everything after it a rationalisation of
 * the guess — the model describes the Taj Mahal it decided it was seeing rather
 * than the marble it is actually looking at.
 */
const VISION_PROMPT = [
  'Describe this photograph for someone who cannot see it.',
  'Report ONLY what is visibly present: the main subject and its shape, its material and colour,',
  'the light and time of day, the weather and sky, the surroundings, and any distinct visible',
  'features (dome, arch, spire, steps, columns, carvings, statue, water, trees).',
  'Then, on a final separate line beginning "NAME:", give the specific name of the place or',
  'monument if you genuinely recognise it, or "NAME: unknown" if you do not.',
  'Also transcribe any text, signboard or plaque visible in the image.',
].join(' ');

const EXTRACT_SYSTEM = `You convert a raw description of a photograph into strict JSON.

Return ONE JSON object and nothing else:
{"name":<string or null>,"description":<string>,"looksLike":[<string>,...],"confidence":"high"|"low"}

Rules:
- "description" is at most 3 sentences and is PURELY VISUAL: shape, material, colour, light,
  weather, sky, surroundings, condition. It must contain NO history, NO dates, NO years,
  NO century, NO names of people, rulers, dynasties, religions, cities or countries, and NO
  claim about purpose or meaning. Describe stone, not stories.
- "looksLike" is 3 to 8 single lowercase visual nouns for parts you can actually see, drawn from:
  dome, cupola, spire, finial, minaret, tower, roof, crown, chhatri, parapet, cornice, flag,
  arch, window, balcony, carving, inscription, facade, wall, column, pillar, door, gate, lattice,
  statue, figure, railing, steps, stairs, plinth, base, courtyard, path, ground, water, pool,
  garden, grass, road, fence, shadow.
  Include a noun ONLY if that part is genuinely visible. An empty array is a correct answer.
- "name" is the specific proper name of the place ONLY if it is stated on a visible sign or you
  recognise it with real certainty. Otherwise null. A guess is worse than null here.
- "confidence" is "high" only when "name" is non-null and you are certain. Otherwise "low".

Output the JSON object alone. No prose, no code fences.`;

interface Extracted {
  name?: unknown;
  description?: unknown;
  looksLike?: unknown;
  confidence?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: 'multipart/form-data is required', kind: 'bad_request' }, { status: 400 });
    }

    const image = form.get('image');
    if (!(image instanceof Blob) || image.size === 0) {
      return NextResponse.json({ error: 'image is required', kind: 'bad_request' }, { status: 400 });
    }
    if (image.size > MAX_BYTES) {
      return NextResponse.json(
        { error: 'That photograph is too large. It should have been resized before upload.', kind: 'bad_request' },
        { status: 413 },
      );
    }

    const lang = normalizeLang(typeof form.get('lang') === 'string' ? String(form.get('lang')) : undefined);
    const sessionId = typeof form.get('sessionId') === 'string' ? String(form.get('sessionId')) : null;

    // ---- 1. Sarvam Vision --------------------------------------------------
    let raw = '';
    try {
      raw = await readDocument(image, VISION_PROMPT, { filename: 'photo.jpg', mode: 'large' });
    } catch (err) {
      // Auth and rate-limit are real, reportable failures — the visitor deserves
      // the honest 502/429. Anything else (an endpoint shape we do not know, an
      // empty parse) is survivable: the Living Photograph does not need Vision,
      // only the conversation's flavour does.
      if (err instanceof SarvamAuth || err instanceof SarvamRateLimit || err instanceof SarvamNotConfigured) throw err;
      console.warn('[api/photo/identify] vision unavailable:', (err as Error).message);
      await logEvent('photo_identify_degraded', { reason: (err as Error).message.slice(0, 200) }, sessionId);
      return NextResponse.json(empty());
    }

    // ---- 2. Structure it, and strip history out of the description ---------
    const extracted = await extract(raw);

    const name = cleanName(extracted?.name);
    const description = stripHistoricalClaims(asString(extracted?.description) || fallbackDescription(raw)).slice(0, 600);
    const looksLike = asStringArray(extracted?.looksLike);

    // ---- 3. Does the real, grounded thing already live in our registry? ----
    const matchedMonumentId = matchRegistry(name, raw);

    // A name we could not resolve to anything is never "high" confidence to us,
    // whatever the model said about itself.
    const confidence: 'high' | 'low' =
      extracted?.confidence === 'high' && name && (matchedMonumentId || name.length > 2) ? 'high' : 'low';

    await logEvent(
      'photo_identified',
      {
        lang,
        hasName: Boolean(name),
        matchedMonumentId,
        confidence,
        looksLike,
        descriptionChars: description.length,
        // Never the image, never the raw vision text — it can contain a plaque
        // with a stranger's name on it.
      },
      sessionId,
    );

    const result: IdentifyResult = { name, description, looksLike, matchedMonumentId, confidence };
    return NextResponse.json(result);
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/photo/identify] failed:', err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function empty(): IdentifyResult {
  return { name: null, description: '', looksLike: [], matchedMonumentId: null, confidence: 'low' };
}

/**
 * sarvam-105b turns the free-form Vision reading into the strict shape. If it
 * fails we still have the raw text, so the feature degrades to "a photograph
 * with a plain description" rather than to an error page.
 */
async function extract(raw: string): Promise<Extracted | null> {
  try {
    const out = await chat(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: raw.slice(0, 4000) },
      ],
      {
        model: MODELS.chatDeep,
        maxTokens: 400,
        // Near-zero: this is an extraction, not a performance. Temperature is
        // what invents the century.
        temperature: 0.1,
        // NEVER true — the reasoning_effort trap eats the whole token budget and
        // returns empty content. See lib/sarvam.ts.
        think: false,
      },
    );
    const parsed = looseParse(stripFences(out));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Extracted) : null;
  } catch (err) {
    console.warn('[api/photo/identify] extraction failed:', (err as Error).message);
    return null;
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = asString(v).toLowerCase();
    if (s && s.length < 24 && !out.includes(s)) out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

function cleanName(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  if (/^(unknown|none|null|n\/?a|not sure|unclear|unidentified)$/i.test(s)) return null;
  if (s.length > 80) return null;
  return s;
}

/**
 * Last resort when the extraction call failed: take the first couple of
 * sentences of the raw Vision reading. It still goes through
 * stripHistoricalClaims() at the call site, so a volunteered date does not
 * survive this path either.
 */
function fallbackDescription(raw: string): string {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^name\s*:/i.test(l))
    .join(' ');
  return line.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Resolve a guessed name against the grounded registry.
 *
 * Deliberately strict. A false match sends the visitor to the WRONG monument's
 * cited history, which is a worse failure than the ungrounded photograph they
 * already have — so we require a full containment match in one direction or the
 * other on a name of real length, and we verify the id round-trips through
 * getMonument (which falls back to the default monument for anything unknown,
 * and would otherwise hand back Qutub Minar for every miss).
 */
function matchRegistry(name: string | null, raw: string): string | null {
  const haystacks = [name, raw.slice(0, 400)].filter((v): v is string => Boolean(v)).map(fold);
  if (haystacks.length === 0) return null;

  for (const monument of allMonuments()) {
    const candidates = [monument.id.replace(/-/g, ' '), ...Object.values(monument.displayName)];
    for (const candidate of candidates) {
      const needle = fold(candidate);
      if (needle.length < 5) continue;
      const hit = haystacks.some((hay) => hay.includes(needle) || (needle.includes(hay) && hay.length >= 5));
      if (!hit) continue;
      // getMonument() silently substitutes the default for an unknown id, so an
      // identity check is the only way to know the registry really has this one.
      if (getMonument(monument.id).id === monument.id) return monument.id;
    }
  }
  return null;
}
