// ============================================================
// 검증: 단체전 점수 정정이 본선 토너먼트에 반영되는지 (운영 흐름 그대로)
// 실행: node scripts/test-team-correction-flow.mjs   (임시 대회를 만들고 끝나면 지운다)
// 정정은 운영자 정정 함수(rpc_admin_correct_rubber_score — 대시보드·관리자 PIN 화면이 쓰는 것)로 한다.
//
//  [예선 정정]
//  G1  조별리그를 모두 끝낸 뒤 본선 생성 → A조 경기 정정으로 1·2위가 바뀜 → 본선 자리도 바뀜
//  G2  순위가 바뀌지 않는 정정 (6:2 → 6:4) → 본선 그대로
//  G3  본선 경기가 시작된 뒤 예선 정정 → 본선은 그대로, 경고(재배정 보류)
//  G4  부전승이 걸린 조(3조×1위 진출, 4강에 부전승 1개) 정정 → 부전승 자리와 결승 자리까지 바뀜
//  [본선 정정]
//  K1  준결승 A 2:1 승 → 결승 양팀 확정(시작 전) → 준결승 정정으로 B 2:1 승 → 결승 자리 A→B, 결승 러버 유지
//  K2  결승 정정으로 우승팀이 바뀜
//  K3  결승이 시작된 뒤 준결승 정정 → 거부
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

const eventIds = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

async function cleanup() {
  for (const id of eventIds) {
    const tieIds = (await sb.from('ties').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
    const clubIds = (await sb.from('clubs').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
    if (tieIds.length) { await sb.from('tie_rubbers').delete().in('tie_id', tieIds); await sb.from('team_lineups').delete().in('tie_id', tieIds); }
    await sb.from('ties').delete().eq('event_id', id);
    await sb.from('team_standings').delete().eq('event_id', id);
    await sb.from('groups').delete().eq('event_id', id);
    await sb.from('audit_log').delete().eq('event_id', id);
    if (clubIds.length) { await sb.from('club_members').delete().in('club_id', clubIds); await sb.from('club_pins').delete().in('club_id', clubIds); }
    await sb.from('clubs').delete().eq('event_id', id);
    await sb.from('divisions').delete().eq('event_id', id);
    await sb.from('events').delete().eq('id', id);
  }
  console.log('🧹 테스트 이벤트 정리 완료');
}

const rubbersOf = async (tieId) => must(await sb.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number'), '러버');
const tieOf = async (id) => must(await sb.from('ties').select('*').eq('id', id).single(), '대전');
const koTies = async (ev) => must(await sb.from('ties').select('*').eq('event_id', ev).in('round', ['semi', 'final']).order('round', { ascending: false }).order('bracket_position'), '본선');
const rankOf = async (clubId) => (must(await sb.from('team_standings').select('rank').eq('club_id', clubId).single(), '순위')).rank;
// 러버 입력/정정: winA=true 면 club_a 승
const rec = async (id, winA, score = [6, 2]) => must(await sb.rpc('rpc_admin_record_score', { p_rubber_id: id, p_set1_a: winA ? score[0] : score[1], p_set1_b: winA ? score[1] : score[0] }), '입력');
const cor = async (id, winA, score = [6, 3]) => must(await sb.rpc('rpc_admin_correct_rubber_score', { p_rubber_id: id, p_set1_a: winA ? score[0] : score[1], p_set1_b: winA ? score[1] : score[0] }), '정정');
async function play(tie, winners) { const rs = await rubbersOf(tie.id); for (let i = 0; i < winners.length; i++) { const r = await rec(rs[i].id, winners[i] === tie.club_a_id); if (!r.success) throw new Error(r.error); } }
const between = (ties, x, y) => ties.find(t => (t.club_a_id === x && t.club_b_id === y) || (t.club_a_id === y && t.club_b_id === x));
const slot = (ko, gid, rank) => ko.flatMap(t => [{ t, club: t.club_a_id, src: t.qualifier_src_a }, { t, club: t.club_b_id, src: t.qualifier_src_b }]).find(s => s.src === `${gid}:${rank}`);

async function setupEvent(tag, clubCount, groupSize) {
  const name = `__TEST_TEAM_corr_${tag}_${Date.now()}`;
  const ev = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'admin_only', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;
  eventIds.push(ev);
  const div = must(await sb.from('divisions').insert({ event_id: ev, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('clubs').insert(Array.from({ length: clubCount }, (_, i) => ({ event_id: ev, division_id: div.id, name: `${tag}${i + 1}` }))), '클럽');
  const g = must(await sb.rpc('rpc_create_team_groups', { p_event_id: ev, p_group_count: clubCount / groupSize, p_group_size: groupSize, p_division_id: div.id }), '조편성');
  if (!g.success) throw new Error(g.error);
  const groups = must(await sb.from('groups').select('*').eq('event_id', ev).order('group_num'), '조');
  const out = [];
  for (const gr of groups) {
    const members = (must(await sb.from('team_standings').select('club_id').eq('group_id', gr.id), '조원')).map(r => r.club_id).sort();
    const ties = must(await sb.from('ties').select('*').eq('group_id', gr.id), '조 대전');
    out.push({ g: gr, m: members, ties });
  }
  return { ev, div, groups: out };
}

async function main() {
  // ───────── 예선 정정 (2조×3팀, 조별 2팀 → 4강) ─────────
  console.log('\n[예선 정정] 조별리그 완료 후 본선 생성');
  const S = await setupEvent('G', 6, 3);
  const [GA, GB] = S.groups;
  const [X, Y, Z] = GA.m, [P, Q, R] = GB.m;
  await play(between(GA.ties, X, Y), [X, X, X]);   // X 2승
  await play(between(GA.ties, X, Z), [X, X, Z]);
  await play(between(GA.ties, Y, Z), [Y, Y, Z]);   // Y 1승 → A조 X 1위, Y 2위, Z 3위
  await play(between(GB.ties, P, Q), [P, P, P]);
  await play(between(GB.ties, P, R), [P, P, P]);
  await play(between(GB.ties, Q, R), [Q, Q, R]);   // B조 P 1위, Q 2위
  const gen = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: S.ev, p_division_id: S.div.id, p_advance_per_group: 2, p_allow_tbd: false }), '본선');
  let ko = await koTies(S.ev);
  ok(gen.success && slot(ko, GA.g.id, 1)?.club === X && slot(ko, GA.g.id, 2)?.club === Y, '본선에 A조 1위 X, 2위 Y 배치 (출처 기록됨)');

  console.log('\nG1  A조 Y-Z 정정 → Z가 2위');
  const yz = between(GA.ties, Y, Z);
  let rs = await rubbersOf(yz.id);
  let r = await cor(rs[0].id, yz.club_a_id === Z);          // Y,Y,Z → Z,Y,Z : Z 2승 1패
  ok(r.success && r.reseat?.success === true, `정정 성공, 재배정 성공 (${JSON.stringify(r.reseat)})`);
  ok(await rankOf(Z) === 2 && await rankOf(Y) === 3, 'A조 순위 Z 2위, Y 3위');
  ko = await koTies(S.ev);
  ok(slot(ko, GA.g.id, 2)?.club === Z, '본선 A조 2위 자리 Y → Z');

  console.log('\nG2  순위가 안 바뀌는 정정 (6:2 → 6:4)');
  const pq = between(GB.ties, P, Q);
  const before = JSON.stringify((await koTies(S.ev)).map(t => [t.club_a_id, t.club_b_id]));
  rs = await rubbersOf(pq.id);
  r = await cor(rs[0].id, pq.club_a_id === P, [6, 4]);
  ok(r.success && (r.reseat?.changed ?? 0) === 0, '정정 성공, 바뀐 자리 없음');
  ok(JSON.stringify((await koTies(S.ev)).map(t => [t.club_a_id, t.club_b_id])) === before, '본선 그대로');

  console.log('\nG3  본선 시작 후 예선 정정');
  ko = await koTies(S.ev);
  const sfZ = ko.find(t => t.round === 'semi' && (t.club_a_id === Z || t.club_b_id === Z));
  await rec((await rubbersOf(sfZ.id))[0].id, true);         // Z가 있는 준결승 시작
  rs = await rubbersOf(yz.id);
  r = await cor(rs[0].id, yz.club_a_id === Y);              // 다시 Y 2위가 되도록
  ok(r.success && r.reseat?.reseat_skipped === true, `정정은 저장, 본선 재배정 보류 + 경고 (${r.reseat?.error})`);
  ok(await rankOf(Y) === 2, '순위표는 Y 2위로 바뀜');
  ok(slot(await koTies(S.ev), GA.g.id, 2)?.club === Z, '본선 자리는 Z 그대로 (시작된 경기 보호)');

  // ───────── 본선 정정 ─────────
  console.log('\n[본선 정정] 준결승·결승');
  ko = await koTies(S.ev);
  const sf1 = ko.find(t => t.round === 'semi' && t.bracket_position === 1);
  const sf2 = ko.find(t => t.round === 'semi' && t.bracket_position === 2);
  const fin = ko.find(t => t.round === 'final');
  const finSide1 = 'club_a_id';                          // 준결승1 승자 → 결승 club_a
  // 준결승1: 이미 1복식이 입력된 경우가 있으므로 남은 복식으로 club_a 2:1 승 만들기
  const s1 = await rubbersOf(sf1.id);
  const s1a = sf1.club_a_id, s1b = sf1.club_b_id;
  for (const [i, winA] of [[0, true], [1, false], [2, true]]) {
    if (s1[i].status === 'completed') await cor(s1[i].id, winA); else await rec(s1[i].id, winA);
  }
  const s2 = await rubbersOf(sf2.id);
  for (const [i, winA] of [[0, true], [1, true]]) { if (s2[i].status === 'completed') await cor(s2[i].id, winA); else await rec(s2[i].id, winA); }
  let f = await tieOf(fin.id);
  const finR0 = await rubbersOf(fin.id);
  ok(f[finSide1] === s1a && f.club_b_id === sf2.club_a_id && finR0.length === 3, '결승 양팀 확정, 러버 3개');

  console.log('\nK1  준결승1 정정 → 승자 A→B');
  r = await cor(s1[0].id, false);                            // club_a 승 → club_b 승 : B 2:1
  f = await tieOf(fin.id);
  const sfNow = await tieOf(sf1.id);
  ok(r.success && sfNow.winning_club_id === s1b && sfNow.status === 'completed', '준결승1 승자 B, 완료 유지');
  ok(f[finSide1] === s1b, '결승 자리 A → B 로 바뀜');
  ok(JSON.stringify((await rubbersOf(fin.id)).map(x => x.id)) === JSON.stringify(finR0.map(x => x.id)), '결승 러버는 그대로 (지워지지 않음)');

  console.log('\nK2  결승 정정 → 우승팀 변경');
  const fr = await rubbersOf(fin.id);
  await rec(fr[0].id, true); await rec(fr[1].id, true);      // club_a 2:0 우승
  f = await tieOf(fin.id);
  const champA = f.club_a_id;
  ok(f.status === 'completed' && f.winning_club_id === champA, '결승 club_a 우승');
  await cor(fr[0].id, false);                                // 1:1 → 진행 중
  f = await tieOf(fin.id);
  ok(f.status === 'in_progress' && f.winning_club_id === null, '정정으로 1:1 → 결승 진행 중으로');
  await rec(fr[2].id, false);                                // club_b 2:1 우승
  f = await tieOf(fin.id);
  ok(f.status === 'completed' && f.winning_club_id === f.club_b_id, '3복식으로 club_b 우승으로 바뀜');

  console.log('\nK3  결승 시작 후 준결승 정정');
  const s2now = await rubbersOf(sf2.id);
  r = await cor(s2now[0].id, false);
  ok(r.success === false, `거부 (${r.error})`);

  // ───────── 부전승 (3조×3팀, 조 1위만 → 4강에 부전승 1개) ─────────
  console.log('\nG4  부전승이 걸린 조 정정');
  const T = await setupEvent('B', 9, 3);
  for (const G of T.groups) {
    const [a, b, c] = G.m;
    await play(between(G.ties, a, b), [a, a, a]);
    await play(between(G.ties, a, c), [a, a, c]);
    await play(between(G.ties, b, c), [b, b, c]);           // 1위 a, 2위 b
  }
  const gen2 = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: T.ev, p_division_id: T.div.id, p_advance_per_group: 1, p_allow_tbd: false }), '본선');
  let ko2 = await koTies(T.ev);
  const byeTie = ko2.find(t => t.round === 'semi' && t.is_bye);
  ok(gen2.success && !!byeTie, '4강에 부전승 대전 1개');
  const byeClub = byeTie.club_a_id || byeTie.club_b_id;
  const BG = T.groups.find(G => G.m.includes(byeClub));
  const [ba, bb] = BG.m;                                      // 부전승 받은 조: 1위 ba
  let final2 = ko2.find(t => t.round === 'final');
  const finSlot = byeTie.bracket_position % 2 === 1 ? 'club_a_id' : 'club_b_id';
  ok(byeClub === ba && final2[finSlot] === ba, `부전승 ${ba === byeClub ? '조 1위' : '?'} → 결승 자리에 올라감`);
  // 그 조의 a-b 대전을 정정해 b 가 1위가 되도록: a,a,a → b,b,a (b 2:1 승) → a 1승1패, b 2승
  const ab = between(BG.ties, ba, bb);
  const abR = await rubbersOf(ab.id);
  await cor(abR[0].id, ab.club_a_id === bb);
  r = await cor(abR[1].id, ab.club_a_id === bb);
  ok(await rankOf(bb) === 1, '그 조 1위가 b 로 바뀜');
  ko2 = await koTies(T.ev);
  const byeNow = await tieOf(byeTie.id);
  final2 = ko2.find(t => t.round === 'final');
  ok((byeNow.club_a_id || byeNow.club_b_id) === bb && byeNow.winning_club_id === bb && byeNow.is_bye, '부전승 대전의 팀·승자 b 로 바뀜');
  ok(final2[finSlot] === bb, '결승 자리도 b 로 바뀜');
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
