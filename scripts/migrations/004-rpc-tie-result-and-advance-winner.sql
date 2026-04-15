-- ============================================================
-- 004: F2 — rpc_calculate_tie_result + rpc_advance_tournament_winner
--
-- F2-1: rpc_calculate_tie_result에서 division_id 전달 누락 수정
--       (003의 3-arg rpc_calculate_standings 활용)
-- F2-2: rpc_advance_tournament_winner에서 club_id 덮어쓸 때
--       qualifier_label도 NULL로 정리
-- F2-3: 동 함수에서 rubber insert 시 status='pending' 명시
--
-- 실행일: 2026-04-15
-- ============================================================

-- F2-1: rpc_calculate_tie_result
CREATE OR REPLACE FUNCTION public.rpc_calculate_tie_result(p_tie_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tie RECORD;
  v_a_wins INT;
  v_b_wins INT;
  v_completed INT;
  v_majority INT;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;
  SELECT
    coalesce(COUNT(*) FILTER (WHERE winning_club_id = v_tie.club_a_id), 0),
    coalesce(COUNT(*) FILTER (WHERE winning_club_id = v_tie.club_b_id), 0),
    coalesce(COUNT(*) FILTER (WHERE status = 'completed'), 0)
  INTO v_a_wins, v_b_wins, v_completed
  FROM tie_rubbers WHERE tie_id = p_tie_id;

  v_majority := (v_tie.rubber_count / 2) + 1;

  UPDATE ties SET
    club_a_rubbers_won = v_a_wins,
    club_b_rubbers_won = v_b_wins
  WHERE id = p_tie_id;

  IF v_a_wins >= v_majority THEN
    UPDATE ties SET winning_club_id = v_tie.club_a_id, status = 'completed' WHERE id = p_tie_id;
    -- ✅ F2-1: division_id 전달
    PERFORM rpc_calculate_standings(v_tie.event_id, v_tie.group_id, v_tie.division_id);
    IF v_tie.round IN ('round_of_16', 'quarter', 'semi', 'final') THEN
      PERFORM rpc_advance_tournament_winner(p_tie_id);
    END IF;
    IF v_tie.round = 'group' AND v_tie.group_id IS NOT NULL THEN
      PERFORM rpc_fill_team_tournament_slots(v_tie.event_id, v_tie.group_id);
    END IF;
    RETURN json_build_object('success', true, 'winner_club_id', v_tie.club_a_id, 'completed', true);

  ELSIF v_b_wins >= v_majority THEN
    UPDATE ties SET winning_club_id = v_tie.club_b_id, status = 'completed' WHERE id = p_tie_id;
    PERFORM rpc_calculate_standings(v_tie.event_id, v_tie.group_id, v_tie.division_id);
    IF v_tie.round IN ('round_of_16', 'quarter', 'semi', 'final') THEN
      PERFORM rpc_advance_tournament_winner(p_tie_id);
    END IF;
    IF v_tie.round = 'group' AND v_tie.group_id IS NOT NULL THEN
      PERFORM rpc_fill_team_tournament_slots(v_tie.event_id, v_tie.group_id);
    END IF;
    RETURN json_build_object('success', true, 'winner_club_id', v_tie.club_b_id, 'completed', true);
  END IF;

  IF v_completed > 0 AND v_tie.status NOT IN ('completed', 'lineup_ready') THEN
    UPDATE ties SET status = 'in_progress' WHERE id = p_tie_id;
  END IF;

  RETURN json_build_object('success', true, 'completed', false, 'a_wins', v_a_wins, 'b_wins', v_b_wins);
END;
$function$;


-- F2-2 + F2-3: rpc_advance_tournament_winner
CREATE OR REPLACE FUNCTION public.rpc_advance_tournament_winner(p_tie_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tie RECORD;
  v_next_round TEXT;
  v_next_position INT;
  v_next_tie RECORD;
  v_is_upper BOOLEAN;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie.winning_club_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', '아직 승자가 결정되지 않았습니다.');
  END IF;
  CASE v_tie.round
    WHEN 'round_of_16' THEN v_next_round := 'quarter';
    WHEN 'quarter'     THEN v_next_round := 'semi';
    WHEN 'semi'        THEN v_next_round := 'final';
    WHEN 'final'       THEN
      RETURN json_build_object('success', true, 'message', '결승 완료! 우승 확정.');
    ELSE
      RETURN json_build_object('success', false, 'error', '알 수 없는 라운드: ' || v_tie.round);
  END CASE;
  v_next_position := ceil(v_tie.bracket_position::NUMERIC / 2);
  v_is_upper      := (v_tie.bracket_position % 2 = 1);

  SELECT * INTO v_next_tie FROM ties
  WHERE event_id = v_tie.event_id
    AND (
      (v_tie.division_id IS NULL AND division_id IS NULL)
      OR division_id = v_tie.division_id
    )
    AND round = v_next_round
    AND bracket_position = v_next_position
  LIMIT 1;

  IF v_next_tie.id IS NULL THEN
    RETURN json_build_object('success', false, 'error',
      '다음 라운드 대전을 찾을 수 없습니다. round=' || v_next_round || ' pos=' || v_next_position);
  END IF;

  -- ✅ F2-2: club_id 채울 때 qualifier_label도 NULL로 정리
  IF v_is_upper THEN
    UPDATE ties
      SET club_a_id = v_tie.winning_club_id,
          qualifier_label_a = NULL
      WHERE id = v_next_tie.id;
  ELSE
    UPDATE ties
      SET club_b_id = v_tie.winning_club_id,
          qualifier_label_b = NULL
      WHERE id = v_next_tie.id;
  END IF;

  SELECT * INTO v_next_tie FROM ties WHERE id = v_next_tie.id;
  IF v_next_tie.club_a_id IS NOT NULL AND v_next_tie.club_b_id IS NOT NULL THEN
    DELETE FROM tie_rubbers WHERE tie_id = v_next_tie.id;
    FOR i IN 1..v_next_tie.rubber_count LOOP
      -- ✅ F2-3: status 명시
      INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
      VALUES (v_next_tie.id, i, 'pending', LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0'));
    END LOOP;
  END IF;
  RETURN json_build_object(
    'success', true,
    'next_round', v_next_round,
    'next_position', v_next_position,
    'winner', v_tie.winning_club_id
  );
END;
$function$;

-- 검증
SELECT proname FROM pg_proc
WHERE proname IN ('rpc_calculate_tie_result', 'rpc_advance_tournament_winner')
ORDER BY proname;
