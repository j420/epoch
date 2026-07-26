'use client';

import CameraCapture from '@/components/vision/CameraCapture';

/**
 * The first screen of /create: photograph something, or pick a photograph.
 *
 * `CameraCapture` is reused wholesale from the vision lane rather than rebuilt.
 * It already does the thing that matters most on a mid-range Android over 4G:
 * decode with `imageOrientation: 'from-image'` so EXIF-rotated portrait shots do
 * not arrive sideways, then downscale to a 1600px long edge and re-encode as
 * JPEG q0.82 BEFORE anything is uploaded. A 12MP phone photo is 4-6MB; that is
 * a six-second wait on an Indian uplink and it would wreck this feature before
 * the depth model even started. Its `capture="environment"` file input is also
 * the only camera path that reliably opens inside in-app browsers.
 *
 * Everything on this screen is stated plainly before the visitor commits: what
 * happens to their photograph, and what the result will and will not know.
 */

export interface PhotoIntakeProps {
  onCapture: (file: File) => void;
  busy?: boolean;
  /** Progress line while depth is being inferred. */
  status?: string | null;
  /** Something failed. Shown, never swallowed. */
  error?: string | null;
  /** e.g. no Sarvam key — the photograph still comes alive, it just cannot talk. */
  notice?: string | null;
  /** Offered when a previous photograph is still in this browser's storage. */
  onRestore?: (() => void) | null;
  resetToken?: number;
}

export default function PhotoIntake({
  onCapture,
  busy = false,
  status = null,
  error = null,
  notice = null,
  onRestore = null,
  resetToken = 0,
}: PhotoIntakeProps) {
  return (
    <main className="h-dvh w-full overflow-y-auto bg-night-950">
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-5 px-5 py-10">
        <header>
          <a href="/" className="bol-chip">
            ← back to the monument
          </a>
          <h1 className="mt-5 text-balance text-2xl font-semibold leading-tight text-sandstone-50">
            Photograph anything. Then talk to it.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-sandstone-200/75">
            A building, a statue, a gate, a wall you like. Your phone will find the depth in the picture
            and give it a slow, moving camera — the same one the monuments use.
          </p>
        </header>

        <CameraCapture
          onCapture={onCapture}
          disabled={busy}
          resetToken={resetToken}
          label="Your photograph"
          hint="Stand back far enough to get the whole thing in frame. Depth reads best with sky or open space behind the subject."
        />

        {/* The two promises, made before anything is sent anywhere. */}
        <section className="bol-glass p-4 text-xs leading-relaxed text-sandstone-200/75">
          <p className="text-sandstone-100">
            <span className="font-semibold">It will not know its history.</span> Nobody has researched your
            photograph, so it has no sources to answer from. It can describe how it looks — colour, light,
            material, weather — and when you ask it anything factual it will say plainly that it does not
            know. It is not allowed to guess, and it will not.
          </p>
          <p className="mt-3 text-sandstone-100">
            <span className="font-semibold">It stays on your device.</span> The picture is kept in this
            browser only. It is sent once, to be described, and is not saved on any server or in any
            database. Clear it whenever you like.
          </p>
        </section>

        {notice && (
          <p className="rounded-xl border border-sandstone-500/40 bg-sandstone-900/30 p-3 text-xs leading-relaxed text-sandstone-100">
            {notice}
          </p>
        )}

        {busy && (
          <div className="bol-glass p-4">
            <div className="bol-shimmer h-1 w-full rounded-full" aria-hidden />
            <p className="mt-3 text-sm text-sandstone-100" role="status" aria-live="polite">
              {status ?? 'Waking your photograph…'}
            </p>
            <p className="mt-1 text-xs text-sandstone-200/55">
              All of this runs in your browser. Nothing here is uploaded.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl border border-red-400/40 bg-red-950/30 p-3 text-xs leading-relaxed text-red-100">
            {error}
          </p>
        )}

        {onRestore && !busy && (
          <button
            type="button"
            onClick={onRestore}
            className="w-full rounded-xl border border-white/15 px-4 py-3 text-sm text-sandstone-100"
          >
            Back to the photograph you made last time
          </button>
        )}
      </div>
    </main>
  );
}
