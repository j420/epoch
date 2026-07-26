import { NextResponse } from 'next/server';

import { backend, listMemories } from '@/lib/db';
import { info } from '@/lib/langs';
import { DEFAULT_MONUMENT_ID } from '@/lib/monuments';

import { errorResponse, requireAdmin } from '../_lib/admin';
import { getVerdicts, type StoredVerdict } from '../_lib/verdicts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/memories/list?monument_id=&pending=1
 *
 * The moderation queue. Requires `x-bol-admin: $BOL_ADMIN_TOKEN`.
 *
 * A moderator sees the verbatim record beside the clean transcript — that side-by-side
 * is how you tell a real memory from a microphone test in two seconds — plus whatever
 * the automatic screen said about it.
 *
 * One thing a moderator does NOT see: the words of anyone who did not consent. The
 * row is listed so the count is honest, with `redacted: true` and nothing to read.
 * Consent was refused for storage and playback; it was not refused selectively for
 * everyone except staff.
 */

export interface AdminMemoryRow {
  id: string;
  monument_id: string;
  lang: string;
  langLabel: { native: string; english: string };
  city: string | null;
  created_at: string;
  consented: boolean;
  approved: boolean;
  redacted: boolean;
  transcript: string | null;
  verbatim: string | null;
  audio_url: string | null;
  moderation: StoredVerdict | null;
}

export async function GET(req: Request) {
  try {
    requireAdmin(req);

    const url = new URL(req.url);
    const monumentId = url.searchParams.get('monument_id')?.trim() || DEFAULT_MONUMENT_ID;
    const pendingOnly = url.searchParams.get('pending') === '1';

    const all = await listMemories({ monument_id: monumentId, approvedOnly: false, limit: 500 });
    const rows = pendingOnly ? all.filter((m) => !m.approved) : all;
    const verdicts = await getVerdicts(rows.map((m) => m.id));

    const memories: AdminMemoryRow[] = rows.map((m) => {
      const i = info(m.lang);
      return {
        id: m.id,
        monument_id: m.monument_id,
        lang: m.lang,
        langLabel: { native: i.native, english: i.english },
        city: m.city,
        created_at: m.created_at,
        consented: m.consented,
        approved: m.approved,
        redacted: !m.consented,
        transcript: m.consented ? m.transcript : null,
        verbatim: m.consented ? m.verbatim : null,
        audio_url: m.consented && m.approved ? m.audio_url : null,
        moderation: verdicts[m.id] ?? null,
      };
    });

    return NextResponse.json({
      monument_id: monumentId,
      backend: backend(),
      counts: {
        total: all.length,
        pending: all.filter((m) => !m.approved).length,
        approved: all.filter((m) => m.approved).length,
        unconsented: all.filter((m) => !m.consented).length,
      },
      memories,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
