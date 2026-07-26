import 'server-only';

import { MODELS, chat, isConfigured } from '@/lib/sarvam';

/**
 * Auto-screening for every spoken contribution.
 *
 * Two layers, deliberately:
 *
 *  1. A deterministic local screen for the things a model should never be the only
 *     guard against — phone numbers, email addresses, ID numbers, empty recordings.
 *     It runs with no network and no API key, so the privacy floor never depends on
 *     Sarvam being reachable.
 *  2. sarvam-105b for judgement — abuse, doxxing-by-description, irrelevance.
 *
 * Nothing here ever throws. A contribution whose screening failed comes back as
 * `unreviewed`, which — like every other verdict — leaves `approved = false`.
 * A human still has to press the button in /admin. Moderation failing open is
 * impossible by construction: approval is a separate, human, positive act.
 */

export type Verdict = 'ok' | 'abuse' | 'personal_data' | 'irrelevant' | 'unreviewed';

export interface Moderation {
  verdict: Verdict;
  reason: string;
  /** Which model produced the verdict, or null when it came from the local screen. */
  model: string | null;
  /** True when we could not reach the model and fell back to the local screen only. */
  degraded: boolean;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const PHONE_IN = /(?:\+?\s?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/;
const AADHAAR = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

/**
 * Runs with no key and no network. Returns null when it has no opinion.
 */
export function localScreen(text: string): Moderation | null {
  const clean = text.trim();
  if (clean.length < 3) {
    return {
      verdict: 'irrelevant',
      reason: 'No speech was detected in the recording.',
      model: null,
      degraded: false,
    };
  }
  if (EMAIL.test(clean)) {
    return { verdict: 'personal_data', reason: 'Contains an email address.', model: null, degraded: false };
  }
  if (AADHAAR.test(clean)) {
    return { verdict: 'personal_data', reason: 'Contains a twelve-digit ID-like number.', model: null, degraded: false };
  }
  if (PHONE_IN.test(clean)) {
    return { verdict: 'personal_data', reason: 'Contains what looks like a phone number.', model: null, degraded: false };
  }
  if (URL_RE.test(clean)) {
    return { verdict: 'irrelevant', reason: 'Contains a web link — likely advertising.', model: null, degraded: false };
  }
  return null;
}

const SYSTEM = [
  'You are the content filter for a public heritage kiosk in India.',
  'You receive one short spoken memory a visitor left at a monument. It may be in any Indian language.',
  'Reply with ONE line of JSON and nothing else:',
  '{"verdict":"ok"|"abuse"|"personal_data"|"irrelevant","reason":"<at most 15 words, in English>"}',
  '',
  'abuse         — insults, hate, sexual content, threats, communal or political attack, profanity aimed at people.',
  'personal_data — phone numbers, email, postal address, ID numbers, or a living person named with identifying detail.',
  'irrelevant    — nothing to do with this place or this visit: advertising, microphone tests, gibberish.',
  'ok            — everything else.',
  '',
  'Be generous. Rambling, long pauses, fillers, mixing English into the sentence, grief,',
  'affection, and complaints about litter or upkeep are all "ok". A real memory is "ok".',
].join('\n');

function parseVerdict(raw: string): { verdict: Verdict; reason: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { verdict?: unknown; reason?: unknown };
    const v = String(obj.verdict ?? '').toLowerCase().trim();
    if (v !== 'ok' && v !== 'abuse' && v !== 'personal_data' && v !== 'irrelevant') return null;
    const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim().slice(0, 160) : 'No reason given.';
    return { verdict: v, reason };
  } catch {
    return null;
  }
}

export async function moderate(
  transcript: string,
  opts: { monumentName?: string; signal?: AbortSignal } = {},
): Promise<Moderation> {
  const local = localScreen(transcript);
  if (local) return local;

  if (!isConfigured()) {
    return {
      verdict: 'unreviewed',
      reason: 'Automatic screening is offline (no Sarvam key). A human must review this.',
      model: null,
      degraded: true,
    };
  }

  try {
    const raw = await chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `MONUMENT: ${opts.monumentName ?? 'an Indian monument'}\nMEMORY: ${transcript.trim().slice(0, 1800)}`,
        },
      ],
      { model: MODELS.chatDeep, temperature: 0, maxTokens: 160, think: false, signal: opts.signal },
    );

    const parsed = parseVerdict(raw);
    if (!parsed) {
      return {
        verdict: 'unreviewed',
        reason: `Screening model replied in an unexpected shape: ${raw.slice(0, 80)}`,
        model: MODELS.chatDeep,
        degraded: true,
      };
    }
    return { ...parsed, model: MODELS.chatDeep, degraded: false };
  } catch (err) {
    return {
      verdict: 'unreviewed',
      reason: `Screening failed: ${(err as Error).message.slice(0, 120)}`,
      model: MODELS.chatDeep,
      degraded: true,
    };
  }
}
