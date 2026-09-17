// ============================================================
// 3팀 조 "승자 우선" 규칙 E2E 테스트 (마이그레이션 016)
// 실행: node scripts/test-group3-winner-next.mjs
//
// 규칙: 1번 vs 2번 먼저 → 이긴 팀이 곧바로(같은 코트) 3번과 → 마지막에 진 팀이 3번과
// 검증:
//   T1 조편성 시 group_members.seq = 1,2,3… 저장
//   T2 경기 생성 순서 = (1v2) → (1v3) → (2v3)
//   T3 [2번 승리] 남은 경기 순서가 (2v3) → (1v3) 로 바뀜 + 자동시작된 경기 = (2v3)
//   T4 [1번 승리] 순서 유지 (1v3) → (2v3) + 자동시작 = (1v3)
//   T5 4팀 조는 순서 변화 없음 (기존 방식)
//   T6 3팀 조의 두 번째 경기가 끝날 땐 아무것도 안 바꿈
// 안전: __TEST_SIM_ 접두사 이벤트만 사용, 끝나면 삭제
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

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };

let eventId = null;
async function cleanup() {
  if (!eventId) return;
  const mids = (await sb.from('matches').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const gids = (await sb.from('groups').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  if (mids.length) await sb.from('bracket_nodes').delete().in('match_id', mids);
  await sb.from('audit_log').delete().eq('event_id', eventId);
  if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
  for (const t of ['matches', 'groups', 'group_settings', 'venues', 'teams', 'divisions', 'sync_log']) await sb.from(t).delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

async function main() {
  // ── 셋업 ──
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_조3_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'preparing', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  const { data: ev, error: ee } = await sb.from('events').insert(row).select().single();
  if (ee) throw new Error('이벤트 생성: ' + ee.message);
  eventId = ev.id;

  async function makeDivision(divName, teamCount) {
    const { data: div } = await sb.from('divisions').insert({ event_id: eventId, name: divName, sort_order: 1 }).select().single();
    const rows = Array.from({ length: teamCount }, (_, i) => ({
      event_id: eventId, division_id: div.id, division_name: div.name,
      team_key: `${div.id}|g3-${i + 1}`, team_name: `${divName}-팀${i + 1}`,
      player1_name: `선수${i + 1}`, player2_name: `파트너${i + 1}`, pin_plain: String(200001 + i),
    }));
    const { error } = await sb.from('teams').insert(rows);
    if (error) throw new Error('팀 생성: ' + error.message);
    return div;
  }

  // 부서A: 10팀, 조크기 3 → 실DB 규칙상 [3,3,2,2]  /  부서B: 4팀, 조크기 4 → [4]
  const divA = await makeDivision('부서A', 10);
  const divB = await makeDivision('부서B', 4);

  for (const [div, size] of [[divA, 3], [divB, 4]]) {
    const g = await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: size });
    if (g.error) throw new Error('조편성: ' + g.error.message);
    const m = await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id });
    if (m.error) throw new Error('경기 생성: ' + m.error.message);
  }

  const { data: groups } = await sb.from('groups').select('id, group_label, division_id, group_num').eq('event_id', eventId).order('group_num');
  const { data: members } = await sb.from('group_members').select('group_id, team_id, seq').eq('event_id', eventId);
  const bySeq = (gid) => members.filter(x => x.group_id === gid).sort((a, b) => (a.seq ?? 99) - (b.seq ?? 99));
  const fetchGroupMatches = async (gid) =>
    (await sb.from('matches').select('id, slot, court, court_order, status, team_a_id, team_b_id, winner_team_id').eq('group_id', gid).order('slot')).data;

  console.log('\n━━━ T1: 조편성 시 순번(seq) 저장 ━━━');
  const sizes = groups.map(g => bySeq(g.id).length);
  console.log('   조 크기:', groups.map((g, i) => `${g.group_label}(${sizes[i]}팀)`).join(', '));
  const seqOk = groups.every(g => { const ms = bySeq(g.id); return ms.every((x, i) => x.seq === i + 1); });
  check('모든 조의 seq가 1부터 연속으로 저장됨', seqOk);

  const g3 = groups.filter(g => g.division_id === divA.id && bySeq(g.id).length === 3);
  const g4 = groups.find(g => g.division_id === divB.id && bySeq(g.id).length === 4);
  check('3팀 조 2개 + 4팀 조 1개 확보', g3.length >= 2 && !!g4, `3팀조 ${g3.length}개, 4팀조 ${g4 ? 1 : 0}개`);

  console.log('\n━━━ T2: 경기 생성 순서 = (1v2) → (1v3) → (2v3) ━━━');
  for (const g of g3.slice(0, 2)) {
    const [s1, s2, s3] = bySeq(g.id).map(x => x.team_id);
    const ms = await fetchGroupMatches(g.id);
    const pairOf = (m) => [m.team_a_id, m.team_b_id];
    const same = (p, a, b) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a);
    const ok = ms.length === 3 && same(pairOf(ms[0]), s1, s2) && same(pairOf(ms[1]), s1, s3) && same(pairOf(ms[2]), s2, s3);
    check(`${g.group_label}: slot 순서가 1v2 → 1v3 → 2v3`, ok);
  }

  // 코트 배정: 조의 3경기를 같은 코트에 slot 순으로 (자동배정과 동일한 모양)
  async function assign(gid, court) {
    const ms = await fetchGroupMatches(gid);
    for (let i = 0; i < ms.length; i++) await sb.from('matches').update({ court, court_order: i + 1 }).eq('id', ms[i].id);
  }
  const label = (m, seqs) => { const n = id => seqs.indexOf(id) + 1; return `${n(m.team_a_id)}v${n(m.team_b_id)}`; };

  console.log('\n━━━ T3: [2번 승리] → 남은 경기는 (2v3) 먼저, (1v3) 마지막 ━━━');
  {
    const g = g3[0]; const seqs = bySeq(g.id).map(x => x.team_id); const [s1, s2] = seqs;
    await assign(g.id, 'T-1');
    const before = await fetchGroupMatches(g.id);
    console.log('   결과 입력 전 코트순서:', before.map(m => `${label(m, seqs)}(#${m.court_order})`).join(' → '));
    const r = await sb.rpc('rpc_submit_match_result', { p_match_id: before[0].id, p_score: '3:6', p_winner_team_id: s2 });
    check('1경기(1v2) 결과 입력 성공 — 트리거가 점수 저장을 막지 않음', !r.error, r.error?.message || '');
    const after = (await fetchGroupMatches(g.id)).filter(m => m.status !== 'FINISHED').sort((a, b) => a.court_order - b.court_order);
    console.log('   결과 입력 후 남은 경기:', after.map(m => `${label(m, seqs)}(#${m.court_order}, slot ${m.slot}, ${m.status})`).join(' → '));
    check('코트순서: (2v3)이 먼저', label(after[0], seqs) === '2v3' && label(after[1], seqs) === '1v3');
    const bySlot = [...after].sort((a, b) => a.slot - b.slot);
    check('slot 순서도 (2v3)이 먼저 (자동배정용)', label(bySlot[0], seqs) === '2v3');
    const started = after.find(m => m.status === 'IN_PROGRESS');
    check('"다음 경기 자동 시작"이 (2v3)을 시작시킴 (패자 경기 아님)', started && label(started, seqs) === '2v3', started ? label(started, seqs) + ' 시작됨' : '자동 시작된 경기 없음');

    console.log('\n━━━ T6: 같은 조의 두 번째 경기 종료 시엔 순서 변경 없음 ━━━');
    const second = after[0];
    const r2 = await sb.rpc('rpc_submit_match_result', { p_match_id: second.id, p_score: '6:4', p_winner_team_id: second.team_a_id });
    check('2경기 결과 입력 성공', !r2.error, r2.error?.message || '');
    const last = (await fetchGroupMatches(g.id)).filter(m => m.status !== 'FINISHED');
    check('마지막 경기는 (1v3) 하나 남고 코트순서 #3 유지', last.length === 1 && label(last[0], seqs) === '1v3' && last[0].court_order === 3,
      last.map(m => `${label(m, seqs)}(#${m.court_order}, ${m.status})`).join(', '));
  }

  console.log('\n━━━ T4: [1번 승리] → 순서 유지 (1v3) → (2v3) ━━━');
  {
    const g = g3[1]; const seqs = bySeq(g.id).map(x => x.team_id); const [s1] = seqs;
    await assign(g.id, 'T-2');
    const before = await fetchGroupMatches(g.id);
    const r = await sb.rpc('rpc_submit_match_result', { p_match_id: before[0].id, p_score: '6:2', p_winner_team_id: s1 });
    check('1경기(1v2) 결과 입력 성공', !r.error, r.error?.message || '');
    const after = (await fetchGroupMatches(g.id)).filter(m => m.status !== 'FINISHED').sort((a, b) => a.court_order - b.court_order);
    console.log('   결과 입력 후 남은 경기:', after.map(m => `${label(m, seqs)}(#${m.court_order}, ${m.status})`).join(' → '));
    check('코트순서: (1v3) 먼저, (2v3) 마지막 — 그대로', label(after[0], seqs) === '1v3' && label(after[1], seqs) === '2v3');
    const started = after.find(m => m.status === 'IN_PROGRESS');
    check('자동 시작된 경기 = (1v3) (승자 1번의 경기)', started && label(started, seqs) === '1v3', started ? label(started, seqs) + ' 시작됨' : '자동 시작 없음');
  }

  console.log('\n━━━ T5: 4팀 조는 기존 방식 그대로 (순서 변화 없음) ━━━');
  {
    const seqs = bySeq(g4.id).map(x => x.team_id);
    await assign(g4.id, 'T-3');
    const before = await fetchGroupMatches(g4.id);
    const snap = (arr) => arr.filter(m => m.id !== before[0].id).map(m => `${m.id}:${m.slot}:${m.court_order}`).sort().join('|');
    const snapBefore = snap(before);
    // 일부러 "뒤 순번 팀"이 이기게 해서, 규칙이 잘못 적용되면 순서가 바뀌도록 유도
    const r = await sb.rpc('rpc_submit_match_result', { p_match_id: before[0].id, p_score: '2:6', p_winner_team_id: before[0].team_b_id });
    check('4팀 조 1경기 결과 입력 성공', !r.error, r.error?.message || '');
    const afterAll = await fetchGroupMatches(g4.id);
    check('나머지 5경기의 slot·코트순서가 전혀 안 바뀜', snap(afterAll) === snapBefore,
      afterAll.filter(m => m.status !== 'FINISHED').sort((a, b) => a.court_order - b.court_order).map(m => `${label(m, seqs)}(#${m.court_order})`).join(' → '));
  }
}

main()
  .catch(e => { console.error('\n❌ 테스트 중단:', e.message); results.push({ name: 'fatal', ok: false }); })
  .finally(async () => {
    await cleanup();
    const pass = results.filter(r => r.ok).length;
    console.log(`\n╔══════════════════════════════╗\n   결과: ${pass} / ${results.length} 통과\n╚══════════════════════════════╝`);
    process.exit(pass === results.length ? 0 : 1);
  });
