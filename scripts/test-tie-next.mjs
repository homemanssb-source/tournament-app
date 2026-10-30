// 단체전 대전 종료 뒤 '다음 대전' 고르기(src/lib/tie-next.ts) 검증
//   준비: 아무 빈 폴더에서 npm i typescript@5 후 이 파일을 그 폴더로 복사
//   실행: node test-tie-next.mjs <phase2-frontend/src/lib/tie-next.ts 경로>
import ts from 'typescript'
import { readFileSync, writeFileSync } from 'fs'
const src = readFileSync(process.argv[2], 'utf8')
writeFileSync('./tn.mjs', ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText)
const { pickNextTie, courtNameOf } = await import('./tn.mjs')
let pass = 0, fail = 0
const check = (ok, label, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok ? '  → ' + JSON.stringify(d) : ''}`) }

const T = (id, o) => ({ id, status: 'pending', is_bye: false, court_number: 1, court_order: null, tie_order: 1, division_id: 'd31',
  club_a_id: 'A', club_b_id: 'B', ...o })
const dd = { d31: '2026-10-31', d01: '2026-11-01', dn: null }
const fin = T('f', { status: 'completed', court_order: 7 })

// ① 같은 코트 같은 날 다음 순서
let n = pickNextTie([fin, T('x', { court_order: 9 }), T('y', { court_order: 8 })], fin, dd)
check(n?.id === 'y', '① 같은 코트 다음 순서', n)

// ② 다른 날(11/1) 대전이 앞 순서여도 건너뜀 (재성 회천-1 모양)
n = pickNextTie([fin, T('w01', { division_id: 'd01', court_order: 1 }), T('r16', { court_order: 12 })], fin, dd)
check(n?.id === 'r16', '② 다른 날 대전 제외', n)

// ③ 다른 코트·완료·진행중·부전승 제외
n = pickNextTie([fin, T('c2', { court_number: 2, court_order: 8 }), T('done', { status: 'completed', court_order: 8 }),
  T('live', { status: 'in_progress', court_order: 8 }), T('bye', { is_bye: true, court_order: 8 }), T('ok', { court_order: 20 })], fin, dd)
check(n?.id === 'ok', '③ 다른 코트·완료·진행중·부전승 제외', n)

// ④ 두 팀 모두 미정이면 제외, 한 팀만 정해졌으면 포함
n = pickNextTie([fin, T('tbd', { court_order: 8, club_a_id: null, club_b_id: null }), T('half', { court_order: 9, club_b_id: null })], fin, dd)
check(n?.id === 'half', '④ 둘 다 TBD 제외, 한쪽 확정은 포함', n)

// ⑤ 남은 대전 없음 / 코트 없는 대전
check(pickNextTie([fin], fin, dd) === null, '⑤ 남은 대전 없음 → null')
check(pickNextTie([T('x', {})], T('f', { court_number: null }), dd) === null, '⑤ 코트 없는 대전 → null')

// ⑥ court_order 없으면 100+tie_order (CourtBoard 와 같은 기준) — 순서 있는 대전이 먼저
n = pickNextTie([fin, T('noord', { tie_order: 1 }), T('ord', { court_order: 50 })], fin, dd)
check(n?.id === 'ord', '⑥ court_order 없으면 100+tie_order', n)

// ⑦ 경기일 없는 부서는 날짜 무관
n = pickNextTie([fin, T('nd', { division_id: 'dn', court_order: 8 })], fin, dd)
check(n?.id === 'nd', '⑦ 날짜 없는 부서 포함', n)

// ⑧ 코트 이름 — 대회 전체 코트 목록 순번 (여러 경기장)
const vs = [{ short_name: '회천', courts: ['회천-1', '회천-2'] }, { name: '한라', court_count: 3 }]
check(courtNameOf(1, vs) === '회천-1' && courtNameOf(3, vs) === '한라-1' && courtNameOf(5, vs) === '한라-3', '⑧ 여러 경기장 순번 → 이름', [1, 3, 5].map(i => courtNameOf(i, vs)))
check(courtNameOf(9, vs) === '한라-9' && courtNameOf(2, []) === '코트-2', '⑧ 범위 밖 / 경기장 없음')

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
