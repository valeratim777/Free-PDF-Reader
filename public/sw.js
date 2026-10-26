// Offline support: the app shell and every asset it loads are cached on first use.
const CACHE = 'pr-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pr-v') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromNetwork(request) {
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    const c = await caches.open(CACHE);
    c.put(request, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Files shared from other apps (Android "Share" → PDF Reader).
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        const form = await request.formData();
        const file = form.getAll('file').find((f) => f && typeof f !== 'string');
        if (file) {
          const c = await caches.open('pr-share');
          await c.put(
            'shared-file',
            new Response(file, { headers: { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': encodeURIComponent(file.name || 'shared.pdf') } }),
          );
        }
        return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
      })(),
    );
    return;
  }

  if (request.method !== 'GET') return;

  // Pages: network first so updates arrive, cache when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fromNetwork(request).catch(async () => (await caches.match(request)) || (await caches.match('./')) || Response.error()));
    return;
  }

  // Assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const net = fromNetwork(request).catch(() => hit);
      return hit || net;
    }),
  );
});
