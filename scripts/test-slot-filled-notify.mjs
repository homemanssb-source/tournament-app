// READ-ONLY 테스트: 본선 빈자리 채움 알림 대상 선정 (src/lib/slot-filled-notify.ts 를 그대로 실행)
// 실행: node scripts/test-slot-filled-notify.mjs
// - 합성 케이스 + H.B컵(2026-09-19) 실제 push_logs 로 "그때 이 기능이 있었다면" 재현
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'slot-filled-notify.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
const { findFilledSlotTargets } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

let fail = 0;
const ok = (c, msg) => { console.log((c ? '  ✅ ' : '  ❌ ') + msg); if (!c) fail++; };
const M = (o) => ({ id: 'm1', court: '제대-7', status: 'PENDING', stage: 'FINALS', round: '8강', match_date: '2026-09-19', division_name: '여자', team_a_id: 'A', team_b_id: 'B', team_a_name: '팀A', team_b_name: '팀B', ...o });
const L = (a, b, o = {}) => ({ court: '제대-7', division_name: '여자', team_a_name: a, team_b_name: b, ...o });
const T = '2026-09-19';
const run = (ms, ls) => findFilledSlotTargets(ms, ls, T).map(t => t.teamId).join(',');

console.log('▶ 합성 케이스');
ok(run([M()], [L('팀A', '')]) === 'B', 'A만 알림 받음(B 미정) → B에게');
ok(run([M()], [L('', '팀B')]) === 'A', 'B만 알림 받음(A 미정) → A에게');
ok(run([M()], [L('팀A', null)]) === 'B', '미정 이름이 null 이어도 동일');
ok(run([M()], [L('팀A', ''), L('팀A', '팀B')]) === '', '두 팀 이름 로그가 이미 있으면 재발송 안 함');
ok(run([M()], [L('팀B', '팀A')]) === '', '순서 바뀐 두 팀 로그도 이미 보낸 것으로');
ok(run([M()], []) === '', '로그가 전혀 없으면(한 번도 안내 안 됨) 보내지 않음 — 차례 알림이 따로 감');
ok(run([M()], [L('팀A', '', { court: '제대-1' })]) === '', '다른 코트 로그는 무시');
ok(run([M()], [L('팀A', '', { division_name: '마스터' })]) === '', '다른 부서 로그는 무시');
ok(run([M({ status: 'IN_PROGRESS' })], [L('팀A', '')]) === '', '진행중 경기는 제외');
ok(run([M({ stage: 'GROUP' })], [L('팀A', '')]) === '', '조별 경기는 제외');
ok(run([M({ court: null })], [L('팀A', '')]) === '', '코트 미배정 제외');
ok(run([M({ team_b_id: null, team_b_name: '' })], [L('팀A', '')]) === '', '아직 미정이면 제외');
ok(run([M({ match_date: '2026-09-20' })], [L('팀A', '')]) === '', '다른 날짜 경기 제외');
ok(run([M({ match_date: null })], [L('팀A', '')]) === 'B', '날짜 없는 경기는 포함');

console.log('\n▶ H.B컵 재현 (실제 push_logs, 읽기 전용)');
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const E = '45bcc787-09ba-4c06-be0d-c29818125113';
const { data: logs } = await sb.from('push_logs').select('court, division_name, team_a_name, team_b_name, created_at').eq('event_id', E);
const { data: ms } = await sb.from('v_matches_with_teams').select('id, court, status, stage, round, match_date, division_name, team_a_id, team_b_id, team_a_name, team_b_name').eq('event_id', E).eq('stage', 'FINALS');
// 경기를 "빈자리가 막 채워진 직후(PENDING)" 로 되돌리고, 그 시각까지의 로그만 사용
const at = (id, iso) => findFilledSlotTargets(ms.filter(m => m.id === id).map(m => ({ ...m, status: 'PENDING', match_date: null })), logs.filter(l => l.created_at < iso), T);
const find = (court, sub) => ms.find(m => m.court === court && (m.team_a_name + m.team_b_name).includes(sub));

const w8 = find('제대-7', '좌미경');          // 8강 마은정 vs 좌미경 — 12:10:53 에 "마은정 vs  " 로만 안내
const r1 = at(w8.id, '2026-09-19T03:30:00Z'); // 12:30 KST
ok(r1.length === 1 && r1[0].teamId === (w8.team_a_name.includes('좌미경') ? w8.team_a_id : w8.team_b_id), '좌미경팀 8강(제대-7) → 좌미경팀에게 발송');

const w4 = find('제대-5', '좌미경');          // 4강 좌미경 vs 강정화 — 13:42:52 에 "  vs 강정화" 로만 안내
const r2 = at(w4.id, '2026-09-19T04:55:00Z'); // 13:55 KST
ok(r2.length === 1 && r2[0].teamId === (w4.team_a_name.includes('좌미경') ? w4.team_a_id : w4.team_b_id), '좌미경팀 4강(제대-5) → 좌미경팀에게 발송');

const j8 = find('제대-4', '심광현');          // 지도자 8강 이승헌/정지우 vs 심광현 — 12:12:30 "  vs 심광현"
const r3 = at(j8.id, '2026-09-19T03:20:00Z'); // 12:20 KST
ok(r3.length === 1 && r3[0].teamId === (j8.team_a_name.includes('이승헌') ? j8.team_a_id : j8.team_b_id), '이승헌/정지우팀 8강(제대-4) → 이승헌/정지우팀에게 발송');

const m8 = find('제대-1', '강기준');          // 11:31:19 에 두 팀 이름으로 이미 안내됨
ok(at(m8.id, '2026-09-19T04:00:00Z').length === 0, '두 팀 모두 안내된 경기(제대-1 8강)는 추가 발송 없음');

const now = findFilledSlotTargets(ms, logs, T);
ok(now.length === 0, `지금 H.B컵 전체로 돌리면 대상 0건 (모두 종료) → ${now.length}`);

console.log(fail ? `\n❌ 실패 ${fail}건` : '\n✅ 전부 통과');
process.exit(fail ? 1 : 0);
