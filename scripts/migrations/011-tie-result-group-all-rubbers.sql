-- ============================================================
-- 011: rpc_calculate_tie_result — 예선(group/full_league)에서
--      과반 승리 후에도 모든 러버 완료까지 대전 유지
--
-- 배경:
--   3팀 이상 한 조일 때, 득실(rubber_diff)로 순위 결정.
--   현재: 2:0이면 tie가 즉시 completed → 3번째 러버 잠김 → 득실 왜곡.
--   수정: group/full_league에서는 과반 달성 시 winning_club_id만 설정,
--         status='completed'는 ALL rubbers 끝났을 때만.
--         토너먼트(16강~결승)는 기존대로 과반 즉시 종료.
--
-- 실행일: 2026-04-17
-- ============================================================

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
  v_is_group BOOLEAN;
  v_winner_id uuid;
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
  v_is_group := v_tie.round IN ('group', 'full_league') OR v_tie.round IS NULL;

  -- 항상 러버 승수 업데이트
  UPDATE ties SET
    club_a_rubbers_won = v_a_wins,
    club_b_rubbers_won = v_b_wins
  WHERE id = p_tie_id;

  -- 승자 판정 (과반 도달)
  v_winner_id := NULL;
  IF v_a_wins >= v_majority THEN
    v_winner_id := v_tie.club_a_id;
  ELSIF v_b_wins >= v_majority THEN
    v_winner_id := v_tie.club_b_id;
  END IF;

  -- ══════════════════════════════════════════
  -- 토너먼트 라운드 (16강~결승): 과반 즉시 종료
  -- ══════════════════════════════════════════
  IF NOT v_is_group AND v_winner_id IS NOT NULL THEN
    UPDATE ties SET
      winning_club_id = v_winner_id,
      status = 'completed'
    WHERE id = p_tie_id;

    PERFORM rpc_calculate_standings(v_tie.event_id, v_tie.group_id, v_tie.division_id);

    IF v_tie.round IN ('round_of_16', 'quarter', 'semi', 'final') THEN
      PERFORM rpc_advance_tournament_winner(p_tie_id);
    END IF;

    RETURN json_build_object('success', true, 'winner_club_id', v_winner_id, 'completed', true);
  END IF;

  -- ══════════════════════════════════════════
  -- 예선 라운드 (group/full_league):
  --   과반 → winning_club_id만 설정 (status는 in_progress 유지)
  --   모든 러버 완료 → status='completed' + 순위 계산
  -- ══════════════════════════════════════════
  IF v_is_group THEN
    -- 과반 달성: 승자만 기록 (아직 종료 아님)
    IF v_winner_id IS NOT NULL AND v_tie.winning_club_id IS NULL THEN
      UPDATE ties SET winning_club_id = v_winner_id WHERE id = p_tie_id;
    END IF;

    -- 모든 러버 완료: 비로소 tie 종료
    IF v_completed >= v_tie.rubber_count THEN
      -- 전체 러버 결과 반영: 최종 승자 재확인
      IF v_winner_id IS NULL THEN
        -- 동률일 수 있음 (이론적으로 3복식에서 1:1:1 상태 없음, 안전장치)
        IF v_a_wins > v_b_wins THEN
          v_winner_id := v_tie.club_a_id;
        ELSIF v_b_wins > v_a_wins THEN
          v_winner_id := v_tie.club_b_id;
        END IF;
      END IF;

      UPDATE ties SET
        winning_club_id = COALESCE(v_winner_id, winning_club_id),
        status = 'completed'
      WHERE id = p_tie_id;

      PERFORM rpc_calculate_standings(v_tie.event_id, v_tie.group_id, v_tie.division_id);

      IF v_tie.round = 'group' AND v_tie.group_id IS NOT NULL THEN
        PERFORM rpc_fill_team_tournament_slots(v_tie.event_id, v_tie.group_id);
      END IF;

      RETURN json_build_object('success', true, 'winner_club_id', v_winner_id, 'completed', true);
    END IF;

    -- 아직 진행 중
    IF v_completed > 0 AND v_tie.status NOT IN ('completed', 'lineup_ready') THEN
      UPDATE ties SET status = 'in_progress' WHERE id = p_tie_id;
    END IF;

    RETURN json_build_object(
      'success', true,
      'completed', false,
      'a_wins', v_a_wins,
      'b_wins', v_b_wins,
      'winner_decided', v_winner_id IS NOT NULL
    );
  END IF;

  -- 기타 라운드 (fallback)
  IF v_completed > 0 AND v_tie.status NOT IN ('completed', 'lineup_ready') THEN
    UPDATE ties SET status = 'in_progress' WHERE id = p_tie_id;
  END IF;

  RETURN json_build_object('success', true, 'completed', false, 'a_wins', v_a_wins, 'b_wins', v_b_wins);
END;
$function$;
