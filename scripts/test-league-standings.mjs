// ============================================================
// 검증: 풀리그 순위 규칙 (src/lib/league.ts) — DB 안 씀
// 실행: node --experimental-strip-types scripts/test-league-standings.mjs
//  L1 승수 순     L2 2팀 동률 → 승자승     L3 3팀 물고물림 → 게임득실
//  L4 완전 동률 → 미결정, 수동 지정으로 해결 (덩어리 밖 값은 무시)
//  L5 입상 매핑 (5팀 / 6팀)     L6 예상 경기 수
// ============================================================
import { register } from 'node:module'
// '@/…' 경로(tsconfig paths)를 src/….ts 로 풀어 주는 작은 resolve 훅
const SRC = new URL('../src/', import.meta.url).href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@/')) s = ${JSON.stringify(SRC)} + s.slice(2) + '.ts'; return next(s, c) }`))
const { computeLeagueStandings, leaguePlacement, fullLeagueMatchCount, groupKnockoutMatchCount } = await import('../src/lib/league.ts')

let pass = 0, fail = 0
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++ }
const M = (a, b, score, w) => ({ status: 'FINISHED', score, team_a_id: a, team_b_id: b, winner_team_id: w === 'a' ? a : b })
const mem = (...ids) => ids.map(id => ({ team_id: id, team_name: id }))
const order = rows => rows.map(r => `${r.team_id}${r.rank ?? '?'}`).join(' ')

console.log('L1 승수 순')
let r = computeLeagueStandings(mem('A', 'B', 'C'), [M('A', 'B', '6:2', 'a'), M('A', 'C', '6:3', 'a'), M('B', 'C', '6:4', 'a')])
ok(order(r) === 'A1 B2 C3', order(r))

console.log('L2 2팀 동률 → 승자승 (득실은 반대여도)')
// A,B 2승1패 / B가 A를 이김 / A 득실이 더 좋음 → B 위
r = computeLeagueStandings(mem('A', 'B', 'C', 'D'), [
  M('A', 'B', '5:6', 'b'), M('A', 'C', '6:0', 'a'), M('A', 'D', '6:0', 'a'),
  M('B', 'C', '6:5', 'a'), M('B', 'D', '5:6', 'b'), M('C', 'D', '6:4', 'a'),
])
// 승수: A2 B2 C1 D1 → A·B 승자승 B, C·D 승자승 C
ok(order(r) === 'B1 A2 C3 D4', order(r))

console.log('L3 3팀 물고물림 → 게임득실')
r = computeLeagueStandings(mem('A', 'B', 'C'), [M('A', 'B', '6:0', 'a'), M('B', 'C', '6:4', 'a'), M('C', 'A', '6:5', 'a')])
// 모두 1승, 승자승 각 1 → 득실 A +5, B -4... A:+6-1=+5, B:-6+2=-4, C:-2+1=-1
ok(order(r) === 'A1 C2 B3', order(r))

console.log('L4 완전 동률 → 미결정 → 수동 지정')
const tieMs = [M('A', 'B', '6:4', 'a'), M('B', 'C', '6:4', 'a'), M('C', 'A', '6:4', 'a')]
r = computeLeagueStandings(mem('A', 'B', 'C'), tieMs)
ok(r.every(x => x.rank === null && x.tied && x.tieStart === 1 && x.tieSize === 3), '세 팀 모두 ? (동률 1~3위)')
r = computeLeagueStandings([{ team_id: 'A', team_name: 'A', manual_rank: 2 }, { team_id: 'B', team_name: 'B', manual_rank: 3 }, { team_id: 'C', team_name: 'C', manual_rank: 1 }], tieMs)
ok(order(r) === 'C1 A2 B3' && r.every(x => x.manual), `수동 순위 반영 (${order(r)})`)
r = computeLeagueStandings([{ team_id: 'A', team_name: 'A', manual_rank: 2 }, { team_id: 'B', team_name: 'B', manual_rank: 7 }, { team_id: 'C', team_name: 'C', manual_rank: 1 }], tieMs)
ok(r.every(x => x.rank === null), '덩어리 밖 값(7위)이 있으면 무시 → 다시 지정 필요')

console.log('L5 입상 매핑')
const p5 = [1, 2, 3, 4, 5].map(k => leaguePlacement(k, 5).appA).join(',')
ok(p5 === '우승,준우승,4강,4강,참가', `5팀: ${p5}`)
const p8 = [1, 2, 3, 4, 5, 8, 9].map(k => leaguePlacement(k, 9).appA).join(',')
ok(p8 === '우승,준우승,4강,4강,8강,8강,참가', `9팀: ${p8}`)
ok(leaguePlacement(3, 3).report === '3-4위', '3팀 3위 = 3-4위(리포트) / 4강(앱A)')

console.log('L6 예상 경기 수')
ok(fullLeagueMatchCount(5) === 10 && fullLeagueMatchCount(3) === 3, '풀리그 5팀 10경기, 3팀 3경기')
const g = groupKnockoutMatchCount([4, 4, 3, 3], 2)
ok(g.prelim === 18 && g.finals === 7 && g.minPerTeam === 2, `14팀(4,4,3,3) 예선 ${g.prelim} + 본선 ${g.finals}`)

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`)
process.exit(fail ? 1 : 0)
