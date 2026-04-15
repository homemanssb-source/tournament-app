-- ============================================================
-- 003: rpc_calculate_standings에 division_id 파라미터 추가 (C3 근본)
--
-- 배경:
--   풀리그 모드 다부서 대회에서 group_id=NULL로 모든 클럽이 섞여
--   순위가 부서 간 혼재되는 버그
--
-- 해결: p_division_id uuid DEFAULT NULL 추가
--       clubs와 JOIN해서 division 필터링
--
-- 주의: 기존 2-arg 오버로드 삭제 (PostgREST overload 충돌 방지)
--
-- 실행일: 2026-04-15
-- ============================================================

-- 기존 2-arg 버전 삭제
DROP FUNCTION IF EXISTS public.rpc_calculate_standings(uuid, uuid);

CREATE OR REPLACE FUNCTION public.rpc_calculate_standings(
  p_event_id    uuid,
  p_group_id    uuid DEFAULT NULL,
  p_division_id uuid DEFAULT NULL
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_rec RECORD;
  v_rank INT := 0;
BEGIN
  -- 각 클럽 성적 재계산 (수동 확정 제외 + division 필터)
  FOR v_rec IN
    SELECT ts.id AS standing_id, ts.club_id
    FROM team_standings ts
    JOIN clubs c ON c.id = ts.club_id
    WHERE ts.event_id = p_event_id
      AND ((p_group_id IS NULL AND ts.group_id IS NULL) OR ts.group_id = p_group_id)
      AND (p_division_id IS NULL OR c.division_id = p_division_id)
      AND ts.rank_locked = false
  LOOP
    UPDATE team_standings SET
      played = (
        SELECT COUNT(*) FROM ties t
        WHERE t.event_id = p_event_id
          AND (t.club_a_id = v_rec.club_id OR t.club_b_id = v_rec.club_id)
          AND t.status = 'completed'
          AND t.is_bye = false
          AND ((p_group_id IS NULL AND t.group_id IS NULL) OR t.group_id = p_group_id)
      ),
      won = (
        SELECT COUNT(*) FROM ties t
        WHERE t.event_id = p_event_id
          AND t.winning_club_id = v_rec.club_id
          AND t.status = 'completed'
          AND ((p_group_id IS NULL AND t.group_id IS NULL) OR t.group_id = p_group_id)
      ),
      lost = (
        SELECT COUNT(*) FROM ties t
        WHERE t.event_id = p_event_id
          AND (t.club_a_id = v_rec.club_id OR t.club_b_id = v_rec.club_id)
          AND t.status = 'completed'
          AND t.winning_club_id IS NOT NULL
          AND t.winning_club_id != v_rec.club_id
          AND ((p_group_id IS NULL AND t.group_id IS NULL) OR t.group_id = p_group_id)
      ),
      rubbers_for = (
        SELECT coalesce(SUM(CASE
          WHEN t.club_a_id = v_rec.club_id THEN t.club_a_rubbers_won
          WHEN t.club_b_id = v_rec.club_id THEN t.club_b_rubbers_won
          ELSE 0 END), 0)
        FROM ties t
        WHERE t.event_id = p_event_id
          AND (t.club_a_id = v_rec.club_id OR t.club_b_id = v_rec.club_id)
          AND t.status = 'completed'
          AND ((p_group_id IS NULL AND t.group_id IS NULL) OR t.group_id = p_group_id)
      ),
      rubbers_against = (
        SELECT coalesce(SUM(CASE
          WHEN t.club_a_id = v_rec.club_id THEN t.club_b_rubbers_won
          WHEN t.club_b_id = v_rec.club_id THEN t.club_a_rubbers_won
          ELSE 0 END), 0)
        FROM ties t
        WHERE t.event_id = p_event_id
          AND (t.club_a_id = v_rec.club_id OR t.club_b_id = v_rec.club_id)
          AND t.status = 'completed'
          AND ((p_group_id IS NULL AND t.group_id IS NULL) OR t.group_id = p_group_id)
      )
    WHERE id = v_rec.standing_id;
  END LOOP;

  -- rubber_diff 계산
  UPDATE team_standings ts
  SET rubber_diff = ts.rubbers_for - ts.rubbers_against
  FROM clubs c
  WHERE c.id = ts.club_id
    AND ts.event_id = p_event_id
    AND ((p_group_id IS NULL AND ts.group_id IS NULL) OR ts.group_id = p_group_id)
    AND (p_division_id IS NULL OR c.division_id = p_division_id)
    AND ts.rank_locked = false;

  -- 순위 부여
  v_rank := 0;
  FOR v_rec IN
    SELECT ts.id
    FROM team_standings ts
    JOIN clubs c ON c.id = ts.club_id
    WHERE ts.event_id = p_event_id
      AND ((p_group_id IS NULL AND ts.group_id IS NULL) OR ts.group_id = p_group_id)
      AND (p_division_id IS NULL OR c.division_id = p_division_id)
      AND ts.rank_locked = false
    ORDER BY ts.won DESC, ts.rubber_diff DESC
  LOOP
    v_rank := v_rank + 1;
    UPDATE team_standings SET rank = v_rank WHERE id = v_rec.id;
  END LOOP;

  -- 동률 감지 (rank=NULL로 표시, 수동 결정 필요)
  UPDATE team_standings ts1
  SET rank = NULL
  FROM clubs c1
  WHERE c1.id = ts1.club_id
    AND ts1.event_id = p_event_id
    AND ((p_group_id IS NULL AND ts1.group_id IS NULL) OR ts1.group_id = p_group_id)
    AND (p_division_id IS NULL OR c1.division_id = p_division_id)
    AND ts1.rank_locked = false
    AND ts1.played > 0
    AND EXISTS (
      SELECT 1 FROM team_standings ts2
      JOIN clubs c2 ON c2.id = ts2.club_id
      WHERE ts2.event_id = p_event_id
        AND ((p_group_id IS NULL AND ts2.group_id IS NULL) OR ts2.group_id = p_group_id)
        AND (p_division_id IS NULL OR c2.division_id = p_division_id)
        AND ts2.id != ts1.id
        AND ts2.won = ts1.won
        AND ts2.rubber_diff = ts1.rubber_diff
        AND ts2.rank_locked = false
    );

  RETURN json_build_object('success', true);
END;
$function$;

-- 검증
SELECT proname, pg_get_function_identity_arguments(oid) AS sig
FROM pg_proc WHERE proname = 'rpc_calculate_standings';
-- 기대: p_event_id uuid, p_group_id uuid, p_division_id uuid
