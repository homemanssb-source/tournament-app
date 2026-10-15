// ============================================================
// 검증: 개인전 본선 조별 3위 진출 (migration 029)
// 실행: node scripts/test-third-place-029.mjs      (임시 대회를 만들고 끝나면 스스로 지운다)
//
//  16팀, 4명 조 → 4개 조, 각 조 3위까지 진출 → 12팀, 본선 16강(BYE 4)
//   P1  미리 생성(TBD): 1R 자리에 "N조 1·2·3위" 12개 이름표가 전부 한 번씩
//   P2  BYE 4개는 1위 자리(시드 1~4) 맞은편, 1R 에 같은 조끼리 대결 없음
//   P3  조 경기를 끝내면 이름표가 모두 실제 팀으로 채워지고, 각 조 3위도 대진에 들어감
//   P4  예선 완료 후 생성(TBD 아님)에서도 12팀 전부 대진에
//  조 경기 결과: 조 내 순번(seq)이 작은 팀이 항상 이김 → 1위=1번, 2위=2번, 3위=3번
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
  if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
  for (const t of ['matches', 'groups', 'group_settings', 'teams', 'divisions']) await sb.from(t).delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 대회 정리 완료');
}

async function deleteFinals(divId) {
  const ids = (await sb.from('matches').select('id').eq('division_id', divId).eq('stage', 'FINALS')).data.map(r => r.id);
  if (ids.length) must(await sb.from('bracket_nodes').delete().in('match_id', ids), '본선 노드 삭제');
  must(await sb.from('matches').delete().eq('division_id', divId).eq('stage', 'FINALS'), '본선 삭제');
}

async function main() {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_3위진출029_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  eventId = must(await sb.from('events').insert(row).select().single(), '이벤트 생성').id;

  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '3위검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('group_settings').insert({ event_id: eventId, division_id: div.id, division_name: div.name, teams_per_group: 4, advance_count: 3, random_assign: true }), '조 설정');
  must(await sb.from('teams').insert(Array.from({ length: 16 }, (_, i) => ({
    event_id: eventId, division_id: div.id, division_name: div.name, team_key: `${div.id}|t-${i + 1}`,
    team_name: `삼위검증${i + 1}/x`, player1_name: `삼위검증${i + 1}`, player2_name: 'x', pin_plain: String(390001 + i),
  }))), '팀');
  must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 4 }), '조편성');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id }), '조별 경기');

  const groups = must(await sb.from('groups').select('id, group_num, group_label').eq('division_id', div.id).order('group_num'), 'groups');
  const mem = must(await sb.from('group_members').select('group_id, team_id, seq').eq('division_id', div.id), 'members');
  const seqOf = Object.fromEntries(mem.map(m => [m.team_id, m.seq]));
  const thirds = groups.map(g => mem.find(m => m.group_id === g.id && m.seq === 3).team_id);

  const finals = async () => must(await sb.from('matches').select('id, round, slot, team_a_id, team_b_id, qualifier_label_a, qualifier_label_b, score, winner_team_id').eq('division_id', div.id).eq('stage', 'FINALS').order('slot'), 'finals');
  const firstRound = fs => fs.filter(m => m.round === fs[0].round);

  console.log('\n━━━ P1·P2) 미리 생성(TBD), 각 조 3위까지 ━━━');
  const pre = must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 3, p_allow_tbd: true }), 'TBD 본선');
  ok(pre.adv_teams === 12 && pre.bracket_size === 16 && pre.byes === 4, `진출 ${pre.adv_teams}팀, ${pre.bracket_size}강, BYE ${pre.byes}`);
  let r1 = firstRound(await finals());
  console.log('     1R:', r1.map(m => `[${m.qualifier_label_a ?? '·'} vs ${m.qualifier_label_b ?? 'BYE'}]`).join(' '));
  const labels = r1.flatMap(m => [m.qualifier_label_a, m.qualifier_label_b]).filter(Boolean);
  const want = groups.flatMap(g => [1, 2, 3].map(k => `${g.group_label} ${k}위`));
  ok(labels.length === 12 && new Set(labels).size === 12 && want.every(w => labels.includes(w)), `이름표 ${labels.length}개, 모두 다름, 각 조 1·2·3위 전부 포함`);
  const byeMatches = r1.filter(m => !m.qualifier_label_a || !m.qualifier_label_b);
  const grpOf = l => (l || '').split(' ')[0];
  ok(r1.every(m => !m.qualifier_label_a || !m.qualifier_label_b || grpOf(m.qualifier_label_a) !== grpOf(m.qualifier_label_b)), '1R 에 같은 조끼리 대결 없음');
  ok(byeMatches.length === 4 && byeMatches.every(m => / 1위$/.test(m.qualifier_label_a || m.qualifier_label_b || '')), 'BYE 4개 모두 조 1위 맞은편');

  console.log('\n━━━ P3) 조 경기 완료 → 3위까지 실제 팀으로 채움 ━━━');
  const gm = must(await sb.from('matches').select('id, team_a_id, team_b_id').eq('division_id', div.id).eq('stage', 'GROUP').order('slot'), '조 경기');
  for (const m of gm) {
    const w = seqOf[m.team_a_id] < seqOf[m.team_b_id] ? m.team_a_id : m.team_b_id;
    must(await sb.from('matches').update({ status: 'FINISHED', score: '6:2', winner_team_id: w, ended_at: new Date().toISOString() }).eq('id', m.id), '조 결과');
  }
  r1 = firstRound(await finals());
  const leftLabels = r1.flatMap(m => [m.qualifier_label_a, m.qualifier_label_b]).filter(Boolean);
  const seated = r1.flatMap(m => [m.team_a_id, m.team_b_id]).filter(Boolean);
  ok(leftLabels.length === 0, `남은 이름표 ${leftLabels.length}개`);
  ok(seated.length === 12 && new Set(seated).size === 12, `1R 에 ${seated.length}팀, 중복 없음`);
  ok(thirds.every(t => seated.includes(t)), '각 조 3위(3번) 4팀 모두 대진에 있음');

  console.log('\n━━━ P4) 예선 완료 후 생성 (TBD 아님) ━━━');
  await deleteFinals(div.id);
  const gen = must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 3, p_allow_tbd: false }), '본선');
  r1 = firstRound(await finals());
  const seated2 = r1.flatMap(m => [m.team_a_id, m.team_b_id]).filter(Boolean);
  ok(gen.adv_teams === 12 && seated2.length === 12 && new Set(seated2).size === 12, `1R 에 ${seated2.length}팀, 중복 없음`);
  ok(thirds.every(t => seated2.includes(t)), '각 조 3위 4팀 모두 대진에 있음');
  ok(r1.filter(m => m.score === 'BYE').length === 4, `BYE 처리 ${r1.filter(m => m.score === 'BYE').length}경기`);
}

try { await main(); }
catch (e) { console.error('💥', e.message); fail++; }
finally {
  await cleanup();
  console.log(`\n결과: ✅ ${pass}  ❌ ${fail}`);
  process.exit(fail ? 1 : 0);
}
