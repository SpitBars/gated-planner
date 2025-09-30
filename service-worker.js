// Enhanced cache-first service worker for GatePlan 2.0
const CACHE = 'gateplan-v2';
const RUNTIME_CACHE = 'gateplan-runtime-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

let pendingSnapshots = [];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch((error) => {
      console.error('Asset caching failed', error);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => ![CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handlePageRequest(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'state-sync') {
    pendingSnapshots.push(event.data.payload);
    pendingSnapshots = pendingSnapshots.slice(-50);
  }
  if (event.data.type === 'sync-status') {
    event.source?.postMessage({ type: 'sync-status', pending: pendingSnapshots.length });
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'gateplan-state-sync') {
    event.waitUntil(flushPendingSnapshots());
  }
});

self.addEventListener('push', (event) => {
  const data = (() => {
    try {
      return event.data?.json();
    } catch (error) {
      return null;
    }
  })();
  const title = data?.title || 'GatePlan reminder';
  const body = data?.body || 'Stay on track with today’s plan. Tap to review your focus blocks.';
  const options = {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: data?.url || '/',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = event.notification.data || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(destination);
          return client.focus();
        }
      }
      return clients.openWindow(destination);
    })
  );
});

async function handlePageRequest(request) {
  try {
    const network = await fetch(request);
    const cache = await caches.open(CACHE);
    cache.put(request, network.clone());
    return network;
  } catch (error) {
    return caches.match('./index.html');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  try {
    const network = await fetch(request);
    cache.put(request, network.clone());
    return network;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function flushPendingSnapshots() {
  if (!pendingSnapshots.length) return;
  // Simulate background sync by acknowledging the queue.
  pendingSnapshots = [];
  const clientsList = await clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach((client) => client.postMessage({ type: 'sync-status', pending: 0 }));
}
