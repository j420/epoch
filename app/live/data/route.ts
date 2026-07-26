import { NextResponse, type NextRequest } from 'next/server';

import { liveStats } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dashboard's only data source. Every field here is a count of real rows,
 * computed by `liveStats()` from the sessions / turns / memories / reports /
 * events tables. Nothing is seeded, estimated, extrapolated or remembered
 * between requests. If the store cannot be read this returns `ok:false` and the
 * page shows dashes — never a zero, and never a number we made up.
 *
 * GET /live/data?monument_id=qutub-minar
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  try {
    const monumentId = req.nextUrl.searchParams.get('monument_id')?.trim() || undefined;
    const stats = await liveStats(monumentId);

    return NextResponse.json(
      { ok: true, ...stats, monumentId: monumentId ?? null, ms: Date.now() - started },
      { headers: { 'cache-control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(
      { ok: false, ...payload, ms: Date.now() - started },
      { status: payload.status, headers: { 'cache-control': 'no-store, max-age=0' } },
    );
  }
}
