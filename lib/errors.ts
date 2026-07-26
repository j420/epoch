/**
 * Typed Sarvam errors so every caller can degrade gracefully instead of dying.
 * Prompt 9 requires a visible, honest fallback for each of these.
 */

export class SarvamError extends Error {
  readonly status?: number;
  readonly endpoint?: string;
  readonly body?: unknown;

  constructor(message: string, opts: { status?: number; endpoint?: string; body?: unknown } = {}) {
    super(message);
    this.name = 'SarvamError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
  }
}

/** HTTP 429. Rate limits are per-account across all keys — a teammate testing can throttle you. */
export class SarvamRateLimit extends SarvamError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 900, opts: { endpoint?: string; body?: unknown } = {}) {
    super(message, { ...opts, status: 429 });
    this.name = 'SarvamRateLimit';
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP 401/403 — missing or invalid api-subscription-key. Never retried. */
export class SarvamAuth extends SarvamError {
  constructor(message: string, opts: { status?: number; endpoint?: string; body?: unknown } = {}) {
    super(message, opts);
    this.name = 'SarvamAuth';
  }
}

/** The call succeeded but the payload was not the shape we can use. */
export class SarvamBadResponse extends SarvamError {
  constructor(message: string, opts: { status?: number; endpoint?: string; body?: unknown } = {}) {
    super(message, opts);
    this.name = 'SarvamBadResponse';
  }
}

/** No SARVAM_API_KEY configured. Distinct from auth failure so the UI can say so plainly. */
export class SarvamNotConfigured extends SarvamError {
  constructor(message = 'SARVAM_API_KEY is not set') {
    super(message);
    this.name = 'SarvamNotConfigured';
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof SarvamAuth || err instanceof SarvamNotConfigured) return false;
  if (err instanceof SarvamRateLimit) return true;
  if (err instanceof SarvamError) return err.status === undefined || err.status >= 500 || err.status === 408;
  return true; // network / abort / DNS
}

/** Maps any thrown value onto a stable, user-safe shape for API route responses. */
export function toErrorPayload(err: unknown): { error: string; kind: string; status: number } {
  if (err instanceof SarvamNotConfigured) return { error: err.message, kind: 'not_configured', status: 503 };
  if (err instanceof SarvamRateLimit) return { error: 'Sarvam is rate limiting us right now.', kind: 'rate_limit', status: 429 };
  if (err instanceof SarvamAuth) return { error: 'Sarvam rejected our credentials.', kind: 'auth', status: 502 };
  if (err instanceof SarvamBadResponse) return { error: err.message, kind: 'bad_response', status: 502 };
  if (err instanceof SarvamError) return { error: err.message, kind: 'sarvam', status: err.status ?? 502 };
  return { error: err instanceof Error ? err.message : 'Unknown error', kind: 'unknown', status: 500 };
}
