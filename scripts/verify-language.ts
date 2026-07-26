/**
 * npx tsx scripts/verify-language.ts
 *
 * END-TO-END LANGUAGE FIDELITY, WITHOUT A SARVAM KEY.
 *
 * The spine of Bol is one claim: a visitor speaks, Saaras says which of the 23
 * languages that was, and every stage after it — routing, generation, voice —
 * obeys. Nothing downstream may override it and nothing anywhere may ask. That
 * claim had never been executed, because there is no Sarvam key in this
 * environment and every route correctly refuses to run without one.
 *
 * So this harness stands up a stub that impersonates api.sarvam.ai on localhost,
 * points SARVAM_BASE_URL at it (the one env var lib/sarvam.ts reads for its base
 * URL), and drives the REAL route handlers — app/api/listen, /answer, /speak,
 * /session — in this process. Nothing is mocked above the network boundary: the
 * routes, lib/sarvam, lib/prompts, lib/directive, lib/langs, lib/retrieval and
 * lib/db are all the shipping code.
 *
 * Every assertion is made against the value the stub ACTUALLY RECEIVED, not
 * against a 200. "Saaras said Tamil" is only proved by Bulbul being called with
 * target_language_code=ta-IN and by the answering prompt naming Tamil.
 *
 * WHAT THE STUB CANNOT PROVE is listed at the bottom of the run, honestly, every
 * time. Read it. A green run here means the wiring is right; it does not mean
 * Sarvam's models behave.
 *
 * Runs in ~2 seconds, no dev server, no network, no ports above the stub's.
 */

import http from 'node:http';
import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

// ---------------------------------------------------------------------------
// 0. Bootstrapping — all of this must happen before a single lib/ module loads
// ---------------------------------------------------------------------------

/**
 * lib/sarvam.ts and lib/db.ts open with `import 'server-only'`, a marker package
 * Next aliases away at build time and which throws if it is ever really loaded.
 * Outside Next there is nothing to alias it, so we point the specifier at the
 * same empty module Next uses. scripts/seed.ts does this too.
 */
const loader = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveOriginal = loader._resolveFilename;
loader._resolveFilename = function patched(this: unknown, request: string, ...rest: unknown[]): string {
  if (request === 'server-only' || request === 'client-only') {
    return resolveOriginal.call(this, 'next/dist/compiled/server-only/empty.js', ...rest);
  }
  return resolveOriginal.call(this, request, ...rest);
};

const STUB_PORT = Number(process.env.BOL_STUB_PORT ?? 3312);
const DATA_DIR = path.join(os.tmpdir(), `bol-verify-${process.pid}`);

// lib/sarvam reads SARVAM_BASE_URL at module load, so this must precede the
// dynamic imports in main(). A key must be present or every route 503s by design.
process.env.SARVAM_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
process.env.SARVAM_API_KEY = 'stub-key-for-verify-language';
process.env.SARVAM_USE_BACKUP = '0';
// Never write into the repo's .data/ — this run logs hundreds of events.
process.env.BOL_DATA_DIR = DATA_DIR;
// The file-backed store, not a real Supabase project.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORIGIN = 'http://localhost:3311';
const MONUMENT = 'qutub-minar';

// ---------------------------------------------------------------------------
// 1. Assertions
// ---------------------------------------------------------------------------

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Failure {
  suite: string;
  name: string;
  detail: string;
}

let suite = '';
let passed = 0;
const failures: Failure[] = [];
const notes: string[] = [];

function section(title: string): void {
  suite = title;
  console.log(`\n${C.bold(title)}`);
}

/**
 * `detail` is the explanation printed when the assertion FAILS — the sentence a
 * reader needs to know what broke. It is deliberately not printed on success,
 * where it would read as an accusation against a passing check.
 */
function check(name: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passed++;
    console.log(`  ${C.green('PASS')}  ${name}`);
  } else {
    failures.push({ suite, name, detail });
    console.log(`  ${C.red('FAIL')}  ${name}  ${C.red(detail)}`);
  }
  return ok;
}

function eq(name: string, actual: unknown, expected: unknown): boolean {
  return check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function note(line: string): void {
  notes.push(line);
}

/**
 * Some suites deliberately drive the failure paths, and those paths log — loudly
 * and correctly. Their console noise is expected output, not a finding, so it is
 * muted for the duration rather than left to bury the assertions.
 */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

// ---------------------------------------------------------------------------
// 2. The stub — everything api.sarvam.ai does that Bol depends on
// ---------------------------------------------------------------------------

/**
 * Scenario control travels INSIDE the uploaded audio, as a marker in the WAV
 * data chunk, so the stub needs no out-of-band state and the suites can run in
 * any order. Whatever the test writes into the "recording" is what Saaras
 * "hears".
 */
interface SttScript {
  lang: string;
  transcript: string;
}

interface StubCall {
  path: string;
  apiKey: string | undefined;
  /** What kind of call this was, so suites can filter without counting. */
  kind: 'stt' | 'router' | 'answer' | 'tts' | 'translate' | 'other';
  body?: Record<string, any>;
  /** Multipart parts, for /speech-to-text. */
  parts?: { name: string; filename: string | null; contentType: string | null; bytes: number; head: string }[];
  /** For 'answer': the language code the system prompt actually instructed. */
  promptLang?: string;
  /** For 'tts': the language code actually handed to Bulbul. */
  ttsLang?: string;
}

const calls: StubCall[] = [];

/** Only the calls made since a mark — suites never count calls globally. */
const since = (mark: number, kind: StubCall['kind']): StubCall[] => calls.slice(mark).filter((c) => c.kind === kind);
const mark = (): number => calls.length;

const HEADER_END = '\r\n\r\n';

function parseMultipart(buf: Buffer, boundary: string): NonNullable<StubCall['parts']> {
  const parts: NonNullable<StubCall['parts']> = [];
  const sep = Buffer.from(`--${boundary}`);
  let idx = buf.indexOf(sep);
  while (idx >= 0) {
    const start = idx + sep.length;
    if (buf.subarray(start, start + 2).toString('latin1') === '--') break;
    const next = buf.indexOf(sep, start);
    const chunk = buf.subarray(start + 2, next < 0 ? buf.length : next - 2);
    const headerEnd = chunk.indexOf(HEADER_END);
    if (headerEnd < 0) break;
    const headers = chunk.subarray(0, headerEnd).toString('latin1');
    const body = chunk.subarray(headerEnd + HEADER_END.length);
    parts.push({
      name: /name="([^"]*)"/.exec(headers)?.[1] ?? '',
      filename: /filename="([^"]*)"/.exec(headers)?.[1] ?? null,
      contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null,
      bytes: body.length,
      head: body.subarray(0, 512).toString('utf8'),
    });
    if (next < 0) break;
    idx = next;
  }
  return parts;
}

/** A minimal but genuinely valid 16kHz mono WAV, so lib/wav can parse and concat it. */
function wav(payload: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + payload.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

const TTS_WAV_B64 = wav(Buffer.alloc(640)).toString('base64');

/**
 * One short first-person line per language, in that language's script.
 *
 * These are STUB FIXTURES, not product copy — they stand in for what the model
 * would return, and every assertion made on them is about SCRIPT, never about
 * grammar. Nothing here is ever shown to a visitor.
 */
const REPLIES: Record<string, string> = {
  'en-IN': 'I am built of red sandstone, and I have watched Delhi for eight centuries.',
  'hi-IN': 'मैं लाल पत्थर का बना हूँ, और आठ सदियों से दिल्ली को देख रहा हूँ।',
  'bn-IN': 'আমি লাল পাথরে গড়া, আট শতাব্দী ধরে দিল্লিকে দেখছি।',
  'gu-IN': 'હું લાલ પથ્થરથી બનેલો છું, અને આઠ સદીઓથી દિલ્હીને જોઈ રહ્યો છું.',
  'kn-IN': 'ನಾನು ಕೆಂಪು ಕಲ್ಲಿನಿಂದ ಕಟ್ಟಲ್ಪಟ್ಟಿದ್ದೇನೆ, ಎಂಟು ಶತಮಾನಗಳಿಂದ ದೆಹಲಿಯನ್ನು ನೋಡುತ್ತಿದ್ದೇನೆ.',
  'ml-IN': 'ഞാൻ ചുവന്ന കല്ലുകൊണ്ട് പണിതതാണ്, എട്ട് നൂറ്റാണ്ടായി ഡൽഹിയെ കാണുന്നു.',
  'mr-IN': 'मी लाल दगडाचा बनलेला आहे, आठ शतकांपासून दिल्लीला पाहतो आहे.',
  'od-IN': 'ମୁଁ ଲାଲ ପଥରରେ ତିଆରି, ଆଠ ଶତାବ୍ଦୀ ଧରି ଦିଲ୍ଲୀକୁ ଦେଖୁଛି।',
  'pa-IN': 'ਮੈਂ ਲਾਲ ਪੱਥਰ ਦਾ ਬਣਿਆ ਹਾਂ, ਅੱਠ ਸਦੀਆਂ ਤੋਂ ਦਿੱਲੀ ਨੂੰ ਵੇਖ ਰਿਹਾ ਹਾਂ।',
  'ta-IN': 'நான் சிவப்புக் கல்லால் கட்டப்பட்டவன், எட்டு நூற்றாண்டுகளாக தில்லியைப் பார்க்கிறேன்.',
  'te-IN': 'నేను ఎర్రరాయితో నిర్మించబడ్డాను, ఎనిమిది శతాబ్దాలుగా ఢిల్లీని చూస్తున్నాను.',
  'as-IN': 'মই ৰঙা শিলেৰে গঢ়া, আঠ শতিকা ধৰি দিল্লীক চাই আছোঁ।',
  'ur-IN': 'میں سرخ پتھر سے بنا ہوں، آٹھ صدیوں سے دہلی کو دیکھ رہا ہوں۔',
  'sa-IN': 'अहं रक्तप्रस्तरेण निर्मितः, अष्टशतकेभ्यः दिल्लीं पश्यामि।',
  'ne-IN': 'म रातो ढुङ्गाले बनेको हुँ, आठ शताब्दीदेखि दिल्लीलाई हेर्दै छु।',
  'kok-IN': 'हांव तांबड्या फातराचो बांदिल्लो, आठ शतमानां थावन दिल्ली पळयतां.',
  'mai-IN': 'हम लाल पाथरसँ बनल छी, आठ शताब्दीसँ दिल्लीकेँ देखि रहल छी।',
  'doi-IN': 'मैं लाल पत्थर दा बणे दा हां, अठ सदियें कोला दिल्ली गी दिखदा पेआ हां।',
  'ks-IN': 'بہٕ چھُس وُزُل کنہِ سٕتؠ بنومُت، ژھ صدین پؠٹھ چھُس دِلی وُچھان۔',
  'sd-IN': 'مان ڳاڙهي پٿر مان ٺهيل آهيان، اٺن صدين کان دهلي کي ڏسي رهيو آهيان.',
  'mni-IN': 'ꯑꯩ ꯑꯉꯥꯡꯕ ꯅꯨꯡꯅ ꯁꯥꯕꯅꯤ, ꯆꯍꯤ ꯆꯥꯃꯥ ꯅꯤꯄꯥꯟ ꯗꯤꯜꯂꯤꯕꯨ ꯌꯦꯡꯂꯤ꯫',
  'brx-IN': 'आं गोजां अन्थाइजों बानायखौ, दाइनि जेब्लानिफ्राय दिल्लीखौ नायबाय दं।',
  'sat-IN': 'ᱤᱧ ᱟᱨᱟᱜ ᱫᱷᱤᱨᱤ ᱛᱮ ᱛᱮᱭᱟᱨ ᱠᱟᱱᱟ, ᱤᱨᱟᱹᱲ ᱥᱟᱶ ᱦᱚᱲᱢᱚ ᱫᱤᱞᱞᱤ ᱧᱮᱞ ᱠᱟᱱᱟ.',
};

/**
 * The stub reads the language out of the answering prompt exactly where
 * lib/prompts puts it. If prompts.ts stops naming the language, this regex stops
 * matching and every language assertion in the run fails — which is the correct
 * outcome, not a harness bug.
 */
const PROMPT_LANG_RE = /Reply in ([A-Za-z]+) \(([^)]+)\), written in the (.+?) script/;

let nativeToCode = new Map<string, string>();

function stubReply(promptLang: string, userText: string): string {
  const forced = /\[\[reply:([A-Za-z-]+)\]\]/.exec(userText)?.[1];
  const replyLang = forced ?? promptLang;
  const remembered = /\[\[remembered:false\]\]/.test(userText) ? 'false' : 'true';
  const text = REPLIES[replyLang] ?? REPLIES['en-IN'];
  return `${text}\n{"remembered":${remembered},"focus":"dome","grade":"dusk","era":null}`;
}

function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const contentType = String(req.headers['content-type'] ?? '');
      const call: StubCall = {
        path: req.url ?? '',
        apiKey: req.headers['api-subscription-key'] as string | undefined,
        kind: 'other',
      };

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (contentType.includes('multipart/form-data')) {
        call.parts = parseMultipart(raw, /boundary=(.*)$/.exec(contentType)?.[1] ?? '');
      } else if (raw.length) {
        try {
          call.body = JSON.parse(raw.toString('utf8'));
        } catch {
          call.body = { _unparsed: raw.toString('utf8').slice(0, 200) };
        }
      }

      switch (req.url) {
        case '/speech-to-text': {
          call.kind = 'stt';
          calls.push(call);
          const head = call.parts?.find((p) => p.name === 'file')?.head ?? '';
          const json = /BOL<<(.*?)>>BOL/s.exec(head)?.[1];
          let script: SttScript = { lang: 'hi-IN', transcript: '' };
          if (json) {
            try {
              script = { ...script, ...(JSON.parse(json) as SttScript) };
            } catch {
              /* an unreadable marker means an empty transcript, which is itself a test case */
            }
          }
          // Saaras returns the language it heard even when it heard no words.
          return send(200, { transcript: script.transcript, language_code: script.lang });
        }

        case '/v1/chat/completions': {
          const messages = (call.body?.messages ?? []) as { role: string; content: string }[];
          const system = messages.find((m) => m.role === 'system')?.content ?? '';
          const user = messages.find((m) => m.role === 'user')?.content ?? '';

          if (/You are a router/.test(system)) {
            call.kind = 'router';
            calls.push(call);
            const intent = /\[\[intent:([A-Z]+)\]\]/.exec(user)?.[1] ?? 'SIMPLE';
            return send(200, { choices: [{ message: { content: intent }, finish_reason: 'stop' }] });
          }

          call.kind = 'answer';
          const native = PROMPT_LANG_RE.exec(system)?.[2] ?? '';
          call.promptLang = nativeToCode.get(native) ?? `??(${native})`;
          calls.push(call);
          return send(200, {
            choices: [{ message: { content: stubReply(call.promptLang, user) }, finish_reason: 'stop' }],
          });
        }

        case '/text-to-speech': {
          call.kind = 'tts';
          call.ttsLang = call.body?.target_language_code;
          calls.push(call);
          return send(200, { audios: [TTS_WAV_B64] });
        }

        case '/translate': {
          call.kind = 'translate';
          calls.push(call);
          const target = String(call.body?.target_language_code ?? 'en-IN');
          return send(200, { translated_text: REPLIES[target] ?? REPLIES['en-IN'] });
        }

        default:
          calls.push(call);
          return send(404, { error: `stub has no route for ${req.url}` });
      }
    });
  });

  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// 3. Driving the real routes
// ---------------------------------------------------------------------------

/** An "utterance": a real WAV carrying the scenario Saaras is to report. */
function utterance(script: SttScript, mime = 'audio/webm'): Blob {
  const payload = Buffer.from(`BOL<<${JSON.stringify(script)}>>BOL`, 'utf8');
  const bytes = wav(payload);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}

type Routes = {
  listen: typeof import('../app/api/listen/route');
  answer: typeof import('../app/api/answer/route');
  speak: typeof import('../app/api/speak/route');
  session: typeof import('../app/api/session/route');
};

let routes: Routes;
let NextRequestCtor: typeof import('next/server').NextRequest;

interface Json {
  status: number;
  body: any;
}

async function postListen(opts: {
  script: SttScript;
  mime?: string;
  sessionId?: string | null;
  lastLang?: string | null;
}): Promise<Json> {
  const form = new FormData();
  // The client sends the field as "audio" (see hooks/useVoiceLoop.ts).
  form.append('audio', utterance(opts.script, opts.mime), 'utterance.bin');
  form.append('mode', 'codemix');
  if (opts.sessionId) form.append('sessionId', opts.sessionId);
  if (opts.lastLang) form.append('lastLang', opts.lastLang);

  const req = new NextRequestCtor(`${ORIGIN}/api/listen`, { method: 'POST', body: form } as any);
  const res = await routes.listen.POST(req);
  return { status: res.status, body: await res.json() };
}

async function postJson(route: 'answer' | 'speak' | 'session', body: unknown, query = ''): Promise<Json> {
  const req = new NextRequestCtor(`${ORIGIN}/api/${route}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await routes[route].POST(req);
  return { status: res.status, body: await res.json() };
}

async function postSpeakRaw(body: unknown): Promise<{ status: number; headers: Headers; bytes: number }> {
  const req = new NextRequestCtor(`${ORIGIN}/api/speak?raw=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await routes.speak.POST(req);
  const buf = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, bytes: buf.byteLength };
}

/**
 * One complete turn, wired exactly as hooks/useVoiceLoop.ts wires it:
 * the language from /api/listen is what goes to /api/answer, and the language
 * /api/answer reports is what goes to /api/speak. Nothing is remembered between
 * turns except `lastLang`, which is what the hook sends too.
 */
async function turn(opts: {
  script: SttScript;
  sessionId?: string | null;
  lastLang?: string | null;
  bypassCache?: boolean;
}): Promise<{ stt: Json; answer: Json; speak: Json }> {
  const stt = await postListen(opts);
  const answer = await postJson('answer', {
    transcript: stt.body.transcript,
    lang: stt.body.lang,
    monumentId: MONUMENT,
    sessionId: opts.sessionId ?? undefined,
  });
  const speak = await postJson('speak', {
    text: answer.body.text,
    lang: answer.body.lang,
    sessionId: opts.sessionId ?? undefined,
    bypassCache: opts.bypassCache ?? true,
  });
  return { stt, answer, speak };
}

async function readEvents(): Promise<{ kind: string; payload: Record<string, unknown> }[]> {
  // persist() is queued, not awaited by the routes; give it a tick to land.
  await new Promise((r) => setTimeout(r, 120));
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'store.json'), 'utf8');
    return (JSON.parse(raw).events ?? []) as { kind: string; payload: Record<string, unknown> }[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. The suites
// ---------------------------------------------------------------------------

/** The 11 Bulbul can voice — detection must survive untouched all the way to TTS. */
const SPEAKABLE_UNDER_TEST = [
  'ta-IN', 'hi-IN', 'bn-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'od-IN', 'en-IN',
];

/** The 11 Saaras understands and Bulbul cannot voice. */
const UNSPEAKABLE = [
  'as-IN', 'ur-IN', 'sa-IN', 'ne-IN', 'kok-IN', 'mai-IN', 'doi-IN', 'ks-IN', 'sd-IN', 'mni-IN', 'brx-IN', 'sat-IN',
];

async function main(): Promise<void> {
  const stub = await startStub();

  const langs = await import('../lib/langs');
  const prompts = await import('../lib/prompts');
  NextRequestCtor = (await import('next/server')).NextRequest;
  routes = {
    listen: await import('../app/api/listen/route'),
    answer: await import('../app/api/answer/route'),
    speak: await import('../app/api/speak/route'),
    session: await import('../app/api/session/route'),
  };

  nativeToCode = new Map(Object.values(langs.LANGS).map((l) => [l.native, l.code]));

  console.log(C.bold('\nBol — end-to-end language fidelity'));
  console.log(C.dim(`  stub api.sarvam.ai on 127.0.0.1:${STUB_PORT} · store ${DATA_DIR}\n`));

  const session = await postJson('session', { monumentId: MONUMENT });
  const sessionId: string = session.body.sessionId;

  // -------------------------------------------------------------------------
  section('1 · Detection propagates — Saaras → prompt → Bulbul');
  // -------------------------------------------------------------------------
  eq('session bootstraps without choosing a language', session.body.lang, null);

  for (const lang of SPEAKABLE_UNDER_TEST) {
    const at = mark();
    const { stt, answer, speak } = await turn({
      script: { lang, transcript: `question in ${lang}` },
      sessionId,
    });

    const sttCall = since(at, 'stt')[0];
    const answerCall = since(at, 'answer')[0];
    const ttsCall = since(at, 'tts')[0];
    const label = langs.info(lang).english;

    const ok =
      check(`${lang} · /api/listen reports the detected language`, stt.body.lang === lang, `got ${stt.body.lang}`) &&
      check(
        `${lang} · Saaras was asked to auto-detect (no language_code sent)`,
        !sttCall?.parts?.some((p) => p.name === 'language_code'),
        'a language_code field was sent to /speech-to-text — that is a language picker by another name',
      ) &&
      check(
        `${lang} · the answering prompt instructs ${label}`,
        answerCall?.promptLang === lang,
        `prompt named ${answerCall?.promptLang}`,
      ) &&
      check(`${lang} · /api/answer echoes the language`, answer.body.lang === lang, `got ${answer.body.lang}`) &&
      check(
        `${lang} · the reply is in the ${langs.info(lang).script} script`,
        prompts.checkReplyScript(answer.body.text, lang) === 'match',
        `got "${String(answer.body.text).slice(0, 40)}"`,
      ) &&
      check(
        `${lang} · Bulbul is called with target_language_code=${lang}`,
        ttsCall?.ttsLang === lang,
        `got ${ttsCall?.ttsLang}`,
      ) &&
      check(`${lang} · no voice degradation claimed`, speak.body.degraded === false, `degraded=${speak.body.degraded}`);

    if (!ok) note(`detection chain broke for ${lang}`);
  }

  // -------------------------------------------------------------------------
  section('1b · Whatever shape Saaras spells the language in');
  // -------------------------------------------------------------------------
  {
    // BUILD-CONTRACT.md warns that Sarvam has renamed fields between versions.
    // The language code is the one field where a silent misread costs the whole
    // product, so every spelling we have seen is exercised against the route.
    for (const [raw, expected] of [
      ['ta-IN', 'ta-IN'],
      ['ta', 'ta-IN'],
      ['tam', 'ta-IN'],
      ['TA-IN', 'ta-IN'],
      ['ta_IN', 'ta-IN'],
      ['ory', 'od-IN'],
    ] as [string, string][]) {
      const at = mark();
      const { answer } = await turn({ script: { lang: raw, transcript: 'a question' }, sessionId });
      check(
        `Saaras saying "${raw}" reaches Bulbul as ${expected}`,
        answer.body.lang === expected && since(at, 'tts')[0]?.ttsLang === expected,
        `answer=${answer.body.lang} tts=${since(at, 'tts')[0]?.ttsLang}`,
      );
    }

    // And the shapes that CANNOT be understood must land on the default rather
    // than crash — silently, which is why they are called out here.
    // A language NAME now resolves to its code — normalizeLang gained an English-name
    // lookup after this suite first reported the gap. Kept as an assertion so the
    // capability cannot silently regress.
    {
      const at = mark();
      const { answer } = await turn({ script: { lang: 'Tamil', transcript: 'a question' }, sessionId });
      check(
        'a language NAME "Tamil" resolves to ta-IN rather than degrading to the default',
        answer.body.lang === 'ta-IN' && since(at, 'tts')[0]?.ttsLang === 'ta-IN',
        `answer=${answer.body.lang} tts=${since(at, 'tts')[0]?.ttsLang}`,
      );
    }
    for (const raw of ['unknown', 'Klingon', '']) {
      const { answer } = await turn({ script: { lang: raw, transcript: 'a question' }, sessionId });
      check(`an unrecognised code "${raw}" degrades to ${langs.DEFAULT_LANG}`, answer.body.lang === langs.DEFAULT_LANG);
    }
    note(
      `if Saaras returns a language label we do not hold at all, normalizeLang falls back to ${langs.DEFAULT_LANG} — it now warns loudly and isRecognisedLang() can tell a real detection from a fallback, but confirm the live shape with GET /api/sarvam/selftest on the first key.`,
    );
  }

  // -------------------------------------------------------------------------
  section('2 · The unspeakable eleven — right text, borrowed voice, said out loud');
  // -------------------------------------------------------------------------
  for (const lang of UNSPEAKABLE) {
    const at = mark();
    const { stt, answer } = await turn({ script: { lang, transcript: `question in ${lang}` }, sessionId });
    const raw = await postSpeakRaw({ text: answer.body.text, lang: answer.body.lang, sessionId, bypassCache: true });

    const answerCall = since(at, 'answer')[0];
    const ttsCall = since(at, 'tts').pop();
    const expectedVoice = langs.resolveVoice(lang).voiceLang;

    check(`${lang} · Saaras's detection survives /api/listen`, stt.body.lang === lang, `got ${stt.body.lang}`);
    check(
      `${lang} · the answer is generated in ${langs.info(lang).english}`,
      answerCall?.promptLang === lang && answer.body.lang === lang,
      `prompt=${answerCall?.promptLang} answer=${answer.body.lang}`,
    );
    check(
      `${lang} · the TEXT is in the ${langs.info(lang).script} script`,
      prompts.checkReplyScript(answer.body.text, lang) === 'match',
      `got "${String(answer.body.text).slice(0, 40)}"`,
    );
    check(
      `${lang} · the VOICE falls back to ${expectedVoice}, which is not ${lang}`,
      ttsCall?.ttsLang === expectedVoice && expectedVoice !== lang,
      `Bulbul got ${ttsCall?.ttsLang}`,
    );
    check(`${lang} · raw response flags degraded`, raw.headers.get('x-bol-degraded') === 'true');
    check(
      `${lang} · requested vs voice language both reported`,
      raw.headers.get('x-bol-requested-lang') === lang && raw.headers.get('x-bol-voice-lang') === expectedVoice,
      `requested=${raw.headers.get('x-bol-requested-lang')} voice=${raw.headers.get('x-bol-voice-lang')}`,
    );
    check(
      `${lang} · the honest notice is surfaced, in the visitor's own words`,
      decodeURIComponent(raw.headers.get('x-bol-notice') ?? '') === langs.voiceGapNotice(lang),
      'notice header did not match voiceGapNotice()',
    );
    check(`${lang} · audio still comes back to play`, raw.status === 200 && raw.bytes > 44, `${raw.bytes} bytes`);
  }

  // -------------------------------------------------------------------------
  section('3 · Mid-session switching — Tamil, Hindi, Tamil, with no stickiness');
  // -------------------------------------------------------------------------
  {
    const switchSession = (await postJson('session', { monumentId: MONUMENT })).body.sessionId as string;
    const sequence = ['ta-IN', 'hi-IN', 'ta-IN'];
    let lastLang: string | null = null;

    for (let i = 0; i < sequence.length; i++) {
      const lang = sequence[i];
      const at = mark();
      const { stt, answer } = await turn({
        script: { lang, transcript: `turn ${i + 1}` },
        sessionId: switchSession,
        lastLang,
      });
      const answerCall = since(at, 'answer')[0];
      const ttsCall = since(at, 'tts')[0];

      check(`turn ${i + 1} · detected ${lang}`, stt.body.lang === lang, `got ${stt.body.lang}`);
      check(
        `turn ${i + 1} · switch flagged correctly`,
        stt.body.switched === (lastLang !== null && lastLang !== lang),
        `switched=${stt.body.switched} lastLang=${lastLang}`,
      );
      check(`turn ${i + 1} · generated in ${lang}`, answerCall?.promptLang === lang, `prompt=${answerCall?.promptLang}`);
      check(`turn ${i + 1} · voiced in ${lang}`, ttsCall?.ttsLang === lang, `tts=${ttsCall?.ttsLang}`);
      lastLang = stt.body.lang;
    }

    check('turn 3 came back to Tamil rather than sticking on Hindi', lastLang === 'ta-IN', `ended on ${lastLang}`);

    // The server must also have followed the visitor in the session record.
    const patched = await (async () => {
      const req = new NextRequestCtor(`${ORIGIN}/api/session`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: switchSession, lang: 'ta-IN' }),
      });
      const res = await routes.session.PATCH(req);
      return { status: res.status, body: await res.json() };
    })();
    check('PATCH /api/session records the latest language', patched.body.lang === 'ta-IN', JSON.stringify(patched.body));
    check(
      'PATCH reports the chip in the visitor’s own script',
      patched.body.chip?.native === langs.info('ta-IN').native,
      JSON.stringify(patched.body.chip),
    );
  }

  // -------------------------------------------------------------------------
  section('4 · The model answering in the wrong language');
  // -------------------------------------------------------------------------
  {
    const at = mark();
    // [[reply:en-IN]] makes the stub ignore the prompt and answer in English,
    // which is exactly what a weak prompt produces against a live model.
    const stt = await postListen({ script: { lang: 'ta-IN', transcript: 'question [[reply:en-IN]]' }, sessionId });
    const answer = await postJson('answer', {
      transcript: stt.body.transcript,
      lang: stt.body.lang,
      monumentId: MONUMENT,
      sessionId,
    });

    check('the prompt still asked for Tamil', since(at, 'answer')[0]?.promptLang === 'ta-IN');
    check('an English reply to a Tamil speaker is detected', answer.body.langMismatch === true, JSON.stringify(answer.body.langMismatch));
    check('the mismatch is repaired rather than spoken', answer.body.langRepaired === true);
    check(
      'the repair is routed through Sarvam translate with the right target',
      since(at, 'translate')[0]?.body?.target_language_code === 'ta-IN',
      `translate target=${since(at, 'translate')[0]?.body?.target_language_code}`,
    );
    check(
      'what finally gets spoken is Tamil',
      prompts.checkReplyScript(answer.body.text, 'ta-IN') === 'match',
      `text="${String(answer.body.text).slice(0, 40)}"`,
    );

    // And the check must not cry wolf on a correct reply.
    const clean = await postJson('answer', { transcript: 'a fine question', lang: 'ta-IN', monumentId: MONUMENT });
    check('a correct Tamil reply is not flagged', clean.body.langMismatch === false);

    check(
      'script check is honest about what it cannot see',
      prompts.checkReplyScript(REPLIES['hi-IN'], 'mr-IN') === 'match',
      'Devanagari is shared — a Hindi reply to a Marathi speaker cannot be caught by script alone',
    );
  }

  // -------------------------------------------------------------------------
  section('5 · Empty transcript — "I did not catch that", in their language');
  // -------------------------------------------------------------------------
  {
    const tamilSilence = await quiet(() =>
      postListen({ script: { lang: 'ta-IN', transcript: '' }, sessionId, lastLang: 'ta-IN' }),
    );
    eq('empty transcript still returns 200', tamilSilence.status, 200);
    check('flagged as empty', tamilSilence.body.empty === true);
    check('language stays on the last known one', tamilSilence.body.lang === 'ta-IN', `got ${tamilSilence.body.lang}`);
    check(
      'the "I did not catch that" line is in Tamil',
      tamilSilence.body.fallbackText === prompts.didNotCatch('ta-IN') &&
        prompts.checkReplyScript(tamilSilence.body.fallbackText, 'ta-IN') === 'match',
      `got "${tamilSilence.body.fallbackText}"`,
    );

    const at = mark();
    const spoke = await postJson('speak', {
      text: tamilSilence.body.fallbackText,
      lang: tamilSilence.body.lang,
      bypassCache: true,
    });
    check('and it is spoken in the Tamil voice', since(at, 'tts')[0]?.ttsLang === 'ta-IN', `tts=${since(at, 'tts')[0]?.ttsLang}`);
    check('not an error path', spoke.status === 200);

    // Silence before any language is known: Saaras's guess on noise is not
    // trustworthy, so the route must fall back to DEFAULT_LANG, never English.
    const coldSilence = await quiet(() => postListen({ script: { lang: 'ta-IN', transcript: '' } }));
    check(
      'with no language known yet it falls back to the default, not English',
      coldSilence.body.lang === langs.DEFAULT_LANG && coldSilence.body.lang !== 'en-IN',
      `got ${coldSilence.body.lang}`,
    );

    // An unspeakable language has no pre-written line of its own; it must walk
    // the voiceFallback chain rather than dropping to English.
    const konkani = await quiet(() => postListen({ script: { lang: 'kok-IN', transcript: '' }, lastLang: 'kok-IN' }));
    check(
      'Konkani silence answers in Marathi (documented degradation), not English',
      konkani.body.fallbackText === prompts.didNotCatch('mr-IN') && konkani.body.lang === 'kok-IN',
      `got "${konkani.body.fallbackText}"`,
    );
  }

  // -------------------------------------------------------------------------
  section('6 · Codemix — romanised Hindi must not become English');
  // -------------------------------------------------------------------------
  {
    const at = mark();
    const { stt, answer } = await turn({
      script: { lang: 'hi-IN', transcript: 'Qutub kitna purana hai' },
      sessionId,
    });
    check('the transcript comes back romanised, as Saaras sent it', stt.body.transcript === 'Qutub kitna purana hai');
    check('Saaras was called in codemix mode', since(at, 'stt')[0]?.parts?.some((p) => p.name === 'mode' && p.head === 'codemix') === true);
    check('the Latin script does not override the detected language', stt.body.lang === 'hi-IN', `got ${stt.body.lang}`);
    check('the answer is generated in Hindi', since(at, 'answer')[0]?.promptLang === 'hi-IN');
    check(
      'the reply comes back in Devanagari',
      prompts.checkReplyScript(answer.body.text, 'hi-IN') === 'match',
      `got "${String(answer.body.text).slice(0, 40)}"`,
    );
    check('and it is voiced in Hindi', since(at, 'tts')[0]?.ttsLang === 'hi-IN');

    // The typed fallback has no Saaras result to obey. Script decides, and Latin
    // is a script like any other — a typed English question must not be answered
    // in Hindi just because Hindi is the default.
    const typedEnglish = await postJson('answer', { transcript: 'How old are you?', monumentId: MONUMENT });
    eq('typed English with no detection is answered in English', typedEnglish.body.lang, 'en-IN');
    const typedTamil = await postJson('answer', { transcript: 'நீ எவ்வளவு பழையவன்?', monumentId: MONUMENT });
    eq('typed Tamil with no detection is answered in Tamil', typedTamil.body.lang, 'ta-IN');
  }

  // -------------------------------------------------------------------------
  section('7 · The audio really reaches Sarvam');
  // -------------------------------------------------------------------------
  {
    const cases: [string, string][] = [
      ['audio/webm;codecs=opus', 'audio.webm'],
      ['audio/webm', 'audio.webm'],
      ['audio/ogg;codecs=opus', 'audio.ogg'],
      // iOS Safari cannot record webm at all. If this row regresses, every
      // iPhone visitor uploads a file Sarvam may reject on extension alone.
      ['audio/mp4', 'audio.m4a'],
      ['audio/wav', 'audio.wav'],
    ];

    for (const [mime, filename] of cases) {
      const at = mark();
      const blob = utterance({ lang: 'ta-IN', transcript: 'hello' }, mime);
      await postListen({ script: { lang: 'ta-IN', transcript: 'hello' }, mime });
      const part = since(at, 'stt')[0]?.parts?.find((p) => p.name === 'file');

      check(`${mime} · uploaded under the field name Sarvam expects`, Boolean(part), 'no "file" part in the multipart body');
      check(`${mime} · filename follows the blob type`, part?.filename === filename, `got ${part?.filename}`);
      check(`${mime} · part carries the recorder's content type`, part?.contentType === mime, `got ${part?.contentType}`);
      check(`${mime} · every byte of the recording arrives`, part?.bytes === blob.size, `${part?.bytes} of ${blob.size}`);
    }

    // A Blob with no type at all (some Android builds): must not crash, must
    // still upload, and lib/sarvam's documented default applies.
    const at = mark();
    await postListen({ script: { lang: 'hi-IN', transcript: 'x' }, mime: '' });
    const untyped = since(at, 'stt')[0]?.parts?.find((p) => p.name === 'file');
    check('an untyped blob still uploads', Boolean(untyped) && (untyped?.bytes ?? 0) > 44, `${untyped?.bytes} bytes`);
    note(`a Blob with no mime type uploads as ${untyped?.filename} (${untyped?.contentType}) — lib/sarvam's documented default`);

    // The client half: the recorder's mime must reach the Blob, or the server
    // has nothing to derive the extension from.
    const hookSource = await fs.readFile(path.join(process.cwd(), 'hooks', 'useVoiceLoop.ts'), 'utf8');
    check(
      'useVoiceLoop stamps the recorder mime onto the uploaded blob',
      /new Blob\(parts, \{ type: mimeRef\.current \|\| 'audio\/webm' \}\)/.test(hookSource),
      'the blob type no longer comes from the recorder — the extension will be wrong on iOS',
    );
    check(
      'useVoiceLoop probes for audio/mp4 rather than assuming webm',
      hookSource.includes("'audio/mp4'"),
      'iOS Safari would record nothing',
    );
    check(
      'the uploaded field is named "audio", which /api/listen reads',
      /form\.append\('audio', blob/.test(hookSource),
    );
    check(
      'the client sends lastLang so a failed turn keeps the visitor’s language',
      /form\.append\('lastLang', langRef\.current\)/.test(hookSource),
    );
    check(
      'the answer call is given the language THIS turn detected, not a remembered one',
      /runAnswer\(stt\.transcript, stt\.lang \?\? null/.test(hookSource),
      'a cached language here is what makes a session stick to the first language spoken',
    );
    check(
      'the speak call is given the language the answer came back in',
      /playSpeech\(reply\.text, reply\.lang/.test(hookSource),
    );
  }

  // -------------------------------------------------------------------------
  section('8 · Regressions this loop has already had');
  // -------------------------------------------------------------------------
  {
    // lib/sarvam's TTS cache is keyed on the VOICE language, not the visitor's.
    // Sanskrit and Hindi share a voice, so the same line spoken to both collides
    // and the cached entry carries the first caller's `degraded`/`requestedLang`.
    // /api/speak must therefore trust resolveVoice(), not the cached result.
    // Two lines, so the collision is tested in both directions: the leak goes
    // whichever way the cache was warmed first. Neither line is used elsewhere
    // in this file, so the cache state here is deterministic.
    const lineA = 'मैं यहाँ आठ सौ बरस से खड़ा हूँ।';
    const lineB = 'मेरी छाया दिल्ली पर पड़ती है।';

    const sanskritFirst = await postJson('speak', { text: lineA, lang: 'sa-IN' });
    check(
      'Sanskrit is honestly degraded to the Hindi voice',
      sanskritFirst.body.degraded === true && sanskritFirst.body.voiceLang === 'hi-IN',
      JSON.stringify(sanskritFirst.body.degraded),
    );
    const hindiSecond = await postJson('speak', { text: lineA, lang: 'hi-IN' });
    check(
      'a Hindi visitor hearing that same line is NOT told their language cannot be spoken',
      hindiSecond.body.degraded === false,
      'the TTS cache leaked a previous caller’s degraded flag',
    );
    eq('and the requested language is their own', hindiSecond.body.requestedLang, 'hi-IN');

    const hindiFirst = await postJson('speak', { text: lineB, lang: 'hi-IN' });
    check('a plain Hindi line is not degraded', hindiFirst.body.degraded === false);
    const sanskritSecond = await postJson('speak', { text: lineB, lang: 'sa-IN' });
    check(
      'a Sanskrit visitor is still told about the voice gap after Hindi warmed the cache',
      sanskritSecond.body.degraded === true && sanskritSecond.body.notice === langs.voiceGapNotice('sa-IN'),
      'the TTS cache swallowed the voice-gap notice',
    );

    // The refusal marker must survive the round trip now that Stage renders it.
    const refusal = await postJson('answer', {
      transcript: 'what is the wifi password [[remembered:false]]',
      lang: 'ta-IN',
      monumentId: MONUMENT,
    });
    check('a `remembered:false` marker is parsed as a refusal', refusal.body.admittedIgnorance === true);
    check('a refusal is still spoken in Tamil', prompts.checkReplyScript(refusal.body.text, 'ta-IN') === 'match');
    check(
      'a refusal moves no camera',
      refusal.body.directive?.focus === null && refusal.body.directive?.grade === null,
      JSON.stringify(refusal.body.directive),
    );
    const answered = await postJson('answer', { transcript: 'how tall are you', lang: 'ta-IN', monumentId: MONUMENT });
    check('a normal answer is not mistaken for a refusal', answered.body.admittedIgnorance === false);
    check('and its directive still reaches the visual lane', answered.body.directive?.focus === 'dome');
  }

  // -------------------------------------------------------------------------
  section('9 · The chip speaks all 23 languages');
  // -------------------------------------------------------------------------
  {
    const seen = new Set<string>();
    let bad = 0;
    for (const lang of Object.values(langs.LANGS)) {
      const chip = langs.detectedChip(lang.code);
      const ok =
        Boolean(chip.native?.trim()) &&
        Boolean(chip.english?.trim()) &&
        !seen.has(chip.native) &&
        (lang.code === 'en-IN' || prompts.checkReplyScript(chip.native, lang.code) !== 'mismatch');
      seen.add(chip.native);
      if (!ok) {
        bad++;
        check(`chip · ${lang.code}`, false, JSON.stringify(chip));
      }
    }
    check('every one of the 23 languages has a distinct endonym chip', bad === 0 && seen.size === 23, `${seen.size} distinct`);
    note('endonyms are rendered from lib/langs.ts and only a native reader can truly confirm them; the Bodo entry was corrected from "बर-ा" to बड़ो after the coverage panel first displayed them.');
  }

  // -------------------------------------------------------------------------
  section('9b · With no key at all, the refusal is honest');
  // -------------------------------------------------------------------------
  {
    // Every route that calls Sarvam must 503 not_configured rather than invent
    // anything — including a language. /api/session is the documented exception
    // so the client can learn that it must degrade.
    const key = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    try {
      const listenRes = await quiet(() => postListen({ script: { lang: 'ta-IN', transcript: 'hello' } }));
      check('/api/listen refuses without a key', listenRes.status === 503 && listenRes.body.kind === 'not_configured');
      const answerRes = await quiet(() => postJson('answer', { transcript: 'hello', lang: 'ta-IN', monumentId: MONUMENT }));
      check('/api/answer refuses without a key', answerRes.status === 503 && answerRes.body.kind === 'not_configured');
      const speakRes = await quiet(() => postJson('speak', { text: 'hello', lang: 'ta-IN' }));
      check('/api/speak refuses without a key', speakRes.status === 503 && speakRes.body.kind === 'not_configured');
      const sessionRes = await postJson('session', { monumentId: MONUMENT });
      check(
        '/api/session still answers, and says the loop is unavailable',
        sessionRes.status === 200 && sessionRes.body.sarvamConfigured === false && sessionRes.body.capabilities.stt === false,
        JSON.stringify(sessionRes.body.capabilities),
      );
      check('and it still greets the visitor from the monument JSON', typeof sessionRes.body.intro === 'string' && sessionRes.body.intro.length > 0);
    } finally {
      process.env.SARVAM_API_KEY = key;
    }
  }

  // -------------------------------------------------------------------------
  section('10 · Events — a judge can audit every language decision');
  // -------------------------------------------------------------------------
  {
    const events = await readEvents();
    const kinds = new Set(events.map((e) => e.kind));
    for (const kind of ['session_start', 'lang_switch', 'voice_gap', 'stt_empty', 'lang_mismatch', 'lang_repair', 'turn_answered']) {
      check(`event logged: ${kind}`, kinds.has(kind));
    }
    const switches = events.filter((e) => e.kind === 'lang_switch');
    check(
      'the Tamil→Hindi→Tamil session logged both switches',
      switches.length >= 2,
      `${switches.length} lang_switch events`,
    );
  }

  // -------------------------------------------------------------------------
  stub.close();
  // lib/db persists on a queue the routes do not await, so let the last writes
  // land before removing the temp store — otherwise it is recreated behind us.
  await new Promise((r) => setTimeout(r, 200));
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);

  console.log(C.bold('\n─── what a stub cannot prove ───'));
  for (const line of [
    'Saaras really detecting the language a human spoke — this proves the wiring, not the model.',
    'Bulbul really producing intelligible speech for the language it is handed.',
    'That the model obeys the language rule in the prompt. The mismatch detector and repair are proved; the obedience rate is not.',
    'Sarvam response field names. lib/sarvam reads every known variant; GET /api/sarvam/selftest with a live key is what confirms which one is live.',
    'That Sarvam accepts each container/extension we upload (webm, ogg, m4a, wav) — the stub accepts everything.',
    'Anything above the fetch boundary in the browser: MediaRecorder, echo cancellation, barge-in timing, autoplay policy.',
    'Script checks cannot separate languages that share a script — Hindi/Marathi/Sanskrit/Nepali/Konkani/Maithili/Dogri/Bodo, or Bengali/Assamese.',
    ...notes,
  ]) {
    console.log(C.dim(`  · ${line}`));
  }

  console.log(C.bold('\n─── summary ───'));
  console.log(`  ${C.green(`${passed} passed`)}  ${failures.length ? C.red(`${failures.length} failed`) : C.dim('0 failed')}`);
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(C.red(`  ${f.suite} :: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
    console.log('');
    process.exit(1);
  }
  console.log(C.dim('\n  The voice loop keeps the visitor’s language at every hop.\n'));
  process.exit(0);
}

main().catch((err) => {
  console.error(C.red(`\nverify-language crashed: ${(err as Error).stack ?? err}\n`));
  process.exit(1);
});
