// 046 오프라인 검증 (PGlite) — 실서버 DB를 건드리지 않음
//   준비: 아무 빈 폴더에서 npm i @electric-sql/pglite@0.2.17 후 이 파일을 그 폴더로 복사
//   실행: node test-046-pglite.mjs <phase2-frontend/scripts/migrations 경로>
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'fs'
const db = new PGlite()
let pass = 0, fail = 0
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) }
const J = '00000000-0000-0000-0000-00000000000a'   // 주니어: 회천 8면
const A = '00000000-0000-0000-0000-00000000000b'   // 동호인: 연정 10면
const N = '00000000-0000-0000-0000-00000000000c'   // 경기장 없는 대회
const G = '00000000-0000-0000-0000-00000000000d'   // courts 배열 없이 약칭+면수만 있는 대회
const MJ = '00000000-0000-0000-0000-000000000001', MA = '00000000-0000-0000-0000-000000000002'
const MN = '00000000-0000-0000-0000-000000000003', MG = '00000000-0000-0000-0000-000000000004'
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE venues (id serial PRIMARY KEY, event_id uuid, name text, short_name text, court_count int, courts text[]);
CREATE TABLE matches (id uuid PRIMARY KEY, event_id uuid, court text, court_order int, status text DEFAULT 'PENDING', score text);
INSERT INTO venues (event_id, name, short_name, court_count, courts) VALUES
  ('${J}', '제주시생활체육공원', '회천', 8, ARRAY['회천-1','회천-2','회천-3','회천-4','회천-5','회천-6','회천-7','회천-8']),
  ('${A}', '연정정구장', '연정', 10, ARRAY['연정-1','연정-2','연정-3','연정-4','연정-5','연정-6','연정-7','연정-8','연정-9','연정-10']),
  ('${G}', '사라봉', ' 사라 ', 3, NULL);
-- 트리거가 생기기 전부터 잘못 들어가 있던 경기 (기존 데이터는 건드리지 않는지 확인용)
INSERT INTO matches (id, event_id, court, court_order) VALUES ('${MA}', '${A}', '회천-7', 1);
`)
const sql = readFileSync(`${process.argv[2]}/046-court-in-event-guard.sql`, 'utf8')
await db.exec(sql); await db.exec(sql)   // 멱등
const tryq = async (q, p) => { try { await db.query(q, p); return null } catch (e) { return e.message } }
const court = async id => (await db.query(`SELECT court, court_order, score FROM matches WHERE id = $1`, [id])).rows[0]
let e

// 기존 잘못된 값: court 를 안 건드리는 수정은 통과
e = await tryq(`UPDATE matches SET score = '6:3', status = 'FINISHED' WHERE id = $1`, [MA]); check(!e, '① 잘못된 코트가 남아 있어도 점수 입력은 됨', e)
e = await tryq(`UPDATE matches SET court_order = 4 WHERE id = $1`, [MA]); check(!e, '② 순서만 바꾸는 것도 됨', e)
e = await tryq(`UPDATE matches SET court = '회천-7', court_order = 5 WHERE id = $1`, [MA]); check(!e, '③ 같은 코트 값으로 다시 저장(변화 없음)은 됨', e)
// 사고 재현: 동호인 경기를 주니어 코트로
e = await tryq(`UPDATE matches SET court = '연정-8', court_order = 4 WHERE id = $1`, [MA]); check(!e, '④ 자기 대회 코트로 옮기기 → 됨', e)
e = await tryq(`UPDATE matches SET court = '회천-7', court_order = 1 WHERE id = $1`, [MA]); check(!!e && /이 대회 경기장의 코트가 아닙니다/.test(e), '⑤ 다른 대회 코트로 옮기기 → 거절', e)
let r = await court(MA); check(r.court === '연정-8' && r.court_order === 4, '⑥ 거절되면 코트·순서 그대로', r)
e = await tryq(`UPDATE matches SET court = '연정-11' WHERE id = $1`, [MA]); check(!!e, '⑦ 면수를 넘는 코트 → 거절', e)
e = await tryq(`UPDATE matches SET court = NULL, court_order = NULL WHERE id = $1`, [MA]); check(!e, '⑧ 코트 비우기 → 됨', e)
e = await tryq(`UPDATE matches SET court = '' WHERE id = $1`, [MA]); check(!e, '⑨ 빈 문자열 → 됨', e)
// INSERT
e = await tryq(`INSERT INTO matches (id, event_id, court, court_order) VALUES ($1, $2, '회천-3', 1)`, [MJ, J]); check(!e, '⑩ 새 경기 + 자기 대회 코트 → 됨', e)
e = await tryq(`INSERT INTO matches (id, event_id, court) VALUES ('00000000-0000-0000-0000-000000000009', $1, '연정-1')`, [J]); check(!!e, '⑪ 새 경기 + 다른 대회 코트 → 거절', e)
e = await tryq(`INSERT INTO matches (id, event_id) VALUES ('00000000-0000-0000-0000-000000000008', $1)`, [J]); check(!e, '⑫ 새 경기 + 코트 없음 → 됨', e)
// 경기장 없는 대회
e = await tryq(`INSERT INTO matches (id, event_id, court) VALUES ($1, $2, '코트-3')`, [MN, N]); check(!e, '⑬ 경기장 없는 대회는 검사 안 함', e)
e = await tryq(`UPDATE matches SET court = '아무거나' WHERE id = $1`, [MN]); check(!e, '⑭ 경기장 없는 대회: 어떤 이름이든 됨', e)
// courts 배열 없이 약칭+면수
e = await tryq(`INSERT INTO matches (id, event_id, court) VALUES ($1, $2, '사라-3')`, [MG, G]); check(!e, '⑮ 배열 없어도 약칭-번호(공백 제거) → 됨', e)
e = await tryq(`UPDATE matches SET court = '사라-4' WHERE id = $1`, [MG]); check(!!e, '⑯ 약칭-번호가 면수 초과 → 거절', e)
// 대회 자체를 바꾸는 경우
e = await tryq(`UPDATE matches SET event_id = $2 WHERE id = $1`, [MJ, A]); check(!!e, '⑰ 코트 그대로 두고 대회만 바꾸기 → 거절', e)
// 여러 줄 한꺼번에: 하나라도 틀리면 전부 취소
e = await tryq(`UPDATE matches SET court = '회천-1' WHERE event_id IN ($1, $2)`, [J, A]); check(!!e, '⑱ 여러 대회를 한꺼번에 같은 코트로 → 거절', e)
r = await court(MJ); check(r.court === '회천-3', '⑲ ⑱ 실패 뒤 원래 값 유지', r)
const acl = (await db.query(`SELECT has_function_privilege('anon', 'fn_matches_court_in_event()', 'EXECUTE') ok`)).rows[0].ok; check(!acl, '⑳ anon 이 함수를 직접 부를 수 없음')
// 되돌리기
await db.exec(readFileSync(`${process.argv[2]}/046-rollback.sql`, 'utf8'))
e = await tryq(`UPDATE matches SET court = '연정-1' WHERE id = $1`, [MJ]); check(!e, '㉑ 되돌리기 후엔 검사 없음', e)
console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
