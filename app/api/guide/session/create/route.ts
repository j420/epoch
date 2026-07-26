import { NextResponse, type NextRequest } from 'next/server';

import { toErrorPayload } from '@/lib/errors';
import { isConfigured } from '@/lib/sarvam';
import { isDubEnabled } from '@/lib/dub';
import { createSession, logEvent } from '@/lib/db';
import { createRoom, summarise } from '../../_room';
import { qrSvg } from '../../_qr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open a guide session and hand back the join code, the two URLs and a QR.
 *
 * Deliberately does NOT 503 when Sarvam is unconfigured. This route calls no Sarvam
 * endpoint — it allocates local state — and a hard failure here would leave the guide
 * screen with nothing to explain itself with. Instead it returns `sarvamConfigured:
 * false` and the guide page renders a plain banner saying translation is offline.
 * The routes that genuinely need the key (consent, chunk, join) return 503 properly.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const guideLang = typeof body?.guideLang === 'string' ? body.guideLang : 'hi-IN';

    // Log a session row so guide turns join up with the rest of the product's analytics.
    let sessionId: string | null = null;
    try {
      const session = await createSession({
        monument_id: 'guide-amplifier',
        detected_lang: guideLang,
        user_agent: req.headers.get('user-agent'),
      });
      sessionId = session.id;
    } catch (err) {
      // A database hiccup must not stop a tour from starting.
      console.warn('[guide] createSession failed, running without a session row:', (err as Error).message);
    }

    const room = createRoom({ guideLang, sessionId });
    const origin = resolveOrigin(req);
    const joinUrl = `${origin}/join?code=${room.code}`;
    const guideUrl = `${origin}/guide?code=${room.code}`;

    void logEvent('guide_session_created', { code: room.code, guideLang, dubEnabled: isDubEnabled() }, sessionId);

    return NextResponse.json({
      code: room.code,
      guideUrl,
      joinUrl,
      // Error correction M: the QR is shown on a screen, not weathered on a wall,
      // and M keeps the module count low enough to scan from the back of a room.
      qrSvg: qrSvg(joinUrl, { ecl: 'M', title: `Join code ${room.code}` }),
      sarvamConfigured: isConfigured(),
      dubEnabled: isDubEnabled(),
      notice: isConfigured()
        ? null
        : 'SARVAM_API_KEY is not set. The room, the join code and the QR all work; transcription, translation and voice stay offline until a key is present.',
      room: summarise(room),
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

/**
 * Prefer the origin the request actually arrived on, so a phone scanning the QR gets
 * the LAN address the laptop is being served from rather than a baked-in localhost.
 * Getting this wrong is a QR that resolves to nothing on the listener's phone.
 *
 * Order: the proxy's own headers (Vercel always sets these), then the protocol the
 * request really used, then NEXT_PUBLIC_BASE_URL for deployments behind a rewrite.
 */
function resolveOrigin(req: NextRequest): string {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0].trim();
  if (host) {
    const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
    const proto = forwarded || req.nextUrl.protocol.replace(':', '') || 'http';
    return `${proto}://${host}`;
  }
  return (process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}
