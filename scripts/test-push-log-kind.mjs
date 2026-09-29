// READ-ONLY 테스트: 알림 로그 상태 분류(src/lib/push-log-kind.ts) + 대회 전 코트변경 보류 규칙
// 실행: node scripts/test-push-log-kind.mjs
// - 합성 케이스 + H.B컵(2026-09-19) 실제 push_logs 분류
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'push-log-kind.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
const { logKind } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

let fail = 0;
const ok = (c, msg) => { console.log((c ? '  ✅ ' : '  ❌ ') + msg); if (!c) fail++; };
const L = (o) => ({ team_a_name: 'A', team_b_name: 'B', sent: 0, failed: 0, no_sub: false, error_msg: null, ...o });

console.log('▶ 합성 케이스');
ok(logKind(L({ sent: 1 })) === 'ok', '발송 성공');
ok(logKind(L({ sent: 1, failed: 1, error_msg: 'expired: status=410 gone' })) === 'cleanup', '성공 + 만료 구독 정리 → 오류 아님');
ok(logKind(L({ failed: 1, error_msg: 'expired: status=410 gone' })) === 'expired', '구독이 전부 만료 → 구독만료');
ok(logKind(L({ sent: 1, failed: 2, error_msg: 'expired: x | expired-retry: y' })) === 'cleanup', '만료만 여러 건이어도 정리');
ok(logKind(L({ sent: 1, failed: 1, error_msg: 'retry-failed: status=500' })) === 'partial', '재시도 실패 섞이면 일부실패');
ok(logKind(L({ failed: 1, error_msg: 'retry-failed: status=500' })) === 'fail', '전부 재시도 실패 → 실패');
ok(logKind(L({ error_msg: 'fetch failed' })) === 'fail', '서버 오류 → 실패');
ok(logKind(L({ no_sub: true })) === 'no_sub', '구독 없음');
ok(logKind(L({ no_sub: true, team_a_name: '', team_b_name: null })) === 'no_target', '두 팀 이름 없음 → 대기경기 없음');
ok(logKind(L({ no_sub: true, team_a_name: '' })) === 'no_sub', '한쪽 미정 + 구독 없음 → 구독없음');
ok(logKind(L({ error_msg: 'skipped: 경기일(2026-09-19) 전 코트 변경 — 발송 안 함' })) === 'held', '대회 전 보류');

console.log('\n▶ H.B컵 실제 로그 (읽기 전용)');
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const E = '45bcc787-09ba-4c06-be0d-c29818125113';
const { data: logs } = await sb.from('push_logs').select('*').eq('event_id', E).lte('created_at', '2026-09-20T00:00:00Z');
const { data: ev } = await sb.from('events').select('date').eq('id', E).single();
const cnt = {}; for (const l of logs) { const k = logKind(l); cnt[k] = (cnt[k] || 0) + 1; }
console.log('  분류:', JSON.stringify(cnt));
ok(!cnt.fail && !cnt.partial, '실패·일부실패 0건 (예전 화면의 ❌ 오류 1건은 만료 정리였음)');
ok(cnt.cleanup === 1, '10:06 제대-8 → 성공·만료정리 1건');
ok(cnt.no_target === 18, '대기경기 없음 18건 (예전엔 구독없음에 섞임)');

// 대회 전 보류 규칙 재현: 코트변경 로그의 KST 날짜 < 대회일
const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const pre = logs.filter(l => l.trigger === 'court_changed' && kst(l.created_at) < ev.date);
const preSent = pre.reduce((s, l) => s + l.sent, 0);
console.log(`  대회일 ${ev.date} 전 코트변경 로그 ${pre.length}건, 실제 도착 ${preSent}건`);
ok(pre.length === 76 && preSent === 7, '9/17·18 코트변경 76건(실제 도착 7건) → 새 규칙이면 모두 보류');
const sameDay = logs.filter(l => l.trigger === 'court_changed' && kst(l.created_at) === ev.date);
ok(sameDay.length === 19, `대회 당일 코트변경 ${sameDay.length}건은 그대로 발송`);

console.log(fail ? `\n❌ 실패 ${fail}건` : '\n✅ 전부 통과');
process.exit(fail ? 1 : 0);
