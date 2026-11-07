import { supabase } from '@/lib/supabase'

// 진행 중(IN_PROGRESS) 경기를 다른 코트로 옮길 때의 자리 정하기
//   예전: 새 코트 맨 뒤에 '진행중' 그대로 붙음 → 그 코트에 진행중 경기가 2개가 되거나,
//         대기 경기들 뒤에 진행중 경기가 생겨 '현재 경기'가 2개처럼 보임
//   지금: ① 새 코트에 이미 진행 중인 경기가 있으면 옮기지 않음
//         ② 없으면 새 코트 대기 경기들 맨 앞(= 지금 경기)으로 넣음
// 진행 중이 아닌 경기는 예전처럼 맨 뒤 (null 반환 → 호출한 쪽 기존 방식)
export interface LiveMovePlan {
  error?: string
  order?: number
  shifts?: { id: string; order: number }[]   // 앞자리를 비우려고 한 칸씩 뒤로 미는 경기들
}

export async function planLiveMove(
  eventId: string, matchId: string, status: string | null | undefined, court: string,
): Promise<LiveMovePlan | null> {
  if ((status || '').toUpperCase() !== 'IN_PROGRESS') return null
  const { data, error } = await supabase.from('matches')
    .select('id, status, court_order')
    .eq('event_id', eventId).eq('court', court)
  if (error) return { error: '코트 경기 목록을 못 불러왔습니다. 잠시 뒤 다시 해 주세요.' }
  const rows = ((data || []) as { id: string; status: string; court_order: number | null }[])
    .filter(r => r.id !== matchId)
  if (rows.some(r => r.status === 'IN_PROGRESS')) {
    return { error: `${court}에 이미 진행 중인 경기가 있어서 옮길 수 없습니다.\n그 경기가 끝난 뒤 옮기거나, 다른 코트를 고르세요.` }
  }
  const waiting = rows.filter(r => r.status !== 'FINISHED').sort((a, b) => (a.court_order ?? 0) - (b.court_order ?? 0))
  if (waiting.length === 0) {
    const max = rows.reduce((n, r) => Math.max(n, r.court_order ?? 0), 0)
    return { order: max + 1 }
  }
  const first = waiting[0].court_order ?? 1
  if (first > 1 && !rows.some(r => r.court_order === first - 1)) return { order: first - 1 }
  // 앞에 빈 번호가 없음 → 대기 경기들을 한 칸씩 뒤로 (뒤에서부터라 겹치지 않음)
  const shifts = [...waiting].reverse().map(r => ({ id: r.id, order: (r.court_order ?? 0) + 1 }))
  return { order: first, shifts }
}
