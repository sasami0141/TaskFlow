const CACHE_NAME = 'taskflow-cache-v24-bypassed';

// キャッシュを一切使わず、即座に新しいコードを反映させる強力な設定

self.addEventListener('install', event => {
    // 待機状態をスキップし、即座にこのワーカーをアクティブにする
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        // 全ての古いキャッシュを無条件で削除する
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => caches.delete(cacheName))
            );
        })
    );
    // 開いている全てのページを即座にコントロール下に置く
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    // 常にネットワーク（最新のファイル）から取得する Network-First
    event.respondWith(
        fetch(event.request).catch(() => {
            // ネットワークが使えない場合のみキャッシュを見る
            return caches.match(event.request);
        })
    );
});

self.addEventListener('message', event => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});
