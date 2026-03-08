// 대회앱 푸시 알림 유틸
// 사용법: notify.matchStart('A조 1번 코트 - 홍길동 vs 김철수', '/events/123')

type NotifyOptions = {
  title: string
  body: string
  url?: string
  tag?: string
}

async function sendNotification({ title, body, url = '/', tag = 'jta' }: NotifyOptions) {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  const reg = await navigator.serviceWorker.ready
  await reg.showNotification(title, {
    body,
    icon: '/icon-192x192.png',
    badge: '/icon-72x72.png',
    vibrate: [200, 100, 200],
    tag,
    renotify: true,
    data: { url },
  })
}

export const notify = {
  /** 경기 시작 알림 */
  matchStart: (body: string, url?: string) =>
    sendNotification({ title: '🎾 경기 시작', body, url, tag: 'match-start' }),

  /** 스코어 업데이트 */
  scoreUpdate: (body: string, url?: string) =>
    sendNotification({ title: '📊 스코어 업데이트', body, url, tag: 'score-update' }),

  /** 경기 종료 */
  matchEnd: (body: string, url?: string) =>
    sendNotification({ title: '🏆 경기 종료', body, url, tag: 'match-end' }),

  /** 코트 배정 */
  courtAssign: (body: string, url?: string) =>
    sendNotification({ title: '📍 코트 배정', body, url, tag: 'court-assign' }),

  /** 경기 일정 변경 */
  scheduleChange: (body: string, url?: string) =>
    sendNotification({ title: '🔄 일정 변경', body, url, tag: 'schedule-change' }),

  /** 일반 공지 */
  general: (title: string, body: string, url?: string) =>
    sendNotification({ title, body, url, tag: 'general' }),
}
