// 039 오더 마감 계산(src/lib/lineup-deadline.ts) 검증
//   준비: 아무 빈 폴더에서 npm i typescript@5 후 이 파일을 그 폴더로 복사
//   실행: node test-039-deadline.mjs <phase2-frontend/src/lib/lineup-deadline.ts 경로>
// lineup-deadline.ts 를 typescript 로 변환해 실행
import ts from 'typescript'
import { readFileSync, writeFileSync } from 'fs'
const src = readFileSync(process.argv[2], 'utf8')
writeFileSync('./ld.mjs', ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText)
const { classifyPending, LINEUP_DEADLINE_MIN, pickBoardDate, filterBoardDate, kstToday } = await import('./ld.mjs')
let pass = 0, fail = 0
const check = (ok, label, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok ? '  → ' + JSON.stringify(d) : ''}`) }

const names = ['가-1', '가-2', '가-3']
const cn = n => (n ? names[n - 1] || null : null)
const T = (id, o) => ({ id, tie_order: 1, is_bye: false, club_a_id: 'A', club_b_id: 'B', lineup_revealed: false, status: 'pending',
  club_a_lineup_submitted: false, club_b_lineup_submitted: false, court_number: null, court_order: null, court_assigned_at: null, ended_at: null, ...o })
const M = (id, o) => ({ id, court: '가-1', court_order: 1, status: 'PENDING', ended_at: null, ...o })
const t0 = Date.parse('2026-11-01T01:00:00Z'), iso = ms => new Date(ms).toISOString(), min = 60000

// ① 코트에 앞 개인전 진행중 → 대기
let r = classifyPending([T('x', { court_number: 1, court_order: 2, court_assigned_at: iso(t0) })], [M('m1', { status: 'IN_PROGRESS' })], cn)
check(r.items[0].kind === 'waiting' && r.items[0].ahead === 1, '① 앞 경기 진행중 → 대기', r.items)

// ② 앞 경기 종료 → 차례, 마감 = 종료 + 10분 (배정은 더 일찍)
r = classifyPending([T('x', { court_number: 1, court_order: 2, court_assigned_at: iso(t0) })], [M('m1', { status: 'FINISHED', ended_at: iso(t0 + 30 * min) })], cn)
check(r.items[0].kind === 'turn' && r.items[0].deadline === t0 + 30 * min + LINEUP_DEADLINE_MIN * min, '② 앞 경기 종료 시각 + 10분', r.items)

// ③ 빈 코트에 나중에 배정 → 배정 + 10분
r = classifyPending([T('x', { court_number: 1, court_order: 2, court_assigned_at: iso(t0 + 50 * min) })], [M('m1', { status: 'FINISHED', ended_at: iso(t0 + 30 * min) })], cn)
check(r.items[0].deadline === t0 + 60 * min, '③ 빈 코트 배정 시각 + 10분', r.items)

// ④ 다른 코트 경기는 무시
r = classifyPending([T('x', { court_number: 2, court_assigned_at: iso(t0) })], [M('m1', { status: 'IN_PROGRESS' })], cn)
check(r.items[0].kind === 'turn', '④ 다른 코트 경기는 무관', r.items)

// ⑤ 앞 단체전 대전(court_order 없음 → 100+tie_order) 진행중
r = classifyPending([T('x', { court_number: 3, tie_order: 5 }), T('y', { court_number: 3, tie_order: 2, status: 'in_progress', lineup_revealed: true })], [], cn)
check(r.items.length === 1 && r.items[0].kind === 'waiting', '⑤ 앞 단체전 진행중 → 대기, 공개된 대전은 목록 제외', r.items)

// ⑥ 오더 없이 시작 / 코트 미배정 / 부전승 / 양팀 제출
r = classifyPending([
  T('s', { court_number: 1, status: 'in_progress' }),
  T('u', {}),
  T('b', { court_number: 2, is_bye: true }),
  T('d', { court_number: 2, club_a_lineup_submitted: true, club_b_lineup_submitted: true }),
  T('tbd', { court_number: 2, club_b_id: null }),
], [], cn)
check(r.items.length === 1 && r.items[0].kind === 'started' && r.unassigned === 1, '⑥ 시작됨·미배정 집계, 부전승·양팀제출·TBD 제외', r)

// ⑦ 시각 정보 없음 → deadline null
r = classifyPending([T('x', { court_number: 1 })], [], cn)
check(r.items[0].kind === 'turn' && r.items[0].deadline === null, '⑦ 배정 시각 없음(039 이전 배정) → 시각 모름', r.items)

// ⑧ 정렬: 시작됨 → 마감 이른 순 → 시각 모름 → 대기
r = classifyPending([
  T('w', { court_number: 1, court_order: 9 }),
  T('late', { court_number: 2, court_assigned_at: iso(t0 + 20 * min) }),
  T('nt', { court_number: 3, court_order: 1 }),
  T('early', { court_number: 3, court_order: 0, court_assigned_at: iso(t0) }),
], [M('m1', { status: 'IN_PROGRESS', court_order: 1 })], cn)
check(r.items[0].tie.id === 'early' && r.items[1].tie.id === 'late' && r.items.at(-1).kind === 'waiting', '⑧ 마감 이른 순, 대기는 마지막', r.items.map(i => [i.tie.id, i.kind]))

// ⑨ 현황판 날짜 — 오늘 경기일 → 오늘, 아니면 가장 가까운 날, 경기일 없으면 전부
check(pickBoardDate(['2026-11-01', '2026-10-31', null], '2026-10-31') === '2026-10-31', '⑨ 오늘 경기일이면 오늘')
check(pickBoardDate(['2026-11-01', '2026-10-31'], '2026-10-30') === '2026-10-31', '⑨ 대회 전날 → 첫날')
check(pickBoardDate(['2026-11-01', '2026-10-31'], '2026-11-05') === '2026-11-01', '⑨ 대회 뒤 → 마지막 날')
check(pickBoardDate([null, null], '2026-10-31') === null, '⑨ 경기일 없음 → null')
check(kstToday(Date.parse('2026-10-31T23:30:00Z')) === '2026-11-01', '⑨ 한국 시간 오늘 (UTC 23:30 = 다음날 08:30)')

// ⑩ 여러 날 대회: 같은 코트에 다음날 대전이 앞 순서 → 오늘 것만 보면 차례 (재성 10/31 회천-1 모양)
const divDates = { d31: '2026-10-31', d01: '2026-11-01', dn: null }
const ties10 = [
  T('w01', { division_id: 'd01', court_number: 1, court_order: 1 }),
  T('b01', { division_id: 'd01', court_number: 1, court_order: 6 }),
  T('b31', { division_id: 'd31', court_number: 1, court_order: 7, court_assigned_at: iso(t0) }),
  T('nd', { division_id: 'dn', court_number: 2, court_order: 1, court_assigned_at: iso(t0) }),
]
const ms10 = [M('m31', { court: '가-2', court_order: 0, status: 'FINISHED', ended_at: iso(t0 + 5 * min), match_date: '2026-10-31' }),
  M('m01', { court: '가-2', court_order: 0, status: 'PENDING', match_date: '2026-11-01' })]
r = classifyPending(ties10, ms10, cn)
check(r.items.find(i => i.tie.id === 'b31').kind === 'waiting', '⑩ 날짜 안 가르면 다음날 대전 때문에 대기 (고치기 전)', r.items.map(i => [i.tie.id, i.kind]))
const f = filterBoardDate(ties10, ms10, divDates, '2026-10-31')
check(f.ties.map(t => t.id).join() === 'b31,nd' && f.matches.map(m => m.id).join() === 'm31', '⑩ 10/31 만 남김 (날짜 없는 부서는 유지)', [f.ties.map(t => t.id), f.matches.map(m => m.id)])
r = classifyPending(f.ties, f.matches, cn)
const b31 = r.items.find(i => i.tie.id === 'b31'), nd = r.items.find(i => i.tie.id === 'nd')
check(b31.kind === 'turn' && b31.deadline === t0 + LINEUP_DEADLINE_MIN * min, '⑩ 오늘 대전은 차례, 마감 = 배정 + 10분', b31)
check(nd.kind === 'turn' && nd.deadline === t0 + 15 * min, '⑩ 다른 날 개인전 빼고 오늘 개인전 종료 기준', nd)
check(!r.items.some(i => i.tie.division_id === 'd01'), '⑩ 다음날 대전은 현황판에 없음')
check(filterBoardDate(ties10, ms10, divDates, null).ties.length === 4, '⑩ 날짜 null → 전부')

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
