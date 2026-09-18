// 라이브 DB 함수 정의 덤프 (임시 도우미 _dbg_def 가 있어야 함 — SQL 편집기로 생성/삭제)
// 실행: node scripts/dump-live-defs.mjs [fn1 fn2 ...]   → 스크래치 폴더에 live_fn_<name>.sql 저장
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
let c = readFileSync(join(__dirname, '..', '.env.local'), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = process.env.DUMP_DIR || join(__dirname, '..', '.live-defs'); mkdirSync(out, { recursive: true });
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['rpc_generate_tournament', 'rpc_fill_tournament_slots', 'advance_winner', 'rpc_advance_tournament_winner'];
const g1 = await sb.rpc('_dbg_def', { p_kind: 'grep', p_name: 'split_part' });
const g2 = await sb.rpc('_dbg_def', { p_kind: 'grep', p_name: 'string_to_array' });
const g3 = await sb.rpc('_dbg_def', { p_kind: 'grepview', p_name: 'score' });
console.log('▶ split_part 사용 함수:\n' + (g1.data || g1.error?.message || '(없음)'));
console.log('▶ string_to_array 사용 함수:\n' + (g2.data || g2.error?.message || '(없음)'));
console.log('▶ score 를 참조하는 뷰:\n' + (g3.data || g3.error?.message || '(없음)'));
for (const n of names) {
  const r = await sb.rpc('_dbg_def', { p_kind: 'fn', p_name: n });
  const txt = r.error ? 'ERROR: ' + r.error.message : (r.data || '(없음)');
  writeFileSync(join(out, `live_fn_${n}.sql`), txt);
  console.log(`▶ ${n}: ${txt.length}자 → ${join(out, `live_fn_${n}.sql`)}`);
}
