// 본선 자리 (사용자 지시 2026-11-18)
//  - 조 1위는 조 번호 = 시드 번호 자리: 1번 맨 위, 2번 맨 아래, 3·4번은 서로 다른 4분의1 … (표준 시드 배열)
//  - 부전승은 2팀 조(순위 결정전만 하는 조) 1위에게 주지 않고, 3팀 조 1위에게 — 대진표 위·아래 절반에 고르게, 그 안에서는 앞 번호 조부터
//  - 조 2위는 같은 조 1위와 최대한 늦게 만나게(가능하면 반대편 절반) 배치
export function seatBracket(sizes) {
  const ng = sizes.length, total = ng * 2
  let size = 1; while (size < total) size *= 2
  let bp = [1, 2]
  while (bp.length < size) { const sum = bp.length * 2 + 1; bp = bp.flatMap(v => [v, sum - v]) }
  const byes = size - total, rounds = Math.log2(size)
  const big = sizes.map((s, i) => (s > 2 ? i + 1 : 0)).filter(Boolean)
  const small = sizes.map((s, i) => (s > 2 ? 0 : i + 1)).filter(Boolean)
  if (byes > ng) throw new Error('부전승이 조 수보다 많음 — 기존 방식 대상')
  // 부전승 받는 조: 3팀 조 먼저(모자라면 2팀 조), 위·아래 절반에 고르게(부전승이 적은 절반 먼저), 그 안에서는 앞 번호 조
  const halfOfSeed = g => (bp.indexOf(g) < size / 2 ? 0 : 1)
  const head = [], cnt = [0, 0]
  for (let i = 0; i < byes; i++) {
    const c = [...big, ...small].filter(g => !head.includes(g)).sort((a, b) => (small.includes(a) - small.includes(b)) || (cnt[halfOfSeed(a)] - cnt[halfOfSeed(b)]) || (a - b))[0]
    head.push(c); cnt[halfOfSeed(c)]++
  }
  const byeSeeds = new Set(head.map(g => size + 1 - g))             // 그 조 1위의 맞은편 자리
  const slots = []; for (let s = ng + 1; s <= size; s++) if (!byeSeeds.has(s)) slots.push(s)
  const pos = s => bp.indexOf(s)
  // 두 자리가 만나는 라운드 (1 = 첫 경기 … rounds = 결승). 일찍 만날수록 비용이 큼
  const meet = (a, b) => { let p = pos(a), q = pos(b), r = 0; while (p !== q) { p >>= 1; q >>= 1; r++ } return r }
  const cost = (g, s) => { const r = meet(g, s); return r === rounds ? 0 : Math.pow(100, rounds - r) * (1 + (ng - g) / (ng * 10)) }
  // 시작: 낮은 조부터 가장 싼 자리, 이후 두 조씩 바꿔 보며 개선
  const assign = new Map(), free = new Set(slots)
  for (let g = 1; g <= ng; g++) { let best = null; for (const s of free) if (best === null || cost(g, s) < cost(g, best) || (cost(g, s) === cost(g, best) && s > best)) best = s; assign.set(g, best); free.delete(best) }
  for (let improved = true; improved;) {
    improved = false
    for (let a = 1; a <= ng; a++) for (let b = a + 1; b <= ng; b++) {
      const sa = assign.get(a), sb = assign.get(b)
      if (cost(a, sb) + cost(b, sa) < cost(a, sa) + cost(b, sb) - 1e-9) { assign.set(a, sb); assign.set(b, sa); improved = true }
    }
  }
  const slot = new Map()
  for (let g = 1; g <= ng; g++) { slot.set(g, { g, r: 1 }); slot.set(assign.get(g), { g, r: 2 }) }
  let first = []
  for (let i = 0; i < size / 2; i++) first.push([slot.get(bp[2 * i]) || null, slot.get(bp[2 * i + 1]) || null])
  // 아래쪽 절반은 경기 순서를 뒤집어 2번 시드(2조 1위)가 대진표 맨 아래 경기에 오게 한다 (만나는 라운드는 그대로)
  first = [...first.slice(0, size / 4), ...first.slice(size / 4).reverse()]
  const sameHalf = []; for (let g = 1; g <= ng; g++) if (meet(g, assign.get(g)) < rounds) sameHalf.push(`${g}조(${['', '첫 경기', '2번째 라운드', '3번째 라운드', '4번째 라운드'][meet(g, assign.get(g))]}에서 재대결 가능)`)
  return { size, order: head, first, sameHalf }
}
