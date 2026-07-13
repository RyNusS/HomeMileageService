// Service worker:
//  - navigations (app shell / index.html): NETWORK-FIRST so new deploys show up
//    immediately (fixes stale UI after an update), cache as offline fallback.
//  - hashed static assets: cache-first (filenames change per build, so it's safe).
//  - API (/api/*): bypass the SW entirely.
const CACHE = 'hms-v2';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  const isNavigation = e.request.mode === 'navigate'
    || (e.request.destination === 'document');

  if (isNavigation) {
    // network-first: always try to get the freshest shell
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // static assets: cache-first with background refresh
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetching = fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || fetching;
    })
  );
});

// ── web push ──
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(data.title || '홈 마일리지', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(e.notification.data && e.notification.data.url || '/');
  }));
});
