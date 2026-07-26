import 'server-only';

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { toErrorPayload } from '@/lib/errors';

/**
 * Admin auth for the echo wall moderation queue.
 *
 * One shared token (BOL_ADMIN_TOKEN) sent as `x-bol-admin`. Deliberately boring:
 * the queue is a demo-day tool for one human with one thumb, not a user system.
 * Compared in constant time so the token cannot be discovered a byte at a time.
 */

export class AdminNotConfigured extends Error {
  constructor() {
    super('BOL_ADMIN_TOKEN is not set — the moderation queue is closed until it is.');
    this.name = 'AdminNotConfigured';
  }
}

export class AdminUnauthorized extends Error {
  constructor() {
    super('Wrong or missing x-bol-admin token.');
    this.name = 'AdminUnauthorized';
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which itself leaks length.
  // Hash-free fix: compare fixed-width buffers of the max length.
  const len = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/** Throws AdminNotConfigured / AdminUnauthorized. Call it first in every admin route. */
export function requireAdmin(req: Request): void {
  const expected = process.env.BOL_ADMIN_TOKEN?.trim();
  if (!expected) throw new AdminNotConfigured();
  const got = req.headers.get('x-bol-admin')?.trim() ?? '';
  if (!got || !constantTimeEqual(got, expected)) throw new AdminUnauthorized();
}

/**
 * Every route in this lane ends here. Our two local error kinds get their own
 * shape; everything else falls through to the frozen toErrorPayload().
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AdminNotConfigured) {
    return NextResponse.json({ error: err.message, kind: 'admin_not_configured', status: 503 }, { status: 503 });
  }
  if (err instanceof AdminUnauthorized) {
    return NextResponse.json({ error: err.message, kind: 'unauthorized', status: 401 }, { status: 401 });
  }
  const payload = toErrorPayload(err);
  return NextResponse.json(payload, { status: payload.status });
}
