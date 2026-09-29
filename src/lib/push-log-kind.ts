// src/lib/push-log-kind.ts
// 알림 로그(push_logs) 한 줄을 화면용 상태로 분류 — /dashboard/push-logs 에서 사용

export type PushLogLike = {
  team_a_name: string | null
  team_b_name: string | null
  sent: number
  failed: number
  no_sub: boolean
  error_msg: string | null
}

// 로그 한 줄의 상태 — 배지·필터·통계가 모두 이것 하나로 판단
// - held:      대회 전이라 코트 변경 알림 보류 (error_msg 'skipped:')
// - no_target: 그 코트에 대기 경기가 없어 보낼 대상이 없음 (팀 이름 둘 다 빈 no_sub)
// - expired:   구독이 전부 만료돼 자동 정리됨 (받을 기기 없음)
// - cleanup:   발송 성공 + 만료된 옛 구독을 정리 (오류 아님)
export type LogKind = 'ok' | 'cleanup' | 'partial' | 'fail' | 'no_sub' | 'expired' | 'no_target' | 'held' | 'none'

export function logKind(log: PushLogLike): LogKind {
  const err = log.error_msg || ''
  if (err.startsWith('skipped:')) return 'held'
  const expiredOnly = !!err && err.split(' | ').every(p => p.startsWith('expired'))
  if (err && !expiredOnly) return log.sent > 0 ? 'partial' : 'fail'
  if (log.no_sub) return !log.team_a_name && !log.team_b_name ? 'no_target' : 'no_sub'
  if (expiredOnly) return log.sent > 0 ? 'cleanup' : 'expired'
  if (log.failed > 0) return log.sent > 0 ? 'partial' : 'fail'
  return log.sent > 0 ? 'ok' : 'none'
}
