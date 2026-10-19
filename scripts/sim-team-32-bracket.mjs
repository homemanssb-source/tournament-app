// ============================================================
// 시뮬: 단체전 본선 32강 브래킷 (17~32팀 진출) — 우승팀 1팀까지 이어지는지
// 실행: node scripts/sim-team-32-bracket.mjs [--keep]   (임시 대회 생성 → 끝나면 삭제)
//  23클럽 → 11조 (2팀×10 + 3팀×1), 조별 2팀 진출 = 22팀 → 32 브래킷 (부전승 10)
//  조별 전부 진행 → 자리 채움 → 본선 라운드 순서대로 모든 대전 진행 → 마지막에 남은 대전/우승팀 확인
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

const KEEP = process.argv.includes('--keep');
const ROUNDS = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final'];
let eventId = null, pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

async function cleanup() {
  if (!eventId) return;
  if (KEEP) { console.log('보존: ' + eventId); return; }
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
const rec = async (rubberId, winA) => must(await sb.rpc('rpc_admin_record_score', { p_rubber_id: rubberId, p_set1_a: winA ? 6 : 2, p_set1_b: winA ? 2 : 6 }), '점수');
const allTies = async () => must(await sb.from('ties').select('*').eq('event_id', eventId).order('bracket_position'), '대전');
const summary = (ts) => {
  const m = {};
  ts.filter(t => t.round !== 'group').sort((a, b) => ROUNDS.indexOf(a.round) - ROUNDS.indexOf(b.round))
    .forEach(t => { m[t.round] = (m[t.round] || 0) + 1; });
  return m;
};

// 대전 하나를 club_a 승리로 진행 (토너먼트는 과반에서 멈춤, 조별은 전부)
async function playA(tie) {
  const rs = await rubbersOf(tie.id);
  for (const r of rs) {
    const t = must(await sb.from('ties').select('status').eq('id', tie.id).single(), '상태');
    if (t.status === 'completed') break;
    const res = await rec(r.id, true);
    if (!res.success) throw new Error(`${tie.round}#${tie.bracket_position} 러버${r.rubber_number}: ${res.error}`);
  }
}

async function main() {
  const name = `__TEST_TEAM_r32_${Date.now()}`;
  eventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'admin_only', team_match_type: '3_doubles',
  }).select().single(), '이벤트').id;
  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('clubs').insert(Array.from({ length: 23 }, (_, i) => ({
    event_id: eventId, division_id: div.id, name: `임시${i + 1}`, captain_pin: String(730000 + i),
  }))), '클럽');
  const g = must(await sb.rpc('rpc_create_team_groups', { p_event_id: eventId, p_group_count: 11, p_group_size: 2, p_division_id: div.id }), '조편성');
  if (!g.success) throw new Error('조편성: ' + g.error);
  const groups = must(await sb.from('groups').select('id,group_label').eq('event_id', eventId).order('group_num'), '조');
  const sizes = await Promise.all(groups.map(async gr => (must(await sb.from('team_standings').select('club_id').eq('group_id', gr.id), '조원')).length));
  console.log('조 크기:', sizes.join(','));

  console.log('\n1. 조별 진행 전 본선 생성 (3부와 같은 상태)');
  const gen = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true }), '생성');
  let ts = await allTies();
  console.log('   생성 결과:', JSON.stringify(gen), '\n   라운드별 대전 수:', JSON.stringify(summary(ts)));
  ok(gen.success, '생성 성공');

  console.log('\n2. 조별 전부 진행 (club_a 승)');
  for (const t of ts.filter(t => t.round === 'group' && !t.is_bye)) await playA(t);
  ts = await allTies();
  const order = [...new Set(ts.filter(t => t.round !== 'group').map(t => t.round))].sort((a, b) => ROUNDS.indexOf(a) - ROUNDS.indexOf(b));
  const fr = ts.filter(t => t.round === order[0]);
  const unfilled = fr.filter(t => t.qualifier_label_a || t.qualifier_label_b);
  ok(unfilled.length === 0, `1라운드(${order[0]}) 이름표 자리 모두 채워짐 (남은 ${unfilled.length})`);
  ok(fr.filter(t => t.is_bye).length === 10, `부전승 10개 (${fr.filter(t => t.is_bye).length})`);

  console.log('\n3. 본선 라운드 순서대로 진행');
  for (const rd of order) {
    ts = await allTies();
    const rt = ts.filter(t => t.round === rd);
    let played = 0, stuck = 0;
    for (const t of rt) {
      if (t.is_bye || t.status === 'completed') continue;
      if (!t.club_a_id || !t.club_b_id) { stuck++; continue; }
      await playA(t); played++;
    }
    ts = await allTies();
    const done = ts.filter(t => t.round === rd && (t.status === 'completed' || t.is_bye)).length;
    console.log(`   ${rd}: 대전 ${rt.length}, 진행 ${played}, 상대 미정 ${stuck}, 종료 ${done}`);
    ok(stuck === 0, `${rd} 모든 대전 양팀 확정`);
  }

  console.log('\n4. 최종 확인');
  ts = await allTies();
  const ko = ts.filter(t => t.round !== 'group');
  const sum = summary(ts);
  console.log('   라운드별 대전 수:', JSON.stringify(sum));
  const finals = ko.filter(t => t.round === 'final');
  ok(finals.length === 1, `결승 대전 1개 (${finals.length})`);
  ok(finals.map(t => t.winning_club_id).filter(Boolean).length === 1, `우승팀 1팀 (${finals.map(t => t.winning_club_id).filter(Boolean).length})`);
  ok(ko.every(t => t.status === 'completed' || t.is_bye), '본선 미종료 대전 없음');
  const want = { round_of_32: 16, round_of_16: 8, quarter: 4, semi: 2, final: 1 };
  ok(Object.keys(want).every(k => sum[k] === want[k]), '라운드 구성 32강16·16강8·8강4·4강2·결승1');
}

try { await main(); } catch (e) { console.error('💥', e.message); fail++; }
await cleanup();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
