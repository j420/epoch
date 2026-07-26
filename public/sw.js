/**
 * Bol service worker — demo insurance.
 *
 * Assume venue wifi dies. Everything that is not a live voice call must survive
 * airplane mode: the hero photograph, the depth map, the archival layer, the seed
 * memories, the pre-rendered intro narration, the app shell itself.
 *
 * Strategy per request type:
 *   - demo assets (images, audio, cue tracks) -> cache-first, they never change mid-demo
 *   - navigations and JS/CSS            -> network-first with a cache fallback, so a
 *                                          deploy is picked up but a dead network still boots
 *   - /api/*                            -> network-only, EXCEPT the small set of
 *                                          pre-warmed GETs listed below
 *
 * Deliberately NOT cached: /api/listen, /api/answer, /api/speak. A stale answer is
 * worse than an honest "I cannot hear you right now" — the app has a visible offline
 * fallback for the live loop and it should be allowed to fire.
 */

const VERSION = 'bol-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const RUNTIME = `${VERSION}-runtime`;

/** Fetched eagerly on install. Keep this list to things the demo genuinely needs. */
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/monuments/qutub-minar/hero.png',
  '/monuments/qutub-minar/depth.png',
  '/monuments/qutub-minar/era-1900.png',
];

/** Extra demo assets precached best-effort — a 404 here must not fail the install. */
const PRECACHE_OPTIONAL = [
  '/demo/intro-hi.mp3',
  '/demo/intro-ta.mp3',
  '/demo/intro-bn.mp3',
  '/demo/intro-te.mp3',
  '/demo/intro-mr.mp3',
  '/demo/cues-intro.json',
  '/demo/plaque-sample.jpg',
  '/demo/plaque-sample-ocr.json',
];

const isAsset = (url) =>
  url.pathname.startsWith('/monuments/') ||
  url.pathname.startsWith('/demo/') ||
  /\.(png|jpe?g|webp|avif|svg|mp3|wav|webm|m4a|woff2?)$/i.test(url.pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ASSETS);
      // Required precache: fail loudly if the hero or depth map is missing.
      await cache.addAll(PRECACHE);
      // Optional precache: each independently, so one missing file cannot abort install.
      await Promise.all(
        PRECACHE_OPTIONAL.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* not generated yet — fine */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // The demo reset key clears runtime state without a hard reload.
  if (event.data?.type === 'BOL_RESET') {
    event.waitUntil(caches.delete(RUNTIME));
  }
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // --- API: network-only. Never serve a stale answer. ---
  if (url.pathname.startsWith('/api/')) return;

  // --- demo assets: cache-first ---
  if (isAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(ASSETS);
            cache.put(req, res.clone());
          }
          return res;
        } catch (err) {
          const fallback = await caches.match(req, { ignoreSearch: true });
          if (fallback) return fallback;
          throw err;
        }
      })(),
    );
    return;
  }

  // --- everything else: network-first, cache fallback ---
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (req.mode === 'navigate' || /\.(js|css)$/.test(url.pathname))) {
          const cache = await caches.open(SHELL);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const cached = (await caches.match(req)) ?? (req.mode === 'navigate' ? await caches.match('/') : undefined);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
