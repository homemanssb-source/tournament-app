// 제주시 테니스 대회 Service Worker
const CACHE_NAME = 'jta-tournament-v1';
const ASSETS = ['/', '/manifest.json', '/icon-192x192.png', '/icon-512x512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).hostname.includes('supabase')) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match('/'))
    )
  );
});

// ── 푸시 알림 수신 ──
self.addEventListener('push', e => {
  const d = e.data?.json() || {};
  const options = {
    body:     d.body    || '새로운 알림이 있습니다.',
    icon:     '/icon-192x192.png',
    badge:    '/icon-72x72.png',
    vibrate:  [200, 100, 200, 100, 200],
    tag:      d.tag     || 'jta-tournament',
    renotify: true,
    data:     { url: d.url || '/' },
    actions: [
      { action: 'open',  title: '확인하기' },
      { action: 'close', title: '닫기' }
    ]
  };
  e.waitUntil(
    self.registration.showNotification(d.title || '🎾 제주시 테니스 대회', options)
  );
});

// ── 알림 클릭 처리 ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
