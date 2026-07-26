'use client';

import type { IdentifyResult } from '@/lib/userMonument';

/**
 * The client half of POST /api/photo/identify.
 *
 * NEVER THROWS, and never fails the flow. Identification is the one part of this
 * feature that needs a server and a Sarvam key, and it is also the least
 * important part: without it the photograph still gets its depth map, its camera
 * rig, its regions and — as long as speech is configured — its voice. It just
 * describes itself in more general terms and its regions carry neutral names.
 *
 * So every failure resolves to an empty result plus an honest `notice` the UI
 * shows, rather than to an exception that would strand the visitor on a spinner.
 */

export interface IdentifyOutcome extends IdentifyResult {
  /** Plain-language explanation when identification did not happen. */
  notice: string | null;
  /** True when the server reported no Sarvam key. The UI says so, and says why. */
  notConfigured: boolean;
}

const EMPTY: IdentifyResult = {
  name: null,
  description: '',
  looksLike: [],
  matchedMonumentId: null,
  confidence: 'low',
};

export async function identifyPhoto(file: Blob, lang?: string | null, sessionId?: string | null): Promise<IdentifyOutcome> {
  const form = new FormData();
  form.append('image', file, 'photo.jpg');
  if (lang) form.append('lang', lang);
  if (sessionId) form.append('sessionId', sessionId);

  let res: Response;
  try {
    res = await fetch('/api/photo/identify', { method: 'POST', body: form });
  } catch (err) {
    return {
      ...EMPTY,
      notice: `Your photograph could not be described (${(err as Error).message}). It will still come alive — it just has less to say about how it looks.`,
      notConfigured: false,
    };
  }

  const payload = (await res.json().catch(() => ({}))) as Partial<IdentifyResult> & { kind?: string; error?: string };

  if (!res.ok) {
    const notConfigured = payload.kind === 'not_configured';
    return {
      ...EMPTY,
      notice: notConfigured
        ? 'No speech key is configured on this deployment, so your photograph cannot be described or talked to yet. The depth and the camera still work — they run entirely in your browser.'
        : payload.error ?? `Your photograph could not be described (${res.status}).`,
      notConfigured,
    };
  }

  return {
    name: typeof payload.name === 'string' ? payload.name : null,
    // Already sanitised server-side; sanitised AGAIN in /api/photo/answer before
    // it reaches any prompt. This client copy is display and cache only.
    description: typeof payload.description === 'string' ? payload.description : '',
    looksLike: Array.isArray(payload.looksLike) ? payload.looksLike.filter((s): s is string => typeof s === 'string') : [],
    matchedMonumentId: typeof payload.matchedMonumentId === 'string' ? payload.matchedMonumentId : null,
    confidence: payload.confidence === 'high' ? 'high' : 'low',
    notice: null,
    notConfigured: false,
  };
}
