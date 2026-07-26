/**
 * The visual directive parser — the contract between the voice lane and the visual lane.
 *
 * The answering model is asked to append one line of JSON after its reply:
 *
 *     {"focus":"dome","grade":"dusk","era":"1900"}
 *
 * This function runs on EVERY turn, so it has to be boringly reliable. Language
 * models get creative with formatting in ways that are individually rare and
 * collectively certain, so every one of these has been seen in the wild and is
 * handled here:
 *
 *   1. JSON alone on the last line                      -> parsed
 *   2. JSON wrapped in a ```json fence                  -> parsed, fence removed
 *   3. JSON followed by more prose                      -> parsed, prose kept
 *   4. JSON with single quotes / unquoted keys / trailing
 *      commas / Python None / smart quotes              -> repaired, then parsed
 *   5. Genuinely malformed JSON                         -> EMPTY_DIRECTIVE, text preserved
 *   6. `focus` naming a region the monument does not
 *      have (hallucinated id, or the literal placeholder
 *      "<region id or null>")                           -> nulled out
 *   7. An invalid `grade` or an `era` the monument has
 *      no layer for                                     -> nulled out
 *   8. The reply being nothing but the JSON             -> text comes back empty, caller decides
 *
 * ONE DELIBERATE REFINEMENT over "return the full text on malformed JSON": we
 * still strip a trailing brace-span from the SPOKEN text when that span is
 * clearly a directive attempt (it mentions focus/grade/era). The directive is
 * discarded exactly as specified — but the monument must never be heard reading
 * punctuation aloud to a visitor. `ok: false` on the result tells you it happened.
 */

import { EMPTY_DIRECTIVE, type Grade, type Monument, type VisualDirective } from './types';

/** The five grades the visual engine understands (BUILD-CONTRACT.md). */
export const GRADES: readonly Grade[] = ['dawn', 'noon', 'dusk', 'night', 'sepia'] as const;

const DIRECTIVE_KEYS = ['focus', 'grade', 'era'] as const;

export interface ParsedDirective {
  /** The reply with the directive (and any code fences) removed. Safe to hand to TTS. */
  text: string;
  directive: VisualDirective;
  /** False when no well-formed directive was found — the caller may want to log it. */
  ok: boolean;
  /** The exact substring that was removed from the text, for debugging. */
  raw: string | null;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  body: string;
}

/**
 * Find every balanced `{...}` span in the text.
 *
 * A regex cannot do this: `/\{.*\}/s` is greedy across multiple objects and
 * `/\{[^}]*\}/` dies on any nesting. We walk the string tracking brace depth and
 * string state (including the quote character, so an apostrophe inside a
 * double-quoted value does not open a "string").
 */
export function findJsonSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let quote: string | null = null;
    let esc = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];

      if (quote) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          spans.push({ start: i, end: j + 1, body: text.slice(i, j + 1) });
          i = j; // skip past this object; nested braces are part of it
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * JSON.parse first (the overwhelmingly common case, and it is exact). Only if
 * that fails do we apply repairs — which is important, because the repairs are
 * lossy: turning `'` into `"` would corrupt a legitimate apostrophe inside a
 * value. Anything containing a real apostrophe would have parsed strictly.
 */
export function looseParse(src: string): unknown {
  try {
    return JSON.parse(src);
  } catch {
    /* fall through to repair */
  }

  const repaired = src
    // Smart quotes — models copy these in from prose formatting.
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // Python-isms from models trained on notebooks.
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    // Single-quoted strings.
    .replace(/'/g, '"')
    // Unquoted keys: {focus: "dome"}
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    // Trailing commas before a close.
    .replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/** Lowercases keys so `{"Focus": ...}` and `{"FOCUS": ...}` both work. */
function lowerKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k.trim().toLowerCase()] = v;
  return out;
}

/**
 * Is this object shaped like a directive? We require at least one of the three
 * keys so that an unrelated JSON blob in the reply (a quoted inscription, a
 * coordinate pair) is not mistaken for one.
 */
function asDirectiveObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let obj = lowerKeys(value as Record<string, unknown>);

  // Some models wrap it: {"directive": {...}} or {"visual": {...}}
  for (const wrapper of ['directive', 'visual', 'visual_directive', 'camera']) {
    const inner = obj[wrapper];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const unwrapped = lowerKeys(inner as Record<string, unknown>);
      if (DIRECTIVE_KEYS.some((k) => k in unwrapped)) {
        obj = unwrapped;
        break;
      }
    }
  }

  return DIRECTIVE_KEYS.some((k) => k in obj) ? obj : null;
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

const NULLISH = new Set(['', 'null', 'none', 'nil', 'undefined', 'n/a', 'na', '-', 'false']);

/** Everything that is not a usable string becomes null. Numbers are stringified (era). */
function str(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  // The model echoing the prompt placeholder back verbatim: "<region id or null>".
  if (t.startsWith('<') && t.endsWith('>')) return null;
  if (NULLISH.has(t.toLowerCase())) return null;
  return t;
}

const slug = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** A focus is only valid if the monument actually has that region. */
export function validateFocus(value: unknown, monument?: Monument | null): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (!monument) return raw; // nothing to validate against; trust the caller
  const want = slug(raw);
  const hit = monument.regions.find((r) => slug(r.id) === want);
  return hit ? hit.id : null;
}

export function validateGrade(value: unknown): Grade | null {
  const raw = str(value);
  if (!raw) return null;
  const g = raw.toLowerCase() as Grade;
  return GRADES.includes(g) ? g : null;
}

/** An era is only valid if the monument has an image layer for that year. */
export function validateEra(value: unknown, monument?: Monument | null): string | null {
  const raw = str(value);
  if (!raw) return null;
  const year = raw.match(/\d{3,4}/)?.[0];
  if (!year) return null;
  if (!monument) return year;
  const years = (monument.eras ?? []).map((e) => e.year);
  return years.includes(year) ? year : null;
}

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

/**
 * Removes the directive span and any scaffolding the model put around it: an
 * opening ```json fence immediately before, a closing fence immediately after,
 * and a "Directive:" / "JSON:" label on the preceding line.
 */
function stripAround(rawBefore: string, rawAfter: string): string {
  let before = rawBefore;
  let after = rawAfter;

  before = before.replace(/```[a-zA-Z]*\s*$/, '');
  // The label may be followed by a newline before the JSON, so the anchor has to
  // allow trailing whitespace — not just end-of-string.
  before = before.replace(/(?:^|\n)[ \t]*(?:visual[ _-]?)?(?:directive|json|output)[ \t]*[:=]?[ \t\r\n]*$/i, '\n');
  after = after.replace(/^\s*```/, '');

  return cleanSpokenText(`${before.trimEnd()}\n${after.trimStart()}`);
}

function stripSpan(raw: string, span: Span): string {
  return stripAround(raw.slice(0, span.start), raw.slice(span.end));
}

/**
 * Index of a trailing `{` that never closes, or -1.
 *
 * This is the truncation case, and it is the most likely malformed directive in
 * production: the model hits max_tokens partway through the JSON and we are
 * handed `{"focus":"dome", "grade":`. There is no balanced span to find, so the
 * ordinary scanner sees nothing and the fragment would otherwise survive into
 * the spoken text and be read aloud, punctuation and all.
 */
function findUnterminatedBrace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '{') continue;

    let depth = 0;
    let quote: string | null = null;
    let esc = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (quote) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return -1; // the last object is closed; nothing dangling
      }
    }
    return i;
  }
  return -1;
}

/** Does this fragment look like someone was trying to write a directive? */
function looksLikeDirectiveText(fragment: string): boolean {
  return /["'\s{,](focus|grade|era)["'\s]*:/i.test(fragment);
}

/**
 * Whatever survives is going to a text-to-speech engine and onto a screen.
 * Backticks, stray fences and runs of blank lines must not reach either.
 */
export function cleanSpokenText(text: string): string {
  return text
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*[\r\n]+/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Split a model reply into speakable text and a validated VisualDirective.
 *
 * @param raw       The model's complete reply.
 * @param monument  Optional. When supplied, `focus` is checked against
 *                  `monument.regions` and `era` against `monument.eras`; an id
 *                  the monument does not have is nulled rather than passed to
 *                  the visual engine, which would otherwise pan to nowhere.
 */
export function parseDirective(raw: string, monument?: Monument | null): ParsedDirective {
  const source = typeof raw === 'string' ? raw : '';
  if (!source.trim()) {
    return { text: '', directive: { ...EMPTY_DIRECTIVE }, ok: false, raw: null };
  }

  // Truncated JSON first: it sits at the very end by definition, and it is the
  // one shape the balanced-span scanner cannot see.
  const dangling = findUnterminatedBrace(source);
  if (dangling >= 0 && looksLikeDirectiveText(source.slice(dangling))) {
    return {
      text: stripAround(source.slice(0, dangling), ''),
      directive: { ...EMPTY_DIRECTIVE },
      ok: false,
      raw: source.slice(dangling),
    };
  }

  const spans = findJsonSpans(source);
  if (spans.length === 0) {
    return { text: cleanSpokenText(source), directive: { ...EMPTY_DIRECTIVE }, ok: false, raw: null };
  }

  // Search from the end: the directive is specified to come AFTER the reply, and
  // if the reply itself quoted something brace-shaped we want the later one.
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const obj = asDirectiveObject(looseParse(span.body));
    if (!obj) continue;

    const directive: VisualDirective = {
      focus: validateFocus(obj.focus, monument),
      grade: validateGrade(obj.grade),
      era: validateEra(obj.era, monument),
    };
    return { text: stripSpan(source, span), directive, ok: true, raw: span.body };
  }

  // No span parsed into a directive. If the last one at least LOOKS like a
  // directive attempt, drop it from the spoken text so the monument does not
  // recite braces; otherwise leave the text completely alone.
  const last = spans[spans.length - 1];
  const looksLikeAttempt = looksLikeDirectiveText(last.body);

  return {
    text: looksLikeAttempt ? stripSpan(source, last) : cleanSpokenText(source),
    directive: { ...EMPTY_DIRECTIVE },
    ok: false,
    raw: looksLikeAttempt ? last.body : null,
  };
}

/** True when the directive would actually change anything on screen. */
export function isEmptyDirective(d: VisualDirective): boolean {
  return d.focus === null && d.grade === null && d.era === null;
}
