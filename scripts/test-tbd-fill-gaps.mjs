// ============================================================
// 검증: TBD 본선 슬롯 채움의 두 구멍 (migration 018)
// 실행: node scripts/test-tbd-fill-gaps.mjs      (임시 대회를 만들고 끝나면 스스로 지운다)
//
//  T1  조 마지막 경기와 같은 코트에 그 조를 기다리는 TBD 본선 경기가 있으면
//      자동 시작(IN_PROGRESS)된 뒤에도 슬롯이 채워져야 한다.
//  T2  슬롯이 채워진 뒤 조별 점수를 정정해 1·2위가 바뀌면 본선 자리도 바뀌어야 한다.
//  T3  같은 점수를 다시 저장하면 아무 일도 없어야 한다 (audit 추가 없음).
//  T4  바뀌어야 할 본선 경기에 이미 점수가 있으면 아무것도 바꾸지 않고 reseat_skipped 만 남긴다.
//
//  각 조 점수 설계 (X=1번, Y=2번, Z=3번):  X>Y 6:2,  Y>Z 6:5,  Z>X 6:2(오입력) → 정정 6:5
//     오입력 기준: Z +3, X 0, Y -3  → 1위 Z, 2위 X
//     정정 후    : X +3, Z 0, Y -3  → 1위 X, 2위 Z
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
  const mids = (await sb.from('matches').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const gids = (await sb.from('groups').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  if (mids.length) await sb.from('bracket_nodes').delete().in('match_id', mids);
  await sb.from('audit_log').delete().eq('event_id', eventId);
  await sb.from('pin_sessions').delete().eq('event_id', eventId);
  if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
  for (const t of ['matches', 'groups', 'group_settings', 'teams', 'divisions']) await sb.from(t).delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

async function main() {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_TBD채움_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  eventId = must(await sb.from('events').insert(row).select().single(), '이벤트 생성').id;

  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('group_settings').insert({ event_id: eventId, division_id: div.id, division_name: div.name, teams_per_group: 3, advance_count: 2, random_assign: true }), '조 설정');
  must(await sb.from('teams').insert(Array.from({ length: 6 }, (_, i) => ({
    event_id: eventId, division_id: div.id, division_name: div.name, team_key: `${div.id}|d-${i + 1}`,
    team_name: `임시${i + 1}/x`, player1_name: `임시${i + 1}`, player2_name: 'x', pin_plain: String(350001 + i),
  }))), '팀');
  must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 3 }), '조편성');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id }), '조별 경기 생성');

  const groups = must(await sb.from('groups').select('id, group_num, group_label').eq('event_id', eventId).order('group_num'), 'groups');
  const members = must(await sb.from('group_members').select('group_id, team_id, seq').eq('event_id', eventId), 'members');
  const nm = {}; // team_id → 'A1'
  groups.forEach((g, gi) => members.filter(m => m.group_id === g.id).forEach(m => { nm[m.team_id] = `${'AB'[gi]}${m.seq}`; }));
  const idOf = key => Object.keys(nm).find(id => nm[id] === key);

  const pre = must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }), 'TBD 본선 생성');
  console.log(`\n━━━ 0) TBD 본선 미리 생성 — TBD 슬롯 ${pre?.tbd_slots ?? '?'}개 ━━━`);

  const finals = async () => must(await sb.from('matches').select('*').eq('event_id', eventId).eq('stage', 'FINALS').order('slot'), 'finals');
  const seatOf = (fs, label) => { for (const f of fs) { if (f.qualifier_label_a === label || f.qualifier_src_a === label) return { f, side: 'a' }; if (f.qualifier_label_b === label || f.qualifier_src_b === label) return { f, side: 'b' }; } return null; };
  const teamAt = (fs, label) => { const s = seatOf(fs, label); return s ? (nm[s.f[`team_${s.side}_id`]] || null) : undefined; };
  const audits = async () => must(await sb.from('audit_log').select('action, details').eq('event_id', eventId).like('action', 'reseat_%'), 'audit');

  // 조 경기 진행: 남은 경기 중 slot 순으로 하나씩. 마지막 경기는 courtHook 으로 코트를 걸 수 있다.
  async function playGroup(g, L, courtHook) {
    const res = { [`${L}1-${L}2`]: [`${L}1`, '6:2'], [`${L}2-${L}3`]: [`${L}2`, '6:5'], [`${L}1-${L}3`]: [`${L}3`, '6:2'] };
    for (;;) {
      const left = must(await sb.from('matches').select('*').eq('group_id', g.id).neq('status', 'FINISHED').order('slot'), 'left');
      if (!left.length) break;
      const m = left[0];
      if (left.length === 1 && courtHook) await courtHook(m);
      const [w, score] = res[[nm[m.team_a_id], nm[m.team_b_id]].sort().join('-')];
      must(await sb.from('matches').update({ status: 'FINISHED', score, winner_team_id: idOf(w), ended_at: new Date().toISOString() }).eq('id', m.id), '점수 입력');
    }
  }
  const zx = async (L) => { const a = idOf(`${L}1`), z = idOf(`${L}3`); return must(await sb.from('matches').select('*').eq('event_id', eventId).eq('stage', 'GROUP').or(`and(team_a_id.eq.${a},team_b_id.eq.${z}),and(team_a_id.eq.${z},team_b_id.eq.${a})`).single(), 'Z-X 경기'); };

  // ── T1 ─────────────────────────────────────────────────────
  console.log('\n━━━ T1) 같은 코트에서 자동 시작된 TBD 본선 경기도 채워지는가 ━━━');
  const gA = groups[0], lab1 = `${gA.group_label} 1위`, lab2 = `${gA.group_label} 2위`;
  let fs = await finals();
  const target = seatOf(fs, lab1);
  if (!target) throw new Error(`"${lab1}" 라벨 슬롯을 찾지 못함: ` + JSON.stringify(fs.map(f => [f.qualifier_label_a, f.qualifier_label_b])));
  must(await sb.from('matches').update({ court: 'T-검증', court_order: 2 }).eq('id', target.f.id), '본선 코트');
  await playGroup(gA, 'A', async (last) => { must(await sb.from('matches').update({ court: 'T-검증', court_order: 1 }).eq('id', last.id), '조 경기 코트'); });
  fs = await finals();
  const t1 = fs.find(f => f.id === target.f.id);
  console.log(`   ${t1.match_num}: status=${t1.status}, ${lab1} 자리=${nm[t1[`team_${target.side}_id`]] ?? '(빈칸)'}, label=${t1[`qualifier_label_${target.side}`]}, src=${t1[`qualifier_src_${target.side}`]}`);
  ok(t1.status === 'IN_PROGRESS', '조 마지막 경기 종료 → 같은 코트 본선 경기 자동 시작됨 (재현 조건)');
  ok(nm[t1[`team_${target.side}_id`]] === 'A3', `자동 시작된 경기의 "${lab1}" 슬롯 = A3 (오입력 기준 1위)`);
  ok(teamAt(fs, lab2) === 'A1', `"${lab2}" 슬롯 = A1`);
  ok(t1[`qualifier_src_${target.side}`] === lab1, '출처(qualifier_src) 보존');

  // ── T2 ─────────────────────────────────────────────────────
  console.log('\n━━━ T2) 조별 점수 정정(6:2 → 6:5) → 1·2위 교체가 본선에 반영되는가 ━━━');
  must(await sb.from('matches').update({ score: '6:5' }).eq('id', (await zx('A')).id), '점수 정정');
  fs = await finals();
  console.log(`   ${lab1} = ${teamAt(fs, lab1)}, ${lab2} = ${teamAt(fs, lab2)}`);
  ok(teamAt(fs, lab1) === 'A1' && teamAt(fs, lab2) === 'A3', '정정 후 1위 자리 = A1, 2위 자리 = A3');
  let au = await audits();
  ok(au.filter(a => a.action === 'reseat_applied').length === 1, 'audit_log 에 reseat_applied 1건');

  // ── T3 ─────────────────────────────────────────────────────
  console.log('\n━━━ T3) 같은 점수 재저장 → 변화 없음 ━━━');
  must(await sb.from('matches').update({ score: '6:5', locked_reason: '관리자 수정' }).eq('id', (await zx('A')).id), '재저장');
  fs = await finals(); au = await audits();
  ok(teamAt(fs, lab1) === 'A1' && teamAt(fs, lab2) === 'A3' && au.length === 1, '자리 그대로, audit 추가 없음');

  // ── T4 ─────────────────────────────────────────────────────
  console.log('\n━━━ T4) 이미 점수가 들어간 본선 경기는 건드리지 않는가 ━━━');
  const gB = groups[1], b1 = `${gB.group_label} 1위`, b2 = `${gB.group_label} 2위`;
  await playGroup(gB, 'B');
  fs = await finals();
  ok(teamAt(fs, b1) === 'B3' && teamAt(fs, b2) === 'B1', `B조 채움: ${b1} = B3, ${b2} = B1`);
  const played = seatOf(fs, b1).f;
  must(await sb.from('matches').update({ status: 'FINISHED', score: '6:0', winner_team_id: played.team_a_id, ended_at: new Date().toISOString() }).eq('id', played.id), '본선 경기 종료');
  must(await sb.from('matches').update({ score: '6:5' }).eq('id', (await zx('B')).id), 'B조 점수 정정');
  fs = await finals(); au = await audits();
  console.log(`   ${b1} = ${teamAt(fs, b1)}, ${b2} = ${teamAt(fs, b2)}`);
  ok(teamAt(fs, b1) === 'B3' && teamAt(fs, b2) === 'B1', '끝난 경기가 끼어 있으면 두 자리 모두 그대로 (전부 or 전무)');
  ok(au.filter(a => a.action === 'reseat_skipped').length === 1, 'audit_log 에 reseat_skipped 1건');
  ok(teamAt(fs, lab1) === 'A1' && teamAt(fs, lab2) === 'A3', 'A조 자리는 영향 없음');

  console.log(`\n══ 결과: ✅ ${pass} / ❌ ${fail} ══`);
}

main().catch(e => { fail++; console.error('\n❌ 테스트 중단:', e.message); }).finally(async () => { await cleanup(); process.exit(fail ? 1 : 0); });
