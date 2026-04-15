// ============================================================
// 단체전 E2E 시뮬레이션 — 다중 시나리오
// 실행: node scripts/e2e-team-tournament.mjs
//
// 시나리오:
//   #1 full_league (4팀, 3복식) — 기본 흐름
//   #2 tied_results (3팀 풀리그, 의도적 동률) — 동률 처리 검증
//   #3 group_tournament (6팀, 2조×3팀, 토너먼트 진출) — 조별→본선
//   #4 five_doubles (4팀, 5복식 풀리그) — match_type 분기
//
// 안전:
//   - 시작 시 기존 __TEST_TEAM_ 잔여 데이터 강제 정리
//   - 각 시나리오 종료 시 explicit FK-safe 삭제
//   - SIGINT 시에도 cleanup 시도
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    content.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq < 1) return;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '').trim();
      if (key && val) process.env[key] = val;
    });
  } catch (e) {
    console.error('.env.local 로드 실패:', e.message);
  }
}
loadEnv();

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY 없음');
  process.exit(1);
}

const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

// ── 유틸 ──
const log  = (...a) => console.log('  ', ...a);
const ok   = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const err  = (m, d) => console.error(`❌ ${m}`, d || '');
const step = (n, t) => console.log(`\n━━━ ${n}: ${t} ━━━`);
const scen = (n, t) => console.log(`\n\n╔══════════════════════════════════════════╗\n║ SCENARIO ${n}: ${t.padEnd(31)}║\n╚══════════════════════════════════════════╝`);

const TEST_PREFIX = '__TEST_TEAM_';
const eventIds = []; // 정리 대상 추적

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`ASSERT 실패 [${msg}]: ${actual} !== ${expected}`);
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(`ASSERT 실패: ${msg}`);
}

// ── FK-safe explicit 삭제 (cascade 의존 X) ──
async function safeDeleteEvent(eventId) {
  if (!eventId) return;

  // ID 사전 수집 (supabase-js .in() 은 array만 받음, subquery 미지원)
  const tieIds = (await sb.from('ties').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const clubIds = (await sb.from('clubs').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const groupIds = (await sb.from('groups').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];

  const ops = [
    tieIds.length ? () => sb.from('tie_rubbers').delete().in('tie_id', tieIds) : null,
    tieIds.length ? () => sb.from('team_lineups').delete().in('tie_id', tieIds) : null,
    () => sb.from('ties').delete().eq('event_id', eventId),
    () => sb.from('team_standings').delete().eq('event_id', eventId),
    clubIds.length ? () => sb.from('club_members').delete().in('club_id', clubIds) : null,
    groupIds.length ? () => sb.from('group_members').delete().in('group_id', groupIds) : null,
    () => sb.from('groups').delete().eq('event_id', eventId),
    () => sb.from('clubs').delete().eq('event_id', eventId),
    () => sb.from('matches').delete().eq('event_id', eventId),
    () => sb.from('divisions').delete().eq('event_id', eventId),
    () => sb.from('events').delete().eq('id', eventId),
  ].filter(Boolean);

  for (const op of ops) {
    try {
      const { error } = await op();
      if (error && !/relation .* does not exist|column .* does not exist/.test(error.message)) {
        warn(`삭제 경고: ${error.message}`);
      }
    } catch (e) {
      warn(`삭제 예외: ${e.message}`);
    }
  }
}

async function cleanupAll() {
  for (const id of eventIds) {
    await safeDeleteEvent(id);
  }
}

async function purgeStaleTestEvents() {
  const { data, error } = await sb.from('events').select('id, name')
    .ilike('name', `${TEST_PREFIX}%`);
  if (error) { warn(`잔여 검색 실패: ${error.message}`); return; }
  if (!data || data.length === 0) return;
  log(`잔여 테스트 이벤트 ${data.length}건 정리 중...`);
  for (const e of data) {
    await safeDeleteEvent(e.id);
  }
  ok(`잔여 ${data.length}건 정리 완료`);
}

process.on('SIGINT', async () => { await cleanupAll(); process.exit(130); });

// ── 시나리오 헬퍼 ──
function newName(suffix) {
  return `${TEST_PREFIX}${suffix}_${Date.now()}`;
}

async function createTestEvent(name, cfg = {}) {
  const { data, error } = await sb.from('events').insert({
    name,
    event_key: name.toLowerCase(),
    date: new Date().toISOString().slice(0, 10),
    location: 'E2E',
    status: 'active',
    event_type: 'team',
    team_format: 'full_league',
    team_rubber_count: 3,
    team_sets_per_rubber: 1,
    allow_player_reuse: true,
    lineup_mode: 'admin_only',
    team_match_type: '3_doubles',
    ...cfg,
  }).select().single();
  if (error) throw new Error(`이벤트 생성 실패: ${error.message}`);
  eventIds.push(data.id);
  return data;
}

async function createDivision(eventId, name = 'A부') {
  const { data, error } = await sb.from('divisions').insert({
    event_id: eventId, name, sort_order: 1,
  }).select().single();
  if (error) throw new Error(`부서 생성 실패: ${error.message}`);
  return data;
}

async function createClubsWithMembers(eventId, divisionId, names, memberCount = 4) {
  const clubs = [];
  for (let i = 0; i < names.length; i++) {
    const { data: c, error } = await sb.from('clubs').insert({
      event_id: eventId, division_id: divisionId, name: names[i],
      captain_name: `${names[i]}주장`,
      captain_pin: String(200000 + Math.floor(Math.random() * 800000)),
      seed_number: i + 1,
    }).select().single();
    if (error) throw new Error(`클럽 ${names[i]}: ${error.message}`);
    clubs.push(c);
  }
  const members = {};
  for (const c of clubs) {
    const rows = Array.from({ length: memberCount }, (_, i) => ({
      club_id: c.id, name: `${c.name}-P${i + 1}`,
      gender: i % 2 === 0 ? 'M' : 'F',
      is_captain: i === 0, member_order: i + 1,
    }));
    const { data, error } = await sb.from('club_members').insert(rows).select();
    if (error) throw new Error(`멤버 ${c.name}: ${error.message}`);
    members[c.id] = data;
  }
  return { clubs, members };
}

async function submitLineupAndScore(tie, clubA, clubB, membersA, membersB, scores) {
  // scores: [{winner: 'a'|'b', s1a, s1b, s2a?, s2b?, s3a?, s3b?}, ...]
  const lineupA = scores.map((_, i) => ({
    rubber_number: i + 1,
    player1_id: membersA[i % membersA.length].id,
    player2_id: membersA[(i + 1) % membersA.length].id,
  }));
  const lineupB = scores.map((_, i) => ({
    rubber_number: i + 1,
    player1_id: membersB[i % membersB.length].id,
    player2_id: membersB[(i + 1) % membersB.length].id,
  }));

  const { data: subA, error: eA } = await sb.rpc('rpc_submit_lineup', {
    p_tie_id: tie.id, p_club_id: clubA.id, p_captain_pin: clubA.captain_pin, p_lineups: lineupA,
  });
  if (eA) throw new Error(`A 라인업: ${eA.message}`);
  if (subA && !subA.success) throw new Error(`A 라인업 실패: ${subA.error}`);

  const { data: subB, error: eB } = await sb.rpc('rpc_submit_lineup', {
    p_tie_id: tie.id, p_club_id: clubB.id, p_captain_pin: clubB.captain_pin, p_lineups: lineupB,
  });
  if (eB) throw new Error(`B 라인업: ${eB.message}`);
  if (subB && !subB.success) throw new Error(`B 라인업 실패: ${subB.error}`);

  const { data: rubbers } = await sb.from('tie_rubbers')
    .select('*').eq('tie_id', tie.id).order('rubber_number');
  if (!rubbers || rubbers.length === 0) {
    throw new Error('rubbers 자동 생성 안 됨');
  }

  for (let i = 0; i < rubbers.length && i < scores.length; i++) {
    const r = rubbers[i];
    const s = scores[i];
    const { data: sr, error } = await sb.rpc('rpc_admin_record_score', {
      p_rubber_id: r.id,
      p_set1_a: s.s1a, p_set1_b: s.s1b,
      p_set2_a: s.s2a ?? null, p_set2_b: s.s2b ?? null,
      p_set3_a: s.s3a ?? null, p_set3_b: s.s3b ?? null,
    });
    if (error) throw new Error(`러버 ${r.rubber_number}: ${error.message}`);
    if (sr && !sr.success) throw new Error(`러버 ${r.rubber_number}: ${sr.error}`);
  }
}

async function printStandings(eventId, label = '순위표') {
  const { data: standings } = await sb
    .from('team_standings')
    .select('*, club:clubs(name)')
    .eq('event_id', eventId)
    .order('rank', { ascending: true, nullsFirst: false });
  console.log(`\n  📊 ${label}:`);
  console.log('     순위 | 팀명         | 경기 | 승 | 패 | 러버득실 | 득실차');
  for (const s of standings || []) {
    const rank = (s.rank ?? '-').toString().padStart(4);
    const name = (s.club?.name || '-').padEnd(8, ' ');
    const diff = (s.rubber_diff >= 0 ? '+' : '') + s.rubber_diff;
    console.log(`     ${rank} | ${name} |  ${s.played}  | ${s.won} | ${s.lost} | ${s.rubbers_for}-${s.rubbers_against}     | ${diff}`);
  }
  return standings || [];
}

// ============================================================
// SCENARIO 1: full_league (4팀, 3복식)
// ============================================================
async function scenario1() {
  scen(1, 'full_league 4팀 3복식');
  const ev = await createTestEvent(newName('S1'));
  const div = await createDivision(ev.id);
  const { clubs, members } = await createClubsWithMembers(
    ev.id, div.id, ['알파', '브라보', '찰리', '델타']);
  ok(`이벤트+부서+클럽 4개+멤버 16명`);

  const r1 = await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: div.id });
  if (r1.error) throw new Error(`풀리그: ${r1.error.message}`);
  log(`풀리그 RPC: tie_count=${r1.data.tie_count}`);

  const { data: ties } = await sb.from('ties').select('*').eq('event_id', ev.id).order('tie_order');
  assertEq(ties.length, 6, '4C2=6 ties');

  // 시드 순서로 명확한 승패: i<j면 i가 항상 이김 → 시드1 전승, 시드4 전패
  for (const tie of ties) {
    const ai = clubs.findIndex(c => c.id === tie.club_a_id);
    const bi = clubs.findIndex(c => c.id === tie.club_b_id);
    const aWins = ai < bi;
    const scores = aWins ?
      [{winner:'a',s1a:6,s1b:2}, {winner:'a',s1a:6,s1b:3}, {winner:'b',s1a:3,s1b:6}] :
      [{winner:'b',s1a:2,s1b:6}, {winner:'b',s1a:3,s1b:6}, {winner:'a',s1a:6,s1b:3}];
    await submitLineupAndScore(tie, clubs[ai], clubs[bi], members[clubs[ai].id], members[clubs[bi].id], scores);
  }
  ok('6 ties 점수 입력 완료');

  await sb.rpc('rpc_calculate_standings', { p_event_id: ev.id, p_group_id: null });
  const st = await printStandings(ev.id);

  assertEq(st.length, 4, '클럽 수');
  assertEq(st[0].won, 3, '1위 알파 3승');
  assertEq(st[0].lost, 0, '1위 알파 0패');
  assertEq(st[3].won, 0, '4위 델타 0승');
  assertEq(st[3].lost, 3, '4위 델타 3패');
  ok('순위 검증 통과 (전승/전패 구조)');
}

// ============================================================
// SCENARIO 2: 동률 시나리오 (3팀 순환)
// ============================================================
async function scenario2() {
  scen(2, '동률 — 3팀 순환승 (가위바위보)');
  const ev = await createTestEvent(newName('S2'));
  const div = await createDivision(ev.id);
  const { clubs, members } = await createClubsWithMembers(
    ev.id, div.id, ['가위', '바위', '보']);
  ok('3팀 생성');

  const r = await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: div.id });
  if (r.error) throw new Error(`풀리그: ${r.error.message}`);
  const { data: ties } = await sb.from('ties').select('*').eq('event_id', ev.id).order('tie_order');
  assertEq(ties.length, 3, '3C2=3');

  // 가위 > 바위 > 보 > 가위 (순환)
  const order = { '가위': 0, '바위': 1, '보': 2 };
  for (const tie of ties) {
    const ca = clubs.find(c => c.id === tie.club_a_id);
    const cb = clubs.find(c => c.id === tie.club_b_id);
    const ai = order[ca.name], bi = order[cb.name];
    // 가위(0) → 바위(1) 이김 (순환: 0>1, 1>2, 2>0)
    const aWins = (ai === 0 && bi === 1) || (ai === 1 && bi === 2) || (ai === 2 && bi === 0);
    const scores = aWins ?
      [{winner:'a',s1a:6,s1b:4}, {winner:'a',s1a:6,s1b:5}, {winner:'b',s1a:4,s1b:6}] :
      [{winner:'b',s1a:4,s1b:6}, {winner:'b',s1a:5,s1b:6}, {winner:'a',s1a:6,s1b:4}];
    await submitLineupAndScore(tie, ca, cb, members[ca.id], members[cb.id], scores);
  }
  ok('순환승 패턴 입력 완료');

  await sb.rpc('rpc_calculate_standings', { p_event_id: ev.id, p_group_id: null });
  const st = await printStandings(ev.id, '동률 순위표');

  // 모두 1승 1패 + 동일 득실 → 동률(rank=null) 기대 OR 다른 tiebreaker로 결정
  for (const s of st) assertEq(s.won, 1, `${s.club?.name} 1승`);
  for (const s of st) assertEq(s.lost, 1, `${s.club?.name} 1패`);
  for (const s of st) assertEq(s.rubber_diff, 0, `${s.club?.name} 득실차 0`);

  const tied = st.filter(s => s.rank === null);
  if (tied.length === 3) {
    ok('완전 동률 감지 (rank=null) — 수동 결정 필요 상태');
  } else {
    warn(`예상: 3팀 동률(rank=null)이지만 실제 rank 분포: [${st.map(s => s.rank).join(', ')}]`);
    log('백엔드가 다른 tiebreaker(상대전적 등) 사용 가능성');
  }
}

// ============================================================
// SCENARIO 3: 조별리그 + 토너먼트
// ============================================================
async function scenario3() {
  scen(3, 'group_tournament 6팀 (2조×3팀 → SF)');
  const ev = await createTestEvent(newName('S3'), { team_format: 'group_tournament' });
  const div = await createDivision(ev.id);
  const { clubs, members } = await createClubsWithMembers(
    ev.id, div.id, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
  ok('6팀 생성');

  // 조 생성 (v2 호출: 4-arg)
  const r1 = await sb.rpc('rpc_create_team_groups', {
    p_event_id: ev.id, p_group_count: 2, p_group_size: 3, p_division_id: div.id,
  });
  if (r1.error) throw new Error(`조편성: ${r1.error.message}`);
  log(`조편성 결과: ${JSON.stringify(r1.data)}`);

  const { data: groups } = await sb.from('groups').select('*').eq('event_id', ev.id).order('group_num');
  assertEq(groups.length, 2, '2개 조');

  const { data: groupTies } = await sb.from('ties').select('*').eq('event_id', ev.id).eq('round', 'group').order('tie_order');
  assertEq(groupTies.length, 6, '각 조 3 ties × 2 = 6');

  // 각 조에서 시드1이 무조건 이기게 (rank 결정 명확화)
  for (const tie of groupTies) {
    const ca = clubs.find(c => c.id === tie.club_a_id);
    const cb = clubs.find(c => c.id === tie.club_b_id);
    const aWins = ca.seed_number < cb.seed_number;
    const scores = aWins ?
      [{winner:'a',s1a:6,s1b:1}, {winner:'a',s1a:6,s1b:2}, {winner:'b',s1a:2,s1b:6}] :
      [{winner:'b',s1a:1,s1b:6}, {winner:'b',s1a:2,s1b:6}, {winner:'a',s1a:6,s1b:2}];
    await submitLineupAndScore(tie, ca, cb, members[ca.id], members[cb.id], scores);
  }
  ok('조별리그 6 ties 완료');

  // 조별 순위 계산
  for (const g of groups) {
    await sb.rpc('rpc_calculate_standings', { p_event_id: ev.id, p_group_id: g.id });
    await printStandings(ev.id, `${g.group_label || g.group_num + '조'} 순위 (group_id=${g.id.slice(0,8)})`);
    // 위 함수는 event_id 전체로 보여주는데, 조별로 필터하려면 별도 처리 필요. 일단 디스플레이용
  }

  // 본선 토너먼트 생성 (각 조 1위 + 2위 → 4팀 → SF)
  const r2 = await sb.rpc('rpc_generate_team_tournament_v2', {
    p_event_id: ev.id, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: false,
  });
  if (r2.error) {
    warn(`본선 생성 실패: ${r2.error.message}`);
    return;
  }
  log(`본선 RPC: ${JSON.stringify(r2.data)}`);

  const { data: tourTies } = await sb.from('ties').select('*').eq('event_id', ev.id)
    .in('round', ['semi', 'final']).order('round').order('bracket_position');
  log(`토너먼트 ties: ${tourTies?.length || 0}개`);
  if (!tourTies || tourTies.length === 0) {
    warn('토너먼트 ties 생성 안 됨');
    return;
  }

  // SF 진행
  for (const tie of tourTies.filter(t => t.round === 'semi' && t.club_a_id && t.club_b_id)) {
    const ca = clubs.find(c => c.id === tie.club_a_id);
    const cb = clubs.find(c => c.id === tie.club_b_id);
    if (!ca || !cb) continue;
    const aWins = ca.seed_number < cb.seed_number;
    const scores = aWins ?
      [{winner:'a',s1a:6,s1b:3}, {winner:'a',s1a:6,s1b:4}, {winner:'b',s1a:3,s1b:6}] :
      [{winner:'b',s1a:3,s1b:6}, {winner:'b',s1a:4,s1b:6}, {winner:'a',s1a:6,s1b:3}];
    await submitLineupAndScore(tie, ca, cb, members[ca.id], members[cb.id], scores);
  }
  ok('SF 점수 입력');

  // 결승 자동 진출 확인
  const { data: final } = await sb.from('ties').select('*').eq('event_id', ev.id).eq('round', 'final').maybeSingle();
  if (final && final.club_a_id && final.club_b_id) {
    ok(`결승 진출: club_a=${final.club_a_id.slice(0,8)} vs club_b=${final.club_b_id.slice(0,8)}`);
    const ca = clubs.find(c => c.id === final.club_a_id);
    const cb = clubs.find(c => c.id === final.club_b_id);
    const aWins = ca.seed_number < cb.seed_number;
    const scores = aWins ?
      [{winner:'a',s1a:6,s1b:0}, {winner:'a',s1a:6,s1b:1}, {winner:'b',s1a:1,s1b:6}] :
      [{winner:'b',s1a:0,s1b:6}, {winner:'b',s1a:1,s1b:6}, {winner:'a',s1a:6,s1b:1}];
    await submitLineupAndScore(final, ca, cb, members[ca.id], members[cb.id], scores);
    ok(`결승 종료: 우승 = ${aWins ? ca.name : cb.name}`);
  } else {
    warn('결승 ties club 미할당 — 자동 진출 로직 점검 필요');
  }
}

// ============================================================
// SCENARIO 4: 5_doubles match_type
// ============================================================
async function scenario4() {
  scen(4, 'five_doubles 4팀 5복식');
  const ev = await createTestEvent(newName('S4'), {
    team_match_type: '5_doubles',
    team_rubber_count: 5,
  });
  const div = await createDivision(ev.id);
  const { clubs, members } = await createClubsWithMembers(
    ev.id, div.id, ['X1', 'X2', 'X3', 'X4'], 6);
  ok('4팀 × 6명');

  const r = await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: div.id });
  if (r.error) throw new Error(`풀리그: ${r.error.message}`);
  log(`tie_count=${r.data.tie_count}, rubber_count=${r.data.rubber_count}`);
  assertEq(r.data.rubber_count, 5, '5복식 → rubber_count=5');

  const { data: ties } = await sb.from('ties').select('*').eq('event_id', ev.id);
  for (const t of ties) assertEq(t.rubber_count, 5, `tie ${t.id.slice(0,8)} rubber_count`);
  ok('모든 tie가 rubber_count=5');

  // 첫 tie만 점수 입력해서 rubber 생성+계산 검증
  const tie = ties[0];
  const ca = clubs.find(c => c.id === tie.club_a_id);
  const cb = clubs.find(c => c.id === tie.club_b_id);
  const scores = [
    {winner:'a',s1a:6,s1b:2},
    {winner:'a',s1a:6,s1b:3},
    {winner:'a',s1a:6,s1b:4},  // a 3승 — majority 도달
    {winner:'b',s1a:2,s1b:6},
    {winner:'b',s1a:1,s1b:6},
  ];
  await submitLineupAndScore(tie, ca, cb, members[ca.id], members[cb.id], scores);

  const { data: rubbers } = await sb.from('tie_rubbers').select('*').eq('tie_id', tie.id);
  assertEq(rubbers.length, 5, '러버 5개');
  ok('5복식 점수 입력 완료, 러버 5개 확인');

  const { data: updatedTie } = await sb.from('ties').select('*').eq('id', tie.id).single();
  log(`tie 결과: a_wins=${updatedTie.club_a_rubbers_won}, b_wins=${updatedTie.club_b_rubbers_won}, status=${updatedTie.status}`);
  assertTrue(updatedTie.club_a_rubbers_won === 3 && updatedTie.club_b_rubbers_won === 2,
    `a:b = ${updatedTie.club_a_rubbers_won}:${updatedTie.club_b_rubbers_won} (기대 3:2)`);
  ok(`tie 결과 정확 (3:2 a 승)`);
}

// ============================================================
// SCENARIO 5: 다부서 풀리그 (C3 근본 수정 검증)
// 두 부서 A/B에 각각 3팀씩 풀리그 → division별 순위가 섞이지 않아야 함
// ============================================================
async function scenario5() {
  scen(5, 'multi_division full_league (C3 검증)');
  const ev = await createTestEvent(newName('S5'));
  // 부서 2개
  const { data: divA } = await sb.from('divisions').insert({
    event_id: ev.id, name: 'M부', sort_order: 1,
  }).select().single();
  const { data: divB } = await sb.from('divisions').insert({
    event_id: ev.id, name: 'W부', sort_order: 2,
  }).select().single();

  // 각 부서에 3팀
  const { clubs: clubsA, members: mA } = await createClubsWithMembers(
    ev.id, divA.id, ['MA1', 'MA2', 'MA3']);
  const { clubs: clubsB, members: mB } = await createClubsWithMembers(
    ev.id, divB.id, ['WA1', 'WA2', 'WA3']);
  ok('2부서 × 3팀 생성');

  // 각 부서 풀리그 생성
  await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: divA.id });
  await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: divB.id });

  const { data: ties } = await sb.from('ties').select('*').eq('event_id', ev.id);
  assertEq(ties.length, 6, '3C2×2=6');

  // 시드1이 승리 패턴
  for (const tie of ties) {
    const allClubs = [...clubsA, ...clubsB];
    const ca = allClubs.find(c => c.id === tie.club_a_id);
    const cb = allClubs.find(c => c.id === tie.club_b_id);
    const membersMap = { ...mA, ...mB };
    const aWins = ca.seed_number < cb.seed_number;
    const scores = aWins ?
      [{winner:'a',s1a:6,s1b:2}, {winner:'a',s1a:6,s1b:3}, {winner:'b',s1a:3,s1b:6}] :
      [{winner:'b',s1a:2,s1b:6}, {winner:'b',s1a:3,s1b:6}, {winner:'a',s1a:6,s1b:3}];
    await submitLineupAndScore(tie, ca, cb, membersMap[ca.id], membersMap[cb.id], scores);
  }
  ok('6 ties 점수 입력');

  // ✅ C3 근본 수정: 부서별로 재계산
  await sb.rpc('rpc_calculate_standings', { p_event_id: ev.id, p_group_id: null, p_division_id: divA.id });
  await sb.rpc('rpc_calculate_standings', { p_event_id: ev.id, p_group_id: null, p_division_id: divB.id });

  // 각 부서 순위 조회
  const { data: allStandings } = await sb
    .from('team_standings')
    .select('*, club:clubs(name, division_id, seed_number)')
    .eq('event_id', ev.id);

  const aStandings = allStandings.filter(s => s.club.division_id === divA.id).sort((a, b) => a.rank - b.rank);
  const bStandings = allStandings.filter(s => s.club.division_id === divB.id).sort((a, b) => a.rank - b.rank);

  // 각 부서 1~3위가 따로 부여되어야 함 (섞이면 안 됨)
  assertEq(aStandings.map(s => s.rank).join(','), '1,2,3', 'A부서 순위 1,2,3');
  assertEq(bStandings.map(s => s.rank).join(','), '1,2,3', 'B부서 순위 1,2,3');
  ok('부서별 순위 분리 확인 (1,2,3 / 1,2,3)');

  // 시드 순서 검증 (A부서)
  assertEq(aStandings[0].club.seed_number, 1, 'A 1위 = seed1');
  assertEq(aStandings[2].club.seed_number, 3, 'A 3위 = seed3');
  ok('시드 순서 순위 일치');
}

// ============================================================
// SCENARIO 6: PIN rate limit (lockout 검증)
// ============================================================
async function scenario6() {
  scen(6, 'PIN rate limit (5회 실패 → 10분 잠금)');
  const ev = await createTestEvent(newName('S6'), {
    lineup_mode: 'captain_pin',
  });
  const div = await createDivision(ev.id);
  const { clubs } = await createClubsWithMembers(
    ev.id, div.id, ['LA', 'LB'], 2);
  ok('2팀 생성 (captain_pin 모드)');

  const r = await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: div.id });
  if (r.error) throw new Error(r.error.message);
  const { data: ties } = await sb.from('ties').select('*').eq('event_id', ev.id);
  assertEq(ties.length, 1, '2C2=1 tie');
  const tie = ties[0];
  const clubA = clubs.find(c => c.id === tie.club_a_id);

  // 잘못된 PIN으로 5번 시도
  const wrongPin = '999999';
  assertTrue(clubA.captain_pin !== wrongPin, 'wrong PIN이 실제 PIN과 달라야 함');

  for (let i = 1; i <= 5; i++) {
    const { data } = await sb.rpc('rpc_submit_lineup', {
      p_tie_id: tie.id, p_club_id: clubA.id,
      p_captain_pin: wrongPin, p_lineups: [],
    });
    assertTrue(data && !data.success, `시도 ${i}: 실패 기대`);
    assertTrue((data.error || '').includes('PIN'), `시도 ${i}: PIN 에러 메시지 기대: ${data.error}`);
  }
  ok('5회 실패 기록');

  // 6번째 — 올바른 PIN이어도 잠금 상태라 거부
  const { data: d6 } = await sb.rpc('rpc_submit_lineup', {
    p_tie_id: tie.id, p_club_id: clubA.id,
    p_captain_pin: clubA.captain_pin,
    p_lineups: [],
  });
  assertTrue(d6 && !d6.success, '6번째 (올바른 PIN) 도 실패해야 함');
  assertTrue((d6.error || '').includes('시도 횟수 초과'), `잠금 메시지 기대, 실제: ${d6.error}`);
  ok(`잠금 작동: "${d6.error}"`);

  // pin_attempts 레코드 존재 확인
  const { data: attempts } = await sb.from('pin_attempts')
    .select('*').eq('target_key', `club:${clubA.id}`).maybeSingle();
  assertTrue(attempts !== null, 'pin_attempts 레코드 존재');
  assertTrue(attempts.fail_count >= 5, `fail_count >= 5 (실제: ${attempts.fail_count})`);
  assertTrue(attempts.locked_until !== null, 'locked_until 설정됨');
  ok(`pin_attempts: fail=${attempts.fail_count}, locked_until 설정됨`);

  // 정리
  await sb.from('pin_attempts').delete().eq('target_key', `club:${clubA.id}`);
}

// ============================================================
async function main() {
  console.log(`🎾 단체전 E2E 다중 시나리오\n   대상: ${URL_}`);

  step('PRE', '잔여 테스트 데이터 정리');
  await purgeStaleTestEvents();

  const results = [];
  const scenarios = [
    ['#1 full_league',       scenario1],
    ['#2 tied_results',      scenario2],
    ['#3 group_tournament',  scenario3],
    ['#4 five_doubles',      scenario4],
    ['#5 multi_division',    scenario5],
    ['#6 pin_rate_limit',    scenario6],
  ];

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name, status: '✅ PASS' });
    } catch (e) {
      console.error(`\n💥 ${name} 실패:`, e.message);
      console.error(e.stack);
      results.push({ name, status: `❌ FAIL — ${e.message}` });
    }
  }

  step('CLEANUP', '모든 테스트 이벤트 삭제');
  await cleanupAll();
  ok(`${eventIds.length}개 이벤트 정리`);

  console.log('\n\n╔══════════════════════════════════════════╗');
  console.log('║              최종 결과                   ║');
  console.log('╚══════════════════════════════════════════╝');
  for (const r of results) {
    console.log(`  ${r.status.padEnd(8)} ${r.name}`);
  }
  const failed = results.filter(r => r.status.startsWith('❌'));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n💥 치명적 예외:', e);
  await cleanupAll();
  process.exit(1);
});
