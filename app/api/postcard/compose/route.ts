import { NextResponse, type NextRequest } from 'next/server';

import { logEvent } from '@/lib/db';
import { toErrorPayload } from '@/lib/errors';
import { info, normalizeLang, voiceGapNotice } from '@/lib/langs';
import { displayName, getMonument } from '@/lib/monuments';
import { qrSvg } from '@/lib/qr';
import { MODELS, chat, isConfigured, speak, translate } from '@/lib/sarvam';

import { cleanName, cleanSpoken, limitSentences, publicBase } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The growth loop. After a handful of turns the monument offers to come with the
 * visitor: it composes a short personal farewell addressed to them by name, in
 * their language, voices it with Bulbul, and hands back everything the client
 * needs to burn a 15-second card — audio, caption and a QR back to this monument.
 *
 * The caption deliberately goes through MAYURA (`translate(..., {colloquial:true})`)
 * and not sarvam-translate. Formal translation reads like a government notice;
 * a caption has to read like a person wrote it, or nobody forwards it.
 */

interface ComposeBody {
  monument_id?: string;
  name?: string;
  lang?: string;
  session_id?: string | null;
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as ComposeBody;

    const monument = getMonument(body.monument_id ?? undefined);
    const lang = normalizeLang(body.lang);
    const langInfo = info(lang);
    const name = cleanName(body.name);
    const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : null;

    const base = publicBase(req);
    const shareUrl = `${base}/?m=${encodeURIComponent(monument.id)}&via=postcard`;
    const qr = qrSvg(shareUrl, { ec: 'M', border: 4, label: `Open ${displayName(monument, 'en-IN')} in Bol` });
    const monumentName = displayName(monument, lang);

    if (!name) {
      return NextResponse.json(
        { error: 'A name is required — the postcard is addressed to the visitor.', kind: 'bad_request', status: 400 },
        { status: 400 },
      );
    }

    // Honest degradation: the card is still real (photo + QR + link), the voice is not.
    if (!isConfigured()) {
      return NextResponse.json(
        {
          error: 'SARVAM_API_KEY is not set, so the monument cannot compose or speak a farewell.',
          kind: 'not_configured',
          status: 503,
          text: null,
          audio: null,
          caption: null,
          captionModel: null,
          shareUrl,
          qrSvg: qr,
          ms: Date.now() - started,
        },
        { status: 503 },
      );
    }

    // ---- the farewell -----------------------------------------------------
    // Grounded: the model may lean on the monument's own source chunks and
    // nothing else. A postcard is not the place to invent history.
    const memory = monument.sources
      .slice(0, 4)
      .map((s) => `- ${s.text}`)
      .join('\n');

    const system = [
      `You are ${displayName(monument, 'en-IN')}, a monument in ${monument.city}, India.`,
      'You speak in the first person, always. You are old, warm and unsentimental.',
      `A visitor named ${name} has been talking with you and is about to leave.`,
      'Say goodbye to them. Use their name. Two sentences; three at the very most.',
      'It must be sayable aloud in about fifteen seconds, so keep it short.',
      `Write ONLY in ${langInfo.english} (${langInfo.native}), in the ${langInfo.script} script. No transliteration, no English gloss.`,
      'MY MEMORY (the only facts you may use — state no fact that is not here):',
      memory,
      'Do not invent dates, numbers or events. You may say goodbye without stating any fact at all.',
      'Return only the spoken words. No quotation marks, no stage directions, no JSON.',
    ].join('\n');

    const raw = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: `${name} is leaving now. Say your farewell to ${name}.` },
      ],
      { model: MODELS.chatDeep, maxTokens: 260, temperature: 0.7, think: false },
    );

    const text = limitSentences(cleanSpoken(raw), 3);
    if (!text) {
      return NextResponse.json(
        { error: 'The monument returned an empty farewell.', kind: 'bad_response', status: 502, shareUrl, qrSvg: qr },
        { status: 502 },
      );
    }

    // ---- voice and caption, in parallel ------------------------------------
    const captionSeed =
      `${name} came to see me today, and I answered in ${langInfo.english}. ` +
      `Come and talk to me too — I am ${displayName(monument, 'en-IN')}, and I speak your language.`;

    const [voice, caption] = await Promise.all([
      speak(text, lang).then(
        (r) => ({ ok: true as const, r }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      captionFor(captionSeed, lang),
    ]);

    const audio = voice.ok ? voice.r.url : null;
    const voiceNotice = voice.ok
      ? voice.r.degraded
        ? voiceGapNotice(lang)
        : null
      : `Bulbul could not voice this farewell: ${(voice.err as Error)?.message ?? 'unknown error'}`;

    await logEvent(
      'postcard_composed',
      {
        monument_id: monument.id,
        lang,
        voiced: audio !== null,
        caption_model: caption.model,
        chars: text.length,
      },
      sessionId,
    );

    return NextResponse.json({
      text,
      audio,
      caption: caption.text,
      captionModel: caption.model,
      shareUrl,
      qrSvg: qr,
      ms: Date.now() - started,
      // Extras the card and the share sheet use; ignore them if you do not need them.
      lang,
      langNative: langInfo.native,
      monumentId: monument.id,
      monumentName,
      hero: monument.hero,
      voiceLang: voice.ok ? voice.r.voiceLang : null,
      voiceDegraded: voice.ok ? voice.r.degraded : null,
      voiceNotice,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json({ ...payload, ms: Date.now() - started }, { status: payload.status });
  }
}

/**
 * Mayura writes the caption. If the visitor's language is English there is
 * nothing to translate, and we say so rather than claiming a model ran.
 * If Mayura fails we fall back to the English seed and label it honestly —
 * a caption in the wrong language is better than a card that never renders.
 */
async function captionFor(seed: string, lang: string): Promise<{ text: string; model: string }> {
  if (normalizeLang(lang) === 'en-IN') return { text: seed, model: 'none:already-english' };
  try {
    const out = await translate(seed, lang, { from: 'en-IN', colloquial: true });
    return { text: out, model: MODELS.translateColloquial };
  } catch (err) {
    console.warn('[postcard] Mayura caption failed, falling back to English:', (err as Error).message);
    return { text: seed, model: 'fallback:en-IN' };
  }
}
