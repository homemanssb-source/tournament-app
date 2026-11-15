// 2026-11-15 혼디모영배 루키부: 16강 M-0118 초기화 후 8강 M-0122 B 에 남은 김동현/이충환 비우고 대기로 (조건부 UPDATE)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
let c = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const b = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KIM = 'fd034610-985e-497f-8a20-f7a908ba1705', M122 = '7c6b4aa2-b884-46d0-ae66-e0c7693cae5f', M118 = 'b5c83323-cfd4-4561-979c-dc00a9433cb1';
const get = async () => (await b.from('matches').select('id,match_num,round,status,team_a_id,team_b_id,score,winner_team_id,court,court_order,started_at').in('id', [M118, M122]).order('match_num')).data;
const before = await get(); console.log('BEFORE', JSON.stringify(before));
const m118 = before.find(m => m.id === M118);
if (m118.score || m118.winner_team_id) { console.log('16강 M-0118 에 점수가 들어가 있음 — 중단'); process.exit(1); }
const r = await b.from('matches').update({ team_b_id: null, status: 'PENDING', started_at: null }).eq('id', M122).eq('team_b_id', KIM).is('score', null).is('winner_team_id', null).select('id');
if (r.error) throw new Error(r.error.message);
console.log('M-0122 →', r.data.length, '행');
console.log('AFTER', JSON.stringify(await get()));
