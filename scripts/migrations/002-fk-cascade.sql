-- ============================================================
-- 002: 단체전 FK cascade 안전화
--
-- 문제: tie_rubbers.winning_club_id → clubs(id) FK에
--       ON DELETE CASCADE/SET NULL이 없어서, 운영자가
--       "이벤트 삭제" 시 FK 위반으로 실패함.
--
-- 해결: ON DELETE SET NULL — 클럽이 삭제되면 winning_club_id를
--       NULL로 (러버 기록은 보존)
--
-- 실행일: 2026-04-15
-- ============================================================

BEGIN;

-- 1. tie_rubbers.winning_club_id
ALTER TABLE tie_rubbers
  DROP CONSTRAINT IF EXISTS tie_rubbers_winning_club_id_fkey;
ALTER TABLE tie_rubbers
  ADD CONSTRAINT tie_rubbers_winning_club_id_fkey
  FOREIGN KEY (winning_club_id) REFERENCES clubs(id) ON DELETE SET NULL;

-- 2. tie_rubbers player FK 4개
ALTER TABLE tie_rubbers
  DROP CONSTRAINT IF EXISTS tie_rubbers_club_a_player1_id_fkey,
  DROP CONSTRAINT IF EXISTS tie_rubbers_club_a_player2_id_fkey,
  DROP CONSTRAINT IF EXISTS tie_rubbers_club_b_player1_id_fkey,
  DROP CONSTRAINT IF EXISTS tie_rubbers_club_b_player2_id_fkey;

ALTER TABLE tie_rubbers
  ADD CONSTRAINT tie_rubbers_club_a_player1_id_fkey
    FOREIGN KEY (club_a_player1_id) REFERENCES club_members(id) ON DELETE SET NULL,
  ADD CONSTRAINT tie_rubbers_club_a_player2_id_fkey
    FOREIGN KEY (club_a_player2_id) REFERENCES club_members(id) ON DELETE SET NULL,
  ADD CONSTRAINT tie_rubbers_club_b_player1_id_fkey
    FOREIGN KEY (club_b_player1_id) REFERENCES club_members(id) ON DELETE SET NULL,
  ADD CONSTRAINT tie_rubbers_club_b_player2_id_fkey
    FOREIGN KEY (club_b_player2_id) REFERENCES club_members(id) ON DELETE SET NULL;

-- 3. ties.winning_club_id
ALTER TABLE ties
  DROP CONSTRAINT IF EXISTS ties_winning_club_id_fkey;
ALTER TABLE ties
  ADD CONSTRAINT ties_winning_club_id_fkey
  FOREIGN KEY (winning_club_id) REFERENCES clubs(id) ON DELETE SET NULL;

-- 4. tie_rubbers (tie_id, rubber_number) UNIQUE (중복 insert race 차단)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tie_rubbers_tie_rubber_uq'
  ) THEN
    ALTER TABLE tie_rubbers
      ADD CONSTRAINT tie_rubbers_tie_rubber_uq UNIQUE (tie_id, rubber_number);
  END IF;
END $$;

COMMIT;

-- 검증
SELECT conname,
  CASE confdeltype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
  END AS on_delete
FROM pg_constraint
WHERE conrelid = 'tie_rubbers'::regclass AND contype = 'f'
ORDER BY conname;
-- 기대: 모든 FK가 SET NULL (tie_id는 CASCADE 유지)
