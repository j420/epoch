import { NextResponse } from 'next/server';
import { MODELS, chat, isConfigured, sarvamFetch, speak, translate } from '@/lib/sarvam';
import { toErrorPayload } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Verify the live API surface the moment a real key exists.
 *
 * docs.sarvam.ai is unreachable from the build environment and Sarvam has
 * renamed response fields between versions, so lib/sarvam.ts reads several
 * variants of every field. This route calls each endpoint for real and prints
 * the ACTUAL top-level keys that came back, so we can confirm which variant is
 * live instead of guessing. Run it once after setting SARVAM_API_KEY.
 *
 *   curl -s localhost:3000/api/sarvam/selftest | jq
 */
interface Probe {
  endpoint: string;
  ok: boolean;
  ms: number;
  keys?: string[];
  sample?: unknown;
  error?: string;
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<Probe> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const keys = out && typeof out === 'object' ? Object.keys(out as object) : undefined;
    return { endpoint: name, ok: true, ms: Date.now() - t0, keys, sample: summarise(out) };
  } catch (err) {
    return { endpoint: name, ok: false, ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** Never dump base64 audio into a debug response. */
function summarise(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) return v.slice(0, 3).map(summarise);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = typeof val === 'string' && val.length > 120 ? `<${val.length} chars>` : summarise(val);
    }
    return out;
  }
  return v;
}

export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'SARVAM_API_KEY is not set — nothing to verify yet.', kind: 'not_configured' },
      { status: 503 },
    );
  }

  try {
    const probes = await Promise.all([
      probe('POST /v1/chat/completions (raw)', () =>
        sarvamFetch('/v1/chat/completions', {
          json: {
            model: MODELS.chatFast,
            messages: [{ role: 'user', content: 'Reply with exactly the word: ok' }],
            max_tokens: 16,
            reasoning_effort: null,
          },
          attempts: 2,
        }),
      ),
      probe('chat() helper', () => chat([{ role: 'user', content: 'Say ok.' }], { maxTokens: 16 })),
      probe('POST /text-to-speech (raw)', () =>
        sarvamFetch('/text-to-speech', {
          json: {
            text: 'नमस्ते',
            target_language_code: 'hi-IN',
            model: MODELS.tts,
            speaker: 'anushka',
          },
          attempts: 2,
        }),
      ),
      probe('speak() helper', () => speak('नमस्ते, मैं क़ुतुब मीनार हूँ।', 'hi-IN')),
      probe('translate() helper', () => translate('How old are you?', 'ta-IN', { from: 'en-IN' })),
      probe('translate() colloquial (mayura)', () => translate('How old are you?', 'hi-IN', { from: 'en-IN', colloquial: true })),
    ]);

    return NextResponse.json({
      ok: probes.every((p) => p.ok),
      note:
        'Compare the `keys` arrays against the readers in lib/sarvam.ts (readAudioB64, readChatContent, ' +
        'readTranslation, readTranscript). If a key here is not on the accept-list, add it there. ' +
        'Speech-to-text is not probed because it needs a real audio file — use /debug/voice.',
      models: MODELS,
      probes,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    return NextResponse.json(payload, { status: payload.status });
  }
}
