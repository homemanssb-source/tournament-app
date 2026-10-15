// ============================================================
// 시드 배정 공용 헬퍼 (개인전 teams.seed_number / 단체전 clubs.seed_number)
// 규칙(서버 028): 시드 k번 → k번째 조 첫 자리, 본선은 시드 조 1위를 표준 시드 위치에.
// ============================================================
import { supabase } from '@/lib/supabase'

// 서버(rpc_generate_groups / rpc_create_team_groups)와 완전 동일한 분배 로직.
// 1팀 조 방지 (2+1→3, 3+1→2+2, 4+1→3+2, 5+1→3+3, 6+1→4+3).
export function calcGroupDistribution(totalTeams: number, groupSize: number): number[] {
  if (totalTeams < 2) return []
  const tpg = Math.max(2, Math.min(6, groupSize))
  const remainder  = totalTeams % tpg
  const fullGroups = Math.floor(totalTeams / tpg)
  const result: number[] = []

  if (remainder === 0) {
    for (let i = 0; i < fullGroups; i++) result.push(tpg)
  } else if (remainder === 1) {
    // 마지막 1팀을 앞 조에 병합해서 1팀 조 없앰
    for (let i = 0; i < fullGroups - 1; i++) result.push(tpg)
    if (tpg === 2)      result.push(3)
    else if (tpg === 3) { result.push(2); result.push(2) }
    else if (tpg === 4) { result.push(3); result.push(2) }
    else if (tpg === 5) { result.push(3); result.push(3) }
    else if (tpg === 6) { result.push(4); result.push(3) }
    else                 result.push(tpg + 1)
  } else {
    for (let i = 0; i < fullGroups; i++) result.push(tpg)
    result.push(remainder)
  }
  return result
}

// 시드 저장: 부서의 기존 시드를 모두 지우고 orderedIds 순서대로 1·2·3… 부여 ([] = 시드 안 함)
export async function saveSeeds(
  table: 'teams' | 'clubs',
  eventId: string,
  divisionId: string | null,
  orderedIds: string[],
): Promise<void> {
  let clear = supabase.from(table).update({ seed_number: null })
    .eq('event_id', eventId).not('seed_number', 'is', null)
  if (divisionId) clear = clear.eq('division_id', divisionId)
  const { error } = await clear
  if (error) throw error

  for (let i = 0; i < orderedIds.length; i++) {
    const { error: e } = await supabase.from(table).update({ seed_number: i + 1 }).eq('id', orderedIds[i])
    if (e) throw e
  }
}
