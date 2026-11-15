// 랭킹 시드 검증 (DB 쓰기 없음)
//   1) 조 배치(028 지그재그)와 본선 자리(044) 규칙을 같은 계산으로 재현해 확인
//   2) --live : 앱A DB 함수(현재 포인트)를 같은 규칙의 별도 계산과 대조 (읽기 전용, 공개 키)
// 실행: node --experimental-strip-types scripts/test-ranking-seed.mjs [--live]
import { readFileSync } from 'fs'
import { rankTeams } from '../src/lib/seed-ranking.ts'

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

console.log('3) 순위 정렬')
{
  const t = (id, total) => ({ id, name: id, p1: { name: id, club: null, points: total, matched: true }, p2: null, total })
  ok(rankTeams([t('x', 10), t('y', 30), t('z', 20)]).map(v => v.id).join() === 'y,z,x', '합산 높은 순')
}

// 포인트 규칙은 앱A DB 함수에 있다. 여기서는 같은 규칙을 따로 계산해 DB 함수 결과와 대조한다.
const seriesKey = name => {
  const raw = (name || '').trim()
  return raw.replace(/제\s*\d+\s*회/g, '').replace(/(19|20)\d{2}\s*년?(도)?/g, '').replace(/\s+/g, '').toLowerCase() || raw.replace(/\s+/g, '').toLowerCase()
}
function countedNames(rows) {
  const last = new Map()
  for (const r of rows) { const n = (r.tournament_name || '').trim(); if (!n) continue; if (!last.has(n) || (r.date || '') > (last.get(n) || '')) last.set(n, r.date || last.get(n) || null) }
  const top = new Map()
  for (const [n, d] of last) { const k = seriesKey(n), c = top.get(k); if (!c || (d || '') > (c.d || '') || ((d || '') === (c.d || '') && n > c.n)) top.set(k, { n, d }) }
  return new Set([...top.values()].map(v => v.n))
}
{
  ok(seriesKey('제2회TF컵 동호인대회') === seriesKey('제3회 TF컵 동호인대회'), 'TF컵 회차 묶음')
  ok(seriesKey('제6회 제주시테니스협회장배 클럽대항전') !== seriesKey('제 5회 제주시테니스협회장배 개인복식 테니스대회'), '클럽대항전 ≠ 개인복식')
  const rows = [
    { tournament_name: '제2회TF컵 동호인대회', date: '2026-02-21' }, { tournament_name: '제1회 팀H.B컵', date: '2026-09-19' },
    { tournament_name: '제3회 TF컵 동호인대회', date: '2027-02-20' },
  ]
  ok([...countedNames(rows)].sort().join('|') === '제1회 팀H.B컵|제3회 TF컵 동호인대회', '다음 회차가 들어오면 이전 회차만 빠짐')
  ok(countedNames(rows.slice(0, 2)).size === 2, '다음 회차 전에는 유지')
}

if (process.argv.includes('--live')) {
  console.log('4) 앱A DB 함수 대조 (읽기 전용)')
  const { createClient } = await import('@supabase/supabase-js')
  let c = readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1)
  const env = {}
  c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
  const a = createClient(env.APP_A_SUPABASE_URL, env.APP_A_ANON_KEY, { auth: { persistSession: false } })
  const page = async q => { const out = []; for (let from = 0; ; from += 1000) { const r = await q().range(from, from + 999); if (r.error) throw new Error(r.error.message); out.push(...r.data); if (r.data.length < 1000) break } return out }
  try {
    const rows = await page(() => a.from('tournament_results').select('member_id, tournament_name, date, points').order('id'))
    const names = countedNames(rows)
    const mine = new Map()
    for (const r of rows) if (r.member_id && names.has((r.tournament_name || '').trim())) mine.set(r.member_id, (mine.get(r.member_id) || 0) + (Number(r.points) || 0))
    const eds = await page(() => a.rpc('ranking_current_tournaments'))
    for (const e of eds) console.log(`   ${e.counted ? '반영' : '제외'}  ${e.last_date}  ${e.tournament_name}${e.replaced_by ? '  → ' + e.replaced_by : ''}`)
    ok([...names].sort().join('|') === eds.filter(e => e.counted).map(e => e.tournament_name).sort().join('|'), '반영 대회 목록 일치')
    const pts = await page(() => a.rpc('ranking_current_points'))
    const db = new Map(pts.map(p => [p.member_id, Number(p.total_points)]))
    let diff = 0
    for (const id of new Set([...mine.keys(), ...db.keys()])) if ((mine.get(id) || 0) !== (db.get(id) || 0)) diff++
    ok(diff === 0, `회원별 포인트 일치 (${db.size}명, 다른 회원 ${diff}명 — 수동 조정이 있으면 그만큼 다를 수 있음)`)
    // 현재 랭킹(0) 과 올해 시즌 랭킹 — 올해 대회만 있는 동안은 같아야 한다
    const mem = await page(() => a.from('members_public').select('division').not('division', 'is', null))
    const div = [...new Set(mem.map(m => m.division).filter(Boolean))][0]
    const [cur, season] = await Promise.all([0, new Date().getFullYear()].map(y => a.rpc('get_rankings', { p_division: div, p_season_year: y, p_limit: 2000, p_offset: 0 })))
    ok(!cur.error && cur.data.length > 0 && cur.data.every(p => p.total_points === (db.get(p.member_id) || 0)), `get_rankings(0) = 현재 포인트 (${div} ${cur.data?.length}명)`, cur.error?.message)
    console.log(`   ${div}: 현재 1위 ${cur.data?.[0]?.total_points}점 / ${new Date().getFullYear()}시즌 1위 ${season.data?.[0]?.total_points}점`)
    const h = await a.rpc('get_member_history', { p_member_id: cur.data[0].member_id, p_season_year: 0 })
    ok(!h.error && h.data?.ok && h.data.total_points === cur.data[0].total_points && h.data.history.every(x => typeof x.counted === 'boolean'), '회원 상세(0) 포인트·반영 표시')
  } catch (e) { ok(false, '앱A 조회: ' + e.message) }
}

console.log(`\n결과: ${pass}/${pass + fail} 통과`)
process.exit(fail ? 1 : 0)
