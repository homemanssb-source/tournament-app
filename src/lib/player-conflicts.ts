// src/lib/player-conflicts.ts
// 같은 선수가 동시에 두 코트에 걸리는 경우 경고용 헬퍼
//
// 한 선수가 여러 부서(예: 학생 단식 + 복식)에 나가면, 각 부서 경기가 서로 다른
// 코트에서 동시에 진행되도록 배정될 수 있다. 앱은 팀 단위로만 경기를 다루므로
// 팀명("홍길동(제주중)/김철수(한라중)")을 선수 단위로 풀어 비교한다.
// 동명이인은 소속까지 같아야 같은 선수로 본다.

export interface CourtSlotMatch {
  id: string
  court: string | null
  court_order: number | null
  status: string
  team_a_name: string | null
  team_b_name: string | null
  division_name?: string | null
  is_team_tie?: boolean
}

export interface PlayerConflict {
  player: string        // "홍길동(제주중)"
  court: string         // 겹치는 다른 코트
  status: string        // 그 코트 경기 상태 (IN_PROGRESS | PENDING)
  division_name: string
}

// 팀명 → 선수 키 목록 ("이름(소속)" 또는 소속이 없으면 "이름")
export function playerKeys(teamName?: string | null): string[] {
  if (!teamName || teamName === 'TBD' || teamName === 'BYE') return []
  return teamName.split('/').map(p => p.trim()).filter(Boolean).map(p => {
    const m = p.match(/^(.+?)\((.+)\)$/)
    return m ? `${m[1].trim()}(${m[2].trim()})` : p
  })
}

function matchPlayers(m: CourtSlotMatch): string[] {
  if (m.is_team_tie) return []   // 단체전은 팀명이 클럽명이라 선수 비교 불가
  return [...playerKeys(m.team_a_name), ...playerKeys(m.team_b_name)]
}

// 코트마다 "지금 경기" = 진행 중인 경기, 없으면 첫 번째 대기 경기
export function currentCourtSlots(matches: CourtSlotMatch[]): CourtSlotMatch[] {
  const byCourt = new Map<string, CourtSlotMatch[]>()
  for (const m of matches) {
    if (!m.court || m.status === 'FINISHED') continue
    const list = byCourt.get(m.court) || []
    list.push(m)
    byCourt.set(m.court, list)
  }
  const slots: CourtSlotMatch[] = []
  for (const list of byCourt.values()) {
    list.sort((a, b) => (a.court_order ?? 9999) - (b.court_order ?? 9999))
    const cur = list.find(m => m.status === 'IN_PROGRESS') || list.find(m => m.status === 'PENDING')
    if (cur) slots.push(cur)
  }
  return slots
}

// 각 코트의 "지금 경기"끼리 같은 선수가 있으면 match id → 겹치는 상대 목록
export function findCourtConflicts(matches: CourtSlotMatch[]): Map<string, PlayerConflict[]> {
  const slots = currentCourtSlots(matches)
  const byPlayer = new Map<string, CourtSlotMatch[]>()
  for (const m of slots) {
    for (const p of new Set(matchPlayers(m))) {
      const list = byPlayer.get(p) || []
      list.push(m)
      byPlayer.set(p, list)
    }
  }
  const result = new Map<string, PlayerConflict[]>()
  for (const [player, list] of byPlayer) {
    if (list.length < 2) continue
    for (const m of list) {
      const others = list.filter(o => o.id !== m.id).map(o => ({
        player, court: o.court || '', status: o.status, division_name: o.division_name || '',
      }))
      result.set(m.id, [...(result.get(m.id) || []), ...others])
    }
  }
  return result
}

// 이 경기의 선수가 다른 코트에서 이미 진행 중인 경기 (경기 시작 전 확인용)
export function busyElsewhere(match: CourtSlotMatch, matches: CourtSlotMatch[]): PlayerConflict[] {
  const mine = new Set(matchPlayers(match))
  if (mine.size === 0) return []
  const out: PlayerConflict[] = []
  for (const o of matches) {
    if (o.id === match.id || o.status !== 'IN_PROGRESS') continue
    for (const p of matchPlayers(o)) {
      if (mine.has(p)) out.push({ player: p, court: o.court || '-', status: o.status, division_name: o.division_name || '' })
    }
  }
  return out
}

// "홍길동(제주중) — A-3 코트 진행중(U12 단식)" 형태
export function describeConflicts(list: PlayerConflict[]): string {
  return list.map(c =>
    `${c.player} — ${c.court} 코트 ${c.status === 'IN_PROGRESS' ? '진행중' : '대기'}${c.division_name ? `(${c.division_name})` : ''}`
  ).join(', ')
}
