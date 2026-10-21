// ============================================================
// 코트 구역 (events.court_zones) — 부서 × 라운드별 우선 코트 + 코트 사용 시간
//
// 저장 형태 (예전 형태와 호환 — 새 키가 없으면 예전과 똑같이 동작):
//   {
//     "<division_id>": {
//       "group":  ["회천-1", ...],          // 예선 (기존)
//       "finals": ["블샌-1", ...],          // 본선 공통 (기존)
//       "rounds": { "32강": [...], "16강": [...] }   // 라운드별 (새) — 비어 있으면 본선 공통을 씀
//     },
//     "_avail": {                           // 코트 사용 시간 (새) — 경기일별, "*" = 모든 날
//       "2026-10-25": { "회천-1": { "from": "07:30", "until": "10:00" } }
//     }
//   }
// DB 트리거(037)도 같은 규칙으로 읽는다 — 바꿀 때 scripts/migrations/037-*.sql 과 함께 바꿀 것.
// ============================================================

export const ROUND_KEYS = ['128강', '64강', '32강', '16강', '8강', '4강', '결승'] as const
export type RoundKey = typeof ROUND_KEYS[number]

export interface DivZone { group?: string[]; finals?: string[]; rounds?: Record<string, string[]> }
export interface CourtWindow { from?: string; until?: string }
export type AvailMap = Record<string, Record<string, CourtWindow>>   // date | '*' → court → window
export type CourtZones = Record<string, any> & { _avail?: AvailMap }

const ROUND_ALIASES: Record<string, RoundKey> = {
  '128강': '128강', R128: '128강', round_of_128: '128강',
  '64강': '64강', R64: '64강', round_of_64: '64강',
  '32강': '32강', R32: '32강', round_of_32: '32강',
  '16강': '16강', R16: '16강', round_of_16: '16강',
  '8강': '8강', QF: '8강', quarter: '8강',
  '4강': '4강', SF: '4강', semi: '4강',
  '결승': '결승', F: '결승', final: '결승',
}

// 경기의 stage/round → 'group' | 라운드 키 | null(본선이지만 라운드를 모름 → 본선 공통)
export function roundKeyOf(stage: string | null | undefined, round: string | null | undefined): 'group' | RoundKey | null {
  const s = (stage || '').toUpperCase(), r = round || ''
  if (s === 'GROUP' || r === 'group' || r === 'GROUP' || r === '조별') return 'group'
  return ROUND_ALIASES[r] || null
}

export function divZone(zones: CourtZones | null | undefined, divId: string): DivZone {
  const z = zones?.[divId]
  return z && typeof z === 'object' ? z as DivZone : {}
}

// 이 부서·라운드에 쓸 코트 목록 (빈 배열 = 제한 없음). 라운드 칸이 비면 본선 공통.
export function zoneCourts(zones: CourtZones | null | undefined, divId: string, key: 'group' | RoundKey | null): string[] {
  const z = divZone(zones, divId)
  if (key === 'group') return z.group || []
  const byRound = key ? (z.rounds?.[key] || []) : []
  return byRound.length > 0 ? byRound : (z.finals || [])
}

// 라운드 칸에 직접 넣은 코트인지 (본선 공통으로 따라온 게 아니라)
export function isRoundListed(zones: CourtZones | null | undefined, divId: string, key: 'group' | RoundKey | null, court: string): boolean {
  if (!key || key === 'group') return false
  return (divZone(zones, divId).rounds?.[key] || []).includes(court)
}

export function hasAnyZone(zones: CourtZones | null | undefined, divId: string): boolean {
  const z = divZone(zones, divId)
  return (z.group?.length || 0) > 0 || (z.finals?.length || 0) > 0 ||
    Object.values(z.rounds || {}).some(l => (l?.length || 0) > 0)
}

// ── 코트 사용 시간 ──
export function toMin(hhmm?: string | null): number | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
export function fromMin(min: number): string {
  const h = Math.floor(min / 60), m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
export function courtWindow(zones: CourtZones | null | undefined, date: string | null | undefined, court: string): CourtWindow | null {
  const a = zones?._avail
  if (!a) return null
  return (date && a[date]?.[court]) || a['*']?.[court] || null
}
// 이 시각(분)에 이 코트에서 경기를 시작할 수 있는지
export function courtOpenAt(zones: CourtZones | null | undefined, date: string | null | undefined, court: string, min: number): boolean {
  const w = courtWindow(zones, date, court)
  if (!w) return true
  const f = toMin(w.from), u = toMin(w.until)
  return (f == null || min >= f) && (u == null || min < u)
}
