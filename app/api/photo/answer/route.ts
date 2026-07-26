import { NextResponse, type NextRequest } from 'next/server';

import { logEvent, logTurn } from '@/lib/db';
import { parseDirective } from '@/lib/directive';
import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { normalizeLang, type LangCode } from '@/lib/langs';
import { guessLangFromScript } from '@/lib/prompts';
import { MODELS, chat, isConfigured } from '@/lib/sarvam';
import { EMPTY_DIRECTIVE, type Monument, type Region, type VisualDirective } from '@/lib/types';
import {
  containsHistoricalClaim,
  doNotKnowMyself,
  stripHistoricalClaims,
  ungroundedMessages,
  type PhotoAnswerResult,
  type RegionHint,
} from '@/lib/userMonument';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/photo/answer
 *
 *   json: { transcript, lang, description, regions, sessionId? }
 *   -> 200 PhotoAnswerResult — the same { text, directive } contract the main
 *          voice loop consumes, so hooks/useVoiceLoop.ts can drive this route
 *          with no changes to how it reads a reply.
 *   -> 503 { kind: 'not_configured' }
 *
 * THIS ROUTE CANNOT MAKE A HISTORICAL CLAIM. Not "is instructed not to" —
 * cannot, for four independent reasons, any one of which would have to fail
 * silently and simultaneously with the others for a fabricated date to be spoken:
 *
 *   1. There is no retrieval here at all. `retrieveSources` is not imported,
 *      `getMonument` is not imported, and `sources` is `[]` in the response type.
 *      There is no code path that could put a fact in front of the model.
 *
 *   2. The prompt is `ungroundedSystemPrompt`, not `answerSystemPrompt`. Its
 *      signature accepts a visual description and region ids — it has no
 *      parameter for sources, a name, or a history.
 *
 *   3. Everything the client sends is sanitised before it reaches the prompt.
 *      `description` goes through `stripHistoricalClaims`; the identified NAME is
 *      not a field on this route's body at all, so the photograph never learns
 *      what it might be called. A hostile client cannot inject history because
 *      there is no field that carries it.
 *
 *   4. The generated reply is checked by `containsHistoricalClaim` BEFORE it is
 *      returned. Any three-digit numeral in any script, any century or dynasty
 *      vocabulary, and the reply is discarded and replaced with the pre-written
 *      "I do not know that about myself" line in the visitor's own language.
 *      The rejection is reported in `guardTripped`, not hidden.
 */

interface PhotoAnswerBody {
  transcript?: string;
  lang?: string;
  description?: string;
  /** Either region ids, or {id,label} hints. Both are accepted. */
  regions?: unknown;
  sessionId?: string;
  /** Client's elapsed ms so far (STT included), for honest end-to-end logging. */
  elapsedMs?: number;
}

/** Two sentences maximum — BUILD-CONTRACT rule 5, enforced, not merely requested. */
const MAX_SENTENCES = 2;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let sessionId: string | null = null;

  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const body = (await req.json().catch(() => ({}))) as PhotoAnswerBody;
    const transcript = (body.transcript ?? '').trim();
    sessionId = body.sessionId ?? null;

    if (!transcript) {
      return NextResponse.json({ error: 'transcript is required', kind: 'bad_request' }, { status: 400 });
    }

    // Language comes from Saaras upstream. The script guess is only for the
    // typed fallback, where there is no detection to trust. No picker, ever.
    const lang: LangCode = body.lang
      ? normalizeLang(body.lang)
      : normalizeLang(guessLangFromScript(transcript) ?? undefined);

    const regions = readRegions(body.regions);
    // Sanitised here as well as in /api/photo/identify: the client is not a
    // trust boundary, and this is the last point before the model sees it.
    const description = stripHistoricalClaims((body.description ?? '').slice(0, 1200));

    const timings: PhotoAnswerResult['timings'] = {};

    // --- Generate -----------------------------------------------------------
    const tGen = Date.now();
    const raw = await chat(ungroundedMessages({ lang, description, regions }, transcript), {
      // The fast model. There is nothing to reason over — no sources, no
      // synthesis — so the deep model would buy latency and no accuracy.
      model: MODELS.chatFast,
      maxTokens: 220,
      temperature: 0.6,
      // NEVER true on the voice path. See the reasoning_effort trap in lib/sarvam.
      think: false,
    });
    timings.generate = Date.now() - tGen;

    // Reuse the ONE directive parser. Focus is validated against the derived
    // region ids; `eras: []` means every `era` value the model emits is nulled.
    const shape = monumentShape(regions);
    const parsed = parseDirective(raw, shape);
    if (!parsed.ok) {
      await logEvent('photo_directive_unparsed', { raw: raw.slice(0, 300) }, sessionId);
    }

    let text = clampSentences(parsed.text);
    let directive: VisualDirective = parsed.directive;
    // `remembered: false` here means "I had to admit I do not know", which for an
    // ungrounded photograph is a success, not a failure. `null` means the model
    // did not say — read as "not a refusal", exactly as lib/directive specifies.
    let admittedIgnorance = parsed.remembered === false;
    let guardTripped = false;

    // --- THE GUARD ----------------------------------------------------------
    if (!text || containsHistoricalClaim(text)) {
      if (text) {
        guardTripped = true;
        // Log the rejected line so the failure is auditable after a demo. It is
        // the model's own output about a stranger's photograph — no personal
        // data, and knowing what slipped through is how the prompt gets better.
        await logEvent('photo_history_blocked', { rejected: text.slice(0, 240), lang }, sessionId);
      }
      text = doNotKnowMyself(lang);
      // Do not pan or re-grade while admitting ignorance: a camera move under a
      // refusal reads as the photograph contradicting itself.
      directive = { ...EMPTY_DIRECTIVE };
      admittedIgnorance = true;
    }

    if (admittedIgnorance) {
      directive = { ...EMPTY_DIRECTIVE };
    }

    timings.total = Date.now() - t0;

    if (sessionId) {
      await logTurn({
        session_id: sessionId,
        role: 'monument',
        text,
        lang,
        latency_ms: timings.total ?? null,
      }).catch((err) => console.warn('[api/photo/answer] logTurn failed:', (err as Error).message));
    }
    await logEvent(
      'photo_turn_answered',
      {
        lang,
        grounded: false,
        admittedIgnorance,
        guardTripped,
        regionIds: regions.map((r) => r.id),
        directive,
        timings,
        clientElapsedMs: body.elapsedMs ?? null,
      },
      sessionId,
    );

    const result: PhotoAnswerResult = {
      text,
      directive,
      lang,
      grounded: false,
      sources: [],
      admittedIgnorance,
      model: MODELS.chatFast,
      timings,
      ...(guardTripped ? { guardTripped: true } : {}),
    };
    // `intent` and `retrievalMode` are added for shape-compatibility with
    // /api/answer so useVoiceLoop paints this reply exactly as it paints a
    // grounded one — with `sources: []`, which is the honest value.
    return NextResponse.json({ ...result, intent: 'SIMPLE', retrievalMode: null });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/photo/answer] failed:', err);
    await logEvent('photo_answer_error', { kind: payload.kind, error: payload.error }, sessionId);
    return NextResponse.json(payload, { status: payload.status });
  }
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Accepts `["dome","base"]` or `[{id:"dome",label:"the dome"}]`.
 *
 * Ids are re-validated against a slug pattern rather than trusted: they are
 * interpolated into the system prompt, and an "id" containing a newline and a
 * fresh instruction is the obvious injection against a route like this one.
 */
function readRegions(value: unknown): RegionHint[] {
  if (!Array.isArray(value)) return [];
  const out: RegionHint[] = [];
  for (const entry of value) {
    let id = '';
    let label = '';
    if (typeof entry === 'string') {
      id = entry;
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      id = typeof rec.id === 'string' ? rec.id : '';
      const raw = rec.label;
      if (typeof raw === 'string') label = raw;
      else if (raw && typeof raw === 'object') {
        const first = Object.values(raw as Record<string, unknown>).find((v) => typeof v === 'string');
        label = typeof first === 'string' ? first : '';
      }
    }
    id = id.trim().toLowerCase();
    if (!SLUG.test(id) || out.some((r) => r.id === id)) continue;
    out.push({ id, label: sanitizeLabel(label) || id.replace(/-/g, ' ') });
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n{}"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * The minimum a `Monument` needs for `parseDirective` to validate against:
 * the region ids, and an empty `eras` so every era the model invents is nulled.
 * `sources: []` is not decoration — it is the type-level statement that this
 * object has nothing to answer from.
 */
function monumentShape(regions: RegionHint[]): Monument {
  const asRegions: Region[] = regions.map((r) => ({
    id: r.id,
    x: 0.5,
    y: 0.5,
    z: 0.5,
    label: { 'en-IN': r.label },
  }));
  return {
    id: 'photo',
    displayName: { 'en-IN': 'your photograph' },
    city: '',
    hero: '',
    depth: '',
    aspect: 1,
    credit: '',
    regions: asRegions,
    eras: [],
    sources: [],
  };
}

/**
 * Rule 5, enforced. Splits on Latin punctuation and the Devanagari danda, keeps
 * the first two, and never returns empty — a trailing fragment with no
 * terminator still counts as a sentence, otherwise a reply that ran out of
 * tokens mid-word would be silently deleted.
 */
function clampSentences(text: string, limit = MAX_SENTENCES): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const parts = clean.split(/(?<=[।.!?॥])\s+/).filter(Boolean);
  if (parts.length <= limit) return clean;
  return parts.slice(0, limit).join(' ').trim();
}
