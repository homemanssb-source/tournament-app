import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync('.env.local','utf-8').split('\n').filter(l=>l.includes('=')).map(l=>{const[k,...v]=l.split('=');return[k.trim(),v.join('=').trim()]}));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(p, opts = {}) {
  const r = await fetch(url + '/rest/v1/' + p, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
}

const EVENT_ID = 'a10cf306-8e38-4695-8320-6b1611af79b3';
const apiUrl = process.env.API_URL || 'http://localhost:3000/api/notify/court';
let testTieId = null;

try {
  // ✅ 실제 사용자 구독이 걸린 club_id 찾기 (push_subscriptions와 매칭)
  const subRow = await rest('push_subscriptions?endpoint=like.*e7-DpF9CleQ*&select=team_id');
  if (!subRow.data[0]) throw new Error('사용자 구독 못 찾음');
  const userClubId = subRow.data[0].team_id;
  const opp = await rest('clubs?event_id=eq.' + EVENT_ID + '&name=eq.연동클럽&select=id&limit=1');
  if (!opp.data[0]) throw new Error('상대 club 찾기 실패');
  const oppClubId = opp.data[0].id;
  console.log('▶ 테스트 플로우 시작');
  console.log('  제주하나클럽 id:', userClubId);
  console.log('  연동클럽 id:', oppClubId);

  const tieIns = await rest('ties', {
    method: 'POST',
    body: JSON.stringify({
      event_id: EVENT_ID,
      club_a_id: userClubId,
      club_b_id: oppClubId,
      round: 'group',
      rubber_count: 3,
      tie_order: 9999,
      status: 'pending',
      is_bye: false,
      court_number: 3,
      court_order: 1,
      club_a_rubbers_won: 0,
      club_b_rubbers_won: 0,
    }),
  });
  testTieId = tieIns.data?.[0]?.id;
  if (!testTieId) throw new Error('tie 생성 실패: ' + JSON.stringify(tieIns));
  console.log();
  console.log('  ✅ 임시 tie 생성:', testTieId.slice(0,8), '| 코트 제대-3');

  console.log();
  console.log('▶ /api/notify/court 호출 (3회, 간격 3초)');

  for (let i = 1; i <= 3; i++) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: EVENT_ID,
        court: '제대-3',
        match_date: '2026-04-19',
        trigger: 'court_changed',
      }),
    });
    const data = await res.json();
    console.log('  [' + i + '/3] status=' + res.status + ' sent=' + (data.sent ?? '?') + ' retried=' + (data.retried ?? 0) + ' failed=' + (data.failed ?? 0) + (data.message ? ' msg=' + data.message : ''));
    if (i < 3) await new Promise(r => setTimeout(r, 3000));
  }

} catch (e) {
  console.error('❌', e.message);
} finally {
  if (testTieId) {
    console.log();
    console.log('── 정리');
    await rest('tie_rubbers?tie_id=eq.' + testTieId, { method: 'DELETE' });
    await rest('ties?id=eq.' + testTieId, { method: 'DELETE' });
    console.log('  임시 tie + rubbers 삭제 완료');
  }
}

console.log();
console.log('📱 사용자 폰에서 확인:');
console.log('   "제대-3 - 경기 준비하세요!" 알림이 3번 왔나요?');
