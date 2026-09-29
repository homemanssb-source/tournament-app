// ============================================================
// 검증: 주장 PIN 보안 (migration 022a / 022b)
// 실행: node scripts/test-captain-pin-022.mjs a   (022a 적용 후 — 새 RPC 동작)
//       node scripts/test-captain-pin-022.mjs b   (022b 적용 후 — a 전부 + 잠금 확인)
// 임시 대회를 만들고 끝나면 스스로 지운다. 호출은 익명 키(외부 사용자와 같은 권한)로 한다.
//
//  A1  clubs.captain_pin 으로 쓰면 club_pins 로 복사
//  A2  주장 로그인: 맞는 PIN → 클럽 목록, 틀린 PIN 10회 → 잠금
//  A3  라인업 페이지 주장 확인: 틀린 PIN 거부, 맞는 PIN → 내 라인업만
//  A4  주장 점수 입력: 공개 전 거부 → 양 팀 제출(공개) 후 입력 → 같은 러버 재입력 거부, 다른 대전 러버 거부
//  A5  관리자 PIN 토큰: 주장 PIN 목록, 공개 전 라인업, 러버 입력/정정, 잘못된 토큰 거부
//  B1  익명으로 clubs.captain_pin 은 비어 있고 club_pins 는 못 읽음
//  B2  새 클럽을 PIN 과 함께 넣으면 clubs 는 NULL, club_pins 에만 저장
//  B3  익명은 공개 전 라인업을 못 읽고, 공개 후에는 읽음
//  B4  익명으로 운영 함수 실행 불가 (대진 생성, 관리자 점수 입력, 마스터 PIN 변경, 러버 PIN 점수, 순위 계산)
//  B5  관리자 PIN 로그인 5회 실패 → 잠금
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PHASE = (process.argv[2] || 'a').toLowerCase();
const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let eventId = null, pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

async function cleanup() {
  if (!eventId) return;
  const tieIds = (await sb.from('ties').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const clubIds = (await sb.from('clubs').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  if (tieIds.length) {
    await sb.from('tie_rubbers').delete().in('tie_id', tieIds);
    await sb.from('team_lineups').delete().in('tie_id', tieIds);
    await sb.from('pin_attempts').delete().in('target_key', tieIds.map(t => 'captain_tie:' + t));
  }
  await sb.from('pin_attempts').delete().in('target_key', ['captain_login:' + eventId, 'admin_pin:' + eventId, ...clubIds.map(c => 'club:' + c)]);
  await sb.from('ties').delete().eq('event_id', eventId);
  await sb.from('team_standings').delete().eq('event_id', eventId);
  await sb.from('admin_pin_sessions').delete().eq('event_id', eventId);
  await sb.from('audit_log').delete().eq('event_id', eventId);
  if (clubIds.length) {
    await sb.from('club_members').delete().in('club_id', clubIds);
    await sb.from('club_pins').delete().in('club_id', clubIds);
  }
  await sb.from('clubs').delete().eq('event_id', eventId);
  await sb.from('divisions').delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

const PIN_A = '731001', PIN_B = '731002', PIN_C = '731003', MASTER = '9731';
const rpcA = async (fn, args) => { const r = await anon.rpc(fn, args); return r.error ? { success: false, error: r.error.message, _err: true } : r.data; };
const lineupOf = (members) => [1, 2, 3].map(n => ({ rubber_number: n, player1_id: members[(n - 1) % 4].id, player2_id: members[n % 4].id }));

async function main() {
  const name = `__TEST_TEAM_pin022_${Date.now()}`;
  eventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'full_league', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'captain_pin', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;
  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '검증부', sort_order: 1 }).select().single(), '부서');
  const clubs = must(await sb.from('clubs').insert([
    { event_id: eventId, division_id: div.id, name: '핀A', captain_pin: PIN_A, seed_number: 1 },
    { event_id: eventId, division_id: div.id, name: '핀B', captain_pin: PIN_B, seed_number: 2 },
    { event_id: eventId, division_id: div.id, name: '핀C', captain_pin: PIN_C, seed_number: 3 },
  ]).select(), '클럽');
  const [A, B, C] = ['핀A', '핀B', '핀C'].map(n => clubs.find(c => c.name === n));
  const mem = {};
  for (const c of [A, B, C]) mem[c.id] = must(await sb.from('club_members').insert([1, 2, 3, 4].map(i => ({ club_id: c.id, name: `${c.name}-${i}`, member_order: i }))).select(), '선수');
  must(await sb.rpc('rpc_generate_full_league', { p_event_id: eventId, p_division_id: div.id }), '풀리그');
  const ties = must(await sb.from('ties').select('*').eq('event_id', eventId).order('tie_order'), '대전');
  const tAB = ties.find(t => [t.club_a_id, t.club_b_id].sort().join() === [A.id, B.id].sort().join());
  const tAC = ties.find(t => [t.club_a_id, t.club_b_id].sort().join() === [A.id, C.id].sort().join());
  const rub = async (tieId) => must(await sb.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number'), '러버');

  console.log('\nA1  club_pins 복사');
  const pins = must(await sb.from('club_pins').select('*').in('club_id', [A.id, B.id, C.id]), 'club_pins');
  ok(pins.length === 3 && pins.find(p => p.club_id === A.id)?.captain_pin === PIN_A, 'club_pins 에 3개 저장');

  console.log('\nA2  주장 로그인');
  let r = await rpcA('rpc_captain_login', { p_event_id: eventId, p_pin: PIN_A });
  ok(r.success && r.clubs?.length === 1 && r.clubs[0].id === A.id && r.clubs[0].division_name === '검증부', '맞는 PIN → 핀A (부서 이름 포함)');
  for (let i = 0; i < 10; i++) r = await rpcA('rpc_captain_login', { p_event_id: eventId, p_pin: String(100000 + i) });
  r = await rpcA('rpc_captain_login', { p_event_id: eventId, p_pin: PIN_A });
  ok(!r.success && /초과/.test(r.error || ''), `10회 실패 후 잠금 (${r.error})`);
  await sb.from('pin_attempts').delete().eq('target_key', 'captain_login:' + eventId);

  console.log('\nA3  라인업 페이지 주장 확인');
  r = await rpcA('rpc_captain_tie', { p_tie_id: tAB.id, p_pin: PIN_C });
  ok(!r.success, '다른 대전 주장 PIN 거부');
  const sideA = tAB.club_a_id === A.id ? 'a' : 'b';
  r = await rpcA('rpc_captain_tie', { p_tie_id: tAB.id, p_pin: PIN_A });
  ok(r.success && r.side === sideA && r.club_id === A.id && r.my_lineups.length === 0, `핀A 확인 (side ${r.side}), 라인업 없음`);
  r = await rpcA('rpc_submit_lineup', { p_tie_id: tAB.id, p_club_id: A.id, p_captain_pin: PIN_A, p_lineups: lineupOf(mem[A.id]) });
  ok(r.success && r.revealed === false, '핀A 라인업 제출 (미공개)');
  r = await rpcA('rpc_captain_tie', { p_tie_id: tAB.id, p_pin: PIN_A });
  ok(r.my_lineups.length === 3, '핀A 내 라인업 3개');
  r = await rpcA('rpc_captain_tie', { p_tie_id: tAB.id, p_pin: PIN_B });
  ok(r.success && r.my_lineups.length === 0, '핀B 에게 핀A 라인업 안 보임');

  console.log('\nA4  주장 점수 입력');
  let rs = await rub(tAB.id);
  r = await rpcA('rpc_captain_record_score', { p_tie_id: tAB.id, p_pin: PIN_A, p_rubber_id: rs[0].id, p_set1_a: 6, p_set1_b: 2 });
  ok(!r.success && /공개/.test(r.error || ''), `공개 전 거부 (${r.error})`);
  r = await rpcA('rpc_submit_lineup', { p_tie_id: tAB.id, p_club_id: B.id, p_captain_pin: PIN_B, p_lineups: lineupOf(mem[B.id]) });
  ok(r.success && r.revealed === true, '핀B 제출 → 공개');
  r = await rpcA('rpc_captain_record_score', { p_tie_id: tAB.id, p_pin: '000000', p_rubber_id: rs[0].id, p_set1_a: 6, p_set1_b: 2 });
  ok(!r.success, '틀린 PIN 거부');
  r = await rpcA('rpc_captain_record_score', { p_tie_id: tAB.id, p_pin: PIN_B, p_rubber_id: rs[0].id, p_set1_a: 6, p_set1_b: 2 });
  ok(r.success, '핀B 주장 입력 성공');
  r = await rpcA('rpc_captain_record_score', { p_tie_id: tAB.id, p_pin: PIN_A, p_rubber_id: rs[0].id, p_set1_a: 2, p_set1_b: 6 });
  ok(!r.success && /완료/.test(r.error || ''), '같은 러버 재입력 거부 (정정은 운영본부)');
  const rsAC = await rub(tAC.id);
  r = await rpcA('rpc_captain_record_score', { p_tie_id: tAB.id, p_pin: PIN_A, p_rubber_id: rsAC[0].id, p_set1_a: 6, p_set1_b: 2 });
  ok(!r.success, '다른 대전 러버 거부');

  console.log('\nA5  관리자 PIN 토큰');
  must(await sb.rpc('rpc_set_master_pin', { p_event_id: eventId, p_new_pin: MASTER }), '마스터 PIN');
  const login = await anon.rpc('rpc_admin_pin_login', { p_master_pin: MASTER, p_event_id: eventId });
  const token = login.data?.token;
  ok(!!token, '관리자 PIN 로그인');
  r = await rpcA('rpc_admin_pin_clubs', { p_token: token });
  ok(r.success && r.clubs.length === 3 && r.clubs.find(c => c.id === A.id)?.captain_pin === PIN_A, '주장 PIN 목록');
  r = await rpcA('rpc_admin_pin_clubs', { p_token: 'nope' });
  ok(!r.success, '잘못된 토큰 거부');
  r = await rpcA('rpc_submit_lineup', { p_tie_id: tAC.id, p_club_id: A.id, p_captain_pin: PIN_A, p_lineups: lineupOf(mem[A.id]) });
  r = await rpcA('rpc_admin_pin_tie_lineups', { p_token: token, p_tie_id: tAC.id });
  ok(r.success && r.lineups.length === 3, '공개 전 라인업도 관리자는 조회');
  rs = await rub(tAB.id);
  r = await rpcA('rpc_admin_pin_rubber_score', { p_token: token, p_rubber_id: rs[1].id, p_set1_a: 6, p_set1_b: 4 });
  ok(r.success && !r.corrected, '관리자 새 러버 입력');
  r = await rpcA('rpc_admin_pin_rubber_score', { p_token: token, p_rubber_id: rs[0].id, p_set1_a: 6, p_set1_b: 1 });
  ok(r.success && r.corrected === true, '관리자 완료 러버 정정');

  if (PHASE !== 'b') return;

  console.log('\nB1  익명 조회');
  const ac = must(await anon.from('clubs').select('*').eq('event_id', eventId), '익명 clubs');
  ok(ac.length === 3 && ac.every(c => c.captain_pin === null), 'clubs.captain_pin 모두 NULL');
  const ap = await anon.from('club_pins').select('*').in('club_id', [A.id]);
  ok(!!ap.error || (ap.data || []).length === 0, `club_pins 익명 조회 불가 (${ap.error?.message || '0행'})`);

  console.log('\nB2  새 클럽 PIN 저장 위치');
  const D = must(await sb.from('clubs').insert({ event_id: eventId, division_id: div.id, name: '핀D', captain_pin: '731004' }).select().single(), '핀D');
  ok(D.captain_pin === null, 'clubs.captain_pin NULL');
  ok((await sb.from('club_pins').select('captain_pin').eq('club_id', D.id).single()).data?.captain_pin === '731004', 'club_pins 에 저장');

  console.log('\nB3  라인업 공개 전/후');
  let al = must(await anon.from('team_lineups').select('id').eq('tie_id', tAC.id), '익명 라인업');
  ok(al.length === 0, '공개 전 (핀A만 제출) 익명 0행');
  r = await rpcA('rpc_submit_lineup', { p_tie_id: tAC.id, p_club_id: C.id, p_captain_pin: PIN_C, p_lineups: lineupOf(mem[C.id]) });
  al = must(await anon.from('team_lineups').select('id').eq('tie_id', tAC.id), '익명 라인업');
  ok(r.revealed && al.length === 6, '공개 후 6행');

  console.log('\nB4  익명 운영 함수 실행 불가');
  for (const [fn, args] of [
    ['rpc_generate_team_tournament_v2', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }],
    ['rpc_admin_record_score', { p_rubber_id: rs[2].id, p_set1_a: 6, p_set1_b: 0 }],
    ['rpc_admin_correct_rubber_score', { p_rubber_id: rs[0].id, p_set1_a: 0, p_set1_b: 6 }],
    ['rpc_set_master_pin', { p_event_id: eventId, p_new_pin: '0000' }],
    ['rpc_team_pin_score', { p_pin: rs[2].pin_code, p_rubber_id: rs[2].id, p_set1_a: 6, p_set1_b: 0 }],
    ['rpc_calculate_standings', { p_event_id: eventId, p_group_id: null, p_division_id: div.id }],
    ['rpc_create_team_groups', { p_event_id: eventId, p_group_count: 1, p_group_size: 4, p_division_id: div.id }],
  ]) {
    const x = await anon.rpc(fn, args);
    ok(!!x.error && /permission denied/i.test(x.error.message), `${fn} 거부 (${x.error?.message || '실행됨!'})`);
  }
  ok((await sb.from('tie_rubbers').select('status').eq('id', rs[2].id).single()).data.status === 'pending', '러버 3 그대로');

  console.log('\nB5  관리자 PIN 로그인 잠금');
  for (let i = 0; i < 5; i++) await anon.rpc('rpc_admin_pin_login', { p_master_pin: '1111', p_event_id: eventId });
  const lk = await anon.rpc('rpc_admin_pin_login', { p_master_pin: MASTER, p_event_id: eventId });
  ok(lk.data?.success === false && /초과/.test(lk.data?.error || ''), `5회 실패 후 잠금 (${lk.data?.error || lk.error?.message})`);
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과 (${PHASE}): ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
