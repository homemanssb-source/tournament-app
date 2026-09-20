// READ-ONLY 확인: 대회의 '참가'(본선 순위 없는 팀) 명단 — src/lib/participation.ts 를 그대로 실행
// 실행: node scripts/check-participation.mjs <event_id>
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
let content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
content.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'participation.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
const { findParticipantOnlyTeams } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const eventId = process.argv[2];
if (!eventId) { console.log('usage: node scripts/check-participation.mjs <event_id>'); process.exit(1); }
const { data: all } = await sb.from('matches').select('stage, status, score, round, group_id, division_id, team_a_id, team_b_id, winner_team_id').eq('event_id', eventId);
const { data: teams } = await sb.from('teams').select('id, team_name, division_id').eq('event_id', eventId);
const { data: divs } = await sb.from('divisions').select('id, name').eq('event_id', eventId).order('sort_order');
const tn = Object.fromEntries(teams.map(t => [t.id, t.team_name]));

const placed = new Set(all.filter(m => m.stage === 'FINALS' && m.status === 'FINISHED' && m.round && m.winner_team_id && m.team_a_id && m.team_b_id).flatMap(m => [m.team_a_id, m.team_b_id]));
const part = findParticipantOnlyTeams(all, placed);
for (const d of divs) {
  const total = teams.filter(t => t.division_id === d.id).length;
  const p = part.filter(x => x.division_id === d.id);
  const pl = [...placed].filter(id => teams.find(t => t.id === id)?.division_id === d.id).length;
  console.log(`\n■ ${d.name}: 등록 ${total}팀 = 본선 순위 ${pl}팀 + 참가 ${p.length}팀${total - pl - p.length ? ` + 미포함 ${total - pl - p.length}팀` : ''}`);
  p.forEach(x => console.log('   참가  ' + tn[x.team_id]));
  teams.filter(t => t.division_id === d.id && !placed.has(t.id) && !p.some(x => x.team_id === t.id)).forEach(t => console.log('   (미포함: 완료 경기 없음) ' + t.team_name));
}
