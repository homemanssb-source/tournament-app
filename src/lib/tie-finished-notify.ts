// 단체전 복식 점수 저장 뒤: 이번 입력으로 대전이 끝났으면 같은 코트 다음 대전 주장들에게 '다음 대전 준비' 알림 요청
// 주장·경기장·마스터 PIN·대시보드 화면이 같이 씀. 서버(/api/notify/court finished_tie_id)가 대전마다 1번만 보냄
import { supabase } from '@/lib/supabase'

export async function notifyIfTieFinished(tieId: string, statusBefore: string | null | undefined) {
  if (statusBefore === 'completed') return   // 정정 — 이미 끝났던 대전
  try {
    const { data } = await supabase.from('ties').select('event_id, status').eq('id', tieId).single()
    if (data?.status !== 'completed') return
    fetch('/api/notify/court', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: data.event_id, finished_tie_id: tieId, trigger: 'finished' }),
    }).catch(() => {})
  } catch {}
}
