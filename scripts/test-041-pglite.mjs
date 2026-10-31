// 041 오프라인 검증 (PGlite) — 실서버 DB를 건드리지 않음
//   준비: 아무 빈 폴더에서 npm i @electric-sql/pglite@0.2.17 후 이 파일을 그 폴더로 복사
//   실행: node test-041-pglite.mjs <phase2-frontend/scripts/migrations 경로>
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'fs'
const db = new PGlite()
let pass = 0, fail = 0
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) }
const call = async (tie, pin, side) => (await db.query(`SELECT rpc_captain_tie($1::uuid, $2, $3) r`, [tie, pin, side])).rows[0].r
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b', C = '00000000-0000-0000-0000-00000000000c'
const T1 = '00000000-0000-0000-0000-000000000001', T2 = '00000000-0000-0000-0000-000000000002'
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE ties (id uuid PRIMARY KEY, club_a_id uuid, club_b_id uuid);
CREATE TABLE team_lineups (tie_id uuid, club_id uuid, rubber_number int, player1_id uuid, player2_id uuid);
CREATE TABLE club_pins (club_id uuid PRIMARY KEY, captain_pin text);
CREATE TABLE fails (k text);
CREATE FUNCTION _club_captain_pin(uuid) RETURNS text LANGUAGE sql AS $$ SELECT captain_pin FROM club_pins WHERE club_id = $1 $$;
CREATE FUNCTION _pin_check_locked(text) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
CREATE FUNCTION _pin_record_fail(text, int, int) RETURNS void LANGUAGE sql AS $$ INSERT INTO fails VALUES ($1) $$;
CREATE FUNCTION _pin_record_success(text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
INSERT INTO club_pins VALUES ('${A}', '111111'), ('${B}', '111111'), ('${C}', '222222');
INSERT INTO ties VALUES ('${T1}', '${A}', '${B}'), ('${T2}', '${A}', '${C}');
INSERT INTO team_lineups VALUES ('${T1}', '${B}', 1, NULL, NULL);
`)
const sql = readFileSync(`${process.argv[2]}/041-captain-tie-side.sql`, 'utf8')
await db.exec(sql); await db.exec(sql)   // 멱등
let r
r = await call(T1, '111111', null); check(r.success && r.side === 'a' && r.both_sides === true && r.club_id === A, '① 같은 PIN 양팀 → 기본 a + both_sides', r)
r = await call(T1, '111111', 'b'); check(r.side === 'b' && r.club_id === B && r.opponent_id === A && r.my_lineups.length === 1, '② p_side b → B팀, B팀 오더', r)
r = await call(T2, '222222', 'a'); check(r.side === 'b' && r.both_sides === false, '③ 한쪽만 맞으면 p_side 무시', r)
r = await call(T2, '111111', 'b'); check(r.side === 'a' && r.both_sides === false, '④ A만 맞는데 b 요청 → a', r)
r = await call(T2, '999999', null); check(!r.success, '⑤ 틀린 PIN → 실패', r)
const f = (await db.query(`SELECT count(*)::int n FROM fails`)).rows[0].n; check(f === 1, '⑥ 실패 1회 기록', f)
const acl = (await db.query(`SELECT has_function_privilege('anon', 'rpc_captain_tie(uuid,text,text)', 'EXECUTE') ok`)).rows[0].ok; check(acl, '⑦ anon 실행 가능')
console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
