import { NextResponse, type NextRequest } from 'next/server';

import { toErrorPayload } from '@/lib/errors';
import { createSession, logEvent, setSessionLang } from '@/lib/db';
import { DEFAULT_LANG, detectedChip, info, normalizeLang, resolveVoice, voiceGapNotice } from '@/lib/langs';
import { displayName, getMonument } from '@/lib/monuments';
import { introLine } from '@/lib/prompts';
import { STT_MAX_SECONDS, isConfigured } from '@/lib/sarvam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Session bootstrap for the voice loop.
 *
 * DELIBERATE EXCEPTION to "every route 503s when isConfigured() is false": this
 * route never touches Sarvam. If it refused to serve without a key there would
 * be no session id to log the degraded text path against, and the client could
 * not learn *that* it must degrade. So it always answers 200 and reports
 * `sarvamConfigured` honestly in the payload — that flag is what switches the UI
 * into its text-input / large-text fallbacks. Every route that does call Sarvam
 * still 503s exactly as specified.
 */

interface CreateBody {
  monumentId?: string;
  /** Optional: a language already detected earlier in this browser session. */
  lang?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await readJson(req)) as CreateBody;
    const monument = getMonument(body.monumentId);
    const configured = isConfigured();

    // Language is NEVER chosen here. A code may only be carried in from a
    // previous Saaras detection; otherwise it stays null until the first
    // utterance decides it.
    const carried = body.lang ? normalizeLang(body.lang) : null;

    const session = await createSession({
      monument_id: monument.id,
      detected_lang: carried,
      user_agent: req.headers.get('user-agent'),
    });

    await logEvent('session_start', { monumentId: monument.id, configured, carried }, session.id);

    // The intro line is pre-generated in the monument JSON, so the monument can
    // greet a visitor even with no API key at all.
    const langForCopy = carried ?? DEFAULT_LANG;

    return NextResponse.json({
      sessionId: session.id,
      monumentId: monument.id,
      lang: carried,
      displayName: displayName(monument, langForCopy),
      intro: introLine(monument, langForCopy),
      regions: monument.regions.map((r) => r.id),
      eras: (monument.eras ?? []).map((e) => e.year),
      capabilities: {
        // One flag, three consequences: no STT, no answering, no TTS.
        stt: configured,
        answer: configured,
        tts: configured,
      },
      sarvamConfigured: configured,
      /** Client must hard-stop the recorder here: Saaras REST caps a call at 30s. */
      sttMaxSeconds: STT_MAX_SECONDS,
      startedAt: session.started_at,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/session] POST failed:', err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

interface PatchBody {
  sessionId?: string;
  lang?: string;
}

/**
 * Records the language Saaras detected. Called after the first utterance, and
 * again whenever the visitor switches language mid-session — we follow them.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await readJson(req)) as PatchBody;
    if (!body.sessionId) {
      return NextResponse.json({ error: 'sessionId is required', kind: 'bad_request' }, { status: 400 });
    }
    if (!body.lang) {
      return NextResponse.json({ error: 'lang is required', kind: 'bad_request' }, { status: 400 });
    }

    const lang = normalizeLang(body.lang);
    await setSessionLang(body.sessionId, lang);

    const voice = resolveVoice(lang);
    if (voice.degraded) {
      await logEvent('voice_gap', { lang, voiceLang: voice.voiceLang }, body.sessionId);
    }

    return NextResponse.json({
      ok: true,
      lang,
      chip: detectedChip(lang),
      script: info(lang).script,
      voice: {
        voiceLang: voice.voiceLang,
        speaker: voice.speaker,
        degraded: voice.degraded,
        notice: voice.degraded ? voiceGapNotice(lang) : null,
      },
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error('[api/session] PATCH failed:', err);
    return NextResponse.json(payload, { status: payload.status });
  }
}

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    // An empty POST body is legitimate here — it means "default monument".
    return {};
  }
}
