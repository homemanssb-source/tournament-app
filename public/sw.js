// JTA 제주테니스 Service Worker
const CACHE_NAME = 'jta-ranking-v10';
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

  if (url.hostname.includes('supabase')) return;
  if (url.pathname.startsWith('/_next/')) return;
  if (e.request.mode === 'navigate') return;
  if (url.pathname.startsWith('/api/')) return;

  // 이미지 캐시
  if (url.pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|webp)$/)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // manifest.json 캐시
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
  // ✅ [FIX] JSON 파싱 실패 시 crash 방지 → try-catch로 감싸기
  let d = {};
  try {
    d = e.data?.json() || {};
  } catch {
    d = {};
  }

  // ✅ tag에 timestamp 추가 → 같은 코트 연속 알림이 덮어씌워지지 않음
  const uniqueTag = (d.tag || 'jta-notification') + '-' + Date.now();

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // 포그라운드 클라이언트에 인앱 배너 전달
      if (list.length > 0) {
        list.forEach(client => {
          client.postMessage({
            type: 'PUSH_NOTIFICATION',
            title: d.title || '🎾 JTA 제주테니스',
            body: d.body || '새로운 알림이 있습니다.',
            tag: uniqueTag,
            url: d.url || '/',
          });
        });
      }

      // ✅ requireInteraction: true → 사용자가 탭/닫기 누를 때까지 알림이 화면에 유지됨
      //    (Android Chrome 완전 지원, iOS PWA는 제한 있음)
      // ✅ 진동 패턴 강화: 길게-짧게-길게-짧게-길게-짧게-길게 (약 3초, 확실히 인지)
      return self.registration.showNotification(d.title || '🎾 JTA 제주테니스', {
        body: d.body || '새로운 알림이 있습니다.',
        icon: '/icon-192x192.png',
        badge: '/icon-72x72.png',
        vibrate: [500, 200, 500, 200, 500, 200, 800],
        tag: uniqueTag,
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
