// ============================================================
// 단체전 휴대폰 리허설용 임시 대회
//   node scripts/rehearsal-team-event.mjs create   → 대회 + 2클럽(선수 6명씩) + 풀리그 1대전 + 마스터 PIN, 공오더 허용 부서
//   node scripts/rehearsal-team-event.mjs delete   → 이름이 '리허설_단체전_' 으로 시작하는 대회 전부 삭제
// 앱A 연동 없음(자동 동기화 대상 아님). 3복식, 주장 PIN 모드.
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
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data; };

const PREFIX = '리허설_단체전_';
const SITE = 'https://jeju-tournament.vercel.app';
const PIN_A = '240101', PIN_B = '240102', MASTER = '0929';

async function create() {
  const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const name = PREFIX + kstToday.slice(5).replace('-', '');
  const ev = must(await sb.from('events').insert({
    name, event_key: 'rehearsal-team-' + Date.now(), date: kstToday, location: '리허설',
    status: 'active', event_type: 'team', team_format: 'full_league', team_rubber_count: 3,
    team_sets_per_rubber: 1, allow_player_reuse: true, lineup_mode: 'captain_pin', team_match_type: '3_doubles',
  }).select().single(), '대회');
  const div = must(await sb.from('divisions').insert({ event_id: ev.id, name: '리허설부', sort_order: 1, allow_empty_order: true }).select().single(), '부서');
  const clubs = must(await sb.from('clubs').insert([
    { event_id: ev.id, division_id: div.id, name: '리허설A클럽', captain_name: 'A주장', captain_pin: PIN_A, seed_number: 1 },
    { event_id: ev.id, division_id: div.id, name: '리허설B클럽', captain_name: 'B주장', captain_pin: PIN_B, seed_number: 2 },
  ]).select(), '클럽');
  for (const c of clubs) {
    const tag = c.name.includes('A') ? 'A' : 'B';
    must(await sb.from('club_members').insert([1, 2, 3, 4, 5, 6].map(i => ({
      club_id: c.id, name: `${tag}선수${i}`, gender: i % 2 ? 'M' : 'F', member_order: i, is_captain: i === 1,
    }))), '선수');
  }
  must(await sb.rpc('rpc_generate_full_league', { p_event_id: ev.id, p_division_id: div.id }), '풀리그');
  must(await sb.rpc('rpc_set_master_pin', { p_event_id: ev.id, p_new_pin: MASTER }), '마스터 PIN');
  const tie = must(await sb.from('ties').select('id').eq('event_id', ev.id).single(), '대전');
  console.log(JSON.stringify({ name, event_id: ev.id, tie_id: tie.id, PIN_A, PIN_B, MASTER,
    pin_url: `${SITE}/pin?event=${ev.id}`, lineup_url: `${SITE}/lineup/${tie.id}`,
    admin_url: `${SITE}/admin-pin?event=${ev.id}`, public_url: `${SITE}/events/${ev.id}` }, null, 2));
}

async function del() {
  const evs = must(await sb.from('events').select('id, name').like('name', PREFIX + '%'), '대회 조회');
  for (const ev of evs) {
    const tieIds = (await sb.from('ties').select('id').eq('event_id', ev.id)).data?.map(r => r.id) || [];
    const clubIds = (await sb.from('clubs').select('id').eq('event_id', ev.id)).data?.map(r => r.id) || [];
    if (tieIds.length) {
      await sb.from('tie_rubbers').delete().in('tie_id', tieIds);
      await sb.from('team_lineups').delete().in('tie_id', tieIds);
      await sb.from('pin_attempts').delete().in('target_key', tieIds.map(t => 'captain_tie:' + t));
    }
    await sb.from('pin_attempts').delete().in('target_key', ['captain_login:' + ev.id, 'admin_pin:' + ev.id, ...clubIds.map(c => 'club:' + c)]);
    if (clubIds.length) await sb.from('push_subscriptions').delete().in('team_id', clubIds);
    await sb.from('ties').delete().eq('event_id', ev.id);
    await sb.from('team_standings').delete().eq('event_id', ev.id);
    await sb.from('admin_pin_sessions').delete().eq('event_id', ev.id);
    await sb.from('audit_log').delete().eq('event_id', ev.id);
    if (clubIds.length) {
      await sb.from('club_members').delete().in('club_id', clubIds);
      await sb.from('club_pins').delete().in('club_id', clubIds);
    }
    await sb.from('clubs').delete().eq('event_id', ev.id);
    await sb.from('divisions').delete().eq('event_id', ev.id);
    const { error } = await sb.from('events').delete().eq('id', ev.id);
    console.log(error ? `⚠️ ${ev.name} 삭제 실패: ${error.message}` : `🧹 ${ev.name} 삭제`);
  }
  if (!evs.length) console.log('삭제할 리허설 대회 없음');
}

const mode = process.argv[2];
if (mode === 'create') await create();
else if (mode === 'delete') await del();
else console.log('사용법: node scripts/rehearsal-team-event.mjs create|delete');
