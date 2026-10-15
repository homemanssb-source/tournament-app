// ============================================================
// 검증: 개인전 본선 결과 정정(오입력으로 승자 변경) → 다음 라운드 자리가 바뀌는지
// 실행: node scripts/test-finals-correction-individual.mjs   (임시 대회를 만들고 끝나면 지운다)
//
//  8팀, 4명 2개 조, 조 2위까지 → 4강·결승
//  C1  대시보드(코트 화면) 결과 입력 rpc_submit_match_result: 4강1 승자 A → 결승에 A, 정정해서 B → 결승 자리 B
//  C2  관리자 PIN 수정 rpc_admin_pin_update_score: B → A 로 정정 → 결승 자리 A, 감사 기록 old/new 승자
//  C3  현장 관리자 rpc_venue_submit_score: A → B 로 정정 → 결승 자리 B
//  C4  결승이 이미 끝난 뒤 4강 정정: 관리자 PIN 일반 수정은 거부, 강제 수정은 자리를 바꿈
//      (결승 결과는 그대로 남으므로 운영자가 결승을 다시 입력해야 함 — 화면 경고와 일치하는지 확인)
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
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let eventId = null, pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const info = msg => console.log(`   ℹ️  ${msg}`);
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

async function cleanup() {
  if (!eventId) return;
  const id = eventId;
  const mids = (await sb.from('matches').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
  const gids = (await sb.from('groups').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
  const tids = (await sb.from('teams').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
  if (mids.length) await sb.from('bracket_nodes').delete().in('match_id', mids);
  await sb.from('audit_log').delete().eq('event_id', id);
  await sb.from('venue_sessions').delete().eq('event_id', id);
  await sb.from('admin_pin_sessions').delete().eq('event_id', id);
  await sb.from('pin_attempts').delete().like('target_key', `%${id}%`);
  if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
  if (tids.length) await sb.from('team_pins').delete().in('team_id', tids);
  for (const t of ['matches', 'groups', 'group_settings', 'teams', 'venues', 'divisions']) await sb.from(t).delete().eq('event_id', id);
  await sb.from('event_secrets').delete().eq('event_id', id);
  const { error } = await sb.from('events').delete().eq('id', id);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 대회 정리 완료');
}

async function main() {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_본선정정_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  if ('app_a_connected' in row) row.app_a_connected = false;
  if ('app_a_event_id' in row) row.app_a_event_id = null;
  eventId = must(await sb.from('events').insert(row).select().single(), '대회').id;

  const div = must(await sb.from('divisions').insert({ event_id: eventId, name: '정정부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('group_settings').insert({ event_id: eventId, division_id: div.id, division_name: div.name, teams_per_group: 4, advance_count: 2, random_assign: true }), '조 설정');
  const teams = must(await sb.from('teams').insert(Array.from({ length: 8 }, (_, i) => ({
    event_id: eventId, division_id: div.id, division_name: div.name, team_key: `${div.id}|c-${i + 1}`,
    team_name: `정정${i + 1}/x`, player1_name: `정정${i + 1}`, player2_name: 'x', pin_plain: String(397001 + i),
  }))).select('id, team_name'), '팀');
  const nm = Object.fromEntries(teams.map(t => [t.id, t.team_name]));
  must(await sb.rpc('rpc_generate_groups', { p_event_id: eventId, p_division_id: div.id, p_group_size: 4 }), '조편성');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: eventId, p_division_id: div.id }), '조별 경기');
  const mem = must(await sb.from('group_members').select('team_id, seq').eq('division_id', div.id), '조원');
  const seq = Object.fromEntries(mem.map(m => [m.team_id, m.seq]));
  for (const m of must(await sb.from('matches').select('id, team_a_id, team_b_id').eq('division_id', div.id).eq('stage', 'GROUP'), '조 경기')) {
    const w = seq[m.team_a_id] < seq[m.team_b_id] ? m.team_a_id : m.team_b_id;
    must(await sb.from('matches').update({ status: 'FINISHED', score: '6:2', winner_team_id: w, ended_at: new Date().toISOString() }).eq('id', m.id), '조 결과');
  }
  must(await sb.rpc('rpc_generate_tournament', { p_event_id: eventId, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: false }), '본선');

  const fin = async () => {
    const ms = must(await sb.from('matches').select('*').eq('division_id', div.id).eq('stage', 'FINALS').order('slot'), '본선 조회');
    const bn = must(await sb.from('bracket_nodes').select('match_id, next_match_id, next_slot').in('match_id', ms.map(m => m.id)), 'nodes');
    const node = Object.fromEntries(bn.map(b => [b.match_id, b]));
    return { semis: ms.filter(m => node[m.id]?.next_match_id), final: ms.find(m => !node[m.id]?.next_match_id), node };
  };
  let { semis, final, node } = await fin();
  const S1 = semis[0], S2 = semis[1];
  const slotKey = `team_${node[S1.id].next_slot.toLowerCase()}_id`;   // 결승에서 4강1 승자가 들어가는 칸
  const A = S1.team_a_id, B = S1.team_b_id;
  const finalSlot = async () => (await fin()).final[slotKey];
  console.log(`\n   4강1: ${nm[A]} vs ${nm[B]} → 결승 ${node[S1.id].next_slot} 칸`);

  console.log('\nC1  대시보드 결과 입력 후 정정');
  must(await sb.rpc('rpc_submit_match_result', { p_match_id: S1.id, p_score: '6:3', p_winner_team_id: A }), '입력');
  ok(await finalSlot() === A, `처음 입력 승자 ${nm[A]} → 결승 자리 ${nm[await finalSlot()]}`);
  must(await sb.rpc('rpc_submit_match_result', { p_match_id: S1.id, p_score: '6:4', p_winner_team_id: B }), '정정');
  ok(await finalSlot() === B, `정정 승자 ${nm[B]} → 결승 자리 ${nm[await finalSlot()]}`);

  console.log('\nC2  관리자 PIN 수정');
  must(await sb.rpc('rpc_set_master_pin', { p_event_id: eventId, p_new_pin: '9731' }), '마스터 PIN');
  const aTok = must(await anon.rpc('rpc_admin_pin_login', { p_master_pin: '9731', p_event_id: eventId }), '관리자 로그인')?.token;
  ok(!!aTok, '관리자 PIN 로그인');
  must(await anon.rpc('rpc_admin_pin_update_score', { p_token: aTok, p_match_id: S1.id, p_score: '6:1', p_winner_team_id: A }), '관리자 정정');
  ok(await finalSlot() === A, `정정 승자 ${nm[A]} → 결승 자리 ${nm[await finalSlot()]}`);
  const aud = must(await sb.from('audit_log').select('details').eq('event_id', eventId).eq('action', 'admin_pin_update_score').order('created_at', { ascending: false }).limit(1), '감사');
  ok(aud[0]?.details?.old_winner === B && aud[0]?.details?.new_winner === A, '감사 기록에 이전/새 승자 남음');

  console.log('\nC3  현장 관리자(경기장 PIN) 정정');
  must(await sb.from('venues').insert({ event_id: eventId, name: '정정코트', short_name: 'Z', courts: ['Z-1'], court_count: 1, pin_plain: '397099' }), '경기장');
  const vTok = must(await anon.rpc('rpc_venue_login', { p_pin_code: '397099', p_event_id: eventId }), '경기장 로그인')?.token;
  ok(!!vTok, '경기장 PIN 로그인');
  must(await anon.rpc('rpc_venue_set_match_court', { p_token: vTok, p_match_id: S1.id, p_court: 'Z-1', p_court_order: 1 }), '코트 지정');
  must(await anon.rpc('rpc_venue_submit_score', { p_token: vTok, p_match_id: S1.id, p_score: '7:6', p_winner_team_id: B }), '현장 정정');
  ok(await finalSlot() === B, `정정 승자 ${nm[B]} → 결승 자리 ${nm[await finalSlot()]}`);

  console.log('\nC4  결승이 끝난 뒤 4강 정정');
  must(await sb.rpc('rpc_submit_match_result', { p_match_id: S2.id, p_score: '6:0', p_winner_team_id: S2.team_a_id }), '4강2');
  ({ final } = await fin());
  must(await sb.rpc('rpc_submit_match_result', { p_match_id: final.id, p_score: '6:2', p_winner_team_id: B }), '결승');
  const r = await anon.rpc('rpc_admin_pin_update_score', { p_token: aTok, p_match_id: S1.id, p_score: '6:2', p_winner_team_id: A });
  ok(!!r.error && /다음 라운드/.test(r.error.message), `관리자 일반 수정 거부 (${r.error?.message})`);
  ok(await finalSlot() === B, '거부됐으니 결승 자리는 그대로');
  const f = must(await anon.rpc('rpc_admin_pin_force_score', { p_token: aTok, p_match_id: S1.id, p_score: '6:2', p_winner_team_id: A }), '강제 수정');
  ok(f?.success === true && await finalSlot() === A, `강제 수정 → 결승 자리 ${nm[await finalSlot()]}`);
  ({ final } = await fin());
  info(`강제 수정 뒤 결승: ${nm[final.team_a_id]} vs ${nm[final.team_b_id]}, 상태 ${final.status}, 기록된 우승 ${nm[final.winner_team_id]} — 결승은 다시 입력해야 함(화면 경고대로)`);
}

try { await main(); }
catch (e) { console.error('💥', e.message); fail++; }
finally {
  await cleanup();
  console.log(`\n결과: ✅ ${pass}  ❌ ${fail}`);
  process.exit(fail ? 1 : 0);
}
