// Service worker: offline shell + the push handler that draws the lock-screen alert.

const CACHE = 'commute-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png'];
const TAG = 'commute';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return res;
  })));
});

/** Drop anything left over from a previous morning, or past its window end. */
async function closeStale(now = Date.now()) {
  for (const note of await self.registration.getNotifications({ tag: TAG })) {
    const expires = note.data?.expiresAt ? Date.parse(note.data.expiresAt) : 0;
    if (!expires || expires <= now) note.close();
  }
}

async function closeAll() {
  for (const note of await self.registration.getNotifications({ tag: TAG })) note.close();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data?.text() || 'Commute' }; }

  event.waitUntil((async () => {
    // The window has closed: clear the morning's alert off the lock screen.
    // iOS requires every push to show *something*, so show a silent placeholder
    // and take it straight back down.
    if (data.kind === 'sweep') {
      await closeAll();
      await self.registration.showNotification('Commute window closed', {
        tag: TAG, silent: true, body: '', data: { kind: 'sweep', expiresAt: new Date().toISOString() },
      });
      await wait(600);
      await closeAll();
      return;
    }

    await closeStale();
    await self.registration.showNotification(data.title || 'Commute', {
      tag: TAG,                       // replaces the previous refresh instead of stacking
      renotify: Boolean(data.renotify),
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      timestamp: Date.parse(data.checkedAt || '') || Date.now(),
      data,
    });

    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      client.postMessage({ type: 'alert', payload: data });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = clients.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { await open.focus(); return; }
    await self.clients.openWindow('/?source=notification');
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'clear-notifications') event.waitUntil(closeAll());
});
