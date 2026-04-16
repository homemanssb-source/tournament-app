// ============================================================
// 특정 이벤트의 단체전 데이터 초기화
// 사용: node scripts/reset-team-data.mjs <event_id> [--level=groups|teams|all]
//
// 레벨:
//   groups (기본): 조편성/ties/rubbers/lineups/standings만 삭제
//                  → 클럽·선수는 유지, 조편성부터 재시작
//   teams:        groups + 클럽·선수·sync_log 삭제
//                  → 앱A에서 팀 재가져오기 가능
//   all:          teams + 이벤트·부서·경기장까지 모두 삭제
//                  → 이벤트 자체 삭제 (위험)
//
// 예시:
//   node scripts/reset-team-data.mjs abc-123
//   node scripts/reset-team-data.mjs abc-123 --level=teams
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  content.split(/\r?\n/).forEach(line => {
    const t = line.trim(); if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('='); if (eq < 1) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '').trim();
    if (k && v) process.env[k] = v;
  });
}
loadEnv();

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('❌ SUPABASE_SERVICE_ROLE_KEY 필요'); process.exit(1); }

const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

const eventId = process.argv[2];
const levelArg = process.argv.find(a => a.startsWith('--level='));
const level = levelArg ? levelArg.split('=')[1] : 'groups';

if (!eventId) {
  console.error('사용: node scripts/reset-team-data.mjs <event_id> [--level=groups|teams|all]');
  process.exit(1);
}
if (!['groups', 'teams', 'all'].includes(level)) {
  console.error(`알 수 없는 level: ${level}  (groups/teams/all 중 선택)`);
  process.exit(1);
}

const log = (...a) => console.log('  ', ...a);
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);

async function main() {
  console.log(`🧹 이벤트 ${eventId} 단체전 데이터 초기화 (level=${level})`);

  // 사전 확인
  const { data: ev } = await sb.from('events').select('id, name').eq('id', eventId).maybeSingle();
  if (!ev) { console.error('❌ 이벤트를 찾을 수 없음'); process.exit(1); }
  console.log(`   대상: ${ev.name}`);

  // ── 공통: groups 레벨 (조편성 아래 데이터) ────────
  const { data: ties } = await sb.from('ties').select('id').eq('event_id', eventId);
  const tieIds = (ties || []).map(t => t.id);
  if (tieIds.length) {
    const r1 = await sb.from('tie_rubbers').delete().in('tie_id', tieIds);
    if (r1.error) warn(`tie_rubbers: ${r1.error.message}`); else log(`tie_rubbers: ${tieIds.length}건 기반 삭제`);
    const r2 = await sb.from('team_lineups').delete().in('tie_id', tieIds);
    if (r2.error) warn(`team_lineups: ${r2.error.message}`);
  }
  const r3 = await sb.from('ties').delete().eq('event_id', eventId);
  if (r3.error) warn(`ties: ${r3.error.message}`); else log('ties 삭제');

  const r4 = await sb.from('team_standings').delete().eq('event_id', eventId);
  if (r4.error) warn(`team_standings: ${r4.error.message}`); else log('team_standings 삭제');

  const { data: groups } = await sb.from('groups').select('id').eq('event_id', eventId);
  const gids = (groups || []).map(g => g.id);
  if (gids.length) {
    const r5 = await sb.from('group_members').delete().in('group_id', gids);
    if (r5.error) warn(`group_members: ${r5.error.message}`); else log(`group_members: ${gids.length}그룹`);
  }
  const r6 = await sb.from('groups').delete().eq('event_id', eventId);
  if (r6.error) warn(`groups: ${r6.error.message}`); else log('groups 삭제');

  if (level === 'groups') {
    ok('조편성 아래만 삭제 완료 (클럽·선수 유지)');
    return;
  }

  // ── teams 레벨: 클럽·선수·sync_log 추가 삭제 ────────
  const { data: clubs } = await sb.from('clubs').select('id').eq('event_id', eventId);
  const cids = (clubs || []).map(c => c.id);
  if (cids.length) {
    const r7 = await sb.from('club_members').delete().in('club_id', cids);
    if (r7.error) warn(`club_members: ${r7.error.message}`); else log(`club_members: ${cids.length}클럽`);
    // pin_attempts (클럽 PIN 잠금) 정리
    const keys = cids.map(id => `club:${id}`);
    await sb.from('pin_attempts').delete().in('target_key', keys);
    log('pin_attempts(club) 삭제');
  }
  const r8 = await sb.from('clubs').delete().eq('event_id', eventId);
  if (r8.error) warn(`clubs: ${r8.error.message}`); else log('clubs 삭제');

  // ✅ sync_log — 앱A에서 재가져오기 가능하도록
  const r9 = await sb.from('sync_log').delete().eq('event_id', eventId).eq('sync_type', 'team');
  if (r9.error) warn(`sync_log: ${r9.error.message}`); else log('sync_log(team) 삭제 — 앱A 재가져오기 가능');

  if (level === 'teams') {
    ok('팀 데이터 전체 삭제 완료 (이벤트·부서는 유지)');
    return;
  }

  // ── all 레벨: 이벤트·부서까지 삭제 ────────
  await sb.from('matches').delete().eq('event_id', eventId);
  log('matches 삭제');
  await sb.from('sync_log').delete().eq('event_id', eventId);  // 모든 sync 로그
  log('sync_log(전체) 삭제');
  await sb.from('divisions').delete().eq('event_id', eventId);
  log('divisions 삭제');
  const r10 = await sb.from('events').delete().eq('id', eventId);
  if (r10.error) warn(`events: ${r10.error.message}`); else ok('이벤트 완전 삭제됨');
}

main().catch(e => { console.error('💥', e); process.exit(1); });
