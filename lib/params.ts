/**
 * Request parameter readers that accept both spellings.
 *
 * Six lanes built these routes in parallel and settled on different conventions:
 * `monument_id` vs `monumentId`, `session_id` vs `sessionId`. Most routes ended up
 * tolerating both, but not all — and the failure mode is silent, which is the
 * dangerous part. A route reading only `monumentId` that receives `monument_id`
 * does not error: it falls through to the default monument and answers confidently
 * about the wrong building. The same mismatch on `session_id` meant no turn was
 * logged for an entire smoke run, so the latency budget had nothing to measure.
 *
 * Rather than pick a winner and break every caller, both spellings are accepted
 * everywhere. snake_case is the documented canonical form (it matches the database
 * columns and the JSON bodies in docs/BUILD-CONTRACT.md); camelCase is accepted
 * because half the client code already sends it.
 */

/**
 * `object` rather than `Record<string, unknown>` so callers can pass their own
 * typed body interfaces without a cast — an interface is not assignable to an
 * index-signature type in TypeScript, and forcing every caller to cast would
 * defeat the point of a shared helper.
 */
type Source = object | URLSearchParams | FormData | null | undefined;

function read(src: Source, keys: string[]): string | null {
  if (!src) return null;
  for (const key of keys) {
    let v: unknown;
    if (src instanceof URLSearchParams || src instanceof FormData) v = src.get(key);
    else v = (src as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Accepts `monument_id` or `monumentId`. Returns null so callers can apply their own default. */
export function monumentId(src: Source): string | null {
  return read(src, ['monument_id', 'monumentId']);
}

/** Accepts `session_id` or `sessionId`. */
export function sessionId(src: Source): string | null {
  return read(src, ['session_id', 'sessionId']);
}

/** Accepts `lang`, `language`, or `language_code` — Sarvam uses the last of these. */
export function lang(src: Source): string | null {
  return read(src, ['lang', 'language', 'language_code', 'languageCode']);
}

/** Generic escape hatch for any other pair, e.g. param(src, 'photo_url', 'photoUrl'). */
export function param(src: Source, ...keys: string[]): string | null {
  return read(src, keys);
}
