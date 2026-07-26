'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The retrieve half of the echo wall: one memory, played back with its attribution.
 *
 * Three sources of sound, tried in order, and the visitor is always told which one
 * they got:
 *
 *   1. `playbackUrl` — the ORIGINAL recording. Only ever present when the listener
 *      shares the speaker's language, because a voice you cannot understand is not
 *      a memory, it is noise. This is the good case and it is marked as such.
 *   2. Bulbul, via the voice lane's /api/speak, reading the translated text in the
 *      listener's language. Used for seeded memories (no audio) and for every
 *      cross-language retrieval.
 *   3. Text alone, large and legible, when there is no key and no voice at all.
 *      This is a fallback, not a failure, and it says so rather than spinning.
 *
 * The card carries the sepia treatment itself, so the grade holds even if the
 * visual engine is not mounted. The route's `directive` is what actually drives the
 * photograph; this is the same instruction, expressed locally.
 */

export interface RetrievedMemory {
  id: string;
  lang: string;
  city: string | null;
  created_at: string;
  sameLanguage: boolean;
  /** The original recording, or null — then we synthesise, then we fall back to text. */
  playbackUrl: string | null;
  /** Preface + memory, already in the listener's language. */
  spokenText: string;
  /** "a Bengali-speaking visitor from Kolkata, last March" — never a name. */
  attribution: string;
}

export interface MemoryPlaybackProps {
  memory: RetrievedMemory;
  /** The listener's language, for the text-to-speech fallback. */
  listenerLang: string;
  autoPlay?: boolean;
  onStart?: (memory: RetrievedMemory) => void;
  onEnded?: (memory: RetrievedMemory) => void;
  /** Owned by the voice lane. Override only for tests. */
  speakEndpoint?: string;
  /** Shown when there is no audio at all. Keep it short. */
  textOnlyNote?: string;
  className?: string;
}

type Source = 'original' | 'synthesised' | 'text';

/** /api/speak belongs to the voice lane; read its URL out of any of the shapes it may use. */
function readAudioUrl(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d) return null;
  const direct = d.url ?? d.audioUrl ?? d.audio_url;
  if (typeof direct === 'string' && direct) return direct;
  const nested = (d.audio as Record<string, unknown> | undefined)?.url;
  if (typeof nested === 'string' && nested) return nested;
  const b64 = d.base64 ?? d.audio_base64;
  if (typeof b64 === 'string' && b64) return `data:${typeof d.mime === 'string' ? d.mime : 'audio/wav'};base64,${b64}`;
  return null;
}

export default function MemoryPlayback({
  memory,
  listenerLang,
  autoPlay = false,
  onStart,
  onEnded,
  speakEndpoint = '/api/speak',
  textOnlyNote = 'I can only show you these words — I have no voice for them right now.',
  className = '',
}: MemoryPlaybackProps) {
  const [src, setSrc] = useState<string | null>(memory.playbackUrl);
  const [source, setSource] = useState<Source>(memory.playbackUrl ? 'original' : 'text');
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // No original recording: ask the voice lane to say it. One attempt, then text.
  useEffect(() => {
    if (memory.playbackUrl) {
      setSrc(memory.playbackUrl);
      setSource('original');
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(speakEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: memory.spokenText, lang: listenerLang }),
    })
      .then(async (r) => (r.ok ? readAudioUrl(await r.json()) : null))
      .then((url) => {
        if (!alive) return;
        setSrc(url);
        setSource(url ? 'synthesised' : 'text');
      })
      .catch(() => {
        if (alive) {
          setSrc(null);
          setSource('text');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [listenerLang, memory.playbackUrl, memory.spokenText, speakEndpoint]);

  useEffect(() => {
    if (!autoPlay || !src) return;
    audioRef.current?.play().catch(() => {
      // Autoplay refused until the visitor has interacted — the button is right there.
      setPlaying(false);
    });
  }, [autoPlay, src]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, []);

  return (
    <figure
      className={`bol-glass indic-text overflow-hidden border-sandstone-300/25 bg-[#1a1310]/70 p-4 ${className}`}
      data-echo="memory"
      data-source={source}
      // The image is remembering: warm, low-contrast, slow.
      style={{ boxShadow: 'inset 0 0 60px rgba(193,98,47,0.14)' }}
    >
      <blockquote className="text-[15px] leading-relaxed text-sandstone-50/95" style={{ filter: 'sepia(0.25)' }}>
        {memory.spokenText}
      </blockquote>

      <figcaption className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-sandstone-200/70">
        <span>{memory.attribution}</span>
        {source === 'original' && (
          <span className="bol-chip border-sandstone-300/30 px-2 py-0.5 text-[10px]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sandstone-300" />
            in their own voice
          </span>
        )}
      </figcaption>

      <div className="mt-3 flex items-center gap-3">
        {src ? (
          <>
            <button
              type="button"
              onClick={toggle}
              aria-label={playing ? 'Pause' : 'Play'}
              className="grid h-10 w-10 flex-none place-items-center rounded-full bg-sandstone-500/90 text-night-950 transition hover:bg-sandstone-400"
            >
              {playing ? (
                <span className="flex gap-[3px]" aria-hidden>
                  <span className="block h-3.5 w-[3px] bg-night-950" />
                  <span className="block h-3.5 w-[3px] bg-night-950" />
                </span>
              ) : (
                <span
                  aria-hidden
                  className="ml-[2px] block h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-night-950"
                />
              )}
            </button>
            <audio
              ref={audioRef}
              src={src}
              preload="metadata"
              onPlay={() => {
                setPlaying(true);
                onStart?.(memory);
              }}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false);
                onEnded?.(memory);
              }}
              onError={() => {
                setPlaying(false);
                setSrc(null);
                setSource('text');
              }}
              className="hidden"
            />
            <span className="text-[11px] text-sandstone-200/60">
              {source === 'original' ? 'The original recording.' : 'Read back in your language.'}
            </span>
          </>
        ) : (
          <span className="text-[11px] leading-relaxed text-sandstone-200/60">
            {loading ? 'Finding a voice for this…' : textOnlyNote}
          </span>
        )}
      </div>
    </figure>
  );
}
