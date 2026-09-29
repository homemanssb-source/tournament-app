// ============================================================
// 검증: 앱A 단체전 동기화 안전화 + 부서별 복식 수 (migration 021, src/lib/team-sync.ts)
// 실행: node scripts/test-team-sync-021.mjs   (앱B에 임시 대회를 만들고 끝나면 지운다. 앱A는 건드리지 않음 — 가짜 앱A 데이터 사용)
//
//  동기화 (가짜 앱A: 1부 5복식 / 2부 기본(3복식), 1부에 같은 이름 클럽 신청 2건)
//  S1  첫 동기화 → 클럽 3·선수·부서 경기방식 반영, 같은 부서 같은 이름 신청 2번째는 합치지 않고 오류 보고
//  S2  같은 데이터로 재동기화 → 변경 0, 선수 ID 그대로, sync_log 추가 없음
//  S3  라인업에 쓰인 선수가 앱A에서 빠지고 새 선수 추가 → 쓰인 선수 유지(경고), 새 선수 추가, 중복 없음
//  S4  앱A 조회 실패(대회 경기방식·선수 명단) → 기존 값/명단 유지
//  S5  빈 선수 명단 → 기존 명단 유지
//  S6  주장 PIN 변경(앱A 기준) → 반영
//  S7  1부 대전이 생긴 뒤 앱A가 1부를 3복식으로 변경 → 반영 안 함(경고)
//  S8  앱A에서 취소된 신청 → 보고만, 클럽 유지
//  S9  앱B에 없는 부서 + 자동 생성 끔 → 오류 보고, 클럽 안 만듦
//  복식 수
//  R1  조편성: 1부 대전·러버 5개, 2부 3개, 대회 값은 그대로
//  R2  풀리그(2부) 3개 / 대진 생성(1부) 5개
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncTeamEntries } from '../src/lib/team-sync.ts';

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
  const tieIds = (await sb.from('ties').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  const clubIds = (await sb.from('clubs').select('id').eq('event_id', eventId)).data?.map(r => r.id) || [];
  if (tieIds.length) {
    await sb.from('tie_rubbers').delete().in('tie_id', tieIds);
    await sb.from('team_lineups').delete().in('tie_id', tieIds);
  }
  await sb.from('ties').delete().eq('event_id', eventId);
  await sb.from('team_standings').delete().eq('event_id', eventId);
  await sb.from('groups').delete().eq('event_id', eventId);
  await sb.from('sync_log').delete().eq('event_id', eventId);
  if (clubIds.length) await sb.from('club_members').delete().in('club_id', clubIds);
  await sb.from('clubs').delete().eq('event_id', eventId);
  await sb.from('divisions').delete().eq('event_id', eventId);
  const { error } = await sb.from('events').delete().eq('id', eventId);
  console.log(error ? '⚠️ 정리 실패: ' + error.message : '🧹 테스트 이벤트 정리 완료');
}

// ── 가짜 앱A ──
const A = {
  event: { team_match_type: '3_doubles' },
  divisions: [
    { division_id: 'D1', division_name: '1부', team_match_type: '5_doubles' },
    { division_id: 'D2', division_name: '2부', team_match_type: null },
  ],
  entries: [
    { id: 'E1', club_name: '가클럽', captain_name: '가1', captain_pin: '111111', captain_member_id: 'MA1', division_id: 'D1', division_name: '1부', status: 'confirmed' },
    { id: 'E2', club_name: '같은클럽', captain_name: '같1', captain_pin: '222222', division_id: 'D1', division_name: '1부', status: 'confirmed' },
    { id: 'E3', club_name: '같은클럽', captain_name: '같2', captain_pin: '333333', division_id: 'D1', division_name: '1부', status: 'pending' },
    { id: 'E4', club_name: '나클럽', captain_name: '나1', captain_pin: '444444', division_id: 'D2', division_name: '2부', status: 'confirmed' },
  ],
  members: {
    E1: ['가1', '가2', '가3', '가4'].map((n, i) => ({ member_id: `MA${i + 1}`, member_name: n, gender: '남', grade: null, member_order: i + 1 })),
    E2: ['같1', '같2x'].map((n, i) => ({ member_id: `MB${i + 1}`, member_name: n, gender: '여', grade: null, member_order: i + 1 })),
    E3: ['같2', '같3'].map((n, i) => ({ member_id: `MC${i + 1}`, member_name: n, gender: null, grade: 'A', member_order: i + 1 })),
    E4: ['나1', '나2', '나3'].map((n, i) => ({ member_id: null, member_name: n, gender: '남', grade: null, member_order: i + 1 })),
  },
  fail: { event: false, members: false },
};
const src = {
  async getEventMatchType() { return A.fail.event ? { data: null, error: 'timeout' } : { data: { ...A.event } }; },
  async getDivisions() { return { data: A.divisions.map(d => ({ ...d })) }; },
  async getEntries() { return { data: A.entries.map(e => ({ ...e })) }; },
  async getMembers(id) { return A.fail.members ? { data: null, error: 'timeout' } : { data: (A.members[id] || []).map(m => ({ ...m })) }; },
};
const sync = (o) => syncTeamEntries(sb, src, eventId, o);
const clubsNow = async () => must(await sb.from('clubs').select('*').eq('event_id', eventId).order('created_at'), '클럽');
const membersOf = async (cid) => must(await sb.from('club_members').select('*').eq('club_id', cid).order('member_order'), '선수');
const logCount = async () => (must(await sb.from('sync_log').select('id').eq('event_id', eventId), 'log')).length;

async function main() {
  const name = `__TEST_TEAM_sync021_${Date.now()}`;
  eventId = must(await sb.from('events').insert({
    name, event_key: name.toLowerCase(), date: new Date().toISOString().slice(0, 10), location: 'TEST',
    status: 'active', event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'admin_only', team_match_type: null,
  }).select().single(), '이벤트').id;

  console.log('\nS1  첫 동기화');
  let r = await sync();
  ok(r.success && r.synced === 3 && (r.errors || []).length === 1 && r.errors[0].includes('같은 이름'), `신규 3 + 같은 이름 오류 1 (${JSON.stringify({ s: r.synced, e: r.errors })})`);
  const divs = must(await sb.from('divisions').select('*').eq('event_id', eventId), '부서');
  const d1 = divs.find(d => d.name === '1부'), d2 = divs.find(d => d.name === '2부');
  ok(d1?.team_match_type === '5_doubles' && d2 && d2.team_match_type === null, '부서 생성 + 1부 5복식 / 2부 기본');
  ok((await sb.from('events').select('team_match_type').eq('id', eventId).single()).data.team_match_type === '3_doubles', '대회 기본 3복식');
  let clubs = await clubsNow();
  const gatM = await membersOf(clubs.find(c => c.name === '같은클럽').id);
  ok(clubs.filter(c => c.name === '같은클럽').length === 1 && gatM.map(m => m.name).join(',') === '같1,같2x', '같은클럽 1개, 첫 신청 명단 그대로 (덮어쓰지 않음)');
  const ga = clubs.find(c => c.name === '가클럽');
  let gaM = await membersOf(ga.id);
  ok(gaM.length === 4 && gaM[0].app_a_member_id === 'MA1' && gaM[0].is_captain, '가클럽 선수 4명, 앱A ID·주장 표시');
  const logs1 = await logCount();

  console.log('\nS2  재동기화 (변경 없음)');
  r = await sync();
  ok(r.success && r.synced === 0 && r.updated === 0 && r.unchanged === 3, `변경 0 (${r.synced}/${r.updated}/${r.unchanged})`);
  const gaM2 = await membersOf(ga.id);
  ok(JSON.stringify(gaM2.map(m => m.id)) === JSON.stringify(gaM.map(m => m.id)), '선수 ID 그대로');
  ok(await logCount() === logs1, 'sync_log 추가 없음');
  const na = clubs.find(c => c.name === '나클럽');
  const naIds = (await membersOf(na.id)).map(m => m.id);
  await sync();
  ok(JSON.stringify((await membersOf(na.id)).map(m => m.id)) === JSON.stringify(naIds), '앱A ID 없는 선수도 이름으로 맞춰 ID 그대로');

  console.log('\nS3  라인업에 쓰인 선수가 빠지고 새 선수 추가');
  const gat = clubs.find(c => c.name === '같은클럽');
  const tie = must(await sb.from('ties').insert({ event_id: eventId, division_id: d1.id, round: 'full_league', tie_order: 1, club_a_id: ga.id, club_b_id: gat.id, rubber_count: 5, status: 'pending' }).select().single(), '대전');
  must(await sb.from('team_lineups').insert({ tie_id: tie.id, club_id: ga.id, rubber_number: 1, player1_id: gaM[1].id, player2_id: gaM[2].id, submitted_by: 'captain' }), '라인업');
  A.members.E1 = [A.members.E1[0], A.members.E1[2], A.members.E1[3], { member_id: 'MA9', member_name: '가9', gender: '남', grade: null, member_order: 5 }]; // 가2(라인업) 빠짐
  A.members.E1 = A.members.E1.filter(m => m.member_name !== '가4'); // 가4(안 쓰임) 빠짐
  r = await sync();
  gaM = await membersOf(ga.id);
  const names = gaM.map(m => m.name).sort().join(',');
  ok(names === '가1,가2,가3,가9', `명단 = ${names} (가2 유지, 가4 삭제, 가9 추가)`);
  ok((r.warnings || []).some(w => w.includes('가2')), '가2 유지 경고');
  ok(gaM.find(m => m.name === '가3').id === gaM2.find(m => m.name === '가3').id, '남은 선수 ID 그대로');
  ok(r.updated === 1, '업데이트 1팀');

  console.log('\nS4  앱A 조회 실패');
  A.fail.event = true; A.fail.members = true;
  A.event.team_match_type = '5_doubles';
  r = await sync();
  ok(r.success && (await sb.from('events').select('team_match_type').eq('id', eventId).single()).data.team_match_type === '3_doubles', '대회 경기방식 유지');
  ok((await membersOf(ga.id)).length === 4 && (r.errors || []).some(e => e.includes('선수 명단 조회 실패')), '선수 명단 유지 + 오류 보고');
  A.fail.event = false; A.fail.members = false; A.event.team_match_type = '3_doubles';

  console.log('\nS5  빈 선수 명단');
  const saved = A.members.E4; A.members.E4 = [];
  r = await sync();
  ok((await membersOf(na.id)).length === 3, '나클럽 명단 유지');
  A.members.E4 = saved;

  console.log('\nS6  주장 PIN 변경');
  A.entries[0].captain_pin = '999999';
  r = await sync();
  ok((await sb.from('club_pins').select('captain_pin').eq('club_id', ga.id).single()).data?.captain_pin === '999999', '앱A PIN 반영 (club_pins)');

  console.log('\nS7  1부 대전 후 경기방식 변경');
  A.divisions[0].team_match_type = '3_doubles';
  r = await sync();
  ok((await sb.from('divisions').select('team_match_type').eq('id', d1.id).single()).data.team_match_type === '5_doubles', '1부 5복식 유지');
  ok((r.warnings || []).some(w => w.includes('1부')), '경고 보고');
  A.divisions[0].team_match_type = '5_doubles';
  await sb.from('team_lineups').delete().eq('tie_id', tie.id);
  await sb.from('ties').delete().eq('id', tie.id);

  console.log('\nS8  취소된 신청');
  A.entries[3].status = 'cancelled';
  r = await sync();
  ok((r.cancelled || []).some(c => c.includes('나클럽')), `취소 보고 (${JSON.stringify(r.cancelled)})`);
  ok((await clubsNow()).some(c => c.name === '나클럽'), '나클럽 유지');
  ok(r.total === 3, '활성 신청 3건');
  A.entries[3].status = 'confirmed';

  console.log('\nS9  부서 매핑 실패');
  A.entries.push({ id: 'E5', club_name: '다클럽', captain_name: null, captain_pin: null, division_id: 'D9', division_name: '9부', status: 'confirmed' });
  A.divisions.push({ division_id: 'D9', division_name: '9부', team_match_type: null });
  r = await sync({ autoCreateDivisions: false });
  ok((r.errors || []).some(e => e.includes('다클럽') && e.includes('9부')), '오류 보고');
  ok(!(await clubsNow()).some(c => c.name === '다클럽'), '클럽 안 만듦');
  A.entries.pop(); A.divisions.pop();

  console.log('\nR1  조편성 복식 수');
  // 1부 가·같은·같은 + 추가 1팀으로 4팀, 2부 나 + 추가 3팀
  must(await sb.from('clubs').insert([
    ...[1, 2, 3].map(i => ({ event_id: eventId, division_id: d1.id, name: `임시1부${i}` })),
    ...[1, 2, 3].map(i => ({ event_id: eventId, division_id: d2.id, name: `임시2부${i}` })),
  ]), '추가 클럽');
  for (const d of [d1, d2]) {
    const g = must(await sb.rpc('rpc_create_team_groups', { p_event_id: eventId, p_group_count: 2, p_group_size: 2, p_division_id: d.id }), '조편성');
    const want = d === d1 ? 5 : 3;
    const ties = must(await sb.from('ties').select('id, rubber_count').eq('event_id', eventId).eq('division_id', d.id).eq('round', 'group'), '조 대전');
    const rub = must(await sb.from('tie_rubbers').select('id').in('tie_id', ties.map(t => t.id)), '러버');
    ok(g.success && g.rubber_count === want && ties.every(t => t.rubber_count === want) && rub.length === ties.length * want,
      `${d.name}: 대전 ${ties.length}개 모두 ${want}복식, 러버 ${rub.length}개`);
  }
  const ev = (await sb.from('events').select('team_match_type, team_rubber_count').eq('id', eventId).single()).data;
  ok(ev.team_match_type === '3_doubles' && ev.team_rubber_count === 3, '대회 값 덮어쓰지 않음');

  console.log('\nR2  풀리그 / 대진 생성');
  const fl = must(await sb.rpc('rpc_generate_full_league', { p_event_id: eventId, p_division_id: d2.id }), '풀리그');
  ok(fl.success && fl.rubber_count === 3, `2부 풀리그 3복식`);
  const gen = must(await sb.rpc('rpc_generate_team_tournament_v2', { p_event_id: eventId, p_division_id: d1.id, p_advance_per_group: 1, p_allow_tbd: true }), '대진');
  const ko = must(await sb.from('ties').select('rubber_count').eq('event_id', eventId).eq('division_id', d1.id).in('round', ['semi', 'final']), '본선');
  ok(gen.success && ko.length > 0 && ko.every(t => t.rubber_count === 5), `1부 본선 ${ko.length}경기 모두 5복식 (${JSON.stringify(gen)})`);
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally { await cleanup(); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
