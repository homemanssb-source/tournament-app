// 개인전 점수 문자열 규칙
//   "6:4"       일반 (승자 먼저)
//   "w.o"       불참 — 승은 인정, 게임 득실에는 안 들어감
//   "3:2 w.o"   도중 기권 — 그때까지 점수 + w.o, 게임 득실에는 안 들어감
// DB 순위 계산(fn_group_game_diff)도 "숫자:숫자"만 득실로 센다.

const WO_TAIL = /\s*w\s*\.?\s*o\s*\.?\s*$/i

export function isWalkoverScore(score: string | null | undefined): boolean {
  return !!score && WO_TAIL.test(score)
}

// "6:4" 처럼 숫자 두 개만 있는 점수 → [앞, 뒤]. w.o·BYE·기타는 null (득실 계산에서 뺌)
export function parseScorePair(score: string | null | undefined): [number, number] | null {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(score || '')
  return m ? [Number(m[1]), Number(m[2])] : null
}

// 관리자 입력 정리: "wo", "W.O" → "w.o", "4:6" → "6:4" (승자 먼저), 형식 오류·동점은 error
export function normalizeAdminScore(raw: string): { score: string } | { error: string } {
  const s = raw.trim()
  if (!s) return { error: '점수를 입력해주세요.' }
  if (WO_TAIL.test(s)) {
    const head = s.replace(WO_TAIL, '').trim()
    if (!head) return { score: 'w.o' }
    const p = parseScorePair(head)
    if (!p) return { error: '도중 기권은 "3:2 w.o" 처럼 입력해주세요.' }
    return { score: `${p[0]}:${p[1]} w.o` }
  }
  const p = parseScorePair(s)
  if (!p) return { error: '점수는 6:4, w.o, 3:2 w.o 형식으로 입력해주세요.' }
  if (p[0] === p[1]) return { error: '동점은 저장할 수 없습니다.' }
  return { score: `${Math.max(...p)}:${Math.min(...p)}` }
}
