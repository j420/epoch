'use client';

/**
 * The client half of POST /api/scan/identify.
 *
 * NEVER THROWS. A scanner is a loop, and a loop that can throw is a loop that
 * strands the visitor on a frozen viewfinder. Every failure resolves to an
 * outcome carrying an honest reason, and the loop decides what to do with it —
 * which for a rate limit or a missing key is "stop, and say so", not "retry
 * harder against an account we are already being throttled on".
 */

export type ScanConfidence = 'high' | 'low' | 'none';

export interface ScanIdentifyPayload {
  matchedMonumentId: string | null;
  name: string | null;
  confidence: ScanConfidence;
  looksLike: string[];
  ms: number;
}

export interface ScanOutcome extends ScanIdentifyPayload {
  /** Plain-language reason this frame produced nothing. Null on success. */
  error: string | null;
  /** No Sarvam key on this deployment. The page must say so and stop. */
  notConfigured: boolean;
  /** Sarvam is throttling. The loop stops rather than making it worse. */
  rateLimited: boolean;
  /** Auth failure or a broken deployment — retrying cannot help. */
  fatal: boolean;
}

const EMPTY: ScanIdentifyPayload = {
  matchedMonumentId: null,
  name: null,
  confidence: 'none',
  looksLike: [],
  ms: 0,
};

/** A hung Vision call must not hold the viewfinder hostage. */
const TIMEOUT_MS = 25_000;

/**
 * Ids are used to build a URL, so they are validated here as well as on the
 * server. Cheap, and it means a compromised or confused response can never
 * navigate the visitor somewhere arbitrary.
 */
const ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 48 || !ID_SHAPE.test(id)) return null;
  return id;
}

export async function identifyFrame(
  frame: Blob,
  opts: { lang?: string | null; sessionId?: string | null; signal?: AbortSignal } = {},
): Promise<ScanOutcome> {
  const form = new FormData();
  form.append('frame', frame, 'frame.jpg');
  if (opts.lang) form.append('lang', opts.lang);
  if (opts.sessionId) form.append('sessionId', opts.sessionId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch('/api/scan/identify', { method: 'POST', body: form, signal: controller.signal });
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      return {
        ...EMPTY,
        error: aborted
          ? 'That frame took too long to read. Trying again.'
          : `Could not reach the recogniser (${(err as Error).message}).`,
        notConfigured: false,
        rateLimited: false,
        fatal: false,
      };
    }

    const body = (await res.json().catch(() => ({}))) as Partial<ScanIdentifyPayload> & {
      kind?: string;
      error?: string;
    };

    if (!res.ok) {
      const notConfigured = body.kind === 'not_configured';
      const rateLimited = body.kind === 'rate_limit' || res.status === 429;
      return {
        ...EMPTY,
        error: notConfigured
          ? 'Recognition is not available on this deployment — no speech key is configured.'
          : rateLimited
            ? 'Sarvam is rate limiting us right now, so scanning has stopped rather than making it worse.'
            : body.error ?? `The recogniser answered ${res.status}.`,
        notConfigured,
        rateLimited,
        fatal: notConfigured || body.kind === 'auth',
      };
    }

    const matchedMonumentId = safeId(body.matchedMonumentId);
    const confidence: ScanConfidence =
      body.confidence === 'high' ? 'high' : body.confidence === 'low' ? 'low' : 'none';

    return {
      // A confidence without an id is meaningless, and an id we could not
      // validate is not an id. Collapse both to "no match" here so no caller
      // has to remember the invariant.
      matchedMonumentId,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null,
      confidence: matchedMonumentId ? confidence : 'none',
      looksLike: Array.isArray(body.looksLike)
        ? body.looksLike.filter((s): s is string => typeof s === 'string').slice(0, 6)
        : [],
      ms: typeof body.ms === 'number' ? body.ms : 0,
      error: null,
      notConfigured: false,
      rateLimited: false,
      fatal: false,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
