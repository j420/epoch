'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import LivingPhoto from '@/components/LivingPhoto';
import type { LivingPhotoHandle, LivingPhotoStatus } from '@/components/LivingPhoto/types';
import { getMonument, regionLabel } from '@/lib/monuments';
import { GRADES, GRADE_IDS, GRADE_SATURATION } from '@/lib/grades';
import { clearDepthCache } from '@/lib/depth';
import type { Grade } from '@/lib/types';

/**
 * /debug/photo — the visual lane's bench.
 *
 * Everything the shader and the rig expose, on one screen, so the look can be
 * tuned against the real photograph instead of against a guess.
 *
 * Query-param presets, so any state can be screenshotted headlessly:
 *   /debug/photo?bare=1&grade=dusk&era=1900&focus=dome&to=dome&depth=0.5
 * `bare=1` hides the panel, which is the only way to judge the actual frame.
 */
function readParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export default function PhotoDebugPage() {
  const monument = useMemo(() => getMonument(), []);
  const photo = useRef<LivingPhotoHandle>(null);
  const params = useMemo(readParams, []);

  const [depthScale, setDepthScale] = useState(() => {
    const v = Number(params.get('depth'));
    return Number.isFinite(v) && v > 0 ? v : 0.35;
  });
  const [vignette, setVignette] = useState(0.35);
  const [edgeThreshold, setEdgeThreshold] = useState(0.06);
  const [focusRadius, setFocusRadius] = useState(0.26);
  const [grade, setGrade] = useState<Grade>('noon');
  const [focused, setFocused] = useState<string | null>(null);
  const [era, setEra] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [atmosphere, setAtmosphere] = useState(true);
  const [allowCompute, setAllowCompute] = useState(true);
  const [status, setStatus] = useState<LivingPhotoStatus | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(() => params.get('bare') !== '1');

  const presetApplied = useRef(false);

  // Wait for the depth map, not just the photograph: `to()` aims at the real
  // displaced surface, and firing it before the depth lands would frame the
  // flat plane instead.
  const applyPreset = useCallback(() => {
    if (presetApplied.current) return;
    presetApplied.current = true;
    const g = params.get('grade');
    if (g && (GRADE_IDS as string[]).includes(g)) {
      setGrade(g as Grade);
      photo.current?.grade(g as Grade, 0);
    }
    const e = params.get('era');
    if (e) {
      setEra(e);
      photo.current?.era(e, 0);
    }
    const f = params.get('focus');
    if (f) {
      setFocused(f);
      photo.current?.focus(f, focusRadius);
    }
    const t = params.get('to');
    if (t) photo.current?.to(t, { duration: 0 });
    if (params.get('listening') === '1') {
      setListening(true);
      photo.current?.listening(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const onStatus = useCallback(
    (s: LivingPhotoStatus) => {
      setStatus(s);
      if (s.ready && (s.depthPhase === 'done' || s.depthPhase === 'unavailable')) applyPreset();
    },
    // applyPreset is stable and self-guarding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const onError = useCallback((e: Error) => {
    setErrors((prev) => (prev.includes(e.message) ? prev : [...prev.slice(-4), e.message]));
  }, []);

  const regions = monument.regions;
  const eras = monument.eras ?? [];

  const applyFocus = (id: string | null, radius = focusRadius) => {
    setFocused(id);
    photo.current?.focus(id, radius);
  };

  return (
    <main className="fixed inset-0 overflow-hidden bg-night-950">
      <LivingPhoto
        // Both of these are construction-time decisions in the scene, so force a
        // clean rebuild rather than pretending they can change live.
        key={`${atmosphere}-${allowCompute}`}
        ref={photo}
        monument={monument}
        depthScale={depthScale}
        vignette={vignette}
        edgeThreshold={edgeThreshold}
        atmosphere={atmosphere}
        allowDepthCompute={allowCompute}
        initialGrade="noon"
        onStatus={onStatus}
        onError={onError}
        className="absolute inset-0 h-full w-full overflow-hidden bg-night-900"
      />

      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className="bol-chip absolute right-3 top-3 z-20"
      >
        {panelOpen ? 'hide' : 'debug'}
      </button>

      {panelOpen && (
        <div className="bol-glass absolute bottom-3 left-3 top-3 z-10 w-[19rem] max-w-[86vw] overflow-y-auto p-4 text-xs text-sandstone-100">
          <h1 className="mb-3 text-sm font-semibold tracking-wide">LivingPhoto bench</h1>

          <Readout status={status} />

          <Section title="geometry">
            <Slider
              label="depthScale"
              value={depthScale}
              min={0}
              max={0.9}
              step={0.005}
              onChange={setDepthScale}
            />
            <Slider
              label="edge discard"
              value={edgeThreshold}
              min={0.01}
              max={0.5}
              step={0.005}
              onChange={setEdgeThreshold}
            />
            <p className="mt-1 text-[10px] leading-snug text-sandstone-200/60">
              Lower discard = more silhouette fragments dropped. Push depthScale up to see the
              stretching it is suppressing.
            </p>
          </Section>

          <Section title="grade">
            <div className="flex flex-wrap gap-1.5">
              {GRADE_IDS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => {
                    setGrade(g);
                    photo.current?.grade(g, 1200);
                  }}
                  className={chip(grade === g)}
                >
                  {g}
                </button>
              ))}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-2 text-[10px] text-sandstone-200/70">
              <dt>tint</dt>
              <dd className="text-right tabular-nums">
                {GRADES[grade].tint.map((v) => v.toFixed(2)).join(' / ')}
              </dd>
              <dt>lift</dt>
              <dd className="text-right tabular-nums">{GRADES[grade].lift.toFixed(2)}</dd>
              <dt>brightness</dt>
              <dd className="text-right tabular-nums">{GRADES[grade].brightness.toFixed(2)}</dd>
              <dt>saturation</dt>
              <dd className="text-right tabular-nums">{GRADE_SATURATION[grade].toFixed(2)}</dd>
            </dl>
            <Slider
              label="vignette"
              value={vignette}
              min={0}
              max={1}
              step={0.01}
              onChange={setVignette}
            />
          </Section>

          <Section title="camera">
            <div className="flex flex-wrap gap-1.5">
              {regions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => photo.current?.to(r.id, { duration: 2400, ease: 'easeInOutCubic' })}
                  title={`${regionLabel(r, 'en-IN')} — z ${r.z}`}
                  className={chip(false)}
                >
                  {r.id}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className={chip(false)}
                onClick={() => photo.current?.driftIn({ amount: 0.12, duration: 8000 })}
              >
                driftIn
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() => photo.current?.driftIn({ amount: 0.3, duration: 5000 })}
              >
                drift hard
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() => photo.current?.orbitMicro({ amplitude: 0.03 })}
              >
                orbit
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() => photo.current?.orbitMicro({ amplitude: 0 })}
              >
                orbit off
              </button>
            </div>
          </Section>

          <Section title="focus">
            <Slider
              label="radius"
              value={focusRadius}
              min={0.05}
              max={0.9}
              step={0.01}
              onChange={(v) => {
                setFocusRadius(v);
                if (focused) photo.current?.focus(focused, v);
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={chip(focused === null)} onClick={() => applyFocus(null)}>
                none
              </button>
              {regions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={chip(focused === r.id)}
                  onClick={() => applyFocus(r.id)}
                >
                  {r.id}
                </button>
              ))}
            </div>
          </Section>

          <Section title="time travel">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={chip(era === null)}
                onClick={() => {
                  setEra(null);
                  photo.current?.era(null, 1800);
                }}
              >
                present
              </button>
              {eras.map((e) => (
                <button
                  key={e.year}
                  type="button"
                  className={chip(era === e.year)}
                  onClick={() => {
                    setEra(e.year);
                    photo.current?.era(e.year, 1800);
                  }}
                >
                  {e.year}
                </button>
              ))}
            </div>
            {eras.length === 0 && (
              <p className="mt-1 text-[10px] text-sandstone-200/60">No era layers in this monument.</p>
            )}
          </Section>

          <Section title="state">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={chip(listening)}
                onClick={() => {
                  const next = !listening;
                  setListening(next);
                  photo.current?.listening(next);
                }}
              >
                listening
              </button>
              <button type="button" className={chip(atmosphere)} onClick={() => setAtmosphere((v) => !v)}>
                atmosphere
              </button>
              <button
                type="button"
                className={chip(allowCompute)}
                onClick={() => setAllowCompute((v) => !v)}
              >
                in-browser depth
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() => {
                  setGrade('noon');
                  setFocused(null);
                  setEra(null);
                  setListening(false);
                  photo.current?.reset();
                }}
              >
                reset
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() => {
                  void clearDepthCache();
                  setErrors((p) => [...p.slice(-4), 'depth cache cleared — reload to recompute']);
                }}
              >
                clear depth cache
              </button>
            </div>
            <p className="mt-1 text-[10px] leading-snug text-sandstone-200/60">
              Toggling atmosphere or in-browser depth rebuilds the GL context.
            </p>
          </Section>

          {errors.length > 0 && (
            <Section title="errors">
              <ul className="space-y-1 text-[10px] leading-snug text-sandstone-300">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Section>
          )}

          <p className="mt-4 text-[10px] leading-snug text-sandstone-200/50">{monument.credit}</p>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small local controls. Deliberately unstyled-ish: this route is a bench, not UI.
// ---------------------------------------------------------------------------

function chip(active: boolean): string {
  return [
    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
    active
      ? 'border-sandstone-300/70 bg-sandstone-500/30 text-sandstone-50'
      : 'border-white/15 bg-black/30 text-sandstone-200 hover:border-sandstone-300/50',
  ].join(' ');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-white/10 pt-3">
      <h2 className="mb-2 text-[10px] uppercase tracking-[0.18em] text-sandstone-200/60">{title}</h2>
      {children}
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="mb-2 block">
      <span className="flex items-baseline justify-between">
        <span className="text-[11px] text-sandstone-200">{label}</span>
        <span className="tabular-nums text-[11px] text-sandstone-300">{value.toFixed(3)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-sandstone-300"
      />
    </label>
  );
}

function Readout({ status }: { status: LivingPhotoStatus | null }) {
  if (!status) {
    return <p className="text-[10px] text-sandstone-200/60">starting…</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-sandstone-200/75">
      <dt>fps</dt>
      <dd className="text-right tabular-nums">{status.fps}</dd>
      <dt>depth source</dt>
      <dd className="text-right">{status.depthSource}</dd>
      <dt>depth phase</dt>
      <dd className="text-right">{status.depthPhase}</dd>
      <dt>pixel ratio</dt>
      <dd className="text-right tabular-nums">{status.pixelRatio.toFixed(2)}</dd>
      <dt>motes</dt>
      <dd className="text-right tabular-nums">{status.moteCount}</dd>
      <dt>reduced motion</dt>
      <dd className="text-right">{status.reducedMotion ? 'yes' : 'no'}</dd>
      <dt>webgl</dt>
      <dd className="text-right">{status.webgl ? 'ok' : 'lost'}</dd>
    </dl>
  );
}
