import { NextResponse, type NextRequest } from 'next/server';

import { toErrorPayload } from '@/lib/errors';
import { info, normalizeLang, voiceGapNotice } from '@/lib/langs';
import { getMonument } from '@/lib/monuments';
import { MODELS, isConfigured, speak, translate } from '@/lib/sarvam';

import { askLine } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The emotional beat that precedes the payment QR: the monument, in the first
 * person and in the visitor's language, says how long it has stood and asks to
 * stand longer. The claim is derived from a dated source chunk and rounded down,
 * never generated — a monument that lies about its own age has broken the product.
 *
 * GET /api/razorpay/ask?lang=ta-IN&monument_id=qutub-minar
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  try {
    const q = req.nextUrl.searchParams;
    const lang = normalizeLang(q.get('lang'));
    const monument = getMonument(q.get('monument_id') ?? undefined);
    const ask = askLine(monument.id);

    if (!isConfigured()) {
      return NextResponse.json(
        {
          error: 'SARVAM_API_KEY is not set. The line below is the English source text, untranslated and unvoiced.',
          kind: 'not_configured',
          status: 503,
          text: ask.text,
          textLang: 'en-IN',
          audio: null,
          years: ask.years,
          claimedYears: ask.claimedYears,
          citation: ask.citation,
          ms: Date.now() - started,
        },
        { status: 503 },
      );
    }

    // Mayura, not sarvam-translate: this is a plea, not a notice.
    const text =
      normalizeLang(lang) === 'en-IN' ? ask.text : await translate(ask.text, lang, { from: 'en-IN', colloquial: true });

    let audio: string | null = null;
    let voiceNotice: string | null = null;
    try {
      const spoken = await speak(text, lang);
      audio = spoken.url;
      if (spoken.degraded) voiceNotice = voiceGapNotice(lang);
    } catch (err) {
      voiceNotice = `Bulbul could not voice the ask: ${(err as Error).message}`;
    }

    return NextResponse.json({
      text,
      textLang: lang,
      langNative: info(lang).native,
      audio,
      voiceNotice,
      years: ask.years,
      claimedYears: ask.claimedYears,
      citation: ask.citation,
      translateModel: normalizeLang(lang) === 'en-IN' ? 'none:already-english' : MODELS.translateColloquial,
      ms: Date.now() - started,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json({ ...payload, ms: Date.now() - started }, { status: payload.status });
  }
}
