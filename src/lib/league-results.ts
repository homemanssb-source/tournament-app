// ============================================================
// 풀리그 부서 입상 계산 — 리포트(브라우저)·앱A 결과 전송(서버) 공통
// src/lib/league-results.ts
//
// 부서의 리그 경기가 모두 끝나고 순위가 모두 정해졌을 때만 입상을 돌려준다.
// (진행 중 / 동률 미지정 부서는 목록으로만 알려 줌 — 잘못된 등수가 앱A로 가지 않게)
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeLeagueStandings, leagueAllFinished, leaguePlacement } from '@/lib/league'

export interface LeaguePlacement {
  team_id: string; division_id: string; division_name: string
  rank: number; appA: string; report: string
}

export async function fetchLeaguePlacements(db: SupabaseClient, eventId: string): Promise<{
  placements: LeaguePlacement[]
  leagueDivisionIds: string[]
  unfinished: string[]     // 경기가 남은 풀리그 부서 이름
  unresolved: string[]     // 동률 순위 미지정 부서 이름
}> {
  const empty = { placements: [], leagueDivisionIds: [], unfinished: [], unresolved: [] }
  const { data: divs, error } = await db.from('divisions').select('id, name, format').eq('event_id', eventId)
  if (error) return empty   // format 열이 없는 옛 DB → 풀리그 없음
  const leagueDivs = (divs || []).filter((d: any) => d.format === 'full_league')
  if (!leagueDivs.length) return empty
  const divIds = leagueDivs.map((d: any) => d.id)

  const [{ data: groups }, { data: matches }] = await Promise.all([
    db.from('groups').select('id, division_id').eq('event_id', eventId).in('division_id', divIds),
    db.from('matches').select('group_id, division_id, status, score, team_a_id, team_b_id, winner_team_id')
      .eq('event_id', eventId).eq('stage', 'GROUP').in('division_id', divIds),
  ])
  const groupIds = (groups || []).map((g: any) => g.id)
  const { data: members } = groupIds.length
    ? await db.from('group_members').select('group_id, team_id, manual_rank').in('group_id', groupIds)
    : { data: [] as any[] }
  const teamIds = (members || []).map((m: any) => m.team_id)
  const { data: teams } = teamIds.length
    ? await db.from('teams').select('id, team_name').in('id', teamIds)
    : { data: [] as any[] }
  const nameOf = new Map((teams || []).map((t: any) => [t.id, t.team_name]))

  const out = { placements: [] as LeaguePlacement[], leagueDivisionIds: divIds as string[], unfinished: [] as string[], unresolved: [] as string[] }
  for (const d of leagueDivs as any[]) {
    for (const g of (groups || []).filter((x: any) => x.division_id === d.id)) {
      const gm = (members || []).filter((m: any) => m.group_id === g.id)
      const ms = (matches || []).filter((m: any) => m.group_id === g.id && m.score !== 'BYE')
      if (!gm.length) continue
      if (!leagueAllFinished(ms)) { out.unfinished.push(d.name); continue }
      const rows = computeLeagueStandings(
        gm.map((m: any) => ({ team_id: m.team_id, team_name: nameOf.get(m.team_id) || '', manual_rank: m.manual_rank })), ms)
      if (rows.some(r => r.rank == null)) { out.unresolved.push(d.name); continue }
      for (const r of rows) {
        const p = leaguePlacement(r.rank!, rows.length)
        out.placements.push({ team_id: r.team_id, division_id: d.id, division_name: d.name, rank: r.rank!, appA: p.appA, report: p.report })
      }
    }
  }
  return out
}
