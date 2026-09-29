// src/lib/slot-filled-notify.ts
// 본선 빈자리(TBD)가 채워졌을 때 새로 들어온 팀에게 알림
//
// 코트 알림은 "다음 대기 경기"를 기준으로 나가는데, 그 순간 본선 한쪽이 아직 미정이면
// "  vs 이순희"처럼 한 팀에게만 가고, 나중에 자리가 채워져도 들어온 팀은 알림을 못 받았다.
// (H.B컵 2026-09-19: 좌미경팀 8강·4강, 이승헌/정지우팀 8강 등)
//
// 규칙 (DB 변경 없이 push_logs 로 판단):
// - 대상: 본선(FINALS) · PENDING · 코트 배정됨 · 두 팀 다 정해짐 · 오늘(또는 날짜 없음) 경기
// - 같은 코트·부서에 "한 팀 이름 + 빈 상대" 로그가 있고 (= 한쪽 미정 상태로 알림이 나갔음)
// - 두 팀 이름이 모두 담긴 로그가 아직 없으면 (= 채워진 팀은 아직 못 받음)
// → 빈자리였던 팀에게만 발송하고 두 팀 이름으로 로그를 남긴다 (재실행해도 한 번만)

export type SlotMatch = {
  id: string
  court: string | null
  status: string
  stage: string
  round: string | null
  match_date: string | null
  division_name: string | null
  team_a_id: string | null
  team_b_id: string | null
  team_a_name: string | null
  team_b_name: string | null
}

export type SlotLog = {
  court: string | null
  division_name: string | null
  team_a_name: string | null
  team_b_name: string | null
}

export type SlotTarget = {
  match: SlotMatch
  teamId: string      // 알림 받을 팀 (빈자리였던 쪽)
}

const nm = (s: string | null | undefined) => (s || '').trim()

export function findFilledSlotTargets(matches: SlotMatch[], logs: SlotLog[], today: string): SlotTarget[] {
  const out: SlotTarget[] = []
  for (const m of matches) {
    if ((m.stage || '').toUpperCase() !== 'FINALS' || m.status !== 'PENDING' || !m.court) continue
    if (!m.team_a_id || !m.team_b_id) continue
    if (m.match_date && m.match_date !== today) continue
    const a = nm(m.team_a_name), b = nm(m.team_b_name)
    if (!a || !b) continue

    const same = logs.filter(l => l.court === m.court && nm(l.division_name) === nm(m.division_name))
    const names = (l: SlotLog) => [nm(l.team_a_name), nm(l.team_b_name)]
    const hasPair = same.some(l => { const [x, y] = names(l); return (x === a && y === b) || (x === b && y === a) })
    if (hasPair) continue
    const aAlone = same.some(l => { const [x, y] = names(l); return (x === a && !y) || (!x && y === a) })
    const bAlone = same.some(l => { const [x, y] = names(l); return (x === b && !y) || (!x && y === b) })

    // 한쪽만 미정으로 알림이 나갔던 경우만 — 둘 다 이름이 있던 적이 없으면 그 팀이 빈자리였던 것
    if (aAlone && !bAlone) out.push({ match: m, teamId: m.team_b_id })
    else if (bAlone && !aAlone) out.push({ match: m, teamId: m.team_a_id })
  }
  return out
}
