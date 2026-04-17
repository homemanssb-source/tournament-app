// ============================================================
// 팀장 PIN 세션 지속성 검증 (storage 키 호환성)
// 실제 브라우저 환경을 흉내내어 /pin → /lineup 플로우 시뮬레이션
// ============================================================

// Mock storage
class MockStorage {
  constructor() { this.data = {}; }
  getItem(k) { return this.data[k] ?? null; }
  setItem(k, v) { this.data[k] = String(v); }
  removeItem(k) { delete this.data[k]; }
  clear() { this.data = {}; }
}

const sessionStorage = new MockStorage();
const localStorage = new MockStorage();

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label} ${detail}`); failed++; }
}

// ── /pin/page.tsx의 goToTie 로직 ──
function goToTie(pin, tieId) {
  sessionStorage.setItem('captain_pin', pin);
  sessionStorage.setItem(`captain_pin_${tieId}`, pin);
  localStorage.setItem('captain_pin_session', JSON.stringify({ pin, _savedAt: Date.now() }));
}

// ── /lineup/[tie_id]/page.tsx의 auto-login lookup 로직 ──
function findSavedPin(tieId) {
  let savedPin = sessionStorage.getItem(`captain_pin_${tieId}`);
  if (!savedPin) savedPin = sessionStorage.getItem('captain_pin');
  if (!savedPin) {
    try {
      const lsRaw = localStorage.getItem('captain_pin_session');
      if (lsRaw) {
        const parsed = JSON.parse(lsRaw);
        if (parsed._savedAt && Date.now() - parsed._savedAt < 12 * 60 * 60 * 1000) {
          savedPin = parsed.pin;
        } else {
          localStorage.removeItem('captain_pin_session');
        }
      }
    } catch {}
  }
  return savedPin;
}

console.log('▶ 팀장 PIN 세션 지속성 시뮬레이션\n');

// ──────────────────────────────────────────
// Case 1: /pin 입력 → /lineup/A 이동 → 자동 인증 성공
// ──────────────────────────────────────────
console.log('── Case 1: 최초 PIN 입력 → tie 이동 (자동 인증)');
sessionStorage.clear(); localStorage.clear();
goToTie('123456', 'TIE-A');
let found = findSavedPin('TIE-A');
assert('/lineup/TIE-A 자동 인증 성공', found === '123456', `got: ${found}`);

// ──────────────────────────────────────────
// Case 2: 다른 tie로 이동 → 일반 키 폴백
// ──────────────────────────────────────────
console.log('\n── Case 2: 다른 tie로 이동 (예: 타이 목록에서 다른 대전 선택)');
// /pin에서 TIE-A로 갔다가 뒤로가서 TIE-B 누르면 goToTie가 다시 저장함
// 근데 만약 sessionStorage에 tie별 키가 없고 일반 키만 있으면?
sessionStorage.clear(); localStorage.clear();
sessionStorage.setItem('captain_pin', '123456');   // 일반 키만 있는 상태
found = findSavedPin('TIE-C');
assert('일반 키로 폴백 성공', found === '123456', `got: ${found}`);

// ──────────────────────────────────────────
// Case 3: 탭 닫았다 다시 열기 (sessionStorage 날아감) → localStorage 폴백
// ──────────────────────────────────────────
console.log('\n── Case 3: 탭 닫고 다시 열기 (12시간 내)');
sessionStorage.clear(); localStorage.clear();
localStorage.setItem('captain_pin_session', JSON.stringify({ pin: '123456', _savedAt: Date.now() }));
found = findSavedPin('TIE-D');
assert('localStorage 12시간 내 폴백 성공', found === '123456', `got: ${found}`);

// ──────────────────────────────────────────
// Case 4: 12시간 경과 → localStorage 만료 → 재인증 필요
// ──────────────────────────────────────────
console.log('\n── Case 4: 12시간 경과 (만료)');
sessionStorage.clear(); localStorage.clear();
localStorage.setItem('captain_pin_session', JSON.stringify({
  pin: '123456',
  _savedAt: Date.now() - 13 * 60 * 60 * 1000,  // 13시간 전
}));
found = findSavedPin('TIE-E');
assert('만료된 PIN은 반환 안 됨', found === null, `got: ${found}`);
assert('만료된 localStorage 자동 정리', localStorage.getItem('captain_pin_session') === null);

// ──────────────────────────────────────────
// Case 5: PIN 없는 상태 → null 반환
// ──────────────────────────────────────────
console.log('\n── Case 5: PIN 전혀 없는 상태');
sessionStorage.clear(); localStorage.clear();
found = findSavedPin('TIE-F');
assert('PIN 없으면 null 반환', found === null, `got: ${found}`);

console.log(`\n${'═'.repeat(50)}`);
console.log(`결과: ${passed} passed, ${failed} failed`);
