-- ============================================================
-- 014: rpc_fill_team_tournament_slots — division_id 필터 누락 수정
--
-- 🚨 심각한 버그:
--   기존 함수가 토너먼트 슬롯 매칭 시 qualifier_label만 비교하고
--   division_id를 무시함. "A조 1위" 같은 라벨이 여러 부서에 존재하면
--   한 부서 결과가 모든 부서 본선에 동시에 채워짐.
--
-- 영향:
--   3부 group A 1위가 결정되면 → 2부 본선, 여성부 본선의 "A조 1위" 슬롯에도
--   3부 클럽 club_id가 잘못 들어감
--   → 24건 본선 슬롯 오염 확인 (2026-04-18 진단)
--
-- 수정:
--   FOR v_tie IN ... WHERE에 division_id 필터 추가
--   IS NOT DISTINCT FROM 사용 (NULL 대비)
--
-- 실행일: 2026-04-18
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_fill_team_tournament_slots(p_event_id uuid, p_group_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group        RECORD;
  v_standings    RECORD;
  v_tie          RECORD;
  v_tie_updated  RECORD;
  v_filled       int := 0;
BEGIN
  SELECT * INTO v_group FROM groups WHERE id = p_group_id;
  IF v_group IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '그룹을 찾을 수 없습니다.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM ties
    WHERE event_id = p_event_id
      AND group_id = p_group_id
      AND round = 'group'
      AND is_bye = false
      AND status != 'completed'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', '조 경기가 아직 완료되지 않았습니다.');
  END IF;

  FOR v_standings IN
    SELECT ts.club_id, ts.rank
    FROM team_standings ts
    WHERE ts.event_id = p_event_id
      AND ts.group_id = p_group_id
    ORDER BY ts.rank ASC
  LOOP
    FOR v_tie IN
      SELECT id, qualifier_label_a, qualifier_label_b, rubber_count
      FROM ties
      WHERE event_id = p_event_id
        AND round IN ('round_of_16', 'quarter', 'semi', 'final')
        -- ✅ FIX: 부서 필터 추가 (같은 group_label이 다른 부서에도 있으면 오염)
        AND division_id IS NOT DISTINCT FROM v_group.division_id
        AND (
          qualifier_label_a = v_group.group_label || ' ' || v_standings.rank || '위'
          OR qualifier_label_b = v_group.group_label || ' ' || v_standings.rank || '위'
        )
    LOOP
      IF v_tie.qualifier_label_a = v_group.group_label || ' ' || v_standings.rank || '위' THEN
        UPDATE ties SET club_a_id = v_standings.club_id, qualifier_label_a = NULL WHERE id = v_tie.id;
        v_filled := v_filled + 1;
      END IF;

      IF v_tie.qualifier_label_b = v_group.group_label || ' ' || v_standings.rank || '위' THEN
        UPDATE ties SET club_b_id = v_standings.club_id, qualifier_label_b = NULL WHERE id = v_tie.id;
        v_filled := v_filled + 1;
      END IF;

      SELECT * INTO v_tie_updated FROM ties WHERE id = v_tie.id;

      IF v_tie_updated.club_a_id IS NOT NULL AND v_tie_updated.club_b_id IS NOT NULL AND v_tie_updated.is_bye = false THEN
        IF NOT EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = v_tie_updated.id) THEN
          FOR i IN 1..v_tie_updated.rubber_count LOOP
            INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
            VALUES (v_tie_updated.id, i, 'pending', LPAD(FLOOR(RANDOM()*1000000)::TEXT, 6, '0'));
          END LOOP;
        END IF;
      END IF;

      IF v_tie_updated.qualifier_label_a IS NULL AND v_tie_updated.qualifier_label_b IS NULL THEN
        IF v_tie_updated.club_a_id IS NOT NULL AND v_tie_updated.club_b_id IS NULL THEN
          UPDATE ties SET
            is_bye = true, status = 'bye',
            winning_club_id = v_tie_updated.club_a_id
          WHERE id = v_tie_updated.id;
          PERFORM rpc_advance_tournament_winner(v_tie_updated.id);

        ELSIF v_tie_updated.club_b_id IS NOT NULL AND v_tie_updated.club_a_id IS NULL THEN
          UPDATE ties SET
            is_bye = true, status = 'bye',
            winning_club_id = v_tie_updated.club_b_id
          WHERE id = v_tie_updated.id;
          PERFORM rpc_advance_tournament_winner(v_tie_updated.id);
        END IF;
      END IF;

    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'filled', v_filled);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
