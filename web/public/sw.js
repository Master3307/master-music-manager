// Master Music Manager's service worker: starts the app fast and lets it open
// without a connection. It never stores API answers, songs or your data:
// /api, /dav, /share and /s always go straight to the server.
const CACHE = 'mmm-shell-v1';
const SHELL = ['/', '/site.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const LIVE = /^\/(api|dav|share|s)(\/|$)/;
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || LIVE.test(url.pathname)) return;
  // Pages: the newest from the server, the saved one when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) caches.open(CACHE).then((c) => c.put('/', r.clone()));
          return r;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  // Built files have their hash in the name: once saved, always right.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((r) => {
            if (r.ok) caches.open(CACHE).then((c) => c.put(req, r.clone()));
            return r;
          }),
      ),
    );
    return;
  }
  // Icons, fonts, the manifest: the saved one at once, refreshed in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((r) => {
          if (r.ok) caches.open(CACHE).then((c) => c.put(req, r.clone()));
          return r;
        })
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});
