// ============================================================
// 진단: 점수 저장 방향(승자 먼저 vs 팀A:팀B) 과 조별 순위/본선 진출
// 실행: node scripts/test-standings-score-orientation.mjs [--v2] [--tbd]
//   --v2  : 다른 점수 설계(정답 A3)   --tbd : 본선을 미리(TBD) 생성해 두고 rpc_fill_tournament_slots 경로 검증
//
// 3팀 조에서 1승1패 3자 동률을 만들고, "득실차를 어떻게 읽느냐"에 따라
// 1위가 달라지도록 점수를 설계한다.
//   M1  1번 vs 2번 : 2번 승 6:0   (팀B 승리)
//   M2  1번 vs 3번 : 1번 승 6:5   (팀A 승리)
//   M3  2번 vs 3번 : 3번 승 6:4   (팀B 승리)
//   올바른 득실차 : 2번 +4, 3번 +1, 1번 -5   → 1위 = 2번
//   위치 기준 오독: 1번 +7, 3번 -3, 2번 -4   → 1위 = 1번  (틀림)
// 점수는 실제 선수 경로(rpc_pin_login → rpc_pin_submit_score)로 넣는다.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sb = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let eventId = null;
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
  const name = `__TEST_SIM_순위진단_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  const { data: ev, error: ee } = await sb.from('events').insert(row).select().single();
  if (ee) throw new Error('이벤트 생성: ' + ee.message);
  eventId = ev.id;

  const { data: div } = await sb.from('divisions').insert({ event_id: eventId, name: '진단부', sort_order: 1 }).select().single();
  await sb.from('group_settings').insert({ event_id: eventId, division_id: div.id, division_name: div.name, teams_per_group: 3, advance_count: 1, random_assign: true });
  await sb.from('teams').insert(Array.from({ length: 6 }, (_, i) => ({
    event_id: eventId, division_id: div.id, division_name: div.name, team_key: `${div.id}|d-${i + 1}`,
    team_name: `임시${i + 1}/x`, player1_name: `임시${i + 1}`, player2_name: 'x', pin_plain: String(330001 + i),
  })));
  const g = await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 3 });
  if (g.error) throw new Error('조편성: ' + g.error.message);

  const { data: groups } = await sb.from('groups').select('id, group_num').eq('event_id', eventId).order('group_num');
  const { data: members } = await sb.from('group_members').select('group_id, team_id, seq').eq('event_id', eventId);
  const team = {}; // 'A1' → { id, pin }
  for (let gi = 0; gi < groups.length; gi++) for (const m of members.filter(x => x.group_id === groups[gi].id)) {
    const key = `${'AB'[gi]}${m.seq}`; const pin = String(340000 + (gi + 1) * 10 + m.seq);
    team[key] = { id: m.team_id, pin };
    await sb.from('teams').update({ team_name: `${'AB'[gi]}조${m.seq}번/x`, player1_name: `${'AB'[gi]}조${m.seq}번`, pin_plain: pin }).eq('id', m.team_id);
  }
  const nameOf = id => Object.entries(team).find(([, v]) => v.id === id)?.[0] || '?';

  const mk = await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id });
  if (mk.error) throw new Error('경기 생성: ' + mk.error.message);
  const { data: ms } = await sb.from('matches').select('id, group_id, team_a_id, team_b_id').eq('event_id', eventId);
  const matchOf = (x, y) => ms.find(m => (m.team_a_id === team[x].id && m.team_b_id === team[y].id) || (m.team_a_id === team[y].id && m.team_b_id === team[x].id));

  // 실제 선수 경로: 승자가 PIN 로그인 → 앱이 보내는 형식 그대로 제출
  //   앱(pin/matches)은 내가 A면 "내점수:상대", 내가 B면 "상대:내점수" 를 보낸다
  async function playerSubmits(winnerKey, loserKey, winGames, loseGames) {
    const m = matchOf(winnerKey, loserKey);
    const login = await anon.rpc('rpc_pin_login', { p_pin_code: team[winnerKey].pin, p_event_id: eventId });
    if (login.error) throw new Error(`PIN 로그인(${winnerKey}): ` + login.error.message);
    const token = login.data?.token;
    const mySide = m.team_a_id === team[winnerKey].id ? 'A' : 'B';
    const sent = mySide === 'A' ? `${winGames}:${loseGames}` : `${loseGames}:${winGames}`;
    const r = await anon.rpc('rpc_pin_submit_score', { p_token: token, p_match_id: m.id, p_score: sent });
    if (r.error) throw new Error(`점수 제출(${winnerKey}): ` + r.error.message);
    const { data: saved } = await sb.from('matches').select('score, winner_team_id').eq('id', m.id).single();
    console.log(`   ${nameOf(m.team_a_id)} vs ${nameOf(m.team_b_id)} | 승자 ${winnerKey}(팀${mySide}) | 앱이 보낸 값 "${sent}" → DB 저장 "${saved.score}" | 승자기록 ${nameOf(saved.winner_team_id)}`);
    return { sent, saved: saved.score, mySide };
  }

  const TBD = process.argv.includes('--tbd');
  if (TBD) {
    const pre = await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 1, p_allow_tbd: true });
    if (pre.error) throw new Error('TBD 본선 미리 생성: ' + pre.error.message);
    console.log('\n━━━ 0) [--tbd] 점수 입력 전 본선 미리 생성 → TBD 슬롯 ' + (pre.data?.tbd_slots ?? '?') + '개 ━━━');
  }

  console.log('\n━━━ 1) 선수 PIN 경로로 점수 입력 — 저장 형식 관찰 ━━━');
  const obs = [];
  const V2 = process.argv.includes('--v2');
  if (!V2) {
    obs.push(await playerSubmits('A2', 'A1', 6, 0));   // 팀B 승리
    obs.push(await playerSubmits('A1', 'A3', 6, 5));   // 팀A 승리
    obs.push(await playerSubmits('A3', 'A2', 6, 4));   // 팀B 승리
  } else {
    // 변형: 정답=A3(+4), 위치 오독=A2(+5), 순번 1번=A1(+1/+3) — 셋 다 다른 팀
    obs.push(await playerSubmits('A2', 'A1', 6, 5));   // 팀B 승리
    obs.push(await playerSubmits('A1', 'A3', 6, 4));   // 팀A 승리
    obs.push(await playerSubmits('A3', 'A2', 6, 0));   // 팀B 승리
  }
  // B조는 평범하게: 1번 전승
  await playerSubmits('B1', 'B2', 6, 1); await playerSubmits('B1', 'B3', 6, 1); await playerSubmits('B2', 'B3', 6, 1);
  const bWins = obs.filter(o => o.mySide === 'B');
  const rewritten = bWins.filter(o => o.sent !== o.saved).length;
  console.log(`   → 팀B 승리 ${bWins.length}건 중 ${rewritten}건이 "승자 먼저"로 바뀌어 저장됨`);

  console.log('\n━━━ 2) 본선 생성 (조 1위만 진출) — DB가 A조 1위로 누구를 올리는가 ━━━');
  if (TBD) {
    for (const g of groups) { const r = await sb.rpc('rpc_fill_tournament_slots', { p_event_id: eventId, p_group_id: g.id }); if (r.error) throw new Error('슬롯 채우기: ' + r.error.message); }
    console.log('   [--tbd] rpc_fill_tournament_slots 로 TBD 슬롯 채움 (조 완료 시 트리거가 먼저 채웠을 수 있음)');
  } else {
    const gen = await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 1, p_allow_tbd: false });
    if (gen.error) throw new Error('본선 생성: ' + gen.error.message);
  }
  const { data: finals } = await sb.from('matches').select('team_a_id, team_b_id').eq('event_id', eventId).eq('stage', 'FINALS');
  const advanced = [...new Set((finals || []).flatMap(f => [f.team_a_id, f.team_b_id]).filter(Boolean))].map(nameOf).sort();
  console.log('   본선 진출팀:', advanced.join(', '));
  const aAdv = advanced.find(n => n.startsWith('A'));
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  const V2b = process.argv.includes('--v2'); const truth = V2b ? 'A3' : 'A2', misread = V2b ? 'A2' : 'A1';
  console.log('   A조 올바른 1위 = ' + truth + '   /   위치 기준 오독 시 = ' + misread + (V2b ? '   /   (순번 1번 = A1)' : ''));
  console.log(`   DB가 본선에 올린 A조 팀 = ${aAdv}  →  ${aAdv === truth ? '✅ DB 진출 로직은 올바름' : (aAdv === misread ? '❌ DB 진출 로직이 득실차를 거꾸로 읽음 (오독 예측과 정확히 일치)' : '❓ 예측 밖 결과')}`);
  console.log('   (017 적용 후 기대: ✅ / 화면 순위표도 52dd469 부터 승자 기준으로 동일하게 계산)');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch(e => console.error('\n❌ 진단 중단:', e.message)).finally(async () => { await cleanup(); process.exit(0); });
