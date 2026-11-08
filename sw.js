const CACHE_NAME = 'taskflow-cache-v35';
const urlsToCache = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js?v=35',
  './manifest.json',
  './taskflow_icon.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // 今回のv35アップデートを強制適用するため、キャッシュを使わずに常にネットワークから最新を取りに行きます。
  // (オフライン時のみキャッシュを利用)
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
