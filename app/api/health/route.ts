import { NextResponse } from 'next/server';
import { backend } from '@/lib/db';
import { MODELS, caches, isConfigured } from '@/lib/sarvam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cheap liveness + configuration report. Never calls Sarvam, so it costs nothing. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'bol',
    sarvamConfigured: isConfigured(),
    usingBackupKey: process.env.SARVAM_USE_BACKUP === '1',
    db: backend(),
    models: MODELS,
    caches: caches.stats(),
    time: new Date().toISOString(),
  });
}
