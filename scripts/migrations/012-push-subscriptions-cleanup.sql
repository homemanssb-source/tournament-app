-- ============================================================
-- 012: push_subscriptions 정리 + FK cascade
--
-- 배경:
--   진단 결과 (2026-04-17):
--     · 고아 구독 12건 (team/club 삭제됐는데 row 남음)
--     · permanently-removed.invalid 1건 (410이 안 와서 정리 못 함)
--   → 발송 시 매번 이 dead endpoint에 시도하다가 일부 실패 유발
--
-- 수정:
--   ① 만료된/고아 구독 삭제
--   ② team_id에 trigger 또는 application-level cleanup
--      (teams/clubs 같은 id 공간이라 FK 하나만 걸 수 없음 → trigger로)
--
-- 실행일: 2026-04-17
-- ============================================================

-- Step 1: 확실히 만료된 endpoint 정리
DELETE FROM push_subscriptions
WHERE endpoint LIKE '%permanently-removed%'
   OR endpoint LIKE '%invalid%';

-- Step 2: 고아 구독 정리 (team_id가 teams/clubs 어디에도 없음)
DELETE FROM push_subscriptions
WHERE team_id NOT IN (SELECT id FROM teams)
  AND team_id NOT IN (SELECT id FROM clubs);

-- Step 3: teams/clubs 삭제 시 push_subscriptions도 자동 삭제되는 trigger
--   (team_id는 teams.id 또는 clubs.id를 가리키므로 FK 하나로 못 묶음)
CREATE OR REPLACE FUNCTION _cleanup_push_subscriptions_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM push_subscriptions WHERE team_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_push_subs_team ON teams;
CREATE TRIGGER trg_cleanup_push_subs_team
  BEFORE DELETE ON teams
  FOR EACH ROW EXECUTE FUNCTION _cleanup_push_subscriptions_on_delete();

DROP TRIGGER IF EXISTS trg_cleanup_push_subs_club ON clubs;
CREATE TRIGGER trg_cleanup_push_subs_club
  BEFORE DELETE ON clubs
  FOR EACH ROW EXECUTE FUNCTION _cleanup_push_subscriptions_on_delete();

-- 검증
SELECT
  (SELECT COUNT(*) FROM push_subscriptions) AS total_subs,
  (SELECT COUNT(*) FROM push_subscriptions WHERE endpoint LIKE '%invalid%' OR endpoint LIKE '%permanently-removed%') AS dead_endpoints,
  (SELECT COUNT(*) FROM push_subscriptions s
   WHERE s.team_id NOT IN (SELECT id FROM teams)
     AND s.team_id NOT IN (SELECT id FROM clubs)) AS orphans;
