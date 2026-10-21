// ============================================================
// 037 실서버 확인 — 임시 대회('__TEST_SIM_037_')를 만들어 ⚡ 자동 이어 배정을 돌려 보고 지운다
//   node scripts/sim-037-live.mjs          → 실행 + 정리
//   node scripts/sim-037-live.mjs cleanup  → 남은 임시 대회만 정리
// service_role 로 직접 상태를 바꿔 트리거를 실행한다 (실제 대회 데이터는 건드리지 않음)
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
let env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8'); if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1)
env.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const PREFIX = '__TEST_SIM_037_'
const must = (r, l) => { if (r.error) throw new Error(l + ': ' + r.error.message); return r.data }
let pass = 0, fail = 0
const check = (ok, label, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && d !== undefined ? '  → ' + JSON.stringify(d) : ''}`) }

async function cleanup() {
  const evs = must(await sb.from('events').select('id').like('name', PREFIX + '%'), 'events')
  for (const { id } of evs) {
    const tieIds = ((await sb.from('ties').select('id').eq('event_id', id)).data || []).map(r => r.id)
    if (tieIds.length) await sb.from('tie_rubbers').delete().in('tie_id', tieIds)
    for (const t of ['audit_log', 'matches', 'ties', 'team_standings', 'groups', 'teams', 'clubs', 'venues', 'divisions'])
      await sb.from(t).delete().eq('event_id', id)
    const r = await sb.from('events').delete().eq('id', id)
    console.log(r.error ? `⚠️ 삭제 실패 ${id}: ${r.error.message}` : `🧹 임시 대회 삭제 ${id}`)
  }
}

async function run() {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const ev = must(await sb.from('events').insert({ name: PREFIX + Date.now(), event_key: 'sim037-' + Date.now(), date: today, location: '테스트', status: 'preparing',
    event_type: 'team', team_format: 'group_tournament', team_rubber_count: 3, team_sets_per_rubber: 1, team_match_type: '3_doubles', lineup_mode: 'captain_pin' }).select().single(), '대회')
  const div = must(await sb.from('divisions').insert({ event_id: ev.id, name: '시뮬부', sort_order: 1, match_date: today }).select().single(), '부서')
  must(await sb.from('venues').insert([
    { event_id: ev.id, name: '시뮬가', short_name: '가', court_count: 3, courts: ['가-1', '가-2', '가-3'], created_at: new Date(Date.now() - 1000).toISOString() },
    { event_id: ev.id, name: '시뮬나', short_name: '나', court_count: 2, courts: ['나-1', '나-2'], created_at: new Date().toISOString() },
  ]), '경기장')
  const setZones = (z, on = true) => sb.from('events').update({ court_zones: z, auto_fill_courts: on }).eq('id', ev.id)

  // ── 개인전 (teams + matches) ──
  const team = async n => must(await sb.from('teams').insert({ event_id: ev.id, division_id: div.id, division_name: div.name, team_num: 'T-' + n, team_key: div.id + '|' + n, team_name: n, player1_name: n + '가', p1_club: '', player2_name: n + '나', p2_club: '', pin_plain: String(370000 + (++k)) }).select('id').single(), '팀').id
  let k = 0
  const mk = async (round, court = null, status = 'PENDING') => must(await sb.from('matches').insert({
    event_id: ev.id, division_id: div.id, division_name: div.name, stage: 'FINALS', round, match_num: `S-${++k}`, slot: k,
    team_a_id: await team('A' + k), team_b_id: await team('B' + k), court, court_order: court ? 1 : null, status,
  }).select('id').single(), '경기').id
  const get = async id => (await sb.from('matches').select('court,status').eq('id', id).single()).data
  const finish = id => sb.from('matches').update({ status: 'FINISHED', score: '6:2' }).eq('id', id)

  // ① 라운드 칸(16강=가-2 전용)이 있으면, 본선 공통(가-1)이 비어도 16강을 안 데려옴 — 027이면 데려옴
  must(await setZones({ [div.id]: { finals: ['가-1'], rounds: { '16강': ['가-2'] } } }), '구역')
  const r16 = await mk('16강')
  let cur = await mk('16강', '가-1', 'IN_PROGRESS'); must(await finish(cur), '종료')
  check((await get(r16)).court === null, '① 037 적용: 가-1(본선 공통) 비어도 16강(가-2 전용)은 안 데려옴', await get(r16))
  cur = await mk('16강', '가-2', 'IN_PROGRESS'); must(await finish(cur), '종료')
  check((await get(r16)).court === '가-2' && (await get(r16)).status === 'IN_PROGRESS', '① 가-2 비면 16강을 데려와 시작', await get(r16))

  // ② 코트 사용 시간 밖이면 안 올림
  must(await setZones({ _avail: { [today]: { '가-3': { until: '00:00' } } } }), '사용 시간')
  const w = await mk('8강')
  cur = await mk('8강', '가-3', 'IN_PROGRESS'); must(await finish(cur), '종료')
  check((await get(w)).court === null, '② 사용 시간 밖(가-3) → 안 올림', await get(w))
  cur = await mk('8강', '나-2', 'IN_PROGRESS'); must(await finish(cur), '종료')
  check((await get(w)).court === '나-2', '② 시간 설정 없는 코트(나-2)는 예전처럼 올림', await get(w))
  await sb.from('matches').delete().eq('event_id', ev.id)

  // ── 단체전 (clubs + ties) ──
  const club = async n => must(await sb.from('clubs').insert({ event_id: ev.id, division_id: div.id, name: n, captain_name: n, captain_pin: String(370000 + (++k)) }).select('id').single(), '클럽').id
  const tie = async (o) => must(await sb.from('ties').insert({ event_id: ev.id, division_id: div.id, round: o.round || 'round_of_16', bracket_position: o.pos ?? null,
    club_a_id: await club('CA' + k), club_b_id: await club('CB' + k), rubber_count: 3, status: o.status || 'pending', court_number: o.cn ?? null, court_order: o.cn ? 1 : null }).select('id').single(), '대전').id
  const tget = async id => (await sb.from('ties').select('court_number,court_order,status').eq('id', id).single()).data
  must(await setZones({}), '구역 초기화')
  const q1 = await tie({ round: 'quarter', pos: 1 })
  let tc = await tie({ cn: 4, status: 'in_progress' })    // 4번 = 나-1
  must(await sb.from('ties').update({ status: 'completed' }).eq('id', tc), '대전 종료')
  const g = await tget(q1)
  check(g.court_number === 4 && g.status === 'pending', '③ 단체전: 대전 끝 → 다음 대전을 나-1(4번)에 배정만 (상태 그대로)', g)
  const log = must(await sb.from('audit_log').select('target_id,details').eq('event_id', ev.id).eq('action', 'auto_court_fill').eq('target_id', q1), '로그')
  check(log.length === 1 && log[0].target_id === q1 && log[0].details?.court === '나-1', '③ 감사 로그 (코트 이름 나-1)', log)

  // ④ ⚡ 꺼짐이면 아무것도 안 함
  must(await setZones({}, false), '끔')
  const q2 = await tie({ round: 'quarter', pos: 2 })
  tc = await tie({ cn: 5, status: 'in_progress' })
  must(await sb.from('ties').update({ status: 'completed' }).eq('id', tc), '대전 종료')
  check((await tget(q2)).court_number === null, '④ ⚡ 꺼짐 → 배정 안 함')
}

const mode = process.argv[2]
await cleanup()
if (mode !== 'cleanup') {
  try { await run() } catch (e) { check(false, '중단: ' + e.message) }
  await cleanup()
  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail ? 1 : 0)
}
