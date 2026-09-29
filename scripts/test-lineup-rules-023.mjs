// ============================================================
// 검증: 라인업 규칙 — 선수 중복 금지 + 공오더 (migration 023)
// 실행: node scripts/test-lineup-rules-023.mjs   (임시 대회를 만들고 끝나면 지운다. 제출은 익명 키 = 주장과 같은 권한)
//
//  R1  같은 선수를 두 복식에 → 거부 / 같은 복식에 두 번 → 거부 / 다른 클럽 선수 → 거부
//  R2  공오더 허용 안 한 부서에서 빈 복식 → 거부
//  R3  허용 부서: 빈 복식 2개 → 거부, 1개 → 제출 성공
//  R4  공개 시 A가 비운 복식 2 → B 6:0 승(공오더), 대전 1:0 반영, 그 러버 점수 입력 거부
//  R5  양 팀이 같은 복식 3을 비움 → 승자 없이 0:0, 복식 1·2가 1:1 이면 대전은 승자 없이 완료
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
  if (clubIds.length) await sb.from('pin_attempts').delete().in('target_key', clubIds.map(c => 'club:' + c));
  await sb.from('ties').delete().eq('event_id', eventId);
  await sb.from('team_standings').delete().eq('event_id', eventId);
  if (clubIds.length) {
    await sb.from('club_members').delete().in('club_id', clubIds);
    await sb.from('club_pins').delete().in('club_id', clubIds);
  }
  await sb.from('clubs').delete().eq('event_id', eventId);
  await sb.from('divisions').delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

const submit = async (tie, club, pin, lineups) => {
  const r = await anon.rpc('rpc_submit_lineup', { p_tie_id: tie.id, p_club_id: club.id, p_captain_pin: pin, p_lineups: lineups });
  return r.error ? { success: false, error: r.error.message } : r.data;
};
const L = (rows) => rows.map((p, i) => ({ rubber_number: i + 1, player1_id: p ? p[0].id : '', player2_id: p ? p[1].id : '' }));

async function main() {
  const name = `__TEST_TEAM_rules023_${Date.now()}`;
  eventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'full_league', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'captain_pin', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;
  const dNo = must(await sb.from('divisions').insert({ event_id: eventId, name: '불허부', sort_order: 1 }).select().single(), '부서');
  const dYes = must(await sb.from('divisions').insert({ event_id: eventId, name: '허용부', sort_order: 2, allow_empty_order: true }).select().single(), '부서');
  const mk = async (div, nm, pin) => {
    const c = must(await sb.from('clubs').insert({ event_id: eventId, division_id: div.id, name: nm, captain_pin: pin }).select().single(), '클럽');
    const m = must(await sb.from('club_members').insert([1, 2, 3, 4, 5, 6].map(i => ({ club_id: c.id, name: `${nm}-${i}`, member_order: i }))).select(), '선수');
    return { ...c, m: m.sort((a, b) => a.member_order - b.member_order) };
  };
  const A = await mk(dNo, '불A', '823001'), B = await mk(dNo, '불B', '823002');
  const C = await mk(dYes, '허C', '823003'), D = await mk(dYes, '허D', '823004');
  const E = await mk(dYes, '허E', '823005'), F = await mk(dYes, '허F', '823006');
  const tie = async (x, y, div) => must(await sb.from('ties').insert({ event_id: eventId, division_id: div.id, round: 'full_league', tie_order: 1, club_a_id: x.id, club_b_id: y.id, rubber_count: 3, status: 'pending' }).select().single(), '대전');
  const tAB = await tie(A, B, dNo), tCD = await tie(C, D, dYes), tEF = await tie(E, F, dYes);
  for (const t of [tAB, tCD, tEF]) must(await sb.rpc('rpc_create_rubbers_for_event_ties', { p_event_id: eventId, p_round: 'full_league' }), '러버');
  const m = (c, i, j) => [c.m[i], c.m[j]];

  console.log('\nR1  선수 중복·소속');
  let r = await submit(tAB, A, '823001', L([m(A, 0, 1), m(A, 1, 2), m(A, 3, 4)]));
  ok(!r.success && /중복/.test(r.error), `두 복식에 같은 선수 거부 (${r.error})`);
  r = await submit(tAB, A, '823001', L([m(A, 0, 0), m(A, 1, 2), m(A, 3, 4)]));
  ok(!r.success && /두 번/.test(r.error), `같은 복식 두 번 거부 (${r.error})`);
  r = await submit(tAB, A, '823001', L([m(A, 0, 1), [A.m[2], B.m[0]], m(A, 3, 4)]));
  ok(!r.success && /소속/.test(r.error), `다른 클럽 선수 거부 (${r.error})`);

  console.log('\nR2  불허 부서 공오더');
  r = await submit(tAB, A, '823001', L([m(A, 0, 1), null, m(A, 3, 4)]));
  ok(!r.success && /공오더/.test(r.error), `거부 (${r.error})`);
  r = await submit(tAB, A, '823001', L([m(A, 0, 1), m(A, 2, 3), m(A, 4, 5)]));
  ok(r.success, '정상 라인업은 제출됨');

  console.log('\nR3  허용 부서 공오더 개수');
  r = await submit(tCD, C, '823003', L([m(C, 0, 1), null, null]));
  ok(!r.success && /1개/.test(r.error), `2개 거부 (${r.error})`);
  r = await submit(tCD, C, '823003', L([m(C, 0, 1), null, m(C, 2, 3)]));
  ok(r.success && r.empty_rubbers === 1, '1개 제출 성공');

  console.log('\nR4  공개 시 공오더 자동 기록');
  r = await submit(tCD, D, '823004', L([m(D, 0, 1), m(D, 2, 3), m(D, 4, 5)]));
  ok(r.success && r.revealed, 'D 제출 → 공개');
  const rs = must(await sb.from('tie_rubbers').select('*').eq('tie_id', tCD.id).order('rubber_number'), '러버');
  const dSide = tCD.club_a_id === D.id ? 'a' : 'b';
  ok(rs[1].status === 'completed' && rs[1].is_walkover && rs[1].winning_club_id === D.id
     && rs[1]['set1_' + dSide] === 6 && rs[1]['set1_' + (dSide === 'a' ? 'b' : 'a')] === 0, '복식 2 = D 6:0 승 (공오더)');
  ok(rs[0].status !== 'completed' && rs[2].status !== 'completed', '나머지 복식은 그대로');
  const t4 = must(await sb.from('ties').select('*').eq('id', tCD.id).single(), '대전');
  ok((dSide === 'a' ? t4.club_a_rubbers_won : t4.club_b_rubbers_won) === 1, '대전 러버 승수 D 1');
  r = await anon.rpc('rpc_captain_record_score', { p_tie_id: tCD.id, p_pin: '823003', p_rubber_id: rs[1].id, p_set1_a: 6, p_set1_b: 0 });
  ok(r.data?.success === false, `공오더 러버 점수 입력 거부 (${r.data?.error})`);

  console.log('\nR5  양 팀이 같은 복식을 비움');
  r = await submit(tEF, E, '823005', L([m(E, 0, 1), m(E, 2, 3), null]));
  r = await submit(tEF, F, '823006', L([m(F, 0, 1), m(F, 2, 3), null]));
  ok(r.success && r.revealed, '공개');
  let rsEF = must(await sb.from('tie_rubbers').select('*').eq('tie_id', tEF.id).order('rubber_number'), '러버');
  ok(rsEF[2].status === 'completed' && rsEF[2].is_walkover && rsEF[2].winning_club_id === null && rsEF[2].set1_a === 0 && rsEF[2].set1_b === 0, '복식 3 승자 없음 0:0');
  await anon.rpc('rpc_captain_record_score', { p_tie_id: tEF.id, p_pin: '823005', p_rubber_id: rsEF[0].id, p_set1_a: 6, p_set1_b: 3 });
  await anon.rpc('rpc_captain_record_score', { p_tie_id: tEF.id, p_pin: '823005', p_rubber_id: rsEF[1].id, p_set1_a: 3, p_set1_b: 6 });
  const t5 = must(await sb.from('ties').select('*').eq('id', tEF.id).single(), '대전');
  ok(t5.status === 'completed' && t5.winning_club_id === null && t5.club_a_rubbers_won === 1 && t5.club_b_rubbers_won === 1, '대전 1:1 승자 없이 완료 (운영본부 판단)');
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
