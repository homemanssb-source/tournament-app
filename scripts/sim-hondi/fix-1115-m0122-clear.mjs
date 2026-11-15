// 2026-11-15 혼디모영배 루키부: 16강 M-0117 초기화 후 8강 M-0122 에 남은 고태혁/정지용 자리 비움 (조건부 UPDATE)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
let c = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const b = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KO = '7ade7282-2703-46d5-937e-15954b4388ad', M122 = '7c6b4aa2-b884-46d0-ae66-e0c7693cae5f', M117 = 'bfeef962-3e66-4f90-b1c1-a910305bd290';
const get = async () => (await b.from('matches').select('id,match_num,round,status,team_a_id,team_b_id,score,winner_team_id,court,court_order').in('id', [M117, M122]).order('match_num')).data;
const before = await get(); console.log('BEFORE', JSON.stringify(before));
const m117 = before.find(m => m.id === M117);
if (m117.score || m117.winner_team_id) { console.log('16강에 점수가 다시 들어가 있음 — 중단'); process.exit(1); }
const r = await b.from('matches').update({ team_a_id: null }).eq('id', M122).eq('team_a_id', KO).is('score', null).is('winner_team_id', null).select('id');
if (r.error) throw new Error(r.error.message);
console.log('M-0122 →', r.data.length, '행');
console.log('AFTER', JSON.stringify(await get()));
