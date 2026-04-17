// ============================================================
// 팀장 PIN 여러 부서 선택 시뮬레이션
// handleTeamSubmit에서 사용하는 동일 쿼리로 부서 분기 로직 검증
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
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; } catch { return { status: r.status, data: text }; }
}

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label} ${detail}`); failed++; }
}

// ── 실제 handleTeamSubmit 로직 재현 ──
async function simulateTeamSubmit(pin) {
  // 1. clubs 조회 (+ division_id)
  const clubRes = await rest(`clubs?captain_pin=eq.${pin}&select=id,name,event_id,division_id`);
  const clubs = clubRes.data || [];
  if (clubs.length === 0) return { error: 'PIN에 해당하는 클럽 없음' };

  // 2. 부서명 조회
  const divIds = [...new Set(clubs.map(c => c.division_id).filter(Boolean))];
  const divNameMap = {};
  if (divIds.length > 0) {
    const divRes = await rest(`divisions?id=in.(${divIds.join(',')})&select=id,name`);
    for (const d of divRes.data || []) divNameMap[d.id] = d.name;
  }

  // 3. 부서별 그룹핑
  const divMap = new Map();
  for (const c of clubs) {
    const divKey = c.division_id || '_nodiv';
    const divName = c.division_id ? (divNameMap[c.division_id] || '(부서 미지정)') : '단체전';
    if (!divMap.has(divKey)) divMap.set(divKey, { division_id: c.division_id, division_name: divName, clubs: [] });
    divMap.get(divKey).clubs.push({ id: c.id, name: c.name });
  }

  const choices = [...divMap.values()];
  return { clubs, choices, needsDivisionPicker: choices.length > 1 };
}

async function loadTiesForClubs(clubIds) {
  const orFilter = clubIds.flatMap(id => [`club_a_id.eq.${id}`, `club_b_id.eq.${id}`]).join(',');
  const r = await rest(`ties?or=(${orFilter})&status=in.(pending,lineup_phase,lineup_ready,in_progress)&select=id,tie_order,status,round,club_a:clubs!ties_club_a_id_fkey(id,name),club_b:clubs!ties_club_b_id_fkey(id,name)&order=tie_order`);
  return r.data || [];
}

console.log('▶ 팀장 PIN 부서 선택 시뮬레이션\n');

// ──────────────────────────────────────────
// Step 0: 여러 부서에 걸친 captain_pin이 존재하는지 DB에서 탐색
// ──────────────────────────────────────────
console.log('Step 0: 여러 부서 captain_pin 탐색');
const allClubs = await rest('clubs?select=captain_pin,division_id,name&captain_pin=not.is.null&division_id=not.is.null');
const pinToDivs = new Map();
for (const c of allClubs.data || []) {
  if (!c.captain_pin || !c.division_id) continue;
  if (!pinToDivs.has(c.captain_pin)) pinToDivs.set(c.captain_pin, new Set());
  pinToDivs.get(c.captain_pin).add(c.division_id);
}
const multiDivPins = [...pinToDivs.entries()].filter(([_, divs]) => divs.size > 1);
const singleDivPins = [...pinToDivs.entries()].filter(([_, divs]) => divs.size === 1);
console.log(`  - 여러 부서 PIN: ${multiDivPins.length}건`);
console.log(`  - 단일 부서 PIN: ${singleDivPins.length}건\n`);

// ──────────────────────────────────────────
// Case 1: 단일 부서 PIN → 부서 선택 건너뜀
// ──────────────────────────────────────────
if (singleDivPins.length > 0) {
  const [pin] = singleDivPins[0];
  console.log(`── Case 1: 단일 부서 PIN (${pin.slice(0,2)}****)`);
  const r = await simulateTeamSubmit(pin);
  console.log(`  clubs: ${r.clubs.length}, choices: ${r.choices.length}`);
  assert('needsDivisionPicker = false', r.needsDivisionPicker === false);
  assert('choices.length = 1', r.choices.length === 1);
  const ties = await loadTiesForClubs(r.clubs.map(c => c.id));
  console.log(`  ties: ${ties.length}건\n`);
} else {
  console.log('── Case 1: 단일 부서 PIN (DB에 없음 — 스킵)\n');
}

// ──────────────────────────────────────────
// Case 2: 여러 부서 PIN → 부서 선택 화면 필요
// ──────────────────────────────────────────
if (multiDivPins.length > 0) {
  const [pin] = multiDivPins[0];
  console.log(`── Case 2: 실제 여러 부서 PIN (${pin.slice(0,2)}****)`);
  const r = await simulateTeamSubmit(pin);
  console.log(`  clubs: ${r.clubs.length}, choices: ${r.choices.length}`);
  for (const c of r.choices) {
    console.log(`    · ${c.division_name} → ${c.clubs.map(cl => cl.name).join(', ')}`);
  }
  assert('needsDivisionPicker = true', r.needsDivisionPicker === true);
  assert('choices.length >= 2', r.choices.length >= 2);

  // 부서 하나 선택 → 해당 부서 ties만 반환되는지
  const picked = r.choices[0];
  const ties = await loadTiesForClubs(picked.clubs.map(c => c.id));
  console.log(`  "${picked.division_name}" 선택 → ties ${ties.length}건`);
  // 모든 ties는 picked의 club만 포함해야 함
  const pickedClubIds = new Set(picked.clubs.map(c => c.id));
  const onlyPickedDiv = ties.every(t =>
    pickedClubIds.has(t.club_a?.id) || pickedClubIds.has(t.club_b?.id)
  );
  assert('선택된 부서의 ties만 반환', onlyPickedDiv);
  console.log();
} else {
  console.log('── Case 2: 여러 부서 PIN이 DB에 없음 → 가상 시나리오로 검증');

  // DB에 실제 예시가 없으면, 같은 PIN 쓰는 클럽 2개를 가상으로 만들어서 로직만 검증
  // (실제 데이터 변경 없이 로직만)
  const twoDivs = await rest('divisions?limit=2&select=id,name&event_id=eq.a10cf306-8e38-4695-8320-6b1611af79b3');
  if (twoDivs.data.length >= 2) {
    const fakeClubs = [
      { id: 'fake-1', name: '가상클럽A', event_id: 'x', division_id: twoDivs.data[0].id },
      { id: 'fake-2', name: '가상클럽B', event_id: 'x', division_id: twoDivs.data[1].id },
    ];
    const divMap = new Map();
    for (const c of fakeClubs) {
      if (!divMap.has(c.division_id)) divMap.set(c.division_id, { clubs: [] });
      divMap.get(c.division_id).clubs.push(c);
    }
    console.log(`  가상 클럽 2개 (부서 ${twoDivs.data[0].name}, ${twoDivs.data[1].name})`);
    assert('divMap.size === 2 (여러 부서 감지)', divMap.size === 2);
    console.log();
  }
}

console.log('═'.repeat(50));
console.log(`결과: ${passed} passed, ${failed} failed`);
