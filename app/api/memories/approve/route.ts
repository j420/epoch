import { NextResponse } from 'next/server';

import { approveMemory, listMemories, logEvent } from '@/lib/db';
import { allMonuments } from '@/lib/monuments';
import type { Memory } from '@/lib/types';

import { errorResponse, requireAdmin } from '../_lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/memories/approve   { id, approved, monument_id? }
 *
 * Requires `x-bol-admin: $BOL_ADMIN_TOKEN`. One click, one row.
 *
 * Approving a memory whose speaker did not consent is refused outright — 409, no
 * override, no force flag. Consent is not something a moderator can supply on
 * someone else's behalf. Rejecting one (approved: false) is always allowed.
 */

export async function POST(req: Request) {
  try {
    requireAdmin(req);

    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      approved?: boolean;
      monument_id?: string;
    };

    const id = body.id?.trim();
    if (!id) {
      return NextResponse.json({ error: 'id is required.', kind: 'bad_request', status: 400 }, { status: 400 });
    }
    if (typeof body.approved !== 'boolean') {
      return NextResponse.json(
        { error: 'approved must be true or false.', kind: 'bad_request', status: 400 },
        { status: 400 },
      );
    }

    const found = await findMemory(id, body.monument_id);
    if (!found) {
      return NextResponse.json({ error: `No memory with id ${id}.`, kind: 'not_found', status: 404 }, { status: 404 });
    }
    if (body.approved && !found.consented) {
      return NextResponse.json(
        {
          error: 'This visitor did not consent to their voice being shared. It cannot be approved.',
          kind: 'consent_missing',
          status: 409,
        },
        { status: 409 },
      );
    }

    await approveMemory(id, body.approved);
    await logEvent('memory_reviewed', {
      memory_id: id,
      monument_id: found.monument_id,
      lang: found.lang,
      approved: body.approved,
      by: 'human',
    });

    return NextResponse.json({ ok: true, id, approved: body.approved });
  } catch (err) {
    return errorResponse(err);
  }
}

/** listMemories is scoped by monument, so without a hint we sweep the registry. */
async function findMemory(id: string, monumentId?: string): Promise<Memory | null> {
  const ids = monumentId?.trim() ? [monumentId.trim()] : allMonuments().map((m) => m.id);
  for (const mid of ids) {
    const rows = await listMemories({ monument_id: mid, approvedOnly: false, limit: 500 });
    const hit = rows.find((m) => m.id === id);
    if (hit) return hit;
  }
  return null;
}
