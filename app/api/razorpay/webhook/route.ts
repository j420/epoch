import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NextResponse, type NextRequest } from 'next/server';

import { backend, logEvent, supabase } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';
import { normalizeLang } from '@/lib/langs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Razorpay webhook.
 *
 * Three things matter here and each of them is easy to get wrong:
 *
 * 1. THE RAW BODY. The signature is an HMAC over the exact bytes Razorpay sent.
 *    `await req.text()` first, verify, and only then JSON.parse. Parsing first and
 *    re-stringifying reorders keys and changes whitespace, and every signature
 *    fails for a reason nobody can see.
 * 2. CONSTANT-TIME COMPARISON. `timingSafeEqual`, after a length check, never `===`.
 * 3. IDEMPOTENCY. Razorpay retries on any non-2xx and sometimes on 2xx. A payment
 *    id that is already in the events table is acknowledged and dropped, so the
 *    dashboard's rupee counter cannot be inflated by a retry.
 *
 * On success we write one `donation_paid` event. `liveStats()` sums `payload.amount`
 * into its `rupees` field, so `amount` is stored in RUPEES; the raw paise figure
 * Razorpay sent is kept alongside as `amount_paise`.
 */

const SUCCESS_EVENTS = new Set(['payment.captured', 'payment_link.paid', 'order.paid']);

/** Same-instance guard, ahead of the store lookup. Not durable, and not relied on. */
const seenPaymentIds = new Set<string>();

export async function POST(req: NextRequest) {
  try {
    // 1. Raw body first. Nothing may touch it before the signature is checked.
    const raw = await req.text();

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return NextResponse.json(
        {
          error: 'RAZORPAY_WEBHOOK_SECRET is not set, so no webhook can be verified. Nothing was recorded.',
          kind: 'not_configured',
          status: 503,
        },
        { status: 503 },
      );
    }

    const provided = req.headers.get('x-razorpay-signature') ?? '';
    const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
    if (!signatureMatches(provided, expected)) {
      console.warn('[razorpay] webhook signature mismatch — rejected');
      return NextResponse.json({ error: 'Invalid webhook signature.', kind: 'bad_signature', status: 400 }, { status: 400 });
    }

    // 2. Only now is the body trustworthy.
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Webhook body was not JSON.', kind: 'bad_request', status: 400 }, { status: 400 });
    }

    const event: string = typeof body?.event === 'string' ? body.event : '';
    if (!SUCCESS_EVENTS.has(event)) {
      // Acknowledge everything else, or Razorpay will retry it forever.
      return NextResponse.json({ ok: true, ignored: event || 'unknown' });
    }

    const payment = body?.payload?.payment?.entity ?? null;
    const link = body?.payload?.payment_link?.entity ?? null;
    const order = body?.payload?.order?.entity ?? null;
    const entity = payment ?? order ?? link;

    const paymentId: string | null =
      (typeof payment?.id === 'string' && payment.id) ||
      (typeof order?.id === 'string' && order.id) ||
      (typeof link?.id === 'string' && link.id) ||
      null;

    if (!paymentId) {
      return NextResponse.json({ ok: true, ignored: event, reason: 'no payment id in payload' });
    }

    const amountPaise = Number(entity?.amount ?? 0);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return NextResponse.json({ ok: true, ignored: event, reason: 'no positive amount in payload' });
    }

    const notes = { ...(link?.notes ?? {}), ...(payment?.notes ?? {}) } as Record<string, unknown>;
    const monumentId = typeof notes.monument_id === 'string' && notes.monument_id ? notes.monument_id : null;
    const lang = typeof notes.lang === 'string' && notes.lang ? normalizeLang(notes.lang) : null;
    const sessionId = typeof notes.session_id === 'string' && notes.session_id ? notes.session_id : null;

    // 3. Idempotency.
    if (await alreadyRecorded(paymentId)) {
      return NextResponse.json({ ok: true, duplicate: true, payment_id: paymentId });
    }

    const rupees = amountPaise / 100;
    await logEvent(
      'donation_paid',
      {
        // liveStats() sums this field into its `rupees` counter.
        amount: rupees,
        amount_paise: amountPaise,
        currency: typeof entity?.currency === 'string' ? entity.currency : 'INR',
        payment_id: paymentId,
        lang,
        monument_id: monumentId,
        event,
        link_id: typeof link?.id === 'string' ? link.id : null,
        method: typeof payment?.method === 'string' ? payment.method : null,
      },
      sessionId,
    );
    seenPaymentIds.add(paymentId);

    return NextResponse.json({
      ok: true,
      recorded: true,
      payment_id: paymentId,
      amount: rupees,
      currency: 'INR',
      lang,
      monument_id: monumentId,
      session_id: sessionId,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

function signatureMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on unequal lengths; the length itself is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Has this payment already been banked? Checks the in-process set, then the
 * store itself, because a retry can land on a different lambda instance.
 * A read failure returns false: a duplicated donation is a worse lie than a
 * missed one, but a lost donation is worse still, and the store lookup only
 * fails when the store is unreadable — in which case logEvent will fail too.
 */
async function alreadyRecorded(paymentId: string): Promise<boolean> {
  if (seenPaymentIds.has(paymentId)) return true;

  try {
    if (backend() === 'supabase') {
      const { data, error } = await supabase()
        .from('events')
        .select('id')
        .eq('kind', 'donation_paid')
        .eq('payload->>payment_id', paymentId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    }

    // The file store is lib/db's private business; we only ever read it.
    const dir = process.env.BOL_DATA_DIR ?? path.join(process.cwd(), '.data');
    const raw = await fs.readFile(path.join(dir, 'store.json'), 'utf8');
    const store = JSON.parse(raw) as { events?: { kind: string; payload?: Record<string, unknown> }[] };
    return (store.events ?? []).some((e) => e.kind === 'donation_paid' && e.payload?.payment_id === paymentId);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('[razorpay] idempotency lookup failed, treating as new:', (err as Error).message);
    }
    return false;
  }
}
