// ============================================================
// 단체전 팀장 push 구독 로직 검증
// - 단일 부서 captain_pin → 1 row 생성
// - 다중 부서 captain_pin → N rows 생성 (각 club_id별)
// - 존재하지 않는 PIN → 404
//
// 주의: 실제 /api/push/subscribe는 dev 서버에서 테스트해야 하므로
// 여기서는 API 로직(DB 쿼리 + upsert)을 재현만 함
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

// 수정된 subscribe API 로직 재현
async function simulateSubscribe(pin) {
  const targetIds = [];
  let teamName = null;

  // 개인전 먼저
  const teamRes = await rest(`teams?pin_plain=eq.${pin}&select=id,team_name&limit=1`);
  if (teamRes.data?.length > 0) {
    targetIds.push(teamRes.data[0].id);
    teamName = teamRes.data[0].team_name;
  }

  // 단체전 captain_pin (여러 row 가능)
  if (targetIds.length === 0) {
    const clubRes = await rest(`clubs?captain_pin=eq.${pin}&select=id,name`);
    if (clubRes.data?.length > 0) {
      for (const c of clubRes.data) targetIds.push(c.id);
      const names = [...new Set(clubRes.data.map(c => c.name))];
      teamName = names.join(' / ');
    }
  }

  return { targetIds, teamName, count: targetIds.length };
}

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label} ${detail}`); failed++; }
}

console.log('▶ 단체전 팀장 push 구독 로직 검증\n');

// ── 단일 부서 captain_pin 찾기 ──
const allClubs = await rest('clubs?select=captain_pin,name,division_id&captain_pin=not.is.null');
const pinCount = new Map();
for (const c of allClubs.data || []) {
  if (!pinCount.has(c.captain_pin)) pinCount.set(c.captain_pin, []);
  pinCount.get(c.captain_pin).push(c);
}
const singleDivPin = [...pinCount.entries()].find(([_, clubs]) => clubs.length === 1);
const multiDivPin = [...pinCount.entries()].find(([_, clubs]) => clubs.length > 1);

console.log('── Case 1: 단일 부서 captain_pin');
if (singleDivPin) {
  const [pin, clubs] = singleDivPin;
  const r = await simulateSubscribe(pin);
  console.log(`  PIN ${pin.slice(0,2)}****: ${clubs[0].name}`);
  assert('targetIds.length === 1', r.count === 1);
  assert('teamName = 클럽명', r.teamName === clubs[0].name);
} else { console.log('  (DB에 단일 부서 PIN 없음)'); }

console.log('\n── Case 2: 다중 부서 captain_pin (기존 버그 케이스)');
if (multiDivPin) {
  const [pin, clubs] = multiDivPin;
  const r = await simulateSubscribe(pin);
  console.log(`  PIN ${pin.slice(0,2)}****: ${clubs.length}개 부서 (${clubs.map(c => c.name).join(', ')})`);
  console.log(`  → targetIds.length = ${r.count}`);
  assert('targetIds.length === 부서 개수', r.count === clubs.length);
  assert('teamName 포함', r.teamName && r.teamName.length > 0);
}

console.log('\n── Case 3: 존재하지 않는 PIN');
const r3 = await simulateSubscribe('000000');
assert('targetIds 없음', r3.count === 0);
assert('teamName null', r3.teamName === null);

console.log(`\n${'═'.repeat(50)}`);
console.log(`결과: ${passed} passed, ${failed} failed`);

console.log('\n📌 실제 테스트는 브라우저에서:');
console.log('   1. /pin → 단체전 → PIN 입력');
console.log('   2. "알림 켜기" 클릭 → 브라우저 허용 다이얼로그');
console.log('   3. 허용 후 push_subscriptions 테이블에 row 생성 확인');
console.log('   4. 휴대폰 화면 끄고 /api/notify/court 테스트');
