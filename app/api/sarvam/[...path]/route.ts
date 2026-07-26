import { NextRequest, NextResponse } from 'next/server';
import { SARVAM_BASE, apiKey, isConfigured } from '@/lib/sarvam';
import { toErrorPayload } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Thin pass-through proxy so the api-subscription-key never reaches the browser.
 *
 * This exists as an escape hatch and for the /debug tooling. Feature code should
 * call the typed helpers in lib/sarvam.ts through a purpose-built route
 * (/api/listen, /api/speak, ...) rather than firing arbitrary paths from the client.
 *
 * Only paths on the allowlist are forwarded — an open proxy in front of a metered
 * API is a way to have someone else spend your quota.
 */
const ALLOWED = [
  /^speech-to-text$/,
  /^speech-to-text-translate$/,
  /^text-to-speech$/,
  /^translate$/,
  /^transliterate$/,
  /^v1\/chat\/completions$/,
  /^parse\/parsepdf$/,
  /^v1\/document\/parse$/,
  /^document-parse$/,
  /^speech-to-text-job.*$/,
  /^text-to-speech-job.*$/,
];

function allowed(path: string): boolean {
  return ALLOWED.some((re) => re.test(path));
}

async function forward(req: NextRequest, path: string) {
  if (!allowed(path)) {
    return NextResponse.json({ error: `Path /${path} is not proxyable`, kind: 'forbidden_path' }, { status: 403 });
  }
  if (!isConfigured()) {
    return NextResponse.json({ error: 'SARVAM_API_KEY is not set', kind: 'not_configured' }, { status: 503 });
  }

  try {
    const url = new URL(`${SARVAM_BASE}/${path}`);
    req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

    const headers: Record<string, string> = { 'api-subscription-key': apiKey() };
    const contentType = req.headers.get('content-type');
    // FormData must keep its generated multipart boundary — only copy JSON content types.
    if (contentType && contentType.includes('application/json')) headers['Content-Type'] = contentType;

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      cache: 'no-store',
    });

    const bytes = await upstream.arrayBuffer();
    return new NextResponse(bytes, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path.join('/'));
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path.join('/'));
}
