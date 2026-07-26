import { NextResponse, type NextRequest } from 'next/server';

import { logEvent } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';
import { info, normalizeLang, voiceGapNotice } from '@/lib/langs';
import { displayName, getMonument } from '@/lib/monuments';
import { MODELS, chat, isConfigured, speak } from '@/lib/sarvam';

import { cleanSpoken, limitSentences } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The monument thanks a donor by voice, in their language.
 *
 * Called by the client once the Razorpay webhook has recorded the payment (or
 * once the payment page reports success). It states no fact about where the
 * money goes — we do not know, and the monument does not lie.
 *
 * GET /api/postcard/thanks?lang=ta-IN&amount=1
 *   amount        rupees (default 1)
 *   amount_paise  paise, wins over `amount` if present — Razorpay's unit
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  try {
    const q = req.nextUrl.searchParams;
    const lang = normalizeLang(q.get('lang'));
    const langInfo = info(lang);
    const monument = getMonument(q.get('monument_id') ?? undefined);
    const sessionId = q.get('session_id');

    const paise = Number(q.get('amount_paise'));
    const rupeesRaw = Number.isFinite(paise) && paise > 0 ? paise / 100 : Number(q.get('amount'));
    const rupees = Number.isFinite(rupeesRaw) && rupeesRaw > 0 ? Math.round(rupeesRaw * 100) / 100 : 1;

    if (!isConfigured()) {
      return NextResponse.json(
        {
          error: 'SARVAM_API_KEY is not set, so the monument cannot speak its thanks.',
          kind: 'not_configured',
          status: 503,
          text: null,
          audio: null,
          lang,
          amount: rupees,
          ms: Date.now() - started,
        },
        { status: 503 },
      );
    }

    const system = [
      `You are ${displayName(monument, 'en-IN')}, a monument in ${monument.city}, India.`,
      'You speak in the first person, always.',
      `A visitor has just given ${rupees} rupees towards your conservation.`,
      'Thank them. Two sentences maximum. Warm, plain, unsentimental, no begging.',
      'Do NOT say what the money will be spent on, do not promise anything, do not state any date, number or historical fact.',
      `Write ONLY in ${langInfo.english} (${langInfo.native}), in the ${langInfo.script} script.`,
      'Return only the spoken words. No quotation marks, no stage directions, no JSON.',
    ].join('\n');

    const raw = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: `They have just donated ${rupees} rupees. Thank them.` },
      ],
      { model: MODELS.chatDeep, maxTokens: 200, temperature: 0.6, think: false },
    );

    const text = limitSentences(cleanSpoken(raw), 2);
    if (!text) {
      return NextResponse.json(
        { error: 'The monument returned an empty thank-you.', kind: 'bad_response', status: 502 },
        { status: 502 },
      );
    }

    let audio: string | null = null;
    let voiceNotice: string | null = null;
    let degraded = false;
    try {
      const spoken = await speak(text, lang);
      audio = spoken.url;
      degraded = spoken.degraded;
      if (spoken.degraded) voiceNotice = voiceGapNotice(lang);
    } catch (err) {
      voiceNotice = `Bulbul could not voice the thanks: ${(err as Error).message}`;
    }

    await logEvent('donation_thanked', { monument_id: monument.id, lang, amount: rupees, voiced: audio !== null }, sessionId);

    return NextResponse.json({
      text,
      audio,
      lang,
      langNative: langInfo.native,
      amount: rupees,
      voiceDegraded: degraded,
      voiceNotice,
      ms: Date.now() - started,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json({ ...payload, ms: Date.now() - started }, { status: payload.status });
  }
}
