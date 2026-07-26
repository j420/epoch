import { NextResponse, type NextRequest } from 'next/server';

import { SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { logEvent, logTurn } from '@/lib/db';
import { parseDirective } from '@/lib/directive';
import { normalizeLang, type LangCode } from '@/lib/langs';
import { getMonument } from '@/lib/monuments';
import {
  VISUAL_EXTRA_RULE,
  answerMessages,
  checkReplyScript,
  classificationMessages,
  doNotRemember,
  guessLangFromText,
  memoryLeadIn,
  noMemoriesYet,
  parseIntent,
  reportAcknowledgement,
  retrievalDepth,
} from '@/lib/prompts';
import { retrieveSources } from '@/lib/retrieval';
import { MODELS, chat, isConfigured, translate } from '@/lib/sarvam';
import { EMPTY_DIRECTIVE, type Intent, type Monument, type SourceChunk, type StageTimings, type VisualDirective } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * route -> retrieve -> generate.
 *
 * The order matters and so does the early exit. Constraint 4 says every factual
 * claim comes from a retrieved chunk, so when retrieveSources() reports
 * `empty: true` we do NOT call the model with an empty SOURCES block hoping it
 * will behave. We say we do not remember, in the visitor's language, and set
 * admittedIgnorance. That branch is also the fastest path in the whole product,
 * which is a pleasant accident.
 */

interface AnswerBody {
  transcript?: string;
  lang?: string;
  monumentId?: string;
  sessionId?: string;
  /** scripts/smoke.ts posts snake_case; both spellings are accepted. */
  monument_id?: string;
  session_id?: string;
  /** Skip the routing call — used by the debug page to force a branch. */
  intent?: Intent;
  /** Client's total elapsed ms so far (STT included), for honest end-to-end logging. */
  elapsedMs?: number;
}

export interface AnswerHandoff {
  kind: 'memory' | 'report';
  /** The route another lane owns. We code against it; we never create it. */
  endpoint: string;
  /** False when that lane has not shipped yet — the UI must not pretend it worked. */
  available: boolean;
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let sessionId: string | null = null;

  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const body = (await req.json().catch(() => ({}))) as AnswerBody;
    const transcript = (body.transcript ?? '').trim();
    sessionId = body.sessionId ?? body.session_id ?? null;
    const monumentId = body.monumentId ?? body.monument_id;

    if (!transcript) {
      return NextResponse.json({ error: 'transcript is required', kind: 'bad_request' }, { status: 400 });
    }

    const monument = getMonument(monumentId);
    // Language always comes from upstream (Saaras). The script guess is only a
    // last resort for the typed fallback, where there is no detection to use.
    const lang: LangCode = body.lang ? normalizeLang(body.lang) : normalizeLang(guessLangFromText(transcript) ?? undefined);

    const timings: StageTimings = {};

    // --- 1. Route -------------------------------------------------------------
    let intent: Intent;
    if (body.intent) {
      intent = body.intent;
      timings.route = 0;
    } else {
      const tRoute = Date.now();
      intent = await classify(transcript, monument, lang);
      timings.route = Date.now() - tRoute;
    }

    // --- 2a. REPORT: hand straight to the vision lane -------------------------
    // No model call: the visitor is reporting damage, not asking a question, and
    // the useful next step is the camera. /api/report is owned by the vision lane.
    if (intent === 'REPORT') {
      const text = reportAcknowledgement(lang);
      timings.total = Date.now() - t0;
      await record(sessionId, text, lang, timings, intent, 'none', []);
      return NextResponse.json({
        text,
        directive: { ...EMPTY_DIRECTIVE },
        intent,
        lang,
        sources: [],
        model: 'none',
        timings,
        admittedIgnorance: false,
        handoff: { kind: 'report', endpoint: '/api/report', available: true } satisfies AnswerHandoff,
      });
    }

    // --- 2b. MEMORY: ask the echo wall ---------------------------------------
    let memoryUnavailable = false;
    if (intent === 'MEMORY') {
      const tMem = Date.now();
      const memories = await fetchMemories(req.nextUrl.origin, monument.id, transcript, lang);
      timings.retrieve = Date.now() - tMem;

      if (memories !== null) {
        const text = memories.length > 0 ? memoryLeadIn(lang) : noMemoriesYet(lang);
        timings.total = Date.now() - t0;
        await record(sessionId, text, lang, timings, intent, 'none', []);
        return NextResponse.json({
          text,
          directive: { ...EMPTY_DIRECTIVE },
          intent,
          lang,
          sources: [],
          model: 'none',
          timings,
          admittedIgnorance: false,
          memories,
          handoff: { kind: 'memory', endpoint: '/api/memories/retrieve', available: true } satisfies AnswerHandoff,
        });
      }
      // The echo lane has not shipped its retrieval route yet. Answering the
      // question normally is a far better failure than silence, but the client
      // is told, so no UI can imply that memories were found.
      memoryUnavailable = true;
      await logEvent('memory_lane_unavailable', { monumentId: monument.id }, sessionId);
    }

    /** Present on every response from here down, so the fallback is never invisible. */
    const memoryHandoff = memoryUnavailable
      ? ({ kind: 'memory', endpoint: '/api/memories/retrieve', available: false } satisfies AnswerHandoff)
      : undefined;

    // --- 3. Retrieve ----------------------------------------------------------
    const tRetrieve = Date.now();
    const retrieval = await retrieveSources(monument.id, monument.sources, transcript, retrievalDepth(intent));
    timings.retrieve = (timings.retrieve ?? 0) + (Date.now() - tRetrieve);

    // Still correct, and still reachable: the ranked path (a corpus above
    // SMALL_CORPUS_MAX, or a registered embedder) can genuinely retrieve nothing.
    // On the small-corpus full-context path this is only true for an empty corpus,
    // and rule 4 is enforced at generation instead — see `remembered` below.
    if (retrieval.empty) {
      // Never call the model with no sources. This is the whole of constraint 4.
      const text = doNotRemember(lang);
      timings.total = Date.now() - t0;
      await record(sessionId, text, lang, timings, intent, 'none', []);
      await logEvent('admitted_ignorance', { transcript, monumentId: monument.id, intent }, sessionId);
      return NextResponse.json({
        text,
        directive: { ...EMPTY_DIRECTIVE },
        intent,
        lang,
        sources: [],
        retrievalMode: retrieval.mode,
        model: 'none',
        timings,
        admittedIgnorance: true,
        ...(memoryHandoff ? { handoff: memoryHandoff } : {}),
      });
    }

    // --- 4. Generate ----------------------------------------------------------
    const model = intent === 'DEEP' ? MODELS.chatDeep : MODELS.chatFast;
    const tGen = Date.now();
    const raw = await chat(
      answerMessages(monument, lang, retrieval.chunks, transcript, {
        intent,
        retrievalMode: retrieval.mode,
        extraRule: intent === 'VISUAL' ? VISUAL_EXTRA_RULE : undefined,
      }),
      {
        model,
        // Two sentences plus a JSON line. DEEP gets a little more rope because
        // Indic scripts are token-hungry and a truncated reply is unspeakable.
        maxTokens: intent === 'DEEP' ? 340 : 220,
        temperature: 0.6,
        // NEVER true on the voice path — see the reasoning_effort trap in lib/sarvam.
        think: false,
      },
    );
    timings.generate = Date.now() - tGen;

    const parsed = parseDirective(raw, monument);
    let text = parsed.text;
    const directive: VisualDirective = parsed.directive;

    if (!parsed.ok) {
      // Malformed or absent directive is not an error — we speak the text anyway.
      await logEvent('directive_unparsed', { raw: raw.slice(0, 300), monumentId: monument.id }, sessionId);
    }

    /**
     * RULE 4's ENFORCEMENT POINT.
     *
     * Retrieval no longer filters on the demo corpus, so "we had sources" proves
     * nothing about relevance — the monument itself is now the one that decides
     * whether it remembered, and reports it in the directive JSON. `null` means
     * it did not say, which we must read as "not a refusal": defaulting the other
     * way would brand every reply with a missing directive as an admission of
     * ignorance.
     */
    const refused = parsed.remembered === false;
    if (parsed.remembered === null) {
      await logEvent('remembered_missing', { raw: raw.slice(0, 200), mode: retrieval.mode }, sessionId);
    }

    // A VISUAL turn without a focus leaves the camera doing nothing while the
    // visitor points at something. Infer it from the words they used — but never
    // when refusing: panning to a carving while saying "I do not remember" reads
    // as the monument contradicting itself.
    if (refused) {
      directive.focus = null;
      directive.grade = null;
      directive.era = null;
    } else if (intent === 'VISUAL' && !directive.focus) {
      directive.focus = inferFocus(monument, transcript, lang);
    }

    // The model returned nothing but a directive (rare, but it happens when the
    // reply is short and the JSON swallows it). Do not play silence.
    if (!text) {
      text = doNotRemember(lang);
      await logEvent('empty_after_strip', { raw: raw.slice(0, 300) }, sessionId);
    }

    /**
     * DID IT ACTUALLY ANSWER IN THE VISITOR'S LANGUAGE?
     *
     * The prompt asks, twice, and the model still sometimes answers in the
     * English of the SOURCES block — most often on the DEEP model, and most
     * often for the languages with the least training data, which are exactly
     * the visitors this product exists for. A prompt is a request, not a
     * guarantee, so the reply is checked before it is spoken.
     *
     * `checkReplyScript` only reports 'mismatch' when the expected script is
     * completely absent AND there is a sentence of Latin in its place, so a
     * correct reply cannot trigger this. When it does fire we repair with one
     * Sarvam translate call rather than shipping a language the visitor did not
     * speak; if the repair fails we speak the original and say so in the payload
     * instead of failing the turn. Either way the event is logged, because a
     * mismatch is a prompt regression someone needs to see.
     */
    let langMismatch = false;
    let langRepaired = false;
    if (checkReplyScript(text, lang) === 'mismatch') {
      langMismatch = true;
      const tRepair = Date.now();
      await logEvent('lang_mismatch', { lang, intent, model, text: text.slice(0, 200) }, sessionId);
      try {
        const repaired = await translate(text, lang, { colloquial: true });
        if (repaired && checkReplyScript(repaired, lang) !== 'mismatch') {
          text = repaired;
          langRepaired = true;
        }
        await logEvent('lang_repair', { lang, ok: langRepaired, ms: Date.now() - tRepair }, sessionId);
      } catch (err) {
        // Speaking the wrong language is bad; speaking nothing is worse.
        console.warn('[api/answer] language repair failed:', (err as Error).message);
        await logEvent('lang_repair_failed', { lang, error: (err as Error).message }, sessionId);
      }
      timings.generate = (timings.generate ?? 0) + (Date.now() - tRepair);
    }

    timings.total = Date.now() - t0;
    await record(sessionId, text, lang, timings, intent, model, retrieval.chunks, {
      scores: retrieval.scores,
      directive,
      retrievalMode: retrieval.mode,
      admittedIgnorance: refused,
      langMismatch,
      langRepaired,
      clientElapsedMs: body.elapsedMs ?? null,
    });
    if (refused) {
      await logEvent('admitted_ignorance', { transcript, monumentId: monument.id, intent, at: 'generation' }, sessionId);
    }

    return NextResponse.json({
      text,
      directive,
      intent,
      lang,
      // In full-context mode these are the whole corpus, NOT a relevance-filtered
      // set. `retrievalMode` is what tells a caller which of the two it is holding.
      sources: retrieval.chunks,
      retrievalMode: retrieval.mode,
      model,
      timings,
      admittedIgnorance: refused,
      scores: retrieval.scores,
      directiveOk: parsed.ok,
      remembered: parsed.remembered,
      /** True when the model replied in the wrong script and we caught it. */
      langMismatch,
      /** True when the mismatch was repaired by translating into `lang`. */
      langRepaired,
      ...(memoryHandoff ? { handoff: memoryHandoff } : {}),
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/answer] failed:', err);
    await logEvent('answer_error', { kind: payload.kind, error: payload.error }, sessionId);
    return NextResponse.json(payload, { status: payload.status });
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * One token out of sarvam-30b at temperature 0 — deterministic, and cached by
 * lib/sarvam so a repeated question during a demo costs nothing.
 *
 * A router failure must never cost the visitor their turn: if the call throws we
 * fall back to SIMPLE, which answers from the fast model and always works.
 */
async function classify(transcript: string, monument: Monument, lang: LangCode): Promise<Intent> {
  try {
    const raw = await chat(classificationMessages(transcript, monument, lang), {
      model: MODELS.chatFast,
      maxTokens: 8,
      temperature: 0,
      think: false,
    });
    return parseIntent(raw);
  } catch (err) {
    console.warn('[api/answer] routing failed, defaulting to SIMPLE:', (err as Error).message);
    return 'SIMPLE';
  }
}

// ---------------------------------------------------------------------------
// Cross-lane call: the echo wall
// ---------------------------------------------------------------------------

/**
 * The echo lane owns /api/memories/retrieve. We code against its interface and
 * do not create it.
 *
 *   POST { monumentId, query, lang, limit } -> { memories: Memory[] }
 *
 * Returns null when the route is absent, errors, or takes too long — the caller
 * then answers the question from sources instead. A 1.5s ceiling keeps a missing
 * lane from eating the entire latency budget.
 */
async function fetchMemories(
  origin: string,
  monumentId: string,
  query: string,
  lang: LangCode,
): Promise<unknown[] | null> {
  try {
    const res = await fetch(new URL('/api/memories/retrieve', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monumentId, query, lang, limit: 3 }),
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!res.ok) return null; // 404 while the lane is unbuilt, 5xx if it is broken
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray((data as { memories?: unknown[] })?.memories)) return (data as { memories: unknown[] }).memories;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Focus inference for VISUAL turns
// ---------------------------------------------------------------------------

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Match the visitor's words against every localized label the monument holds for
 * each region, not just the labels in the detected language: a Tamil speaker
 * code-mixing "andha dome" should still land on `dome`. Longest match wins so
 * "the sky above me" beats "sky" when both appear.
 */
function inferFocus(monument: Monument, transcript: string, lang: LangCode): string | null {
  const hay = fold(transcript);
  if (!hay) return null;

  let best: { id: string; len: number } | null = null;
  for (const region of monument.regions) {
    const candidates = [region.id, ...Object.values(region.label)];
    for (const candidate of candidates) {
      for (const token of fold(candidate).split(' ')) {
        // Two-character tokens produce nonsense matches across scripts.
        if (token.length < 3) continue;
        if (!hay.includes(token)) continue;
        if (!best || token.length > best.len) best = { id: region.id, len: token.length };
      }
    }
  }
  void lang; // labels from every language are searched; the detected one has no privilege
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * turns.latency_ms carries the end-to-end server time for this turn; the full
 * per-stage breakdown goes to the events table, which is where the latency HUD
 * numbers can be audited after a demo.
 */
async function record(
  sessionId: string | null,
  text: string,
  lang: LangCode,
  timings: StageTimings,
  intent: Intent,
  model: string,
  sources: SourceChunk[],
  extra: Record<string, unknown> = {},
) {
  if (sessionId) {
    await logTurn({
      session_id: sessionId,
      role: 'monument',
      text,
      lang,
      latency_ms: timings.total ?? null,
    }).catch((err) => console.warn('[api/answer] logTurn failed:', (err as Error).message));
  }
  await logEvent(
    'turn_answered',
    { intent, model, timings, lang, sourceIds: sources.map((s) => s.id), ...extra },
    sessionId,
  );
}
