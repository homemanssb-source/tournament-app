// ============================================================
// 검증: migration 043 (2026-11-15 혼디모영배에서 나온 문제 6건)
// 실행: node scripts/test-043-score-guards-court-place.mjs   (임시 대회를 만들고 끝나면 스스로 지운다)
//
//  A  조 1위 자리가 부전승(BYE)이어도, 조 점수를 정정하면 부전승 경기·다음 라운드 자리·2위 자리가 모두 바뀐다
//  B  자동 시작: 코트에 진행 중 경기가 있으면 더 켜지 않고, 팀이 미정인 경기는 켜지 않는다
//  C  선수 PIN 점수: 상대 미정 거절 / 같은 팀 앞 경기가 방금 끝났으면 거절 / 2분 지나면 허용
//  D  점수 초기화: 다음 라운드 자리 되돌림 + 같이 켜진 '진행 중' 되돌림 / 다음 경기에 결과가 있으면 거절
//  E  코트·순서 지정(rpc_venue_admin_place_match) / 대기로 되돌리기(rpc_venue_admin_set_match_pending)
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let eventId = null, pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };
const errOf = r => r.error?.message || (r.data && r.data.success === false ? r.data.error : '') || '';

async function cleanup() {
  if (!eventId) return;
  const mids = (await sb.from('matches').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const gids = (await sb.from('groups').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const tids = (await sb.from('teams').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  if (mids.length) await sb.from('bracket_nodes').delete().in('match_id', mids);
  await sb.from('audit_log').delete().eq('event_id', eventId);
  for (const t of ['pin_sessions', 'admin_pin_sessions', 'venue_sessions', 'venues']) await sb.from(t).delete().eq('event_id', eventId);
  if (tids.length) await sb.from('team_pins').delete().in('team_id', tids);
  if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
  for (const t of ['matches', 'groups', 'group_settings', 'teams', 'divisions']) await sb.from(t).delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

async function main() {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_043_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  if ('auto_fill_courts' in row) row.auto_fill_courts = false;
  if ('auto_steal_courts' in row) row.auto_steal_courts = false;
  if ('is_public' in row) row.is_public = false;
  eventId = must(await sb.from('events').insert(row).select().single(), '이벤트 생성').id;

  // 12팀 · 2팀 조 6개 · 조 2위까지 본선 → 12강(16강 대진, 부전승 4)
  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('group_settings').insert({ event_id: eventId, division_id: div.id, division_name: div.name, teams_per_group: 2, advance_count: 2, random_assign: true }), '조 설정');
  must(await sb.from('teams').insert(Array.from({ length: 12 }, (_, i) => ({
    event_id: eventId, division_id: div.id, division_name: div.name, team_key: `${div.id}|d-${i + 1}`,
    team_name: `임시${i + 1}/x`, player1_name: `임시${i + 1}`, player2_name: 'x', pin_plain: String(430001 + i),
  }))), '팀');
  must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 2 }), '조편성');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id }), '조별 경기 생성');
  must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }), 'TBD 본선 생성');

  const groups = must(await sb.from('groups').select('id, group_num, group_label').eq('event_id', eventId).order('group_num'), 'groups');
  const all = async () => must(await sb.from('matches').select('*').eq('event_id', eventId).order('slot'), 'matches');
  const one = async id => must(await sb.from('matches').select('*').eq('id', id).single(), 'match');
  const nodes = async () => must(await sb.from('bracket_nodes').select('*').eq('event_id', eventId), 'nodes');
  const upd = async (id, patch, label = 'update') => must(await sb.from('matches').update(patch).eq('id', id), label);
  const finish = async (m, winnerId, score = '6:2') => upd(m.id, { status: 'FINISHED', score, winner_team_id: winnerId, ended_at: new Date().toISOString() }, '점수 입력');
  const audits = async like => must(await sb.from('audit_log').select('action, details, target_id').eq('event_id', eventId).like('action', like), 'audit');

  // ── A ─────────────────────────────────────────────────────
  console.log('\n━━━ A) 부전승 자리의 조 순위 재배치 ━━━');
  let ms = await all(); let bn = await nodes();
  const fin0 = ms.filter(m => m.stage === 'FINALS');
  // "N조 1위" 라벨 하나만 있고 반대쪽이 비어 있는 경기 = 부전승 예정 자리
  const byeSeat = fin0.map(f => {
    const la = f.qualifier_label_a, lb = f.qualifier_label_b;
    if (la && !lb && !f.team_b_id) return { f, side: 'a', label: la };
    if (lb && !la && !f.team_a_id) return { f, side: 'b', label: lb };
    return null;
  }).find(Boolean);
  if (!byeSeat) throw new Error('부전승 예정 자리를 찾지 못함: ' + JSON.stringify(fin0.map(f => [f.round, f.qualifier_label_a, f.qualifier_label_b])));
  const gLabel = byeSeat.label.replace(/\s*\d+위$/, ''), rank = Number(byeSeat.label.match(/(\d+)위$/)[1]);
  const gA = groups.find(g => g.group_label === gLabel);
  const gm = ms.find(m => m.stage === 'GROUP' && m.group_id === gA.id);
  const otherLabel = `${gLabel} ${rank === 1 ? 2 : 1}위`;
  console.log(`   부전승 자리: ${byeSeat.f.match_num} "${byeSeat.label}" · 조 경기 ${gm.match_num}`);
  // 처음엔 team_a 승 (오입력) → 정정해서 team_b 승
  await finish(gm, gm.team_a_id, '6:2');
  ms = await all();
  let byeM = ms.find(m => m.id === byeSeat.f.id);
  const firstSeated = byeM[`team_${byeSeat.side}_id`];
  const node = bn.find(n => n.match_id === byeM.id);
  let nextM = node?.next_match_id ? ms.find(m => m.id === node.next_match_id) : null;
  ok(byeM.score === 'BYE' && byeM.status === 'FINISHED' && byeM.winner_team_id === firstSeated, `조 종료 → 부전승 경기 채워짐 (BYE, 승자=${rank}위 팀)`);
  ok(!!nextM && nextM[`team_${node.next_slot.toLowerCase()}_id`] === firstSeated, '부전승 팀이 다음 라운드 자리에 올라감');
  const expectAfter = firstSeated === gm.team_a_id ? gm.team_b_id : gm.team_a_id;
  await upd(gm.id, { score: '6:5', winner_team_id: gm.team_b_id }, '조 점수 정정');
  ms = await all(); byeM = ms.find(m => m.id === byeSeat.f.id); nextM = ms.find(m => m.id === node.next_match_id);
  const seatOf = label => { for (const f of ms.filter(m => m.stage === 'FINALS')) { if (f.qualifier_src_a === label) return f.team_a_id; if (f.qualifier_src_b === label) return f.team_b_id; } return undefined; };
  ok(byeM[`team_${byeSeat.side}_id`] === expectAfter && byeM.winner_team_id === expectAfter && byeM.score === 'BYE', '정정 후 부전승 경기의 팀·승자가 새 순위 팀으로 바뀜');
  ok(nextM[`team_${node.next_slot.toLowerCase()}_id`] === expectAfter, '다음 라운드 자리도 새 팀으로 바뀜');
  ok(seatOf(otherLabel) === firstSeated, `"${otherLabel}" 자리 = 원래 부전승에 있던 팀`);
  ok((await audits('reseat_%')).filter(a => a.action === 'reseat_applied').length === 1, 'audit_log reseat_applied 1건');

  // ── B ─────────────────────────────────────────────────────
  console.log('\n━━━ B) 자동 시작 ━━━');
  ms = await all();
  const gRest = ms.filter(m => m.stage === 'GROUP' && m.status !== 'FINISHED');
  const [X, Y, Y2] = gRest;
  // 두 팀이 모두 미정인 본선 경기 (4강)
  const Z = ms.find(m => m.stage === 'FINALS' && !m.team_a_id && !m.team_b_id && !m.qualifier_label_a && !m.qualifier_label_b);
  if (!X || !Y || !Y2 || !Z) throw new Error('B 준비 실패');
  await upd(X.id, { court: 'T-1', court_order: 1 }); await upd(Y.id, { court: 'T-1', court_order: 2 });
  await upd(Y2.id, { court: 'T-1', court_order: 3 }); await upd(Z.id, { court: 'T-1', court_order: 4 });
  const live = async court => (await all()).filter(m => m.court === court && m.status === 'IN_PROGRESS').map(m => m.match_num);
  await finish(X, X.team_a_id);
  ok((await one(Y.id)).status === 'IN_PROGRESS', '앞 경기 종료 → 다음 경기(두 팀 확정) 자동 시작');
  await upd(X.id, { status: 'PENDING', score: null, winner_team_id: null, ended_at: null }, '초기화');
  await finish(X, X.team_b_id);
  let lv = await live('T-1');
  ok(lv.length === 1 && (await one(Y2.id)).status === 'PENDING', `점수 초기화 후 재입력해도 진행 중은 1개 (지금 ${lv.length}개)`);
  await finish(await one(Y.id), Y.team_a_id);
  ok((await one(Y2.id)).status === 'IN_PROGRESS', '진행 중 경기가 끝나면 그 다음 경기 시작');
  await finish(await one(Y2.id), Y2.team_a_id);
  const z1 = await one(Z.id);
  ok(z1.status === 'PENDING' && !z1.started_at, '팀이 미정인 경기는 자동 시작하지 않음');

  // ── C ─────────────────────────────────────────────────────
  console.log('\n━━━ C) 선수 PIN 점수 입력 보호 ━━━');
  // 남은 조 경기를 모두 끝내 본선 1라운드를 채움
  for (const m of (await all()).filter(m => m.stage === 'GROUP' && m.status !== 'FINISHED')) await finish(m, m.team_a_id);
  // 방금 끝낸 조 경기들이 '2분 규칙'에 걸리지 않게 종료 시각을 10분 전으로
  must(await sb.from('matches').update({ ended_at: new Date(Date.now() - 10 * 60e3).toISOString() }).eq('event_id', eventId).eq('status', 'FINISHED'), '종료 시각 조정');
  ms = await all(); bn = await nodes();
  const fins = ms.filter(m => m.stage === 'FINALS');
  // 두 팀이 확정된 1라운드 경기 q1 과 그 다음 경기 n1
  const q1 = fins.find(f => f.team_a_id && f.team_b_id && f.status !== 'FINISHED' && bn.find(n => n.match_id === f.id)?.next_match_id);
  if (!q1) throw new Error('두 팀이 확정된 본선 경기가 없음');
  const q1node = bn.find(n => n.match_id === q1.id); const n1id = q1node.next_match_id;
  const P = q1.team_a_id;   // 점수를 넣는 팀
  const tok = must(await sb.from('pin_sessions').insert({ token: randomUUID(), event_id: eventId, team_id: P, division_name: div.name, expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }).select().single(), 'pin 세션').token;
  const submit = (mid, score) => sb.rpc('rpc_pin_submit_score', { p_token: tok, p_match_id: mid, p_score: score });
  // 상대 미정: q1 을 P 승으로 넣기 전에, 상대가 빈 경기에 P 를 앉혀 놓고 시도
  const n1before = await one(n1id);
  const otherSlot = q1node.next_slot === 'A' ? 'b' : 'a';
  const savedOther = n1before[`team_${otherSlot}_id`];
  await upd(n1id, { [`team_${q1node.next_slot.toLowerCase()}_id`]: P, [`team_${otherSlot}_id`]: null, status: 'IN_PROGRESS' }, 'n1 준비');
  let r = await submit(n1id, '6:3');
  ok(/정해지지 않은/.test(errOf(r)), `상대 미정 경기 → 거절 ("${errOf(r).slice(0, 30)}…")`);
  await upd(n1id, { [`team_${q1node.next_slot.toLowerCase()}_id`]: n1before[`team_${q1node.next_slot.toLowerCase()}_id`], [`team_${otherSlot}_id`]: savedOther, status: 'PENDING', started_at: null }, 'n1 복구');
  r = await submit(q1.id, '6:3');
  ok(!errOf(r) && (await one(q1.id)).status === 'FINISHED', '자기 경기 점수 저장 성공' + (errOf(r) ? ' — ' + errOf(r) : ''));
  ok((await one(n1id))[`team_${q1node.next_slot.toLowerCase()}_id`] === P, '승자가 다음 라운드에 올라감');
  // 다음 경기에 상대를 채워 놓고(다른 확정 팀), 곧바로 또 입력
  const filler = fins.find(f => f.id !== q1.id && f.team_a_id && f.team_a_id !== P)?.team_a_id;
  if (!(await one(n1id))[`team_${otherSlot}_id`]) await upd(n1id, { [`team_${otherSlot}_id`]: filler }, 'n1 상대 채움');
  r = await submit(n1id, '6:3');
  ok(/방금 앞 경기/.test(errOf(r)) && (await one(n1id)).status !== 'FINISHED', `앞 경기 직후 다음 경기 입력 → 거절 ("${errOf(r).slice(0, 24)}…")`);
  await upd(q1.id, { ended_at: new Date(Date.now() - 3 * 60e3).toISOString() }, '3분 전으로');
  r = await submit(n1id, '6:3');
  ok(!errOf(r) && (await one(n1id)).status === 'FINISHED', '2분이 지난 뒤에는 저장됨');

  // ── D ─────────────────────────────────────────────────────
  console.log('\n━━━ D) 점수 초기화 → 다음 라운드 되돌림 ━━━');
  const atok = must(await sb.from('admin_pin_sessions').insert({ token: randomUUID(), event_id: eventId, expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }).select().single(), 'admin 세션').token;
  const unlock = mid => sb.rpc('rpc_admin_pin_unlock_match', { p_token: atok, p_match_id: mid, p_reason: '테스트' });
  // n1 은 끝났고(P 승) 그 승자가 다음 경기(n2)에 올라가 있음 → q1 초기화는 거절돼야 함 (n1 에 결과 있음)
  r = await unlock(q1.id);
  ok(/다음 라운드/.test(errOf(r)) && (await one(q1.id)).status === 'FINISHED', `다음 경기에 결과가 있으면 초기화 거절 ("${errOf(r).slice(0, 26)}…")`);
  // n1 초기화: 같은 코트 다음 경기가 같이 켜졌다가 되돌아가는지
  ms = await all();
  const n1 = ms.find(m => m.id === n1id); const n1node = bn.find(n => n.match_id === n1id);
  const n2slot = n1node?.next_match_id ? `team_${n1node.next_slot.toLowerCase()}_id` : null;
  if (n2slot) ok((await one(n1node.next_match_id))[n2slot] === n1.winner_team_id, '(준비) n1 승자가 그 다음 경기에 올라가 있음');
  // 코트 T-2: n1 을 다시 끝내며 다음 경기가 자동으로 켜지게
  const W1 = fins.find(f => ![q1.id, n1id, n1node?.next_match_id].includes(f.id) && f.team_a_id && f.team_b_id && f.status === 'PENDING');
  if (!W1) throw new Error('D 준비: 대기 경기 없음');
  r = await unlock(n1id);
  ok(!errOf(r) && (await one(n1id)).status === 'PENDING', 'n1 초기화 성공');
  if (n2slot) ok((await one(n1node.next_match_id))[n2slot] === null, '다음 라운드에 올라간 팀이 빠짐');
  ok((await audits('unadvance_%')).some(a => a.action === 'unadvance_applied' && a.target_id === n1id), 'audit_log unadvance_applied');
  await upd(n1id, { court: 'T-2', court_order: 1 }); await upd(W1.id, { court: 'T-2', court_order: 2 });
  await sb.rpc('rpc_admin_pin_update_score', { p_token: atok, p_match_id: n1id, p_score: '6:1', p_winner_team_id: P });
  const afterFin = await one(n1id);
  ok(afterFin.status === 'FINISHED' && (await one(W1.id)).status === 'IN_PROGRESS', '(준비) n1 종료 → 같은 코트 다음 경기 자동 시작');
  r = await unlock(n1id);
  ok(!errOf(r) && (await one(W1.id)).status === 'PENDING' && r.data?.stopped_next === 1, '초기화하면 같이 켜진 다음 경기도 대기로');
  // 다른 경로(직접 수정)로 승자를 지워도 되돌림
  const q2 = (await all()).find(f => f.stage === 'FINALS' && f.team_a_id && f.team_b_id && f.status !== 'FINISHED' && f.id !== W1.id && f.id !== n1id && bn.find(n => n.match_id === f.id)?.next_match_id);
  if (q2) {
    const nd = bn.find(n => n.match_id === q2.id); const col = `team_${nd.next_slot.toLowerCase()}_id`;
    await finish(q2, q2.team_b_id); must(await sb.rpc('advance_winner', { p_match_id: q2.id }), 'advance');
    ok((await one(nd.next_match_id))[col] === q2.team_b_id, '(준비) 직접 입력 + 진출');
    await upd(q2.id, { status: 'PENDING', score: null, winner_team_id: null, ended_at: null }, '직접 초기화');
    ok((await one(nd.next_match_id))[col] === null, '직접 수정으로 결과를 지워도 다음 라운드 자리가 비워짐 (트리거)');
  }

  // ── E ─────────────────────────────────────────────────────
  console.log('\n━━━ E) 코트·순서 지정 / 대기로 되돌리기 ━━━');
  const courts = ['T-3', 'T-4'];
  const venue = must(await sb.from('venues').insert({ event_id: eventId, name: 'T-검증장', courts }).select().single(), 'venue');
  const mkVs = async admin => must(await sb.from('venue_sessions').insert({ token: randomUUID(), event_id: eventId, venue_id: venue.id, venue_name: venue.name, courts, is_admin: admin, expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }).select().single(), 'venue 세션').token;
  const vAdmin = await mkVs(true), vPlain = await mkVs(false);
  const place = (t, mid, court, before = null, pend = false) => sb.rpc('rpc_venue_admin_place_match', { p_token: t, p_match_id: mid, p_court: court, p_before_match_id: before, p_set_pending: pend });
  const pool = (await all()).filter(m => m.status === 'PENDING' && m.score == null).slice(0, 6);
  if (pool.length < 6) throw new Error('E 준비: 대기 경기 부족 ' + pool.length);
  const [a, b, c, d, e, f] = pool;
  for (const m of pool) await upd(m.id, { court: null, court_order: null, status: 'PENDING', started_at: null });
  await upd(a.id, { court: 'T-3', court_order: 1 }); await upd(b.id, { court: 'T-3', court_order: 2 }); await upd(c.id, { court: 'T-3', court_order: 3 });
  const orderOf = async court => (await all()).filter(m => m.court === court).sort((x, y) => x.court_order - y.court_order).map(m => m.match_num).join(',');
  r = await place(vPlain, d.id, 'T-3', b.id);
  ok(/마스터 PIN/.test(errOf(r)), '경기장 PIN(관리자 아님) → 거절');
  r = await place(vAdmin, d.id, 'T-3', b.id);
  ok(!errOf(r) && await orderOf('T-3') === [a, d, b, c].map(m => m.match_num).join(','), `미배정 경기를 2번째에 넣기 → ${await orderOf('T-3')}`);
  r = await place(vAdmin, c.id, 'T-3', a.id);
  ok(!errOf(r) && await orderOf('T-3') === [c, a, d, b].map(m => m.match_num).join(','), `같은 코트 안에서 맨 앞으로 → ${await orderOf('T-3')}`);
  r = await place(vAdmin, e.id, 'T-4', null);
  ok(!errOf(r) && (await one(e.id)).court === 'T-4' && (await one(e.id)).court_order === 1, '빈 코트 맨 뒤(=첫 번째)로 넣기');
  r = await place(vAdmin, f.id, 'X-없는코트', null);
  ok(/자기 경기장/.test(errOf(r)), '내 경기장 코트가 아니면 거절');
  // 진행 중 겹침: T-3 의 c, a 를 둘 다 진행 중으로 → a 를 진행 중 경기(e)가 있는 T-4 로
  await upd(c.id, { status: 'IN_PROGRESS', started_at: new Date().toISOString() }); await upd(a.id, { status: 'IN_PROGRESS', started_at: new Date().toISOString() });
  await upd(e.id, { status: 'IN_PROGRESS', started_at: new Date().toISOString() });
  r = await place(vAdmin, a.id, 'T-4', null, false);
  ok(r.data?.success === false && r.data?.code === 'target_busy' && (await one(a.id)).court === 'T-3', '진행 중 경기를 진행 중 경기가 있는 코트로(그대로) → 거절');
  r = await place(vAdmin, a.id, 'T-4', null, true);
  const a2 = await one(a.id);
  ok(!errOf(r) && a2.court === 'T-4' && a2.court_order === 2 && a2.status === 'PENDING' && !a2.started_at, '대기로 바꿔서 옮기기 → 옮겨지고 대기 상태');
  r = await sb.rpc('rpc_venue_admin_set_match_pending', { p_token: vAdmin, p_match_id: c.id });
  ok(!errOf(r) && (await one(c.id)).status === 'PENDING', '진행 중 → 대기로 되돌리기');
  r = await sb.rpc('rpc_venue_admin_set_match_pending', { p_token: vAdmin, p_match_id: c.id });
  ok(/진행 중/.test(errOf(r)), '이미 대기인 경기는 거절');
  r = await sb.rpc('rpc_venue_admin_set_match_pending', { p_token: vPlain, p_match_id: e.id });
  ok(/마스터 PIN/.test(errOf(r)) && (await one(e.id)).status === 'IN_PROGRESS', '경기장 PIN 은 대기로 되돌리기 불가');

  console.log(`\n══ 결과: ✅ ${pass} / ❌ ${fail} ══`);
}

main().catch(e => { fail++; console.error('\n❌ 테스트 중단:', e.message); }).finally(async () => { await cleanup(); process.exit(fail ? 1 : 0); });
