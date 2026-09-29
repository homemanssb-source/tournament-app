// ============================================================
// 검증: 단체전 본선 진출 로직 + 운영자 점수 정정 (migration 020)
// 실행: node scripts/test-team-qualifiers-020.mjs   (임시 대회를 만들고 끝나면 스스로 지운다)
//
//  6클럽 → 2조×3팀, 3복식, 조별 2팀 진출 → 준결승 2 + 결승
//  T1  조별 진행 전 대진 생성 → 4자리 모두 이름표 + 출처
//  T2  A조 완료 (X 2승, Y 1승, Z 0승) → A조 1·2위 자리 자동 채움
//  T3  B조 순환 동률 (P>Q, Q>R, R>P 모두 2:1) → 전원 순위 NULL, B조 자리는 이름표 유지
//  T4  B조 수동 결정 P=1, Q=2, R=3 → 마지막 저장 시 B조 자리 자동 채움
//  T5  A조 Y-Z 대전 정정 → Z가 2위 → 본선 A조 2위 자리가 Y→Z로 재배정
//  T6  X가 있는 준결승 1복식 입력(시작) 후, A조 1위가 바뀌는 정정 → 재배정 보류(경고), 자리 그대로
//  T7  준결승 2:0 → 결승 진출, 1복식 정정으로 1:1 → 준결승 진행 중 복귀 + 결승 자리 비움 → 3복식으로 다시 결정
//  T8  결승 시작 후 준결승 정정 시도 → 거부
//  T9  재생성: 조 완료 + B조 동률 결정 풀린 상태 → B조 자리 이름표, undecided_groups 에 B조
//      → 다시 수동 결정 → 자동 채움 (random 없이 결정대로)
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
  await sb.from('groups').delete().eq('event_id', eventId);
  await sb.from('audit_log').delete().eq('event_id', eventId);
  if (clubIds.length) await sb.from('club_members').delete().in('club_id', clubIds);
  await sb.from('clubs').delete().eq('event_id', eventId);
  await sb.from('divisions').delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

const rubbersOf = async (tieId) => must(await sb.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number'), '러버');
const tieOf = async (tieId) => must(await sb.from('ties').select('*').eq('id', tieId).single(), '대전');
const koTies = async () => must(await sb.from('ties').select('*').eq('event_id', eventId).in('round', ['semi', 'final']).order('round', { ascending: false }).order('bracket_position'), '본선');
const standing = async (clubId) => must(await sb.from('team_standings').select('*').eq('event_id', eventId).eq('club_id', clubId).single(), '순위');
const rec = async (rubberId, winA) => must(await sb.rpc('rpc_admin_record_score', { p_rubber_id: rubberId, p_set1_a: winA ? 6 : 2, p_set1_b: winA ? 2 : 6 }), '점수');
const correct = async (rubberId, winA) => must(await sb.rpc('rpc_admin_correct_rubber_score', { p_rubber_id: rubberId, p_set1_a: winA ? 6 : 3, p_set1_b: winA ? 3 : 6 }), '정정');

// 대전을 클럽 기준으로 진행: winners = [clubId, clubId, clubId]
async function play(tie, winners) {
  const rs = await rubbersOf(tie.id);
  for (let i = 0; i < winners.length; i++) {
    const r = await rec(rs[i].id, winners[i] === tie.club_a_id);
    if (!r.success) throw new Error(`러버 ${i + 1}: ${r.error}`);
  }
}
const tieBetween = (ties, c1, c2) => ties.find(t => (t.club_a_id === c1 && t.club_b_id === c2) || (t.club_a_id === c2 && t.club_b_id === c1));
const slotsOf = (ko) => ko.filter(t => t.round === 'semi').flatMap(t => [
  { tie: t, side: 'a', club: t.club_a_id, label: t.qualifier_label_a, src: t.qualifier_src_a },
  { tie: t, side: 'b', club: t.club_b_id, label: t.qualifier_label_b, src: t.qualifier_src_b },
]);
const slotFor = (ko, groupId, rank) => slotsOf(ko).find(s => s.src === `${groupId}:${rank}`);

async function main() {
  const name = `__TEST_TEAM_q020_${Date.now()}`;
  eventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'admin_only', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;
  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('clubs').insert([1, 2, 3, 4, 5, 6].map(i => ({
    event_id: eventId, division_id: div.id, name: `임시${i}`, captain_pin: String(620000 + i), seed_number: i,
  }))), '클럽');
  const g = must(await sb.rpc('rpc_create_team_groups', { p_event_id: eventId, p_group_count: 2, p_group_size: 3, p_division_id: div.id }), '조편성');
  if (!g.success) throw new Error('조편성: ' + g.error);
  const groups = must(await sb.from('groups').select('*').eq('event_id', eventId).order('group_num'), '조');
  const [GA, GB] = groups;
  const gTies = async (gid) => must(await sb.from('ties').select('*').eq('group_id', gid).order('tie_order'), '조 대전');
  const members = async (gid) => (must(await sb.from('team_standings').select('club_id').eq('group_id', gid), '조원')).map(r => r.club_id).sort();
  const [X, Y, Z] = await members(GA.id);
  const [P, Q, R] = await members(GB.id);
  const cname = {}; (must(await sb.from('clubs').select('id,name').eq('event_id', eventId), '이름')).forEach(c => cname[c.id] = c.name);

  console.log('\nT1  조별 진행 전 대진 생성');
  const gen = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }), '생성');
  ok(gen.success && gen.tbd_slots === 4, `생성 성공, 미정 4자리 (${JSON.stringify(gen)})`);
  let ko = await koTies();
  ok(slotsOf(ko).every(s => s.club === null && s.label && s.src), '4자리 모두 이름표+출처, 클럽 없음');

  console.log('\nT2  A조 완료');
  let at = await gTies(GA.id);
  await play(tieBetween(at, X, Y), [X, X, X]);
  await play(tieBetween(at, X, Z), [X, X, X]);
  await play(tieBetween(at, Y, Z), [Y, Y, Z]);
  ko = await koTies();
  ok(slotFor(ko, GA.id, 1).club === X, `A조 1위 자리 = ${cname[X]}`);
  ok(slotFor(ko, GA.id, 2).club === Y, `A조 2위 자리 = ${cname[Y]}`);
  ok(slotFor(ko, GA.id, 1).label === null && slotFor(ko, GA.id, 1).src, '채운 뒤에도 출처 유지');

  console.log('\nT3  B조 순환 동률');
  let bt = await gTies(GB.id);
  await play(tieBetween(bt, P, Q), [P, P, Q]);
  await play(tieBetween(bt, Q, R), [Q, Q, R]);
  await play(tieBetween(bt, R, P), [R, R, P]);
  ok((await standing(P)).rank === null && (await standing(Q)).rank === null && (await standing(R)).rank === null, 'B조 3팀 모두 순위 NULL (동률)');
  ko = await koTies();
  ok(slotFor(ko, GB.id, 1).club === null && slotFor(ko, GB.id, 1).label, 'B조 1위 자리 이름표 유지');

  console.log('\nT4  B조 수동 결정 P=1, Q=2, R=3');
  const m1 = must(await sb.rpc('rpc_set_manual_rank', { p_event_id: eventId, p_club_id: P, p_rank: 1, p_notes: '추첨' }), '수동1');
  ko = await koTies();
  ok(m1.success && slotFor(ko, GB.id, 1).club === null, '첫 팀만 저장 → 아직 동률, 자리 비어 있음');
  must(await sb.rpc('rpc_set_manual_rank', { p_event_id: eventId, p_club_id: Q, p_rank: 2, p_notes: '추첨' }), '수동2');
  const m3 = must(await sb.rpc('rpc_set_manual_rank', { p_event_id: eventId, p_club_id: R, p_rank: 3, p_notes: '추첨' }), '수동3');
  ok(m3.success && m3.reseat?.success === true, `마지막 저장 → 재배정 성공 (${JSON.stringify(m3.reseat)})`);
  const sP = await standing(P), sQ = await standing(Q), sR = await standing(R);
  ok(sP.rank === 1 && sQ.rank === 2 && sR.rank === 3 && sP.rank_locked, 'B조 순위 1·2·3, 본부 결정 표시');
  ko = await koTies();
  ok(slotFor(ko, GB.id, 1).club === P && slotFor(ko, GB.id, 2).club === Q, `B조 자리 = ${cname[P]}, ${cname[Q]}`);
  const semiRubbersOk = (await Promise.all(ko.filter(t => t.round === 'semi').map(t => rubbersOf(t.id)))).every(r => r.length === 3);
  ok(semiRubbersOk, '준결승 2개 러버 3개씩 생성');

  console.log('\nT5  A조 Y-Z 정정 → Z 2위');
  at = await gTies(GA.id);
  const yz = tieBetween(at, Y, Z);
  const yzR = await rubbersOf(yz.id);
  const c5 = await correct(yzR[0].id, yz.club_a_id === Z);
  ok(c5.success && c5.corrected, '정정 성공');
  ok((await tieOf(yz.id)).winning_club_id === Z, 'Y-Z 대전 승자 Z');
  ok((await standing(Z)).rank === 2 && (await standing(Y)).rank === 3, 'A조 순위 Z 2위, Y 3위');
  ko = await koTies();
  ok(slotFor(ko, GA.id, 2).club === Z, `본선 A조 2위 자리 ${cname[Y]} → ${cname[Z]}`);

  console.log('\nT6  준결승 시작 후 A조 1위가 바뀌는 정정');
  const sfX = ko.find(t => t.round === 'semi' && (t.club_a_id === X || t.club_b_id === X));
  const sfXr = await rubbersOf(sfX.id);
  await rec(sfXr[0].id, sfX.club_a_id === X);
  at = await gTies(GA.id);
  const xz = tieBetween(at, X, Z);
  const xzR = await rubbersOf(xz.id);
  await correct(xzR[0].id, xz.club_a_id === Z);
  const c6 = await correct(xzR[1].id, xz.club_a_id === Z);
  ok(c6.success && c6.reseat?.reseat_skipped === true, `정정은 저장, 재배정은 보류 (${c6.reseat?.error})`);
  ok((await standing(Z)).rank === 1, '순위표상 Z 1위');
  const koAfter = await koTies();
  ok(slotFor(koAfter, GA.id, 1).club === X && slotFor(koAfter, GA.id, 2).club === Z, '본선 자리는 그대로 (X, Z)');
  const aud = must(await sb.from('audit_log').select('action').eq('event_id', eventId).eq('action', 'team_reseat_skipped'), '감사');
  ok(aud.length >= 1, 'audit_log 에 team_reseat_skipped 기록');

  console.log('\nT7  준결승 정정으로 과반이 풀리는 경우');
  await rec(sfXr[1].id, sfX.club_a_id === X);
  let fin = (await koTies()).find(t => t.round === 'final');
  const finSideX = sfX.bracket_position % 2 === 1 ? 'club_a_id' : 'club_b_id';
  ok((await tieOf(sfX.id)).status === 'completed' && fin[finSideX] === X, `준결승 2:0 → 결승 자리 ${cname[X]}`);
  const opp = sfX.club_a_id === X ? sfX.club_b_id : sfX.club_a_id;
  const c7 = await correct(sfXr[0].id, sfX.club_a_id === opp);
  const sfNow = await tieOf(sfX.id);
  fin = await tieOf(fin.id);
  ok(c7.success && sfNow.status === 'in_progress' && sfNow.winning_club_id === null, '준결승 1:1 → 진행 중으로 복귀');
  ok(fin[finSideX] === null, '결승 자리 비워짐');
  const r7 = await rec(sfXr[2].id, sfX.club_a_id === opp);
  fin = await tieOf(fin.id);
  ok(r7.success && fin[finSideX] === opp, `3복식으로 결정 → 결승 자리 ${cname[opp]}`);

  console.log('\nT8  결승 시작 후 준결승 정정');
  const sf2 = (await koTies()).find(t => t.round === 'semi' && t.id !== sfX.id);
  const sf2r = await rubbersOf(sf2.id);
  await rec(sf2r[0].id, true); await rec(sf2r[1].id, true);
  fin = await tieOf(fin.id);
  const finR = await rubbersOf(fin.id);
  ok(fin.club_a_id && fin.club_b_id && finR.length === 3, '결승 양팀 확정, 러버 3개');
  await rec(finR[0].id, true);
  const c8 = await correct(sf2r[0].id, false);
  ok(c8.success === false, `거부됨 (${c8.error})`);
  ok((await rubbersOf(fin.id))[0].status === 'completed', '결승 1복식 그대로');

  console.log('\nT9  재생성: B조 동률 결정이 풀린 상태');
  must(await sb.from('team_standings').update({ manual_tiebreak: null }).eq('group_id', GB.id), '결정 해제');
  const gen2 = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: false }), '재생성');
  ko = await koTies();
  ok(gen2.success && (gen2.undecided_groups || []).includes(GB.group_label), `B조 결정 필요 안내 (${JSON.stringify(gen2.undecided_groups)})`);
  ok(slotFor(ko, GA.id, 1).club === Z && slotFor(ko, GA.id, 2).club === X, 'A조 자리 현재 순위대로 (Z, X)');
  ok(slotFor(ko, GB.id, 1).club === null && slotFor(ko, GB.id, 1).label && slotFor(ko, GB.id, 2).club === null, 'B조 자리 이름표 (무작위 배치 없음)');
  ok(ko.filter(t => t.round === 'semi').every(t => !t.is_bye), '부전승 처리 안 됨');
  for (const [c, r] of [[Q, 1], [R, 2], [P, 3]]) must(await sb.rpc('rpc_set_manual_rank', { p_event_id: eventId, p_club_id: c, p_rank: r }), '재결정');
  ko = await koTies();
  ok(slotFor(ko, GB.id, 1).club === Q && slotFor(ko, GB.id, 2).club === R, `결정대로 채움 (${cname[Q]}, ${cname[R]})`);
}

try { await main(); } catch (e) { console.error('💥', e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
