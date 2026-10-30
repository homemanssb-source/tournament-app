// 039 오프라인 검증 (PGlite) — 실서버 DB를 건드리지 않음
//   준비: 아무 빈 폴더에서 npm i @electric-sql/pglite@0.2.17 후 이 파일을 그 폴더로 복사
//   실행: node test-039-pglite.mjs <phase2-frontend/scripts/migrations 경로>
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'fs'
const MIG = process.argv[2]
const read = f => readFileSync(`${MIG}/${f}`, 'utf8')
const db = new PGlite()
let pass = 0, fail = 0
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) }
const q = async (sql, params) => (await db.query(sql, params)).rows
const one = async (sql, params) => (await q(sql, params))[0]

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE TABLE events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lineup_mode text DEFAULT 'captain_pin');
CREATE TABLE divisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, allow_empty_order boolean NOT NULL DEFAULT false);
CREATE TABLE clubs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, name text);
CREATE TABLE club_pins (club_id uuid PRIMARY KEY, captain_pin text);
CREATE TABLE club_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, name text);
CREATE TABLE ties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, club_a_id uuid, club_b_id uuid,
  rubber_count int DEFAULT 3, club_a_lineup_submitted boolean DEFAULT false, club_b_lineup_submitted boolean DEFAULT false,
  lineup_revealed boolean DEFAULT false, lineup_locked_at timestamptz, status text DEFAULT 'pending', court_number int);
CREATE TABLE team_lineups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tie_id uuid, club_id uuid, rubber_number int,
  player1_id uuid, player2_id uuid, submitted_by text, submitted_at timestamptz DEFAULT now(), is_revealed boolean DEFAULT false);
CREATE TABLE admin_pin_sessions (token text PRIMARY KEY, event_id uuid, is_active boolean DEFAULT true, expires_at timestamptz DEFAULT now() + interval '12 hours');
CREATE TABLE audit_log (id serial, event_id uuid, action text, actor_type text, actor text, target_table text, target_id uuid, details jsonb);
CREATE TABLE calls (fn text, tie uuid);
CREATE FUNCTION log_audit(p_event uuid, p_action text, p_actor_type text, p_actor text, p_table text, p_target uuid, p_details jsonb)
 RETURNS void LANGUAGE sql AS $$ INSERT INTO audit_log(event_id, action, actor_type, actor, target_table, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7) $$;
CREATE FUNCTION _pin_check_locked(k text) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
CREATE FUNCTION _pin_record_fail(k text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION _pin_record_success(k text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION _club_captain_pin(c uuid) RETURNS text LANGUAGE sql AS $$ SELECT captain_pin FROM club_pins WHERE club_id = c $$;
CREATE FUNCTION _admin_pin_event(p_token text) RETURNS uuid LANGUAGE sql AS $$
  SELECT event_id FROM admin_pin_sessions WHERE token = p_token AND is_active AND expires_at > now() LIMIT 1 $$;
CREATE FUNCTION rpc_apply_lineups_to_rubbers(t uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO calls VALUES ('apply', t) $$;
CREATE FUNCTION fn_team_apply_walkovers(t uuid) RETURNS int LANGUAGE sql AS $$ INSERT INTO calls VALUES ('wo', t); SELECT 0 $$;
`)
await db.exec(read('039-lineup-proxy-submit.sql'))
check(true, '039 적용')
await db.exec(read('039-lineup-proxy-submit.sql'))
check(true, '039 재실행(멱등)')

const ev = (await one(`INSERT INTO events DEFAULT VALUES RETURNING id`)).id
const ev2 = (await one(`INSERT INTO events DEFAULT VALUES RETURNING id`)).id
const dv = (await one(`INSERT INTO divisions(event_id) VALUES ($1) RETURNING id`, [ev])).id
const A = (await one(`INSERT INTO clubs(event_id,name) VALUES ($1,'A') RETURNING id`, [ev])).id
const B = (await one(`INSERT INTO clubs(event_id,name) VALUES ($1,'B') RETURNING id`, [ev])).id
const C = (await one(`INSERT INTO clubs(event_id,name) VALUES ($1,'C') RETURNING id`, [ev])).id
await q(`INSERT INTO club_pins VALUES ($1,'111111'),($2,'222222')`, [A, B])
const mem = async c => (await q(`INSERT INTO club_members(club_id,name) SELECT $1, 'm'||g FROM generate_series(1,6) g RETURNING id`, [c])).map(r => r.id)
const mA = await mem(A), mB = await mem(B)
const tie = async () => (await one(`INSERT INTO ties(event_id,division_id,club_a_id,club_b_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ev, dv, A, B])).id
const lu = m => JSON.stringify([1, 2, 3].map(n => ({ rubber_number: n, player1_id: m[(n - 1) * 2], player2_id: m[(n - 1) * 2 + 1] })))
await q(`INSERT INTO admin_pin_sessions(token,event_id) VALUES ('tok',$1),('tok2',$2)`, [ev, ev2])
await q(`INSERT INTO admin_pin_sessions(token,event_id,expires_at) VALUES ('old',$1,now()-interval '1 minute')`, [ev])

const T1 = await tie()
let r = (await one(`SELECT rpc_submit_lineup($1,$2,'000000',$3::jsonb) r`, [T1, A, lu(mA)])).r
check(r.success === false && /PIN/.test(r.error), '주장: 틀린 PIN 거부', r)
r = (await one(`SELECT rpc_submit_lineup($1,$2,'111111',$3::jsonb) r`, [T1, A, lu(mA)])).r
check(r.success === true && r.revealed === false, '주장: 맞는 PIN 제출 (공개 전)', r)
check((await one(`SELECT count(*)::int n FROM team_lineups WHERE tie_id=$1 AND submitted_by='captain'`, [T1])).n === 3, '주장 제출 submitted_by=captain')

r = (await one(`SELECT rpc_admin_pin_submit_lineup('old',$1,$2,$3::jsonb) r`, [T1, B, lu(mB)])).r
check(r.success === false && /만료/.test(r.error), '현장: 만료 세션 거부', r)
r = (await one(`SELECT rpc_admin_pin_submit_lineup('tok2',$1,$2,$3::jsonb) r`, [T1, B, lu(mB)])).r
check(r.success === false && /찾을 수 없/.test(r.error), '현장: 다른 대회 세션 거부', r)
r = (await one(`SELECT rpc_admin_pin_submit_lineup('tok',$1,$2,$3::jsonb) r`, [T1, C, lu(mB)])).r
check(r.success === false && /참가하는 클럽이 아닙/.test(r.error), '현장: 대전에 없는 클럽 거부', r)
const dup = JSON.stringify([{ rubber_number: 1, player1_id: mB[0], player2_id: mB[1] }, { rubber_number: 2, player1_id: mB[0], player2_id: mB[2] }, { rubber_number: 3, player1_id: mB[3], player2_id: mB[4] }])
r = (await one(`SELECT rpc_admin_pin_submit_lineup('tok',$1,$2,$3::jsonb) r`, [T1, B, dup])).r
check(r.success === false && /중복/.test(r.error), '현장: 선수 중복 거부 (주장과 같은 규칙)', r)
r = (await one(`SELECT rpc_admin_pin_submit_lineup('tok',$1,$2,$3::jsonb) r`, [T1, B, lu(mA)])).r
check(r.success === false && /소속/.test(r.error), '현장: 다른 클럽 선수 거부', r)
check((await one(`SELECT count(*)::int n FROM audit_log`)).n === 0, '실패한 대리입력은 감사 로그 없음')

r = (await one(`SELECT rpc_admin_pin_submit_lineup('tok',$1,$2,$3::jsonb) r`, [T1, B, lu(mB)])).r
check(r.success === true && r.revealed === true, '현장: 대리입력 → 상대가 냈으니 즉시 공개', r)
const t1 = await one(`SELECT * FROM ties WHERE id=$1`, [T1])
check(t1.lineup_revealed && t1.status === 'lineup_ready' && t1.lineup_locked_at, '대전 공개·확정 상태', t1)
check((await one(`SELECT count(*)::int n FROM team_lineups WHERE tie_id=$1 AND club_id=$2 AND submitted_by='admin' AND is_revealed`, [T1, B])).n === 3, '대리입력 submitted_by=admin, 공개됨')
check((await one(`SELECT count(*)::int n FROM calls WHERE tie=$1`, [T1])).n === 2, '공개 시 러버 반영·공오더 처리 호출')
const au = await one(`SELECT * FROM audit_log`)
check(au?.action === 'admin_pin_submit_lineup' && au.actor === 'tok' && au.details.club_id === B, '감사 로그 기록', au)

r = (await one(`SELECT rpc_admin_pin_submit_lineup('tok',$1,$2,$3::jsonb) r`, [T1, A, lu(mA)])).r
check(r.success === false && /확정/.test(r.error), '공개 후 대리입력 거부', r)

const T2 = await tie()
r = (await one(`SELECT rpc_admin_submit_lineup($1,$2,$3::jsonb) r`, [T2, A, lu(mA)])).r
check(r.success === true && r.revealed === false, '대시보드: 대리입력 (상대 미제출 → 공개 안 됨)', r)
r = (await one(`SELECT rpc_submit_lineup($1,$2,'111111',$3::jsonb) r`, [T2, A, lu([...mA].reverse())])).r
check(r.success === true, '공개 전이면 주장이 다시 제출해 덮어쓰기 가능', r)
check((await one(`SELECT count(*)::int n FROM team_lineups WHERE tie_id=$1 AND club_id=$2 AND submitted_by='captain'`, [T2, A])).n === 3, '덮어쓴 뒤 submitted_by=captain')
check((await one(`SELECT actor_type FROM audit_log WHERE action='admin_submit_lineup'`)).actor_type === 'operator', '대시보드 감사 로그')

// 공오더
await q(`UPDATE divisions SET allow_empty_order=true WHERE id=$1`, [dv])
const T3 = await tie()
const emp = JSON.stringify([{ rubber_number: 1, player1_id: '', player2_id: '' }, { rubber_number: 2, player1_id: mB[0], player2_id: mB[1] }, { rubber_number: 3, player1_id: mB[2], player2_id: mB[3] }])
r = (await one(`SELECT rpc_admin_submit_lineup($1,$2,$3::jsonb) r`, [T3, B, emp])).r
check(r.success === true && r.empty_rubbers === 1, '허용 부서 공오더 대리입력', r)

// 권한
const priv = async (fn, role) => (await one(`SELECT has_function_privilege($2, $1, 'EXECUTE') v`, [fn, role])).v
check(!(await priv('_team_store_lineup(uuid,uuid,jsonb,text)', 'anon')) && !(await priv('_team_store_lineup(uuid,uuid,jsonb,text)', 'authenticated')), '내부 함수 외부 실행 불가')
check(!(await priv('rpc_admin_submit_lineup(uuid,uuid,jsonb)', 'anon')) && await priv('rpc_admin_submit_lineup(uuid,uuid,jsonb)', 'authenticated'), '대시보드 RPC: 로그인만')
check(await priv('rpc_admin_pin_submit_lineup(text,uuid,uuid,jsonb)', 'anon'), '현장 RPC: 익명(토큰 검사) 실행 가능')

// 코트 배정 시각 트리거
const T9 = await tie()
check((await one(`SELECT court_assigned_at FROM ties WHERE id=$1`, [T9])).court_assigned_at === null, '배정 전 court_assigned_at 없음')
await q(`UPDATE ties SET court_number=2 WHERE id=$1`, [T9])
const at1 = (await one(`SELECT court_assigned_at FROM ties WHERE id=$1`, [T9])).court_assigned_at
check(at1 !== null, '코트 배정 → 시각 기록')
await q(`UPDATE ties SET court_assigned_at = now() - interval '1 hour' WHERE id=$1`, [T9])
await q(`UPDATE ties SET status='lineup_phase', court_number=2 WHERE id=$1`, [T9])
check((await one(`SELECT court_assigned_at < now() - interval '50 minutes' v FROM ties WHERE id=$1`, [T9])).v, '같은 코트로 다시 저장·다른 칸 수정 → 시각 유지')
await q(`UPDATE ties SET court_number=3 WHERE id=$1`, [T9])
check((await one(`SELECT court_assigned_at > now() - interval '1 minute' v FROM ties WHERE id=$1`, [T9])).v, '다른 코트로 이동 → 새 시각')
await q(`UPDATE ties SET lineup_alerted_at = now() WHERE id=$1`, [T9])
await q(`UPDATE ties SET status='lineup_phase' WHERE id=$1`, [T9])
check((await one(`SELECT lineup_alerted_at FROM ties WHERE id=$1`, [T9])).lineup_alerted_at !== null, '자동 알림 표시 — 다른 칸 수정엔 유지')
await q(`UPDATE ties SET court_number=1 WHERE id=$1`, [T9])
check((await one(`SELECT lineup_alerted_at FROM ties WHERE id=$1`, [T9])).lineup_alerted_at === null, '코트 이동 → 자동 알림 표시 지움 (새 차례에 다시 알림)')
await q(`UPDATE ties SET court_number=NULL WHERE id=$1`, [T9])
check((await one(`SELECT court_assigned_at FROM ties WHERE id=$1`, [T9])).court_assigned_at === null, '배정 해제 → 시각 지움')
const T10 = (await one(`INSERT INTO ties(event_id,club_a_id,club_b_id,court_number) VALUES ($1,$2,$3,1) RETURNING court_assigned_at`, [ev, A, B]))
check(T10.court_assigned_at !== null, '코트 지정해서 생성 → 시각 기록')

// 되돌리기
await db.exec(read('039-rollback.sql'))
const T4 = await tie()
r = (await one(`SELECT rpc_submit_lineup($1,$2,'111111',$3::jsonb) r`, [T4, A, lu(mA)])).r
check(r.success === true && !(await one(`SELECT count(*)::int n FROM pg_proc WHERE proname IN ('_team_store_lineup','rpc_admin_submit_lineup','rpc_admin_pin_submit_lineup')`)).n, '되돌리기 후 023 제출 동작 + 새 함수 삭제', r)
check(!(await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='ties' AND column_name IN ('court_assigned_at','lineup_alerted_at')`)).n, '되돌리기 후 추가 칸 삭제')

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
