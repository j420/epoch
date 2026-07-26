import Link from 'next/link';

import { allMonuments, displayName } from '@/lib/monuments';

/**
 * The ten monuments, as a way in.
 *
 * In the field nobody arrives here — a visitor scans the QR at the site and lands
 * straight on /m/<id>. This exists because the whole product must be demonstrable
 * indoors in a conference room, where there is no signboard to scan and a judge
 * wants to try a second monument without someone re-pointing a camera at a printout.
 *
 * Each card shows the monument's name in its OWN regional language above the
 * English, which is the clearest one-glance statement of what this product is for.
 *
 * ---------------------------------------------------------------------------
 * VISUALLY this is a gallery wall, not a grid of dark cards on near-black. The
 * card IS the photograph: the image runs full-bleed to every edge and the name
 * sits on it, over a scrim, in the monument's own script at display size. That
 * makes the one thing worth looking at — eight different writing systems on one
 * screen — the thing the eye lands on, and it leaves no boxes within boxes.
 *
 * Two columns at every width, because a wall of ten reads as a collection and a
 * single stacked column reads as a feed.
 */
export const metadata = {
  title: 'The monuments — Bol',
  description: 'Ten Indian monuments that listen in 22 languages.',
};

/** The language whose script best represents each monument's own place. */
const HOME_LANG: Record<string, string> = {
  'qutub-minar': 'hi-IN',
  'taj-mahal': 'ur-IN',
  'red-fort': 'ur-IN',
  'gateway-of-india': 'mr-IN',
  'hawa-mahal': 'hi-IN',
  charminar: 'te-IN',
  'konark-sun-temple': 'od-IN',
  'mysore-palace': 'kn-IN',
  'golden-temple': 'pa-IN',
  'sanchi-stupa': 'hi-IN',
};

export default function MonumentsIndex() {
  const monuments = allMonuments();

  return (
    <main className="relative min-h-dvh overflow-x-hidden bg-night-950">
      {/* A single warm wash at the top so the page opens in evening light rather
          than on a flat black rectangle. No image, no weight — one gradient. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[26rem]"
        style={{
          background:
            'radial-gradient(90% 60% at 50% 0%, rgba(193,98,47,0.16) 0%, rgba(122,55,32,0.07) 45%, rgba(0,0,0,0) 78%)',
        }}
      />

      <div className="relative mx-auto max-w-3xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
        <header className="mb-10 sm:mb-14">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sandstone-300/70">Bol</p>
          <h1 className="mt-3 text-display font-semibold text-sandstone-50">Ten monuments</h1>
          <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-sandstone-200/70">
            Each one listens in twenty-two languages and answers in yours. Pick one, then just speak — you are never
            asked which language you want.
          </p>
        </header>

        {/* One wide plate per row on a phone so the native name can be set at
            display size; two portrait plates from 640px up, where a wall of ten
            reads as a collection rather than a feed. */}
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
          {monuments.map((m) => {
            const home = HOME_LANG[m.id] ?? 'hi-IN';
            const native = displayName(m, home);
            const english = displayName(m, 'en-IN');
            const sameName = native === english;
            return (
              <li key={m.id}>
                <Link
                  href={`/m/${m.id}`}
                  className="group relative block aspect-[3/2] overflow-hidden rounded-2xl bg-night-900
                             ring-1 ring-white/[0.08] transition-[transform,box-shadow] duration-base ease-bol
                             hover:-translate-y-1 hover:shadow-[0_26px_50px_-28px_rgba(0,0,0,1)]
                             hover:ring-sandstone-200/40
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sandstone-200
                             sm:aspect-[3/4]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={m.hero}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full scale-[1.02] object-cover object-[center_38%]
                               transition-transform duration-slow ease-bol group-hover:scale-[1.07]"
                  />

                  {/* The scrim the name stands on. Deep at the foot, gone by the
                      midpoint, so the photograph is never covered — only weighted. */}
                  <div
                    aria-hidden
                    className="absolute inset-0"
                    style={{
                      background:
                        'linear-gradient(to top, rgba(3,2,2,0.95) 0%, rgba(3,2,2,0.87) 24%, rgba(4,3,2,0.44) 48%, rgba(4,3,2,0.06) 72%, rgba(0,0,0,0) 100%)',
                    }}
                  />
                  {/* A warm bloom on hover — light falling on stone, not a colour wash. */}
                  <div
                    aria-hidden
                    className="absolute inset-0 opacity-0 transition-opacity duration-base ease-bol group-hover:opacity-100"
                    style={{
                      background:
                        'radial-gradient(80% 55% at 50% 18%, rgba(226,162,113,0.20) 0%, rgba(0,0,0,0) 70%)',
                    }}
                  />

                  <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
                    <p
                      lang={home}
                      className="bol-legible indic-text text-balance text-[1.6rem] font-medium leading-tight text-sandstone-50 sm:text-[1.55rem]"
                    >
                      {native}
                    </p>
                    <p className="bol-legible-soft mt-1 text-[0.8rem] leading-snug text-sandstone-200/70 sm:text-[0.78rem]">
                      {sameName ? m.city : `${english} · ${m.city}`}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>

        <div aria-hidden className="bol-hairline mt-12 h-px" />

        <p className="mt-6 max-w-md text-[0.8rem] leading-relaxed text-sandstone-200/45">
          Have a photograph of somewhere else?{' '}
          <Link
            href="/create"
            className="text-sandstone-200/80 underline decoration-sandstone-300/40 underline-offset-4
                       transition-colors duration-fast ease-bol hover:text-sandstone-100 hover:decoration-sandstone-300"
          >
            Bring your own
          </Link>{' '}
          — it will come alive and talk to you, though it will not know its own history.
        </p>
      </div>
    </main>
  );
}
