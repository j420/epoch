import { NextResponse, type NextRequest } from 'next/server';

import { logEvent } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/photo/created
 *
 *   json: { hash, aspect, depthSource, webgpu, regionIds, matchedMonumentId,
 *           confidence, hasDescription, sessionId? }
 *   -> 200 { ok: true }
 *
 * Logs `photo_monument_created` so we can see how many visitors made one, how
 * often WebGPU was actually available on real phones, and how often Vision
 * matched something already in the grounded registry.
 *
 * NO IMAGE DATA. Not the bytes, not a data URL, not a thumbnail, not the Vision
 * description — that can contain a plaque with a stranger's name on it. Only the
 * content hash (which is one-way and useless without the original), the geometry,
 * and the capability flags. The photograph itself never leaves the visitor's
 * device except for the single /api/photo/identify call, and is not stored there
 * either.
 *
 * `lib/db` is server-only, which is exactly why this thin route exists: the
 * /create page is a client component and cannot call `logEvent` directly.
 *
 * Deliberately does NOT require a Sarvam key. Depth generation and the Living
 * Photograph work with no key at all, and that path deserves to be measured too.
 */

interface CreatedBody {
  hash?: unknown;
  aspect?: unknown;
  depthSource?: unknown;
  webgpu?: unknown;
  regionIds?: unknown;
  matchedMonumentId?: unknown;
  confidence?: unknown;
  hasDescription?: unknown;
  restored?: unknown;
  sessionId?: unknown;
}

const HASH = /^[a-z0-9-]{4,64}$/i;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as CreatedBody;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;

    await logEvent(
      'photo_monument_created',
      {
        // Content hash only. It identifies a repeat of the SAME photograph
        // within one browser; it cannot reconstruct the image.
        hash: typeof body.hash === 'string' && HASH.test(body.hash) ? body.hash : null,
        grounded: false,
        aspect: typeof body.aspect === 'number' && Number.isFinite(body.aspect) ? Math.round(body.aspect * 100) / 100 : null,
        depthSource: str(body.depthSource, ['precomputed', 'cache', 'computed', 'none']),
        webgpu: typeof body.webgpu === 'boolean' ? body.webgpu : null,
        regionIds: Array.isArray(body.regionIds)
          ? body.regionIds.filter((r): r is string => typeof r === 'string').slice(0, 8)
          : [],
        matchedMonumentId: typeof body.matchedMonumentId === 'string' ? body.matchedMonumentId : null,
        confidence: str(body.confidence, ['high', 'low']),
        hasDescription: Boolean(body.hasDescription),
        restored: Boolean(body.restored),
      },
      sessionId,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/photo/created] failed:', err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

function str(value: unknown, allowed: string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}
