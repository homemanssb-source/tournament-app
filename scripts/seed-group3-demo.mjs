// ============================================================
// 3팀 조 "승자 우선" 규칙 — 앱 화면 데모용 seed
// 실행: node scripts/seed-group3-demo.mjs        (정리: node scripts/seed-sim.mjs --cleanup)
//
// 실제 운영 흐름과 같은 상태를 만든다:
//   조편성(RPC) → 경기 생성(RPC) → 경기장/코트 배정(자동배정과 같은 모양) → 첫 경기 "시작"
//   A조(T-1 코트): 기본 순서   1v2(진행중) → 1v3 → 2v3
//   B조(T-2 코트): 2v3을 맨 위로 옮긴 상태  2v3(진행중) → 1v2 → 1v3
// 이후 선수 PIN으로 점수를 넣어 공개 "코트현황"에서 순서 변화를 본다.
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

const { data: tmpl } = await sb.from('events').select('*').eq('event_type', 'individual').limit(1).single();
const row = { ...tmpl }; delete row.id; delete row.created_at; delete row.updated_at;
const name = `__TEST_SIM_3팀조데모_${Date.now()}`;
Object.assign(row, { name, event_key: name.toLowerCase(), status: 'active', master_pin_hash: null,
  date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) });
if ('app_a_connected' in row) row.app_a_connected = false;
if ('app_a_event_id' in row) row.app_a_event_id = null;
const { data: ev, error: ee } = await sb.from('events').insert(row).select().single();
if (ee) { console.error('이벤트 생성 실패:', ee.message); process.exit(1); }

const { data: div } = await sb.from('divisions').insert({ event_id: ev.id, name: '데모부', sort_order: 1 }).select().single();
const teamRows = Array.from({ length: 6 }, (_, i) => ({
  event_id: ev.id, division_id: div.id, division_name: div.name,
  team_key: `${div.id}|demo-${i + 1}`, team_name: `임시${i + 1}/임시`,
  player1_name: `임시${i + 1}`, player2_name: '임시', pin_plain: String(310001 + i),
}));
const { error: te } = await sb.from('teams').insert(teamRows);
if (te) { console.error('팀 생성 실패:', te.message); process.exit(1); }

// 조편성 (6팀, 조크기 3 → 3팀 조 2개) — 실DB RPC, seq 저장됨
const g = await sb.rpc('rpc_generate_groups', { p_event_id: ev.id, p_division_id: div.id, p_group_size: 3 });
if (g.error) { console.error('조편성 실패:', g.error.message); process.exit(1); }

// 화면에서 읽기 쉽게: 조/순번대로 팀 이름을 다시 붙인다 (A조 1번 …)
const { data: groups } = await sb.from('groups').select('id, group_num').eq('event_id', ev.id).order('group_num');
const { data: members } = await sb.from('group_members').select('group_id, team_id, seq').eq('event_id', ev.id);
const letter = ['A', 'B'];
const pinOf = {};
for (let gi = 0; gi < groups.length; gi++) {
  const ms = members.filter(m => m.group_id === groups[gi].id).sort((a, b) => a.seq - b.seq);
  for (const m of ms) {
    const pin = String(320000 + (gi + 1) * 10 + m.seq);      // A조: 320011~13, B조: 320021~23
    pinOf[`${letter[gi]}${m.seq}`] = pin;
    await sb.from('teams').update({
      team_name: `${letter[gi]}조${m.seq}번/짝꿍`, player1_name: `${letter[gi]}조${m.seq}번`, player2_name: '짝꿍', pin_plain: pin,
    }).eq('id', m.team_id);
  }
}

// 경기 생성 (seq 순: 1v2, 1v3, 2v3)
const mk = await sb.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: div.id });
if (mk.error) { console.error('경기 생성 실패:', mk.error.message); process.exit(1); }

// 경기장 + 코트 배정 (자동배정과 같은 모양: 한 조 = 한 코트, slot 순)
await sb.from('venues').insert({ event_id: ev.id, name: '데모경기장', short_name: 'T', court_count: 2, courts: ['T-1', 'T-2'], pin_plain: '399999' });
const seqOfTeam = Object.fromEntries(members.map(m => [m.team_id, m.seq]));
for (let gi = 0; gi < groups.length; gi++) {
  const { data: ms } = await sb.from('matches').select('id, slot, team_a_id, team_b_id').eq('group_id', groups[gi].id).order('slot');
  const lab = m => `${seqOfTeam[m.team_a_id]}v${seqOfTeam[m.team_b_id]}`;
  // A조: 기본 순서 / B조: 운영자가 2v3을 맨 위로 옮긴 상태
  const order = gi === 0 ? ['1v2', '1v3', '2v3'] : ['2v3', '1v2', '1v3'];
  for (let k = 0; k < order.length; k++) {
    const m = ms.find(x => lab(x) === order[k]);
    await sb.from('matches').update({ court: `T-${gi + 1}`, court_order: k + 1, status: k === 0 ? 'IN_PROGRESS' : 'PENDING',
      ...(k === 0 ? { started_at: new Date().toISOString() } : {}) }).eq('id', m.id);
  }
}

console.log('╔════════════════════════════════════════════════╗');
console.log(`  대회: ${name}`);
console.log(`  id  : ${ev.id}`);
console.log('  T-1 (A조): 1v2[진행중] → 1v3 → 2v3        ← A조 2번이 이기게 할 것');
console.log('  T-2 (B조): 2v3[진행중] → 1v2 → 1v3        ← B조 3번이 이기게 할 것');
console.log(`  PIN  A조2번=${pinOf.A2}  B조3번=${pinOf.B3}   (A1=${pinOf.A1} A3=${pinOf.A3} B1=${pinOf.B1} B2=${pinOf.B2})`);
console.log(`  공개 페이지: /events/${ev.id}`);
console.log('╚════════════════════════════════════════════════╝');
