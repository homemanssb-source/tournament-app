// ============================================================
// 부서별 진행방식 + 풀리그 순위·입상 (개인전/단체전 공통)
// src/lib/league.ts
//
// 진행방식: divisions.format = 'full_league' | 'group_knockout' (null = 예전 방식 그대로)
// 개인전 풀리그 = 부서 전체가 한 조('리그')로 서로 한 번씩 → 본선 없이 리그 순위로 입상
// 순위: 승수 → 승자승(동률 팀끼리 경기 승수) → 게임 득실 → 운영자 수동 지정(group_members.manual_rank)
// ============================================================
import { parseScorePair } from '@/lib/score'

export type DivisionFormat = 'full_league' | 'group_knockout'

export const FULL_LEAGUE_RECOMMEND_MAX = 5   // 이 팀 수 이하면 풀리그 추천

export function isFullLeague(div: { format?: string | null } | null | undefined): boolean {
  return div?.format === 'full_league'
}

// 단체전: 부서 진행방식 → team_format. 부서에 저장된 값이 없으면 대회 설정(events.team_format) 그대로
export type TeamFormatKey = 'full_league' | 'group_tournament' | 'prelim_tournament'
export function divisionTeamFormat(div: { format?: string | null } | null | undefined, eventFormat: string | null | undefined): TeamFormatKey {
  if (div?.format === 'full_league') return 'full_league'
  if (div?.format === 'group_knockout') return eventFormat === 'prelim_tournament' ? 'prelim_tournament' : 'group_tournament'
  return (eventFormat as TeamFormatKey) || 'group_tournament'
}

export function recommendedFormat(teamCount: number): DivisionFormat {
  return teamCount <= FULL_LEAGUE_RECOMMEND_MAX ? 'full_league' : 'group_knockout'
}

// ── 예상 경기 수 ──
export function fullLeagueMatchCount(n: number): number {
  return n >= 2 ? (n * (n - 1)) / 2 : 0
}

// 조별(조 크기 분배) + 본선(조당 advance 명) 경기 수
export function groupKnockoutMatchCount(groupSizes: number[], advancePerGroup: number): { prelim: number; finals: number; total: number; minPerTeam: number } {
  const prelim = groupSizes.reduce((s, g) => s + fullLeagueMatchCount(g), 0)
  const qualifiers = groupSizes.reduce((s, g) => s + Math.min(advancePerGroup, g), 0)
  const finals = qualifiers >= 2 ? qualifiers - 1 : 0   // 단판 토너먼트 실제 경기 수 (부전승 제외)
  const minPerTeam = groupSizes.length ? Math.min(...groupSizes) - 1 : 0
  return { prelim, finals, total: prelim + finals, minPerTeam }
}

// ── 순위 ──
export interface LeagueMember { team_id: string; team_name: string; manual_rank?: number | null }
export interface LeagueMatch {
  status: string | null; score: string | null
  team_a_id: string | null; team_b_id: string | null; winner_team_id: string | null
}
export interface LeagueRow {
  team_id: string; team_name: string
  played: number; wins: number; losses: number; gf: number; ga: number; game_diff: number
  rank: number | null          // null = 동률 미결정 (수동 지정 필요)
  tied: boolean                // 승수·승자승·득실까지 같아 수동 지정이 필요했던(또는 필요한) 팀
  manual: boolean              // 수동 순위로 결정됨
  tieStart: number | null      // 동률 덩어리가 시작하는 순위 (예: 2·3위 동률이면 2) — 수동 지정은 이 덩어리 안에서만
  tieSize: number
}

export function computeLeagueStandings(members: LeagueMember[], matches: LeagueMatch[]): LeagueRow[] {
  const ids = new Set(members.map(m => m.team_id))
  const st = new Map<string, LeagueRow>()
  for (const m of members) {
    st.set(m.team_id, { team_id: m.team_id, team_name: m.team_name, played: 0, wins: 0, losses: 0, gf: 0, ga: 0, game_diff: 0, rank: null, tied: false, manual: false, tieStart: null, tieSize: 1 })
  }
  const finished = matches.filter(m => m.status === 'FINISHED' && m.score !== 'BYE'
    && m.team_a_id && m.team_b_id && ids.has(m.team_a_id) && ids.has(m.team_b_id))
  for (const m of finished) {
    // 점수는 승자 기준으로 읽는다 (조별 순위와 같은 방식, w.o 는 득실 0)
    const [n1, n2] = parseScorePair(m.score || '') ?? [0, 0]
    const hi = Math.max(n1, n2), lo = Math.min(n1, n2)
    const aWin = m.winner_team_id === m.team_a_id
    const a = st.get(m.team_a_id!)!, b = st.get(m.team_b_id!)!
    a.played++; b.played++
    a.gf += aWin ? hi : lo; a.ga += aWin ? lo : hi
    b.gf += aWin ? lo : hi; b.ga += aWin ? hi : lo
    if (m.winner_team_id === m.team_a_id) { a.wins++; b.losses++ }
    else if (m.winner_team_id === m.team_b_id) { b.wins++; a.losses++ }
  }
  for (const r of st.values()) r.game_diff = r.gf - r.ga

  // 승자승: 같은 승수 팀들끼리 경기에서 이긴 수
  const miniWins = (team: string, group: Set<string>) =>
    finished.filter(m => m.winner_team_id === team && group.has(m.team_a_id!) && group.has(m.team_b_id!)).length

  const manualOf = new Map(members.map(m => [m.team_id, m.manual_rank ?? null]))
  const rows = [...st.values()]
  const byWins = new Map<number, LeagueRow[]>()
  for (const r of rows) byWins.set(r.wins, [...(byWins.get(r.wins) || []), r])

  const ordered: LeagueRow[][] = []   // 동률 덩어리(순서대로)
  for (const w of [...byWins.keys()].sort((a, b) => b - a)) {
    const bucket = byWins.get(w)!
    const set = new Set(bucket.map(r => r.team_id))
    const key = (r: LeagueRow) => [miniWins(r.team_id, set), r.game_diff]
    bucket.sort((x, y) => { const [a1, a2] = key(x), [b1, b2] = key(y); return b1 - a1 || b2 - a2 })
    let i = 0
    while (i < bucket.length) {
      let j = i + 1
      const [k1, k2] = key(bucket[i])
      while (j < bucket.length && key(bucket[j])[0] === k1 && key(bucket[j])[1] === k2) j++
      ordered.push(bucket.slice(i, j))
      i = j
    }
  }

  let pos = 1
  const out: LeagueRow[] = []
  for (const chunk of ordered) {
    if (chunk.length === 1) { chunk[0].rank = pos; out.push(chunk[0]) }
    else {
      chunk.forEach(r => { r.tied = true; r.tieStart = pos; r.tieSize = chunk.length })
      const allManual = chunk.every(r => manualOf.get(r.team_id) != null)
      const manualVals = chunk.map(r => manualOf.get(r.team_id)!)
      // 저장된 수동 순위가 이 덩어리 자리(pos ~ pos+n-1) 안에서 모두 다를 때만 인정 (결과가 바뀌어 덩어리가 달라지면 다시 지정)
      const valid = allManual && new Set(manualVals).size === chunk.length
        && manualVals.every(v => v >= pos && v < pos + chunk.length)
      if (valid) {
        chunk.sort((a, b) => manualOf.get(a.team_id)! - manualOf.get(b.team_id)!)
        chunk.forEach((r, k) => { r.rank = pos + k; r.manual = true })
      }
      out.push(...chunk)
    }
    pos += chunk.length
  }
  return out
}

export function leagueAllFinished(matches: LeagueMatch[]): boolean {
  return matches.length > 0 && matches.every(m => m.status === 'FINISHED')
}

// ── 입상 (리그 순위 → 앱A 등수 / 리포트 표시) ──
// 1위 우승 · 2위 준우승 · 3·4위 4강 · (6팀 이상) 5~8위 8강 · 나머지 참가
export function leaguePlacement(rank: number, teamCount: number): { appA: string; report: string } {
  if (rank === 1) return { appA: '우승', report: '우승' }
  if (rank === 2) return { appA: '준우승', report: '준우승' }
  if (rank <= 4) return { appA: '4강', report: '3-4위' }
  if (teamCount >= 6 && rank <= 8) return { appA: '8강', report: '5-8위' }
  return { appA: '참가', report: '참가' }
}
