import { NextResponse, type NextRequest } from 'next/server';

import { SarvamBadResponse, SarvamNotConfigured, toErrorPayload } from '@/lib/errors';
import { isConfigured, listen } from '@/lib/sarvam';
import { isDubEnabled, prewarm, registerVoiceProfile, type VoiceProfile } from '@/lib/dub';
import { logEvent } from '@/lib/db';
import { detectedChip } from '@/lib/langs';
import { getRoom, languageCounts } from '../../_room';
import { bytesToB64 } from '@/lib/wav';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Record the guide's spoken consent before a single word is cloned.
 *
 * This is not decoration. Voice cloning in front of an enterprise and government
 * audience without a stored, timestamped, transcribed consent recording is the kind
 * of thing that ends a pilot. The recording is kept on the room; the guide screen
 * shows a permanent badge; and `dub()` refuses the clone path when `room.voice` is
 * null, so skipping this step cannot silently produce a cloned voice.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isConfigured()) throw new SarvamNotConfigured();

    const form = await req.formData();
    const code = String(form.get('code') ?? '').trim();
    const room = getRoom(code);
    if (!room) {
      return NextResponse.json({ error: `No live session for code ${code || '(none)'}`, kind: 'no_room', status: 404 }, { status: 404 });
    }
    if (room.endedAt) {
      return NextResponse.json({ error: 'That session has already ended.', kind: 'room_ended', status: 410 }, { status: 410 });
    }

    const file = form.get('audio');
    if (!(file instanceof Blob) || file.size === 0) {
      throw new SarvamBadResponse('consent requires a non-empty `audio` part');
    }
    const declaredMs = Number(form.get('ms') ?? 0);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const heard = await listen(file, 'transcribe');

    if (!heard.transcript) {
      return NextResponse.json(
        {
          error: 'We could not hear the consent phrase. Please record it again, a little closer to the microphone.',
          kind: 'empty_consent',
          status: 422,
        },
        { status: 422 },
      );
    }

    const consentedAt = new Date().toISOString();
    const referenceB64 = bytesToB64(bytes);

    // Best effort: a reusable speaker handle if Sarvam offers one, otherwise we pass
    // the reference audio inline on every Dub call. Both are guesses — see lib/dub.ts.
    let speakerId: string | null = null;
    if (isDubEnabled()) {
      try {
        speakerId = await registerVoiceProfile(referenceB64, heard.lang, { mime: file.type || 'audio/webm' });
      } catch (err) {
        console.warn('[guide] voice registration failed, falling back to inline reference:', (err as Error).message);
      }
    }

    const voice: VoiceProfile = {
      id: speakerId,
      referenceB64,
      referenceMime: file.type || 'audio/webm',
      lang: heard.lang,
      consentedAt,
    };

    room.voice = voice;
    room.guideLang = heard.lang;
    room.consent = {
      at: consentedAt,
      transcript: heard.transcript,
      lang: heard.lang,
      ms: Number.isFinite(declaredMs) && declaredMs > 0 ? Math.round(declaredMs) : 0,
      registered: Boolean(speakerId),
    };

    void logEvent(
      'guide_consent_recorded',
      {
        code: room.code,
        lang: heard.lang,
        chars: heard.transcript.length,
        speakerRegistered: Boolean(speakerId),
        bytes: bytes.length,
      },
      room.sessionId,
    );

    /*
     * Pre-warm now, while the guide is still reading the badge. The brief asks for a
     * throwaway phrase at session start so the first real sentence does not also pay
     * for connection setup. We warm the guide's own language plus whichever listener
     * languages have already joined; the results land in the dub cache.
     */
    const warmLangs = [room.guideLang, ...languageCounts(room).slice(0, 2).map((l) => l.lang)];
    const prewarmPromise = prewarm(warmLangs, { voice, sourceLang: room.guideLang }).catch((err) => {
      console.warn('[guide] prewarm failed (harmless):', (err as Error).message);
      return [];
    });
    // Give it a moment, but never hold the guide up for it.
    const prewarmReport = await Promise.race([
      prewarmPromise,
      new Promise<[]>((resolve) => setTimeout(() => resolve([]), 1200)),
    ]);

    return NextResponse.json({
      consented: true,
      at: consentedAt,
      transcript: heard.transcript,
      lang: heard.lang,
      chip: detectedChip(heard.lang),
      ms: room.consent.ms,
      sttMs: heard.latencyMs,
      voice: { registered: Boolean(speakerId), inlineReference: !speakerId, dubEnabled: isDubEnabled() },
      prewarm: prewarmReport,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}
