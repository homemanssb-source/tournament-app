// 플랜 B: PIN 23**** 소유자의 모든 endpoint에 테스트 푸시 발송
import fs from 'node:fs';
import webpush from 'web-push';

const env = Object.fromEntries(fs.readFileSync('.env.local','utf-8').split('\n').filter(l=>l.includes('=')).map(l=>{const[k,...v]=l.split('=');return[k.trim(),v.join('=').trim()]}));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

webpush.setVapidDetails(
  'mailto:admin@jeju-tournament.com',
  env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  env.VAPID_PRIVATE_KEY
);

async function rest(p, opts={}) {
  const r = await fetch(url+'/rest/v1/'+p, { ...opts, headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...(opts.headers||{})}});
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}

const teams = await rest('teams?pin_plain=like.23*&select=id');
const clubs = await rest('clubs?captain_pin=like.23*&select=id');
const allIds = [...teams.map(t=>t.id), ...clubs.map(c=>c.id)];
const subs = await rest('push_subscriptions?team_id=in.(' + allIds.join(',') + ')&select=team_id,endpoint,p256dh,auth,created_at');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('▶ 1단계: 각 endpoint에 probe 1회 발송해서 생존 확인');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

async function sendOne(sub, payload, seq) {
  const start = Date.now();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      { urgency: 'high', TTL: 60 }
    );
    return { ok: true, ms: Date.now() - start, seq };
  } catch (err) {
    const code = err.statusCode || err.status || 0;
    return { ok: false, code, body: (err.body || err.message || '').slice(0,100), ms: Date.now() - start, seq };
  }
}

// 1단계: probe
const probeResults = [];
for (let i = 0; i < subs.length; i++) {
  const sub = subs[i];
  const tag = sub.endpoint.slice(50, 70);
  const payload = JSON.stringify({
    title: '🔔 테스트 PROBE ' + (i+1),
    body: '구독 생존 확인 — ' + new Date().toLocaleTimeString('ko-KR'),
    tag: 'probe-' + Date.now() + '-' + i,
    url: '/',
  });
  const r = await sendOne(sub, payload, i);
  probeResults.push({ ...r, endpoint: sub.endpoint, tag });
  console.log(`  [${i+1}/${subs.length}] ${r.ok ? '✅ OK' : '❌ ' + r.code} (${r.ms}ms) ...${tag}`);
}

const alive = probeResults.filter(r => r.ok);
const dead  = probeResults.filter(r => !r.ok);
console.log();
console.log(`생존 endpoint: ${alive.length}/${subs.length}`);
if (dead.length > 0) {
  console.log('❌ 실패:');
  for (const d of dead) console.log('  code=' + d.code + ' body=' + d.body);
}

if (alive.length === 0) { console.log('\n생존한 endpoint 없음. 종료.'); process.exit(0); }

// 2단계: 10회 반복 (가장 최근 endpoint로)
console.log();
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('▶ 2단계: 생존 endpoint로 10회 반복 발송 (2초 간격)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 가장 최근 endpoint 선택 (created_at 내림차순 첫번째)
const target = alive.map(r => subs.find(s => s.endpoint === r.endpoint)).sort((a,b) => b.created_at.localeCompare(a.created_at))[0];
console.log(`대상 endpoint: ${target.endpoint.slice(0, 70)}... (created=${target.created_at.slice(0,19)})`);
console.log();

const results = [];
for (let i = 1; i <= 10; i++) {
  const payload = JSON.stringify({
    title: `🎾 테스트 ${i}/10`,
    body: `푸시 도달 테스트 — ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
    tag: 'reliability-' + Date.now() + '-' + i,
    url: '/',
  });
  const r = await sendOne(target, payload, i);
  results.push(r);
  console.log(`  [${i}/10] ${r.ok ? '✅ 전송 OK' : '❌ 실패 ' + r.code} (${r.ms}ms)`);
  if (i < 10) await new Promise(res => setTimeout(res, 2000));
}

console.log();
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('▶ 리포트');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const okCount = results.filter(r => r.ok).length;
const avgMs = Math.round(results.filter(r=>r.ok).reduce((s,r)=>s+r.ms,0) / (okCount || 1));
console.log('전송 성공:', okCount + '/10');
console.log('평균 응답:', avgMs + 'ms');
console.log();
console.log('📱 사용자 폰에서 확인 (제가 측정 불가):');
console.log('   - 몇 개의 알림이 실제 도착했는지');
console.log('   - 화면이 꺼진 상태에서도 왔는지');
console.log('   - 알림 내용이 "테스트 1/10" ~ "테스트 10/10" 형식으로 순서대로 왔는지');
