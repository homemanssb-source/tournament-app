// Simulate the 3 user-facing issues:
// 1) CourtBoard (대회보기 코트현황): division name shown per tie?
// 2) venue/manage CourtMatchCard: division/round/group shown per tie?
// 3) Date filter: filters to correct date?
import fs from 'node:fs';

const envFile = fs.readFileSync('.env.local', 'utf-8');
const env = Object.fromEntries(envFile.split('\n').filter(l => l.includes('=')).map(l => {
  const [k, ...v] = l.split('=');
  return [k.trim(), v.join('=').trim()];
}));

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(path, opts={}) {
  const r = await fetch(url + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer '+key, 'Content-Type':'application/json', ...(opts.headers||{}) },
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; } catch { return { status: r.status, data: text }; }
}

const eventId = 'a10cf306-8e38-4695-8320-6b1611af79b3';   // 시협회단체전
console.log(`▶ Event: ${eventId} (제6회 제주시테니스협회장배)\n`);

// Fetch divisions, groups
const divRes = await rest(`divisions?select=id,name,match_date&event_id=eq.${eventId}`);
const grpRes = await rest(`groups?select=id,group_label&event_id=eq.${eventId}`);
const divMap = Object.fromEntries(divRes.data.map(d => [d.id, d]));
const grpMap = Object.fromEntries(grpRes.data.map(g => [g.id, g.group_label]));

console.log('=== ① CourtBoard simulation (대회보기 코트현황) ===');
const tieRes = await rest(`ties?select=id,division_id,group_id,court_number,round,is_bye&event_id=eq.${eventId}&court_number=not.is.null&limit=5`);
console.log(`Ties on courts: ${tieRes.data.length}`);
for (const t of tieRes.data.slice(0, 3)) {
  const divName = divMap[t.division_id]?.name || '단체전(부서 없음)';
  const grpLabel = grpMap[t.group_id] || '(조 없음)';
  console.log(`  - tie ${t.id.slice(0,8)} → 부서:${divName} 라운드:${t.round} 조:${grpLabel} court:${t.court_number}`);
}

console.log('\n=== ② venue/manage simulation (현장관리) ===');
const sessRes = await rest(`venue_sessions?select=token,venue_name,courts&event_id=eq.${eventId}&order=created_at.desc&limit=1`);
const token = sessRes.data?.[0]?.token;
console.log(`Venue: ${sessRes.data?.[0]?.venue_name}, courts: ${sessRes.data?.[0]?.courts?.join(',')}`);
const rpcRes = await rest('rpc/rpc_venue_list_matches', { method: 'POST', body: JSON.stringify({ p_token: token }) });
const ties = rpcRes.data?.ties || [];
const matches = rpcRes.data?.matches || [];
console.log(`RPC returned: ${matches.length} matches, ${ties.length} ties`);
const sample = ties[0] || matches[0];
if (sample) {
  console.log('Sample fields:', Object.keys(sample).join(', '));
  const hasDivId = 'division_id' in sample;
  const hasGrpId = 'group_id' in sample;
  console.log(`  ✅ has division_id: ${hasDivId}`);
  console.log(`  ✅ has group_id:    ${hasGrpId}`);
  if (hasDivId) {
    console.log(`  → 부서: ${divMap[sample.division_id]?.name || sample.division_name}`);
    console.log(`  → 라운드: ${sample.round}`);
    console.log(`  → 조: ${grpMap[sample.group_id] || '(없음)'}`);
  } else {
    console.log(`  ❌ MIGRATION 010 NOT APPLIED → 날짜 필터 작동 안 함`);
    console.log(`  ❌ division_name = "${sample.division_name}" (하드코딩, 부서명 아님)`);
  }
}

console.log('\n=== ③ Date filter simulation ===');
const today = '2026-04-16';
const dates = [...new Set(divRes.data.map(d => d.match_date).filter(Boolean))].sort();
console.log(`Today: ${today}, Available dates: ${dates.join(', ')}`);
const picked = dates.includes(today) ? today : dates.reduce((b, c) => {
  const bd = Math.abs(new Date(b).getTime() - new Date(today).getTime());
  const cd = Math.abs(new Date(c).getTime() - new Date(today).getTime());
  return cd < bd ? c : b;
}, dates[0]);
console.log(`Auto-picked: ${picked}`);
const matchingDivs = divRes.data.filter(d => d.match_date === picked).map(d => d.id);
console.log(`Divisions on ${picked}: ${matchingDivs.length}`);

if (sample && 'division_id' in sample) {
  const allItems = [...matches, ...ties];
  const filtered = allItems.filter(m => {
    if (!m.division_id) return true;
    if (!divMap[m.division_id]?.match_date) return true;
    return matchingDivs.includes(m.division_id);
  });
  console.log(`After date filter: ${filtered.length}/${allItems.length} items remain`);
  console.log(`Distinct divisions: ${[...new Set(filtered.map(f => divMap[f.division_id]?.name))].join(', ')}`);
} else {
  console.log(`❌ Cannot test filter — division_id missing from RPC`);
}
