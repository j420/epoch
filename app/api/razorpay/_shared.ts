import 'server-only';

import type { NextRequest } from 'next/server';

import { getMonument } from '@/lib/monuments';

/**
 * Razorpay plumbing and the one line that asks for money. Not a route file.
 */

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  mode: 'live' | 'test';
}

export function razorpayKeys(): RazorpayKeys | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, mode: keyId.startsWith('rzp_live_') ? 'live' : 'test' };
}

export function basicAuth({ keyId, keySecret }: RazorpayKeys): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

export function publicBase(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

// ---------------------------------------------------------------------------
// The ask
// ---------------------------------------------------------------------------

/**
 * The brief's line is "I have stood four hundred years. Help me stand four
 * hundred more." Qutub Minar was begun in 1199 CE, so four hundred is false and
 * the monument would be breaking the product's first rule in its own fundraising
 * pitch. The age is therefore derived from the dated source chunk and rounded
 * DOWN to a hundred, so "more than eight hundred years" stays true every year.
 *
 * A monument with no dated source gets a line that makes no factual claim at all.
 */
const FOUNDED: Record<string, { year: number; citation: string }> = {
  'qutub-minar': {
    year: 1199,
    citation: 'Archaeological Survey of India, Qutb Minar site record — construction begun 1199 CE',
  },
};

const HUNDREDS = [
  'zero', 'one hundred', 'two hundred', 'three hundred', 'four hundred', 'five hundred',
  'six hundred', 'seven hundred', 'eight hundred', 'nine hundred', 'a thousand',
  'eleven hundred', 'twelve hundred', 'thirteen hundred', 'fourteen hundred', 'fifteen hundred',
];

export interface AskLine {
  /** English seed, first person, true for this monument. Translate before speaking. */
  text: string;
  /** Whole years since construction began, or null when we hold no dated source. */
  years: number | null;
  /** The rounded-down figure the sentence actually claims. */
  claimedYears: number | null;
  citation: string | null;
}

export function askLine(monumentId: string | undefined, now: Date = new Date()): AskLine {
  const monument = getMonument(monumentId ?? undefined);
  const founded = FOUNDED[monument.id];

  if (!founded) {
    return {
      text: 'I would like to be here for the people who come after you. Help me stay standing.',
      years: null,
      claimedYears: null,
      citation: null,
    };
  }

  const years = now.getUTCFullYear() - founded.year;
  const rounded = Math.floor(years / 100) * 100;
  const words = HUNDREDS[Math.floor(rounded / 100)] ?? `${rounded}`;

  return {
    text: `I have stood for more than ${words} years. Help me stand for ${words} more.`,
    years,
    claimedYears: rounded,
    citation: founded.citation,
  };
}

/** The 503 body used whenever the Razorpay keys are absent. Never fake a link. */
export function notConfigured() {
  return {
    error:
      'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. No payment link can be created, ' +
      'and this route will not invent one.',
    kind: 'not_configured' as const,
    status: 503 as const,
  };
}
