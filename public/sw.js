// JTA 제주테니스 Service Worker
const CACHE_NAME = 'jta-ranking-v8';
const STATIC_ASSETS = ['/icon-192x192.png', '/icon-512x512.png', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
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

  const url = new URL(e.request.url);

  // ✅ Supabase API 요청 — SW 개입 금지
  if (url.hostname.includes('supabase')) return;

  // ✅ Next.js 내부 요청 (_next/) — SW 개입 금지
  if (url.pathname.startsWith('/_next/')) return;

  // ✅ 네비게이션 요청 (HTML 페이지) — SW 개입 금지
  if (e.request.mode === 'navigate') return;

  // ✅ API 라우트 — SW 개입 금지
  if (url.pathname.startsWith('/api/')) return;

  // 이미지 캐시
  if (url.pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|webp)$/)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // manifest.json 캐시 — clone 올바르게 처리
  if (url.pathname === '/manifest.json') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, resClone));
          }
          return res;
        });
      })
    );
    return;
  }
});

self.addEventListener('push', e => {
  const d = e.data?.json() || {};

  e.waitUntil(
    // ✅ 포그라운드 클라이언트에 먼저 메시지 전달 (인앱 알림)
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // 포그라운드 클라이언트가 있으면 메시지 전달
      if (list.length > 0) {
        list.forEach(client => {
          client.postMessage({
            type: 'PUSH_NOTIFICATION',
            title: d.title || '🎾 JTA 제주테니스',
            body: d.body || '새로운 알림이 있습니다.',
            tag: d.tag || 'jta-notification',
            url: d.url || '/',
          });
        });
      }

      // ✅ OS 알림은 항상 표시 (포그라운드 여부 무관)
      // - 백그라운드: OS 시스템 알림으로 표시
      // - 포그라운드: 인앱 배너 + OS 알림 둘 다 표시
      return self.registration.showNotification(d.title || '🎾 JTA 제주테니스', {
        body: d.body || '새로운 알림이 있습니다.',
        icon: '/icon-192x192.png',
        badge: '/icon-72x72.png',
        vibrate: [300, 100, 300, 100, 500],
        tag: d.tag || 'jta-notification',
        renotify: true,
        requireInteraction: true,
        silent: false,
        data: { url: d.url || '/pin/matches' },
        actions: [
          { action: 'open',  title: '✅ 확인하기' },
          { action: 'close', title: '닫기' }
        ]
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});


