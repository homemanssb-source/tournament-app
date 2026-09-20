// ============================================================
// 본선 순위가 없는 "참가" 팀 찾기 (예선 탈락 등)
// 대회 리포트 순위표와 앱A 결과 전송(push-results)이 같은 규칙을 쓴다.
//
// '참가'로 보는 조건 (모두 만족):
//   - 실제 경기를 1경기 이상 마쳤다 (BYE 제외)
//   - 본선 순위(우승~)가 아직 없다
//   - 끝나지 않은 본선 경기에 올라가 있지 않다 (아직 경기 중인 팀 제외)
//   - 본선 경기에 나온 적이 있거나, [해당 부서 본선이 만들어져 있고 + 자기 조 경기가 모두 끝남]
//     → 조별 예선 중이거나 본선 생성 전에는 아무도 '참가'로 확정하지 않는다
// ============================================================

export interface ParticipationMatch {
  stage: string | null
  status: string | null
  score: string | null
  group_id: string | null
  division_id: string | null
  team_a_id: string | null
  team_b_id: string | null
}

export interface ParticipantTeam {
  team_id: string
  division_id: string
}

export function findParticipantOnlyTeams(
  allMatches: ParticipationMatch[],
  placedTeamIds: Set<string>,
): ParticipantTeam[] {
  const played = new Map<string, string>()        // team_id → division_id (완료 경기 1개 이상)
  const teamGroups = new Map<string, Set<string>>() // team_id → 속한 조
  const inFinals = new Set<string>()
  const aliveInFinals = new Set<string>()
  const openGroups = new Set<string>()            // 아직 안 끝난 경기가 있는 조
  const divisionsWithFinals = new Set<string>()

  for (const m of allMatches) {
    const teams = [m.team_a_id, m.team_b_id].filter(Boolean) as string[]
    const finished = m.status === 'FINISHED'

    if (m.stage === 'FINALS') {
      if (m.division_id) divisionsWithFinals.add(m.division_id)
      for (const t of teams) {
        inFinals.add(t)
        if (!finished) aliveInFinals.add(t)
      }
    } else if (m.group_id) {
      if (!finished) openGroups.add(m.group_id)
      for (const t of teams) {
        if (!teamGroups.has(t)) teamGroups.set(t, new Set())
        teamGroups.get(t)!.add(m.group_id)
      }
    }

    if (finished && m.score !== 'BYE' && m.division_id) {
      for (const t of teams) if (!played.has(t)) played.set(t, m.division_id)
    }
  }

  const result: ParticipantTeam[] = []
  for (const [teamId, divisionId] of played) {
    if (placedTeamIds.has(teamId) || aliveInFinals.has(teamId)) continue
    if (!inFinals.has(teamId)) {
      if (!divisionsWithFinals.has(divisionId)) continue
      const groups = teamGroups.get(teamId)
      if (!groups || [...groups].some(g => openGroups.has(g))) continue
    }
    result.push({ team_id: teamId, division_id: divisionId })
  }
  return result
}
