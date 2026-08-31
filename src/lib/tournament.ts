// src/lib/tournament.ts
// 대회 진행 로직 공용 헬퍼
import { supabase } from '@/lib/supabase'

// ============================================================
// 조별 경기가 모두 끝났으면 본선 TBD 슬롯을 자동으로 채운다.
//
// 기존에는 선수(pin/matches)의 브라우저에서만 호출돼서, 마지막 조별 점수를
// 넣은 선수가 제출 직후 앱을 닫으면 슬롯이 안 채워지는 문제가 있었다.
// → 선수 화면과 운영자(courts) 화면 양쪽에서 호출해, 한쪽이 실패해도
//   다른 쪽 조작 시 채워지도록 안전망을 둔다.
//
// 여러 번 호출해도 안전(빈 슬롯만 채우는 멱등 RPC).
// GROUP 경기가 아니면 아무것도 하지 않는다.
// ============================================================
export async function fillSlotsIfGroupComplete(
  eventId: string | null | undefined,
  match: { id: string; stage?: string | null; round?: string | null },
): Promise<void> {
  const stageUp = (match.stage || '').toUpperCase()
  const roundUp = (match.round || '').toUpperCase()
  if (stageUp !== 'GROUP' && roundUp !== 'GROUP') return
  if (!eventId) return

  try {
    // 해당 경기의 group_id / division_id 조회
    const { data: matchData } = await supabase
      .from('matches')
      .select('group_id, division_id')
      .eq('id', match.id)
      .single()
    if (!matchData?.group_id) return

    // 같은 조의 남은 경기 수 확인 (BYE 제외)
    const { data: groupMatches } = await supabase
      .from('matches')
      .select('id, status, score, stage')
      .eq('event_id', eventId)
      .eq('group_id', matchData.group_id)

    const groupOnly = (groupMatches || []).filter(m => (m.stage || '').toUpperCase() === 'GROUP')
    const unfinished = groupOnly.filter(m => m.status !== 'FINISHED' && m.score !== 'BYE')
    if (unfinished.length > 0) return // 아직 남은 경기 있음

    // 본선 브래킷에 TBD 슬롯이 있는지 확인
    const { data: finalsMatches } = await supabase
      .from('matches')
      .select('id, qualifier_label_a, qualifier_label_b')
      .eq('event_id', eventId)
      .eq('division_id', matchData.division_id)
      .eq('stage', 'FINALS')

    const hasTbd = (finalsMatches || []).some(
      m => m.qualifier_label_a != null || m.qualifier_label_b != null,
    )
    if (!hasTbd) return // TBD 슬롯 없음 (브래킷 미생성 or 이미 완료)

    const { error } = await supabase.rpc('rpc_fill_tournament_slots', {
      p_event_id: eventId,
      p_group_id: matchData.group_id,
    })
    if (error) console.warn('[fillSlots] rpc_fill_tournament_slots 오류:', error.message)
  } catch (e) {
    // 안전망이므로 실패해도 조용히 넘어감 (다음 조작 시 재시도됨)
    console.warn('[fillSlots] 예외:', e)
  }
}
