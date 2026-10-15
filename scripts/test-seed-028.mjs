// ============================================================
// 검증: 시드 배정 (migration 028) — 개인전·단체전
// 실행: node scripts/test-seed-028.mjs      (임시 대회를 만들고 끝나면 스스로 지운다)
//
//  개인전 (16팀, 4명 조 → 4개 조, 각 조 2명 진출 → 본선 8강)
//   I1  시드 1~4 → 1~4조 첫 자리, 시드끼리 같은 조 없음
//   I2  본선(TBD): 1조 1위=1번 자리(맨 위), 2조 1위=맨 아래 절반 첫 자리 → 1·2번 시드는 결승에서만
//       3·4번 시드 조 1위도 서로 다른 4분의1
//   I3  시드가 조 수보다 많아도 오류 없이 생성(뱀 순서), 1·2번 시드는 여전히 1·2조
//   I4  시드 없음 → 기존처럼 랜덤 생성 (seeds 0)
//   I5  BYE: 9팀 3개 조 1명 진출(본선 4) + 시드 2 → BYE 는 1번 시드 자리 맞은편
//  단체전 (12팀, 3팀 조 → A~D 4개 조, 조 2팀 진출 → 8강)
//   T1  시드 1~4 → A~D조, 시드끼리 같은 조 없음
//   T2  본선(TBD): A조 1위=1번 대전 위, B조 1위=3번 대전 위(아래 절반)
//   T3  전 클럽 시드여도 오류 없음
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

let indEventId = null, teamEventId = null, pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

async function cleanupInd() {
  if (!indEventId) return;
  const eventId = indEventId;
  const mids = (await sb.from('matches').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const gids = (await sb.from('groups').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  if (mids.length) await sb.from('bracket_nodes').delete().in('match_id', mids);
  await sb.from('audit_log').delete().eq('event_id', eventId);
  if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
  for (const t of ['matches', 'groups', 'group_settings', 'teams', 'divisions']) await sb.from(t).delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 개인전 정리 실패: ' + error.message : '🧹 개인전 테스트 대회 정리 완료');
}

async function cleanupTeam() {
  if (!teamEventId) return;
  const eventId = teamEventId;
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
  console.log(error ? '⚠️ 단체전 정리 실패: ' + error.message : '🧹 단체전 테스트 대회 정리 완료');
}

// ── 개인전 ──
async function individual() {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_시드028_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  indEventId = must(await sb.from('events').insert(row).select().single(), '이벤트 생성').id;
  const eventId = indEventId;

  async function makeDiv(label, n, sort) {
    const div = must(await sb.from('divisions').insert({ event_id: eventId, name: label, sort_order: sort }).select().single(), '부서');
    must(await sb.from('group_settings').insert({ event_id: eventId, division_id: div.id, division_name: div.name, teams_per_group: 4, advance_count: 2, random_assign: true }), '조 설정');
    const teams = must(await sb.from('teams').insert(Array.from({ length: n }, (_, i) => ({
      event_id: eventId, division_id: div.id, division_name: div.name, team_key: `${div.id}|s-${i + 1}`,
      team_name: `시드검증${i + 1}/x`, player1_name: `시드검증${i + 1}`, player2_name: 'x', pin_plain: String(380001 + sort * 100 + i),
    }))).select('id, team_name'), '팀');
    return { div, teams };
  }
  const setSeeds = async (teams, k) => {
    const ids = teams.map(t => t.id);
    must(await sb.from('teams').update({ seed_number: null }).in('id', ids), '시드 초기화');
    for (let i = 0; i < k; i++) must(await sb.from('teams').update({ seed_number: i + 1 }).eq('id', ids[i]), '시드');
  };
  const layout = async divId => {
    const groups = must(await sb.from('groups').select('id, group_num, group_label').eq('event_id', eventId).eq('division_id', divId).order('group_num'), 'groups');
    const mem = must(await sb.from('group_members').select('group_id, team_id, seq').eq('division_id', divId), 'members');
    const gnum = Object.fromEntries(groups.map(g => [g.id, g.group_num]));
    return Object.fromEntries(mem.map(m => [m.team_id, { g: gnum[m.group_id], seq: m.seq }]));
  };

  const { div, teams } = await makeDiv('시드부', 16, 1);

  console.log('\n━━━ I1) 시드 1~4 → 1~4조 첫 자리 ━━━');
  await setSeeds(teams, 4);
  const gen = must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 4 }), '조편성');
  ok(gen.groups_created === 4 && gen.seeds === 4, `조 ${gen.groups_created}개, 시드 ${gen.seeds}`);
  let lay = await layout(div.id);
  for (let k = 0; k < 4; k++) ok(lay[teams[k].id]?.g === k + 1 && lay[teams[k].id]?.seq === 1, `${k + 1}번 시드 → ${lay[teams[k].id]?.g}조 ${lay[teams[k].id]?.seq}번`);
  ok(new Set(teams.slice(0, 4).map(t => lay[t.id].g)).size === 4, '시드끼리 같은 조 없음');

  console.log('\n━━━ I2) 본선 8강(TBD) 시드 자리 ━━━');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id }), '조별 경기');
  const pre = must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }), '본선');
  ok(pre.bracket_size === 8, `본선 ${pre.bracket_size}강`);
  const fin = must(await sb.from('matches').select('round, slot, qualifier_label_a, qualifier_label_b').eq('event_id', eventId).eq('division_id', div.id).eq('stage', 'FINALS').order('slot'), 'finals');
  const r1 = fin.filter(m => m.round === fin[0].round);
  console.log('     1R:', r1.map(m => `[${m.qualifier_label_a} vs ${m.qualifier_label_b}]`).join(' '));
  ok(r1[0].qualifier_label_a === '1조 1위', `1번 자리(맨 위) = ${r1[0].qualifier_label_a}`);
  ok(r1[2].qualifier_label_a === '2조 1위', `아래 절반 첫 자리 = ${r1[2].qualifier_label_a} → 1·2번 시드 결승에서만`);
  ok(r1[3].qualifier_label_a === '3조 1위' && r1[1].qualifier_label_a === '4조 1위', `3·4번 시드 조 1위 서로 다른 4분의1 (${r1[3].qualifier_label_a} / ${r1[1].qualifier_label_a})`);
  const half = lbl => r1.findIndex(m => m.qualifier_label_a === lbl || m.qualifier_label_b === lbl) < 2 ? '위' : '아래';
  ok([1, 2, 3, 4].every(g => half(`${g}조 1위`) !== half(`${g}조 2위`)), '같은 조 1·2위는 반대 절반');

  console.log('\n━━━ I3) 시드 6 > 조 4 → 오류 없음(뱀 순서) ━━━');
  must(await sb.from('bracket_nodes').delete().in('match_id', (await sb.from('matches').select('id').eq('division_id', div.id).eq('stage', 'FINALS')).data.map(r => r.id)), '본선 정리');
  must(await sb.from('matches').delete().eq('division_id', div.id), '경기 정리');
  await setSeeds(teams, 6);
  const gen3 = must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 4 }), '조편성(시드 6)');
  lay = await layout(div.id);
  ok(gen3.seeds === 6, `시드 ${gen3.seeds}`);
  ok(lay[teams[0].id].g === 1 && lay[teams[1].id].g === 2, '1·2번 시드는 1·2조');
  ok(lay[teams[4].id].g === 4 && lay[teams[5].id].g === 3, `5·6번 시드 뱀 순서 → ${lay[teams[4].id].g}조·${lay[teams[5].id].g}조`);

  console.log('\n━━━ I4) 시드 없음 → 랜덤 ━━━');
  await setSeeds(teams, 0);
  const gen4 = must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 4 }), '조편성(시드 없음)');
  ok(gen4.seeds === 0 && gen4.groups_created === 4, `시드 ${gen4.seeds}, 조 ${gen4.groups_created}개`);

  console.log('\n━━━ I5) BYE 는 1번 시드 자리 맞은편 ━━━');
  const d2 = await makeDiv('BYE부', 9, 2);
  await setSeeds(d2.teams, 2);
  must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: d2.div.id, p_group_size: 3 }), '조편성');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: d2.div.id }), '조별 경기');
  const pre5 = must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: d2.div.id, p_advance_per_group: 1, p_allow_tbd: true }), '본선');
  const f5 = must(await sb.from('matches').select('round, qualifier_label_a, qualifier_label_b, team_b_id').eq('division_id', d2.div.id).eq('stage', 'FINALS').order('slot'), 'finals');
  console.log('     4강:', f5.slice(0, 2).map(m => `[${m.qualifier_label_a} vs ${m.qualifier_label_b ?? 'BYE'}]`).join(' '));
  ok(pre5.byes === 1 && f5[0].qualifier_label_a === '1조 1위' && !f5[0].qualifier_label_b && !f5[0].team_b_id, '1조 1위(1번 시드) 맞은편이 BYE');
  ok(f5[1].qualifier_label_a === '2조 1위', `2번 시드 조는 반대편 (${f5[1].qualifier_label_a})`);
}

// ── 단체전 ──
async function team() {
  const name = `__TEST_TEAM_seed028_${Date.now()}`;
  teamEventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'admin_only', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;
  const eventId = teamEventId;
  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '검증부', sort_order: 1 }).select().single(), '부서');
  const clubs = must(await sb.from('clubs').insert(Array.from({ length: 12 }, (_, i) => ({
    event_id: eventId, division_id: div.id, name: `시드클럽${i + 1}`, captain_pin: String(630001 + i),
    seed_number: i < 4 ? i + 1 : null,
  }))).select('id, name'), '클럽');

  console.log('\n━━━ T1) 시드 1~4 → A~D조 ━━━');
  const g = must(await sb.rpc('rpc_create_team_groups', { p_event_id: eventId, p_group_count: 4, p_group_size: 3, p_division_id: div.id }), '조편성');
  ok(g.success && g.group_count === 4 && g.seeds === 4, `조 ${g.group_count}개, 시드 ${g.seeds} ${g.error || ''}`);
  const groups = must(await sb.from('groups').select('id, group_num, group_label').eq('event_id', eventId).order('group_num'), 'groups');
  const st = must(await sb.from('team_standings').select('group_id, club_id').eq('event_id', eventId), 'standings');
  const gOf = Object.fromEntries(st.map(s => [s.club_id, groups.find(x => x.id === s.group_id)?.group_label]));
  for (let k = 0; k < 4; k++) ok(gOf[clubs[k].id] === `${'ABCD'[k]}조`, `${k + 1}번 시드 → ${gOf[clubs[k].id]}`);

  console.log('\n━━━ T2) 본선 8강(TBD) 시드 자리 ━━━');
  const gen = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }), '본선');
  ok(gen.success && gen.bracket_size === 8, `본선 ${gen.bracket_size}강 ${gen.error || ''}`);
  const qf = must(await sb.from('ties').select('bracket_position, qualifier_label_a, qualifier_label_b').eq('event_id', eventId).eq('round', 'quarter').order('bracket_position'), 'quarter');
  console.log('     8강:', qf.map(t => `[${t.qualifier_label_a} vs ${t.qualifier_label_b}]`).join(' '));
  ok(qf[0].qualifier_label_a === 'A조 1위', `1번 대전 위 = ${qf[0].qualifier_label_a}`);
  ok(qf[2].qualifier_label_a === 'B조 1위', `아래 절반 첫 자리 = ${qf[2].qualifier_label_a} → 1·2번 시드 결승에서만`);
  ok(qf[3].qualifier_label_a === 'C조 1위' && qf[1].qualifier_label_a === 'D조 1위', '3·4번 시드 서로 다른 4분의1');

  console.log('\n━━━ T3) 전 클럽 시드 → 오류 없음 ━━━');
  for (let i = 4; i < 12; i++) must(await sb.from('clubs').update({ seed_number: i + 1 }).eq('id', clubs[i].id), '시드');
  const g3 = must(await sb.rpc('rpc_create_team_groups', { p_event_id: eventId, p_group_count: 4, p_group_size: 3, p_division_id: div.id }), '조편성(전원 시드)');
  ok(g3.success && g3.seeds === 12, `성공 ${g3.success}, 시드 ${g3.seeds} ${g3.error || ''}`);
}

try {
  await individual();
  await team();
} catch (e) {
  console.error('💥', e.message); fail++;
} finally {
  await cleanupInd();
  await cleanupTeam();
  console.log(`\n결과: ✅ ${pass}  ❌ ${fail}`);
  process.exit(fail ? 1 : 0);
}
