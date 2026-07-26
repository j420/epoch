import { allMonuments, hasMonument } from '@/lib/monuments';

/**
 * The matching logic for /api/scan/identify, kept apart from the route.
 *
 * Pure, synchronous, and free of `server-only` imports so it can be exercised
 * directly. That matters more here than anywhere else in this lane: these
 * functions are the only thing standing between a chatty language model and a
 * visitor being told, with citations, about a building they are not looking at.
 */

export interface Choice {
  /** hasMonument()-validated, or null. Free text can never become an id. */
  id: string | null;
  sure: boolean;
}

export type ScanConfidence = 'high' | 'low' | 'none';

/**
 * Parse the classifier's single line.
 *
 * Defensive by construction: the ONLY thing that can produce a non-null id is a
 * token `hasMonument()` confirms. "NONE", a monument's name, an apology, a
 * hallucinated id, a markdown bullet — all of them fall through to null.
 */
export function parseChoice(out: string): Choice {
  const text = stripFences(out).trim();
  if (!text) return { id: null, sure: false };

  const firstLine = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
  // Keep only the characters an id can contain, so quotes, backticks, bullets,
  // and stray punctuation cannot hide or split the token.
  const tokens = firstLine
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .trim()
    .split(/\s+/)
    // A token made of nothing but dashes is a markdown bullet, not an answer.
    // Dropping them is safe; scanning further into the line for ANY known id
    // would not be, because "not qutub-minar" would then read as a match.
    .filter((t) => t && !/^-+$/.test(t));
  if (tokens.length === 0) return { id: null, sure: false };

  const head = tokens[0].toLowerCase().replace(/^-+|-+$/g, '');
  if (!hasMonument(head)) return { id: null, sure: false };

  return { id: head, sure: tokens.slice(1).some((t) => /^sure$/i.test(t)) };
}

export function stripFences(text: string): string {
  const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The second matcher: look for a monument's own name inside the raw Vision
 * reading — because Vision named it, or because it transcribed the name off a
 * signboard. No model involved, so it cannot hallucinate.
 *
 * Strict in three ways that matter:
 *   - forward containment only (the haystack is a description, so "does the
 *     description contain this name" is the only meaningful direction);
 *   - names shorter than five folded characters are ignored, because short
 *     needles match by accident;
 *   - if TWO different monuments match, the answer is null. An ambiguous read
 *     ("the red fort at agra") must not resolve to whichever came first in
 *     registry order.
 *
 * Every name in every language the content files carry is checked, so a
 * Devanagari or Telugu signboard is as good a match as an English one.
 */
export function matchByName(raw: string): string | null {
  const hay = fold(raw.slice(0, 1200));
  if (!hay) return null;

  const hits = new Set<string>();
  for (const monument of allMonuments()) {
    const candidates = [monument.id.replace(/-/g, ' '), ...Object.values(monument.displayName)];
    for (const candidate of candidates) {
      const needle = fold(candidate);
      if (needle.length < 5) continue;
      if (hay.includes(needle)) {
        hits.add(monument.id);
        break;
      }
    }
  }

  if (hits.size !== 1) return null;
  const [only] = Array.from(hits);
  // Belt and braces: the id came out of our own registry, but this is the value
  // that becomes a navigation target, so it is validated like any other.
  return hasMonument(only) ? only : null;
}

/**
 * Combine the model's closed-list choice with the deterministic name match.
 *
 *   model  text    ->  result
 *   ----------------------------------------------------------------------
 *   null   null    ->  no match, 'none'
 *   id     same id ->  id, 'high'      two independent signals agree
 *   id     other   ->  text id, 'low'  disagreement is a red flag; the
 *                        deterministic read wins because it saw the name
 *                        written down, but never at high confidence
 *   id     null    ->  id, 'high' when the model said SURE, else 'low'
 *   null   id      ->  id, 'low'       a name in the text with no model
 *                        agreement is a candidate, not a conclusion
 *
 * 'high' is the only value the scanner will navigate on, and even then only
 * after showing the visitor the name with a visible way out.
 */
export function decide(
  choice: Choice,
  textId: string | null,
): { matchedMonumentId: string | null; confidence: ScanConfidence } {
  if (!choice.id && !textId) return { matchedMonumentId: null, confidence: 'none' };
  if (choice.id && textId) {
    if (choice.id === textId) return { matchedMonumentId: choice.id, confidence: 'high' };
    return { matchedMonumentId: textId, confidence: 'low' };
  }
  if (choice.id) return { matchedMonumentId: choice.id, confidence: choice.sure ? 'high' : 'low' };
  return { matchedMonumentId: textId, confidence: 'low' };
}

/**
 * Visual nouns we will report back to the viewfinder, as singulars.
 *
 * Every one of these describes a SHAPE or a MATERIAL, never a purpose. "dome"
 * and "sandstone" are things anyone can see; "mausoleum", "shrine" and "fort"
 * are claims about what a building is FOR, and this line runs under a frame we
 * have explicitly failed to identify. The same discipline lib/userMonument
 * applies to region names.
 */
const VISUAL_SINGULARS = [
  'dome', 'cupola', 'spire', 'finial', 'minaret', 'tower', 'turret', 'roof', 'crown', 'chhatri',
  'parapet', 'cornice', 'canopy', 'flag', 'arch', 'archway', 'window', 'balcony', 'carving',
  'inscription', 'facade', 'wall', 'column', 'pillar', 'door', 'doorway', 'gate', 'gateway',
  'lattice', 'jali', 'statue', 'figure', 'railing', 'step', 'stair', 'plinth', 'base', 'courtyard',
  'path', 'ground', 'water', 'pool', 'moat', 'garden', 'lawn', 'grass', 'road', 'fence', 'shadow',
  'sky', 'tree', 'marble', 'sandstone', 'granite', 'brick', 'stone',
];

/**
 * Accepted form -> canonical singular, so "arch" and "arches" count once.
 * Naive `slice(-1)` de-pluralisation turns "arches" into "arche", which then
 * fails to dedupe against "arch" and reads like a typo in the UI.
 */
const VOCABULARY: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const singular of VISUAL_SINGULARS) {
    map.set(singular, singular);
    const plural = /(?:ch|sh|s|x|z)$/.test(singular) ? `${singular}es` : `${singular}s`;
    if (!map.has(plural)) map.set(plural, singular);
  }
  return map;
})();

/**
 * Visual nouns actually present in the reading. No model call, no invention.
 * Reported in the order they appear and in the form they appear, because
 * "dome, arches, steps" reads like a description and "dome, arch, step" reads
 * like a database.
 */
export function nounsIn(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of fold(raw).split(' ')) {
    const canonical = VOCABULARY.get(word);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(word);
    if (out.length >= 6) break;
  }
  return out;
}

/** Vision's untrusted NAME: line. Shown as a guess, never treated as a match. */
export function visionGuess(raw: string): string | null {
  const line = raw.split(/[\r\n]+/).find((l) => /^\s*name\s*:/i.test(l));
  if (!line) return null;
  const value = line.replace(/^\s*name\s*:/i, '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!value) return null;
  if (/^(unknown|none|null|n\/?a|not sure|unclear|unidentified)$/i.test(value)) return null;
  if (value.length > 80) return null;
  return value;
}
