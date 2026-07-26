import { NextResponse, type NextRequest } from 'next/server';

import { SarvamBadResponse, SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { isConfigured, listen } from '@/lib/sarvam';
import { detectedChip, info, resolveVoice } from '@/lib/langs';
import { logEvent } from '@/lib/db';
import { addListener, getRoom, roster } from '../_room';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A listener speaks one sentence and is in.
 *
 * The language comes from Saaras auto-detection on that utterance and from nothing
 * else. There is no picker on the join screen, there is no `lang` parameter accepted
 * here, and there is no default a listener can be nudged into. Rule 2 of the build
 * contract, held at the API boundary so no client can route around it.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const form = await req.formData();
    const code = String(form.get('code') ?? '').trim();
    const room = getRoom(code);
    if (!room) {
      return NextResponse.json(
        { error: `No live session for code ${code || '(none)'}. Check the four digits on the guide's screen.`, kind: 'no_room', status: 404 },
        { status: 404 },
      );
    }
    if (room.endedAt) {
      return NextResponse.json({ error: 'That tour has ended.', kind: 'room_ended', status: 410 }, { status: 410 });
    }

    const file = form.get('audio');
    if (!(file instanceof Blob) || file.size === 0) {
      throw new SarvamBadResponse('join requires a non-empty `audio` part');
    }

    // 'codemix' is the right mode here: listeners routinely answer in a mix of their
    // language and English, and we still want the dominant language back.
    const heard = await listen(file, 'codemix');

    if (!heard.rawLang && !heard.transcript) {
      return NextResponse.json(
        {
          error: 'We could not hear you. Try once more — one full sentence, in whichever language you are most comfortable.',
          kind: 'no_speech',
          status: 422,
        },
        { status: 422 },
      );
    }

    const previousId = String(form.get('listenerId') ?? '').trim() || null;
    const listener = addListener(room, heard.lang, previousId);
    const snapshot = roster(room);
    const voice = resolveVoice(listener.lang);

    void logEvent(
      'guide_listener_joined',
      { code: room.code, lang: listener.lang, rawLang: heard.rawLang, listeners: snapshot.listeners },
      room.sessionId,
    );

    return NextResponse.json({
      lang: listener.lang,
      listenerId: listener.id,
      listeners: snapshot.listeners,
      /*
       * Where this listener's stream should start. Someone joining twenty minutes into
       * a tour wants what the guide says next, not forty replayed sentences and forty
       * queued audio clips. The client seeds its resume cursor from this, so a later
       * reconnect still replays exactly what it missed and nothing more.
       */
      seq: room.seq,
      chip: detectedChip(listener.lang),
      languages: snapshot.languages,
      transcript: heard.transcript,
      rawLang: heard.rawLang,
      sttMs: heard.latencyMs,
      /*
       * Honest up front: Saaras understands 23 languages, Bulbul voices 11. If this
       * listener's language is in the gap, the join screen says so before the tour
       * starts rather than letting them wonder why the audio sounds wrong.
       */
      voice: {
        speakable: info(listener.lang).speakable,
        voiceLang: voice.voiceLang,
        degraded: voice.degraded,
        voiceLangName: info(voice.voiceLang).english,
      },
      guideLang: room.guideLang,
      consented: Boolean(room.consent),
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}
