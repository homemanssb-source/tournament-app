// ============================================================
// 랭킹 시드 — 포인트 계산 (순수 함수, 서버·화면·테스트 공용)
//
// 규칙: 대회마다 "가장 최근 회차"의 포인트만 유효하다.
//   같은 대회의 다음 회차 결과가 앱A에 들어오면 이전 회차 포인트는 빠진다 (그 대회 점수만 리셋).
//   해가 바뀌어도 다음 회차가 열리기 전까지는 유지된다.
// 같은 대회 판정: 대회명에서 "제N회"·연도·공백을 뺀 이름이 같으면 같은 대회.
//   예) "제2회TF컵 동호인대회" · "제3회 TF컵 동호인대회" → "tf컵동호인대회"
// ============================================================

export interface ResultRow {
  member_id: string | null
  tournament_name: string | null
  date: string | null
  points: number | null
}

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

export function seriesKey(name: string | null | undefined): string {
  const raw = (name || '').trim()
  const key = raw
    .replace(/제\s*\d+\s*회/g, '')
    .replace(/(19|20)\d{2}\s*년?(도)?/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  return key || raw.replace(/\s+/g, '').toLowerCase()
}

// 결과 행 전체 → 회차 목록 (대회 묶음별 최신 회차만 counted)
export function listEditions(rows: Pick<ResultRow, 'tournament_name' | 'date'>[]): EditionInfo[] {
  const byName = new Map<string, string | null>()
  for (const r of rows) {
    const n = (r.tournament_name || '').trim()
    if (!n) continue
    const prev = byName.get(n)
    if (prev === undefined || (r.date && (!prev || r.date > prev))) byName.set(n, r.date || prev || null)
  }
  const editions: EditionInfo[] = [...byName].map(([tournament_name, date]) => ({
    tournament_name, date, series: seriesKey(tournament_name), counted: false, replaced_by: null,
  }))
  const latest = new Map<string, EditionInfo>()
  for (const e of editions) {
    const cur = latest.get(e.series)
    if (!cur || (e.date || '') > (cur.date || '')) latest.set(e.series, e)
  }
  for (const e of editions) {
    const top = latest.get(e.series)!
    e.counted = top === e
    e.replaced_by = top === e ? null : top.tournament_name
  }
  return editions.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

// 회원별 유효 포인트 합계
export function rollingPoints(rows: ResultRow[], editions: EditionInfo[]): Map<string, number> {
  const counted = new Set(editions.filter(e => e.counted).map(e => e.tournament_name))
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!r.member_id || !counted.has((r.tournament_name || '').trim())) continue
    out.set(r.member_id, (out.get(r.member_id) || 0) + (Number(r.points) || 0))
  }
  return out
}

// 합산 높은 순, 동점은 추첨 (rand 를 넣으면 테스트에서 고정 가능)
export function rankTeams(teams: RankedTeam[], rand: () => number = Math.random): RankedTeam[] {
  return teams
    .map(t => ({ t, r: rand() }))
    .sort((a, b) => (b.t.total - a.t.total) || (a.r - b.r))
    .map(x => x.t)
}
