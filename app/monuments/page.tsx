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
    <main className="min-h-dvh overflow-y-auto bg-night-950 px-5 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight text-sandstone-50">Ten monuments</h1>
          <p className="mt-2 text-sm leading-relaxed text-sandstone-200/70">
            Each one listens in twenty-two languages and answers in yours. Pick one, then just speak — you are never
            asked which language you want.
          </p>
        </header>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {monuments.map((m) => {
            const home = HOME_LANG[m.id] ?? 'hi-IN';
            const native = displayName(m, home);
            const english = displayName(m, 'en-IN');
            return (
              <li key={m.id}>
                <Link
                  href={`/m/${m.id}`}
                  className="group block overflow-hidden rounded-2xl border border-white/10 bg-black/30 transition-colors hover:border-sandstone-300/40"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={m.hero}
                    alt=""
                    loading="lazy"
                    className="h-40 w-full object-cover opacity-85 transition-opacity group-hover:opacity-100"
                  />
                  <div className="p-3.5">
                    <p lang={home} className="indic-text text-lg font-medium text-sandstone-50">
                      {native}
                    </p>
                    <p className="mt-0.5 text-xs text-sandstone-200/60">
                      {native === english ? m.city : `${english} · ${m.city}`}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mt-8 text-xs leading-relaxed text-sandstone-200/40">
          Have a photograph of somewhere else?{' '}
          <Link href="/create" className="text-sandstone-200/70 underline underline-offset-4">
            Bring your own
          </Link>{' '}
          — it will come alive and talk to you, though it will not know its own history.
        </p>
      </div>
    </main>
  );
}
