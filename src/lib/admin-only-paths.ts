// 대회 구성 화면은 메인 관리자만 — 운영자 계정에는 메뉴·바로가기를 숨기고 들어오면 안내 (화면에서만, 서버 권한은 그대로)
// 운영자: 홈 · 단체전 대전 관리 · 코트 배정 · 알림 로그 · 리포트
const ADMIN_ONLY_EXACT  = ['/dashboard/teams']
const ADMIN_ONLY_PREFIX = ['/dashboard/groups', '/dashboard/tournament', '/dashboard/teams/clubs', '/dashboard/teams/groups',
  '/dashboard/teams/bracket', '/dashboard/teams/standings', '/dashboard/sync', '/dashboard/settings', '/dashboard/operators']

export function isAdminOnlyPath(path: string): boolean {
  const p = path.split('?')[0]
  return ADMIN_ONLY_EXACT.includes(p) || ADMIN_ONLY_PREFIX.some(x => p === x || p.startsWith(x + '/'))
}
