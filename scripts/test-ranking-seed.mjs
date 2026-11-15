// 랭킹 시드 검증 (DB 쓰기 없음)
//   1) 조 배치(028 지그재그)와 본선 자리(044) 규칙을 같은 계산으로 재현해 확인
//   2) --live : 앱A 실제 결과로 대회별 최신 회차 포인트 계산 확인 (읽기 전용, 공개 키)
// 실행: node --experimental-strip-types scripts/test-ranking-seed.mjs [--live]
import { readFileSync } from 'fs'
import { seriesKey, listEditions, rollingPoints, rankTeams } from '../src/lib/seed-ranking.ts'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m) } }

// ── 서버와 같은 조 크기 분배 (seed.ts calcGroupDistribution 과 동일) ──
function dist(total, size) {
  const r = total % size, f = Math.floor(total / size), out = []
  if (r === 0) for (let i = 0; i < f; i++) out.push(size)
  else if (r === 1) {
    for (let i = 0; i < f - 1; i++) out.push(size)
    out.push(...({ 2: [3], 3: [2, 2], 4: [3, 2], 5: [3, 3], 6: [4, 3] }[size]))
  } else { for (let i = 0; i < f; i++) out.push(size); out.push(r) }
  return out
}
// ── 028 rpc_generate_groups 의 시드 배치 (전 팀 시드) ──
function snake(total, size) {
  const sizes = dist(total, size), ng = sizes.length, groups = sizes.map(() => [])
  for (let si = 1; si <= total; si++) {
    let g = ((si - 1) % ng) + 1
    if (Math.floor((si - 1) / ng) % 2 === 1) g = ng - g + 1
    while (groups[g - 1].length >= sizes[g - 1]) g = (g % ng) + 1
    groups[g - 1].push(si)
  }
  return groups
}
// ── 044 rpc_generate_tournament 의 1·2위 자리 (시드 있는 부서) ──
function bracket(ng) {
  const total = ng * 2
  let size = 1; while (size < total) size *= 2
  let bp = [1, 2]
  while (bp.length < size) { const sum = bp.length * 2 + 1; bp = bp.flatMap(v => [v, sum - v]) }
  const nfr = size / 2
  const half = seed => (Math.ceil((bp.indexOf(seed) + 1) / 2) <= nfr / 2 ? 0 : 1)
  const upper = [], lower = []
  for (let s = ng + 1; s <= total; s++) (half(s) === 0 ? upper : lower).push(s)
  const slot = new Map()   // seed_num → { 조, 순위 }
  for (let k = 1; k <= ng; k++) slot.set(k, { g: k, r: 1 })
  for (let k = 1; k <= ng; k++) {
    const opp = half(k) === 0 ? lower : upper, own = half(k) === 0 ? upper : lower
    const s = opp.length ? opp.pop() : own.pop()
    slot.set(s, { g: k, r: 2 })
  }
  const first = []
  for (let i = 0; i < nfr; i++) first.push([slot.get(bp[2 * i]) || null, slot.get(bp[2 * i + 1]) || null])
  return { size, first }
}

console.log('1) 조 배치')
{
  const g = snake(32, 2)
  ok(g.length === 16 && g[0].join() === '1,32' && g[15].join() === '16,17', '32팀 2팀조: ' + JSON.stringify(g))
  const h = snake(48, 3)
  ok(h[0].join() === '1,32,33' && h[1].join() === '2,31,34' && h[15].join() === '16,17,48', '48팀 3팀조: ' + JSON.stringify(h))
  const j = snake(47, 3)
  ok(j.length === 16 && j[14].join() === '15,18,47' && j[15].join() === '16,17', '47팀: ' + JSON.stringify(j))
  const k = snake(46, 3)
  ok(k.length === 16 && k.flat().length === 46 && k[14].length === 2 && k[15].length === 2, '46팀: ' + JSON.stringify(k))
  const m = snake(33, 2)
  ok(m.length === 16 && m.flat().length === 33 && new Set(m.flat()).size === 33, '33팀: ' + JSON.stringify(m))
  console.log('   32팀 →', g.slice(0, 3).map(x => x.join('·')).join(' | '), '…', g[15].join('·'))
  console.log('   48팀 →', h.slice(0, 3).map(x => x.join('·')).join(' | '), '…', h[15].join('·'))
  console.log('   47팀 →', j.slice(13).map(x => x.join('·')).join(' | '))
}

console.log('2) 본선 자리')
const lab = s => (s ? `${s.g}조${s.r}위` : 'BYE')
for (const ng of [16, 12, 8, 6, 4]) {
  const b = bracket(ng)
  // 같은 조 두 팀은 서로 다른 절반 → 결승 전에는 못 만남
  const pos = new Map()
  b.first.forEach((m, i) => m.forEach(s => { if (s) pos.set(`${s.g}-${s.r}`, i < b.first.length / 2 ? 0 : 1) }))
  let sameHalf = 0
  for (let k = 1; k <= ng; k++) if (pos.get(`${k}-1`) === pos.get(`${k}-2`)) sameHalf++
  ok(sameHalf === 0, `${ng}개 조: 같은 조가 같은 절반 ${sameHalf}건`)
  ok(pos.size === ng * 2, `${ng}개 조: 자리 수 ${pos.size}`)
  // 1·2조 1위는 서로 다른 절반(결승에서만), 1~4조 1위는 서로 다른 4분의1(4강에서야)
  const quarter = new Map()
  b.first.forEach((m, i) => m.forEach(s => { if (s && s.r === 1) quarter.set(s.g, Math.floor(i / (b.first.length / 4))) }))
  ok(lab(b.first[0][0]) === '1조1위' && pos.get('1-1') !== pos.get('2-1'), `${ng}개 조: 1·2조 1위가 다른 절반`)
  ok(new Set([1, 2, 3, 4].map(g => quarter.get(g))).size === 4, `${ng}개 조: 1~4조 1위가 다른 4분의1`)
  console.log(`   ${ng}개 조 (${b.size}강): ` + b.first.slice(0, 4).map(m => m.map(lab).join(' vs ')).join(' | ') + ' …')
}
{
  const b = bracket(16)
  const find = (g, r) => b.first.find(m => m.some(s => s.g === g && s.r === r)).map(s => `${s.g}-${s.r}`).sort().join(' ')
  ok(find(1, 1) === '1-1 2-2', '1조1위 상대: ' + find(1, 1))
  ok(find(2, 1) === '1-2 2-1', '2조1위 상대: ' + find(2, 1))
  ok(find(3, 1) === '3-1 4-2', '3조1위 상대: ' + find(3, 1))
  ok(find(16, 1) === '15-2 16-1', '16조1위 상대: ' + find(16, 1))
}

console.log('3) 포인트 규칙')
{
  ok(seriesKey('제2회TF컵 동호인대회') === seriesKey('제3회 TF컵 동호인대회'), 'TF컵 회차 묶음')
  ok(seriesKey('제 5회 제주시테니스협회장배 개인복식 테니스대회') === seriesKey('제6회 제주시테니스협회장배 개인복식 테니스대회'), '협회장배 묶음')
  ok(seriesKey('제6회 제주시테니스협회장배 클럽대항전') !== seriesKey('제 5회 제주시테니스협회장배 개인복식 테니스대회'), '클럽대항전 ≠ 개인복식')
  const rows = [
    { member_id: 'a', tournament_name: '제2회TF컵 동호인대회', date: '2026-02-21', points: 100 },
    { member_id: 'b', tournament_name: '제2회TF컵 동호인대회', date: '2026-02-21', points: 70 },
    { member_id: 'a', tournament_name: '제1회 팀H.B컵', date: '2026-09-19', points: 50 },
    { member_id: 'b', tournament_name: '제3회 TF컵 동호인대회', date: '2027-02-20', points: 30 },
  ]
  const pts = rollingPoints(rows, listEditions(rows))
  ok(pts.get('a') === 50 && pts.get('b') === 30, '다음 회차가 들어오면 이전 회차 점수만 빠짐: ' + JSON.stringify([...pts]))
  const before = rows.slice(0, 3), pb = rollingPoints(before, listEditions(before))
  ok(pb.get('a') === 150 && pb.get('b') === 70, '다음 회차 전에는 해가 바뀌어도 유지: ' + JSON.stringify([...pb]))
  const t = (id, total) => ({ id, name: id, p1: { name: id, club: null, points: total, matched: true }, p2: null, total })
  ok(rankTeams([t('x', 10), t('y', 30), t('z', 20)]).map(v => v.id).join() === 'y,z,x', '합산 높은 순')
}

if (process.argv.includes('--live')) {
  console.log('4) 앱A 실제 데이터 (읽기 전용)')
  const { createClient } = await import('@supabase/supabase-js')
  let c = readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1)
  const env = {}
  c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
  const a = createClient(env.APP_A_SUPABASE_URL, env.APP_A_ANON_KEY, { auth: { persistSession: false } })
  const rows = []
  for (let from = 0; ; from += 1000) {
    const r = await a.from('tournament_results').select('member_id, tournament_name, date, points').order('id').range(from, from + 999)
    if (r.error) { ok(false, '결과 조회: ' + r.error.message); break }
    rows.push(...r.data); if (r.data.length < 1000) break
  }
  const ed = listEditions(rows), pts = rollingPoints(rows, ed)
  for (const e of ed) console.log(`   ${e.counted ? '반영' : '제외'}  ${e.date}  ${e.tournament_name}${e.replaced_by ? '  → ' + e.replaced_by : ''}`)
  const sum = [...pts.values()].reduce((x, y) => x + y, 0)
  const raw = rows.filter(r => r.member_id).reduce((x, r) => x + (Number(r.points) || 0), 0)
  console.log(`   결과 ${rows.length}행 · 포인트 있는 회원 ${[...pts.values()].filter(v => v > 0).length}명 · 유효 합계 ${sum} / 전체 ${raw}`)
  ok(ed.every(e => e.counted) ? sum === raw : sum <= raw, `합계: ${sum} / ${raw}`)
  const mp = await a.from('members_public').select('member_id, name, display_name, club, status').limit(1)
  ok(!mp.error && mp.data?.length === 1, 'members_public 조회: ' + (mp.error?.message || ''))
}

console.log(`\n결과: ${pass}/${pass + fail} 통과`)
process.exit(fail ? 1 : 0)
