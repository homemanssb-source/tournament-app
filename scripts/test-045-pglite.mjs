// 045 오프라인 검증 (PGlite) — 실서버 DB를 건드리지 않음
//   준비: 아무 빈 폴더에서 npm i @electric-sql/pglite@0.2.17 후 그 폴더에서 실행
//   실행: node <이 파일 경로> <phase2-frontend/scripts 경로>
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'
const { PGlite } = createRequire(process.cwd() + '/')('@electric-sql/pglite')
const S = process.argv[2]
const { seatBracket } = await import(pathToFileURL(`${S}/sim-hyeophoe/seat.mjs`).href)
const read = f => readFileSync(`${S}/migrations/${f}`, 'utf8')
let pass = 0, fail = 0
const check = (ok, label, detail) => { ok ? pass++ : fail++; if (!ok || process.argv.includes('-v')) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) }

const SCHEMA = `
CREATE TABLE divisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, name text);
CREATE TABLE group_settings (id uuid DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, division_name text, teams_per_group int, advance_count int, random_assign boolean, UNIQUE(event_id, division_id));
CREATE TABLE groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, division_name text, group_label text, group_num int, advance_count int);
CREATE TABLE teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, rk int, seed_number smallint, group_id uuid);
CREATE TABLE group_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, group_id uuid, team_id uuid, seq int);
CREATE TABLE matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), match_num text, event_id uuid, division_id uuid, division_name text, stage text, round text, slot int,
  status text, is_tbd_bracket boolean, group_id uuid, team_a_id uuid, team_b_id uuid, qualifier_label_a text, qualifier_label_b text, winner_team_id uuid, score text, ended_at timestamptz);
CREATE TABLE bracket_nodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, division_id uuid, division_name text, round text, match_id uuid, next_match_id uuid, next_slot text, lock boolean);
CREATE FUNCTION size_to_round(s int) RETURNS text LANGUAGE sql AS $$ SELECT CASE WHEN s = 2 THEN '결승' ELSE s || '강' END $$;
CREATE FUNCTION next_match_num(p_event_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'M-' || lpad((COALESCE((SELECT COUNT(*) FROM matches WHERE event_id = p_event_id), 0) + 1)::text, 4, '0') $$;
CREATE FUNCTION fn_group_game_diff(p_event_id uuid, p_division_id uuid) RETURNS TABLE(team_id uuid, game_diff int) LANGUAGE sql AS $$ SELECT NULL::uuid, 0 WHERE false $$;
`
const mk = async sqlFile => { const db = new PGlite(); await db.exec(SCHEMA); await db.exec(read(sqlFile)); return db }
const NEW = await mk('045-ranking-seat-rules.sql'), OLD = await mk('045-rollback.sql')
await NEW.exec(read('045-ranking-seat-rules.sql')); check(true, '045 재실행(멱등) 오류 없음')
const EV = '00000000-0000-0000-0000-000000000001'
const q = async (db, sql, p) => (await db.query(sql, p)).rows

// 부서 하나 만들고 조편성 → (선택) 조 경기 끝냄 → 본선 생성. seeds = 시드 줄 팀 수 (1위부터)
async function run(db, n, size, seeds, { finish = false, tbd = true } = {}) {
  await db.exec('DELETE FROM bracket_nodes; DELETE FROM matches; DELETE FROM group_members; DELETE FROM groups; DELETE FROM teams; DELETE FROM group_settings; DELETE FROM divisions;')
  const D = (await q(db, `INSERT INTO divisions(event_id, name) VALUES ($1, '가부') RETURNING id`, [EV]))[0].id
  await q(db, `INSERT INTO teams(event_id, division_id, rk, seed_number) SELECT $1, $2, g, CASE WHEN g <= $4 THEN g END FROM generate_series(1, $3) g`, [EV, D, n, seeds])
  const g = (await q(db, `SELECT rpc_generate_groups($1, $2, $3) r`, [EV, D, size]))[0].r
  const groups = await q(db, `SELECT g.group_num, array_agg(t.rk ORDER BY gm.seq) ranks FROM groups g JOIN group_members gm ON gm.group_id = g.id JOIN teams t ON t.id = gm.team_id WHERE g.division_id = $1 GROUP BY g.group_num ORDER BY g.group_num`, [D])
  if (finish) {
    // 조마다 모든 대진을 만들고 순위가 높은(숫자 작은) 팀이 이기게 → 조 1위 = 첫 자리, 2위 = 둘째 자리
    await q(db, `INSERT INTO matches(match_num, event_id, division_id, stage, round, slot, status, group_id, team_a_id, team_b_id, winner_team_id, score)
      SELECT 'G', $1, $2, 'GROUP', '조별', row_number() OVER (), 'FINISHED', a.group_id, a.team_id, b.team_id, a.team_id, '6:0'
      FROM group_members a JOIN group_members b ON b.group_id = a.group_id AND a.seq < b.seq WHERE a.division_id = $2`, [EV, D])
  }
  const r = (await q(db, `SELECT rpc_generate_tournament($1, $2, 2, $3) r`, [EV, D, tbd]))[0].r
  const fr = await q(db, `SELECT m.qualifier_label_a a, m.qualifier_label_b b, ta.rk ra, tb.rk rb, m.status, m.score FROM matches m LEFT JOIN teams ta ON ta.id = m.team_a_id LEFT JOIN teams tb ON tb.id = m.team_b_id
    WHERE m.division_id = $1 AND m.stage = 'FINALS' ORDER BY m.slot LIMIT $2`, [D, r.bracket_size / 2])
  return { g, r, groups: groups.map(x => x.ranks), fr }
}
function snake(total, sizes) {
  const ng = sizes.length, groups = sizes.map(() => [])
  for (let si = 1; si <= total; si++) { let g = ((si - 1) % ng) + 1; if (Math.floor((si - 1) / ng) % 2 === 1) g = ng - g + 1; while (groups[g - 1].length >= sizes[g - 1]) g = (g % ng) + 1; groups[g - 1].push(si) }
  return groups
}
const lab = x => (x ? `${x.g}조 ${x.r}위` : null)

console.log('1) 협회장배 세 부서 (확정안과 같은가)')
for (const [n, name] of [[20, '베테랑부'], [21, '여자베테랑부'], [40, '혼합복식']]) {
  const o = await run(NEW, n, 3, n)
  const sizes = o.groups.map(g => g.length), want = snake(n, [...sizes].sort((a, b) => a - b)), seat = seatBracket(sizes)
  check(JSON.stringify(sizes) === JSON.stringify([...sizes].sort((a, b) => a - b)), `${name} ${n}팀: 작은 조가 앞 번호`, sizes)
  check(JSON.stringify(o.groups) === JSON.stringify(want), `${name}: 조 배치 = 지그재그`, o.groups)
  const got = o.fr.map(m => [m.a, m.b]), exp = seat.first.map(m => m.map(lab))
  check(JSON.stringify(got) === JSON.stringify(exp), `${name}: 본선 첫 라운드 = 확정안`, { got, exp })
  console.log('   ' + got.map(m => `${m[0]} vs ${m[1] || '부전승'}`).join(' / '))
}

console.log('2) 전체 랭킹제 — 팀 수·조 크기 전수 (규칙 점검)')
let cmpSame = 0, cmpDiff = 0
for (const size of [2, 3, 4]) for (let n = 4; n <= 66; n++) {
  const o = await run(NEW, n, size, n)
  const sizes = o.groups.map(g => g.length), ng = sizes.length, tag = `${n}팀·${size}팀조`
  const total = ng * 2, bs = o.r.bracket_size, byes = bs - total, nfr = bs / 2
  if (JSON.stringify(sizes) !== JSON.stringify([...sizes].sort((a, b) => a - b))) check(false, tag + ' 작은 조 앞 번호', sizes)
  const labels = o.fr.flatMap(m => [m.a, m.b]).filter(Boolean)
  const all = []; for (let g = 1; g <= ng; g++) all.push(`${g}조 1위`, `${g}조 2위`)
  check(JSON.stringify([...labels].sort()) === JSON.stringify([...all].sort()), tag + ' 모든 조 1·2위가 한 번씩', labels)
  check(o.r.tbd_slots === total && o.fr.filter(m => !m.a || !m.b).length === byes, tag + ' 부전승 칸 수', [o.r, byes])
  if (byes > ng) continue   // 부전승이 조 수보다 많으면 기존 방식
  const pos = new Map(); o.fr.forEach((m, i) => { if (m.a) pos.set(m.a, i); if (m.b) pos.set(m.b, i) })
  const byeOf = g => { const m = o.fr[pos.get(`${g}조 1위`)]; return !m.a || !m.b }
  // 기대값(따로 계산): 3팀 조 먼저 → 부전승이 적은 절반 → 앞 번호. 1위의 절반은 실제 대진 위치로 판단
  const isSmall = g => sizes[g - 1] < 3, hf = g => (pos.get(`${g}조 1위`) < nfr / 2 ? 0 : 1), head = [], cnt = [0, 0]
  for (let i = 0; i < byes; i++) { const c = sizes.map((_, k) => k + 1).filter(g => !head.includes(g)).sort((a, b) => (isSmall(a) - isSmall(b)) || (cnt[hf(a)] - cnt[hf(b)]) || (a - b))[0]; head.push(c); cnt[hf(c)]++ }
  const bigN = [0, 0]; sizes.forEach((s, k) => { if (s >= 3) bigN[hf(k + 1)]++ })
  if (nfr > 1 && bigN[0] >= Math.ceil(byes / 2) && bigN[1] >= Math.ceil(byes / 2)) check(Math.abs(cnt[0] - cnt[1]) <= 1, tag + ' 부전승이 위·아래 절반에 고르게', cnt)
  const byeGroups = []; for (let g = 1; g <= ng; g++) if (byeOf(g)) byeGroups.push(g)
  check(JSON.stringify(byeGroups) === JSON.stringify([...head].sort((a, b) => a - b)), tag + ' 부전승 = 3팀 조 1위, 절반별 앞 번호부터', { byeGroups, head, sizes })
  check(o.fr.every(m => !(m.a === null && m.b !== null)) && pos.get('1조 1위') === 0 && (ng < 2 || pos.get('2조 1위') === nfr - 1 || nfr === 1), tag + ' 1조 1위 맨 위 · 2조 1위 맨 아래', [pos.get('1조 1위'), pos.get('2조 1위'), nfr])
  if (ng >= 4 && nfr >= 4) check(new Set([1, 2, 3, 4].map(g => Math.floor(pos.get(`${g}조 1위`) / (nfr / 4)))).size === 4, tag + ' 1~4조 1위가 서로 다른 4분의1')
  let r1 = 0, sameHalf = 0
  for (let g = 1; g <= ng; g++) { const a = pos.get(`${g}조 1위`), b = pos.get(`${g}조 2위`); if (a === b) r1++; if (nfr > 1 && (a < nfr / 2) === (b < nfr / 2)) sameHalf++ }
  check(r1 === 0 || ng === 1, tag + ' 같은 조가 첫 경기에서 만나지 않음', r1)
  const seat = seatBracket(sizes)
  if (JSON.stringify(o.fr.map(m => [m.a, m.b])) === JSON.stringify(seat.first.map(m => m.map(lab)))) cmpSame++; else { cmpDiff++; if (sameHalf > seat.sameHalf.length) check(false, tag + ' 같은 절반 조 수가 참고 계산보다 많음', [sameHalf, seat.sameHalf]) }
}
console.log(`   참고 계산(seat.mjs)과 완전히 같은 대진 ${cmpSame}건 / 다른 대진 ${cmpDiff}건`)

console.log('3) 조 경기가 끝난 뒤 생성 (자리 미정 아님)')
for (const n of [20, 40, 21]) {
  const o = await run(NEW, n, 3, n, { finish: true, tbd: false })
  const sizes = o.groups.map(g => g.length), seat = seatBracket(sizes)
  const exp = seat.first.map(m => m.map(x => (x ? o.groups[x.g - 1][x.r - 1] : null)))
  check(JSON.stringify(o.fr.map(m => [m.ra, m.rb])) === JSON.stringify(exp), `${n}팀: 팀이 확정안 자리에 들어감`, { got: o.fr.map(m => [m.ra, m.rb]), exp })
  check(o.fr.filter(m => m.score === 'BYE').length === o.r.byes && o.r.byes_applied === o.r.byes, `${n}팀: 부전승 ${o.r.byes}개 자동 처리`, o.r)
}

console.log('4) 전체 랭킹제가 아닌 부서는 그대로')
for (const [n, size] of [[20, 3], [41, 3], [19, 2], [33, 4]]) {
  const sizesOf = async db => (await run(db, n, size, 0)).groups.map(g => g.length)
  check(JSON.stringify(await sizesOf(NEW)) === JSON.stringify(await sizesOf(OLD)), `시드 없음 ${n}팀·${size}팀조: 조 크기 순서 그대로`)
  const ng = (await sizesOf(OLD)).length
  const a = await run(NEW, n, size, ng), b = await run(OLD, n, size, ng)   // 상위 ng팀만 시드 → 조마다 시드 1팀
  check(JSON.stringify(a.groups.map(g => [g.length, g[0]])) === JSON.stringify(b.groups.map(g => [g.length, g[0]])), `상위 ${ng}팀만 시드 ${n}팀: 조 크기·시드 자리 그대로`, [a.groups.map(g => g.length), b.groups.map(g => g.length)])
  check(JSON.stringify(a.fr.map(m => [m.a, m.b])) === JSON.stringify(b.fr.map(m => [m.a, m.b])), `상위 ${ng}팀만 시드 ${n}팀: 본선 대진이 기존 함수와 같음`, { new: a.fr.map(m => [m.a, m.b]), old: b.fr.map(m => [m.a, m.b]) })
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`)
process.exit(fail ? 1 : 0)
