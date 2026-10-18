// ============================================================
// 부서별 진행방식 + 개인전 풀리그 (034) 실서버 시뮬레이션
//   node --experimental-strip-types scripts/sim-league.mjs        → 테스트 대회 만들고 검사 후 삭제
//   node --experimental-strip-types scripts/sim-league.mjs keep   → 검사 후 남겨 둠 (화면 확인용)
//   node --experimental-strip-types scripts/sim-league.mjs cleanup
//
//  S1 익명은 rpc_generate_league 실행 불가
//  S2 5·4·9팀 풀리그 생성: 경기 수, 모든 쌍 1번씩, 라운드 안에서 한 팀 한 경기, 한 조('리그'), 부서 format 저장, 재생성 거부
//  S3 5팀 리그 완료 → 우승·준우승·4강·4강·참가 (앱A 등수), 진행 중 부서는 unfinished
//  S4 4팀 완전 동률 → unresolved, manual_rank 저장 → 해결 (익명 조회 가능)
//  S5 9팀 → 5~8위 8강, 9위 참가
//  S6 단체전: 부서 방식 저장 후 풀리그 생성 → 대회 설정이 바뀌어도 다른 부서는 조별 유지
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { register } from 'node:module'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const SRC = new URL('../src/', import.meta.url).href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@/')) s = ${JSON.stringify(SRC)} + s.slice(2) + '.ts'; return next(s, c) }`))
const { fetchLeaguePlacements } = await import('../src/lib/league-results.ts')
const { divisionTeamFormat } = await import('../src/lib/league.ts')

const __dirname = dirname(fileURLToPath(import.meta.url))
let env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8'); if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1)
env.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const PREFIX = '__TEST_SIM_풀리그_'
const DATE = '2026-01-11'

let pass = 0, fail = 0
const ok = (c, msg, detail) => { console.log(`   ${c ? '✅' : '❌'} ${msg}${!c && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); c ? pass++ : fail++ }
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data }

async function deleteEvent(eventId) {
  const ids = async t => ((await svc.from(t).select('id').eq('event_id', eventId)).data || []).map(r => r.id)
  const teamIds = await ids('teams'), groupIds = await ids('groups'), clubIds = await ids('clubs'), tieIds = await ids('ties')
  const ops = [
    groupIds.length && (() => svc.from('group_members').delete().in('group_id', groupIds)),
    tieIds.length && (() => svc.from('tie_rubbers').delete().in('tie_id', tieIds)),
    () => svc.from('ties').delete().eq('event_id', eventId),
    () => svc.from('team_standings').delete().eq('event_id', eventId),
    () => svc.from('audit_log').delete().eq('event_id', eventId),
    () => svc.from('matches').delete().eq('event_id', eventId),
    () => svc.from('groups').delete().eq('event_id', eventId),
    teamIds.length && (() => svc.from('team_pins').delete().in('team_id', teamIds)),
    () => svc.from('teams').delete().eq('event_id', eventId),
    clubIds.length && (() => svc.from('club_members').delete().in('club_id', clubIds)),
    clubIds.length && (() => svc.from('club_pins').delete().in('club_id', clubIds)),
    () => svc.from('clubs').delete().eq('event_id', eventId),
    () => svc.from('group_settings').delete().eq('event_id', eventId),
    () => svc.from('divisions').delete().eq('event_id', eventId),
    () => svc.from('event_secrets').delete().eq('event_id', eventId),
  ].filter(Boolean)
  for (const op of ops) { try { await op() } catch {} }
  const { error } = await svc.from('events').delete().eq('id', eventId)
  return error?.message || null
}
async function cleanup() {
  const { data } = await svc.from('events').select('id, name').like('name', `${PREFIX}%`)
  for (const e of data || []) { const err = await deleteEvent(e.id); console.log(err ? `❌ ${e.name}: ${err}` : `삭제: ${e.name}`) }
}

async function makeEvent(type) {
  const { data: tmpl } = await svc.from('events').select('*').eq('event_type', type).limit(1).single()
  const row = { ...tmpl }
  for (const k of ['id', 'created_at', 'updated_at']) delete row[k]
  Object.assign(row, { name: PREFIX + type, event_key: 'sim-league-' + type + '-' + Date.now(), status: 'active', date: DATE })
  for (const k of ['master_pin_hash', 'app_a_event_id', 'court_zones']) if (k in row) row[k] = null
  if ('app_a_connected' in row) row.app_a_connected = false
  if ('auto_fill_courts' in row) row.auto_fill_courts = false
  if (type === 'team') row.team_format = 'group_tournament'
  return must(await svc.from('events').insert(row).select().single(), '대회 생성 ' + type)
}
async function makeDiv(ev, name, order) {
  return must(await svc.from('divisions').insert({ event_id: ev.id, name, sort_order: order, match_date: DATE }).select().single(), '부서 ' + name)
}
async function makeTeams(ev, div, n) {
  return must(await svc.from('teams').insert(Array.from({ length: n }, (_, i) => ({
    event_id: ev.id, division_id: div.id, division_name: div.name, team_num: `${div.name}-${i + 1}`,
    team_key: `${div.id}|선수${i + 1}|`, team_name: `${div.name}선수${i + 1}(학교${i + 1})`,
    player1_name: `${div.name}선수${i + 1}`, p1_club: `학교${i + 1}`, player2_name: '',
  }))).select(), '팀 ' + div.name)
}
const leagueMatches = async div => must(await svc.from('matches').select('id, slot, team_a_id, team_b_id, group_id, stage, status')
  .eq('division_id', div.id).order('slot'), '경기')
// 강한 팀(목록 앞쪽)이 이기도록 결과 입력 — strength: team_id → 숫자(클수록 강함)
async function playAll(div, winnerOf, scoreOf = () => '6:3') {
  for (const m of await leagueMatches(div)) {
    const w = winnerOf(m.team_a_id, m.team_b_id)
    must(await svc.from('matches').update({ status: 'FINISHED', score: scoreOf(m.team_a_id, m.team_b_id, w), winner_team_id: w }).eq('id', m.id), '결과')
  }
}

async function main() {
  const ev = await makeEvent('individual')
  const D5 = await makeDiv(ev, '오팀부', 1), D4 = await makeDiv(ev, '사팀부', 2), D9 = await makeDiv(ev, '구팀부', 3)
  const T5 = await makeTeams(ev, D5, 5), T4 = await makeTeams(ev, D4, 4), T9 = await makeTeams(ev, D9, 9)

  console.log('\nS1 익명 실행 불가')
  const a = await anon.rpc('rpc_generate_league', { p_event_id: ev.id, p_division_id: D5.id })
  ok(!!a.error, `익명 호출 거부 (${a.error?.message?.slice(0, 50)})`)

  console.log('\nS2 풀리그 생성')
  for (const [div, teams, want] of [[D5, T5, 10], [D4, T4, 6], [D9, T9, 36]]) {
    const r = await svc.rpc('rpc_generate_league', { p_event_id: ev.id, p_division_id: div.id })
    ok(!r.error && r.data?.matches_created === want, `${div.name}: ${r.data?.matches_created}경기 (기대 ${want})`, r.error?.message)
    const ms = await leagueMatches(div)
    const pairs = new Set(ms.map(m => [m.team_a_id, m.team_b_id].sort().join('|')))
    ok(pairs.size === want && ms.every(m => m.stage === 'GROUP'), '모든 쌍 정확히 한 번, stage=GROUP')
    const per = Math.floor(teams.length / 2)
    let roundsOk = true
    for (let i = 0; i < ms.length; i += per) {
      const ids = ms.slice(i, i + per).flatMap(m => [m.team_a_id, m.team_b_id])
      if (new Set(ids).size !== ids.length) roundsOk = false
    }
    ok(roundsOk, `라운드(${per}경기씩) 안에서 한 팀은 한 경기만`)
    const grps = must(await svc.from('groups').select('id, group_label').eq('division_id', div.id), '조')
    const dv = must(await svc.from('divisions').select('format').eq('id', div.id).single(), '부서')
    ok(grps.length === 1 && grps[0].group_label === '리그' && dv.format === 'full_league', `한 조('리그'), 부서 format=full_league`)
  }
  const again = await svc.rpc('rpc_generate_league', { p_event_id: ev.id, p_division_id: D5.id })
  ok(!!again.error && again.error.message.includes('이미 경기'), '경기가 있으면 다시 만들지 않음')

  console.log('\nS3 5팀 리그 완료 → 입상')
  const rank5 = new Map(T5.map((t, i) => [t.id, 5 - i]))   // 선수1이 가장 강함
  await playAll(D5, (x, y) => (rank5.get(x) > rank5.get(y) ? x : y))
  let L = await fetchLeaguePlacements(svc, ev.id)
  const p5 = T5.map(t => L.placements.find(p => p.team_id === t.id)?.appA).join(',')
  ok(p5 === '우승,준우승,4강,4강,참가', `오팀부: ${p5}`)
  ok(L.unfinished.includes('사팀부') && L.unfinished.includes('구팀부'), `진행 중 부서 표시 (${L.unfinished.join(',')})`)

  console.log('\nS4 4팀 완전 동률 → 수동 지정')
  // 0>1>2>0 (물고 물림) 모두 6:4, 3번은 전패 → 세 팀 2승1패, 승자승 1씩, 득실 같음
  const [p, q, r_, s] = T4.map(t => t.id)
  const beats = new Set([`${p}>${q}`, `${q}>${r_}`, `${r_}>${p}`])
  await playAll(D4, (x, y) => (x === s ? y : y === s ? x : beats.has(`${x}>${y}`) ? x : y), () => '6:4')
  L = await fetchLeaguePlacements(svc, ev.id)
  ok(L.unresolved.includes('사팀부') && !L.placements.some(x => x.division_id === D4.id), '동률 미지정 → 입상 보류')
  const g4 = must(await svc.from('groups').select('id').eq('division_id', D4.id).single(), '조')
  for (const [id, rk] of [[q, 1], [p, 2], [r_, 3]]) must(await svc.from('group_members').update({ manual_rank: rk }).eq('group_id', g4.id).eq('team_id', id), '수동')
  L = await fetchLeaguePlacements(svc, ev.id)
  const p4 = [q, p, r_, s].map(id => L.placements.find(x => x.team_id === id)?.appA).join(',')
  ok(p4 === '우승,준우승,4강,4강', `수동 순위 반영: ${p4}`)
  const an = await anon.from('group_members').select('team_id, manual_rank').eq('group_id', g4.id)
  ok(!an.error && an.data.filter(x => x.manual_rank != null).length === 3, '공개 화면(익명)에서 manual_rank 조회 가능', an.error?.message)

  console.log('\nS5 9팀 → 5~8위 8강')
  const rank9 = new Map(T9.map((t, i) => [t.id, 9 - i]))
  await playAll(D9, (x, y) => (rank9.get(x) > rank9.get(y) ? x : y))
  L = await fetchLeaguePlacements(svc, ev.id)
  const p9 = T9.map(t => L.placements.find(x => x.team_id === t.id)?.appA).join(',')
  ok(p9 === '우승,준우승,4강,4강,8강,8강,8강,8강,참가', `구팀부: ${p9}`)
  ok(L.unfinished.length === 0 && L.unresolved.length === 0, '모든 부서 확정')

  console.log('\nS6 단체전 부서별 진행방식')
  const tev = await makeEvent('team')
  const TA = await makeDiv(tev, '리그부', 1), TB = await makeDiv(tev, '조별부', 2)
  for (const [d, n] of [[TA, 4], [TB, 6]]) {
    must(await svc.from('clubs').insert(Array.from({ length: n }, (_, i) => ({ event_id: tev.id, division_id: d.id, name: `${d.name}클럽${i + 1}` }))), '클럽')
  }
  // 화면(pinDivisionFormats)과 같은 순서: 모든 부서 방식 저장 → 풀리그 생성
  must(await svc.from('divisions').update({ format: 'full_league' }).eq('id', TA.id), 'A')
  must(await svc.from('divisions').update({ format: 'group_knockout' }).eq('id', TB.id), 'B')
  const fl = await svc.rpc('rpc_generate_full_league', { p_event_id: tev.id, p_division_id: TA.id })
  ok(!fl.error && fl.data?.success !== false, '리그부 풀리그 생성', fl.error?.message || fl.data)
  const tevNow = must(await svc.from('events').select('team_format').eq('id', tev.id).single(), '대회')
  const divs = must(await svc.from('divisions').select('*').eq('event_id', tev.id), '부서')
  const fa = divisionTeamFormat(divs.find(d => d.id === TA.id), tevNow.team_format)
  const fb = divisionTeamFormat(divs.find(d => d.id === TB.id), tevNow.team_format)
  ok(fa === 'full_league' && fb === 'group_tournament', `대회 설정=${tevNow.team_format} 이어도 리그부=${fa}, 조별부=${fb}`)
  const ties = must(await svc.from('ties').select('round, division_id').eq('event_id', tev.id), '대전')
  ok(ties.length === 6 && ties.every(t => t.division_id === TA.id && t.round === 'full_league'), `리그부 대전 ${ties.length}개만 생성`)
}

const mode = process.argv[2]
if (mode === 'cleanup') { await cleanup(); process.exit(0) }
try { await main() } catch (e) { console.error('💥', e.stack || e.message); fail++ }
finally { if (mode !== 'keep') await cleanup() }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`)
process.exit(fail ? 1 : 0)
