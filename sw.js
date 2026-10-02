// Offline-Betrieb: alles liegt im Cache und wird sofort von dort geliefert
// (im Studio ist das Netz schlecht). Im Hintergrund wird nachgeladen, die
// neue Version greift beim nächsten Start. VERSION hochzählen, wenn Dateien
// dazukommen oder wegfallen — dann wird der alte Cache aufgeräumt.
const VERSION = 'v5';
const CACHE = `training-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/db.js',
  './js/progression.js',
  './data/days.json',
  './data/exercises.json',
  './data/seed-sessions.json',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // 'no-cache': beim Nachladen den HTTP-Cache des Browsers (GitHub Pages: 10 Min.) umgehen
  const fresh = fetch(req, { cache: 'no-cache' })
    .then(async (res) => {
      if (res.ok) await (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })
    .catch(() => null);
  e.waitUntil(fresh);

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) => hit || fresh.then((res) => res || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())),
    ),
  );
});
