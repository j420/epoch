import type { Cue, Grade, LivingPhotoHandle, VisualDirective, VoiceState } from './types';
import type { Monument } from './types';

/**
 * The director.
 *
 * This is the piece that makes Bol feel like a directed short film rather than a
 * chatbot with wallpaper. It sits between the voice loop and the Living Photograph
 * engine and owns every decision about where the camera looks and how the light
 * falls, so neither of those two modules has to know about the other.
 *
 * Three jobs:
 *   1. Apply a VisualDirective emitted by the monument's answer.
 *   2. Map the voice state machine onto camera behaviour (the world "listens").
 *   3. Drive a timestamped cue track off an <audio> element for pre-rendered narration.
 *
 * Everything here degrades to a no-op if the engine handle is absent — the visual
 * layer failing must never take the conversation down with it.
 */

export interface DirectorOptions {
  /** Camera glide to a focused region. The brief specifies 2.4s. */
  focusMs?: number;
  /** Colour grade transition. The brief specifies 3s. */
  gradeMs?: number;
  /** Archival crossfade. The brief specifies 1.8s. */
  eraMs?: number;
  /** How long an era layer is held before returning, when we cannot infer it from audio. */
  eraHoldMs?: number;
  /** Idle Ken Burns push. */
  driftAmount?: number;
  driftMs?: number;
  /** Idle micro-orbit, so the image is never completely dead. */
  orbitAmplitude?: number;
  onError?: (err: Error) => void;
}

const DEFAULTS: Required<Omit<DirectorOptions, 'onError'>> = {
  focusMs: 2400,
  gradeMs: 3000,
  eraMs: 1800,
  eraHoldMs: 6000,
  driftAmount: 0.12,
  driftMs: 8000,
  orbitAmplitude: 0.03,
};

export class Director {
  private handle: LivingPhotoHandle | null = null;
  private monument: Monument | null = null;
  private opts: Required<Omit<DirectorOptions, 'onError'>>;
  private onError?: (err: Error) => void;

  private eraTimer: ReturnType<typeof setTimeout> | null = null;
  private currentEra: string | null = null;
  private currentGrade: Grade = 'noon';
  private baseGrade: Grade = 'noon';
  private state: VoiceState = 'idle';
  private disposed = false;

  // Cue-track state
  private audio: HTMLAudioElement | null = null;
  private cues: Cue[] = [];
  private nextCue = 0;
  private onTimeUpdate: (() => void) | null = null;
  private onSeeked: (() => void) | null = null;

  constructor(options: DirectorOptions = {}) {
    const { onError, ...rest } = options;
    this.opts = { ...DEFAULTS, ...rest };
    this.onError = onError;
  }

  /** Called once the engine has mounted and reported ready. Safe to call again on remount. */
  attach(handle: LivingPhotoHandle | null, monument: Monument | null) {
    this.handle = handle;
    this.monument = monument;
    if (handle) this.idle();
  }

  detach() {
    this.clearEraTimer();
    this.unbindCues();
    this.handle = null;
  }

  dispose() {
    this.disposed = true;
    this.detach();
  }

  /** Every call into the engine goes through here so one bad frame cannot kill the app. */
  private safe(fn: (h: LivingPhotoHandle) => void) {
    if (this.disposed || !this.handle) return;
    try {
      fn(this.handle);
    } catch (err) {
      this.onError?.(err as Error);
      console.warn('[director] visual command failed:', (err as Error).message);
    }
  }

  private clearEraTimer() {
    if (this.eraTimer) {
      clearTimeout(this.eraTimer);
      this.eraTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Directive application
  // -------------------------------------------------------------------------

  /**
   * Apply a directive parsed off the end of the monument's answer.
   *
   * `audioDurationMs` lets an era layer be held for exactly as long as the sentence
   * that mentions it is playing, then returned — which is what the brief asks for.
   * Without it we fall back to a fixed hold.
   */
  apply(directive: VisualDirective | null | undefined, audioDurationMs?: number) {
    if (!directive) return;

    // --- focus: glide to the region and softly spotlight it ---
    if (directive.focus) {
      const valid = this.monument?.regions.some((r) => r.id === directive.focus);
      if (valid) {
        this.safe((h) => {
          h.to(directive.focus!, { duration: this.opts.focusMs, ease: 'easeInOutCubic' });
          h.focus(directive.focus!, 0.42);
        });
      } else {
        // The model named a region we do not have. Ignore it rather than jumping
        // somewhere arbitrary — a wrong camera move reads as a bug, no move reads as calm.
        console.warn(`[director] unknown region "${directive.focus}" — ignoring focus`);
      }
    } else {
      this.safe((h) => h.focus(null));
    }

    // --- grade: time of day ---
    if (directive.grade) {
      this.currentGrade = directive.grade;
      // A grade the monument chose becomes the new resting state, so the scene does
      // not snap back to noon the moment the answer ends. Sepia is the exception:
      // it belongs to a memory playing, not to the time of day.
      if (directive.grade !== 'sepia') this.baseGrade = directive.grade;
      this.safe((h) => h.grade(directive.grade!, this.opts.gradeMs));
    }

    // --- era: crossfade to the archival layer, hold, return ---
    if (directive.era) {
      const known = this.monument?.eras?.some((e) => e.year === directive.era);
      if (known) {
        this.clearEraTimer();
        this.currentEra = directive.era;
        this.safe((h) => h.era(directive.era!, this.opts.eraMs));

        // Hold for the length of the audio (minus the two crossfades) so we return
        // as the sentence lands, not arbitrarily mid-thought.
        const hold = audioDurationMs
          ? Math.max(this.opts.eraMs, audioDurationMs - this.opts.eraMs)
          : this.opts.eraHoldMs;

        this.eraTimer = setTimeout(() => {
          this.currentEra = null;
          this.safe((h) => h.era(null, this.opts.eraMs));
          this.eraTimer = null;
        }, hold);
      } else {
        console.warn(`[director] unknown era "${directive.era}" — ignoring`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Voice state -> camera behaviour
  // -------------------------------------------------------------------------

  /**
   * "While the visitor is speaking, pull back slightly and desaturate a touch, so the
   * world listens. Restore when the monument answers. This tiny detail sells the
   * interaction." — it really does, and it costs almost nothing.
   */
  setVoiceState(next: VoiceState) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;

    switch (next) {
      case 'listening':
        this.safe((h) => h.listening(true));
        break;

      case 'thinking':
        // Stay pulled back through thinking: the visitor has stopped talking but the
        // monument has not begun. Snapping forward here would feel like an interruption.
        break;

      case 'speaking':
        this.safe((h) => h.listening(false));
        break;

      case 'idle':
        this.safe((h) => h.listening(false));
        this.idle();
        break;

      case 'error':
        this.safe((h) => {
          h.listening(false);
          h.focus(null);
        });
        break;
    }

    if (prev === 'speaking' && next === 'idle') this.releaseFocus();
  }

  /** Between turns the image must never sit dead still. */
  idle() {
    this.safe((h) => {
      h.driftIn({ amount: this.opts.driftAmount, duration: this.opts.driftMs });
      h.orbitMicro({ amplitude: this.opts.orbitAmplitude });
    });
  }

  /** Let a spotlight go without disturbing the grade or the era. */
  releaseFocus() {
    this.safe((h) => h.focus(null));
  }

  /** A memory is playing: warm sepia, and slow the drift right down so the image remembers too. */
  enterMemoryMode() {
    this.safe((h) => {
      h.grade('sepia', 2200);
      h.driftIn({ amount: 0.04, duration: 16000 });
      h.orbitMicro({ amplitude: 0.012 });
    });
  }

  exitMemoryMode() {
    this.safe((h) => {
      h.grade(this.baseGrade, 2200);
      h.driftIn({ amount: this.opts.driftAmount, duration: this.opts.driftMs });
      h.orbitMicro({ amplitude: this.opts.orbitAmplitude });
    });
  }

  reset() {
    this.clearEraTimer();
    this.unbindCues();
    this.currentEra = null;
    this.currentGrade = 'noon';
    this.baseGrade = 'noon';
    this.state = 'idle';
    this.safe((h) => h.reset());
    this.idle();
  }

  get snapshot() {
    return { state: this.state, grade: this.currentGrade, baseGrade: this.baseGrade, era: this.currentEra };
  }

  // -------------------------------------------------------------------------
  // Cue tracks — pre-rendered narration becomes a directed short film
  // -------------------------------------------------------------------------

  /**
   * Bind a cue track to an audio element. Cues fire off `timeupdate`, which browsers
   * emit roughly every 250ms — plenty for camera moves measured in seconds, and far
   * cheaper than a rAF loop polling currentTime.
   *
   * Seeking is handled explicitly: on a seek we rebuild the cursor and re-apply the
   * most recent cue at or before the new position, so scrubbing in /debug/cue lands
   * the scene in the state that moment should be in rather than leaving it stale.
   */
  bindCues(audio: HTMLAudioElement, cues: Cue[]) {
    this.unbindCues();
    this.audio = audio;
    this.cues = [...cues].sort((a, b) => a.t - b.t);
    this.nextCue = 0;

    this.onTimeUpdate = () => {
      const t = audio.currentTime;
      while (this.nextCue < this.cues.length && this.cues[this.nextCue].t <= t) {
        this.applyCue(this.cues[this.nextCue]);
        this.nextCue++;
      }
    };

    this.onSeeked = () => {
      const t = audio.currentTime;
      let last: Cue | null = null;
      this.nextCue = 0;
      for (let i = 0; i < this.cues.length; i++) {
        if (this.cues[i].t <= t) {
          last = this.cues[i];
          this.nextCue = i + 1;
        } else break;
      }
      // Snap rather than glide — a scrub should land instantly.
      if (last) this.applyCue(last, 0);
    };

    audio.addEventListener('timeupdate', this.onTimeUpdate);
    audio.addEventListener('seeked', this.onSeeked);
  }

  unbindCues() {
    if (this.audio) {
      if (this.onTimeUpdate) this.audio.removeEventListener('timeupdate', this.onTimeUpdate);
      if (this.onSeeked) this.audio.removeEventListener('seeked', this.onSeeked);
    }
    this.audio = null;
    this.onTimeUpdate = null;
    this.onSeeked = null;
    this.cues = [];
    this.nextCue = 0;
  }

  private applyCue(cue: Cue, overrideMs?: number) {
    const snap = overrideMs === 0;
    if (cue.focus !== undefined) {
      if (cue.focus) {
        this.safe((h) => {
          h.to(cue.focus!, { duration: snap ? 0 : this.opts.focusMs, ease: 'easeInOutCubic' });
          h.focus(cue.focus!, 0.42);
        });
      } else {
        this.safe((h) => h.focus(null));
      }
    }
    if (cue.grade) {
      this.currentGrade = cue.grade;
      this.safe((h) => h.grade(cue.grade!, snap ? 0 : this.opts.gradeMs));
    }
    if (cue.era !== undefined) {
      const era = cue.era ?? null;
      this.currentEra = era;
      this.safe((h) => h.era(era, snap ? 0 : this.opts.eraMs));
    }
  }
}

/** Serialise a cue track for storage next to a narration audio file. */
export function serializeCues(cues: Cue[]): string {
  return JSON.stringify(
    [...cues].sort((a, b) => a.t - b.t).map((c) => ({ t: Number(c.t.toFixed(2)), focus: c.focus ?? null, grade: c.grade ?? null, era: c.era ?? null })),
    null,
    2,
  );
}

export function parseCues(raw: string): Cue[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => typeof c?.t === 'number' && Number.isFinite(c.t))
      .map((c) => ({ t: c.t, focus: c.focus ?? null, grade: c.grade ?? null, era: c.era ?? null }))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}
