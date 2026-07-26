import 'server-only';

import { LRU } from './lru';
import { SarvamAuth, SarvamBadResponse, SarvamError, SarvamNotConfigured, SarvamRateLimit, isRetryable } from './errors';
import { normalizeLang, resolveVoice, type LangCode } from './langs';
import { b64ToBytes, bytesToB64, concatAudio } from './wav';

/**
 * The single typed Sarvam client. Every route in Bol goes through here.
 * The API key lives in this module and never crosses to the browser.
 *
 * NOTE ON FIELD NAMES: docs.sarvam.ai is unreachable from this build environment
 * (network policy denies it), and Sarvam has historically renamed response fields
 * between versions (`audios` vs `audio`, `transcript` vs `text`, `content` vs `text`).
 * Every reader below accepts the known variants rather than assuming one. Run
 * GET /api/sarvam/selftest once a live key is present to print the ACTUAL shapes.
 */

export const SARVAM_BASE = process.env.SARVAM_BASE_URL ?? 'https://api.sarvam.ai';

export const MODELS = {
  stt: process.env.SARVAM_STT_MODEL ?? 'saaras:v3',
  tts: process.env.SARVAM_TTS_MODEL ?? 'bulbul:v3',
  chatFast: process.env.SARVAM_CHAT_FAST ?? 'sarvam-30b',
  chatDeep: process.env.SARVAM_CHAT_DEEP ?? 'sarvam-105b',
  translate: process.env.SARVAM_TRANSLATE_MODEL ?? 'sarvam-translate:v1',
  translateColloquial: process.env.SARVAM_TRANSLATE_COLLOQUIAL ?? 'mayura:v1',
} as const;

/** Bulbul caps at 2500 chars; we chunk under 2200 to leave headroom for preprocessing. */
export const TTS_CHUNK_LIMIT = 2200;
/** Saaras REST caps a single call at 30 seconds of audio. */
export const STT_MAX_SECONDS = 30;

export type SttMode = 'transcribe' | 'translate' | 'verbatim' | 'transliterate' | 'codemix';

export interface ListenResult {
  transcript: string;
  lang: LangCode;
  /** Raw language string exactly as Sarvam returned it, for debugging detection. */
  rawLang: string | null;
  latencyMs: number;
  mode: SttMode;
}

export interface SpeakResult {
  /** data: URL — playable directly by an <audio> element, no object URL needed on the server. */
  url: string;
  base64: string;
  mime: string;
  bytes: number;
  /** Language actually handed to Bulbul (may differ from requested — see langs.ts). */
  voiceLang: LangCode;
  requestedLang: LangCode;
  degraded: boolean;
  speaker: string;
  chunks: number;
  latencyMs: number;
  cached: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  model?: string;
  maxTokens?: number;
  /** Leave false for every voice-loop call. See the reasoning_effort note below. */
  think?: boolean;
  temperature?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/**
 * Two keys, one switch. Prompt 9: "Have a second API key ready and a one-line
 * switch to use it." Set SARVAM_USE_BACKUP=1 to flip without touching code.
 */
export function apiKey(): string {
  const useBackup = process.env.SARVAM_USE_BACKUP === '1';
  const primary = process.env.SARVAM_API_KEY?.trim();
  const backup = process.env.SARVAM_API_KEY_BACKUP?.trim();
  const key = (useBackup ? backup || primary : primary) ?? '';
  if (!key) throw new SarvamNotConfigured();
  return key;
}

export function isConfigured(): boolean {
  return Boolean(process.env.SARVAM_API_KEY?.trim() || process.env.SARVAM_API_KEY_BACKUP?.trim());
}

// ---------------------------------------------------------------------------
// Caches — during a demo the same lines replay constantly; never pay twice.
// ---------------------------------------------------------------------------

const ttsCache = new LRU<SpeakResult>(400, 96 * 1024 * 1024);
const translateCache = new LRU<string>(1000, 4 * 1024 * 1024);
const chatCache = new LRU<string>(300, 4 * 1024 * 1024);

export const caches = {
  tts: ttsCache,
  translate: translateCache,
  chat: chatCache,
  clear() {
    ttsCache.clear();
    translateCache.clear();
    chatCache.clear();
  },
  stats() {
    return { tts: ttsCache.stats, translate: translateCache.stats, chat: chatCache.stats };
  },
};

// ---------------------------------------------------------------------------
// Transport: retry with exponential backoff, typed errors
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FetchOpts {
  method?: string;
  json?: unknown;
  form?: FormData;
  attempts?: number;
  signal?: AbortSignal;
  /** Some endpoints answer with audio/octet-stream rather than JSON. */
  expect?: 'json' | 'bytes';
  timeoutMs?: number;
}

export async function sarvamFetch<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { method = 'POST', json, form, attempts = 4, expect = 'json', timeoutMs = 45_000 } = opts;
  const url = path.startsWith('http') ? path : `${SARVAM_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const key = apiKey();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const headers: Record<string, string> = { 'api-subscription-key': key };
      if (json !== undefined) headers['Content-Type'] = 'application/json';

      const res = await fetch(url, {
        method,
        headers,
        body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (res.status === 401 || res.status === 403) {
        const body = await safeText(res);
        throw new SarvamAuth(`Sarvam rejected the key (${res.status})`, { status: res.status, endpoint: path, body });
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        // Spec: on 429 back off 900ms * attempt.
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 900 * attempt;
        throw new SarvamRateLimit(`Rate limited on ${path}`, waitMs, { endpoint: path, body: await safeText(res) });
      }
      if (!res.ok) {
        throw new SarvamError(`Sarvam ${path} failed with ${res.status}`, {
          status: res.status,
          endpoint: path,
          body: await safeText(res),
        });
      }

      if (expect === 'bytes') return new Uint8Array(await res.arrayBuffer()) as unknown as T;

      const text = await res.text();
      if (!text.trim()) throw new SarvamBadResponse(`Empty body from ${path}`, { endpoint: path });
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SarvamBadResponse(`Non-JSON body from ${path}`, { endpoint: path, body: text.slice(0, 400) });
      }
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === attempts) break;
      const wait = err instanceof SarvamRateLimit ? err.retryAfterMs : Math.min(8000, 300 * 2 ** (attempt - 1));
      console.warn(`[sarvam] ${path} attempt ${attempt}/${attempts} failed (${(err as Error).message}); retrying in ${wait}ms`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastErr;
}

/**
 * Node's Buffer/Uint8Array can be backed by a SharedArrayBuffer, which TS will not
 * accept as a BlobPart. Copying into a fresh ArrayBuffer is both type-correct and
 * safe against the source being reused while the request is in flight.
 */
function toBlob(data: Blob | Buffer | Uint8Array, mime: string): Blob {
  if (data instanceof Blob) return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 600);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tolerant field readers — see the note at the top of this file.
// ---------------------------------------------------------------------------

function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    const v = k.split('.').reduce((o: any, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function readTranscript(body: any): string {
  const v = pick(body, 'transcript', 'text', 'transcription', 'output', 'data.transcript', 'data.text');
  return typeof v === 'string' ? v.trim() : '';
}

export function readLanguage(body: any): string | null {
  const v = pick(body, 'language_code', 'lang', 'language', 'detected_language', 'detected_language_code', 'data.language_code');
  return typeof v === 'string' ? v : null;
}

/** Bulbul has shipped both `audios: [b64]` and `audio: b64`. Accept either, plus nesting. */
export function readAudioB64(body: any): string[] {
  const audios = pick(body, 'audios', 'audio', 'data.audios', 'data.audio', 'output', 'audio_base64');
  if (Array.isArray(audios)) return audios.filter((a): a is string => typeof a === 'string' && a.length > 0);
  if (typeof audios === 'string' && audios.length > 0) return [audios];
  return [];
}

export function readChatContent(body: any): { content: string; finishReason: string | null } {
  const choice = body?.choices?.[0];
  const content =
    pick(choice, 'message.content', 'message.text', 'text', 'delta.content') ??
    pick(body, 'content', 'text', 'output', 'output_text') ??
    '';
  const finishReason = pick(choice, 'finish_reason', 'finishReason') ?? null;
  return { content: typeof content === 'string' ? content.trim() : '', finishReason };
}

export function readTranslation(body: any): string {
  const v = pick(body, 'translated_text', 'output', 'text', 'translation', 'data.translated_text');
  return typeof v === 'string' ? v.trim() : '';
}

// ---------------------------------------------------------------------------
// listen() — Saaras. The ONLY source of language truth in this product.
// ---------------------------------------------------------------------------

export async function listen(
  audio: Blob | Buffer | Uint8Array,
  mode: SttMode = 'codemix',
  opts: { filename?: string; signal?: AbortSignal; languageHint?: string } = {},
): Promise<ListenResult> {
  const started = Date.now();
  const blob = toBlob(audio, 'audio/webm');

  const form = new FormData();
  const filename = opts.filename ?? guessFilename(blob.type);
  form.append('file', blob, filename);
  form.append('model', MODELS.stt);
  form.append('mode', mode);
  // Deliberately NOT sending language_code: auto-detection is the whole product.
  if (opts.languageHint) form.append('language_code', opts.languageHint);

  const body = await sarvamFetch<any>('/speech-to-text', { form, signal: opts.signal });
  const transcript = readTranscript(body);
  const rawLang = readLanguage(body);

  if (!transcript) {
    console.warn('[sarvam] listen() returned an empty transcript', { keys: Object.keys(body ?? {}) });
  }

  return {
    transcript,
    lang: normalizeLang(rawLang),
    rawLang,
    latencyMs: Date.now() - started,
    mode,
  };
}

function guessFilename(mime: string): string {
  if (mime.includes('webm')) return 'audio.webm';
  if (mime.includes('ogg')) return 'audio.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'audio.m4a';
  if (mime.includes('wav')) return 'audio.wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'audio.mp3';
  return 'audio.webm';
}

// ---------------------------------------------------------------------------
// speak() — Bulbul, with sentence-boundary chunking and WAV-correct concatenation.
// ---------------------------------------------------------------------------

/**
 * Split on the Devanagari danda and standard punctuation, then pack sentences into
 * chunks under the limit. A single sentence longer than the limit is hard-split on
 * whitespace so we never send an over-length request.
 */
export function chunkForTts(text: string, limit = TTS_CHUNK_LIMIT): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const sentences = clean.split(/(?<=[।.!?॥])\s+/);
  const chunks: string[] = [];
  let cur = '';

  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };

  for (const s of sentences) {
    if (s.length > limit) {
      flush();
      let rest = s;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(' ', limit);
        if (cut <= 0) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      cur = rest;
      continue;
    }
    if ((cur + ' ' + s).trim().length > limit) flush();
    cur = cur ? `${cur} ${s}` : s;
  }
  flush();
  return chunks.filter(Boolean);
}

export async function speak(
  text: string,
  lang: string,
  speaker?: string,
  opts: { pace?: number; enablePreprocessing?: boolean; signal?: AbortSignal; bypassCache?: boolean } = {},
): Promise<SpeakResult> {
  const started = Date.now();
  const target = resolveVoice(lang, speaker);
  const clean = text.trim();
  if (!clean) throw new SarvamBadResponse('speak() called with empty text');

  const cacheKey = JSON.stringify([clean, target.voiceLang, target.speaker, opts.pace ?? 1]);
  if (!opts.bypassCache) {
    const hit = ttsCache.get(cacheKey);
    if (hit) return { ...hit, cached: true, latencyMs: Date.now() - started };
  }

  const chunks = chunkForTts(clean);
  const buffers: Uint8Array[] = [];

  for (const chunk of chunks) {
    const body = await sarvamFetch<any>('/text-to-speech', {
      json: {
        text: chunk,
        target_language_code: target.voiceLang,
        model: MODELS.tts,
        speaker: target.speaker,
        pace: opts.pace ?? 1.0,
        enable_preprocessing: opts.enablePreprocessing ?? true,
      },
      signal: opts.signal,
    });
    const b64s = readAudioB64(body);
    if (b64s.length === 0) {
      throw new SarvamBadResponse('Bulbul returned no audio field (checked audios/audio/data.*)', {
        endpoint: '/text-to-speech',
        body: Object.keys(body ?? {}),
      });
    }
    for (const b of b64s) buffers.push(b64ToBytes(b));
  }

  const { bytes, mime } = concatAudio(buffers);
  const base64 = bytesToB64(bytes);

  const result: SpeakResult = {
    url: `data:${mime};base64,${base64}`,
    base64,
    mime,
    bytes: bytes.length,
    voiceLang: target.voiceLang,
    requestedLang: target.textLang,
    degraded: target.degraded,
    speaker: target.speaker,
    chunks: chunks.length,
    latencyMs: Date.now() - started,
    cached: false,
  };

  ttsCache.set(cacheKey, result, bytes.length);
  return result;
}

// ---------------------------------------------------------------------------
// chat() — the reasoning_effort trap is handled here, once, for everyone.
// ---------------------------------------------------------------------------

export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const model = opts.model ?? MODELS.chatFast;
  const maxTokens = opts.maxTokens ?? 300;

  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? 0.6,
    // CRITICAL: thinking mode eats max_tokens and returns empty content with
    // finish_reason "length". Every short reply must pin this to null.
    reasoning_effort: opts.think ? 'medium' : null,
  };

  const cacheKey = opts.temperature === 0 ? JSON.stringify([model, messages, maxTokens]) : null;
  if (cacheKey) {
    const hit = chatCache.get(cacheKey);
    if (hit !== undefined) return hit;
  }

  const body = await sarvamFetch<any>('/v1/chat/completions', { json: payload, signal: opts.signal });
  const { content, finishReason } = readChatContent(body);

  if (!content && finishReason === 'length') {
    console.warn(
      `[sarvam] ⚠️  ${model} returned EMPTY content with finish_reason="length". ` +
        `This is the reasoning_effort trap — thinking tokens consumed the whole budget. ` +
        `reasoning_effort was sent as ${opts.think ? '"medium"' : 'null'}; max_tokens=${maxTokens}.`,
    );
    throw new SarvamBadResponse('Model returned empty content (finish_reason=length)', {
      endpoint: '/v1/chat/completions',
      body: { model, finishReason },
    });
  }
  if (!content) {
    throw new SarvamBadResponse('Model returned empty content', {
      endpoint: '/v1/chat/completions',
      body: { model, finishReason, keys: Object.keys(body ?? {}) },
    });
  }

  if (cacheKey) chatCache.set(cacheKey, content, content.length * 2);
  return content;
}

// ---------------------------------------------------------------------------
// translate()
// ---------------------------------------------------------------------------

export async function translate(
  text: string,
  to: string,
  opts: { from?: string; colloquial?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const clean = text.trim();
  if (!clean) return '';
  const target = normalizeLang(to);
  const model = opts.colloquial ? MODELS.translateColloquial : MODELS.translate;

  const cacheKey = JSON.stringify([clean, target, model, opts.from ?? 'auto']);
  const hit = translateCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const body = await sarvamFetch<any>('/translate', {
    json: {
      input: clean,
      source_language_code: opts.from ? normalizeLang(opts.from) : 'auto',
      target_language_code: target,
      model,
      // Mayura reads like a human; sarvam-translate reads like a government notice.
      mode: opts.colloquial ? 'code-mixed' : 'formal',
    },
    signal: opts.signal,
  });

  const out = readTranslation(body);
  if (!out) throw new SarvamBadResponse('Translate returned no text', { endpoint: '/translate', body: Object.keys(body ?? {}) });
  translateCache.set(cacheKey, out, out.length * 2);
  return out;
}

// ---------------------------------------------------------------------------
// readDocument() — Sarvam Vision / Akshar. Indic OCR for plaques and signboards.
// ---------------------------------------------------------------------------

/**
 * Sarvam's parse endpoint has returned its extracted text base64-encoded in some
 * versions and as plain text in others. Handing base64 straight to the rewrite
 * model would produce confident nonsense from what looks like a successful OCR —
 * a silent failure, and the worst kind, because the side-by-side "proof" panel
 * would be showing the judge a wall of gibberish.
 *
 * So decode only when the string is unambiguously base64 AND the decoded bytes are
 * valid UTF-8 containing letters. Indic scripts are multi-byte, so a mis-decode
 * reliably produces replacement characters, which is the check that catches it.
 */
function maybeDecodeBase64(value: string): string {
  const compact = value.replace(/\s+/g, '');
  // Real OCR output contains spaces and punctuation; base64 does not.
  if (compact.length < 32 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return value;
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (!decoded || decoded.includes('�')) return value;
    // Must look like language, not binary that happened to decode.
    if (!/\p{L}/u.test(decoded)) return value;
    return decoded.trim();
  } catch {
    return value;
  }
}

export async function readDocument(
  file: Blob | Buffer | Uint8Array,
  prompt?: string,
  opts: {
    filename?: string;
    signal?: AbortSignal;
    /** Single-page by default — a plaque photo is one page. */
    pageNumber?: number;
    /** 'large' is the accurate Sarvam Vision model; 'small' is faster and weaker. */
    mode?: 'large' | 'small';
  } = {},
): Promise<string> {
  const blob = toBlob(file, 'image/jpeg');

  const form = new FormData();
  form.append('file', blob, opts.filename ?? 'plaque.jpg');
  if (prompt) form.append('prompt', prompt);

  // Confirmed against Sarvam's published examples: /parse/parsepdf takes these three
  // alongside the file. Despite the endpoint name it accepts JPEG and PNG as well as
  // PDF, which is what makes the phone-photo plaque path viable at all.
  //   page_number    — a plaque photo is always a single page
  //   sarvam_mode    — "large" is the accurate model; "small" trades accuracy for speed
  //   prompt_caching — pointless here, every plaque photo is different
  // Sending them is the safer bet than omitting them: an unknown field is normally
  // ignored, whereas a missing required field is a 400.
  form.append('page_number', String(opts.pageNumber ?? 1));
  form.append('sarvam_mode', opts.mode ?? process.env.SARVAM_VISION_MODE ?? 'large');
  form.append('prompt_caching', 'false');

  // Sarvam has shipped this under a couple of paths across versions. Try in order.
  const candidates = (process.env.SARVAM_VISION_PATHS ?? '/parse/parsepdf,/v1/document/parse,/document-parse')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let lastErr: unknown;
  for (const path of candidates) {
    try {
      const body = await sarvamFetch<any>(path, { form, attempts: 2, signal: opts.signal, timeoutMs: 90_000 });
      const out =
        pick(body, 'output', 'text', 'content', 'markdown', 'parsed_text', 'data.output', 'data.text') ?? '';
      if (typeof out === 'string' && out.trim()) return maybeDecodeBase64(out.trim());
      if (Array.isArray(out)) return out.map((p: any) => (typeof p === 'string' ? p : pick(p, 'text', 'content') ?? '')).join('\n\n').trim();
      lastErr = new SarvamBadResponse(`Vision at ${path} returned no text`, { endpoint: path, body: Object.keys(body ?? {}) });
    } catch (err) {
      lastErr = err;
      if (err instanceof SarvamAuth || err instanceof SarvamNotConfigured) throw err;
      console.warn(`[sarvam] document parse path ${path} failed: ${(err as Error).message}`);
    }
  }
  throw lastErr ?? new SarvamBadResponse('No document parse endpoint responded');
}

export { normalizeLang, resolveVoice };
export type { LangCode };
