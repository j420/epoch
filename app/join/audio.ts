/**
 * One unlocked <audio> element, for the whole session.
 *
 * THE PROBLEM
 * Mobile browsers refuse `play()` unless it descends from a user gesture. A listener's
 * audio arrives seconds later, over SSE, with no gesture anywhere near it. Create a
 * fresh Audio object per chunk and every single one is rejected: the tour is silent
 * and nothing in the console explains why.
 *
 * THE FIX
 * Browsers grant the permission to the *element*, not to the call. So we create ONE
 * element and activate it inside a real gesture by playing a few milliseconds of
 * digital silence. From then on that element may be re-`src`-ed and re-`play()`-ed
 * freely, forever, with no further gestures. Every chunk queues into it.
 *
 * The gesture we use is the listener tapping "speak one sentence" on the join screen —
 * a tap they have to make anyway, before any audio could possibly arrive. `unlock()`
 * must therefore be called on the *synchronous* path of that handler: one `await`
 * before it and the browser no longer considers it gesture-driven.
 *
 * The element is also parked in the DOM rather than kept as a detached object, because
 * Safari has historically been unreliable about playing detached media elements.
 */

/** 8 samples of 8kHz 8-bit silence. The smallest thing that is still a valid WAV. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==';

export interface QueuedClip {
  seq: number;
  url: string;
}

export interface AudioQueueEvents {
  onPlay?: (seq: number) => void;
  onIdle?: () => void;
  onDepth?: (depth: number) => void;
  /** Fired when a clip could not be decoded — the UI still shows the text. */
  onClipError?: (seq: number) => void;
}

export class UnlockedAudioQueue {
  private el: HTMLAudioElement | null = null;
  private queue: QueuedClip[] = [];
  private playing = false;
  private unlocked = false;
  private disposed = false;

  constructor(private readonly events: AudioQueueEvents = {}) {}

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  get depth(): number {
    return this.queue.length + (this.playing ? 1 : 0);
  }

  /**
   * Call this on the synchronous path of a click/touch handler. Do not await
   * anything first.
   */
  unlock(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.unlocked) return Promise.resolve(true);

    const el = this.ensureElement();
    el.src = SILENT_WAV;
    el.muted = false;
    el.volume = 1;

    const attempt = el.play();
    if (!attempt) {
      // Older browsers return void from play() and simply do it.
      this.unlocked = true;
      return Promise.resolve(true);
    }
    return attempt
      .then(() => {
        this.unlocked = true;
        return true;
      })
      .catch(() => {
        // Rejected: the gesture was lost, or the browser is unusually strict. Keep the
        // element — a later gesture can retry — and let the UI offer a tap-to-hear.
        this.unlocked = false;
        return false;
      });
  }

  private ensureElement(): HTMLAudioElement {
    if (this.el) return this.el;
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.autoplay = false;
    el.controls = false;
    // iOS refuses inline playback without this and will try to go fullscreen.
    el.setAttribute('playsinline', '');
    (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    // Present in the document, but invisible. `display:none` can suspend media on
    // some engines, so it is sized away instead.
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';

    el.addEventListener('ended', () => this.advance());
    el.addEventListener('error', () => {
      const current = this.currentSeq;
      if (current !== null) this.events.onClipError?.(current);
      this.advance();
    });

    document.body.appendChild(el);
    this.el = el;
    return el;
  }

  private currentSeq: number | null = null;

  /** Queue a chunk. Safe to call before `unlock()` — it simply waits. */
  enqueue(clip: QueuedClip): void {
    if (this.disposed) return;
    if (this.queue.some((c) => c.seq === clip.seq)) return; // reconnect replay
    this.queue.push(clip);
    this.queue.sort((a, b) => a.seq - b.seq);
    this.events.onDepth?.(this.depth);
    if (!this.playing) this.advance();
  }

  /**
   * Called after a later user gesture when the first unlock was refused. Drains
   * whatever piled up in the meantime.
   */
  retryUnlock(): Promise<boolean> {
    return this.unlock().then((ok) => {
      if (ok && !this.playing) this.advance();
      return ok;
    });
  }

  private advance(): void {
    if (this.disposed) return;
    const next = this.queue.shift();
    this.events.onDepth?.(this.depth);

    if (!next) {
      this.playing = false;
      this.currentSeq = null;
      this.events.onIdle?.();
      return;
    }

    const el = this.ensureElement();
    this.playing = true;
    this.currentSeq = next.seq;
    el.src = next.url;

    const attempt = el.play();
    this.events.onPlay?.(next.seq);
    if (attempt) {
      attempt.catch(() => {
        // Most likely the element was never successfully unlocked. Put the clip back
        // so a retry after the next gesture plays it rather than losing it.
        this.playing = false;
        this.unlocked = false;
        this.queue.unshift(next);
        this.events.onDepth?.(this.depth);
      });
    }
  }

  /** Drop anything not yet played — used when the tour ends. */
  clear(): void {
    this.queue = [];
    this.events.onDepth?.(this.depth);
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    if (this.el) {
      try {
        this.el.pause();
        this.el.removeAttribute('src');
        this.el.load();
        this.el.remove();
      } catch {
        /* teardown is best effort */
      }
      this.el = null;
    }
  }
}
