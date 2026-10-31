// 040 오프라인 검증 (PGlite) — 실서버 DB를 건드리지 않음
//   준비: 아무 빈 폴더에서 npm i @electric-sql/pglite@0.2.17 후 이 파일을 그 폴더로 복사
//   실행: node test-040-pglite.mjs <phase2-frontend/scripts/migrations 경로>
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'fs'
const db = new PGlite()
let pass = 0, fail = 0
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) }
const one = async (sql, params) => (await db.query(sql, params)).rows[0]
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE public.ties (id int PRIMARY KEY, status text, court_number int, started_at timestamptz, ended_at timestamptz);
INSERT INTO ties VALUES (1, 'lineup_ready', 1, NULL, NULL), (2, 'pending', 2, NULL, NULL), (3, 'completed', 3, NULL, NULL);
`)
await db.exec(readFileSync(`${process.argv[2]}/040-tie-status-times.sql`, 'utf8'))
await db.exec(readFileSync(`${process.argv[2]}/040-tie-status-times.sql`, 'utf8'))   // 멱등
let r
await db.exec(`UPDATE ties SET status = 'in_progress' WHERE id = 1`)
r = await one(`SELECT * FROM ties WHERE id = 1`); check(r.started_at && !r.ended_at, '① in_progress → started_at', r)
const st = r.started_at
await db.exec(`UPDATE ties SET status = 'in_progress', court_number = 4 WHERE id = 1`)
r = await one(`SELECT * FROM ties WHERE id = 1`); check(+r.started_at === +st, '② 같은 상태 다시 저장 → started_at 그대로', r)
await db.exec(`UPDATE ties SET status = 'completed' WHERE id = 1`)
r = await one(`SELECT * FROM ties WHERE id = 1`); check(r.ended_at && +r.started_at === +st, '③ completed → ended_at', r)
await db.exec(`UPDATE ties SET court_number = 5 WHERE id = 1`)
r = await one(`SELECT * FROM ties WHERE id = 1`); check(!!r.ended_at, '④ 상태 그대로 다른 칸 수정 → ended_at 유지', r)
await db.exec(`UPDATE ties SET status = 'in_progress' WHERE id = 1`)
r = await one(`SELECT * FROM ties WHERE id = 1`); check(!r.ended_at && +r.started_at === +st, '⑤ 정정으로 다시 열림 → ended_at 비움, started_at 유지', r)
await db.exec(`UPDATE ties SET status = 'completed' WHERE id = 2`)
r = await one(`SELECT * FROM ties WHERE id = 2`); check(r.ended_at && !r.started_at, '⑥ 한 번에 completed (진행중 거치지 않음) → ended_at 만', r)
await db.exec(`UPDATE ties SET status = 'in_progress', started_at = '2026-10-31T01:00:00Z' WHERE id = 3`)
r = await one(`SELECT * FROM ties WHERE id = 3`); check(r.started_at.toISOString() === '2026-10-31T01:00:00.000Z', '⑦ 대시보드가 started_at 직접 넣으면 그 값', r)
console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
