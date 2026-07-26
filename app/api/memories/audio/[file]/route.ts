import { NextResponse } from 'next/server';

import { listMemories } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';
import { allMonuments } from '@/lib/monuments';

import { isSafeAudioName, readAudioFile } from '../../_lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/memories/audio/[file]
 *
 * Serves the original voice from the local .data/audio store — the fallback used
 * whenever Supabase Storage is not configured. Two gates, both required:
 *
 *   1. The filename must be exactly a UUID plus a known audio extension. Nothing
 *      user-supplied ever reaches the path, so traversal is not possible.
 *   2. The file must belong to a memory that is BOTH approved and consented. An
 *      unguessable URL is not a permission; the check is done against the database
 *      on every request, so revoking approval revokes playback immediately.
 */

export async function GET(_req: Request, ctx: { params: { file: string } }) {
  try {
    const file = ctx.params.file;
    if (!isSafeAudioName(file)) return notFound();

    if (!(await belongsToPublishableMemory(file))) return notFound();

    const found = await readAudioFile(file);
    if (!found) return notFound();

    const body = new Uint8Array(found.bytes.byteLength);
    body.set(found.bytes);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': found.mime,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'private, max-age=60',
        'Content-Disposition': `inline; filename="${file}"`,
      },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

async function belongsToPublishableMemory(file: string): Promise<boolean> {
  const suffix = `/api/memories/audio/${file}`;
  for (const monument of allMonuments()) {
    const rows = await listMemories({ monument_id: monument.id, approvedOnly: true, limit: 500 });
    if (rows.some((m) => m.approved && m.consented && m.audio_url?.endsWith(suffix))) return true;
  }
  return false;
}

function notFound() {
  return NextResponse.json({ error: 'No such recording.', kind: 'not_found', status: 404 }, { status: 404 });
}
