// ============================================================
// 011 검증: 예선 라운드에서 2:0 후 3번째 러버 점수 입력 가능한지 테스트
//
// 시나리오:
//   1. 테스트 tie 생성 (group 라운드, 3복식)
//   2. 러버1 점수 입력 → A승 (1:0)
//   3. 러버2 점수 입력 → A승 (2:0, 과반 달성)
//   4. tie status 확인: in_progress 여야 함 (completed 아님)
//   5. 러버3 점수 입력 → B승 (2:1)
//   6. tie status 확인: completed 여야 함 (모든 러버 완료)
//   7. rubber_diff 확인: A는 2-1=+1
//   8. 정리 (테스트 데이터 삭제)
// ============================================================
import fs from 'node:fs';

const envFile = fs.readFileSync('.env.local', 'utf-8');
const env = Object.fromEntries(envFile.split('\n').filter(l => l.includes('=')).map(l => {
  const [k, ...v] = l.split('=');
  return [k.trim(), v.join('=').trim()];
}));

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(path, opts = {}) {
  const r = await fetch(url + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; } catch { return { status: r.status, data: text }; }
}

async function rpc(name, params) {
  const r = await fetch(url + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

const eventId = 'a10cf306-8e38-4695-8320-6b1611af79b3';
let testTieId = null;
let testRubberIds = [];
let testClubAId = null;
let testClubBId = null;

let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label} ${detail}`); failed++; }
}

try {
  console.log('▶ 011 검증: 예선 라운드 과반 후 러버 입력 테스트\n');

  // 0. 기존 클럽 2개 가져오기 (테스트용)
  const clubRes = await rest(`clubs?event_id=eq.${eventId}&select=id,name&limit=2`);
  if (!clubRes.data || clubRes.data.length < 2) {
    console.log('❌ 테스트용 클럽 2개 이상 필요'); process.exit(1);
  }
  testClubAId = clubRes.data[0].id;
  testClubBId = clubRes.data[1].id;
  console.log(`클럽 A: ${clubRes.data[0].name} (${testClubAId.slice(0,8)})`);
  console.log(`클럽 B: ${clubRes.data[1].name} (${testClubBId.slice(0,8)})\n`);

  // 1. 테스트 tie 생성 (group, 3복식)
  const tieInsert = await rest('ties', {
    method: 'POST',
    body: JSON.stringify({
      event_id: eventId,
      club_a_id: testClubAId,
      club_b_id: testClubBId,
      round: 'group',
      rubber_count: 3,
      tie_order: 9999,
      status: 'in_progress',
      is_bye: false,
      club_a_rubbers_won: 0,
      club_b_rubbers_won: 0,
    }),
  });
  testTieId = tieInsert.data?.[0]?.id;
  if (!testTieId) { console.log('❌ tie 생성 실패:', tieInsert); process.exit(1); }
  console.log(`테스트 tie 생성: ${testTieId.slice(0,8)}\n`);

  // 2. 러버 3개 생성
  for (let i = 1; i <= 3; i++) {
    const rubRes = await rest('tie_rubbers', {
      method: 'POST',
      body: JSON.stringify({
        tie_id: testTieId,
        rubber_number: i,
        status: 'pending',
        pin_code: String(100000 + i),
      }),
    });
    testRubberIds.push(rubRes.data?.[0]?.id);
  }
  console.log(`러버 3개 생성: ${testRubberIds.map(id => id?.slice(0,8)).join(', ')}\n`);

  // ── 시나리오 ──

  // Step 1: 러버1 → A승 (6:4)
  console.log('── Step 1: 러버1 점수 입력 (A 6:4 승)');
  const r1 = await rpc('rpc_admin_record_score', {
    p_rubber_id: testRubberIds[0],
    p_set1_a: 6, p_set1_b: 4,
  });
  assert('러버1 저장 성공', r1.success === true, JSON.stringify(r1));

  // Step 2: 러버2 → A승 (6:3) — 이제 2:0 과반 달성
  console.log('\n── Step 2: 러버2 점수 입력 (A 6:3 승) → 과반 2:0 달성');
  const r2 = await rpc('rpc_admin_record_score', {
    p_rubber_id: testRubberIds[1],
    p_set1_a: 6, p_set1_b: 3,
  });
  assert('러버2 저장 성공', r2.success === true, JSON.stringify(r2));

  // Step 3: tie 상태 확인 — in_progress여야 함 (completed 아님!)
  const tieAfter2 = await rest(`ties?id=eq.${testTieId}&select=status,winning_club_id,club_a_rubbers_won,club_b_rubbers_won`);
  const tie2 = tieAfter2.data?.[0];
  console.log(`\n── Step 3: 과반(2:0) 후 tie 상태 확인`);
  console.log(`  tie status: ${tie2?.status}, winner: ${tie2?.winning_club_id?.slice(0,8) || 'null'}`);
  console.log(`  rubbers: A ${tie2?.club_a_rubbers_won} - B ${tie2?.club_b_rubbers_won}`);
  assert('tie가 아직 completed 아님', tie2?.status !== 'completed', `got: ${tie2?.status}`);
  assert('tie status = in_progress', tie2?.status === 'in_progress', `got: ${tie2?.status}`);
  assert('winning_club_id 설정됨 (A)', tie2?.winning_club_id === testClubAId);

  // Step 4: 러버3 점수 입력 가능한지 → B승 (6:2)
  console.log('\n── Step 4: 러버3 점수 입력 (B 2:6 승) → 득실 반영');
  const r3 = await rpc('rpc_admin_record_score', {
    p_rubber_id: testRubberIds[2],
    p_set1_a: 2, p_set1_b: 6,
  });
  assert('러버3 저장 성공 (과반 후에도 입력 가능!)', r3.success === true, JSON.stringify(r3));

  // Step 5: tie 상태 확인 — 이제 completed여야 함
  const tieAfter3 = await rest(`ties?id=eq.${testTieId}&select=status,winning_club_id,club_a_rubbers_won,club_b_rubbers_won`);
  const tie3 = tieAfter3.data?.[0];
  console.log(`\n── Step 5: 모든 러버 완료 후 tie 상태 확인`);
  console.log(`  tie status: ${tie3?.status}, winner: ${tie3?.winning_club_id?.slice(0,8) || 'null'}`);
  console.log(`  rubbers: A ${tie3?.club_a_rubbers_won} - B ${tie3?.club_b_rubbers_won}`);
  assert('tie가 이제 completed', tie3?.status === 'completed', `got: ${tie3?.status}`);
  assert('winning_club_id = A', tie3?.winning_club_id === testClubAId);
  assert('A rubbers = 2', tie3?.club_a_rubbers_won === 2);
  assert('B rubbers = 1 (3번째 반영됨!)', tie3?.club_b_rubbers_won === 1, `got: ${tie3?.club_b_rubbers_won}`);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`결과: ${passed} passed, ${failed} failed`);

} finally {
  // 정리
  console.log('\n── 정리: 테스트 데이터 삭제');
  if (testRubberIds.length > 0) {
    for (const id of testRubberIds) {
      if (id) await rest(`tie_rubbers?id=eq.${id}`, { method: 'DELETE' });
    }
    console.log('  러버 삭제 완료');
  }
  if (testTieId) {
    await rest(`ties?id=eq.${testTieId}`, { method: 'DELETE' });
    console.log('  tie 삭제 완료');
  }
}
