// ============================================================
// 랭킹 시드 (028 지그재그 조편성 + 044 본선 2위 자리 고정) 실서버 시뮬레이션
//   node scripts/sim-ranking-seed.mjs          → 테스트 대회 만들고 검사 후 삭제
//   node scripts/sim-ranking-seed.mjs keep     → 검사 후 남겨 둠 (화면 확인용)
//   node scripts/sim-ranking-seed.mjs cleanup
//
//  S1 32팀·2팀 조 전체 랭킹제: k조 = k위·(33−k)위, 1번 자리가 상위
//  S2 S1 조별 경기 → 1조만 32위가 1위를 이김 → 본선: 두 팀 자리가 서로 바뀜, 같은 조는 반대편 절반
//  S3 48팀·3팀 조: k조 = k위·(33−k)위·(32+k)위, 미리 만든 본선(TBD) 이름표 = 이웃 조 교차
//  S4 47팀·3팀 조: 마지막 조만 2팀 (16위·17위)
//  S5 시드 없는 부서: 기존대로 동작 (같은 조는 반대편 절반)
//  S6 상위 시드만 (16팀·4팀 조·시드 4): 시드끼리 다른 조 첫 자리
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
let env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8'); if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1)
env.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const PREFIX = '__TEST_SIM_랭킹시드_'
const DATE = '2026-01-11'

let pass = 0, fail = 0
const ok = (c, msg, detail) => { console.log(`   ${c ? '✅' : '❌'} ${msg}${!c && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); c ? pass++ : fail++ }
const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data }

async function deleteEvent(eventId) {
  const ids = async t => ((await svc.from(t).select('id').eq('event_id', eventId)).data || []).map(r => r.id)
  const teamIds = await ids('teams'), groupIds = await ids('groups')
  const ops = [
    groupIds.length && (() => svc.from('group_members').delete().in('group_id', groupIds)),
    () => svc.from('bracket_nodes').delete().eq('event_id', eventId),
    () => svc.from('audit_log').delete().eq('event_id', eventId),
    () => svc.from('matches').delete().eq('event_id', eventId),
    () => svc.from('groups').delete().eq('event_id', eventId),
    teamIds.length && (() => svc.from('team_pins').delete().in('team_id', teamIds)),
    () => svc.from('teams').delete().eq('event_id', eventId),
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

async function makeEvent() {
  const { data: tmpl } = await svc.from('events').select('*').eq('event_type', 'individual').limit(1).single()
  const row = { ...tmpl }
  for (const k of ['id', 'created_at', 'updated_at']) delete row[k]
  Object.assign(row, { name: PREFIX + 'individual', event_key: 'sim-rankseed-' + Date.now(), status: 'active', date: DATE })
  for (const k of ['master_pin_hash', 'app_a_event_id', 'court_zones']) if (k in row) row[k] = null
  if ('app_a_connected' in row) row.app_a_connected = false
  if ('auto_fill_courts' in row) row.auto_fill_courts = false
  return must(await svc.from('events').insert(row).select().single(), '대회 생성')
}
const makeDiv = async (ev, name, order) =>
  must(await svc.from('divisions').insert({ event_id: ev.id, name, sort_order: order, match_date: DATE }).select().single(), '부서 ' + name)
// seeds: 앞에서부터 몇 팀에 시드 1..n 을 줄지 (팀 i = i위)
async function makeTeams(ev, div, n, seeds) {
  const rows = must(await svc.from('teams').insert(Array.from({ length: n }, (_, i) => ({
    event_id: ev.id, division_id: div.id, division_name: div.name, team_num: `${div.name}-${i + 1}`,
    team_key: `${div.id}|${i + 1}위|`, team_name: `${div.name}${i + 1}위`,
    player1_name: `${div.name}${i + 1}위`, p1_club: `클럽${i + 1}`, player2_name: '',
    seed_number: i < seeds ? i + 1 : null,
  }))).select('id, team_name, seed_number'), '팀 ' + div.name)
  return new Map(rows.map(t => [t.id, Number(t.team_name.replace(div.name, '').replace('위', ''))]))   // team_id → 순위
}
async function groupsOf(div, rankOf) {
  const gs = must(await svc.from('groups').select('id, group_num').eq('division_id', div.id).order('group_num'), '조')
  const gm = must(await svc.from('group_members').select('group_id, team_id, seq').eq('division_id', div.id), '조원')
  return gs.map(g => ({ id: g.id, num: g.group_num, ranks: gm.filter(m => m.group_id === g.id).sort((a, b) => a.seq - b.seq).map(m => rankOf.get(m.team_id)) }))
}
const gen = (ev, div, size) => svc.rpc('rpc_generate_groups', { p_event_id: ev.id, p_division_id: div.id, p_group_size: size })
async function firstRound(div) {
  const ms = must(await svc.from('matches').select('id, slot, round, team_a_id, team_b_id, qualifier_label_a, qualifier_label_b, status, score')
    .eq('division_id', div.id).eq('stage', 'FINALS').order('slot'), '본선')
  const n = (ms.length + 1) / 2   // 전체 = 2n−1 경기, 첫 라운드 = n 경기 (slot 순서상 맨 앞)
  return ms.slice(0, n)
}
// 이웃 조 교차: 홀수 k ↔ k+1
const partner = k => (k % 2 === 1 ? k + 1 : k - 1)

async function main() {
  const ev = await makeEvent()

  console.log('\nS1 32팀·2팀 조 전체 랭킹제')
  const A = await makeDiv(ev, '가부', 1), rA = await makeTeams(ev, A, 32, 32)
  let r = await gen(ev, A, 2)
  ok(!r.error && r.data?.groups_created === 16 && r.data?.seeds === 32, `조편성 16개 조, 시드 32`, r.error?.message || r.data)
  let gA = await groupsOf(A, rA)
  ok(gA.every(g => g.ranks.join() === `${g.num},${33 - g.num}`), 'k조 = k위·(33−k)위 (1번 자리가 상위)', gA.map(g => g.ranks))
  console.log('      ' + gA.slice(0, 3).map(g => `${g.num}조 ${g.ranks.join('·')}`).join(' | ') + ` … 16조 ${gA[15].ranks.join('·')}`)

  console.log('\nS2 조별 경기 → 1조만 이변 → 본선 자리')
  r = await svc.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: A.id })
  ok(!r.error, `조별 경기 생성 (${r.data?.matches_created}경기)`, r.error?.message)
  const gmA = must(await svc.from('matches').select('id, group_id, team_a_id, team_b_id').eq('division_id', A.id).eq('stage', 'GROUP'), '조별')
  ok(gmA.length === 16, `조별 16경기`, gmA.length)
  const g1 = gA[0].id
  for (const m of gmA) {
    const [hi, lo] = rA.get(m.team_a_id) < rA.get(m.team_b_id) ? [m.team_a_id, m.team_b_id] : [m.team_b_id, m.team_a_id]
    const w = m.group_id === g1 ? lo : hi   // 1조만 32위가 1위를 이김
    const aWins = w === m.team_a_id
    must(await svc.from('matches').update({ status: 'FINISHED', score: aWins ? '6:3' : '3:6', winner_team_id: w }).eq('id', m.id), '결과')
  }
  r = await svc.rpc('rpc_generate_tournament', { p_event_id: ev.id, p_division_id: A.id, p_advance_per_group: 2, p_allow_tbd: false })
  ok(!r.error && r.data?.bracket_size === 32 && r.data?.byes === 0, `본선 32강 생성`, r.error?.message || r.data)
  let fr = await firstRound(A)
  const pairs = fr.map(m => [rA.get(m.team_a_id), rA.get(m.team_b_id)])
  const opp = rk => { const p = pairs.find(x => x.includes(rk)); return p ? p.find(x => x !== rk) : null }
  ok(pairs[0][0] === 32, `1번 시드 자리(맨 위)에 32위가 들어감 — 1위가 진 자리`, pairs[0])
  ok(opp(32) === 31, `32위(1조 1위) 상대 = 2조 2위(31위)`, opp(32))
  ok(opp(1) === 2, `1위(1조 2위)는 32위 자리로 — 상대 = 2조 1위(2위)`, opp(1))
  ok(opp(3) === 29 && opp(4) === 30, `3조 1위 vs 4조 2위(29위), 4조 1위 vs 3조 2위(30위)`, [opp(3), opp(4)])
  const halfOf = rk => (pairs.findIndex(x => x.includes(rk)) < 8 ? 0 : 1)
  ok(gA.every(g => halfOf(g.ranks[0]) !== halfOf(g.ranks[1])), '같은 조 두 팀은 모두 반대편 절반 (결승에서만 재대결)')
  ok(new Set(pairs.flat()).size === 32 && pairs.every(p => p[0] && p[1]), '32팀 모두 한 번씩 배치')
  console.log('      ' + pairs.slice(0, 4).map(p => p.join(' vs ')).join(' | ') + ' …')

  console.log('\nS3 48팀·3팀 조 + 미리 만든 본선(TBD)')
  const B = await makeDiv(ev, '나부', 2), rB = await makeTeams(ev, B, 48, 48)
  r = await gen(ev, B, 3)
  ok(!r.error && r.data?.groups_created === 16, `조편성 16개 조`, r.error?.message || r.data)
  const gB = await groupsOf(B, rB)
  ok(gB.every(g => g.ranks.join() === `${g.num},${33 - g.num},${32 + g.num}`), 'k조 = k위·(33−k)위·(32+k)위', gB.map(g => g.ranks))
  console.log('      ' + gB.slice(0, 2).map(g => `${g.num}조 ${g.ranks.join('·')}`).join(' | ') + ` … 16조 ${gB[15].ranks.join('·')}`)
  r = await svc.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: B.id })
  ok(!r.error, `조별 경기 생성 (${r.data?.matches_created}경기)`, r.error?.message)
  const gmB = must(await svc.from('matches').select('group_id, team_a_id, team_b_id, slot').eq('division_id', B.id).eq('stage', 'GROUP').order('slot'), '조별')
  const first1 = gmB.find(m => m.group_id === gB[0].id)
  ok(first1 && [rB.get(first1.team_a_id), rB.get(first1.team_b_id)].sort((a, b) => a - b).join() === '1,32', '1조 첫 경기 = 1위 vs 32위', first1 && [rB.get(first1.team_a_id), rB.get(first1.team_b_id)])
  r = await svc.rpc('rpc_generate_tournament', { p_event_id: ev.id, p_division_id: B.id, p_advance_per_group: 2, p_allow_tbd: true })
  ok(!r.error && r.data?.bracket_size === 32 && r.data?.tbd_slots === 32, `본선 미리 생성 (TBD 32자리)`, r.error?.message || r.data)
  fr = await firstRound(B)
  const lab = fr.map(m => [m.qualifier_label_a, m.qualifier_label_b])
  const wantOk = lab.every(([a, b]) => {
    const pa = /^(\d+)조 (\d)위$/.exec(a || ''), pb = /^(\d+)조 (\d)위$/.exec(b || '')
    if (!pa || !pb) return false
    const [one, two] = pa[2] === '1' ? [pa, pb] : [pb, pa]
    return one[2] === '1' && two[2] === '2' && Number(two[1]) === partner(Number(one[1]))
  })
  ok(wantOk, '모든 32강 = k조 1위 vs 이웃 조 2위 (1↔2, 3↔4 …)', lab)
  ok(lab[0][0] === '1조 1위' && lab[0][1] === '2조 2위', `맨 위 경기: ${lab[0].join(' vs ')}`)
  console.log('      ' + lab.slice(0, 4).map(p => p.join(' vs ')).join(' | ') + ' …')

  console.log('\nS4 47팀·3팀 조')
  const C = await makeDiv(ev, '다부', 3), rC = await makeTeams(ev, C, 47, 47)
  r = await gen(ev, C, 3)
  const gC = await groupsOf(C, rC)
  ok(!r.error && gC.length === 16 && gC[15].ranks.join() === '16,17' && gC[14].ranks.join() === '15,18,47', '16개 조, 마지막 조만 2팀 (16위·17위)', gC.slice(13).map(g => g.ranks))
  ok(gC.slice(0, 15).every(g => g.ranks.join() === `${g.num},${33 - g.num},${32 + g.num}`), '나머지 15개 조는 지그재그 그대로')

  console.log('\nS5 시드 없는 부서 (기존 동작)')
  const D = await makeDiv(ev, '라부', 4), rD = await makeTeams(ev, D, 16, 0)
  r = await gen(ev, D, 2)
  ok(!r.error && r.data?.groups_created === 8 && r.data?.seeds === 0, '조편성 8개 조 (랜덤)', r.error?.message || r.data)
  const gD = await groupsOf(D, rD)
  r = await svc.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: D.id })
  r = await svc.rpc('rpc_generate_tournament', { p_event_id: ev.id, p_division_id: D.id, p_advance_per_group: 2, p_allow_tbd: true })
  ok(!r.error && r.data?.bracket_size === 16 && r.data?.tbd_slots === 16, '본선 16강 미리 생성', r.error?.message || r.data)
  fr = await firstRound(D)
  const pos = new Map()
  fr.forEach((m, i) => [m.qualifier_label_a, m.qualifier_label_b].forEach(l => pos.set(l, i < 4 ? 0 : 1)))
  ok(pos.size === 16 && gD.every(g => pos.get(`${g.num}조 1위`) !== pos.get(`${g.num}조 2위`)), '16자리 모두 채워지고 같은 조는 반대편 절반')

  console.log('\nS6 상위 시드만 (16팀·4팀 조·시드 4)')
  const E = await makeDiv(ev, '마부', 5), rE = await makeTeams(ev, E, 16, 4)
  r = await gen(ev, E, 4)
  const gE = await groupsOf(E, rE)
  ok(!r.error && gE.length === 4 && gE.every(g => g.ranks[0] === g.num), '시드 k번 = k조 첫 자리', gE.map(g => g.ranks))
  ok(gE.every(g => g.ranks.slice(1).every(x => x > 4)), '나머지 자리는 비시드 팀 (추첨)')
}

const mode = process.argv[2]
if (mode === 'cleanup') { await cleanup(); process.exit(0) }
try { await main() } catch (e) { console.error('💥', e.stack || e.message); fail++ }
finally { if (mode !== 'keep') await cleanup() }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`)
process.exit(fail ? 1 : 0)
