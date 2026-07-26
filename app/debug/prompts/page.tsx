'use client';

import { useMemo, useState } from 'react';

import { classificationMessages, answerSystemPrompt, VISUAL_EXTRA_RULE, type PromptMessage } from '@/lib/prompts';
import { ungroundedSystemPrompt } from '@/lib/userMonument';
import { getMonument, monumentIds, displayName } from '@/lib/monuments';
import { LANGS, SPEAKABLE, info, type LangCode } from '@/lib/langs';
import { MONUMENT_VOICES, castingTable, MODEL_DEFAULT_SPEAKER, V3_SPEAKERS, V2_SPEAKERS, type BulbulModel } from '@/lib/voices';
import type { Intent, SourceChunk } from '@/lib/types';

/**
 * /debug/prompts — what we actually send to the Sarvam models.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PAGE AND NOT A MARKDOWN FILE
 * ---------------------------------------------------------------------------
 *
 * docs/PROMPTS.md quotes every prompt, and a quoted prompt starts drifting from
 * the shipped one the moment someone edits lib/prompts.ts. This page cannot
 * drift: it CALLS the real builder functions — `answerSystemPrompt`,
 * `classificationMessages`, `ungroundedSystemPrompt` — with a real monument and
 * its real source chunks, and prints exactly the string those functions return.
 * If the prompt changes, this page changes with it, with no one remembering to
 * update anything.
 *
 * The two prompts that live in another lane's route file (the plaque rewrite in
 * app/api/plaque, the conservation classifier in app/api/report, the memory
 * moderation filter in app/api/memories) are NOT built by an exported function,
 * so they cannot be rendered this way. They are quoted in docs/PROMPTS.md with
 * their file path, and this page says so rather than pretending otherwise.
 *
 * ---------------------------------------------------------------------------
 * THE LANGUAGE SELECTOR
 * ---------------------------------------------------------------------------
 *
 * BUILD-CONTRACT rule 2: no language picker. Anywhere. In the product, language
 * comes from Saaras auto-detection on the first utterance and nothing may ask.
 *
 * The selector below is not a product surface. It exists because the whole
 * point of the answering prompt is the language it interpolates, and you cannot
 * inspect that without being able to vary it. It lives on /debug, it is labelled
 * as debug in the UI, and nothing here is importable by app/page.tsx. If this
 * control ever appears outside /debug, that is the bug.
 */

const DEBUG_LANGS: LangCode[] = Object.keys(LANGS);

const SAMPLE_TRANSCRIPTS: Record<string, string> = {
  'en-IN': 'How tall are you, and who built you?',
  'hi-IN': 'तुम कितने ऊँचे हो, और तुम्हें किसने बनाया?',
  'ta-IN': 'நீ எவ்வளவு உயரம், உன்னை யார் கட்டினார்கள்?',
  'bn-IN': 'তুমি কত উঁচু, আর তোমাকে কে বানিয়েছে?',
  'te-IN': 'నువ్వు ఎంత ఎత్తు, నిన్ను ఎవరు కట్టారు?',
  'mr-IN': 'तू किती उंच आहेस, आणि तुला कोणी बांधलं?',
  'ur-IN': 'تم کتنے بلند ہو، اور تمہیں کس نے بنایا؟',
};

const INTENTS: Intent[] = ['SIMPLE', 'DEEP', 'MEMORY', 'REPORT', 'VISUAL'];

/** Prompts that live in another lane's file and have no exported builder. */
const QUOTED_ELSEWHERE: { title: string; path: string; model: string; why: string; text: string }[] = [
  {
    title: 'Plaque rewrite — system',
    path: 'app/api/plaque/route.ts',
    model: 'sarvam-105b (MODELS.chatDeep), temperature 0.3',
    why: 'The OCR is evidence. The rewrite may simplify it and may not extend it, so the prohibition on adding a fact is stated before the text is even shown.',
    text:
      'You rewrite monument signboards for ordinary visitors. You never add a fact, a date, ' +
      'a name or a number that is not already in the text you are given. If the text is ' +
      'thin, your rewrite is thin too.',
  },
  {
    title: 'Conservation classifier — system',
    path: 'app/api/report/route.ts',
    model: 'sarvam-105b (MODELS.chatDeep), temperature 0',
    why: 'Temperature 0 makes triage deterministic and lets lib/sarvam cache it. The JSON-only instruction is repeated in the user turn because models fence JSON by habit.',
    text:
      'You triage conservation damage reports at Indian heritage monuments for the ' +
      'Archaeological Survey of India. You reply with one JSON object and nothing else — ' +
      'no prose, no markdown, no code fences.',
  },
  {
    title: 'Memory moderation — system',
    path: 'app/api/memories/_lib/moderation.ts',
    model: 'sarvam-105b (MODELS.chatDeep), temperature 0',
    why: '"Be generous" is load-bearing: a filter that rejects grief, rambling or code-mixing would silence exactly the memories the echo wall exists to keep. Approval is still a separate human act in /admin.',
    text: [
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
    ].join('\n'),
  },
  {
    title: 'Plaque OCR — Sarvam Vision prompt',
    path: 'app/api/plaque/route.ts',
    model: 'Sarvam Vision / Akshar (readDocument)',
    why: '"Do not translate. Do not summarise." is what makes the raw column admissible as proof that the model really read the Devanagari.',
    text:
      'Extract every word of text visible in this photograph of a monument signboard, plaque or ' +
      'printed page, exactly as printed. Preserve the original script, the line breaks and the ' +
      'reading order. Do not translate. Do not summarise. Do not add anything that is not printed.',
  },
  {
    title: 'Damage photograph — Sarvam Vision prompt',
    path: 'app/api/report/route.ts',
    model: 'Sarvam Vision / Akshar (readDocument)',
    why: '"Do not describe people" keeps a citizen report about the stone. A photograph of a crowded monument must not become a description of the crowd.',
    text:
      'Describe only the physical condition of the monument surface in this photograph: any writing ' +
      'or scratching on the stone, cracks, missing pieces, water stains or seepage, plant growth, ' +
      'rubbish, or anything unsafe. Two or three factual sentences in English. Do not guess at ' +
      'history and do not describe people.',
  },
];

// ---------------------------------------------------------------------------

function Block({ title, subtitle, why, body }: { title: string; subtitle: string; why?: string; body: string }) {
  return (
    <section className="bol-glass rounded-2xl p-4 md:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <span className="text-xs text-white/50">{subtitle}</span>
        <span className="ml-auto text-xs text-white/40">{body.length} chars</span>
      </div>
      {why ? <p className="mt-2 text-xs leading-relaxed text-white/60">{why}</p> : null}
      <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/85">
        {body}
      </pre>
    </section>
  );
}

function Messages({ title, subtitle, why, messages }: { title: string; subtitle: string; why: string; messages: PromptMessage[] }) {
  return (
    <section className="bol-glass rounded-2xl p-4 md:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <span className="text-xs text-white/50">{subtitle}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/60">{why}</p>
      {messages.map((m, i) => (
        <div key={i} className="mt-3">
          <div className="text-[10px] uppercase tracking-widest text-white/40">{m.role}</div>
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/85">
            {m.content}
          </pre>
        </div>
      ))}
    </section>
  );
}

export default function PromptsDebugPage() {
  const [monumentId, setMonumentId] = useState<string>('qutub-minar');
  const [lang, setLang] = useState<LangCode>('ta-IN');
  const [intent, setIntent] = useState<Intent>('SIMPLE');
  const [fullContext, setFullContext] = useState(true);
  const [depth, setDepth] = useState(3);
  /**
   * The Bulbul model, chosen here rather than read from SARVAM_TTS_MODEL.
   *
   * `configuredModel()` reads process.env, which the server sees and the client
   * bundle does not — rendering from it would be a hydration mismatch the moment
   * anyone sets that variable. A control is better anyway: the two catalogues
   * are disjoint, and being able to see what a v2 deployment would cast is the
   * point of the table below. Default matches lib/sarvam's own default.
   */
  const [model, setModel] = useState<BulbulModel>('bulbul:v3');

  const monument = useMemo(() => getMonument(monumentId), [monumentId]);
  const li = info(lang);

  /**
   * The SOURCES block the answering prompt will actually contain.
   *
   * In `full-context` mode lib/retrieval hands the model the WHOLE corpus and
   * lets it judge relevance — see SMALL_CORPUS_MAX — so the toggle here mirrors
   * that, and the difference in the rendered prompt (two extra rules about
   * irrelevance) is the point.
   */
  const sources: SourceChunk[] = useMemo(
    () => (fullContext ? monument.sources : monument.sources.slice(0, depth)),
    [monument, fullContext, depth],
  );

  const transcript = SAMPLE_TRANSCRIPTS[lang] ?? SAMPLE_TRANSCRIPTS[li.voiceFallback ?? 'en-IN'] ?? SAMPLE_TRANSCRIPTS['en-IN'];

  const answerPrompt = useMemo(
    () =>
      answerSystemPrompt(monument, lang, sources, {
        intent,
        retrievalMode: fullContext ? 'full-context' : 'ranked',
        extraRule: intent === 'VISUAL' ? VISUAL_EXTRA_RULE : undefined,
      }),
    [monument, lang, sources, intent, fullContext],
  );

  const routerMessages = useMemo(() => classificationMessages(transcript, monument, lang), [transcript, monument, lang]);

  const ungrounded = useMemo(
    () =>
      ungroundedSystemPrompt({
        lang,
        description:
          'A tall pale stone structure with a rounded top, photographed from below against an overcast sky. ' +
          'There are three arched openings near the base and a band of weathered carving above them.',
        regions: [
          { id: 'crown', label: 'the crown' },
          { id: 'arch', label: 'the arch' },
          { id: 'base', label: 'the ground at my feet' },
          { id: 'background', label: 'the sky behind me' },
        ],
      }),
    [lang],
  );

  const cast = castingTable(model).find((r) => r.monumentId === monumentId) ?? null;

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-white md:px-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Every prompt Bol sends</h1>
          <p className="max-w-3xl text-sm leading-relaxed text-white/60">
            These strings are produced by calling the real builder functions in{' '}
            <code className="text-white/80">lib/prompts.ts</code> and{' '}
            <code className="text-white/80">lib/userMonument.ts</code> with a real monument and its real source
            chunks. What is printed below is byte-for-byte what goes to Sarvam. It cannot drift from the shipped
            prompt, because it <em>is</em> the shipped prompt.
          </p>
          <p className="max-w-3xl text-sm leading-relaxed text-white/60">
            Prose commentary, and the prompts that live inside another lane&rsquo;s route file, are in{' '}
            <code className="text-white/80">docs/PROMPTS.md</code>.
          </p>
        </header>

        {/* --- controls ---------------------------------------------------- */}
        <section className="bol-glass space-y-4 rounded-2xl p-4 md:p-5">
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-relaxed text-amber-100">
            <strong>Debug affordance only.</strong> The language control below is <em>not</em> a language picker
            and must never appear in the product. BUILD-CONTRACT rule 2: language comes from Saaras
            auto-detection on the visitor&rsquo;s first utterance and nothing anywhere may ask. It exists here
            because the answering prompt is <em>about</em> the language it interpolates, and you cannot inspect
            that without varying it.
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-white/60">Monument</span>
              <select
                value={monumentId}
                onChange={(e) => setMonumentId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm"
              >
                {monumentIds().map((id) => (
                  <option key={id} value={id}>
                    {displayName(getMonument(id), 'en-IN')}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-amber-200/80">Interpolated language — DEBUG ONLY</span>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="mt-1 w-full rounded-lg border border-amber-400/30 bg-black/40 px-3 py-2 text-sm"
              >
                {DEBUG_LANGS.map((code) => (
                  <option key={code} value={code}>
                    {LANGS[code].english} · {LANGS[code].native}
                    {SPEAKABLE.includes(code) ? '' : ' (no Bulbul voice)'}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-white/60">Intent (the router&rsquo;s output)</span>
              <select
                value={intent}
                onChange={(e) => setIntent(e.target.value as Intent)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm"
              >
                {INTENTS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                    {i === 'VISUAL' ? ' — adds the extra focus rule' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-white/60">Bulbul model (casting only — does not change the prompts)</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as BulbulModel)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm"
              >
                <option value="bulbul:v3">bulbul:v3 — {V3_SPEAKERS.length} voices, default shubh</option>
                <option value="bulbul:v2">bulbul:v2 — {V2_SPEAKERS.length} voices, default anushka</option>
              </select>
            </label>

            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={fullContext} onChange={(e) => setFullContext(e.target.checked)} />
                <span className="text-white/60">
                  full-context retrieval ({monument.sources.length} chunks — this is what actually ships)
                </span>
              </label>
              {!fullContext ? (
                <label className="flex items-center gap-2">
                  <span className="text-white/60">ranked top-k</span>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, monument.sources.length)}
                    value={depth}
                    onChange={(e) => setDepth(Number(e.target.value))}
                  />
                  <span className="tabular-nums text-white/50">{depth}</span>
                </label>
              ) : null}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-white/50">
            Reply language asked for: <strong className="text-white/80">{li.english}</strong> ({li.native}), {li.script}{' '}
            script. Bulbul {SPEAKABLE.includes(lang) ? 'voices this directly' : `cannot voice this — the text is still ${li.english}, the voice falls back`}
            . Voice cast for this monument on <code>{model}</code>:{' '}
            <strong className="text-white/80">{cast?.speaker ?? MODEL_DEFAULT_SPEAKER[model]}</strong> at pace{' '}
            {cast?.pace ?? 1}.
          </p>
        </section>

        {/* --- the prompts -------------------------------------------------- */}
        <Messages
          title="1 · The router"
          subtitle="sarvam-30b · max_tokens 8 · temperature 0 · POST /api/answer"
          why="One token out, so the 200ms routing budget is realistic. Temperature 0 makes it deterministic AND cacheable in lib/sarvam, which matters when the same three questions get asked forty times at a demo. Anything unrecognisable falls back to SIMPLE — the cheap, fast, always-works branch."
          messages={routerMessages}
        />

        <Block
          title="2 · The monument — system"
          subtitle={`${intent === 'DEEP' ? 'sarvam-105b' : 'sarvam-30b'} · max_tokens ${intent === 'DEEP' ? 340 : 220} · temperature 0.6 · POST /api/answer`}
          why="The language rule is stated FIRST and again LAST. The failure it guards against is specific: Saaras detects Tamil, the SOURCES block is English, and the model — pulled by the language of the context it can see — answers in English anyway. Recency beats a rule stated 400 tokens earlier, so it is repeated immediately before generation. The region ids and era years are listed because without them the model invents ids and the validator nulls every focus."
          body={answerPrompt}
        />

        <Block
          title="2b · The monument — user"
          subtitle="the visitor's transcript, verbatim"
          why="Passed through lib/guardrails' neutralisePromptInjection first. A clean utterance is unchanged; one that contains an instruction to the model is re-framed as quoted speech so the monument answers it instead of obeying it."
          body={transcript}
        />

        <Block
          title="3 · The ungrounded photograph — system"
          subtitle="sarvam-30b · max_tokens 220 · temperature 0.6 · POST /api/photo/answer"
          why="A DIFFERENT prompt from the one above, and the load-bearing part is what its signature does not have: no parameter for sources, for a name, or for history. There is no argument you could pass that would put a historical fact in front of this model. Built by ungroundedSystemPrompt in lib/userMonument.ts."
          body={ungrounded}
        />

        <header className="pt-4">
          <h2 className="text-lg font-semibold">Prompts owned by other lanes</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-white/60">
            These are string literals inside another lane&rsquo;s route file rather than exported builders, so
            they are quoted here rather than rendered. The path is given so the quote can be checked; nothing
            below has been moved.
          </p>
        </header>

        {QUOTED_ELSEWHERE.map((p) => (
          <Block key={p.title} title={p.title} subtitle={`${p.model} · ${p.path}`} why={p.why} body={p.text} />
        ))}

        {/* --- voice casting ------------------------------------------------ */}
        <header className="pt-4">
          <h2 className="text-lg font-semibold">Voice casting</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-white/60">
            From <code className="text-white/80">lib/voices.ts</code>. Speaker <em>names</em> are verified
            against three independent mirrors of Sarvam&rsquo;s docs; how any of them actually{' '}
            <em>sounds</em> is assumed, because nobody here has heard one. Model shown:{' '}
            <code className="text-white/80">{model}</code> ({model === 'bulbul:v3' ? V3_SPEAKERS.length : V2_SPEAKERS.length}{' '}
            voices, default <code className="text-white/80">{MODEL_DEFAULT_SPEAKER[model]}</code>). Override
            everything at the venue with <code className="text-white/80">SARVAM_FORCE_SPEAKER</code>.
          </p>
        </header>

        <section className="bol-glass overflow-x-auto rounded-2xl p-4 md:p-5">
          <table className="w-full min-w-[42rem] text-left text-xs">
            <thead className="text-white/50">
              <tr>
                <th className="pb-2 pr-3 font-medium">Monument</th>
                <th className="pb-2 pr-3 font-medium">Speaker</th>
                <th className="pb-2 pr-3 font-medium">Pace</th>
                <th className="pb-2 pr-3 font-medium">Intent</th>
                <th className="pb-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {castingTable(model).map((row) => (
                <tr key={row.monumentId} className={row.monumentId === monumentId ? 'bg-white/5' : ''}>
                  <td className="py-2 pr-3 text-white/80">{displayName(getMonument(row.monumentId), 'en-IN')}</td>
                  <td className="py-2 pr-3 font-mono text-white/70">{row.speaker}</td>
                  <td className="py-2 pr-3 tabular-nums text-white/70">{row.pace}</td>
                  <td className="py-2 pr-3 text-white/60">
                    {row.intent.age} · {row.intent.warmth} · {row.intent.gravity}
                  </td>
                  <td className="py-2 text-white/50">{MONUMENT_VOICES[row.monumentId]?.intent.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <footer className="pb-12 pt-2 text-xs leading-relaxed text-white/40">
          Guardrails that enforce these rules in code rather than asking for them live in{' '}
          <code>lib/guardrails.ts</code> and are documented in <code>docs/GUARDRAILS.md</code>. Run{' '}
          <code>npm run verify:guardrails</code>.
        </footer>
      </div>
    </main>
  );
}
