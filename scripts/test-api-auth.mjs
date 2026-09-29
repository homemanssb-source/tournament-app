// ============================================================
// 검증: 서버 API 호출자 확인 (앱A 결과 전송·알림·경기장 관리·구독자 현황)
// 실행: node scripts/test-api-auth.mjs [BASE_URL]   (기본 http://localhost:3107 — 로컬 `next start`)
// 임시 대회(경기장 1곳, 팀 1개)를 만들고 끝나면 지운다. 운영자 로그인 경로는 실제 계정이 필요해 여기선 확인하지 않음.
//
//  A1  /api/sync/push-results: 인증 없음·가짜 토큰 → 401, 다른 사이트 호출 허용(CORS *) 없음
//  A2  /api/admin/venues POST·PATCH·DELETE: 인증 없음 → 401
//  A3  /api/notify/court: 인증 없음 → 401 / 다른 대회 세션 → 401 / 그 대회 경기장 세션 → 200 / 선수 세션 → 200
//  A4  /api/push/subscribers: 인증 없음 → 401
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BASE = process.argv[2] || 'http://localhost:3107';
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
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function cleanup() {
  for (const id of eventIds) {
    await sb.from('venue_sessions').delete().eq('event_id', id);
    await sb.from('pin_sessions').delete().eq('event_id', id);
    await sb.from('push_logs').delete().eq('event_id', id);
    await sb.from('audit_log').delete().eq('event_id', id);
    await sb.from('venues').delete().eq('event_id', id);
    await sb.from('teams').delete().eq('event_id', id);
    await sb.from('divisions').delete().eq('event_id', id);
    await sb.from('events').delete().eq('id', id);
  }
  console.log('🧹 테스트 이벤트 정리 완료');
}

async function mkEvent(tag) {
  const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
  const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
  const name = `__TEST_SIM_api_${tag}_${Date.now()}`;
  Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null, app_a_connected: false, app_a_event_id: null,
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
  const ev = must(await sb.from('events').insert(row).select().single(), '대회');
  eventIds.push(ev.id);
  return ev;
}

async function main() {
  const E1 = await mkEvent('a'), E2 = await mkEvent('b');
  const div = must(await sb.from('divisions').insert({ event_id: E1.id, name: '검증부', sort_order: 1 }).select().single(), '부서');
  must(await sb.from('venues').insert({ event_id: E1.id, name: '검증코트', short_name: 'T', courts: ['T-1', 'T-2'], court_count: 2, pin_plain: '905501' }), '경기장');
  must(await sb.from('venues').insert({ event_id: E2.id, name: '다른코트', short_name: 'U', courts: ['U-1'], court_count: 1, pin_plain: '905502' }), '경기장2');
  must(await sb.from('teams').insert({ event_id: E1.id, division_id: div.id, division_name: div.name, team_key: `${div.id}|api-1`,
    team_name: '검증팀/x', player1_name: '검증', player2_name: 'x', pin_plain: '905503' }), '팀');
  const vTok = must(await anon.rpc('rpc_venue_login', { p_pin_code: '905501', p_event_id: E1.id }), '경기장 로그인').token;
  const vTok2 = must(await anon.rpc('rpc_venue_login', { p_pin_code: '905502', p_event_id: E2.id }), '경기장2 로그인').token;
  const pTok = must(await anon.rpc('rpc_pin_login', { p_pin_code: '905503', p_event_id: E1.id }), '선수 로그인').token;

  console.log('\nA1  앱A 결과 전송');
  let r = await post('/api/sync/push-results', { event_id: E1.id, app_a_event_id: '00000000-0000-0000-0000-000000000000' });
  ok(r.status === 401, `인증 없음 → ${r.status}`);
  r = await post('/api/sync/push-results', { event_id: E1.id, app_a_event_id: 'x' }, { Authorization: 'Bearer fake.token.here' });
  ok(r.status === 401, `가짜 토큰 → ${r.status}`);
  r = await fetch(BASE + '/api/sync/push-results', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  ok(!r.headers.get('access-control-allow-origin'), `다른 사이트 호출 허용 헤더 없음 (${r.headers.get('access-control-allow-origin') || '없음'})`);

  console.log('\nA2  경기장 관리 API');
  r = await post('/api/admin/venues', { event_id: E1.id, name: 'x', short_name: 'x' });
  ok(r.status === 401, `POST → ${r.status}`);
  r = await fetch(BASE + '/api/admin/venues', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000', pin_plain: '1' }) });
  ok(r.status === 401, `PATCH → ${r.status}`);
  r = await fetch(BASE + '/api/admin/venues?id=00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
  ok(r.status === 401, `DELETE → ${r.status}`);

  console.log('\nA3  알림 API');
  r = await post('/api/notify/court', { event_id: E1.id, court: 'T-1', trigger: 'manual' });
  ok(r.status === 401, `인증 없음 → ${r.status}`);
  r = await post('/api/notify/court', { event_id: E1.id, court: 'T-1', trigger: 'manual', venue_token: vTok2 });
  ok(r.status === 401, `다른 대회 경기장 세션 → ${r.status}`);
  r = await post('/api/notify/court', { event_id: E1.id, court: 'T-1', trigger: 'manual', venue_token: 'garbage' });
  ok(r.status === 401, `엉터리 토큰 → ${r.status}`);
  r = await post('/api/notify/court', { event_id: E1.id, court: 'T-1', trigger: 'court_changed', venue_token: vTok });
  ok(r.status === 200, `그 대회 경기장 세션 → ${r.status}`);
  r = await post('/api/notify/court', { event_id: E1.id, court: 'T-1', trigger: 'finished', pin_token: pTok });
  ok(r.status === 200, `그 대회 선수 세션 → ${r.status}`);

  console.log('\nA5  동기화·알림 기록·자동 동기화 (025)');
  for (const p of ['/api/sync/pull-events', '/api/sync/pull-individual', '/api/sync/pull-team', '/api/sync/update-clubs']) {
    r = await post(p, { event_id: E1.id, app_a_event_id: '00000000-0000-0000-0000-000000000000' });
    ok(r.status === 401, `${p} 인증 없음 → ${r.status}`);
  }
  r = await fetch(BASE + `/api/push/logs?event_id=${E1.id}`);
  ok(r.status === 401, `/api/push/logs 인증 없음 → ${r.status}`);
  r = await fetch(BASE + '/api/sync/auto-pull');
  ok(r.status === 401, `/api/sync/auto-pull 인증 없음 → ${r.status}`);
  r = await fetch(BASE + '/api/sync/auto-pull', { headers: { Authorization: 'Bearer wrong' } });
  ok(r.status === 401, `/api/sync/auto-pull 틀린 비밀값 → ${r.status}`);

  console.log('\nA4  구독자 현황');
  r = await fetch(BASE + `/api/push/subscribers?event_id=${E1.id}`);
  ok(r.status === 401, `인증 없음 → ${r.status}`);
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
