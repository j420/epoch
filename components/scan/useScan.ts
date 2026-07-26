'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  analyseFrame,
  createScratch,
  encodeFrame,
  frameReady,
  gate,
  verdictCopy,
  type FrameScratch,
} from './frame';
import { identifyFrame, type ScanConfidence } from './scanIdentify';

/**
 * The scanning loop: cadence, gates, caps, and the deliberate pause before the
 * visitor is sent anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHAT COSTS MONEY AND WHAT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * Measuring a frame is free — a couple of small canvas readbacks, well under a
 * millisecond. Sending one is not: it is a Sarvam Vision call plus a
 * sarvam-105b call, against an account whose rate limits are shared with
 * everyone else on the team. So the loop polls FAST and sends SLOW:
 *
 *   - a frame that fails a gate is re-examined GATE_RETRY_MS later at no cost,
 *     so "too dark" clears the instant the visitor steps into the light;
 *   - a frame that is actually SENT is followed by at least SAMPLE_INTERVAL_MS
 *     before the next send is even considered.
 *
 * The minimum interval between two uploads is therefore SAMPLE_INTERVAL_MS no
 * matter how the gates fall, and a phone lying face down on a table uploads
 * nothing at all, forever.
 *
 * ---------------------------------------------------------------------------
 * THE BEAT BEFORE NAVIGATION
 * ---------------------------------------------------------------------------
 *
 * A wrong confident match hands the visitor another building's cited history as
 * fact about the one in front of them. That is worse than no match, so:
 *
 *   - only `confidence: 'high'` ever leads anywhere on its own;
 *   - even then the loop STOPS, the name is shown, and a visible CONFIRM_MS
 *     countdown runs with a large "Not this one" beside it. Nobody is moved
 *     without first seeing where they are being moved to;
 *   - a rejected id is remembered and never offered again this session;
 *   - `confidence: 'low'` never navigates on its own. It waits for a tap.
 */

/** At most one upload every 1.8s while actively scanning. */
export const SAMPLE_INTERVAL_MS = 1800;
/** Free re-examination after a gate rejection. No network, no cost. */
export const GATE_RETRY_MS = 600;
/** Hard ceiling per scanning run, then we stop and offer the manual path. */
export const MAX_CALLS_PER_RUN = 12;
/** Ceiling across the whole page visit, however many times "scan again" is tapped. */
export const MAX_CALLS_PER_PAGE = 24;
/** How long the candidate is visible before we navigate. Long enough to say no. */
export const CONFIRM_MS = 2600;
/** After this many blurred frames in a row, the focus gate stands aside. */
const BLUR_PATIENCE = 3;
/** After this many identical frames in a row, tell the visitor nothing is changing. */
const DUPLICATE_PATIENCE = 3;

export type ScanPhase =
  | 'idle'
  /** Loop running. */
  | 'scanning'
  /** A high-confidence candidate is on screen and the countdown is running. */
  | 'confirming'
  /** Loop halted. See `stopReason`. */
  | 'stopped';

export type StopReason =
  | 'exhausted'
  | 'rate_limit'
  | 'not_configured'
  | 'fatal'
  /** A single still was identified and it was not one of the ten. */
  | 'no_match'
  /** Halted because there is nothing to look at — tab hidden, camera off. Resumable. */
  | 'paused'
  | 'manual'
  | null;

export interface Candidate {
  id: string;
  name: string;
  confidence: Exclude<ScanConfidence, 'none'>;
}

export interface UseScanOptions {
  videoRef: React.RefObject<HTMLVideoElement>;
  /** Called once the visitor has seen the candidate and not objected. */
  onMatch: (id: string) => void;
  lang?: string | null;
  sessionId?: string | null;
}

export interface ScanControls {
  phase: ScanPhase;
  stopReason: StopReason;
  /** The live line under the viewfinder. Always says something true. */
  hint: string;
  /** Something the visitor should know about. Shown, never swallowed. */
  notice: string | null;
  candidate: Candidate | null;
  /** Milliseconds left before we navigate to `candidate`. */
  confirmRemaining: number;
  /** Visual nouns from the most recent successful read. */
  looksLike: string[];
  calls: number;
  pageCalls: number;
  /** True while a frame is in flight. */
  busy: boolean;
  /** The last frame we uploaded, so the manual path is never empty-handed. */
  lastFrame: Blob | null;

  /** Begin (or resume) scanning. Safe to call twice. */
  begin: () => void;
  /** Halt the loop without a failure. */
  halt: (reason?: StopReason) => void;
  /** Identify one frame the visitor supplied (the file-picker fallback). */
  submitFrame: (blob: Blob) => Promise<void>;
  /** "Yes, that's it" on a suggestion, or "go now" on a confirmed match. */
  accept: () => void;
  /** "Not this one" — remembers the rejection and resumes scanning. */
  reject: () => void;
  /** Start a fresh run after the per-run cap was reached. */
  again: () => void;
  canScanAgain: boolean;
}

const LOOKING = 'Looking at what is in front of you…';

export function useScan({ videoRef, onMatch, lang = null, sessionId = null }: UseScanOptions): ScanControls {
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [stopReason, setStopReason] = useState<StopReason>(null);
  const [hint, setHint] = useState<string>(LOOKING);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [confirmRemaining, setConfirmRemaining] = useState(0);
  const [looksLike, setLooksLike] = useState<string[]>([]);
  const [calls, setCalls] = useState(0);
  const [pageCalls, setPageCalls] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastFrame, setLastFrame] = useState<Blob | null>(null);

  const scratchRef = useRef<FrameScratch | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  /** Latest tick, so a scheduled timeout never fires a stale closure. */
  const tickRef = useRef<() => void>(() => {});
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  const candidateRef = useRef<Candidate | null>(null);
  candidateRef.current = candidate;

  /** Mutable counters. Kept out of state so the loop never reads a stale value. */
  const countersRef = useRef({
    calls: 0,
    pageCalls: 0,
    blurRejects: 0,
    duplicates: 0,
    lastSent: null as Uint8Array | null,
    rejected: new Set<string>(),
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
  }, []);

  const schedule = useCallback(
    (ms: number) => {
      clearTimer();
      if (!runningRef.current) return;
      timerRef.current = setTimeout(() => tickRef.current(), ms);
    },
    [clearTimer],
  );

  const halt = useCallback(
    (reason: StopReason = 'manual') => {
      runningRef.current = false;
      clearTimer();
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(false);
      setPhase('stopped');
      setStopReason(reason);
    },
    [clearTimer],
  );

  /** The visible beat. Only ever started for a high-confidence candidate. */
  const startCountdown = useCallback(
    (id: string) => {
      clearCountdown();
      const deadline = Date.now() + CONFIRM_MS;
      setConfirmRemaining(CONFIRM_MS);
      countdownRef.current = setInterval(() => {
        const left = deadline - Date.now();
        if (left > 0) {
          setConfirmRemaining(left);
          return;
        }
        clearCountdown();
        setConfirmRemaining(0);
        onMatchRef.current(id);
      }, 100);
    },
    [clearCountdown],
  );

  // -------------------------------------------------------------------------
  // The one place a frame is actually uploaded
  // -------------------------------------------------------------------------

  /**
   * 'matched'   high confidence — the loop stopped itself and the countdown runs
   * 'suggested' low confidence — a candidate is on screen, awaiting a tap
   * 'continue'  nothing found, carry on
   * 'stopped'   halted, by a failure or by the visitor
   *
   * Returned rather than read back off `candidate` state, because state set
   * inside this function is not visible to its own caller until React
   * re-renders — and the caller runs on the very next line.
   */
  type SendResult = 'matched' | 'suggested' | 'continue' | 'stopped';

  const send = useCallback(
    async (blob: Blob): Promise<SendResult> => {
      const counters = countersRef.current;
      counters.calls += 1;
      counters.pageCalls += 1;
      setCalls(counters.calls);
      setPageCalls(counters.pageCalls);
      setLastFrame(blob);
      setBusy(true);
      setHint(LOOKING);

      const controller = new AbortController();
      abortRef.current = controller;
      const outcome = await identifyFrame(blob, { lang, sessionId, signal: controller.signal });
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);

      // halt() aborted us mid-flight — the visitor has moved on.
      if (controller.signal.aborted) return 'stopped';

      // --- failures that must not be retried -------------------------------
      if (outcome.notConfigured || outcome.fatal) {
        setNotice(outcome.error);
        halt(outcome.notConfigured ? 'not_configured' : 'fatal');
        return 'stopped';
      }
      if (outcome.rateLimited) {
        setNotice(outcome.error);
        halt('rate_limit');
        return 'stopped';
      }

      if (outcome.error) {
        // Transient: a timeout, a dropped connection, a frame Vision could not
        // read. Say it, keep going, and let the cap bound the damage.
        setHint(outcome.error);
      } else if (outcome.looksLike.length) {
        setLooksLike(outcome.looksLike);
      }

      const id = outcome.matchedMonumentId;
      if (id && !counters.rejected.has(id) && outcome.confidence !== 'none') {
        const next: Candidate = {
          id,
          name: outcome.name ?? id.replace(/-/g, ' '),
          confidence: outcome.confidence,
        };
        setCandidate(next);

        if (outcome.confidence === 'high') {
          // Matched. Stop scanning entirely — no further calls.
          runningRef.current = false;
          clearTimer();
          setPhase('confirming');
          startCountdown(next.id);
          return 'matched';
        }
        setHint(`This might be ${next.name}. Hold it in frame, or tap to go there.`);
        return 'suggested';
      }

      if (!outcome.error) {
        setHint(
          counters.calls === 1
            ? 'Not one of the ten yet. Get the whole building in the frame.'
            : 'Still not one of the ten. Step back, or try a different side of it.',
        );
      }
      return 'continue';
    },
    [clearTimer, halt, lang, sessionId, startCountdown],
  );

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  const tick = useCallback(async () => {
    if (!runningRef.current) return;
    const counters = countersRef.current;

    const video = videoRef.current;
    if (!frameReady(video)) {
      setHint('Waking the camera…');
      schedule(GATE_RETRY_MS);
      return;
    }

    if (!scratchRef.current) scratchRef.current = createScratch();
    const scratch = scratchRef.current;

    // --- free gates --------------------------------------------------------
    const stats = analyseFrame(video, scratch);
    const verdict = gate(stats, {
      lastSent: counters.lastSent,
      ignoreBlur: counters.blurRejects >= BLUR_PATIENCE,
    });

    if (verdict !== 'ok') {
      counters.blurRejects = verdict === 'blurry' ? counters.blurRejects + 1 : 0;
      counters.duplicates = verdict === 'duplicate' ? counters.duplicates + 1 : 0;

      if (verdict === 'duplicate') {
        // Not a fault — a still phone is doing the right thing and costing us
        // nothing. Only speak up once it is clear nothing is going to change.
        if (counters.duplicates >= DUPLICATE_PATIENCE) {
          setHint('Nothing new in the frame — move the camera a little, or step back.');
        }
      } else {
        setHint(verdictCopy(verdict) ?? LOOKING);
      }
      schedule(GATE_RETRY_MS);
      return;
    }

    counters.blurRejects = 0;
    counters.duplicates = 0;

    // --- the only expensive branch -----------------------------------------
    const blob = await encodeFrame(video, scratch);
    if (!blob) {
      schedule(GATE_RETRY_MS);
      return;
    }
    if (!runningRef.current) return;

    // The signature of what we SENT, not of what we last looked at — so a slow
    // pan accumulates change until it is genuinely a different view.
    if (stats) counters.lastSent = stats.signature;

    const result = await send(blob);
    // 'suggested' keeps scanning: a low-confidence guess is a reason to look
    // harder, not a reason to stop.
    if (result === 'matched' || result === 'stopped' || !runningRef.current) return;

    if (counters.calls >= MAX_CALLS_PER_RUN) {
      halt('exhausted');
      return;
    }
    schedule(SAMPLE_INTERVAL_MS);
  }, [halt, schedule, send, videoRef]);

  useEffect(() => {
    tickRef.current = () => {
      void tick();
    };
  }, [tick]);

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  const begin = useCallback(() => {
    if (runningRef.current) return;
    if (countersRef.current.pageCalls >= MAX_CALLS_PER_PAGE) {
      halt('exhausted');
      return;
    }
    runningRef.current = true;
    setPhase('scanning');
    setStopReason(null);
    setNotice(null);
    setHint(LOOKING);
    schedule(0);
  }, [halt, schedule]);

  /**
   * One identification from a still the visitor supplied — the path taken when
   * the live camera was refused or does not exist. Same pipeline, same caps,
   * same confirmation beat.
   */
  const submitFrame = useCallback(
    async (blob: Blob) => {
      if (countersRef.current.pageCalls >= MAX_CALLS_PER_PAGE) {
        halt('exhausted');
        return;
      }
      runningRef.current = false;
      clearTimer();
      clearCountdown();
      setCandidate(null);
      setNotice(null);
      setStopReason(null);
      setPhase('scanning');

      const result = await send(blob);
      if (result === 'matched' || result === 'stopped') return;
      // A still has no second chance — there is no live frame coming. Land on a
      // definite outcome rather than on an idle spinner. 'manual' (not 'paused')
      // so nothing auto-resumes a loop that has no camera behind it.
      halt(result === 'suggested' ? 'manual' : 'no_match');
    },
    [clearCountdown, clearTimer, halt, send],
  );

  const accept = useCallback(() => {
    const id = candidateRef.current?.id;
    if (!id) return;
    runningRef.current = false;
    clearCountdown();
    clearTimer();
    abortRef.current?.abort();
    abortRef.current = null;
    onMatchRef.current(id);
  }, [clearCountdown, clearTimer]);

  const reject = useCallback(() => {
    const id = candidateRef.current?.id;
    clearCountdown();
    setConfirmRemaining(0);
    if (id) countersRef.current.rejected.add(id);
    setCandidate(null);
    setHint('Alright — still looking.');

    if (
      countersRef.current.calls >= MAX_CALLS_PER_RUN ||
      countersRef.current.pageCalls >= MAX_CALLS_PER_PAGE
    ) {
      halt('exhausted');
      return;
    }
    runningRef.current = true;
    setPhase('scanning');
    setStopReason(null);
    schedule(SAMPLE_INTERVAL_MS);
  }, [clearCountdown, halt, schedule]);

  const again = useCallback(() => {
    if (countersRef.current.pageCalls >= MAX_CALLS_PER_PAGE) return;
    countersRef.current.calls = 0;
    countersRef.current.blurRejects = 0;
    countersRef.current.duplicates = 0;
    countersRef.current.lastSent = null;
    setCalls(0);
    setNotice(null);
    setCandidate(null);
    begin();
  }, [begin]);

  // -------------------------------------------------------------------------
  // Teardown — timers and any in-flight request die with the component.
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return {
    phase,
    stopReason,
    hint,
    notice,
    candidate,
    confirmRemaining,
    looksLike,
    calls,
    pageCalls,
    busy,
    lastFrame,
    begin,
    halt,
    submitFrame,
    accept,
    reject,
    again,
    canScanAgain: pageCalls < MAX_CALLS_PER_PAGE,
  };
}
