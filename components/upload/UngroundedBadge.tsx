'use client';

import { useState } from 'react';

/**
 * The honest badge.
 *
 * A visitor who has just watched their own photograph come alive and start
 * speaking has every reason to assume it knows what it is talking about. It does
 * not, and nothing on screen should let that assumption stand for even a moment.
 *
 * So this sits in the top rail beside the language chip — visible from the first
 * frame, before a word is spoken, not tucked inside a tooltip and not shown once
 * and dismissed. It expands on tap into the full, plain explanation, because the
 * short form has to be short enough to actually read.
 *
 * The wording avoids "AI", "model" and "unverified". A visitor does not need to
 * know our architecture; they need to know that this thing cannot tell them
 * anything true about history, and that the monument on the main page can.
 */

export interface UngroundedBadgeProps {
  /** Set when Vision matched a real monument we hold cited sources for. */
  matchedMonumentId?: string | null;
  /** Vision's guess at a name. Shown only inside the expanded panel, as a guess. */
  identifiedAs?: string | null;
  className?: string;
}

export function UngroundedBadge({ matchedMonumentId = null, identifiedAs = null, className = '' }: UngroundedBadgeProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`flex flex-col items-start gap-2 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="bol-chip border-amber-300/40 text-amber-100"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <span>Your photograph · no history</span>
        <span aria-hidden className="text-amber-200/50">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="bol-glass max-w-xs p-3 text-xs leading-relaxed text-sandstone-100/90">
          <p>
            This is a photograph you took, not a researched monument. It can describe how it looks — its
            colour, its light, its shape — and that is all. It does not know its own name, its age, or
            anything that happened where it stands, and it will say so rather than guess.
          </p>
          <p className="mt-2 text-sandstone-200/60">
            The monuments on the main page answer only from cited sources. This one has none.
          </p>
          {identifiedAs && (
            <p className="mt-2 text-sandstone-200/60">
              Our reader thought it might be <span className="text-sandstone-100">{identifiedAs}</span> — a guess,
              which is exactly why it is not allowed to say so out loud.
            </p>
          )}
          {matchedMonumentId && (
            <a
              href="/"
              className="mt-3 inline-flex rounded-lg border border-sandstone-200/30 px-3 py-1.5 text-xs text-sandstone-100"
            >
              Talk to the real one instead
            </a>
          )}
          <p className="mt-3 border-t border-white/10 pt-2 text-[11px] text-sandstone-200/50">
            Your photograph stays on this device. It was sent once, to be described, and is not stored on
            any server.
          </p>
        </div>
      )}
    </div>
  );
}

export default UngroundedBadge;
