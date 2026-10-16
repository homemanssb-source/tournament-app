// ============================================================
// 현장 운영 시뮬레이션 (실서버) — 마스터 PIN · 경기장 PIN · 선수/주장 PIN 이 같이 운영
//   node scripts/sim-onsite-ops.mjs run       → 테스트 대회 2개 만들고 전 과정 진행 + 검사
//   node scripts/sim-onsite-ops.mjs cleanup   → '__TEST_SIM_현장운영_' 대회 전부 삭제
// 준비(대회·팀·경기장·PIN)는 service_role, 역할 동작은 전부 anon 키 + 그 역할의 PIN/토큰으로.
// 결과 상태(id·토큰)는 SIM_STATE 경로(JSON)에 저장 — 화면 확인용.
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
const PREFIX = '__TEST_SIM_현장운영_'
const STATE = process.env.SIM_STATE || join(__dirname, '..', '.sim-state.json')

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
const q1 = async (table, cols, match) => { let x = svc.from(table).select(cols); for (const [k, v] of Object.entries(match)) x = x.eq(k, v); return (await x.single()).data }

// ── 정리 ──
async function deleteEvent(eventId) {
  const ids = async (t, col = 'event_id') => ((await svc.from(t).select('id').eq(col, eventId)).data || []).map(r => r.id)
  const tieIds = await ids('ties'), clubIds = await ids('clubs'), groupIds = await ids('groups')
  const matchIds = await ids('matches'), teamIds = await ids('teams'), venueIds = await ids('venues')
  const del = (t, col, vals) => vals.length ? svc.from(t).delete().in(col, vals) : null
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

async function cloneEvent(type, name) {
  const { data: tmpl } = await svc.from('events').select('*').eq('event_type', type).limit(1).single()
  const row = { ...tmpl }
  for (const k of ['id', 'created_at', 'updated_at']) delete row[k]
  Object.assign(row, { name, event_key: 'sim-onsite-' + type + '-' + Date.now(), status: 'active', date: '2026-01-10' })
  for (const k of ['master_pin_hash', 'app_a_event_id']) if (k in row) row[k] = null
  if ('app_a_connected' in row) row.app_a_connected = false
  if ('auto_fill_courts' in row) { row.auto_fill_courts = false; row.auto_steal_courts = false }
  if (type === 'team') Object.assign(row, { team_format: 'group_tournament', team_rubber_count: 3, team_sets_per_rubber: 1, lineup_mode: 'captain_pin', team_match_type: '3_doubles' })
  return must(await svc.from('events').insert(row).select().single(), '대회 생성 ' + type)
}

async function makeVenues(eventId, defs) {
  const rows = defs.map((d, i) => ({ event_id: eventId, name: d.name, short_name: d.short, court_count: 2,
    courts: [`${d.short}-1`, `${d.short}-2`], pin_plain: d.pin, manager_name: d.name + ' 관리자',
    created_at: new Date(Date.now() + i * 1000).toISOString() }))
  return must(await svc.from('venues').insert(rows).select(), '경기장')
}

// ============================================================
// 개인전
// ============================================================
async function individual(state) {
  sec('개인전 준비')
  const ev = await cloneEvent('individual', PREFIX + '개인전')
  const div = must(await svc.from('divisions').insert({ event_id: ev.id, name: '테스트부', sort_order: 1 }).select().single(), '부서')
  await svc.from('group_settings').insert({ event_id: ev.id, division_id: div.id, division_name: div.name, teams_per_group: 4, advance_count: 2, random_assign: false })
  const teams = must(await svc.from('teams').insert(Array.from({ length: 8 }, (_, i) => ({
    event_id: ev.id, division_id: div.id, division_name: div.name, team_num: `S-${i + 1}`,
    team_key: `${div.id}|simA${i + 1}|simB${i + 1}`, team_name: `시뮬${i + 1}A/시뮬${i + 1}B`,
    player1_name: `시뮬${i + 1}A`, player2_name: `시뮬${i + 1}B`, pin_plain: String(7310001 + i),
  }))).select(), '팀')
  const pinOf = id => String(7310001 + teams.findIndex(t => t.id === id))
  const venues = await makeVenues(ev.id, [{ name: '시뮬1경기장', short: 'S1', pin: '7319001' }, { name: '시뮬2경기장', short: 'S2', pin: '7319002' }])
  must(await svc.rpc('rpc_set_master_pin', { p_event_id: ev.id, p_new_pin: '7318888' }), '마스터 PIN')
  must(await svc.rpc('rpc_generate_groups', { p_event_id: ev.id, p_division_id: div.id, p_group_size: 4 }), '조편성')
  must(await svc.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: div.id }), '조별 경기')
  const gen = await svc.rpc('rpc_generate_tournament', { p_event_id: ev.id, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true })
  check(!gen.error, '본선 미리 생성 (TBD)', gen.error?.message)
  const groups = must(await svc.from('groups').select('id, group_label, group_num').eq('event_id', ev.id).order('group_num'), '조')
  const gm = async () => must(await svc.from('matches').select('*').eq('event_id', ev.id).eq('stage', 'GROUP').order('slot'), '경기')
  const fm = async () => must(await svc.from('matches').select('*').eq('event_id', ev.id).eq('stage', 'FINALS').order('slot'), '본선')
  check(groups.length === 2 && (await gm()).length === 12, `조 2개 · 조별 12경기 (${groups.length}조, ${(await gm()).length}경기)`)
  const finals0 = await fm()
  check(finals0.some(m => m.qualifier_label_a || m.qualifier_label_b), '본선 TBD 자리 있음', finals0.map(m => [m.round, m.qualifier_label_a, m.qualifier_label_b]))
  state.indiv = { eventId: ev.id, divisionId: div.id, master: '7318888', venuePins: ['7319001', '7319002'], teamPins: teams.map(t => [t.team_name, pinOf(t.id)]) }

  sec('개인전 — 마스터 PIN 로그인 · 경기장 코트 관리')
  const login = await rpcA('rpc_admin_pin_login', { p_master_pin: '7318888', p_event_id: ev.id })
  check(!failed(login) && login.data?.token, '마스터 PIN 로그인', errText(login))
  const A = login.data.token
  const s = await q1('admin_pin_sessions', 'created_at, expires_at', { token: A })
  check(Math.round((new Date(s.expires_at) - new Date(s.created_at)) / 3600000) === 12, '마스터 PIN 세션 12시간')
  const ov = []
  for (const v of venues) {
    const r = await rpcA('rpc_admin_pin_open_venue', { p_token: A, p_venue_id: v.id })
    check(!failed(r) && r.data.is_admin, `마스터 → ${v.name} 코트 관리 열기`, errText(r)); ov.push(r.data.token)
  }
  // 1조 → S1-1, 2조 → S2-1 (조 경기 순서대로)
  const all = await gm()
  for (const [gi, g] of groups.entries()) {
    const list = all.filter(m => m.group_id === g.id)
    for (const [i, m] of list.entries()) {
      const r = await rpcA('rpc_venue_admin_set_match_court', { p_token: ov[gi], p_match_id: m.id, p_court: gi === 0 ? 'S1-1' : 'S2-1', p_court_order: i + 1 })
      if (failed(r)) check(false, `코트 배정 ${m.match_num}`, errText(r))
    }
  }
  const placed = (await gm()).filter(m => m.court)
  check(placed.length === 12, `마스터 PIN 으로 조별 12경기 코트 배정 (${placed.length})`)
  const cross = await rpcA('rpc_venue_admin_set_match_court', { p_token: ov[0], p_match_id: all[0].id, p_court: 'S2-2', p_court_order: 9 })
  check(failed(cross), '마스터 코트 관리도 다른 경기장 코트로는 못 옮김', errText(cross))

  sec('개인전 — 경기장 PIN (현장관리)')
  const v1a = await rpcA('rpc_venue_login', { p_pin_code: '7319001', p_event_id: ev.id })
  const v1b = await rpcA('rpc_venue_login', { p_pin_code: '7319001', p_event_id: ev.id })
  const v2 = await rpcA('rpc_venue_login', { p_pin_code: '7319002', p_event_id: ev.id })
  check(!failed(v1a) && !failed(v1b) && !failed(v2), '경기장 PIN 로그인 (1경기장 폰 2대 + 2경기장)', [errText(v1a), errText(v2)])
  const V1 = v1a.data.token, V1b = v1b.data.token, V2 = v2.data.token
  const act = await svc.from('venue_sessions').select('token, is_active').in('token', [V1, V1b, ov[0]])
  check(act.data.every(x => x.is_active), '같은 경기장 폰 2대 + 마스터 코트 관리 세션 모두 유지 (032)', act.data)
  const lst = await rpcA('rpc_venue_list_matches', { p_token: V1 })
  check(!lst.error && (lst.data.matches || []).filter(m => m.court === 'S1-1').length === 6, `1경기장 목록에 S1-1 6경기 (${(lst.data?.matches || []).length})`, lst.error)
  const vAdmin = await rpcA('rpc_venue_admin_set_match_court', { p_token: V1, p_match_id: all[0].id, p_court: 'S1-2', p_court_order: 1 })
  check(failed(vAdmin) && /마스터 PIN/.test(errText(vAdmin)), '경기장 PIN 은 코트 변경 거절 (래퍼)', errText(vAdmin))
  const vOld = await rpcA('rpc_venue_set_match_court', { p_token: V1, p_match_id: all[0].id, p_court: 'S1-2', p_court_order: 1 })
  check(/permission denied/.test(errText(vOld)), '경기장 PIN 은 예전 코트 함수 직접 호출도 거절', errText(vOld))

  sec('개인전 — 1조 진행 (선수 · 경기장 · 마스터 w.o)')
  const g1 = (await gm()).filter(m => m.group_id === groups[0].id).sort((a, b) => a.court_order - b.court_order)
  // 1조 첫 경기는 코트 배정과 함께 자동 시작됐을 수 있음 → 시작 시도
  const st = await rpcA('rpc_venue_start_match', { p_token: V1, p_match_id: g1[0].id })
  check(!st.error, '경기장 PIN: 첫 경기 시작', st.error)
  // ① 선수 PIN 입력 (A팀 PIN)
  const pl = await rpcA('rpc_pin_login', { p_pin_code: pinOf(g1[0].team_a_id), p_event_id: ev.id })
  check(!failed(pl) && pl.data?.token, '선수 PIN 로그인', errText(pl))
  const ps = await rpcA('rpc_pin_submit_score', { p_token: pl.data.token, p_match_id: g1[0].id, p_score: '6:3', p_winner_id: g1[0].team_a_id })
  check(!failed(ps), '선수 PIN: 점수 입력 6:3', errText(ps))
  const vfix = await rpcA('rpc_venue_record_score', { p_token: V1, p_match_id: g1[0].id, p_score: '6:0', p_winner_team_id: g1[0].team_b_id })
  check(failed(vfix), '경기장 PIN: 끝난 경기 정정 거절', errText(vfix))
  const pfix = await rpcA('rpc_pin_submit_score', { p_token: pl.data.token, p_match_id: g1[0].id, p_score: '6:0', p_winner_id: g1[0].team_a_id })
  check(failed(pfix), '선수 PIN: 끝난 경기 다시 입력 거절', errText(pfix))
  const auto = await q1('matches', 'status', { id: g1[1].id })
  check(auto.status === 'IN_PROGRESS', `다음 경기 자동 시작 (${auto.status})`)
  // ② 경기장 PIN 입력 (두 번째 폰)
  const vs = await rpcA('rpc_venue_record_score', { p_token: V1b, p_match_id: g1[1].id, p_score: '6:4', p_winner_team_id: g1[1].team_b_id })
  check(!failed(vs), '경기장 PIN(두 번째 폰): 점수 입력 6:4', errText(vs))
  // ③ 마스터 w.o (불참)
  const wo = await rpcA('rpc_admin_pin_update_score', { p_token: A, p_match_id: g1[2].id, p_score: 'w.o', p_winner_team_id: g1[2].team_a_id })
  check(!failed(wo), '마스터 PIN: w.o (불참) 처리', errText(wo))
  // ④ 마스터 도중 기권 3:2 w.o
  const wo2 = await rpcA('rpc_admin_pin_update_score', { p_token: A, p_match_id: g1[3].id, p_score: '3:2 w.o', p_winner_team_id: g1[3].team_b_id })
  check(!failed(wo2), '마스터 PIN: 도중 기권 3:2 w.o', errText(wo2))
  // ⑤ 나머지 2경기 경기장 PIN
  for (const m of g1.slice(4)) {
    const r = await rpcA('rpc_venue_record_score', { p_token: V1, p_match_id: m.id, p_score: '6:2', p_winner_team_id: m.team_a_id })
    check(!failed(r), `경기장 PIN: ${m.match_num} 6:2`, errText(r))
  }
  const gd = await svc.rpc('fn_group_game_diff', { p_event_id: ev.id, p_division_id: div.id })
  const done1 = (await gm()).filter(m => m.group_id === groups[0].id)
  const woTeams = [g1[2].team_a_id, g1[2].team_b_id]
  // w.o 경기 두 팀의 득실은 그 경기를 빼고 계산돼야 함 → 직접 계산과 비교
  const expect = {}
  for (const m of done1) {
    const p = /^(\d+):(\d+)$/.exec(m.score || ''); if (!p) continue
    const hi = Math.max(+p[1], +p[2]), lo = Math.min(+p[1], +p[2])
    for (const t of [m.team_a_id, m.team_b_id]) expect[t] = (expect[t] || 0) + (t === m.winner_team_id ? hi - lo : lo - hi)
  }
  const got = Object.fromEntries((gd.data || []).map(r => [r.team_id, r.game_diff]))
  check(!gd.error && woTeams.every(t => (got[t] || 0) === (expect[t] || 0)), 'w.o · 3:2 w.o 는 게임 득실에서 빠짐 (DB 계산 = 숫자 점수만)', { got, expect, err: gd.error?.message })
  const f1 = await fm()
  const g1Label = groups[0].group_label
  const filled1 = f1.filter(m => [m.team_a_id, m.team_b_id].some(Boolean))
  check(filled1.length >= 2 && !f1.some(m => (m.qualifier_label_a || '').startsWith(g1Label) || (m.qualifier_label_b || '').startsWith(g1Label)),
    `1조 끝 → 본선 1조 자리 자동 채움`, f1.map(m => [m.round, m.qualifier_label_a, m.qualifier_label_b, !!m.team_a_id, !!m.team_b_id]))

  sec('개인전 — 2조: 팀 중도 기권 (남은 경기 전부 w.o)')
  const g2 = (await gm()).filter(m => m.group_id === groups[1].id).sort((a, b) => a.court_order - b.court_order)
  const first = await rpcA('rpc_venue_record_score', { p_token: V2, p_match_id: g2[0].id, p_score: '6:1', p_winner_team_id: g2[0].team_a_id })
  check(!failed(first), '2경기장: 첫 경기 점수', errText(first))
  const quitter = g2[0].team_b_id
  // 화면처럼: 저장 직전 최신 목록으로 그 팀의 남은 경기
  const fresh = must(await anon.from('v_matches_with_teams').select('*').eq('event_id', ev.id).or(`team_a_id.eq.${quitter},team_b_id.eq.${quitter}`), '최신 목록')
  const left = fresh.filter(m => m.status !== 'FINISHED' && m.team_a_id && m.team_b_id)
  for (const m of left) {
    const r = await rpcA('rpc_admin_pin_update_score', { p_token: A, p_match_id: m.id, p_score: 'w.o', p_winner_team_id: m.team_a_id === quitter ? m.team_b_id : m.team_a_id })
    if (failed(r)) check(false, `기권 처리 ${m.match_num}`, errText(r))
  }
  const q = (await gm()).filter(m => m.team_a_id === quitter || m.team_b_id === quitter)
  check(left.length === 2 && q.every(m => m.status === 'FINISHED' && m.winner_team_id !== quitter), `기권 팀 남은 ${left.length}경기 w.o, 전부 상대 승`, q.map(m => [m.score, m.winner_team_id === quitter]))
  for (const m of (await gm()).filter(m => m.group_id === groups[1].id && m.status !== 'FINISHED')) {
    const r = await rpcA('rpc_venue_record_score', { p_token: V2, p_match_id: m.id, p_score: '6:3', p_winner_team_id: m.team_a_id })
    if (failed(r)) check(false, `2조 ${m.match_num}`, errText(r))
  }
  const f2 = await fm()
  const firstRound = f2.filter(m => m.round === f2[0].round)
  check(firstRound.every(m => m.team_a_id && m.team_b_id), '두 조 끝 → 본선 첫 라운드 모두 채워짐', firstRound.map(m => [m.qualifier_label_a, m.qualifier_label_b]))
  check(!f2.some(m => m.team_a_id === quitter || m.team_b_id === quitter), '기권 팀은 본선에 안 올라감 (3패)')

  sec('개인전 — 마스터 정정 (본선 시작 전 조 점수 뒤집기 → 자리 재배치)')
  const g1d = (await gm()).filter(m => m.group_id === groups[0].id)
  const before = (await fm()).map(m => [m.team_a_id, m.team_b_id].join(',')).join('|')
  // 1조에서 1·2위가 바뀔 만한 경기: 승수 상위 두 팀의 맞대결을 뒤집음
  const wins = {}; for (const m of g1d) wins[m.winner_team_id] = (wins[m.winner_team_id] || 0) + 1
  const top = Object.entries(wins).sort((a, b) => b[1] - a[1]).map(x => x[0])
  const h2h = g1d.find(m => [m.team_a_id, m.team_b_id].includes(top[0]) && [m.team_a_id, m.team_b_id].includes(top[1]))
  if (h2h) {
    const other = h2h.winner_team_id === h2h.team_a_id ? h2h.team_b_id : h2h.team_a_id
    const r = await rpcA('rpc_admin_pin_update_score', { p_token: A, p_match_id: h2h.id, p_score: '6:0', p_winner_team_id: other })
    check(!failed(r), '마스터: 1조 맞대결 결과 뒤집기', errText(r))
    const after = (await fm()).map(m => [m.team_a_id, m.team_b_id].join(',')).join('|')
    const al = await svc.from('audit_log').select('action').eq('event_id', ev.id).in('action', ['reseat_applied', 'reseat_skipped'])
    check(after !== before || (al.data || []).length > 0, '정정 후 본선 자리 재계산 (재배치 또는 기록)', al.data)
  } else check(false, '1조 상위 두 팀 맞대결을 못 찾음')

  sec('개인전 — 본선 진행 (경기장 · 선수 PIN) + 마스터 PIN 변경')
  const fin = (await fm())
  for (const [i, m] of fin.entries()) {
    const r = await rpcA('rpc_venue_admin_set_match_court', { p_token: ov[0], p_match_id: m.id, p_court: 'S1-2', p_court_order: i + 1 })
    if (failed(r)) check(false, `본선 코트 배정 ${m.match_num}`, errText(r))
  }
  for (const rnd of [...new Set(fin.map(m => m.round))]) {
    for (const m of (await fm()).filter(x => x.round === rnd)) {
      if (m.status === 'FINISHED' || !m.team_a_id || !m.team_b_id) continue
      const r = await rpcA('rpc_venue_record_score', { p_token: V1, p_match_id: m.id, p_score: '6:4', p_winner_team_id: m.team_a_id })
      check(!failed(r), `본선 ${rnd} ${m.match_num} 경기장 PIN 입력`, errText(r))
    }
  }
  const champ = (await fm()).find(m => ['F', '결승'].includes(m.round))
  check(champ?.status === 'FINISHED' && champ.winner_team_id, '결승까지 끝 (우승 팀 있음)', champ)
  const mid = (await fm()).find(m => m.round !== champ.round)
  const blocked = await rpcA('rpc_admin_pin_update_score', { p_token: A, p_match_id: mid.id, p_score: '6:0', p_winner_team_id: mid.team_b_id })
  check(failed(blocked) && /다음 라운드/.test(errText(blocked)), '다음 라운드 끝난 본선 경기는 일반 정정 막힘 (강제 정정 안내)', errText(blocked))
  must(await svc.rpc('rpc_set_master_pin', { p_event_id: ev.id, p_new_pin: '7317777' }), 'PIN 변경')
  const dead = await rpcA('rpc_admin_pin_locks', { p_token: A })
  check(failed(dead) && /만료/.test(errText(dead)), '마스터 PIN 바꾸면 기존 마스터 로그인 끊김', errText(dead))
  const deadV = await rpcA('rpc_venue_admin_set_match_court', { p_token: ov[0], p_match_id: mid.id, p_court: 'S1-1', p_court_order: 1 })
  check(failed(deadV), '마스터 PIN 바꾸면 마스터 코트 관리 세션도 끊김', errText(deadV))
  const stillV = await rpcA('rpc_venue_list_matches', { p_token: V1 })
  check(!stillV.error, '경기장 PIN 로그인은 그대로 유지', stillV.error)
  const relog = await rpcA('rpc_admin_pin_login', { p_master_pin: '7317777', p_event_id: ev.id })
  check(!failed(relog), '새 마스터 PIN 으로 다시 로그인', errText(relog))
  state.indiv.master = '7317777'
  state.indiv.tokens = { admin: relog.data?.token, venue1: V1, venue2: V2 }
}

// ============================================================
// 단체전
// ============================================================
async function team(state) {
  sec('단체전 준비')
  const ev = await cloneEvent('team', PREFIX + '단체전')
  const div = must(await svc.from('divisions').insert({ event_id: ev.id, name: '테스트단체부', sort_order: 1, allow_empty_order: true, team_match_type: '3_doubles' }).select().single(), '부서')
  const names = ['가클럽', '나클럽', '다클럽', '라클럽', '마클럽', '바클럽']
  const clubs = must(await svc.from('clubs').insert(names.map((n, i) => ({ event_id: ev.id, division_id: div.id, name: '시뮬' + n,
    captain_name: n + '주장', captain_pin: String(7320001 + i) }))).select(), '클럽')
  const pinOf = id => String(7320001 + clubs.findIndex(c => c.id === id))
  const members = {}
  for (const c of clubs) members[c.id] = must(await svc.from('club_members').insert(Array.from({ length: 6 }, (_, i) => ({
    club_id: c.id, name: `${c.name.slice(2, 3)}선수${i + 1}`, gender: i % 2 ? 'F' : 'M', member_order: i + 1, is_captain: i === 0 }))).select(), '선수')
  const venues = await makeVenues(ev.id, [{ name: '시뮬단체1경기장', short: 'T1', pin: '7329001' }, { name: '시뮬단체2경기장', short: 'T2', pin: '7329002' }])
  must(await svc.rpc('rpc_set_master_pin', { p_event_id: ev.id, p_new_pin: '7328888' }), '마스터 PIN')
  const cg = await svc.rpc('rpc_create_team_groups', { p_event_id: ev.id, p_group_count: 2, p_group_size: 3, p_division_id: div.id })
  check(!cg.error && cg.data?.success !== false, '단체전 조편성 (2조 × 3클럽)', cg.error?.message || cg.data)
  const gen = await svc.rpc('rpc_generate_team_tournament_v2', { p_event_id: ev.id, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true })
  check(!gen.error && gen.data?.success !== false, '단체전 토너먼트 미리 생성 (TBD)', gen.error?.message || gen.data)
  const ties = async () => must(await svc.from('ties').select('*, rubbers:tie_rubbers(*)').eq('event_id', ev.id).order('tie_order'), '대전')
  const groupTies = (await ties()).filter(t => t.round === 'group')
  const ko = (await ties()).filter(t => t.round !== 'group')
  check(groupTies.length === 6 && ko.length >= 3, `조별 대전 6 · 토너먼트 ${ko.length}`, (await ties()).map(t => t.round))
  state.team = { eventId: ev.id, divisionId: div.id, master: '7328888', venuePins: ['7329001', '7329002'], captainPins: clubs.map(c => [c.name, pinOf(c.id)]) }

  sec('단체전 — 마스터 로그인 · 코트 배정')
  const A = (await rpcA('rpc_admin_pin_login', { p_master_pin: '7328888', p_event_id: ev.id })).data.token
  const ov1 = (await rpcA('rpc_admin_pin_open_venue', { p_token: A, p_venue_id: venues[0].id })).data.token
  const ov2 = (await rpcA('rpc_admin_pin_open_venue', { p_token: A, p_venue_id: venues[1].id })).data.token
  const groupIds = [...new Set(groupTies.map(t => t.group_id))]
  // 코트 번호: 1경기장 T1-1=1, T1-2=2, 2경기장 T2-1=3, T2-2=4
  for (const [i, t] of groupTies.entries()) {
    const inA = t.group_id === groupIds[0]
    const r = await rpcA('rpc_venue_admin_assign_tie_court', { p_token: inA ? ov1 : ov2, p_tie_id: t.id, p_court_number: inA ? 1 : 3, p_court_order: i + 1 })
    if (failed(r)) check(false, `대전 코트 배정 #${t.tie_order}`, errText(r))
  }
  check((await ties()).filter(t => t.round === 'group' && t.court_number).length === 6, '마스터 PIN 으로 조별 대전 6개 코트 배정')
  const V1 = (await rpcA('rpc_venue_login', { p_pin_code: '7329001', p_event_id: ev.id })).data.token
  const V2 = (await rpcA('rpc_venue_login', { p_pin_code: '7329002', p_event_id: ev.id })).data.token
  const vl = await rpcA('rpc_venue_list_matches', { p_token: V1 })
  check(!vl.error && (vl.data.ties || []).filter(t => t.court === 'T1-1').length === 3, `1경기장 목록에 T1-1 대전 3개 (${(vl.data?.ties || []).length})`, vl.error || (vl.data?.ties || []).map(t => t.court))

  // 오더 제출 헬퍼 (주장 PIN, anon)
  const lineup = async (tie, clubId, empty = false) => {
    const m = members[clubId]
    const ls = [1, 2, 3].map(n => (empty && n === 3) ? { rubber_number: n, player1_id: null, player2_id: null }
      : { rubber_number: n, player1_id: m[(n - 1) * 2].id, player2_id: m[(n - 1) * 2 + 1].id })
    return rpcA('rpc_submit_lineup', { p_tie_id: tie.id, p_club_id: clubId, p_captain_pin: pinOf(clubId), p_lineups: ls })
  }
  const rub = async tieId => must(await svc.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number'), '러버')

  sec('단체전 — A조: 경기장 PIN 복식 점수 · 주장 PIN · 충돌')
  const tA = (await ties()).filter(t => t.round === 'group' && t.group_id === groupIds[0])
  const r0 = await rub(tA[0].id)
  if (r0.length) {
    const early = await rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: r0[0].id, p_set1_a: 6, p_set1_b: 1 })
    check(failed(early) && /라인업/.test(errText(early)), '라인업 공개 전 경기장 입력 거절', errText(early))
  }
  for (const t of tA) {
    const a = await lineup(t, t.club_a_id), b = await lineup(t, t.club_b_id)
    check(!failed(a) && !failed(b), `#${t.tie_order} 양 클럽 오더 제출`, [errText(a), errText(b)])
  }
  const revealed = (await ties()).filter(t => tA.some(x => x.id === t.id))
  check(revealed.every(t => t.lineup_revealed), '양쪽 제출 → 라인업 공개')
  // 대전1: 경기장 PIN 이 3복식 입력 (가 > 나 형태: 2:1)
  const t1 = revealed[0], rr1 = await rub(t1.id)
  const sc = [[6, 2], [3, 6], [6, 4]]
  for (const [i, r] of rr1.entries()) {
    const x = await rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: r.id, p_set1_a: sc[i][0], p_set1_b: sc[i][1] })
    check(!failed(x), `경기장 PIN: #${t1.tie_order} ${i + 1}복식 ${sc[i].join('-')}`, errText(x))
  }
  const t1d = (await ties()).find(t => t.id === t1.id)
  check(t1d.status === 'completed' && t1d.club_a_rubbers_won === 2, `대전 결과 2:1 완료 (${t1d.status} ${t1d.club_a_rubbers_won}:${t1d.club_b_rubbers_won})`)
  const again = await rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: rr1[0].id, p_set1_a: 0, p_set1_b: 6 })
  check(failed(again) && /마스터 PIN/.test(errText(again)), '경기장 PIN: 입력된 복식 정정 거절', errText(again))
  const other = await rpcA('rpc_venue_rubber_score', { p_token: V2, p_rubber_id: (await rub(revealed[1].id))[0].id, p_set1_a: 6, p_set1_b: 0 })
  check(failed(other) && /이 경기장 코트/.test(errText(other)), '2경기장 PIN 으로 1경기장 대전 입력 거절', errText(other))
  // 대전2: 주장 PIN 1복식 + 경기장/주장 동시 입력 (충돌 확인)
  const t2 = revealed[1], rr2 = await rub(t2.id)
  const cap = await rpcA('rpc_captain_record_score', { p_tie_id: t2.id, p_pin: pinOf(t2.club_a_id), p_rubber_id: rr2[0].id, p_set1_a: 2, p_set1_b: 6 })
  check(!failed(cap), '주장 PIN: 1복식 입력', errText(cap))
  const [c1, c2] = await Promise.all([
    rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: rr2[1].id, p_set1_a: 1, p_set1_b: 6 }),
    rpcA('rpc_captain_record_score', { p_tie_id: t2.id, p_pin: pinOf(t2.club_b_id), p_rubber_id: rr2[1].id, p_set1_a: 6, p_set1_b: 1 }),
  ])
  const after2 = (await rub(t2.id))[1]
  const both = !failed(c1) && !failed(c2)
  check(true, `동시 입력(경기장·주장 같은 복식): 경기장 ${failed(c1) ? '거절' : '저장'} · 주장 ${failed(c2) ? '거절' : '저장'} → 남은 값 ${after2.set1_a}-${after2.set1_b}${both ? ' (둘 다 저장 = 나중 값이 덮음)' : ''}`)
  results[results.length - 1].note = both ? 'race-both-saved' : 'race-one-rejected'
  // 대전2 남은 복식 → 나 클럽 2:? 완료되게
  for (const r of (await rub(t2.id)).filter(r => r.status !== 'completed')) {
    const x = await rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: r.id, p_set1_a: 3, p_set1_b: 6 })
    check(!failed(x), `#${t2.tie_order} ${r.rubber_number}복식 입력`, errText(x))
  }
  // 대전3: 순환 결과 만들기 위해 결과를 정해 입력 (동률 유도: 각 클럽 1승 1패, 복식 득실 같게)
  const t3 = revealed[2]
  const st = (await ties()).filter(t => tA.some(x => x.id === t.id) && t.status === 'completed')
  const winsBy = {}; for (const t of st) winsBy[t.winning_club_id] = (winsBy[t.winning_club_id] || 0) + 1
  // t3 에서 아직 이기지 못한 클럽이 이기게 → 1승씩
  const t3winnerIsA = !winsBy[t3.club_a_id]
  for (const [i, r] of (await rub(t3.id)).entries()) {
    const aWin = i < 2 ? t3winnerIsA : !t3winnerIsA
    const x = await rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: r.id, p_set1_a: aWin ? 6 : 2, p_set1_b: aWin ? 2 : 6 })
    if (failed(x)) check(false, `#${t3.tie_order} ${i + 1}복식`, errText(x))
  }
  const stA = must(await svc.from('team_standings').select('club_id, won, rubber_diff, rank, rank_locked').eq('event_id', ev.id).eq('group_id', groupIds[0]), '순위')
  const tied = stA.filter(s => s.rank === null)
  check(stA.every(s => s.won === 1), `A조 3클럽 모두 1승 1패 (${stA.map(s => s.won).join(',')})`)
  check(tied.length >= 2, `A조 동률 → 순위 미정 ${tied.length}클럽 (마스터 결정 필요)`, stA)

  sec('단체전 — 마스터: 동률 순위 결정 → 토너먼트 자리')
  const order = stA.slice().sort((a, b) => b.rubber_diff - a.rubber_diff)
  const tiedIds = order.filter(s => s.rank === null).map(s => s.club_id)
  const minRank = Math.min(...order.map((s, i) => s.rank === null ? i + 1 : 99))
  for (const [i, cid] of tiedIds.entries()) {
    const r = await rpcA('rpc_admin_pin_set_manual_rank', { p_token: A, p_club_id: cid, p_rank: minRank + i })
    check(!failed(r), `마스터 PIN: 동률 순위 ${minRank + i}위 지정`, errText(r))
  }
  const stA2 = must(await svc.from('team_standings').select('club_id, rank, rank_locked').eq('event_id', ev.id).eq('group_id', groupIds[0]), '순위2')
  check(stA2.every(s => s.rank !== null), 'A조 순위 모두 확정', stA2)
  const vRank = await rpcA('rpc_admin_pin_set_manual_rank', { p_token: V1, p_club_id: tiedIds[0], p_rank: 1 })
  check(failed(vRank), '경기장 PIN 토큰으로 순위 지정 불가', errText(vRank))

  sec('단체전 — B조: 클럽 불참 w.o + 공오더')
  const tB = (await ties()).filter(t => t.round === 'group' && t.group_id === groupIds[1])
  // B 대전1: 클럽 불참 (오더 없이) → 마스터 w.o
  const noShow = await rpcA('rpc_admin_pin_tie_walkover', { p_token: A, p_tie_id: tB[0].id, p_winner_club_id: tB[0].club_a_id })
  check(!failed(noShow), `마스터 PIN: #${tB[0].tie_order} 클럽 불참 w.o`, errText(noShow))
  const nsT = (await ties()).find(t => t.id === tB[0].id), nsR = await rub(tB[0].id)
  check(nsT.status === 'completed' && nsT.winning_club_id === tB[0].club_a_id && nsR.every(r => r.is_walkover), `불참 대전 완료 · 복식 ${nsR.length}개 모두 w.o`, { status: nsT.status, r: nsR.map(r => r.is_walkover) })
  const noShow2 = await rpcA('rpc_admin_pin_tie_walkover', { p_token: A, p_tie_id: tB[0].id, p_winner_club_id: tB[0].club_a_id })
  check(failed(noShow2), '끝난 대전에 다시 불참 처리 거절', errText(noShow2))
  // B 대전2: 공오더(3복식 비움) → 상대 승 자동 기록
  const b2 = tB[1]
  const la = await lineup(b2, b2.club_a_id, true), lb = await lineup(b2, b2.club_b_id)
  check(!failed(la) && !failed(lb), '공오더 포함 오더 제출', [errText(la), errText(lb)])
  const b2r = await rub(b2.id)
  check(b2r.find(r => r.rubber_number === 3)?.is_walkover && b2r.find(r => r.rubber_number === 3)?.winning_club_id === b2.club_b_id, '비운 3복식 → 상대 w.o 승 자동 기록')
  for (const r of b2r.filter(r => r.status !== 'completed')) {
    const x = await rpcA('rpc_venue_rubber_score', { p_token: V2, p_rubber_id: r.id, p_set1_a: 6, p_set1_b: 3 })
    if (failed(x)) check(false, `B #${b2.tie_order} ${r.rubber_number}복식`, errText(x))
  }
  const b3 = tB[2]
  await lineup(b3, b3.club_a_id); await lineup(b3, b3.club_b_id)
  for (const r of await rub(b3.id)) {
    const x = await rpcA('rpc_venue_rubber_score', { p_token: V2, p_rubber_id: r.id, p_set1_a: 6, p_set1_b: 4 })
    if (failed(x)) check(false, `B #${b3.tie_order} ${r.rubber_number}복식`, errText(x))
  }
  const stB = must(await svc.from('team_standings').select('club_id, won, rank').eq('event_id', ev.id).eq('group_id', groupIds[1]), 'B순위')
  check(stB.every(s => s.rank !== null), `B조 순위 확정 (${stB.map(s => s.won + '승').join(',')})`, stB)

  sec('단체전 — 토너먼트 (자리 채움 · 경기장 입력 · 승부 결정 후 남은 복식)')
  let koT = (await ties()).filter(t => t.round !== 'group')
  const first = koT.filter(t => t.club_a_id && t.club_b_id)
  check(first.length >= 2, `토너먼트 첫 라운드 ${first.length}대전 채워짐`, koT.map(t => [t.round, t.qualifier_label_a, t.qualifier_label_b, !!t.club_a_id, !!t.club_b_id]))
  for (const [i, t] of koT.entries()) {
    const r = await rpcA('rpc_venue_admin_assign_tie_court', { p_token: ov1, p_tie_id: t.id, p_court_number: 2, p_court_order: i + 1 })
    if (failed(r)) check(false, `토너먼트 코트 배정 #${t.tie_order}`, errText(r))
  }
  for (const round of [...new Set(koT.map(t => t.round))]) {
    for (const t of (await ties()).filter(x => x.round === round && x.club_a_id && x.club_b_id && x.status !== 'completed')) {
      await lineup(t, t.club_a_id); await lineup(t, t.club_b_id)
      const rs = await rub(t.id)
      for (const [i, r] of rs.entries()) {
        const x = await rpcA('rpc_venue_rubber_score', { p_token: V1, p_rubber_id: r.id, p_set1_a: 6, p_set1_b: 3 })
        if (i < 2) check(!failed(x), `${round} #${t.tie_order} ${i + 1}복식 (경기장 PIN)`, errText(x))
        else check(failed(x), `${round} #${t.tie_order} 승부 결정 뒤 3복식 입력 막힘`, errText(x))
      }
    }
  }
  const final = (await ties()).find(t => t.round === 'final')
  check(final?.status === 'completed' && final.winning_club_id, '결승 완료 (우승 클럽 있음)', final && [final.status, final.club_a_id, final.club_b_id])
  state.team.tokens = { admin: A, venue1: V1, venue2: V2 }
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'cleanup') return cleanup()
  if (mode !== 'run') { console.log('usage: run | cleanup'); return }
  await cleanup()
  const state = {}
  try { await individual(state) } catch (e) { check(false, '개인전 중단: ' + e.message) }
  try { await team(state) } catch (e) { check(false, '단체전 중단: ' + e.message) }
  writeFileSync(STATE, JSON.stringify(state, null, 2))
  const fail = results.filter(r => !r.ok)
  console.log(`\n══════ 결과: ${results.length - fail.length}/${results.length} 통과 ══════`)
  for (const f of fail) console.log(`FAIL [${f.section}] ${f.label}`)
  writeFileSync(STATE.replace(/\.json$/, '-results.json'), JSON.stringify(results, null, 2))
}
main().catch(e => { console.error('❌', e); process.exit(1) })
