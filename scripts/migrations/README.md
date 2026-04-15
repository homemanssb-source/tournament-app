# DB Migrations

2026-04-15 세션에서 적용한 모든 SQL 마이그레이션을 번호순으로 보관.

## 적용 순서

| # | 파일 | 내용 | 상태 |
|---|---|---|---|
| 001 | `001-drop-legacy-rpc-create-team-groups.sql` | Legacy 3-arg RPC 제거 | ✅ 적용됨 |
| 002 | `002-fk-cascade.sql` | FK ON DELETE SET NULL + tie_rubbers UNIQUE | ✅ 적용됨 |
| 003 | `003-rpc-calculate-standings-division.sql` | division_id 파라미터 추가 (C3) | ✅ 적용됨 |
| 004 | `004-rpc-tie-result-and-advance-winner.sql` | F2 자동진출 위생 + division 전달 | ✅ 적용됨 |
| 005 | `005-rpc-create-team-groups-v2.sql` | 1팀 조 로직 개인전과 동일화 | ✅ 적용됨 |
| 006 | `006-pin-hash-cleanup.sql` | pin_hash 컬럼 삭제 + rpc_pin_login 정리 | ✅ 적용됨 |
| 007 | `007-pin-rate-limiting.sql` | PIN 5회 실패 → 10분 잠금 | ✅ 적용됨 |

## 대상 DB

- Supabase: `https://epgvcudkckrgpsegzbyp.supabase.co`

## 실행 방법

Supabase 대시보드 → SQL Editor → 파일 내용 붙여넣기 → Run

이미 적용된 상태라 재실행해도 `IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`
패턴이라 대부분 멱등적(idempotent)입니다. 재실행 시 SCHEMA 자체는 불변.

## 회귀 테스트

적용 후 검증:

```bash
node scripts/e2e-team-tournament.mjs
```

6 시나리오가 모두 통과해야 정상:
- #1 full_league (4팀 3복식)
- #2 tied_results (동률 감지)
- #3 group_tournament (조별→토너먼트)
- #4 five_doubles (5복식)
- #5 multi_division (부서별 순위 분리)
- #6 pin_rate_limit (잠금 검증)

## 운영 팁

### PIN 잠금 수동 해제
```sql
-- 특정 클럽
DELETE FROM pin_attempts WHERE target_key = 'club:{club_id}';

-- 특정 러버
DELETE FROM pin_attempts WHERE target_key = 'rubber:{rubber_id}';

-- 전체 초기화
TRUNCATE pin_attempts;
```

### 잔여 테스트 데이터 확인
```sql
SELECT id, name FROM events WHERE name LIKE '__TEST_%';
```

### E2E cleanup 수동 실행
E2E 스크립트가 중단되어 잔여 테스트 이벤트가 남았을 때:

```sql
-- 특정 이벤트 안전 삭제 (FK 순서 보장)
DELETE FROM tie_rubbers WHERE tie_id IN (SELECT id FROM ties WHERE event_id = '{id}');
DELETE FROM team_lineups WHERE tie_id IN (SELECT id FROM ties WHERE event_id = '{id}');
DELETE FROM ties WHERE event_id = '{id}';
DELETE FROM team_standings WHERE event_id = '{id}';
DELETE FROM club_members WHERE club_id IN (SELECT id FROM clubs WHERE event_id = '{id}');
DELETE FROM groups WHERE event_id = '{id}';
DELETE FROM clubs WHERE event_id = '{id}';
DELETE FROM divisions WHERE event_id = '{id}';
DELETE FROM events WHERE id = '{id}';
```

## 롤백 가이드

각 마이그레이션 롤백 방법:

- **001**: 레거시 v1 함수 복원 필요 (원본 본문 별도 백업 필요 — 이미 삭제됨)
- **002**: FK를 NO ACTION으로 되돌리거나 이전 제약으로 교체
- **003**: `DROP FUNCTION rpc_calculate_standings(uuid, uuid, uuid); CREATE ... (uuid, uuid);`
- **004**: git blame으로 이전 commit 본문 복구 + CREATE OR REPLACE
- **005**: 이전 분배 로직으로 CREATE OR REPLACE
- **006**: `ALTER TABLE teams ADD COLUMN pin_hash text;` (원 데이터 복구 불가)
- **007**: `DROP TABLE pin_attempts CASCADE; DROP FUNCTION _pin_*;` + RPC 3개 이전 본문 복구

일반적으로 **롤백보다는 forward-fix(새 마이그레이션)** 권장.
