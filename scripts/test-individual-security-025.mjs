// ============================================================
// 검증: 개인전·경기장 보안 (migration 025a / 025b)
// 실행: node scripts/test-individual-security-025.mjs a   (025a 후 — 새 서버 함수 동작)
//       node scripts/test-individual-security-025.mjs b   (025b 후 — a 전부 + 잠금 확인)
// 임시 대회 2개(검증용·다른 대회)를 만들고 끝나면 지운다. 호출은 익명 키(외부 사용자와 같은 권한)로.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PHASE = (process.argv[2] || 'a').toLowerCase();
const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const eventIds = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };
const denied = (r) => !!r.error && /permission denied/i.test(r.error.message);

async function cleanup() {
  for (const id of eventIds) {
    const mids = (await sb.from('matches').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
    const gids = (await sb.from('groups').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
    const tids = (await sb.from('teams').select('id').eq('event_id', id)).data?.map(r => r.id) || [];
    if (mids.length) await sb.from('bracket_nodes').delete().in('match_id', mids);
    await sb.from('audit_log').delete().eq('event_id', id);
    await sb.from('pin_sessions').delete().eq('event_id', id);
    await sb.from('venue_sessions').delete().eq('event_id', id);
    await sb.from('admin_pin_sessions').delete().eq('event_id', id);
    await sb.from('pin_attempts').delete().like('target_key', `%${id}%`);
    if (gids.length) await sb.from('group_members').delete().in('group_id', gids);
    if (tids.length) await sb.from('team_pins').delete().in('team_id', tids);
    for (const t of ['matches', 'groups', 'group_settings', 'teams', 'venues', 'divisions']) await sb.from(t).delete().eq('event_id', id);
    await sb.from('event_secrets').delete().eq('event_id', id);
    await sb.from('events').delete().eq('id', id);
  }
  console.log('🧹 테스트 이벤트 정리 완료');
}

async function mkEvent(tag, pinBase) {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_sec025_${tag}_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null, app_a_connected: false, app_a_event_id: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  const ev = must(await sb.from('events').insert(row).select().single(), '대회');
  eventIds.push(ev.id);
  const div = must(await sb.from('divisions').insert({ event_id: ev.id, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('group_settings').insert({ event_id: ev.id, division_id: div.id, division_name: div.name, teams_per_group: 3, advance_count: 2, random_assign: true }), '조 설정');
  must(await sb.from('teams').insert([1, 2, 3].map(i => ({ event_id: ev.id, division_id: div.id, division_name: div.name, team_key: `${div.id}|s-${i}`,
    team_name: `보안${tag}${i}/x`, player1_name: `보안${i}`, player2_name: 'x', pin_plain: String(pinBase + i) }))), '팀');
  must(await sb.rpc('rpc_generate_groups', { p_event_id: ev.id, p_division_id: div.id, p_group_size: 3 }), '조편성');
  must(await sb.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: div.id }), '조별 경기');
  must(await sb.from('venues').insert({ event_id: ev.id, name: `코트${tag}`, short_name: tag, courts: [`${tag}-1`, `${tag}-2`], court_count: 2, pin_plain: String(pinBase + 9) }), '경기장');
  const matches = must(await sb.from('matches').select('*').eq('event_id', ev.id).order('match_num'), '경기');
  const teams = must(await sb.from('teams').select('*').eq('event_id', ev.id).order('team_key'), '팀 조회');
  const groups = must(await sb.from('groups').select('id').eq('event_id', ev.id), '조');
  return { ev, div, matches, teams, groups, pinBase };
}

async function main() {
  const E = await mkEvent('P', 915500), O = await mkEvent('Q', 915600);

  console.log('\nA1  PIN 보관 테이블');
  const tp = must(await sb.from('team_pins').select('*').in('team_id', E.teams.map(t => t.id)), 'team_pins');
  ok(tp.length === 3 && tp.some(p => p.pin_plain === '915501'), 'team_pins 에 3팀 저장');
  const vp = must(await sb.from('venue_pins').select('pin_plain, venues!inner(event_id)').eq('venues.event_id', E.ev.id), 'venue_pins');
  ok(vp.length === 1 && vp[0].pin_plain === '915509', 'venue_pins 에 저장');

  console.log('\nA2  선수 PIN 로그인·목록·체크인');
  let r = await anon.rpc('rpc_pin_login', { p_pin_code: '915501', p_event_id: E.ev.id });
  const pTok = r.data?.token;
  ok(!!pTok, '로그인 성공');
  r = await anon.rpc('rpc_pin_list_matches', { p_token: pTok });
  ok(r.data?.success && Array.isArray(r.data.team_ids) && r.data.team_ids.length === 1 && r.data.matches.length === 2, `목록 + team_ids (${r.data?.matches?.length}경기)`);
  r = await anon.rpc('rpc_pin_check_in', { p_token: pTok });
  const t1 = E.teams.find(t => t.team_key.endsWith('s-1'));
  ok(r.data?.success && (await sb.from('teams').select('checked_in').eq('id', t1.id).single()).data.checked_in === true, '체크인 반영');
  r = await anon.rpc('rpc_pin_check_in', { p_token: 'garbage' });
  ok(r.data?.success === false, '잘못된 토큰 거부');

  console.log('\nA3  경기장 로그인·코트 배정');
  r = await anon.rpc('rpc_venue_login', { p_pin_code: '915509', p_event_id: E.ev.id });
  const vTok = r.data?.token;
  ok(!!vTok, '경기장 로그인 성공');
  const m0 = E.matches[0], oM = O.matches[0];
  r = await anon.rpc('rpc_venue_set_match_court', { p_token: vTok, p_match_id: m0.id, p_court: 'P-1', p_court_order: 1 });
  ok(r.data?.success && (await sb.from('matches').select('court').eq('id', m0.id).single()).data.court === 'P-1', '내 코트 배정');
  r = await anon.rpc('rpc_venue_set_match_court', { p_token: vTok, p_match_id: m0.id, p_court: 'Q-1', p_court_order: 1 });
  ok(r.data?.success === false, '남의 코트 배정 거부');
  r = await anon.rpc('rpc_venue_set_match_court', { p_token: vTok, p_match_id: oM.id, p_court: 'P-2', p_court_order: 1 });
  ok(r.data?.success === false && (await sb.from('matches').select('court').eq('id', oM.id).single()).data.court === null, '다른 대회 경기 거부');
  r = await anon.rpc('rpc_venue_set_match_court', { p_token: vTok, p_match_id: m0.id, p_court: 'P-1', p_court_order: 5 });
  ok(r.data?.success && (await sb.from('matches').select('court_order').eq('id', m0.id).single()).data.court_order === 5, '순서 변경');
  must(await sb.from('matches').update({ court: 'P-1' }).eq('id', oM.id), '다른 대회 경기에 같은 코트명');
  r = await anon.rpc('rpc_venue_submit_score', { p_token: vTok, p_match_id: oM.id, p_score: '6:0', p_winner_team_id: oM.team_a_id });
  ok(!!r.error && (await sb.from('matches').select('status').eq('id', oM.id).single()).data.status !== 'FINISHED', '같은 코트명이어도 다른 대회 경기 점수 입력 거부');

  console.log('\nA4  관리자 PIN 화면');
  must(await sb.rpc('rpc_set_master_pin', { p_event_id: E.ev.id, p_new_pin: '9025' }), '마스터 PIN');
  const aTok = (await anon.rpc('rpc_admin_pin_login', { p_master_pin: '9025', p_event_id: E.ev.id })).data?.token;
  ok(!!aTok, '관리자 로그인');
  r = await anon.rpc('rpc_admin_pin_teams', { p_token: aTok });
  ok(r.data?.success && r.data.teams.length === 3 && r.data.teams.some(t => t.pin_plain === '915502'), '팀 PIN 목록');
  must(await sb.from('pin_attempts').upsert([
    { target_key: `login:${E.ev.id}:aaa`, fail_count: 5, locked_until: new Date(Date.now() + 600000).toISOString() },
    { target_key: `login:${O.ev.id}:bbb`, fail_count: 5, locked_until: new Date(Date.now() + 600000).toISOString() },
  ]), '잠금 만들기');
  r = await anon.rpc('rpc_admin_pin_locks', { p_token: aTok });
  const keys = (r.data?.locks || []).map(l => l.target_key);
  ok(keys.includes(`login:${E.ev.id}:aaa`) && !keys.includes(`login:${O.ev.id}:bbb`), '이 대회 잠금만 보임');
  r = await anon.rpc('rpc_admin_pin_unlock', { p_token: aTok, p_keys: [`login:${E.ev.id}:aaa`, `login:${O.ev.id}:bbb`] });
  const left = (await sb.from('pin_attempts').select('target_key').in('target_key', [`login:${E.ev.id}:aaa`, `login:${O.ev.id}:bbb`])).data.map(x => x.target_key);
  ok(r.data?.unlocked === 1 && left.length === 1 && left[0].includes(O.ev.id), '이 대회 잠금만 해제');
  const m1 = E.matches[1];
  r = await anon.rpc('rpc_admin_pin_force_score', { p_token: aTok, p_match_id: m1.id, p_score: '6:3', p_winner_team_id: m1.team_a_id });
  ok(r.data?.success && (await sb.from('matches').select('status, winner_team_id').eq('id', m1.id).single()).data.winner_team_id === m1.team_a_id, '강제 수정');
  r = await anon.rpc('rpc_admin_pin_force_score', { p_token: aTok, p_match_id: oM.id, p_score: '6:3', p_winner_team_id: oM.team_a_id });
  ok(r.data?.success === false, '다른 대회 경기 강제 수정 거부');
  r = await anon.rpc('rpc_admin_pin_fill_slots', { p_token: aTok, p_group_id: E.groups[0].id });
  ok(!r.error, `슬롯 채우기 호출 (${JSON.stringify(r.data).slice(0, 60)})`);
  r = await anon.rpc('rpc_admin_pin_fill_slots', { p_token: aTok, p_group_id: O.groups[0].id });
  ok(r.data?.success === false, '다른 대회 조 거부');

  if (PHASE !== 'b') return;

  console.log('\nB1  익명 조회');
  const at = must(await anon.from('teams').select('pin_plain').eq('event_id', E.ev.id), '팀');
  ok(at.every(t => t.pin_plain === null), '팀 PIN 비어 있음');
  const av = must(await anon.from('venues').select('pin_plain').eq('event_id', E.ev.id), '경기장');
  ok(av.every(v => v.pin_plain === null), '경기장 PIN 비어 있음');
  for (const t of ['team_pins', 'venue_pins', 'pin_attempts', 'venue_sessions']) {
    const x = await anon.from(t).select('*').limit(1);
    ok(!!x.error || (x.data || []).length === 0, `${t} 조회 불가 (${x.error?.message || '0행'})`);
  }

  console.log('\nB2  새 팀·경기장 PIN 저장 위치');
  const nt = must(await sb.from('teams').insert({ event_id: E.ev.id, division_id: E.div.id, division_name: E.div.name, team_key: `${E.div.id}|s-9`,
    team_name: '보안새팀/x', player1_name: '새', player2_name: 'x', pin_plain: '915599' }).select().single(), '새 팀');
  ok(nt.pin_plain === null && (await sb.from('team_pins').select('pin_plain').eq('team_id', nt.id).single()).data?.pin_plain === '915599', 'teams NULL, team_pins 저장');

  console.log('\nB3  익명 직접 쓰기 차단');
  const m2 = E.matches[2];
  await anon.from('matches').update({ score: '9:9' }).eq('id', m2.id);
  await anon.from('matches').delete().eq('id', m2.id);
  const still = (await sb.from('matches').select('score').eq('id', m2.id).maybeSingle()).data;
  ok(!!still && still.score !== '9:9', '경기 수정·삭제 안 됨');
  await anon.from('teams').update({ team_name: '해킹' }).eq('id', t1.id);
  await anon.from('teams').delete().eq('id', t1.id);
  const t1now = (await sb.from('teams').select('team_name').eq('id', t1.id).maybeSingle()).data;
  ok(!!t1now && t1now.team_name !== '해킹', '팀 수정·삭제 안 됨');
  await anon.from('groups').delete().eq('id', E.groups[0].id);
  ok(!!(await sb.from('groups').select('id').eq('id', E.groups[0].id).maybeSingle()).data, '조 삭제 안 됨');
  const ins = await anon.from('matches').insert({ event_id: E.ev.id });
  ok(!!ins.error, `경기 추가 안 됨 (${ins.error?.message?.slice(0, 40)})`);

  console.log('\nB4  익명 운영 함수 실행 불가');
  for (const [fn, args] of [
    ['rpc_submit_match_result', { p_match_id: m2.id, p_score: '6:0', p_winner_team_id: m2.team_a_id }],
    ['advance_winner', { p_match_id: m2.id }],
    ['rpc_fill_tournament_slots', { p_event_id: E.ev.id, p_group_id: E.groups[0].id }],
    ['rpc_generate_groups', { p_event_id: E.ev.id, p_division_id: E.div.id, p_group_size: 3 }],
    ['_pin_record_success', { p_target_key: 'x' }],
  ]) {
    const x = await anon.rpc(fn, args);
    ok(denied(x), `${fn} 거부 (${x.error?.message || '실행됨!'})`);
  }

  console.log('\nB5  PIN 로그인 잠금');
  for (let i = 0; i < 5; i++) await anon.rpc('rpc_pin_login', { p_pin_code: '915501', p_event_id: O.ev.id });   // O 대회엔 없는 PIN
  r = await anon.rpc('rpc_pin_login', { p_pin_code: '915501', p_event_id: O.ev.id });
  ok(r.data?.success === false && /초과/.test(r.data?.error || ''), `선수 PIN 5회 실패 후 잠금 (${r.data?.error})`);
  for (let i = 0; i < 10; i++) await anon.rpc('rpc_venue_login', { p_pin_code: '000000', p_event_id: O.ev.id });
  r = await anon.rpc('rpc_venue_login', { p_pin_code: '915609', p_event_id: O.ev.id });
  ok(r.data?.success === false && /초과/.test(r.data?.error || ''), `경기장 PIN 10회 실패 후 잠금 (${r.data?.error})`);
  r = await anon.rpc('rpc_pin_login', { p_pin_code: '915502', p_event_id: E.ev.id });
  ok(r.data?.success === true, '다른 대회는 영향 없음 (정상 로그인)');
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과 (${PHASE}): ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
