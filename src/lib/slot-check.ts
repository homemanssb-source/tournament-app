// 본선 빈자리가 채워진 팀에게 알림 요청 (운영자 화면용)
// 결과 수정·수동 순위 확정·슬롯 채우기 뒤에 호출 — 규칙은 src/lib/slot-filled-notify.ts
import { authHeaders } from '@/lib/auth-headers'

export async function requestSlotCheck(eventId: string) {
  fetch('/api/notify/court', {
    method: 'POST', headers: await authHeaders(),
    body: JSON.stringify({ event_id: eventId, trigger: 'slot_check' }),
  }).catch(() => {})
}
