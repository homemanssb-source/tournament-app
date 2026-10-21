// 037 오프라인 검증 (PGlite) — 실서버 DB를 건드리지 않음
//   준비: 아무 빈 폴더에서 npm i @electric-sql/pglite@0.2.17 후 이 파일을 그 폴더로 복사
//   실행: node test-037-pglite.mjs <phase2-frontend/scripts/migrations 경로>
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
CREATE TYPE match_stage AS ENUM ('GROUP','FINALS');
CREATE TYPE match_status AS ENUM ('PENDING','IN_PROGRESS','FINISHED');
CREATE TABLE events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), court_zones jsonb DEFAULT '{}'::jsonb);
CREATE TABLE divisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, name text, match_date date);
CREATE TABLE venues (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, name text, short_name text, court_count int, courts text[], created_at timestamptz DEFAULT now());
CREATE TABLE teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, player1_name text, p1_club text, player2_name text, p2_club text);
CREATE TABLE matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, group_id uuid,
  stage match_stage, round text, slot int, match_num text, team_a_id uuid, team_b_id uuid, court text, court_order int,
  status match_status DEFAULT 'PENDING', score text, started_at timestamptz);
CREATE TABLE ties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, group_id uuid, round text,
  tie_order int, bracket_position int, club_a_id uuid, club_b_id uuid, winning_club_id uuid, status text DEFAULT 'pending',
  is_bye boolean DEFAULT false, court_number int, court_order int);
CREATE TABLE audit_log (id serial, event_id uuid, action text, actor_type text, actor text, target_table text, target_id uuid, details jsonb);
CREATE FUNCTION log_audit(p_event uuid, p_action text, p_actor_type text, p_actor text, p_table text, p_target uuid, p_details jsonb)
 RETURNS void LANGUAGE sql AS $$ INSERT INTO audit_log(event_id, action, actor_type, actor, target_table, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7) $$;
`)
for (const f of ['026-auto-fill-idle-court.sql', '027-auto-fill-player-conflict.sql', '033-court-zone-ok-enum.sql', '036-team-group3-winner-next.sql']) await db.exec(read(f))
check((await one(`SELECT md5(prosrc) m FROM pg_proc WHERE proname='fn_auto_fill_idle_court'`)).m === '9d8a6289fdbc4ea5e6b16a0d2fbbf8c1', '준비: 027 본문 md5 = 가드 값')

await db.exec(read('037-court-round-zones-autofill.sql'))
check((await one(`SELECT position('_court_zone_ok2' in prosrc) > 0 AS v FROM pg_proc WHERE proname='fn_auto_fill_idle_court'`)).v, '037 적용됨')
await db.exec(read('037-court-round-zones-autofill.sql'))
check(true, '037 재실행(멱등) 오류 없음')

// ── 기본 데이터 ──
const ev = (await one(`INSERT INTO events DEFAULT VALUES RETURNING id`)).id
const D1 = (await one(`INSERT INTO divisions(event_id,name,match_date) VALUES ($1,'A부','2026-10-25') RETURNING id`, [ev])).id
const D2 = (await one(`INSERT INTO divisions(event_id,name,match_date) VALUES ($1,'B부','2026-10-26') RETURNING id`, [ev])).id
await q(`INSERT INTO venues(event_id,name,short_name,court_count,courts,created_at) VALUES ($1,'가','가',3,NULL,now()-interval '1 day'),($1,'나','나',2,ARRAY['나-1','나-2'],now())`, [ev])
check(JSON.stringify((await one(`SELECT _event_court_names($1) n`, [ev])).n) === JSON.stringify(['가-1','가-2','가-3','나-1','나-2']), '코트 이름 순서 (생성 순, courts 우선)', (await one(`SELECT _event_court_names($1) n`, [ev])).n)
const team = async () => (await one(`INSERT INTO teams(event_id) VALUES ($1) RETURNING id`, [ev])).id
const setZones = z => q(`UPDATE events SET court_zones=$2::jsonb, auto_fill_courts=true WHERE id=$1`, [ev, JSON.stringify(z)])
const mk = async (o) => (await one(`INSERT INTO matches(event_id,division_id,stage,round,match_num,team_a_id,team_b_id,court,court_order,status)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [ev, o.div || D1, o.stage || 'FINALS', o.round, o.num || 'M', o.a || await team(), o.b || await team(), o.court || null, o.order || null, o.status || 'PENDING'])).id
const finish = id => q(`UPDATE matches SET status='FINISHED' WHERE id=$1`, [id])
const courtOf = async id => (await one(`SELECT court, status FROM matches WHERE id=$1`, [id]))
const reset = () => db.exec(`DELETE FROM matches; DELETE FROM ties; DELETE FROM audit_log;`)

// ① 개인전 라운드 구역
await setZones({ [D1]: { finals: ['가-1'], rounds: { '16강': ['가-2'] } } })
let r16 = await mk({ round: '16강', num: 'M-16' }), r8 = await mk({ round: '8강', num: 'M-8' })
let done = await mk({ round: '16강', num: 'X', court: '가-1', order: 1, status: 'IN_PROGRESS' })
await finish(done)
check((await courtOf(r16)).court === null && (await courtOf(r8)).court === '가-1', '① 가-1(본선 공통) 비면 8강을 데려오고 16강(가-2 전용)은 안 데려옴', [await courtOf(r16), await courtOf(r8)])
done = await mk({ round: '16강', num: 'Y', court: '가-2', order: 1, status: 'IN_PROGRESS' })
await finish(done)
check((await courtOf(r16)).court === '가-2' && (await courtOf(r16)).status === 'IN_PROGRESS', '① 가-2 비면 16강을 데려와 시작', await courtOf(r16))

// ② 라운드 칸에 직접 넣은 코트 우선 (가-3은 16강·본선 공통 둘 다)
await reset()
await setZones({ [D1]: { finals: ['가-3'], rounds: { '16강': ['가-3'] } } })
const e8 = await mk({ round: '8강', num: 'A-01' }), e16 = await mk({ round: '16강', num: 'Z-99' })
done = await mk({ round: '8강', num: 'X', court: '가-3', order: 1, status: 'IN_PROGRESS' })
await finish(done)
check((await courtOf(e16)).court === '가-3' && (await courtOf(e8)).court === null, '② 라운드 칸에 직접 넣은 16강을 먼저', [await courtOf(e16), await courtOf(e8)])

// ③ 코트 사용 시간
await reset()
await setZones({ _avail: { '*': { '가-1': { until: '00:00' } } } })   // 00:00 전까지 = 항상 닫힘
let w = await mk({ round: '8강', num: 'W' })
done = await mk({ round: '8강', num: 'X', court: '가-1', order: 1, status: 'IN_PROGRESS' })
await finish(done)
check((await courtOf(w)).court === null, '③ 사용 시간 밖 코트엔 안 올림')
check((await one(`SELECT _court_open('{"_avail":{"2026-10-25":{"가-1":{"from":"07:30","until":"10:00"}}}}'::jsonb,'2026-10-25','가-1','2026-10-25 00:30:00+00') v`)).v === true, '③ 09:30 KST 는 07:30~10:00 안')
check((await one(`SELECT _court_open('{"_avail":{"2026-10-25":{"가-1":{"from":"07:30","until":"10:00"}}}}'::jsonb,'2026-10-25','가-1','2026-10-25 01:00:00+00') v`)).v === false, '③ 10:00 KST 는 밖 (until 미포함)')
check((await one(`SELECT _court_open('{"_avail":{"2026-10-25":{"가-1":{"from":"07:30"}}}}'::jsonb,'2026-10-26','가-1','2026-10-25 21:00:00+00') v`)).v === true, '③ 다른 날짜 설정은 적용 안 됨')
check((await one(`SELECT _court_open('{"_avail":{"*":{"가-1":{"from":"11:00"}}}}'::jsonb,'2026-10-25','가-1','2026-10-25 01:00:00+00') v`)).v === false, '③ 모든 날(*) 설정 적용')

// ④ 구역·시간 설정 없음 = 예전과 같음 (어느 코트든)
await reset()
await setZones({})
w = await mk({ round: '8강', num: 'W' })
done = await mk({ round: '8강', num: 'X', court: '가-2', order: 1, status: 'IN_PROGRESS' })
await finish(done)
check((await courtOf(w)).court === '가-2', '④ 설정 없으면 예전처럼 데려옴')

// ⑤ 개인전: 같은 코트에 단체전 대전이 남아 있으면 안 데려옴
await reset()
const CA = await team(), CB = await team()
await q(`INSERT INTO ties(event_id,division_id,round,club_a_id,club_b_id,court_number,court_order,status) VALUES ($1,$2,'group',$3,$4,2,5,'pending')`, [ev, D1, CA, CB])
w = await mk({ round: '8강', num: 'W' })
done = await mk({ round: '8강', num: 'X', court: '가-2', order: 1, status: 'IN_PROGRESS' })
await finish(done)
check((await courtOf(w)).court === null, '⑤ 같은 코트(가-2=2번)에 단체전 대기 → 개인전 안 올림')

// ── 단체전 ──
const club = () => team()
const mkTie = async (o) => (await one(`INSERT INTO ties(event_id,division_id,group_id,round,tie_order,bracket_position,club_a_id,club_b_id,court_number,court_order,status)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [ev, o.div || D1, o.group || null, o.round || 'round_of_16', o.order || null, o.pos || null,
  o.a || await club(), o.b || await club(), o.cn || null, o.co || null, o.status || 'pending'])).id
const tieOf = async id => one(`SELECT court_number, court_order, status FROM ties WHERE id=$1`, [id])
const finTie = id => q(`UPDATE ties SET status='completed' WHERE id=$1`, [id])

// ⑥ 대전 끝 → 빈 코트에 다음 대전 배정만
await reset()
await setZones({})
let t1 = await mkTie({ round: 'quarter', pos: 2 }), t0 = await mkTie({ round: 'quarter', pos: 1 })
let cur = await mkTie({ round: 'round_of_16', cn: 4, co: 1, status: 'in_progress' })
await q(`INSERT INTO matches(event_id,division_id,stage,round,team_a_id,team_b_id,court,court_order,status) VALUES ($1,$2,'FINALS','8강',$3,$4,'나-1',7,'FINISHED')`, [ev, D1, await team(), await team()])
await finTie(cur)
check((await tieOf(t0)).court_number === 4 && (await tieOf(t0)).status === 'pending', '⑥ 대전 끝 → 다음 대전(대진 1번) 4번 코트 배정, 상태 그대로', await tieOf(t0))
check((await tieOf(t0)).court_order === 8, '⑥ 코트 순서 = 그 코트 개인전·단체전 중 최대 + 1', await tieOf(t0))
check((await tieOf(t1)).court_number === null, '⑥ 한 코트에 한 대전만')
check((await one(`SELECT count(*)::int n FROM audit_log WHERE actor='trg_z_auto_fill_idle_court_tie'`)).n === 1, '⑥ 감사 로그 남김')

// ⑦ 같은 코트에 대전이 남아 있으면 아무것도 안 함
await reset()
t0 = await mkTie({ round: 'quarter', pos: 1 })
cur = await mkTie({ round: 'round_of_16', cn: 1, co: 1, status: 'in_progress' })
await mkTie({ round: 'round_of_16', cn: 1, co: 2 })
await finTie(cur)
check((await tieOf(t0)).court_number === null, '⑦ 같은 코트에 대기 대전 있으면 안 올림')

// ⑧ 진행 중 클럽 / 미정 클럽 / 다른 날 / 부전승 제외, 단체전 라운드 구역
await reset()
await setZones({ [D1]: { rounds: { '8강': ['가-3'] } } })
const busyClub = await club()
await mkTie({ round: 'round_of_16', a: busyClub, cn: 5, co: 1, status: 'in_progress' })
const tBusy = await mkTie({ round: 'round_of_16', pos: 1, a: busyClub })
const tTbd = (await one(`INSERT INTO ties(event_id,division_id,round,bracket_position,club_a_id,status) VALUES ($1,$2,'round_of_16',2,$3,'pending') RETURNING id`, [ev, D1, await club()])).id
const tOther = await mkTie({ div: D2, round: 'round_of_16', pos: 3 })
const tQF = await mkTie({ round: 'quarter', pos: 1 })
const tOk = await mkTie({ round: 'round_of_16', pos: 9 })
cur = await mkTie({ round: 'round_of_16', cn: 1, co: 1, status: 'in_progress' })
await finTie(cur)
const got = await tieOf(tOk)
check(got.court_number === 1 && (await tieOf(tBusy)).court_number === null && (await tieOf(tTbd)).court_number === null && (await tieOf(tOther)).court_number === null && (await tieOf(tQF)).court_number === null,
  '⑧ 진행 중 클럽·미정·다른 날·8강(가-3 전용) 제외하고 16강 배정', { got, busy: await tieOf(tBusy), qf: await tieOf(tQF) })
cur = await mkTie({ round: 'round_of_16', cn: 3, co: 1, status: 'in_progress' })
await finTie(cur)
check((await tieOf(tQF)).court_number === 3, '⑧ 가-3(8강 전용) 비면 8강 배정', await tieOf(tQF))

// ⑨ 3팀 조: 036 순서 교체 후 같은 조 다음 대전(승자 대전)을 먼저
await reset()
await setZones({})
const G = (await one(`SELECT gen_random_uuid() g`)).g
const K1 = await club(), K2 = await club(), K3 = await club()
const g1 = await mkTie({ round: 'group', group: G, order: 1, a: K1, b: K2, cn: 2, co: 1, status: 'in_progress' })
const g2 = await mkTie({ round: 'group', group: G, order: 2, a: K1, b: K3 })
const g3 = await mkTie({ round: 'group', group: G, order: 3, a: K2, b: K3 })
const other = await mkTie({ round: 'group', order: 1 })
await q(`UPDATE ties SET status='completed', winning_club_id=$2 WHERE id=$1`, [g1, K2])
check((await tieOf(g3)).court_number === 2 && (await tieOf(g2)).court_number === null && (await tieOf(other)).court_number === null, '⑨ 승자(2번) 대전을 같은 코트에 먼저', { g2: await tieOf(g2), g3: await tieOf(g3) })

// ⑩ 스위치 꺼짐 → 아무것도 안 함
await reset()
await q(`UPDATE events SET auto_fill_courts=false WHERE id=$1`, [ev])
t0 = await mkTie({ round: 'quarter', pos: 1 })
cur = await mkTie({ round: 'round_of_16', cn: 1, co: 1, status: 'in_progress' })
await finTie(cur)
check((await tieOf(t0)).court_number === null, '⑩ ⚡ 꺼짐이면 안 함')

// ⑪ 되돌리기
await db.exec(read('037-rollback.sql'))
check((await one(`SELECT md5(prosrc) m FROM pg_proc WHERE proname='fn_auto_fill_idle_court'`)).m === '9d8a6289fdbc4ea5e6b16a0d2fbbf8c1', '⑪ 되돌리기 → 027 본문 그대로')
check((await one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname='trg_z_auto_fill_idle_court_tie'`)).n === 0, '⑪ 단체전 트리거 삭제')
// 다시 037 (되돌린 뒤 재적용 가능)
await db.exec(read('037-court-round-zones-autofill.sql'))
check((await one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname='trg_z_auto_fill_idle_court_tie'`)).n === 1, '⑪ 되돌린 뒤 다시 적용 가능')

// ⑫ 가드: 라이브 함수가 다르면 중단하고 아무것도 안 바뀜
await db.exec(read('037-rollback.sql'))
await db.exec(`CREATE OR REPLACE FUNCTION public.fn_auto_fill_idle_court() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$`)
let aborted = false
try { await db.exec(read('037-court-round-zones-autofill.sql')) } catch (e) { aborted = /037 중단/.test(e.message) }
try { await db.exec('ROLLBACK') } catch {}
check(aborted && (await one(`SELECT count(*)::int n FROM pg_proc WHERE proname='_court_zone_ok2'`)).n === 0, '⑫ 다른 본문이면 중단 + 새 함수 안 생김')

console.log(`\n${pass} 통과 / ${fail} 실패`)
process.exit(fail ? 1 : 0)
