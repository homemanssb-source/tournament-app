// ============================================================
// 빈 코트 자동 이어 배정(026·027) 실서버 시뮬레이션
//   node scripts/sim-auto-court.mjs run       → 테스트 대회 만들고 시나리오 진행 + 검사 (대회는 남겨 둠 — 화면 확인용)
//   node scripts/sim-auto-court.mjs seed      → 테스트 대회 준비만 (경기 전부 미배정, ④ 꺼짐) — 관리자 화면 확인용
//   node scripts/sim-auto-court.mjs cleanup   → '__TEST_SIM_자동배정_' 대회 전부 삭제
// 준비(대회·팀·코트 배정)는 service_role, 점수 입력은 anon 키 + 마스터 PIN 토큰(실제 현장과 같은 경로).
// 알림 선점(auto_notified_at)은 배포된 /api/notify/court 를 경기장 토큰으로 호출해 확인 (테스트 팀은 구독 없음 → 실제 푸시 없음).
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
let env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8'); if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1)
env.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const anon = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const SITE = process.env.SIM_SITE || 'https://jeju-tournament.vercel.app'
const PREFIX = '__TEST_SIM_자동배정_'
const STATE = process.env.SIM_STATE || join(__dirname, '..', '.sim-state-auto-court.json')
const DATE = '2026-01-10'

// ── 결과 기록 ──
const results = []
let section = ''
const sec = t => { section = t; console.log(`\n━━━ ${t} ━━━`) }
const check = (cond, label, detail) => {
  results.push({ section, ok: !!cond, label, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && !cond ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data }
const rpcA = async (fn, args) => { const r = await anon.rpc(fn, args); return { data: r.data, error: r.error?.message || null } }
const failed = r => !!r.error || r.data?.success === false
const errText = r => r.error || r.data?.error || ''

// ── 정리 (sim-onsite-ops 와 같은 순서) ──
async function deleteEvent(eventId) {
  const ids = async (t, col = 'event_id') => ((await svc.from(t).select('id').eq(col, eventId)).data || []).map(r => r.id)
  const matchIds = await ids('matches'), teamIds = await ids('teams'), venueIds = await ids('venues'), groupIds = await ids('groups')
  const del = (t, col, vals) => vals.length ? svc.from(t).delete().in(col, vals) : null
  const ops = [
    del('push_subscriptions', 'team_id', teamIds),
    del('group_members', 'group_id', groupIds), del('bracket_nodes', 'match_id', matchIds),
    () => svc.from('push_logs').delete().eq('event_id', eventId),
    () => svc.from('audit_log').delete().eq('event_id', eventId),
    () => svc.from('admin_pin_sessions').delete().eq('event_id', eventId),
    () => svc.from('venue_sessions').delete().eq('event_id', eventId),
    () => svc.from('pin_sessions').delete().eq('event_id', eventId),
    () => svc.from('matches').delete().eq('event_id', eventId),
    () => svc.from('groups').delete().eq('event_id', eventId),
    del('venue_pins', 'venue_id', venueIds),
    () => svc.from('venues').delete().eq('event_id', eventId),
    del('team_pins', 'team_id', teamIds),
    () => svc.from('teams').delete().eq('event_id', eventId),
    () => svc.from('group_settings').delete().eq('event_id', eventId),
    () => svc.from('divisions').delete().eq('event_id', eventId),
    () => svc.from('event_secrets').delete().eq('event_id', eventId),
    () => svc.from('operator_events').delete().eq('event_id', eventId),
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

// ── 준비 도우미 ──
async function makeEvent() {
  const { data: tmpl } = await svc.from('events').select('*').eq('event_type', 'individual').limit(1).single()
  const row = { ...tmpl }
  for (const k of ['id', 'created_at', 'updated_at']) delete row[k]
  Object.assign(row, { name: PREFIX + '개인전', event_key: 'sim-auto-court-' + Date.now(), status: 'active', date: DATE,
    auto_fill_courts: false, auto_steal_courts: false, court_zones: null })
  for (const k of ['master_pin_hash', 'app_a_event_id']) if (k in row) row[k] = null
  if ('app_a_connected' in row) row.app_a_connected = false
  return must(await svc.from('events').insert(row).select().single(), '대회 생성')
}
async function makeTeams(ev, div, defs, pinBase) {
  return must(await svc.from('teams').insert(defs.map((d, i) => ({
    event_id: ev.id, division_id: div.id, division_name: div.name, team_num: `${div.name.slice(0, 2)}-${i + 1}`,
    team_key: `${div.id}|${d.p1}|${d.p2 || ''}`,
    team_name: d.p2 ? `${d.p1}(${d.c1})/${d.p2}(${d.c2})` : `${d.p1}(${d.c1})`,
    player1_name: d.p1, p1_club: d.c1, player2_name: d.p2 || '', p2_club: d.c2 || '',
    pin_plain: String(pinBase + i),
  }))).select(), '팀 ' + div.name)
}
const setFlags = (eventId, fill, steal) => svc.from('events').update({ auto_fill_courts: fill, auto_steal_courts: steal }).eq('id', eventId)
const place = (id, court, order) => svc.from('matches').update({ court, court_order: order }).eq('id', id)

async function run(state, seedOnly = false) {
  sec('준비')
  const ev = await makeEvent()
  const D1 = must(await svc.from('divisions').insert({ event_id: ev.id, name: '복식부', sort_order: 1, match_date: DATE }).select().single(), '부서1')
  const D2 = must(await svc.from('divisions').insert({ event_id: ev.id, name: '학생단식', sort_order: 2, match_date: DATE }).select().single(), '부서2')
  for (const d of [D1, D2]) await svc.from('group_settings').insert({ event_id: ev.id, division_id: d.id, division_name: d.name, teams_per_group: d === D1 ? 4 : 3, advance_count: 2, random_assign: false })
  const t1 = await makeTeams(ev, D1, Array.from({ length: 8 }, (_, i) => ({ p1: `복${i + 1}가`, c1: `클럽${i + 1}`, p2: `복${i + 1}나`, c2: `클럽${i + 1}` })), 7410001)
  const t2 = await makeTeams(ev, D2, Array.from({ length: 6 }, (_, i) => ({ p1: `단${i + 1}`, c1: `학교${i + 1}` })), 7410101)
  // 경기장 2곳: S(S-1~S-4), J(J-1~J-2)
  must(await svc.from('venues').insert([
    { event_id: ev.id, name: '시뮬S경기장', short_name: 'S', court_count: 4, courts: ['S-1', 'S-2', 'S-3', 'S-4'], pin_plain: '741901', manager_name: 'S 관리자', created_at: new Date().toISOString() },
    { event_id: ev.id, name: '시뮬J경기장', short_name: 'J', court_count: 2, courts: ['J-1', 'J-2'], pin_plain: '741902', manager_name: 'J 관리자', created_at: new Date(Date.now() + 1000).toISOString() },
  ]).select(), '경기장')
  must(await svc.rpc('rpc_set_master_pin', { p_event_id: ev.id, p_new_pin: '7418888' }), '마스터 PIN')
  for (const [d, size] of [[D1, 4], [D2, 3]]) {
    must(await svc.rpc('rpc_generate_groups', { p_event_id: ev.id, p_division_id: d.id, p_group_size: size }), '조편성 ' + d.name)
    must(await svc.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: d.id }), '조별 경기 ' + d.name)
  }
  const groups = must(await svc.from('groups').select('id, group_label, group_num, division_id').eq('event_id', ev.id).order('group_num'), '조')
  const G = groups.filter(g => g.division_id === D1.id), H = groups.filter(g => g.division_id === D2.id)
  const all = async () => must(await svc.from('matches').select('*').eq('event_id', ev.id).order('slot'), '경기')
  const byGroup = async gid => (await all()).filter(m => m.group_id === gid)
  const get = async id => (await svc.from('matches').select('*').eq('id', id).single()).data
  const autoRows = async () => (await all()).filter(m => m.auto_assigned_at)
  check(G.length === 2 && H.length === 2, `조편성: 복식부 ${G.length}조 · 학생단식 ${H.length}조`)
  check((await byGroup(G[0].id)).length === 6 && (await byGroup(H[0].id)).length === 3, '조별 경기: 4팀 조 6경기 · 3팀 조 3경기')
  state.eventId = ev.id; state.master = '7418888'; state.venuePins = { S: '741901', J: '741902' }
  if (seedOnly) return

  const login = await rpcA('rpc_admin_pin_login', { p_master_pin: '7418888', p_event_id: ev.id })
  check(!failed(login) && login.data?.token, '마스터 PIN 로그인', errText(login))
  const A = login.data.token
  const finish = async (m, winner = m.team_a_id) => {
    const r = await rpcA('rpc_admin_pin_update_score', { p_token: A, p_match_id: m.id, p_score: '6:2', p_winner_team_id: winner })
    if (failed(r)) throw new Error(`점수 입력 ${m.match_num}: ${errText(r)}`)
  }

  // 배정: 복식 1조 6경기 → S-1, 복식 2조 앞 2경기 → S-2 (나머지 4경기 미배정), 단식 1조 3경기 → S-3, 단식 2조 미배정
  const g1 = await byGroup(G[0].id), g2 = await byGroup(G[1].id), h1 = await byGroup(H[0].id)
  for (const [i, m] of g1.entries()) await place(m.id, 'S-1', i + 1)
  for (const [i, m] of g2.slice(0, 2).entries()) await place(m.id, 'S-2', i + 1)
  for (const [i, m] of h1.entries()) await place(m.id, 'S-3', i + 1)
  must(await setFlags(ev.id, true, false), '자동 이어 배정 켜기')

  sec('① 코트에 대기 경기가 있으면 기존 "다음 경기 자동 시작"만')
  await finish(g1[0])
  check((await get(g1[1].id)).status === 'IN_PROGRESS', 'S-1 다음 경기 자동 시작')
  check((await autoRows()).length === 0, '자동 이어 배정은 동작 안 함 (대기 경기 있음)')

  sec('② 빈 코트 → 같은 조 경기를 데려와 바로 시작, 방금 끝낸 팀은 뒤로')
  await finish(g2[0])
  check((await get(g2[1].id)).status === 'IN_PROGRESS', 'S-2 두 번째 경기 자동 시작')
  const justDone = [g2[1].team_a_id, g2[1].team_b_id]
  await finish(g2[1])
  let auto = await autoRows()
  const pulled2 = auto[0]
  check(auto.length === 1 && pulled2?.court === 'S-2' && pulled2.status === 'IN_PROGRESS', 'S-2 가 비자 미배정 경기 1개를 데려와 바로 시작',
    auto.map(m => [m.match_num, m.court, m.status]))
  check(pulled2?.group_id === G[1].id, '데려온 경기 = 같은 조(복식 2조)', pulled2 && pulled2.group_id)
  check(pulled2 && !justDone.includes(pulled2.team_a_id) && !justDone.includes(pulled2.team_b_id), '방금 끝낸 두 팀이 없는 경기를 먼저 데려옴',
    pulled2 && [pulled2.team_a_id, pulled2.team_b_id, justDone])
  check(pulled2?.court_order === 3, `코트 순번 이어 붙임 (S-2 3번째, 실제 ${pulled2?.court_order})`)
  const log2 = (await svc.from('audit_log').select('action, target_id, details').eq('event_id', ev.id).eq('action', 'auto_court_fill')).data || []
  check(log2.length === 1 && log2[0].target_id === pulled2?.id && log2[0].details?.mode === 'fill', '감사 로그 auto_court_fill (mode=fill)', log2)

  sec('③ 학생 단식+복식: 다른 코트에서 경기 중인 선수의 경기는 안 데려옴 (027)')
  // S-1 에서 경기 중인 복식팀의 '가' 선수를, 아직 미배정인 단식 2조의 첫 팀 선수로 (같은 이름·같은 소속 = 같은 사람)
  const live = await get(g1[1].id)
  const liveTeam = t1.find(t => t.id === live.team_a_id)
  const h2 = await byGroup(H[1].id)
  const h2Teams = [...new Set(h2.flatMap(m => [m.team_a_id, m.team_b_id]))]
  const xTeam = h2Teams[0]
  must(await svc.from('teams').update({ player1_name: liveTeam.player1_name, p1_club: liveTeam.p1_club, team_name: `${liveTeam.player1_name}(${liveTeam.p1_club})` }).eq('id', xTeam), '겹치는 선수 만들기')
  const xMatches = h2.filter(m => m.team_a_id === xTeam || m.team_b_id === xTeam).map(m => m.id)
  const okMatch = h2.find(m => !xMatches.includes(m.id))
  // S-3 단식 1조 3경기를 끝내면 S-3 이 비고, 같은 부서(단식 2조)에서 데려와야 함
  await finish(h1[0]); await finish(h1[1]); await finish(h1[2])
  auto = await autoRows()
  const pulled3 = auto.find(m => m.court === 'S-3')
  check(!!pulled3 && pulled3.status === 'IN_PROGRESS', 'S-3 가 비자 경기를 데려와 시작', auto.map(m => [m.match_num, m.court]))
  check(pulled3?.id === okMatch.id, `같은 부서(단식 2조) 중 ${liveTeam.player1_name}(${liveTeam.p1_club}) 없는 경기를 데려옴`,
    pulled3 && { pulled: pulled3.match_num, expected: okMatch.match_num })
  check(xMatches.every(id => auto.every(m => m.id !== id)), `${liveTeam.player1_name} 의 단식 경기 2개는 그대로 미배정`)

  sec('④ 스위치 꺼짐 → 아무것도 안 함')
  must(await setFlags(ev.id, false, false), '끄기')
  const before4 = (await autoRows()).length
  await finish(await get(pulled2.id))   // S-2 마지막 경기 → S-2 비게 됨
  check((await autoRows()).length === before4, '꺼져 있으면 빈 코트가 생겨도 데려오지 않음')
  check((await all()).filter(m => m.court === 'S-2' && m.status !== 'FINISHED').length === 0, 'S-2 는 빈 채로 남음')

  sec('⑤ 밀린 코트 경기 가져오기 (같은 경기장만)')
  must(await setFlags(ev.id, true, true), '켜기 + 가져오기')
  // 남은 미배정 경기를 J 경기장에 모두 배정 → 데려올 미배정 경기가 없게
  const rest = (await all()).filter(m => !m.court && m.status === 'PENDING')
  const g2rest = rest.filter(m => m.group_id === G[1].id), h2rest = rest.filter(m => m.group_id === H[1].id)
  check(g2rest.length === 3 && h2rest.length === 2, `남은 미배정: 복식 2조 ${g2rest.length} · 단식 2조 ${h2rest.length}`)
  const j1 = [...h2rest, g2rest[0]]            // J-1: 대기 3경기 (맨 뒤 = 복식 경기)
  const j2 = g2rest.slice(1)                   // J-2: 2경기
  for (const [i, m] of j1.entries()) await place(m.id, 'J-1', i + 1)
  for (const [i, m] of j2.entries()) await place(m.id, 'J-2', i + 1)
  const s1Pending = (await all()).filter(m => m.court === 'S-1' && m.status === 'PENDING').length
  check(s1Pending > j1.length, `S-1 대기(${s1Pending})가 J-1 대기(${j1.length})보다 많음 — 다른 경기장이라 가져오면 안 됨`)
  await finish(j2[0])
  check((await get(j2[1].id)).status === 'IN_PROGRESS', 'J-2 두 번째 경기 자동 시작')
  const justDone5 = [j2[1].team_a_id, j2[1].team_b_id]
  await finish(j2[1])
  const stolen = await get(j1[2].id)
  check(stolen.court === 'J-2' && stolen.status === 'IN_PROGRESS' && stolen.auto_assigned_at, 'J-1 맨 뒤 경기를 J-2 로 가져와 시작', [stolen.court, stolen.status])
  check((await all()).filter(m => m.court === 'S-1' && m.status === 'PENDING').length === s1Pending, '다른 경기장(S-1) 경기는 그대로')
  check((await get(j1[0].id)).court === 'J-1' && (await get(j1[1].id)).court === 'J-1', 'J-1 앞쪽 경기는 그대로')
  const log5 = (await svc.from('audit_log').select('details').eq('event_id', ev.id).eq('action', 'auto_court_fill').eq('target_id', stolen.id)).data || []
  check(log5[0]?.details?.mode === 'steal' && log5[0]?.details?.from_court === 'J-1', '감사 로그 mode=steal, from J-1', log5)
  void justDone5

  sec('⑥ 선수 알림: 자동 배정된 경기 두 팀에 1회 (배포된 API)')
  const vl = await rpcA('rpc_venue_login', { p_pin_code: '741901', p_event_id: ev.id })
  check(!failed(vl) && vl.data?.token, '경기장 PIN 로그인 (알림 API 호출용)', errText(vl))
  const call = async () => {
    const res = await fetch(`${SITE}/api/notify/court`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: ev.id, court: 'S-3', trigger: 'finished', venue_token: vl.data.token }) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const r1 = await call()
  check(r1.status === 200, `알림 API 응답 200 (${r1.status})`, r1.body)
  const liveAuto = (await autoRows()).filter(m => m.status === 'IN_PROGRESS')
  check(liveAuto.length === 2 && liveAuto.every(m => m.auto_notified_at), `진행 중인 자동 배정 경기 ${liveAuto.length}개 모두 알림 처리 표시`, liveAuto.map(m => [m.match_num, m.auto_notified_at]))
  const stamps = Object.fromEntries(liveAuto.map(m => [m.id, m.auto_notified_at]))
  await call()
  const again = (await autoRows()).filter(m => m.status === 'IN_PROGRESS')
  check(again.every(m => m.auto_notified_at === stamps[m.id]), '다시 호출해도 중복 알림 없음 (처리 시각 그대로)')
  const finishedAuto = (await autoRows()).filter(m => m.status === 'FINISHED')
  check(finishedAuto.every(m => !m.auto_notified_at), '이미 끝난 자동 배정 경기는 알림 대상 아님')

  state.tokens = { admin: A, venueS: vl.data.token }
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'cleanup') return cleanup()
  if (mode !== 'run' && mode !== 'seed') { console.log('usage: run | seed | cleanup'); return }
  await cleanup()
  const state = {}
  try { await run(state, mode === 'seed') } catch (e) { check(false, '중단: ' + e.message) }
  writeFileSync(STATE, JSON.stringify(state, null, 2))
  const fail = results.filter(r => !r.ok)
  console.log(`\n══════ 결과: ${results.length - fail.length}/${results.length} 통과 ══════`)
  for (const f of fail) console.log(`FAIL [${f.section}] ${f.label}`)
}
main().catch(e => { console.error('❌', e); process.exit(1) })
