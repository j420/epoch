/**
 * Continuous microphone capture, cut into sentences.
 *
 * The guide never stops to let the system catch up. So we record continuously and cut
 * on natural sentence boundaries: energy-based voice activity detection, plus a 1.2s
 * silence threshold, plus a hard ceiling so a run-on sentence still ships.
 *
 * WHY ONE RECORDER PER SENTENCE, RESTARTED ON EVERY CUT
 * A MediaRecorder given a `timeslice` emits WebM fragments, and only the first one
 * carries the container header — the rest are undecodable on their own and Saaras
 * would reject them. Stopping and restarting instead yields a complete, standalone,
 * decodable blob every time. The restart costs a few milliseconds and always happens
 * during detected silence, so no speech is lost in the gap.
 *
 * The noise floor is tracked adaptively. A conference room with a projector fan has a
 * very different floor from a quiet office, and a fixed threshold that works in one
 * fails in the other.
 */

export interface ChunkMeta {
  /** Recorded length of this chunk in ms — drives Dub's duration control. */
  ms: number;
  /** Client clock at the moment of the cut, for the latency readout. */
  cutAt: number;
  index: number;
}

export interface ChunkerOptions {
  /** Silence that ends a sentence. The brief's number. */
  silenceMs?: number;
  /** Ship regardless past this, so one long sentence cannot stall the room. */
  maxChunkMs?: number;
  /** Below this, it was a cough, not a sentence. */
  minSpeechMs?: number;
  onChunk: (blob: Blob, meta: ChunkMeta) => void;
  onLevel?: (level: number, speaking: boolean) => void;
  onError?: (err: Error) => void;
  onStateChange?: (state: ChunkerState) => void;
}

export type ChunkerState = 'idle' | 'starting' | 'listening' | 'speaking' | 'stopped' | 'error';

const PREFERRED_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of PREFERRED_MIME) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* Safari has historically thrown here rather than returning false */
    }
  }
  return '';
}

export function isChunkerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator?.mediaDevices?.getUserMedia)
  );
}

export class VoiceChunker {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private buffer: Blob[] = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private samples: Float32Array | null = null;

  private running = false;
  private state: ChunkerState = 'idle';

  private noiseFloor = 0.006;
  private speaking = false;
  private hadSpeech = false;
  private speechMs = 0;
  private lastVoiceAt = 0;
  private segmentStart = 0;
  private index = 0;
  private mime = '';

  private readonly silenceMs: number;
  private readonly maxChunkMs: number;
  private readonly minSpeechMs: number;

  constructor(private readonly opts: ChunkerOptions) {
    this.silenceMs = opts.silenceMs ?? 1200;
    this.maxChunkMs = opts.maxChunkMs ?? 6500;
    this.minSpeechMs = opts.minSpeechMs ?? 450;
  }

  get currentState(): ChunkerState {
    return this.state;
  }

  private setState(next: ChunkerState) {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  /**
   * Returns the AudioContext so the caller can resume it inside the same user
   * gesture — mobile browsers start it suspended otherwise.
   */
  async start(): Promise<AudioContext> {
    if (this.running) return this.ctx!;
    this.setState('starting');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    this.source.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);

    this.mime = pickRecorderMime();
    this.running = true;
    this.resetSegment();
    this.startRecorder();

    // setInterval rather than requestAnimationFrame: rAF stops entirely when the tab
    // is backgrounded, and a guide who switches tabs must not silently stop the tour.
    this.tick = setInterval(() => this.poll(), 40);
    this.setState('listening');
    return this.ctx;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* already torn down */
    }
    this.recorder = null;
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
    this.samples = null;
    this.setState('stopped');
  }

  private resetSegment(): void {
    this.buffer = [];
    this.hadSpeech = false;
    this.speaking = false;
    this.speechMs = 0;
    this.segmentStart = performance.now();
    this.lastVoiceAt = this.segmentStart;
  }

  private startRecorder(): void {
    if (!this.running || !this.stream) return;
    try {
      const recorder = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
      this.recorder = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.buffer.push(e.data);
      };
      recorder.onstop = () => {
        const parts = this.buffer;
        const hadSpeech = this.hadSpeech;
        const speechMs = this.speechMs;
        const ms = Math.round(performance.now() - this.segmentStart);
        this.resetSegment();
        if (this.running) this.startRecorder();

        if (!hadSpeech || speechMs < this.minSpeechMs || parts.length === 0) return;
        const blob = new Blob(parts, { type: recorder.mimeType || this.mime || 'audio/webm' });
        // A blob this small holds no usable speech whatever the VAD thought.
        if (blob.size < 1200) return;
        this.opts.onChunk(blob, { ms, cutAt: Date.now(), index: this.index++ });
      };
      recorder.onerror = () => this.fail(new Error('MediaRecorder failed mid-recording'));
      recorder.start();
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private cut(): void {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    try {
      this.recorder.stop(); // onstop delivers the blob and restarts
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private fail(err: Error): void {
    this.setState('error');
    this.opts.onError?.(err);
  }

  private poll(): void {
    if (!this.running || !this.analyser || !this.samples) return;

    // TS's DOM lib types this as Float32Array<ArrayBuffer>; our buffer satisfies it.
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    const rms = Math.sqrt(sum / this.samples.length);

    // Track the room's noise floor: fall to it fast, rise away from it slowly, so a
    // long sentence never drags the floor up over the speaker's own voice.
    this.noiseFloor = rms < this.noiseFloor ? this.noiseFloor * 0.9 + rms * 0.1 : this.noiseFloor * 0.999 + rms * 0.001;

    const onset = Math.max(this.noiseFloor * 3.5, 0.012);
    const release = onset * 0.6; // hysteresis: don't flap on the tail of a word
    const now = performance.now();
    const speakingNow = this.speaking ? rms > release : rms > onset;

    if (speakingNow) {
      if (!this.speaking) this.setState('speaking');
      this.speaking = true;
      this.hadSpeech = true;
      this.speechMs += 40;
      this.lastVoiceAt = now;
    } else if (this.speaking) {
      this.speaking = false;
      this.setState('listening');
    }

    this.opts.onLevel?.(rms, speakingNow);

    if (!this.hadSpeech) {
      // Nothing said yet. Roll the recorder over occasionally so a long silence does
      // not accumulate into one enormous blob of room tone.
      if (now - this.segmentStart > this.maxChunkMs * 2) this.cut();
      return;
    }

    const silentFor = now - this.lastVoiceAt;
    const segmentFor = now - this.segmentStart;

    // The sentence ended, or it has gone on long enough that waiting costs the room
    // more than cutting mid-thought would.
    if ((!speakingNow && silentFor >= this.silenceMs) || segmentFor >= this.maxChunkMs) this.cut();
  }
}
