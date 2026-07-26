import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { logEvent } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';
import { normalizeLang } from '@/lib/langs';
import { displayName, getMonument } from '@/lib/monuments';
import { qrSvg } from '@/lib/qr';

import { askLine, basicAuth, notConfigured, publicBase, razorpayKeys } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creates a real Razorpay Payment Link over their REST API with Basic auth.
 * No SDK — a single fetch, so there is nothing to install and nothing to break.
 *
 * ON THE QR: Razorpay's own QR product only resolves in Live Mode. What we render
 * here is the QR of the Payment Link's short_url, which is an ordinary https URL:
 * any camera opens it, and the payment completes on Razorpay's page. That works
 * in test mode and in live mode, which is what a conference-room demo needs.
 */

interface LinkBody {
  /** Paise. Default 100 = Rs 1 — a real payment small enough to make on stage. */
  amount?: number;
  monument_id?: string;
  lang?: string;
  session_id?: string | null;
}

const MIN_PAISE = 100; // Razorpay's floor
const MAX_PAISE = 1_000_000; // Rs 10,000 — a demo does not need more

export async function POST(req: NextRequest) {
  const started = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as LinkBody;
    const monument = getMonument(body.monument_id ?? undefined);
    const lang = normalizeLang(body.lang);
    const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : null;
    const ask = askLine(monument.id);

    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) ? Math.round(requested) : MIN_PAISE;
    if (amount < MIN_PAISE || amount > MAX_PAISE) {
      return NextResponse.json(
        {
          error: `amount must be between ${MIN_PAISE} and ${MAX_PAISE} paise (it is in paise, not rupees).`,
          kind: 'bad_request',
          status: 400,
        },
        { status: 400 },
      );
    }

    const keys = razorpayKeys();
    if (!keys) {
      const payload = notConfigured();
      return NextResponse.json(
        { ...payload, amount, ask: ask.text, askCitation: ask.citation, ms: Date.now() - started },
        { status: 503 },
      );
    }

    const base = publicBase(req);
    const reference = `bol-${monument.id}-${randomUUID()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch('https://api.razorpay.com/v1/payment_links', {
        method: 'POST',
        headers: {
          Authorization: basicAuth(keys),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount,
          currency: 'INR',
          accept_partial: false,
          description: `Conservation of ${displayName(monument, 'en-IN')} — Bol`,
          reference_id: reference,
          // The webhook reads these back, so the donation is attributed to the
          // right session, monument and language without any client trust.
          notes: {
            source: 'bol',
            monument_id: monument.id,
            lang,
            session_id: sessionId ?? '',
          },
          notify: { sms: false, email: false },
          reminder_enable: false,
          callback_url: `${base}/?m=${encodeURIComponent(monument.id)}&donated=1&lang=${encodeURIComponent(lang)}`,
          callback_method: 'get',
        }),
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* fall through to the error below */
    }

    if (!res.ok || !parsed?.short_url) {
      const description = parsed?.error?.description ?? raw.slice(0, 300) ?? 'no body';
      console.warn(`[razorpay] payment_links failed ${res.status}: ${description}`);
      return NextResponse.json(
        {
          error: `Razorpay refused to create the payment link (${res.status}): ${description}`,
          kind: 'razorpay',
          status: 502,
          mode: keys.mode,
          ms: Date.now() - started,
        },
        { status: 502 },
      );
    }

    const shortUrl: string = parsed.short_url;
    await logEvent(
      'donation_link_created',
      { monument_id: monument.id, lang, amount, mode: keys.mode, link_id: parsed.id, reference },
      sessionId,
    );

    return NextResponse.json({
      id: parsed.id as string,
      shortUrl,
      qrSvg: qrSvg(shortUrl, { ec: 'M', border: 4, label: 'Razorpay payment link' }),
      amount,
      mode: keys.mode,
      // Context the donation screen shows next to the QR.
      currency: 'INR',
      rupees: amount / 100,
      ask: ask.text,
      askYears: ask.years,
      askCitation: ask.citation,
      referenceId: reference,
      scanNote:
        keys.mode === 'live'
          ? 'Live mode: scanning opens the Razorpay payment page and a real payment is taken.'
          : 'Test mode: scanning opens a Razorpay TEST payment page. No money moves. Use live keys for a real Rs 1 payment.',
      ms: Date.now() - started,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json({ ...payload, ms: Date.now() - started }, { status: payload.status });
  }
}
