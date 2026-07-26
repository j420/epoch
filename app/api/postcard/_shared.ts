import 'server-only';

import type { NextRequest } from 'next/server';

/**
 * Small helpers shared by the postcard routes. Not a route file — Next only
 * treats `route.ts` / `page.tsx` as routable, so this stays private to the lane.
 */

/** The public origin, for QR targets and share links. Env first, request second. */
export function publicBase(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

/**
 * A visitor's spoken name arrives from Saaras, so it can contain anything.
 * Collapse whitespace, drop control characters and the punctuation that would
 * let it break out of the prompt, and cap the length.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["'`<>{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

/**
 * The answering models occasionally append the visual directive JSON. Strip a
 * trailing object, surrounding quotes and any stage directions in brackets.
 */
export function cleanSpoken(raw: string): string {
  let text = raw.trim();
  text = text.replace(/\{[^{}]*"(?:focus|grade|era)"[^{}]*\}\s*$/i, '').trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  text = text.replace(/^\s*(?:assistant|monument)\s*:\s*/i, '').trim();
  return text.replace(/\s+/g, ' ');
}

/** Keep at most `max` sentences. Handles the danda and the double danda. */
export function limitSentences(text: string, max: number): string {
  const parts = text.match(/[^।॥.!?]+[।॥.!?]*/g);
  if (!parts) return text;
  const kept = parts.map((s) => s.trim()).filter(Boolean).slice(0, max);
  return kept.join(' ').trim();
}
