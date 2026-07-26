'use client';

/**
 * /debug/voice — the voice lane on a bench.
 *
 * Everything the loop can do, visible at once: the state machine, the live
 * waveform, the detected-language chip, per-stage latency against budget, the
 * raw directive, the retrieved sources with their scores, and the honest
 * fallbacks for every failure mode. There is a directive-parser playground at
 * the bottom because parseDirective runs on every single turn and is the one
 * piece worth being able to poke at by hand.
 *
 * This page is a harness, not product UI. The Stage is the integration lane's.
 */

import { useEffect, useMemo, useState } from 'react';

import { LanguageChip, LatencyHUD, MicButton, TextFallback, TranscriptRail } from '@/components/voice';
import { useVoiceLoop, type VoiceDebug } from '@/hooks/useVoiceLoop';
import { parseDirective } from '@/lib/directive';
import { getMonument } from '@/lib/monuments';

const SAMPLE_REPLY = `I was begun in 1199 by Qutb ud-Din Aibak, who raised only my first storey. My son-in-law's hand finished what his could not.
{"focus":"base","grade":"dusk","era":null}`;

export default function VoiceDebugPage() {
  const [autoVad, setAutoVad] = useState(true);
  const [bargeIn, setBargeIn] = useState(true);

  const loop = useVoiceLoop({
    monumentId: 'qutub-minar',
    autoVad,
    bargeIn,
  });

  const [dbg, setDbg] = useState<VoiceDebug | null>(null);
  // getDebug is stable; depending on `loop` would rebuild the interval every render.
  const getDebug = loop.getDebug;
  useEffect(() => {
    const id = setInterval(() => setDbg(getDebug()), 200);
    return () => clearInterval(id);
  }, [getDebug]);

  const micUsable = loop.capabilities.mic && loop.capabilities.stt;

  return (
    <main className="h-dvh overflow-y-auto bg-night-900 p-5 text-sandstone-100">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight">voice lane · debug</h1>
          <div className="flex items-center gap-3 font-mono text-[11px] text-sandstone-200/50">
            <span>session {loop.sessionId ? loop.sessionId.slice(0, 8) : '—'}</span>
            <span>
              state <b className="text-sandstone-100">{loop.state}</b>
            </span>
          </div>
        </header>

        <CapabilityBanner
          ready={loop.ready}
          capabilities={loop.capabilities}
          error={loop.error ? `${loop.error.stage}: ${loop.error.message}` : null}
        />

        {/* ---- the loop ---- */}
        <section className="grid gap-5 md:grid-cols-[auto_1fr_auto]">
          <div className="flex flex-col items-center gap-3">
            <MicButton
              state={loop.state}
              onStart={loop.start}
              onStop={loop.stop}
              getAnalyser={loop.getAnalyser}
              level={loop.level}
              disabled={!micUsable}
              size={120}
            />
            <div className="flex gap-2">
              <Toggle label="auto-VAD" on={autoVad} onChange={setAutoVad} />
              <Toggle label="barge-in" on={bargeIn} onChange={setBargeIn} />
            </div>
            <div className="flex gap-2">
              <SmallButton onClick={loop.cancel}>cancel</SmallButton>
              <SmallButton onClick={loop.reset}>reset</SmallButton>
            </div>
            {loop.needsTapToPlay ? (
              <SmallButton onClick={() => void loop.playPending()}>tap to hear the reply</SmallButton>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <LanguageChip lang={loop.lang} notice={loop.voiceNotice} />

            <TranscriptRail turns={loop.turns} limit={8} emphasiseLatestAnswer={!loop.capabilities.tts} />

            {loop.turns.length === 0 ? (
              <p className="text-xs text-sandstone-200/40">
                {loop.intro || 'Hold the mic and ask the monument something.'}
              </p>
            ) : null}

            {!micUsable && loop.ready ? (
              <TextFallback
                onSubmit={(t) => loop.submitText(t)}
                disabled={!loop.capabilities.answer}
                message={
                  !loop.capabilities.configured
                    ? 'No Sarvam key is configured, so I cannot hear you. Type instead — the answer path will tell you honestly if it is unavailable too.'
                    : 'I cannot reach your microphone. Type your question instead.'
                }
              />
            ) : null}
          </div>

          <LatencyHUD timings={loop.timings} budget={loop.budget} force />
        </section>

        {/* ---- what the turn produced ---- */}
        <section className="grid gap-4 md:grid-cols-2">
          <Panel title="directive → visual lane">
            <pre className="overflow-x-auto text-[11px] leading-relaxed text-sandstone-200/80">
              {JSON.stringify(loop.directive, null, 2)}
            </pre>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-sandstone-200/60">
              <dt>intent</dt>
              <dd className="text-sandstone-100">{loop.intent ?? '—'}</dd>
              <dt>admitted ignorance</dt>
              <dd className={loop.admittedIgnorance ? 'text-amber-300' : 'text-sandstone-100'}>
                {String(loop.admittedIgnorance)}
              </dd>
              <dt>lang</dt>
              <dd className="text-sandstone-100">{loop.lang ?? '—'}</dd>
            </dl>
          </Panel>

          <Panel title="retrieved sources">
            {loop.sources.length === 0 ? (
              <p className="text-[11px] text-sandstone-200/45">
                Nothing retrieved yet. When retrieval returns nothing at all, the monument says it does not remember
                and no model call is made.
              </p>
            ) : (
              <ol className="space-y-2 text-[11px] leading-relaxed text-sandstone-200/75">
                {loop.sources.map((s, i) => (
                  <li key={s.id}>
                    <span className="text-sandstone-300">[{i + 1}]</span> {s.text.slice(0, 180)}
                    {s.text.length > 180 ? '…' : ''}
                    <div className="text-sandstone-200/40">— {s.citation}</div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="recorder / VAD">
            {dbg ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] text-sandstone-200/60">
                <dt>mime</dt>
                <dd className="text-sandstone-100">{dbg.mime}</dd>
                <dt>recorder</dt>
                <dd className="text-sandstone-100">{dbg.recorderState}</dd>
                <dt>noise floor</dt>
                <dd className="text-sandstone-100">{dbg.noiseFloor.toFixed(4)}</dd>
                <dt>speech ≥</dt>
                <dd className="text-sandstone-100">{dbg.speechThreshold.toFixed(4)}</dd>
                <dt>barge-in ≥</dt>
                <dd className="text-sandstone-100">{dbg.bargeThreshold.toFixed(4)}</dd>
                <dt>saw speech</dt>
                <dd className="text-sandstone-100">{String(dbg.sawSpeech)}</dd>
                <dt>recording</dt>
                <dd className="text-sandstone-100">{dbg.recordingMs}ms</dd>
                <dt>turn epoch</dt>
                <dd className="text-sandstone-100">{dbg.turnEpoch}</dd>
              </dl>
            ) : null}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-sandstone-300/80 transition-[width] duration-75"
                style={{ width: `${Math.round(loop.level * 100)}%` }}
              />
            </div>
          </Panel>

          <DirectivePlayground />
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function CapabilityBanner({
  ready,
  capabilities,
  error,
}: {
  ready: boolean;
  capabilities: { mic: boolean; stt: boolean; answer: boolean; tts: boolean; configured: boolean };
  error: string | null;
}) {
  if (!ready) return <div className="bol-glass p-3 text-xs text-sandstone-200/50">starting session…</div>;

  const missing = [
    !capabilities.mic && 'microphone',
    !capabilities.stt && 'speech-to-text',
    !capabilities.answer && 'answering',
    !capabilities.tts && 'text-to-speech',
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {(['mic', 'stt', 'answer', 'tts'] as const).map((k) => (
          <span
            key={k}
            className={`bol-chip ${capabilities[k] ? 'text-emerald-200' : 'text-amber-200'}`}
          >
            {capabilities[k] ? '●' : '○'} {k}
          </span>
        ))}
      </div>
      {missing.length > 0 ? (
        <p className="bol-glass p-3 text-xs leading-relaxed text-amber-200/85">
          Unavailable: {missing.join(', ')}.{' '}
          {!capabilities.configured
            ? 'No Sarvam API key is configured in this environment, so every Sarvam-backed route answers 503 not_configured. The fallbacks below are the real degraded experience, not a mock.'
            : 'The affected steps fall back rather than failing silently.'}
        </p>
      ) : null}
      {error ? <p className="bol-glass p-3 text-xs text-amber-300">{error}</p> : null}
    </div>
  );
}

function DirectivePlayground() {
  const [raw, setRaw] = useState(SAMPLE_REPLY);
  const monument = useMemo(() => getMonument('qutub-minar'), []);
  const parsed = useMemo(() => parseDirective(raw, monument), [raw, monument]);

  return (
    <Panel title="parseDirective playground">
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={5}
        spellCheck={false}
        className="w-full resize-y rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-sandstone-100 outline-none focus:border-sandstone-300/50"
      />
      <div className="mt-2 space-y-1 text-[11px]">
        <div>
          <span className="text-sandstone-200/50">ok:</span>{' '}
          <span className={parsed.ok ? 'text-emerald-300' : 'text-amber-300'}>{String(parsed.ok)}</span>
        </div>
        <div>
          <span className="text-sandstone-200/50">spoken:</span>{' '}
          <span className="indic-text text-sandstone-100">{parsed.text || '(empty)'}</span>
        </div>
        <pre className="overflow-x-auto text-sandstone-200/80">{JSON.stringify(parsed.directive)}</pre>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-sandstone-200/40">
        Try: a ```json fence, single quotes, a trailing comma, a focus of &quot;minaret&quot; (not a region → nulled),
        a grade of &quot;sunset&quot; (invalid → nulled), an era of 1850 (no layer → nulled), or broken JSON.
      </p>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bol-glass p-3">
      <h2 className="mb-2 text-[10px] uppercase tracking-widest text-sandstone-200/45">{title}</h2>
      {children}
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
        on ? 'border-sandstone-300/50 bg-sandstone-500/25 text-sandstone-100' : 'border-white/10 bg-black/40 text-sandstone-200/45'
      }`}
    >
      {label} {on ? 'on' : 'off'}
    </button>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[10px] text-sandstone-200/70 transition-colors hover:text-sandstone-100"
    >
      {children}
    </button>
  );
}
