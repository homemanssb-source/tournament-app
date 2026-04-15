-- ============================================================
-- 단체전 FK cascade 안전화 마이그레이션
--
-- 문제: tie_rubbers.winning_club_id → clubs(id) FK에
--       ON DELETE CASCADE/SET NULL이 없어서, 운영자가
--       "이벤트 삭제" 시 FK 위반으로 실패함.
--
-- 해결: ON DELETE SET NULL — 클럽이 삭제되면 winning_club_id를
--       NULL로 (러버 기록은 보존)
--
-- 영향: 운영자가 이벤트/클럽 삭제 시 자동 cascade 가능
--       기존 데이터에는 영향 없음 (제약만 변경)
--
-- 실행: Supabase SQL Editor에서 아래 블록 실행
-- ============================================================

BEGIN;

-- 1. tie_rubbers.winning_club_id FK 재정의
ALTER TABLE tie_rubbers
  DROP CONSTRAINT IF EXISTS tie_rubbers_winning_club_id_fkey;

ALTER TABLE tie_rubbers
  ADD CONSTRAINT tie_rubbers_winning_club_id_fkey
  FOREIGN KEY (winning_club_id) REFERENCES clubs(id) ON DELETE SET NULL;

-- 2. tie_rubbers.club_*_player*_id FK도 같은 패턴 (선수 삭제 안전화)
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

-- 3. ties.winning_club_id도 같은 처리
ALTER TABLE ties
  DROP CONSTRAINT IF EXISTS ties_winning_club_id_fkey;

ALTER TABLE ties
  ADD CONSTRAINT ties_winning_club_id_fkey
  FOREIGN KEY (winning_club_id) REFERENCES clubs(id) ON DELETE SET NULL;

-- 4. (선택) tie_rubbers (tie_id, rubber_number) UNIQUE 제약 — 조건부 추가
--    프론트의 동시 insert 방지 race window 완전 차단
--    ※ 기존 데이터에 중복 없음을 확인 후 실행:
--    SELECT tie_id, rubber_number, COUNT(*) FROM tie_rubbers
--    GROUP BY tie_id, rubber_number HAVING COUNT(*) > 1;
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

-- ============================================================
-- 검증 쿼리 (실행 후 확인)
-- ============================================================
SELECT
  conname,
  confdeltype,
  CASE confdeltype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS on_delete
FROM pg_constraint
WHERE conrelid = 'tie_rubbers'::regclass
  AND contype = 'f'
ORDER BY conname;
