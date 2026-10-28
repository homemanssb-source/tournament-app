// ============================================================
// 036·038 검증: 단체전 3팀 조 첫 대전이 끝나면 승자 대전이 앞으로 오는지 (038: 라인업 미리 제출해도)
//   node scripts/test-team-group3-036.mjs        → 임시 대회 만들고 시나리오 실행 후 삭제
// 임시 대회 이름: '테스트_036_' 로 시작 (실패해도 다음 실행 때 먼저 지움)
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
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

const PREFIX = '테스트_036_';
let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${msg}`); };

async function cleanup() {
  const evs = must(await sb.from('events').select('id').like('name', PREFIX + '%'), 'events');
  for (const ev of evs) {
    const tieIds = (await sb.from('ties').select('id').eq('event_id', ev.id)).data?.map(r => r.id) || [];
    if (tieIds.length) await sb.from('tie_rubbers').delete().in('tie_id', tieIds);
    await sb.from('ties').delete().eq('event_id', ev.id);
    await sb.from('team_standings').delete().eq('event_id', ev.id);
    await sb.from('audit_log').delete().eq('event_id', ev.id);
    await sb.from('groups').delete().eq('event_id', ev.id);
    await sb.from('clubs').delete().eq('event_id', ev.id);
    await sb.from('divisions').delete().eq('event_id', ev.id);
    const { error } = await sb.from('events').delete().eq('id', ev.id);
    if (error) console.log('⚠️ 삭제 실패', error.message);
  }
}

// 3클럽 조 하나 + 대전 3개 (1v2, 1v3, 2v3), 같은 코트 순서 1·2·3
async function setup(tag) {
  const ev = must(await sb.from('events').insert({
    name: PREFIX + tag, event_key: 'test-036-' + Date.now() + tag, date: '2099-01-01', location: '테스트',
    status: 'preparing', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: false, lineup_mode: 'captain_pin', team_match_type: '3_doubles',
  }).select().single(), '대회');
  const div = must(await sb.from('divisions').insert({ event_id: ev.id, name: '테스트부', sort_order: 1 }).select().single(), '부서');
  const [c1, c2, c3] = must(await sb.from('clubs').insert(['가', '나', '다'].map((n, i) => (
    { event_id: ev.id, division_id: div.id, name: n + '클럽', captain_name: n, captain_pin: '03600' + i }
  ))).select(), '클럽').sort((a, b) => a.name.localeCompare(b.name));
  const grp = must(await sb.from('groups').insert({ event_id: ev.id, division_id: div.id, group_label: 'A조', group_num: 1, advance_count: 2 }).select().single(), '조');
  const pairs = [[c1, c2], [c1, c3], [c2, c3]];
  const ties = must(await sb.from('ties').insert(pairs.map(([a, b], i) => ({
    event_id: ev.id, division_id: div.id, group_id: grp.id, round: 'group', tie_order: i + 1,
    club_a_id: a.id, club_b_id: b.id, rubber_count: 3, status: 'pending', court_number: 1, court_order: i + 1,
  }))).select(), '대전').sort((a, b) => a.tie_order - b.tie_order);
  return { c1, c2, c3, ties };
}
const read = async ids => must(await sb.from('ties').select('id,tie_order,court_order,club_a_id,club_b_id').in('id', ids), 'read');

await cleanup();
try {
  // ① 2번 클럽(나)이 첫 대전 승리 → 나 vs 다 가 2번째로
  {
    const { c2, ties } = await setup('1');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: c2.id }).eq('id', ties[0].id), '완료');
    const after = await read(ties.map(t => t.id));
    const t13 = after.find(t => t.id === ties[1].id), t23 = after.find(t => t.id === ties[2].id);
    check(t23.tie_order === 2 && t13.tie_order === 3, `① 승자(나) 대전 tie_order 2 (나vs다=${t23.tie_order}, 가vs다=${t13.tie_order})`);
    check(t23.court_order === 2 && t13.court_order === 3, `① court_order도 교체 (나vs다=${t23.court_order}, 가vs다=${t13.court_order})`);
    check(t23.club_a_id === ties[2].club_a_id && t13.club_b_id === ties[1].club_b_id, '① 클럽은 그대로');
  }
  // ② 1번 클럽(가)이 승리 → 이미 가 vs 다 가 2번째라 그대로
  {
    const { c1, ties } = await setup('2');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: c1.id }).eq('id', ties[0].id), '완료');
    const after = await read(ties.map(t => t.id));
    check(after.find(t => t.id === ties[1].id).tie_order === 2 && after.find(t => t.id === ties[2].id).tie_order === 3, '② 승자(가) 대전이 이미 앞 → 변경 없음');
  }
  // ③ 승자 없음(무효) → 변경 없음
  {
    const { ties } = await setup('3');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: null }).eq('id', ties[0].id), '완료');
    const after = await read(ties.map(t => t.id));
    check(after.find(t => t.id === ties[1].id).tie_order === 2, '③ 승자 없는 대전 → 변경 없음');
  }
  // ④ 두 번째 대전이 끝날 때는 손대지 않음
  {
    const { c2, c3, ties } = await setup('4');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: c2.id }).eq('id', ties[0].id), '완료1');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: c3.id }).eq('id', ties[2].id), '완료2');
    const after = await read(ties.map(t => t.id));
    check(after.find(t => t.id === ties[2].id).tie_order === 2 && after.find(t => t.id === ties[1].id).tie_order === 3, '④ 둘째 대전 완료 시 순서 유지');
  }
  // ⑤ (038) 남은 두 대전에 라인업을 미리 냄(lineup_ready / lineup_phase) → 그래도 승자 대전이 앞으로
  {
    const { c2, ties } = await setup('5');
    must(await sb.from('ties').update({ status: 'lineup_ready', club_a_lineup_submitted: true, club_b_lineup_submitted: true, lineup_revealed: true }).eq('id', ties[1].id), '라인업1');
    must(await sb.from('ties').update({ status: 'lineup_phase', club_a_lineup_submitted: true }).eq('id', ties[2].id), '라인업2');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: c2.id }).eq('id', ties[0].id), '완료');
    const after = await read(ties.map(t => t.id));
    const t13 = after.find(t => t.id === ties[1].id), t23 = after.find(t => t.id === ties[2].id);
    check(t23.tie_order === 2 && t13.tie_order === 3 && t23.court_order === 2 && t13.court_order === 3, `⑤ 라인업 제출 후에도 승자(나) 대전이 2번째 (나vs다=${t23.tie_order}/${t23.court_order}, 가vs다=${t13.tie_order}/${t13.court_order})`);
  }
  // ⑥ 남은 대전 하나가 이미 진행 중 → 순서 유지
  {
    const { c2, ties } = await setup('6');
    must(await sb.from('ties').update({ status: 'in_progress' }).eq('id', ties[1].id), '진행');
    must(await sb.from('ties').update({ status: 'completed', winning_club_id: c2.id }).eq('id', ties[0].id), '완료');
    const after = await read(ties.map(t => t.id));
    check(after.find(t => t.id === ties[1].id).tie_order === 2 && after.find(t => t.id === ties[2].id).tie_order === 3, '⑥ 진행 중인 대전이 있으면 순서 유지');
  }
} finally {
  await cleanup();
}
console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
