// src/lib/court-zones.ts 규칙 확인 (DB 037 과 같은 규칙이어야 함)
//   node scripts/test-court-zones.mjs   (Node 22.6+ — .ts 직접 import)
import { roundKeyOf, zoneCourts, isRoundListed, hasAnyZone, courtOpenAt, courtWindow, toMin, fromMin } from '../src/lib/court-zones.ts'
let pass = 0, fail = 0
const check = (ok, label, got) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  → ' + JSON.stringify(got)}`) }
const D = 'div-1'
const Z = { [D]: { group: ['가-1'], finals: ['가-2'], rounds: { '16강': ['가-3'], '8강': [] } }, _avail: { '2026-10-25': { '회천-1': { from: '07:30', until: '10:00' } }, '*': { '블샌-4': { from: '11:00' } } } }
check(roundKeyOf('GROUP', '조별') === 'group' && roundKeyOf(null, 'group') === 'group', 'round key: 예선')
check(roundKeyOf('FINALS', '16강') === '16강' && roundKeyOf(null, 'round_of_16') === '16강' && roundKeyOf(null, 'quarter') === '8강' && roundKeyOf('FINALS', 'R32') === '32강', 'round key: 개인전·단체전 이름 통일')
check(roundKeyOf('FINALS', '3위전') === null, 'round key: 모르는 라운드 → null (본선 공통)')
check(JSON.stringify(zoneCourts(Z, D, 'group')) === '["가-1"]', '예선 구역')
check(JSON.stringify(zoneCourts(Z, D, '16강')) === '["가-3"]', '라운드 칸 우선')
check(JSON.stringify(zoneCourts(Z, D, '8강')) === '["가-2"]', '빈 라운드 칸 → 본선 공통')
check(JSON.stringify(zoneCourts(Z, D, null)) === '["가-2"]', '라운드 모름 → 본선 공통')
check(zoneCourts({}, D, '16강').length === 0 && !hasAnyZone({}, D) && hasAnyZone(Z, D), '설정 없음 = 제한 없음')
check(isRoundListed(Z, D, '16강', '가-3') && !isRoundListed(Z, D, '8강', '가-2'), '라운드 칸 직접 지정 여부')
check(courtOpenAt(Z, '2026-10-25', '회천-1', toMin('09:59')) && !courtOpenAt(Z, '2026-10-25', '회천-1', toMin('10:00')) && !courtOpenAt(Z, '2026-10-25', '회천-1', toMin('07:00')), '사용 시간 07:30~10:00')
check(courtOpenAt(Z, '2026-10-24', '회천-1', toMin('12:00')), '다른 날은 제한 없음')
check(!courtOpenAt(Z, '2026-10-24', '블샌-4', toMin('10:30')) && courtOpenAt(Z, '2026-10-24', '블샌-4', toMin('11:00')), '모든 날(*) 11:00~')
check(courtWindow(Z, '2026-10-25', '없는코트') === null && courtOpenAt(Z, '2026-10-25', '없는코트', 0), '설정 없는 코트 = 항상 열림')
check(fromMin(toMin('07:30') + 90) === '09:00', '시각 계산')
console.log(`\n${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0)
