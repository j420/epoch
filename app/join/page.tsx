import { isConfigured } from '@/lib/sarvam';
import JoinClient from './JoinClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Bol — join a tour',
  description: 'Speak one sentence. Hear the whole tour in your own language.',
};

/**
 * Server shell. Reads the code out of the QR's query string and reports whether
 * Sarvam is configured, so the page can be honest before the listener taps anything.
 */
export default function JoinPage({ searchParams }: { searchParams?: { code?: string | string[] } }) {
  const raw = searchParams?.code;
  const fromQr = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const initialCode = /^\d{4}$/.test(fromQr.trim()) ? fromQr.trim() : '';

  return <JoinClient initialCode={initialCode} sarvamConfigured={isConfigured()} />;
}
