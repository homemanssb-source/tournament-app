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

// ============================================================
// 3팀 조 "자리표시" — 아직 정해지지 않은 상대를 (첫 경기 승자/패자)로 표시
//
// 3팀 조는 첫 경기가 끝나기 전엔 누가 3번과 먼저 붙을지 정해지지 않는다(DB 트리거가
// 첫 경기 결과 후 순서를 바꿈). 그래서 첫 경기가 끝나기 전엔 남은 두 경기를
//   (첫경기 승자) vs 3번 / (첫경기 패자) vs 3번
// 로 보여준다. 첫 경기 = 그 조에서 진행중인 경기, 없으면 코트 순번(없으면 slot)이 가장 앞인 경기.
// 4팀 이상 조나 첫 경기가 끝난 조는 빈 결과(실제 팀명 그대로).
// ============================================================
export interface PlaceholderMatch {
  id: string
  group_id?: string | null
  group_label?: string | null
  division_id?: string | null
  status: string
  court?: string | null
  court_order?: number | null
  slot?: number | null
  team_a_id: string | null
  team_b_id: string | null
  team_a_name?: string | null
  team_b_name?: string | null
}
export interface PlaceholderNames { a: string | null; b: string | null; note: string }

export function groupPlaceholders(matches: PlaceholderMatch[]): Record<string, PlaceholderNames> {
  const out: Record<string, PlaceholderNames> = {}
  const groups = new Map<string, PlaceholderMatch[]>()
  for (const m of matches) {
    const key = m.group_id || (m.group_label ? `${m.division_id || ''}|${m.group_label}` : '')
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(m)
  }
  for (const gm of groups.values()) {
    const teams = new Set<string>()
    for (const m of gm) { if (m.team_a_id) teams.add(m.team_a_id); if (m.team_b_id) teams.add(m.team_b_id) }
    if (teams.size !== 3 || gm.length !== 3) continue
    if (gm.some(m => m.status === 'FINISHED')) continue   // 첫 경기가 끝났으면 실제 팀명
    const orderKey = (m: PlaceholderMatch) =>
      m.court_order != null ? m.court_order : (m.slot != null ? 1000 + m.slot : 9999)
    const first = gm.find(m => m.status === 'IN_PROGRESS')
      || [...gm].sort((x, y) => orderKey(x) - orderKey(y))[0]
    const rest = gm.filter(m => m.id !== first.id).sort((x, y) => orderKey(x) - orderKey(y))
    const firstLabel = `${(first.team_a_name || '').split('/')[0]} vs ${(first.team_b_name || '').split('/')[0]}`
    rest.forEach((m, i) => {
      const inFirst = (id: string | null) => !!id && (id === first.team_a_id || id === first.team_b_id)
      const tag = i === 0 ? '앞 경기 승자' : '앞 경기 패자'
      out[m.id] = {
        a: inFirst(m.team_a_id) ? `(${tag})` : null,
        b: inFirst(m.team_b_id) ? `(${tag})` : null,
        note: `${firstLabel} → ${tag}`,
      }
    })
  }
  return out
}
