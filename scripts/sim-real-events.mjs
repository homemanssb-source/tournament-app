// ============================================================
// 실전 대회 리허설 (실서버) — 실제 대회를 그대로 복제한 테스트 대회로 첫 경기부터 결승까지 진행
//   node scripts/sim-real-events.mjs run [이음|재성]   → 복제 + 전 경기 진행 + 검사
//   node scripts/sim-real-events.mjs seed [이음|재성]  → 복제만 (화면 확인용, 상태는 .sim-state-real.json)
//   node scripts/sim-real-events.mjs cleanup          → '__TEST_SIM_실전_' 대회 전부 삭제
// 원본 대회는 읽기만 함. 복제본은 날짜를 2026-01-10 으로 (메인 화면에 안 뜨게), 앱A 연결 끔.
// 점수 입력은 역할을 돌아가며: 관리자(대시보드 RPC) · 마스터 PIN · 경기장 PIN · 내 경기(선수 PIN / 주장 PIN)
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
let env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8'); if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1)
env.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const anon = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const PREFIX = '__TEST_SIM_실전_'
const STATE = process.env.SIM_STATE || join(__dirname, '..', '.sim-state-real.json')
const SOURCES = {
  이음: '53e2500c-0fa8-4c37-aac6-76d856f6f523',
  재성: '1f6efbb6-7a04-4839-819f-8ff5488af57c',
}

// ── 결과 기록 ──
const results = []
let section = ''
const sec = t => { section = t; console.log(`\n━━━ ${t} ━━━`) }
const check = (cond, label, detail) => {
  results.push({ section, ok: !!cond, label, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && !cond ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const note = (label, detail) => { results.push({ section, ok: true, note: true, label, detail }); console.log(`NOTE  ${label}${detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`) }
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data }
const rpc = async (client, fn, args) => { const r = await client.rpc(fn, args); return { data: r.data, error: r.error?.message || null } }
const failed = r => !!r.error || r.data?.success === false || r.data?.ok === false
const errText = r => r.error || r.data?.error || r.data?.message || ''
const all = async (table, col, val, order) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    let q = svc.from(table).select('*')
    q = Array.isArray(val) ? q.in(col, val) : q.eq(col, val)
    if (order) q = q.order(order)
    const { data, error } = await q.range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data); if (data.length < 1000) break
  }
  return out
}
const insertAll = async (table, rows) => {
  for (let i = 0; i < rows.length; i += 300) must(await svc.from(table).insert(rows.slice(i, i + 300)), table + ' 복제')
}
// 결정적 난수 (매번 같은 진행)
let seed = 20261024
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }

// ── 정리 ──
async function deleteEvent(eventId) {
  const ids = async (t, col = 'event_id') => ((await svc.from(t).select('id').eq(col, eventId)).data || []).map(r => r.id)
  const tieIds = await ids('ties'), clubIds = await ids('clubs'), groupIds = await ids('groups')
  const matchIds = await ids('matches'), teamIds = await ids('teams'), venueIds = await ids('venues')
  const chunk = (a, n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))
  const del = (t, col, vals) => vals.length ? (async () => { for (const c of chunk(vals)) await svc.from(t).delete().in(col, c) }) : null
  const ops = [
    del('tie_rubbers', 'tie_id', tieIds), del('team_lineups', 'tie_id', tieIds),
    () => svc.from('ties').delete().eq('event_id', eventId),
    () => svc.from('team_standings').delete().eq('event_id', eventId),
    del('club_members', 'club_id', clubIds), del('club_pins', 'club_id', clubIds),
    del('push_subscriptions', 'team_id', [...clubIds, ...teamIds]),
    del('group_members', 'group_id', groupIds), del('bracket_nodes', 'match_id', matchIds),
    () => svc.from('audit_log').delete().eq('event_id', eventId),
    () => svc.from('admin_pin_sessions').delete().eq('event_id', eventId),
    () => svc.from('venue_sessions').delete().eq('event_id', eventId),
    () => svc.from('pin_sessions').delete().eq('event_id', eventId),
    () => svc.from('matches').delete().eq('event_id', eventId),
    () => svc.from('groups').delete().eq('event_id', eventId),
    () => svc.from('clubs').delete().eq('event_id', eventId),
    del('venue_pins', 'venue_id', venueIds),
    () => svc.from('venues').delete().eq('event_id', eventId),
    del('team_pins', 'team_id', teamIds),
    () => svc.from('teams').delete().eq('event_id', eventId),
    () => svc.from('group_settings').delete().eq('event_id', eventId),
    () => svc.from('divisions').delete().eq('event_id', eventId),
    () => svc.from('event_secrets').delete().eq('event_id', eventId),
    () => svc.from('sync_log').delete().eq('event_id', eventId),
    () => svc.from('operator_events').delete().eq('event_id', eventId),
    () => svc.from('push_log').delete().eq('event_id', eventId),
  ].filter(Boolean)
  for (const op of ops) { try { await op() } catch {} }
  const { data: att } = await svc.from('pin_attempts').select('target_key').like('target_key', `%${eventId}%`)
  if (att?.length) await svc.from('pin_attempts').delete().in('target_key', att.map(a => a.target_key))
  const { error } = await svc.from('events').delete().eq('id', eventId)
  return error?.message || null
}
async function cleanup() {
  const { data } = await svc.from('events').select('id, name').like('name', `${PREFIX}%`)
  for (const e of data || []) { const err = await deleteEvent(e.id); console.log(err ? `❌ ${e.name}: ${err}` : `삭제: ${e.name}`) }
  console.log(`정리 끝 (${data?.length || 0}개)`)
}

// ============================================================
// 복제 — 원본의 모든 행을 새 id 로 (외래키 전부 다시 연결)
// ============================================================
async function cloneEvent(srcId, label) {
  const src = must(await svc.from('events').select('*').eq('id', srcId).single(), '원본 대회')
  const id = new Map()
  const nid = old => { if (!old) return old; if (!id.has(old)) id.set(old, randomUUID()); return id.get(old) }
  const map = old => (old && id.has(old)) ? id.get(old) : old
  const strip = (r, ...ks) => { const x = { ...r }; for (const k of ['created_at', 'updated_at', ...ks]) delete x[k]; return x }

  const evId = randomUUID()
  const ev = strip(src)
  Object.assign(ev, { id: evId, name: PREFIX + label, event_key: 'sim-real-' + Date.now(), date: '2026-01-10',
    master_pin_hash: null, app_a_event_id: null, app_a_connected: false })
  must(await svc.from('events').insert(ev), '대회 복제')
  id.set(srcId, evId)

  const divs = await all('divisions', 'event_id', srcId)
  await insertAll('divisions', divs.map(d => ({ ...strip(d), id: nid(d.id), event_id: evId })))
  const teams = await all('teams', 'event_id', srcId)
  teams.forEach(t => nid(t.id))
  const groups = await all('groups', 'event_id', srcId)
  groups.forEach(g => nid(g.id))
  await insertAll('groups', groups.map(g => ({ ...strip(g), id: map(g.id), event_id: evId, division_id: map(g.division_id) })))
  const teamPin = {}
  await insertAll('teams', teams.map((t, i) => {
    teamPin[map(t.id)] = String(510000 + i)
    return { ...strip(t, 'pin_plain'), id: map(t.id), event_id: evId, division_id: map(t.division_id), group_id: map(t.group_id),
      team_key: `${map(t.division_id)}|sim|${i}`, checked_in: false, checked_in_at: null }
  }))
  if (teams.length) await insertAll('team_pins', teams.map(t => ({ team_id: map(t.id), pin_plain: teamPin[map(t.id)] })))
  const gms = await all('group_members', 'event_id', srcId)
  await insertAll('group_members', gms.map(g => ({ ...strip(g, 'id'), event_id: evId, division_id: map(g.division_id), group_id: map(g.group_id), team_id: map(g.team_id) })))
  const gss = await all('group_settings', 'event_id', srcId)
  await insertAll('group_settings', gss.map(g => ({ ...strip(g, 'id'), event_id: evId, division_id: map(g.division_id) })))

  const venues = await all('venues', 'event_id', srcId, 'created_at')
  const venuePin = {}
  await insertAll('venues', venues.map((v, i) => {
    const nv = nid(v.id); venuePin[nv] = String(520000 + i)
    return { ...v, id: nv, event_id: evId, division_id: map(v.division_id), division_ids: (v.division_ids || []).map(map), pin_plain: venuePin[nv], phone: null }
  }))

  const matches = await all('matches', 'event_id', srcId)
  matches.forEach(m => nid(m.id))
  // 'group-uuid:1' 같은 문자열 안의 id 도 바꿈
  const uuidAll = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  const remapStr = v => v.replace(uuidAll, u => map(u))
  const remapSrc = s => s == null ? s : (typeof s === 'string' ? remapStr(s) : JSON.parse(JSON.stringify(s), (k, v) => typeof v === 'string' ? remapStr(v) : v))
  await insertAll('matches', matches.map(m => ({ ...strip(m), id: map(m.id), event_id: evId, division_id: map(m.division_id), group_id: map(m.group_id),
    team_a_id: map(m.team_a_id), team_b_id: map(m.team_b_id), winner_team_id: map(m.winner_team_id),
    qualifier_src_a: remapSrc(m.qualifier_src_a), qualifier_src_b: remapSrc(m.qualifier_src_b), auto_assigned_at: null, auto_notified_at: null })))
  const bns = await all('bracket_nodes', 'event_id', srcId)
  await insertAll('bracket_nodes', bns.map(b => ({ ...strip(b), id: randomUUID(), event_id: evId, division_id: map(b.division_id), match_id: map(b.match_id),
    next_match_id: map(b.next_match_id), seed_a_team_id: map(b.seed_a_team_id), seed_b_team_id: map(b.seed_b_team_id) })))

  const clubs = await all('clubs', 'event_id', srcId)
  const clubPin = {}
  await insertAll('clubs', clubs.map((c, i) => { const n = nid(c.id); clubPin[n] = String(530000 + i)
    return { ...strip(c), id: n, event_id: evId, division_id: map(c.division_id), captain_pin: clubPin[n], captain_phone: null } }))
  const members = clubs.length ? await all('club_members', 'club_id', clubs.map(c => c.id)) : []
  await insertAll('club_members', members.map(m => ({ ...strip(m), id: nid(m.id), club_id: map(m.club_id) })))
  const ties = await all('ties', 'event_id', srcId)
  ties.forEach(t => nid(t.id))
  await insertAll('ties', ties.map(t => ({ ...strip(t), id: map(t.id), event_id: evId, group_id: map(t.group_id), division_id: map(t.division_id),
    club_a_id: map(t.club_a_id), club_b_id: map(t.club_b_id), winning_club_id: map(t.winning_club_id),
    qualifier_src_a: remapSrc(t.qualifier_src_a), qualifier_src_b: remapSrc(t.qualifier_src_b) })))
  const tieIds = ties.map(t => t.id)
  const rubs = tieIds.length ? await all('tie_rubbers', 'tie_id', tieIds) : []
  const already = tieIds.length ? (await all('tie_rubbers', 'tie_id', tieIds.map(map))).length : 0
  if (!already) await insertAll('tie_rubbers', rubs.map(r => ({ ...strip(r), id: randomUUID(), tie_id: map(r.tie_id), pin_code: null,
    club_a_player1_id: map(r.club_a_player1_id), club_a_player2_id: map(r.club_a_player2_id), club_b_player1_id: map(r.club_b_player1_id),
    club_b_player2_id: map(r.club_b_player2_id), winning_club_id: map(r.winning_club_id) })))
  const lus = tieIds.length ? await all('team_lineups', 'tie_id', tieIds) : []
  await insertAll('team_lineups', lus.map(l => ({ ...strip(l), id: randomUUID(), tie_id: map(l.tie_id), club_id: map(l.club_id), player1_id: map(l.player1_id), player2_id: map(l.player2_id) })))
  const sts = await all('team_standings', 'event_id', srcId)
  await insertAll('team_standings', sts.map(s => ({ ...strip(s), id: randomUUID(), event_id: evId, group_id: map(s.group_id), club_id: map(s.club_id) })))

  must(await svc.rpc('rpc_set_master_pin', { p_event_id: evId, p_new_pin: '549999' }), '마스터 PIN')

  // 복제 검증 — 행 수가 원본과 같은지
  const cnt = async (t, col, v) => (await svc.from(t).select('id', { count: 'exact', head: true }).in(col, Array.isArray(v) ? v : [v])).count
  const pairs = [['divisions', divs.length], ['teams', teams.length], ['groups', groups.length], ['matches', matches.length], ['clubs', clubs.length], ['ties', ties.length], ['venues', venues.length], ['team_standings', sts.length]]
  const bad = []
  for (const [t, n] of pairs) { const c = await cnt(t, 'event_id', evId); if (c !== n) bad.push(`${t} ${c}/${n}`) }
  if (tieIds.length) { const c = await cnt('tie_rubbers', 'tie_id', tieIds.map(map)); if (c !== rubs.length) bad.push(`tie_rubbers ${c}/${rubs.length}`) }
  check(!bad.length, `${label} 복제 (부서 ${divs.length} · 팀 ${teams.length} · 조 ${groups.length} · 경기 ${matches.length} · 클럽 ${clubs.length} · 대전 ${ties.length})`, bad)
  return { evId, src, venues: venues.map(v => ({ ...v, id: map(v.id), pin: venuePin[map(v.id)] })), teamPin, clubPin, map, divs: divs.map(d => ({ ...d, id: map(d.id) })) }
}

// 로그인 묶음
async function logins(c) {
  const A = await rpc(anon, 'rpc_admin_pin_login', { p_master_pin: '549999', p_event_id: c.evId })
  check(!failed(A) && A.data?.token, '마스터 PIN 로그인', errText(A))
  const master = A.data?.token
  const venueTok = {}, openTok = {}
  for (const v of c.venues) {
    const r = await rpc(anon, 'rpc_venue_login', { p_pin_code: v.pin, p_event_id: c.evId })
    check(!failed(r) && r.data?.token, `경기장 PIN 로그인 — ${v.name}`, errText(r)); venueTok[v.id] = r.data?.token
    const o = await rpc(anon, 'rpc_admin_pin_open_venue', { p_token: master, p_venue_id: v.id })
    check(!failed(o) && o.data?.token, `마스터 → ${v.name} 코트 관리`, errText(o)); openTok[v.id] = o.data?.token
  }
  return { master, venueTok, openTok }
}

// ============================================================
// 개인전 (이음)
// ============================================================
const SCORES = ['6:2', '6:3', '6:4', '7:6', '6:1', '6:0', '7:5']
async function individual(label) {
  sec(`${label} — 복제`)
  const c = await cloneEvent(SOURCES[label], label)
  const L = await logins(c)
  const venueOfCourt = court => c.venues.find(v => (v.courts || []).includes(court))
  const mm = async () => all('matches', 'event_id', c.evId)
  const teams = Object.fromEntries((await all('teams', 'event_id', c.evId)).map(t => [t.id, t]))
  const groups = Object.fromEntries((await all('groups', 'event_id', c.evId)).map(g => [g.id, g]))
  const playerTok = {}
  const loginPlayer = async teamId => {
    if (playerTok[teamId]) return playerTok[teamId]
    const r = await rpc(anon, 'rpc_pin_login', { p_pin_code: c.teamPin[teamId], p_event_id: c.evId })
    if (failed(r)) { check(false, `선수 PIN 로그인 ${teams[teamId]?.team_name}`, errText(r)); return null }
    return (playerTok[teamId] = r.data.token)
  }
  // 관리자(대시보드) RPC 가 서비스 키로 되는지 먼저 확인
  let adminOk = null
  const roleCount = { admin: 0, master: 0, venue: 0, player: 0 }
  const fails = []
  const ROLES = ['player', 'venue', 'master', 'admin']
  let turn = 0

  const play = async m => {
    let role = ROLES[turn++ % 4]
    if (role === 'admin' && adminOk === false) role = 'master'
    const winA = rnd() < 0.55
    const wo = rnd() < 0.04
    const score = wo ? 'w.o' : SCORES[Math.floor(rnd() * SCORES.length)]
    const winner = winA ? m.team_a_id : m.team_b_id
    const shown = winA ? score : score.split(':').reverse().join(':')  // 점수는 A:B 기준으로 저장
    const sc = wo ? 'w.o' : shown
    let r
    if (role === 'player') {
      // 실제 화면처럼: 이긴 팀이 로그인해서 A:B 점수만 보냄 (winner id 안 보냄)
      const tid = winner
      const tok = await loginPlayer(tid)
      const lst = await rpc(anon, 'rpc_pin_list_matches', { p_token: tok })
      const seen = JSON.stringify(lst.data || '').includes(m.id)
      if (!seen) fails.push(`내 경기 목록에 ${m.match_num} 안 보임 (${lst.error || ''})`)
      r = await rpc(anon, 'rpc_pin_submit_score', { p_token: tok, p_match_id: m.id, p_score: sc })
      if (failed(r) && wo) { role = 'master'; r = null }   // 선수 화면엔 w.o 없음 → 운영본부 처리
      else if (failed(r)) { fails.push(`내 경기 입력 실패 ${m.match_num} ${m.court}#${m.court_order}: ${errText(r)}`); role = 'venue'; r = null }
    }
    if (!r && role === 'venue') {
      const v = venueOfCourt(m.court)
      r = await rpc(anon, 'rpc_venue_record_score', { p_token: L.venueTok[v.id], p_match_id: m.id, p_score: sc, p_winner_team_id: winner })
      if (failed(r)) { fails.push(`경기장 입력 실패 ${m.match_num} ${m.court}: ${errText(r)}`); role = 'master'; r = null }
    }
    if (!r && role === 'admin') {
      r = await rpc(svc, 'rpc_submit_match_result', { p_match_id: m.id, p_score: sc, p_winner_team_id: winner })
      if (adminOk === null) { adminOk = !failed(r); if (!adminOk) note('관리자 RPC(rpc_submit_match_result)는 서비스 키로 못 씀 → 관리자 몫은 마스터로 대신', errText(r)) }
      if (failed(r)) { if (adminOk) fails.push(`관리자 입력 실패 ${m.match_num}: ${errText(r)}`); role = 'master'; r = null }
    }
    if (!r && role === 'master') {
      r = await rpc(anon, 'rpc_admin_pin_update_score', { p_token: L.master, p_match_id: m.id, p_score: sc, p_winner_team_id: winner })
      if (failed(r)) { fails.push(`마스터 입력 실패 ${m.match_num}: ${errText(r)}`); return false }
    }
    roleCount[role]++
    const after = must(await svc.from('matches').select('status, winner_team_id, score').eq('id', m.id).single(), '확인')
    if (after.status !== 'FINISHED' || after.winner_team_id !== winner) { fails.push(`${m.match_num} 저장 후 상태 이상 ${JSON.stringify(after)}`); return false }
    return true
  }

  sec(`${label} — 경기 진행 (코트별 순서대로, 역할 번갈아)`)
  const startCourts = [...new Set((await mm()).filter(m => m.court).map(m => m.court))].sort()
  let rounds = 0, played = 0
  const conflicts = []
  const assignedLater = []
  for (; rounds < 400; rounds++) {
    const ms = await mm()
    const open = ms.filter(m => m.status !== 'FINISHED' && m.status !== 'BYE')
    if (!open.length) break
    // 코트마다 맨 앞 미완료 경기
    const heads = []
    for (const court of [...new Set(open.filter(m => m.court).map(m => m.court))]) {
      const h = open.filter(m => m.court === court).sort((a, b) => (a.court_order ?? 999) - (b.court_order ?? 999))[0]
      if (h.team_a_id && h.team_b_id) heads.push(h)
    }
    // 동시에 같은 팀이 두 코트에? (선수 겹침)
    const busy = {}
    for (const h of heads) for (const t of [h.team_a_id, h.team_b_id]) { if (busy[t]) conflicts.push(`${teams[t]?.team_name}: ${busy[t]} 와 ${h.court}#${h.court_order} 동시`); busy[t] = `${h.court}#${h.court_order}` }
    if (!heads.length) {
      // 코트 앞이 다 막힘 → 코트 없는 경기 중 양 팀 정해진 것 배정 (현장에서 마스터가 코트 지정)
      const ready = open.filter(m => !m.court && m.team_a_id && m.team_b_id)
      if (!ready.length) break
      const m = ready.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0]
      const load = court => open.filter(x => x.court === court).length
      const court = startCourts.slice().sort((a, b) => load(a) - load(b))[0]
      const v = venueOfCourt(court)
      const ord = Math.max(0, ...ms.filter(x => x.court === court).map(x => x.court_order || 0)) + 1
      const r = await rpc(anon, 'rpc_venue_admin_set_match_court', { p_token: L.openTok[v.id], p_match_id: m.id, p_court: court, p_court_order: ord })
      if (failed(r)) { check(false, `마스터 코트 배정 ${m.match_num}`, errText(r)); break }
      assignedLater.push(`${m.division_name} ${m.round} ${m.match_num}→${court}`)
      continue
    }
    for (const h of heads) if (await play(h)) played++
  }
  const end = await mm()
  // 자리 표시(N조 k위)는 채워지면 지워짐 → 원본 대회의 표시를 씀
  const srcLab = Object.fromEntries((await all('matches', 'event_id', SOURCES[label])).map(m => [c.map(m.id), m]))
  for (const m of end) { const o = srcLab[m.id]; if (o) { m.qualifier_label_a = o.qualifier_label_a; m.qualifier_label_b = o.qualifier_label_b } }
  const stuck = end.filter(m => m.status !== 'FINISHED' && m.status !== 'BYE')
  check(!fails.length, `점수 입력 실패 없음 (총 ${played}경기: 관리자 ${roleCount.admin} · 마스터 ${roleCount.master} · 경기장 ${roleCount.venue} · 내 경기 ${roleCount.player})`, fails.slice(0, 15))
  check(!conflicts.length, '같은 선수가 두 코트에 동시에 걸린 적 없음', conflicts.slice(0, 10))
  if (assignedLater.length) note(`코트 없던 경기 ${assignedLater.length}개는 진행 중 마스터가 코트 배정`, assignedLater)
  check(!stuck.length, `안 끝난 경기 없음 (${end.length}경기 중 ${stuck.length} 남음)`, stuck.map(m => `${m.division_name} ${m.round} ${m.match_num} ${m.status} ${m.court || '-'}#${m.court_order ?? '-'} A:${m.team_a_id ? 'O' : m.qualifier_label_a || 'x'} B:${m.team_b_id ? 'O' : m.qualifier_label_b || 'x'}`).slice(0, 30))

  sec(`${label} — 결과 검사`)
  const byDiv = {}
  for (const m of end) (byDiv[m.division_name] ||= []).push(m)
  for (const [dn, ms] of Object.entries(byDiv)) {
    const gm = ms.filter(m => m.stage === 'GROUP'), fm = ms.filter(m => m.stage === 'FINALS')
    // 조별 순위 (승수 → 숫자 점수 게임 득실)
    const rank = {}
    for (const g of [...new Set(gm.map(m => m.group_id))]) {
      const st = {}
      for (const m of gm.filter(x => x.group_id === g)) {
        for (const t of [m.team_a_id, m.team_b_id]) st[t] ||= { w: 0, d: 0 }
        if (m.winner_team_id) st[m.winner_team_id].w++
        const p = /^(\d+):(\d+)$/.exec(m.score || '')
        // 득실은 승자 기준 (내 경기 입력은 승자:패자, 나머지는 A:B 로 저장돼 섞여 있음 — DB 017 과 같은 방식)
        if (p && m.winner_team_id) { const hi = Math.max(+p[1], +p[2]), lo = Math.min(+p[1], +p[2]); const l = m.winner_team_id === m.team_a_id ? m.team_b_id : m.team_a_id; st[m.winner_team_id].d += hi - lo; st[l].d -= hi - lo }
      }
      rank[g] = st
    }
    // 3인조: 2번째 경기에 1번째 경기 승자 (trg_a0_group3_winner_next)
    for (const g of Object.keys(rank)) {
      const list = gm.filter(m => m.group_id === g)
      if (Object.keys(rank[g]).length === 3 && list.length === 3) {
        const o = list.slice().sort((a, b) => (a.court_order ?? a.slot) - (b.court_order ?? b.slot))
        const w1 = o[0].winner_team_id
        if (!(o[1].team_a_id === w1 || o[1].team_b_id === w1)) check(false, `${dn} ${groups[g]?.group_label}: 3인조 두 번째 경기에 첫 경기 승자 없음`)
      }
    }
    // 본선 자리: 'N조 k위' 로 들어간 팀이 그 조 순위와 맞는지
    const wrong = []
    for (const m of fm) for (const side of ['a', 'b']) {
      const lab = m[`qualifier_label_${side}`]; const t = m[`team_${side}_id`]
      const p = /^(\d+)조 (\d)위$/.exec(lab || ''); if (!p || !t) continue
      const g = Object.values(groups).find(x => x.division_id === m.division_id && (String(x.group_num) === p[1] || x.group_label === p[1] + '조' || x.group_label === p[1]))
      if (!g) { wrong.push(`${lab}: 조 못 찾음`); continue }
      const st = rank[g.id] || {}
      if (!st[t]) { wrong.push(`${m.match_num} ${lab}: 그 조 팀 아님 (${teams[t]?.team_name})`); continue }
      const better = Object.entries(st).filter(([x, s]) => x !== t && (s.w > st[t].w || (s.w === st[t].w && s.d > st[t].d))).length
      const same = Object.entries(st).filter(([x, s]) => x !== t && s.w === st[t].w && s.d === st[t].d).length
      const k = +p[2]
      if (!(better + 1 <= k && k <= better + 1 + same)) wrong.push(`${m.match_num} ${lab}=${teams[t]?.team_name} 실제 ${better + 1}위${same ? `(동률 ${same + 1})` : ''}`)
    }
    // 2명/3명 조 '시드 순위전' 은 승수 기준이 아닐 수 있으니 별도 표시
    const fin = fm.find(m => m.round === '결승')
    const leagueOnly = !fm.length
    const okFinal = leagueOnly ? gm.every(m => m.status === 'FINISHED') : (fin && fin.status === 'FINISHED' && fin.winner_team_id)
    check(okFinal, `${dn}: ${leagueOnly ? '풀리그 전 경기 끝' : '결승 끝, 우승 ' + (teams[fin?.winner_team_id]?.team_name || '?')}`, fin && { status: fin.status, a: fin.team_a_id, b: fin.team_b_id })
    check(!wrong.length, `${dn}: 본선 자리 = 조 순위 (${fm.length ? fm.filter(m => m.qualifier_label_a || m.qualifier_label_b).length + '자리 표시 경기' : '본선 없음'})`, wrong)
    const byeShown = fm.filter(m => m.status === 'BYE' || (m.status === 'FINISHED' && (!m.team_a_id || !m.team_b_id)))
    if (byeShown.length) note(`${dn}: 부전승 ${byeShown.length}경기 (${byeShown.map(m => m.round + ' ' + (m.score || m.status)).join(', ')})`)
    // 같은 팀이 한 라운드에 두 번?
    const dup = []
    for (const r of [...new Set(fm.map(m => m.round))]) { const seen = {}; for (const m of fm.filter(x => x.round === r)) for (const t of [m.team_a_id, m.team_b_id].filter(Boolean)) { if (seen[t]) dup.push(`${r} ${teams[t]?.team_name}`); seen[t] = 1 } }
    check(!dup.length, `${dn}: 본선 같은 라운드에 같은 팀 두 번 없음`, dup)
  }
  // 공개 화면 뷰
  const pub = await anon.from('v_matches_with_teams').select('id, status, score').eq('event_id', c.evId)
  check(!pub.error && pub.data.length === end.length, `공개 화면 목록(v_matches_with_teams) ${pub.data?.length}/${end.length}`, pub.error?.message)
  return { eventId: c.evId, master: '549999', venuePins: c.venues.map(v => [v.name, v.pin]) }
}

// ============================================================
// 단체전 (재성철강)
// ============================================================
const SETS = [[6, 2], [6, 4], [3, 6], [6, 5], [5, 6], [6, 1], [2, 6], [6, 3]]
async function team(label) {
  sec(`${label} — 복제`)
  const c = await cloneEvent(SOURCES[label], label)
  const L = await logins(c)
  const clubs = Object.fromEntries((await all('clubs', 'event_id', c.evId)).map(x => [x.id, x]))
  const members = {}
  for (const m of await all('club_members', 'club_id', Object.keys(clubs), 'member_order')) (members[m.club_id] ||= []).push(m)
  const divById = Object.fromEntries(c.divs.map(d => [d.id, d]))
  const tt = async () => all('ties', 'event_id', c.evId)
  const rubs = async tieId => (await svc.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number')).data || []
  // 코트 번호 ↔ 경기장 (경기장 생성 순서대로 1번부터)
  const courtList = c.venues.flatMap(v => (v.courts || []).map(n => ({ v, n })))
  const venueOfNum = n => courtList[n - 1]?.v
  const roleCount = { admin: 0, master: 0, venue: 0, captain: 0 }
  const fails = [], lineupFails = []
  let adminOk = null, turn = 0
  const capLogged = {}
  const blocked = { ko: 0, group: 0 }

  // 주장 로그인 + 내 경기 확인 + 오더 제출
  const submitLineup = async (tie, clubId) => {
    if (!capLogged[clubId]) {
      const r = await rpc(anon, 'rpc_captain_login', { p_event_id: c.evId, p_pin: c.clubPin[clubId] })
      if (failed(r)) lineupFails.push(`주장 로그인 ${clubs[clubId].name}: ${errText(r)}`)
      capLogged[clubId] = true
    }
    const view = await rpc(anon, 'rpc_captain_tie', { p_pin: c.clubPin[clubId], p_tie_id: tie.id })
    if (failed(view)) lineupFails.push(`주장 대전 화면 ${clubs[clubId].name} #${tie.tie_order}: ${errText(view)}`)
    const n = tie.rubber_count || 3
    const ms = members[clubId] || []
    const div = divById[tie.division_id]
    // 여성부·혼복 고려: 성별 섞지 않고 순서대로 2명씩 (선수 중복 없이)
    const pool = ms.slice()
    const ls = []
    for (let k = 1; k <= n; k++) {
      const p1 = pool.shift(), p2 = pool.shift()
      ls.push({ rubber_number: k, player1_id: p1?.id || null, player2_id: p2?.id || null })
    }
    let r = await rpc(anon, 'rpc_submit_lineup', { p_tie_id: tie.id, p_club_id: clubId, p_captain_pin: c.clubPin[clubId], p_lineups: ls })
    if (failed(r)) lineupFails.push(`오더 제출 ${div?.name} ${clubs[clubId].name}(${ms.length}명) #${tie.tie_order}: ${errText(r)}`)
    return !failed(r)
  }
  const score = async (tie, r, a, b) => {
    const decided = x => /이미 승부가 결정/.test(errText(x))
    const isKO = !['group', 'full_league'].includes(tie.round)
    let role = ['captain', 'venue', 'master', 'admin'][turn++ % 4]
    if (role === 'admin' && adminOk === false) role = 'master'
    const S = { p_rubber_id: r.id, p_set1_a: a, p_set1_b: b, p_set2_a: null, p_set2_b: null, p_set3_a: null, p_set3_b: null }
    let x = null
    if (role === 'captain') {
      x = await rpc(anon, 'rpc_captain_record_score', { ...S, p_tie_id: tie.id, p_pin: c.clubPin[rnd() < 0.5 ? tie.club_a_id : tie.club_b_id] })
      if (failed(x) && decided(x)) { blocked[isKO ? 'ko' : 'group']++; return { ok: false, decided: true } }
      if (failed(x)) { fails.push(`주장 입력 실패 #${tie.tie_order} ${r.rubber_number}복식: ${errText(x)}`); role = 'venue'; x = null }
    }
    if (!x && role === 'venue') {
      const v = venueOfNum(tie.court_number)
      x = await rpc(anon, 'rpc_venue_rubber_score', { ...S, p_token: L.venueTok[v?.id] })
      if (failed(x) && decided(x)) { blocked[isKO ? 'ko' : 'group']++; return { ok: false, decided: true } }
      if (failed(x)) { fails.push(`경기장 입력 실패 #${tie.tie_order} ${r.rubber_number}복식 (코트 ${tie.court_number}): ${errText(x)}`); role = 'master'; x = null }
    }
    if (!x && role === 'admin') {
      x = await rpc(svc, 'rpc_admin_record_score', S)
      if (adminOk === null) { adminOk = !failed(x); if (!adminOk) note('관리자 RPC(rpc_admin_record_score)는 서비스 키로 못 씀 → 관리자 몫은 마스터로 대신', errText(x)) }
      if (failed(x) && decided(x)) { blocked[isKO ? 'ko' : 'group']++; return { ok: false, decided: true } }
      if (failed(x)) { if (adminOk) fails.push(`관리자 입력 실패 #${tie.tie_order}: ${errText(x)}`); role = 'master'; x = null }
    }
    if (!x && role === 'master') {
      x = await rpc(anon, 'rpc_admin_pin_rubber_score', { ...S, p_token: L.master })
      if (failed(x) && decided(x)) { blocked[isKO ? 'ko' : 'group']++; return { ok: false, decided: true } }
      if (failed(x)) { fails.push(`마스터 입력 실패 #${tie.tie_order} ${r.rubber_number}복식: ${errText(x)}`); return { ok: false, err: errText(x) } }
    }
    roleCount[role]++
    return { ok: true }
  }

  const playTie = async tie => {
    const d = divById[tie.division_id]
    if (!tie.lineup_revealed) {
      if (!tie.club_a_lineup_submitted) await submitLineup(tie, tie.club_a_id)
      if (!tie.club_b_lineup_submitted) await submitLineup(tie, tie.club_b_id)
    }
    const t2 = must(await svc.from('ties').select('*').eq('id', tie.id).single(), '대전')
    if (!t2.lineup_revealed) { fails.push(`#${tie.tie_order} ${d?.name}: 오더 공개 안 됨`); return false }
    const knockout = !['group', 'full_league'].includes(tie.round)
    for (const r of await rubs(tie.id)) {
      if (r.status === 'completed') continue
      const now = must(await svc.from('ties').select('status').eq('id', tie.id).single(), '대전')
      const [a, b] = SETS[Math.floor(rnd() * SETS.length)]
      const res = await score(tie, r, a, b)
      if (!res.ok && knockout && now.status === 'completed') continue // 승부 난 뒤 남은 복식 막힘 = 정상
    }
    const done = must(await svc.from('ties').select('status, winning_club_id, club_a_rubbers_won, club_b_rubbers_won').eq('id', tie.id).single(), '대전 결과')
    if (done.status !== 'completed' || !done.winning_club_id) { fails.push(`#${tie.tie_order} ${d?.name} ${tie.round}: 다 넣었는데 완료 안 됨 ${JSON.stringify(done)}`); return false }
    return true
  }

  sec(`${label} — 대전 진행 (코트별 순서대로, 역할 번갈아)`)
  let played = 0, rankSet = []
  const assignedLater = [], conflicts = []
  // 날짜별로 (부서 경기일) — 그날 부서의 대전만 코트 순서대로
  const days = [...new Set(c.divs.map(d => d.match_date || ''))].sort()
  for (const day of days) for (let round = 0; round < 500; round++) {
    const ts = (await tt()).filter(t => (divById[t.division_id]?.match_date || '') === day)
    const open = ts.filter(t => t.status !== 'completed' && !t.is_bye)
    if (!open.length) break
    const heads = []
    for (const n of [...new Set(open.filter(t => t.court_number).map(t => t.court_number))]) {
      const h = open.filter(t => t.court_number === n).sort((a, b) => (a.court_order ?? 999) - (b.court_order ?? 999))[0]
      if (h.club_a_id && h.club_b_id) heads.push(h)
    }
    const busy = {}
    for (const h of heads) for (const cl of [h.club_a_id, h.club_b_id]) { if (busy[cl]) conflicts.push(`${clubs[cl]?.name}: 코트 ${busy[cl]} 와 ${h.court_number} 동시`); busy[cl] = h.court_number }
    if (!heads.length) {
      // 조 순위 동률로 자리가 안 채워졌나? → 마스터가 순위 지정
      const st = await all('team_standings', 'event_id', c.evId)
      const groupsDone = new Set(ts.filter(t => t.round === 'group').map(t => t.group_id).filter(g => ts.filter(t => t.group_id === g).every(t => t.status === 'completed')))
      const unr = st.filter(s => groupsDone.has(s.group_id) && s.rank === null)
      if (unr.length) {
        for (const g of [...new Set(unr.map(s => s.group_id))]) {
          const gs = st.filter(s => s.group_id === g).sort((a, b) => (b.won - a.won) || (b.rubber_diff - a.rubber_diff))
          const taken = new Set(gs.filter(s => s.rank !== null).map(s => s.rank))
          let k = 1
          for (const s of gs.filter(s => s.rank === null)) { while (taken.has(k)) k++; const r = await rpc(anon, 'rpc_admin_pin_set_manual_rank', { p_token: L.master, p_club_id: s.club_id, p_rank: k }); taken.add(k)
            if (failed(r)) check(false, `마스터 동률 순위 지정 ${clubs[s.club_id]?.name}`, errText(r)); else rankSet.push(`${divById[ts.find(t => t.group_id === g)?.division_id]?.name} ${clubs[s.club_id]?.name}→${k}위`) }
        }
        continue
      }
      const ready = open.filter(t => !t.court_number && t.club_a_id && t.club_b_id)
      if (!ready.length) break
      const t = ready.sort((a, b) => a.tie_order - b.tie_order)[0]
      // 그 부서가 쓰던 코트 중 남은 대전 적은 곳
      const used = [...new Set(ts.filter(x => x.division_id === t.division_id && x.court_number).map(x => x.court_number))]
      const cand = (used.length ? used : courtList.map((_, i) => i + 1))
      const load = n => open.filter(x => x.court_number === n).length
      const n = cand.slice().sort((a, b) => load(a) - load(b) || a - b)[0]
      const v = venueOfNum(n)
      const ord = Math.max(0, ...ts.filter(x => x.court_number === n).map(x => x.court_order || 0)) + 1
      const r = await rpc(anon, 'rpc_venue_admin_assign_tie_court', { p_token: L.openTok[v.id], p_tie_id: t.id, p_court_number: n, p_court_order: ord })
      if (failed(r)) { check(false, `마스터 대전 코트 배정 #${t.tie_order}`, errText(r)); break }
      assignedLater.push(`${divById[t.division_id]?.name} ${t.round} #${t.tie_order}→${courtList[n - 1]?.n}`)
      continue
    }
    for (const h of heads) if (await playTie(h)) played++
  }
  const end = await tt()
  const srcT = Object.fromEntries((await all('ties', 'event_id', SOURCES[label])).map(t => [c.map(t.id), t]))
  for (const t of end) { const o = srcT[t.id]; if (o) { t.qualifier_label_a ||= o.qualifier_label_a; t.qualifier_label_b ||= o.qualifier_label_b } }
  const stuck = end.filter(t => t.status !== 'completed' && !t.is_bye)
  check(!lineupFails.length, '주장 로그인 · 대전 화면 · 오더 제출 모두 성공', lineupFails.slice(0, 15))
  check(!fails.length, `점수 입력 실패 없음 (${played}대전: 관리자 ${roleCount.admin} · 마스터 ${roleCount.master} · 경기장 ${roleCount.venue} · 주장(내 경기) ${roleCount.captain} 복식)`, fails.slice(0, 15))
  note(`승부 결정 뒤 남은 복식 입력 막힘: 토너먼트 ${blocked.ko}건 · 조별/리그 ${blocked.group}건`)
  check(!conflicts.length, '같은 클럽이 두 코트에 동시에 걸린 적 없음', conflicts.slice(0, 10))
  if (assignedLater.length) note(`코트 없던 대전 ${assignedLater.length}개는 진행 중 마스터가 코트 배정`, assignedLater)
  if (rankSet.length) note(`조 순위 동률 → 마스터 PIN 으로 순위 지정 ${rankSet.length}건`, rankSet)
  check(!stuck.length, `안 끝난 대전 없음 (${end.length}대전 중 ${stuck.length} 남음)`, stuck.map(t => `${divById[t.division_id]?.name} ${t.round} #${t.tie_order} ${t.status} 코트${t.court_number ?? '-'} A:${t.club_a_id ? 'O' : t.qualifier_label_a || 'x'} B:${t.club_b_id ? 'O' : t.qualifier_label_b || 'x'}`).slice(0, 30))

  sec(`${label} — 결과 검사`)
  const st = await all('team_standings', 'event_id', c.evId)
  for (const d of c.divs) {
    const ts = end.filter(t => t.division_id === d.id)
    const ko = ts.filter(t => !['group', 'full_league'].includes(t.round))
    if (!ko.length) {
      // 풀리그: 순위 계산
      const lg = ts.filter(t => t.round === 'full_league')
      const w = {}; for (const t of lg) if (t.winning_club_id) w[t.winning_club_id] = (w[t.winning_club_id] || 0) + 1
      check(lg.length && lg.every(t => t.status === 'completed'), `${d.name}: 풀리그 ${lg.length}대전 끝 (${Object.entries(w).map(([k, v]) => clubs[k]?.name + ' ' + v + '승').join(', ')})`)
      continue
    }
    const fin = ko.find(t => t.round === 'final')
    check(fin?.status === 'completed' && fin.winning_club_id, `${d.name}: 결승 끝, 우승 ${clubs[fin?.winning_club_id]?.name || '?'}`, fin && [fin.status, fin.qualifier_label_a, fin.qualifier_label_b])
    // 토너먼트 자리 = 조 순위
    const wrong = []
    for (const t of ko) for (const side of ['a', 'b']) {
      const lab = t[`qualifier_label_${side}`], cl = t[`club_${side}_id`]
      const p = /(\S+)조 (\d)위/.exec(lab || ''); if (!p || !cl) continue
      const s = st.find(x => x.club_id === cl)
      if (!s) { wrong.push(`#${t.tie_order} ${lab}: 순위표에 없음`); continue }
      if (s.rank !== +p[2]) wrong.push(`#${t.tie_order} ${lab} = ${clubs[cl]?.name} (순위표 ${s.rank}위)`)
    }
    check(!wrong.length, `${d.name}: 토너먼트 자리 = 조 순위 (${ko.length}대전)`, wrong)
    // 라운드 내 중복 클럽
    const dup = []
    for (const r of [...new Set(ko.map(t => t.round))]) { const seen = {}; for (const t of ko.filter(x => x.round === r)) for (const cl of [t.club_a_id, t.club_b_id].filter(Boolean)) { if (seen[cl]) dup.push(`${r} ${clubs[cl]?.name}`); seen[cl] = 1 } }
    check(!dup.length, `${d.name}: 같은 라운드에 같은 클럽 두 번 없음`, dup)
    // 조별: 순위 다 매겨졌나
    const gIds = [...new Set(ts.filter(t => t.round === 'group').map(t => t.group_id))]
    const noRank = st.filter(s => gIds.includes(s.group_id) && s.rank === null)
    check(!noRank.length, `${d.name}: 조 순위 모두 확정 (${gIds.length}조)`, noRank.map(s => clubs[s.club_id]?.name))
  }
  // 결과 합계 = 복식 승수
  const bad = []
  for (const t of end.filter(t => t.status === 'completed')) {
    const rs = await rubs(t.id)
    const a = rs.filter(r => r.winning_club_id === t.club_a_id).length, b = rs.filter(r => r.winning_club_id === t.club_b_id).length
    if (a !== t.club_a_rubbers_won || b !== t.club_b_rubbers_won || t.winning_club_id !== (a > b ? t.club_a_id : t.club_b_id)) bad.push(`#${t.tie_order} ${t.club_a_rubbers_won}:${t.club_b_rubbers_won} vs 복식 ${a}:${b}`)
  }
  check(!bad.length, '모든 대전 결과 = 복식 승수와 일치', bad.slice(0, 10))
  return { eventId: c.evId, master: '549999', venuePins: c.venues.map(v => [v.name, v.pin]) }
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'cleanup') return cleanup()
  if (mode === 'seed') {
    // 복제만 하고 진행은 안 함 (화면 확인용) — node scripts/sim-real-events.mjs seed 재성
    await cleanup()
    const label = process.argv[3] || '재성'
    const c = await cloneEvent(SOURCES[label], label)
    const L = await logins(c)
    writeFileSync(STATE, JSON.stringify({ [label]: { eventId: c.evId, master: '549999', venues: c.venues.map(v => ({ id: v.id, name: v.name, pin: v.pin, token: L.venueTok[v.id] })) } }, null, 2))
    console.log('상태 저장:', STATE)
    return
  }
  if (mode === 'probe') {
    // 내 경기(선수 PIN) 점수 방향 확인: 로그인 팀(A/B) × 보내는 점수 × winner_id 유무
    await cleanup()
    const c = await cloneEvent(SOURCES.이음, '이음_probe')
    await logins(c)
    const ms = await all('matches', 'event_id', c.evId)
    const heads = []
    for (const court of [...new Set(ms.filter(m => m.court).map(m => m.court))].sort()) {
      const h = ms.filter(m => m.court === court && m.stage === 'GROUP').sort((a, b) => a.court_order - b.court_order)[0]
      if (h?.team_a_id && h.team_b_id) heads.push(h)
    }
    const cases = [['A', '6:3', null], ['B', '3:6', null], ['B', '6:3', null], ['A', '3:6', null], ['A', '6:3', 'B'], ['B', '3:6', 'A']]
    for (const [i, [who, sc, wid]] of cases.entries()) {
      const m = heads[i]; if (!m) break
      const tid = who === 'A' ? m.team_a_id : m.team_b_id
      const tok = (await rpc(anon, 'rpc_pin_login', { p_pin_code: c.teamPin[tid], p_event_id: c.evId })).data?.token
      const args = { p_token: tok, p_match_id: m.id, p_score: sc }
      if (wid) args.p_winner_id = wid === 'A' ? m.team_a_id : m.team_b_id
      const r = await rpc(anon, 'rpc_pin_submit_score', args)
      const a = must(await svc.from('matches').select('score, winner_team_id, status').eq('id', m.id).single(), 'x')
      console.log(`로그인 ${who} · 보냄 ${sc}${wid ? ' winner=' + wid : ''} → ${failed(r) ? '거절: ' + errText(r) : '저장 ' + a.score + ' 승자 ' + (a.winner_team_id === m.team_a_id ? 'A' : a.winner_team_id === m.team_b_id ? 'B' : '-')}`)
    }
    return
  }
  if (mode !== 'run') { console.log('usage: run [이음|재성] | cleanup'); return }
  const only = process.argv[3]
  await cleanup()
  const state = {}
  if (!only || only === '이음') { try { state.이음 = await individual('이음') } catch (e) { check(false, '이음 중단: ' + e.message); console.error(e) } }
  if (!only || only === '재성') { try { state.재성 = await team('재성') } catch (e) { check(false, '재성 중단: ' + e.message); console.error(e) } }
  writeFileSync(STATE, JSON.stringify(state, null, 2))
  const fail = results.filter(r => !r.ok)
  console.log(`\n══════ 결과: ${results.filter(r => !r.note).length - fail.length}/${results.filter(r => !r.note).length} 통과 ══════`)
  for (const f of fail) console.log(`FAIL [${f.section}] ${f.label}`)
  writeFileSync(STATE.replace(/\.json$/, '-results.json'), JSON.stringify(results, null, 2))
}
main().catch(e => { console.error('❌', e); process.exit(1) })
