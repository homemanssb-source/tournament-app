// 045 실서버 확인: 비공개 임시 대회를 만들어 조편성·본선 생성 RPC를 돌려 보고 지운다.
//   node scripts/sim-045-live.mjs          → 검사 후 삭제
//   node scripts/sim-045-live.mjs cleanup  → 남은 임시 대회 삭제
import { svc, must } from './sim-hyeophoe/common.mjs'
import { seatBracket } from './sim-hyeophoe/seat.mjs'
const PREFIX = '__TEST_SIM_045_', DATE = '2026-01-11'
let pass = 0, fail = 0
const ok = (c, msg, detail) => { console.log(`   ${c ? '✅' : '❌'} ${msg}${!c && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); c ? pass++ : fail++ }

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
  Object.assign(row, { name: PREFIX + 'individual', event_key: 'sim-045-' + Date.now(), status: 'preparing', date: DATE })   // 준비중 = 비공개
  for (const k of ['master_pin_hash', 'app_a_event_id', 'court_zones']) if (k in row) row[k] = null
  if ('app_a_connected' in row) row.app_a_connected = false
  if ('auto_fill_courts' in row) row.auto_fill_courts = false
  return must(await svc.from('events').insert(row).select().single(), '대회 생성')
}
function snake(total, sizes) {
  const ng = sizes.length, groups = sizes.map(() => [])
  for (let si = 1; si <= total; si++) { let g = ((si - 1) % ng) + 1; if (Math.floor((si - 1) / ng) % 2 === 1) g = ng - g + 1; while (groups[g - 1].length >= sizes[g - 1]) g = (g % ng) + 1; groups[g - 1].push(si) }
  return groups
}
const lab = x => (x ? `${x.g}조 ${x.r}위` : null)

async function division(ev, name, order, n, seeds, size) {
  const div = must(await svc.from('divisions').insert({ event_id: ev.id, name, sort_order: order, match_date: DATE }).select().single(), '부서')
  const rows = must(await svc.from('teams').insert(Array.from({ length: n }, (_, i) => ({
    event_id: ev.id, division_id: div.id, division_name: name, team_num: `${name}-${i + 1}`, team_key: `${div.id}|${i + 1}위|`,
    team_name: `${name}${i + 1}위`, player1_name: `${name}${i + 1}위`, p1_club: `클럽${i + 1}`, player2_name: '', seed_number: i < seeds ? i + 1 : null,
  }))).select('id, team_name'), '팀')
  const rk = new Map(rows.map(t => [t.id, Number(t.team_name.replace(name, '').replace('위', ''))]))
  const g = await svc.rpc('rpc_generate_groups', { p_event_id: ev.id, p_division_id: div.id, p_group_size: size })
  if (g.error) throw new Error('조편성: ' + g.error.message)
  const gs = must(await svc.from('groups').select('id, group_num').eq('division_id', div.id).order('group_num'), '조')
  const gm = must(await svc.from('group_members').select('group_id, team_id, seq').eq('division_id', div.id), '조원')
  const groups = gs.map(x => gm.filter(m => m.group_id === x.id).sort((a, b) => a.seq - b.seq).map(m => rk.get(m.team_id)))
  const gmr = await svc.rpc('rpc_generate_group_matches', { p_event_id: ev.id, p_division_id: div.id })
  if (gmr.error) throw new Error('조별 경기: ' + gmr.error.message)
  const t = await svc.rpc('rpc_generate_tournament', { p_event_id: ev.id, p_division_id: div.id, p_advance_per_group: 2, p_allow_tbd: true })
  if (t.error) throw new Error('본선: ' + t.error.message)
  const fin = must(await svc.from('matches').select('slot, qualifier_label_a, qualifier_label_b').eq('division_id', div.id).eq('stage', 'FINALS').order('slot'), '본선')
  return { groups, r: t.data, first: fin.slice(0, t.data.bracket_size / 2).map(m => [m.qualifier_label_a, m.qualifier_label_b]) }
}

async function main() {
  const ev = await makeEvent()
  for (const [name, n] of [['가부', 20], ['나부', 21], ['다부', 40]]) {
    console.log(`\n${name} ${n}팀 · 3팀 조 · 전체 랭킹제`)
    const o = await division(ev, name, 1, n, n, 3)
    const sizes = o.groups.map(g => g.length), seat = seatBracket(sizes)
    ok(JSON.stringify(o.groups) === JSON.stringify(snake(n, [...sizes].sort((a, b) => a - b))) && sizes[0] <= sizes[sizes.length - 1], `조 크기 ${sizes.join('·')} — 작은 조가 앞, 지그재그`, o.groups)
    ok(JSON.stringify(o.first) === JSON.stringify(seat.first.map(m => m.map(lab))), '본선 첫 라운드 = 규칙대로 (1조 1위 맨 위 · 2조 1위 맨 아래 · 부전승 3팀 조·위아래 고르게)', o.first)
    console.log('      ' + o.first.map(m => `${m[0]} vs ${m[1] || '부전승'}`).join(' / '))
  }
  console.log('\n라부 20팀 · 3팀 조 · 시드 없음 (기존 동작)')
  const p = await division(ev, '라부', 4, 20, 0, 3)
  const ps = p.groups.map(g => g.length)
  ok(JSON.stringify(ps) === JSON.stringify([3, 3, 3, 3, 3, 3, 2]), `조 크기 ${ps.join('·')} — 작은 조가 맨 뒤 그대로`, ps)
  ok(p.first.filter(m => !m[0] || !m[1]).length === 2 && p.first.flat().filter(Boolean).length === 14, '본선 16강 · 부전승 2 · 14자리', p.r)
  console.log('\n마부 20팀 · 3팀 조 · 상위 7팀만 시드 (기존 동작)')
  const q = await division(ev, '마부', 5, 20, 7, 3)
  const qs = q.groups.map(g => g.length)
  ok(JSON.stringify(qs) === JSON.stringify([3, 3, 3, 3, 3, 3, 2]) && q.groups.every((g, i) => g[0] === i + 1), `조 크기 ${qs.join('·')} · 시드 k번 = k조 첫 자리`, q.groups)
  ok(q.first[0][0] === '1조 1위' && q.first[0][1] === null && q.first[4][0] === '2조 1위', '본선: 1조 1위 맨 위(부전승), 2조 1위 아래쪽 절반 첫 줄 — 기존 배열 그대로', q.first)
}

const mode = process.argv[2]
if (mode === 'cleanup') { await cleanup(); process.exit(0) }
try { await main() } catch (e) { console.error('💥', e.stack || e.message); fail++ }
finally { await cleanup() }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`)
process.exit(fail ? 1 : 0)
