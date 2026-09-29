// ============================================================
// 검증: 단체전 토너먼트 다음 라운드 러버 보호 (migration 019)
// 실행: node scripts/test-team-advance-no-wipe.mjs   (임시 대회를 만들고 끝나면 스스로 지운다)
//
//  준비: 4클럽, 준결승 2개(pos1: A vs B, pos2: C vs D) + 결승 1개, 3복식
//  T1  준결승1 2:0 → A가 결승 club_a, 결승 러버는 아직 없음
//  T2  준결승2 2:0 → C가 결승 club_b, 결승 러버 3개 생성
//  T3  결승 라인업 제출(양팀) + 결승 1복식 점수 입력
//  T4  준결승1 남은 3복식 점수 입력 → 거부, 결승 러버(id·점수·선수) 그대로
//  T5  준결승1 진출 처리를 다시 호출 → 결승 러버 그대로 (재실행 안전)
//  T6  준결승1 승자를 강제로 B로 바꾸고 진출 처리 → 결승이 시작됐으므로 거부, 결승 club_a 는 A 유지
//  T7  대진 미확정(TBD) 대전의 러버 점수 입력 → 거부
//  T8  풀리그 대전은 2:0 뒤에도 3복식 입력 가능 (011 동작 유지)
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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
  }
  await sb.from('ties').delete().eq('event_id', eventId);
  await sb.from('team_standings').delete().eq('event_id', eventId);
  if (clubIds.length) await sb.from('club_members').delete().in('club_id', clubIds);
  await sb.from('clubs').delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

const rubbersOf = async (tieId) => must(await sb.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number'), '러버 조회');
const tieOf = async (tieId) => must(await sb.from('ties').select('*').eq('id', tieId).single(), '대전 조회');
const score = async (rubberId, a, b) => must(await sb.rpc('rpc_record_rubber_score', { p_rubber_id: rubberId, p_set1_a: a, p_set1_b: b }), '점수');

async function main() {
  const name = `__TEST_TEAM_advance019_${Date.now()}`;
  eventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'admin_only', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;

  const clubs = must(await sb.from('clubs').insert(['A', 'B', 'C', 'D', 'E'].map((n, i) => ({
    event_id: eventId, name: `임시${n}`, captain_name: `${n}주장`, captain_pin: String(610001 + i), seed_number: i + 1,
  }))).select(), '클럽');
  const [A, B, C, D, E] = ['임시A', '임시B', '임시C', '임시D', '임시E'].map(n => clubs.find(c => c.name === n));
  const members = {};
  for (const c of [A, C]) {
    members[c.id] = must(await sb.from('club_members').insert([1, 2, 3, 4].map(i => ({
      club_id: c.id, name: `${c.name}-P${i}`, member_order: i,
    }))).select(), '멤버');
  }

  const mk = (round, pos, a, b) => ({ event_id: eventId, round, bracket_position: pos, club_a_id: a, club_b_id: b, rubber_count: 3, status: 'pending', is_bye: false });
  const [sf1, sf2, fin] = must(await sb.from('ties').insert([mk('semi', 1, A.id, B.id), mk('semi', 2, C.id, D.id), mk('final', 1, null, null)]).select(), '대전')
    .sort((x, y) => (x.round === 'final') - (y.round === 'final') || x.bracket_position - y.bracket_position);
  const pin = () => String(100000 + Math.floor(Math.random() * 900000));
  for (const t of [sf1, sf2]) must(await sb.from('tie_rubbers').insert([1, 2, 3].map(n => ({ tie_id: t.id, rubber_number: n, status: 'pending', pin_code: pin() }))), '러버');

  console.log('\nT1  준결승1 2:0');
  let r = await rubbersOf(sf1.id);
  await score(r[0].id, 6, 2); await score(r[1].id, 6, 3);
  let f = await tieOf(fin.id);
  ok((await tieOf(sf1.id)).status === 'completed', '준결승1 completed');
  ok(f.club_a_id === A.id, '결승 club_a = A');
  ok((await rubbersOf(fin.id)).length === 0, '결승 러버 아직 없음');

  console.log('\nT2  준결승2 2:0');
  r = await rubbersOf(sf2.id);
  await score(r[0].id, 6, 1); await score(r[1].id, 6, 4);
  f = await tieOf(fin.id);
  ok(f.club_b_id === C.id, '결승 club_b = C');
  const finR0 = await rubbersOf(fin.id);
  ok(finR0.length === 3, '결승 러버 3개 생성');

  console.log('\nT3  결승 라인업 제출 + 1복식 점수');
  for (const c of [A, C]) {
    const m = members[c.id];
    const res = must(await sb.rpc('rpc_submit_lineup', { p_tie_id: fin.id, p_club_id: c.id, p_captain_pin: c.captain_pin,
      p_lineups: [1, 2, 3].map(n => ({ rubber_number: n, player1_id: m[(n - 1) % 4].id, player2_id: m[n % 4].id })) }), '라인업');
    ok(res.success, `${c.name} 라인업 제출`);
  }
  await score(finR0[0].id, 6, 3);
  const finR1 = await rubbersOf(fin.id);
  ok(finR1[0].status === 'completed', '결승 1복식 completed');
  const snap = JSON.stringify(finR1.map(x => [x.id, x.status, x.set1_a, x.set1_b, x.pin_code, x.club_a_player1_id, x.club_b_player1_id]));

  console.log('\nT4  준결승1 남은 3복식 입력 시도');
  const sf1r = await rubbersOf(sf1.id);
  const res4 = must(await sb.rpc('rpc_record_rubber_score', { p_rubber_id: sf1r[2].id, p_set1_a: 2, p_set1_b: 6 }), 'T4');
  ok(res4.success === false, `거부됨 (${res4.error})`);
  ok((await rubbersOf(sf1.id))[2].status === 'pending', '준결승1 3복식 그대로 pending');
  const snap4 = JSON.stringify((await rubbersOf(fin.id)).map(x => [x.id, x.status, x.set1_a, x.set1_b, x.pin_code, x.club_a_player1_id, x.club_b_player1_id]));
  ok(snap4 === snap, '결승 러버 id·점수·PIN·선수 그대로');

  console.log('\nT5  준결승1 진출 처리 재호출');
  const res5 = must(await sb.rpc('rpc_advance_tournament_winner', { p_tie_id: sf1.id }), 'T5');
  ok(res5.success === true, '성공 반환');
  const snap5 = JSON.stringify((await rubbersOf(fin.id)).map(x => [x.id, x.status, x.set1_a, x.set1_b, x.pin_code, x.club_a_player1_id, x.club_b_player1_id]));
  ok(snap5 === snap, '결승 러버 그대로');

  console.log('\nT6  준결승1 승자를 B로 바꾸고 진출 처리');
  must(await sb.from('ties').update({ winning_club_id: B.id }).eq('id', sf1.id), '승자 변경');
  const res6 = must(await sb.rpc('rpc_advance_tournament_winner', { p_tie_id: sf1.id }), 'T6');
  ok(res6.success === false, `거부됨 (${res6.error})`);
  ok((await tieOf(fin.id)).club_a_id === A.id, '결승 club_a 는 A 유지');
  const snap6 = JSON.stringify((await rubbersOf(fin.id)).map(x => [x.id, x.status, x.set1_a, x.set1_b, x.pin_code, x.club_a_player1_id, x.club_b_player1_id]));
  ok(snap6 === snap, '결승 러버 그대로');
  must(await sb.from('ties').update({ winning_club_id: A.id }).eq('id', sf1.id), '승자 원복');

  console.log('\nT7  TBD 대전 러버 점수');
  const tbd = must(await sb.from('ties').insert(mk('quarter', 9, E.id, null)).select().single(), 'TBD 대전');
  const tbdR = must(await sb.from('tie_rubbers').insert({ tie_id: tbd.id, rubber_number: 1, status: 'pending', pin_code: pin() }).select().single(), 'TBD 러버');
  const res7 = must(await sb.rpc('rpc_record_rubber_score', { p_rubber_id: tbdR.id, p_set1_a: 6, p_set1_b: 0 }), 'T7');
  ok(res7.success === false, `거부됨 (${res7.error})`);

  console.log('\nT8  풀리그 2:0 뒤 3복식 입력');
  const fl = must(await sb.from('ties').insert({ ...mk('full_league', null, D.id, E.id) }).select().single(), '풀리그 대전');
  const flR = must(await sb.from('tie_rubbers').insert([1, 2, 3].map(n => ({ tie_id: fl.id, rubber_number: n, status: 'pending', pin_code: pin() }))).select(), '풀리그 러버')
    .sort((x, y) => x.rubber_number - y.rubber_number);
  await score(flR[0].id, 6, 1); await score(flR[1].id, 6, 2);
  const res8 = await score(flR[2].id, 3, 6);
  ok(res8.success === true, '3복식 입력 허용');
  const flT = await tieOf(fl.id);
  ok(flT.status === 'completed' && flT.winning_club_id === D.id && flT.club_a_rubbers_won === 2 && flT.club_b_rubbers_won === 1, '풀리그 대전 2:1 완료, 승자 D');
}

try { await main(); } catch (e) { console.error('💥', e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
