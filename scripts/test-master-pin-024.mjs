// ============================================================
// 검증: 마스터 PIN 해시 숨기기 (migration 024)
// 실행: node scripts/test-master-pin-024.mjs   (임시 대회를 만들고 끝나면 지운다)
//
//  M1  익명으로 events.master_pin_hash 가 전부 비어 있음, event_secrets 는 못 읽음
//  M2  마스터 PIN 설정 → events 쪽은 NULL, 설정 여부 조회는 true
//  M3  관리자 PIN 로그인: 맞는 PIN 성공 / 틀린 PIN 실패
//  M4  events.master_pin_hash 에 직접 써도 event_secrets 로 옮겨지고 events 는 NULL
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let evId = null, pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

async function main() {
  console.log('\nM1  익명 조회');
  const { count } = await anon.from('events').select('id', { count: 'exact', head: true }).not('master_pin_hash', 'is', null);
  ok(count === 0, `해시가 보이는 대회 ${count}개`);
  const es = await anon.from('event_secrets').select('*').limit(1);
  ok(!!es.error || (es.data || []).length === 0, `event_secrets 익명 조회 불가 (${es.error?.message || '0행'})`);

  const name = `__TEST_SIM_master024_${Date.now()}`;
  evId = must(await sb.from('events').insert({ name, event_key: name.toLowerCase(), date: '2026-09-29', location: 'T', status: 'active', event_type: 'individual' }).select().single(), '대회').id;

  console.log('\nM2  마스터 PIN 설정');
  ok((await anon.rpc('rpc_master_pin_status', { p_event_id: evId })).data === false, '설정 전 false');
  must(await sb.rpc('rpc_set_master_pin', { p_event_id: evId, p_new_pin: '7024' }), '설정');
  ok((await sb.from('events').select('master_pin_hash').eq('id', evId).single()).data.master_pin_hash === null, 'events.master_pin_hash NULL');
  ok((await anon.rpc('rpc_master_pin_status', { p_event_id: evId })).data === true, '설정 여부 true');

  console.log('\nM3  관리자 PIN 로그인');
  let r = await anon.rpc('rpc_admin_pin_login', { p_master_pin: '7024', p_event_id: evId });
  ok(r.data?.success === true && !!r.data?.token, '맞는 PIN 성공');
  r = await anon.rpc('rpc_admin_pin_login', { p_master_pin: '0000', p_event_id: evId });
  ok(r.data?.success === false, `틀린 PIN 실패 (${r.data?.error})`);

  console.log('\nM4  events 에 직접 쓰기');
  must(await sb.from('events').update({ master_pin_hash: '$2a$06$abcdefghijklmnopqrstuv' }).eq('id', evId), '직접 쓰기');
  ok((await sb.from('events').select('master_pin_hash').eq('id', evId).single()).data.master_pin_hash === null, 'events 는 NULL 유지');
  ok((await sb.from('event_secrets').select('master_pin_hash').eq('event_id', evId).single()).data?.master_pin_hash === '$2a$06$abcdefghijklmnopqrstuv', 'event_secrets 로 옮겨짐');
}

try { await main(); } catch (e) { console.error('💥', e.stack || e.message); fail++; }
finally {
  if (evId) {
    await sb.from('admin_pin_sessions').delete().eq('event_id', evId);
    await sb.from('audit_log').delete().eq('event_id', evId);
    await sb.from('pin_attempts').delete().eq('target_key', 'admin_pin:' + evId);
    await sb.from('event_secrets').delete().eq('event_id', evId);
    await sb.from('events').delete().eq('id', evId);
    console.log('🧹 테스트 이벤트 정리 완료');
  }
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
