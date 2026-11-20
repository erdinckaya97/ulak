// Offline app shell: once loaded, Ulak opens without any network.
const VERSION = 'ulak-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/app.js',
  'src/i18n.js',
  'src/identity.js',
  'src/messenger.js',
  'src/nostr.js',
  'src/packet.js',
  'src/rtc.js',
  'src/store-idb.js',
  'src/store-memory.js',
  'src/util.js',
  'src/locales/en.js',
  'src/locales/tr.js',
  'src/locales/es.js',
  'src/locales/pt.js',
  'src/locales/ru.js',
  'src/locales/ar.js',
  'src/locales/hi.js',
  'src/locales/zh.js',
  'src/locales/ja.js',
  'src/locales/ko.js',
  'vendor/crypto.js',
  'vendor/qr.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Serve from cache immediately and refresh it in the background.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
