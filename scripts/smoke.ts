/**
 * The four-minute demo, as an automated smoke test.
 *
 * Prompt 9: "Script the exact 4-minute demo as an automated smoke test that runs
 * end to end. Run it 10 times. Any flake at all, fix it or cut the feature."
 *
 *   npm run dev                       # in one terminal
 *   npm run smoke                     # in another
 *   BASE_URL=https://bol.vercel.app npm run smoke
 *   RUNS=10 npm run smoke             # the flake hunt
 *
 * Three outcomes per step, and the distinction matters:
 *   PASS      the step did what the demo needs
 *   DEGRADED  the step returned an honest not_configured/unavailable response.
 *             Expected before a Sarvam key exists. Counted, never celebrated.
 *   FAIL      anything else — a 500, a timeout, a malformed payload, or a
 *             response that breaks one of the product's non-negotiable rules.
 *
 * Rule checks are deliberately part of the smoke test rather than a separate
 * linter, because the rules are what the product IS. A monument that answers in
 * five sentences, or in the third person, or with no source behind it, is a
 * failure even when every HTTP call returned 200.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUNS = Number(process.env.RUNS ?? 1);
const VERBOSE = process.env.VERBOSE === '1';

type Status = 'PASS' | 'DEGRADED' | 'FAIL';

interface StepResult {
  name: string;
  status: Status;
  ms: number;
  detail?: string;
}

const results: StepResult[] = [];

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function record(name: string, status: Status, ms: number, detail?: string) {
  results.push({ name, status, ms, detail });
  const badge = status === 'PASS' ? C.green('PASS') : status === 'DEGRADED' ? C.yellow('DEGR') : C.red('FAIL');
  console.log(`  ${badge}  ${name.padEnd(42)} ${C.dim(`${ms}ms`)}${detail ? `  ${C.dim(detail)}` : ''}`);
}

async function step(name: string, fn: () => Promise<{ status: Status; detail?: string }>) {
  const t0 = Date.now();
  try {
    const { status, detail } = await fn();
    record(name, status, Date.now() - t0, detail);
  } catch (err) {
    record(name, 'FAIL', Date.now() - t0, (err as Error).message);
  }
}

/** A not_configured response is honest degradation, not a failure. */
function classify(res: Response, body: any): Status | null {
  if (res.status === 503 && body?.kind === 'not_configured') return 'DEGRADED';
  if (res.status === 429 || body?.kind === 'rate_limit') return 'DEGRADED';
  if (!res.ok) return 'FAIL';
  return null;
}

async function json(path: string, init?: RequestInit): Promise<{ res: Response; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text.slice(0, 300) };
  }
  if (VERBOSE) console.log(C.dim(`      ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`));
  return { res, body };
}

// ---------------------------------------------------------------------------
// A short WAV of speech-shaped noise. Saaras will not find words in it, which is
// fine: this proves the upload path, the field names and the error handling.
// Swap in a real recording at scripts/fixtures/ for a true end-to-end check.
// ---------------------------------------------------------------------------

function syntheticWav(seconds = 2, sampleRate = 16000): Blob {
  const n = seconds * sampleRate;
  const pcm = new Int16Array(n);
  // Two formants wobbling under an envelope — closer to speech than a pure tone,
  // so we exercise the same code path a real utterance would.
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 6) * Math.min(1, (seconds - t) * 6);
    const v =
      Math.sin(2 * Math.PI * (120 + 20 * Math.sin(t * 3)) * t) * 0.5 +
      Math.sin(2 * Math.PI * (700 + 180 * Math.sin(t * 2)) * t) * 0.3;
    pcm[i] = Math.max(-1, Math.min(1, v * env)) * 20000;
  }
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Product-rule assertions
// ---------------------------------------------------------------------------

/** Rule 5: two sentences maximum in anything spoken. */
function sentenceCount(text: string): number {
  return text.split(/(?<=[।.!?॥])\s+/).filter((s) => s.trim().length > 1).length;
}

/** Rule 3: first person. A monument saying its own name in the third person is a failure. */
const THIRD_PERSON = /\b(qutub minar|the minar|the tower)\s+(was|is|has|stands|were)\b/i;

// ---------------------------------------------------------------------------
// The demo script
// ---------------------------------------------------------------------------

async function runOnce(run: number) {
  console.log(C.bold(`\n▶ run ${run}/${RUNS}  ${C.dim(BASE)}`));
  let sessionId: string | null = null;

  // --- 0. the page is alive ---------------------------------------------------
  await step('health', async () => {
    const { res, body } = await json('/api/health');
    if (!res.ok) return { status: 'FAIL', detail: `HTTP ${res.status}` };
    return {
      status: body.sarvamConfigured ? 'PASS' : 'DEGRADED',
      detail: `db=${body.db} sarvam=${body.sarvamConfigured ? 'configured' : 'no key'}`,
    };
  });

  await step('page shell renders', async () => {
    const res = await fetch(BASE);
    if (!res.ok) return { status: 'FAIL', detail: `HTTP ${res.status}` };
    const html = await res.text();
    // Rule 2 enforced mechanically: a language <select> must never reach the client.
    if (/<select[^>]*lang/i.test(html)) return { status: 'FAIL', detail: 'a language picker is in the DOM' };
    return { status: 'PASS' };
  });

  await step('hero + depth map served', async () => {
    const [hero, depth] = await Promise.all([
      fetch(`${BASE}/monuments/qutub-minar/hero.png`),
      fetch(`${BASE}/monuments/qutub-minar/depth.png`),
    ]);
    if (!hero.ok || !depth.ok) return { status: 'FAIL', detail: `hero ${hero.status} depth ${depth.status}` };
    const heroKb = Number(hero.headers.get('content-length') ?? 0) / 1024;
    return { status: 'PASS', detail: `hero ${heroKb.toFixed(0)}KB` };
  });

  // --- 1. a visitor arrives and speaks ---------------------------------------
  await step('session created', async () => {
    const { res, body } = await json('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monument_id: 'qutub-minar' }),
    });
    const c = classify(res, body);
    if (c) return { status: c };
    // The voice lane's route returns `sessionId`; accept the snake/short variants
    // too rather than pinning the smoke test to one lane's spelling.
    sessionId = body.sessionId ?? body.session_id ?? body.id ?? null;
    return { status: sessionId ? 'PASS' : 'FAIL', detail: sessionId ? undefined : 'no session id returned' };
  });

  await step('listen — Saaras detects the language', async () => {
    const fd = new FormData();
    fd.append('audio', syntheticWav(), 'utterance.wav');
    fd.append('monument_id', 'qutub-minar');
    if (sessionId) fd.append('session_id', sessionId);
    const res = await fetch(`${BASE}/api/listen`, { method: 'POST', body: fd });
    const body = await res.json().catch(() => null);
    const c = classify(res, body);
    if (c) return { status: c, detail: body?.kind };
    if (!body?.lang) return { status: 'FAIL', detail: 'no lang in response' };
    return { status: 'PASS', detail: `lang=${body.lang}` };
  });

  // --- 2. the monument answers ------------------------------------------------
  await step('answer — grounded, first person, ≤2 sentences', async () => {
    const { res, body } = await json('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        monument_id: 'qutub-minar',
        transcript: 'How tall are you and who built you?',
        lang: 'en-IN',
        session_id: sessionId,
      }),
    });
    const c = classify(res, body);
    if (c) return { status: c, detail: body?.kind };

    const text: string = body.text ?? '';
    if (!text) return { status: 'FAIL', detail: 'empty answer' };
    const n = sentenceCount(text);
    if (n > 2) return { status: 'FAIL', detail: `rule 5 violated: ${n} sentences` };
    if (THIRD_PERSON.test(text)) return { status: 'FAIL', detail: 'rule 3 violated: third person' };
    if (!body.admittedIgnorance && (!body.sources || body.sources.length === 0)) {
      return { status: 'FAIL', detail: 'rule 4 violated: answered with no sources' };
    }
    return { status: 'PASS', detail: `${n} sentence(s), ${body.sources?.length ?? 0} sources, ${body.intent}` };
  });

  await step('answer — refuses to invent when nothing is retrieved', async () => {
    const { res, body } = await json('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        monument_id: 'qutub-minar',
        // Deliberately unanswerable from the source chunks. The monument must say
        // it does not remember rather than confabulate — this is rule 4, and it is
        // the single most important assertion in this file.
        transcript: 'What is the wifi password and who won the cricket match last night?',
        lang: 'en-IN',
        session_id: sessionId,
      }),
    });
    const c = classify(res, body);
    if (c) return { status: c, detail: body?.kind };
    if (!body.admittedIgnorance) {
      return { status: 'FAIL', detail: 'answered an unanswerable question instead of admitting ignorance' };
    }
    return { status: 'PASS' };
  });

  await step('speak — Bulbul returns playable audio', async () => {
    const { res, body } = await json('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'मैं क़ुतुब मीनार हूँ।', lang: 'hi-IN', session_id: sessionId }),
    });
    const c = classify(res, body);
    if (c) return { status: c, detail: body?.kind };
    const url: string = body.audio ?? body.url ?? '';
    if (!url.startsWith('data:audio')) return { status: 'FAIL', detail: 'no data: audio URL' };
    return { status: 'PASS', detail: `${(url.length / 1024).toFixed(0)}KB${body.degraded ? ' (voice degraded)' : ''}` };
  });

  await step('speak — unspeakable language degrades honestly', async () => {
    const { res, body } = await json('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Santali: Saaras understands it, Bulbul cannot voice it.
      body: JSON.stringify({ text: 'ᱡᱚᱦᱟᱨ', lang: 'sat-IN' }),
    });
    const c = classify(res, body);
    if (c) return { status: c, detail: body?.kind };
    if (body.degraded !== true) return { status: 'FAIL', detail: 'did not flag the voice gap' };
    return { status: 'PASS', detail: `sat-IN → ${body.voiceLang}` };
  });

  // --- 3. the echo wall -------------------------------------------------------
  await step('echo wall — seeded memories retrievable', async () => {
    const { res, body } = await json('/api/memories/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monument_id: 'qutub-minar', query: 'who has been here with family?', lang: 'en-IN' }),
    });
    const c = classify(res, body);
    if (c) return { status: c, detail: body?.kind };
    if (!Array.isArray(body.memories)) return { status: 'FAIL', detail: 'no memories array' };
    if (body.memories.length === 0) return { status: 'FAIL', detail: 'seed memories missing — run npm run seed' };
    const leaked = body.memories.find((m: any) => m.approved === false || m.consented === false);
    if (leaked) return { status: 'FAIL', detail: 'an unapproved or unconsented memory leaked' };
    return { status: 'PASS', detail: `${body.memories.length} memories` };
  });

  // --- 4. the dashboard -------------------------------------------------------
  await step('live dashboard — real rows only', async () => {
    const { res, body } = await json('/live/data');
    if (!res.ok) return { status: 'FAIL', detail: `HTTP ${res.status}` };
    if (typeof body.questions !== 'number') return { status: 'FAIL', detail: 'no question count' };
    if (!body.generatedAt) return { status: 'FAIL', detail: 'no generatedAt — cannot prove freshness' };
    return { status: 'PASS', detail: `${body.sessionsLastHour} sessions/hr · ${body.languages?.length ?? 0} langs · backend=${body.backend}` };
  });

  // --- 5. the reset, so a judge can try it themselves --------------------------
  await step('debug routes reachable', async () => {
    const routes = ['/debug/photo', '/live', '/admin'];
    const codes = await Promise.all(routes.map(async (r) => `${r}:${(await fetch(`${BASE}${r}`)).status}`));
    const broken = codes.filter((c) => !c.endsWith(':200'));
    return broken.length ? { status: 'FAIL', detail: broken.join(' ') } : { status: 'PASS' };
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(C.bold('\nBol — demo smoke test'));
  console.log(C.dim(`target ${BASE} · ${RUNS} run(s)\n`));

  for (let i = 1; i <= RUNS; i++) await runOnce(i);

  const fails = results.filter((r) => r.status === 'FAIL');
  const degraded = results.filter((r) => r.status === 'DEGRADED');
  const passes = results.filter((r) => r.status === 'PASS');

  console.log(C.bold('\n─── summary ───'));
  console.log(`  ${C.green(`${passes.length} pass`)}  ${C.yellow(`${degraded.length} degraded`)}  ${C.red(`${fails.length} fail`)}`);

  if (degraded.length) {
    console.log(C.yellow('\n  Degraded steps returned an honest not_configured response.'));
    console.log(C.yellow('  Set SARVAM_API_KEY and re-run to exercise them for real.'));
  }

  if (fails.length) {
    console.log(C.red('\n  Failures:'));
    for (const f of fails) console.log(C.red(`    ${f.name}: ${f.detail ?? 'failed'}`));
    console.log(C.red('\n  Prompt 9: any flake at all — fix it, or cut the feature from the demo.\n'));
    process.exit(1);
  }

  // Flake detection across runs: the same step must not vary between runs.
  if (RUNS > 1) {
    const byName = new Map<string, Set<Status>>();
    for (const r of results) {
      if (!byName.has(r.name)) byName.set(r.name, new Set());
      byName.get(r.name)!.add(r.status);
    }
    const flaky = [...byName.entries()].filter(([, s]) => s.size > 1);
    if (flaky.length) {
      console.log(C.red(`\n  FLAKY across ${RUNS} runs:`));
      for (const [name, s] of flaky) console.log(C.red(`    ${name}: ${[...s].join(' / ')}`));
      process.exit(1);
    }
    console.log(C.green(`\n  No flakes across ${RUNS} runs.`));
  }

  console.log('');
}

main().catch((err) => {
  console.error(C.red(`\nsmoke test crashed: ${err.message}\n`));
  process.exit(1);
});
