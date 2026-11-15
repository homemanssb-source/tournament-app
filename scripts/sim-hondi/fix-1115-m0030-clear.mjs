// 2026-11-15 혼디모영배 챌린저부: 8강 M-0027 초기화 후 4강 M-0030 A 에 남은 부윤철/류현창 비움 (조건부 UPDATE)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
let c = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const b = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BU = '3d0fca39-42dd-46b9-9ecf-bcda7666115b', M30 = '78509d2a-cd86-42f6-b655-d73564d080ea', M27 = 'f5706fd2-7cdd-4633-bc24-9656b11defc6';
const get = async () => (await b.from('matches').select('id,match_num,round,status,team_a_id,team_b_id,score,winner_team_id,court,court_order,started_at').in('id', [M27, M30]).order('match_num')).data;
const before = await get(); console.log('BEFORE', JSON.stringify(before));
const m27 = before.find(m => m.id === M27);
if (m27.score || m27.winner_team_id) { console.log('8강 M-0027 에 점수가 들어가 있음 — 중단'); process.exit(1); }
const r = await b.from('matches').update({ team_a_id: null, status: 'PENDING', started_at: null }).eq('id', M30).eq('team_a_id', BU).is('score', null).is('winner_team_id', null).select('id');
if (r.error) throw new Error(r.error.message);
console.log('M-0030 →', r.data.length, '행');
console.log('AFTER', JSON.stringify(await get()));
