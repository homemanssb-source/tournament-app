// 2026-11-15 혼디모영배 루키부 11조: 점수 정정 후 본선 1위/2위 자리 맞바꿈 (조건부 UPDATE)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
let c = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
c.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); });
const b = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PARK = 'a9111157-8f25-498a-a51e-44ed5814c422', YANG = '340994ac-a400-429e-be57-e6f2340ad613';
const M77 = 'a6f4ba77-c292-4efa-98bf-1872488988c8', M80 = '45f5909f-f1a3-4aa6-bf8d-878839a878c9';
const all = async () => (await b.from('matches').select('id,match_num,round,status,team_a_id,team_b_id,score,winner_team_id,court,court_order').in('match_num', ['M-0077', 'M-0080', 'M-0102']).eq('event_id', '171a51e0-43f8-4f1a-b739-72904d4eddc0').order('match_num')).data;
const nm = id => id === PARK ? '박진수/고민혁' : id === YANG ? '양성수/김민범' : id ? id.slice(0, 8) : '-';
const show = (t, rows) => { console.log(t); rows.forEach(m => console.log(`  ${m.match_num} ${m.round} ${m.status} A=${nm(m.team_a_id)} B=${nm(m.team_b_id)} score=${m.score ?? ''} win=${nm(m.winner_team_id)} ${m.court ?? ''}/${m.court_order ?? ''}`)); };
const before = await all(); show('BEFORE', before); console.log(JSON.stringify(before));
const M102 = before.find(m => m.match_num === 'M-0102').id;
const run = async (name, q) => { const r = await q.select('id'); if (r.error) throw new Error(name + ': ' + r.error.message); console.log(name, '→', r.data.length, '행'); return r.data.length; };
// 1) 64강 M-0080: 2위 자리 양성수 → 박진수 (점수·승자 없을 때만)
await run('M-0080', b.from('matches').update({ team_b_id: PARK }).eq('id', M80).eq('team_b_id', YANG).is('score', null).is('winner_team_id', null));
// 2) 64강 M-0077 부전승: 박진수 → 양성수
await run('M-0077', b.from('matches').update({ team_a_id: YANG, winner_team_id: YANG }).eq('id', M77).eq('team_a_id', PARK).eq('score', 'BYE'));
// 3) 32강 M-0102: 박진수 → 양성수 (트리거가 이미 바꿨으면 0행)
await run('M-0102', b.from('matches').update({ team_a_id: YANG }).eq('id', M102).eq('team_a_id', PARK).is('score', null).is('winner_team_id', null));
show('AFTER', await all());
