// ============================================================
// 랭킹 시드 — 공용 타입 + 순위 정렬 (서버·화면·테스트 공용)
//
// 포인트 규칙은 앱A DB 함수에 있다 (ranking_current_points / ranking_current_tournaments):
//   대회마다 "가장 최근 회차"의 포인트만 유효. 같은 대회의 다음 회차 결과가 앱A에 들어오면
//   이전 회차 포인트는 빠진다 (그 대회 점수만 리셋). 수동 조정은 조정일로부터 1년.
//   같은 대회 판정: 대회명에서 "제N회"·연도·공백을 뺀 이름이 같으면 같은 대회.
// 앱A 랭킹 화면(현재 랭킹)과 같은 함수를 쓰므로 숫자가 항상 같다.
// ============================================================

export interface EditionInfo {
  tournament_name: string
  date: string | null          // 그 회차의 마지막 날
  series: string               // 같은 대회 묶음 키
  counted: boolean             // 포인트에 반영되는 회차인가
  replaced_by: string | null   // 반영 안 되면, 대신 반영되는 최신 회차 이름
}

export interface RankedPlayer { name: string; club: string | null; points: number; matched: boolean }
export interface RankedTeam {
  id: string
  name: string
  p1: RankedPlayer
  p2: RankedPlayer | null
  total: number
}
export interface SeedRankingResult {
  ok: boolean
  error?: string
  teams: RankedTeam[]          // 합산 포인트 높은 순 (동점은 추첨)
  tournaments: EditionInfo[]   // 최근 순
  unmatched: string[]          // 앱A 회원을 못 찾은 선수 (0점 처리)
}

// 합산 높은 순, 동점은 추첨 (rand 를 넣으면 테스트에서 고정 가능)
export function rankTeams(teams: RankedTeam[], rand: () => number = Math.random): RankedTeam[] {
  return teams
    .map(t => ({ t, r: rand() }))
    .sort((a, b) => (b.t.total - a.t.total) || (a.r - b.r))
    .map(x => x.t)
}
