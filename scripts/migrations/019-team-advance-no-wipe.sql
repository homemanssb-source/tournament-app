-- ============================================================
-- 019: 단체전 토너먼트 — 다음 라운드 러버가 지워지는 문제 (2026-09-29 점검에서 발견)
--
-- 문제:
--   토너먼트 대전은 과반(3복식 2승, 5복식 3승)에서 즉시 completed 가 되지만
--   남은 러버(pending)는 점수 입력이 막혀 있지 않았다.
--   누가 남은 러버 점수를 넣으면 rpc_calculate_tie_result → rpc_advance_tournament_winner 가
--   다시 돌고, advance 는 다음 라운드 대전의 tie_rubbers 를 DELETE 후 새로 만든다.
--   → 이미 진행 중인 다음 라운드(예: 결승)의 점수·러버 PIN·선수 배정이 전부 사라짐.
--
-- 수정:
--   (1) rpc_record_rubber_score
--       - 토너먼트 라운드에서 대전이 이미 끝났으면(completed/bye) 점수 입력 거부
--       - 양 팀이 아직 정해지지 않은(TBD) 대전의 러버 점수 입력 거부
--       (조별/풀리그는 기존대로 과반 후에도 모든 러버 입력 가능 — 011 동작 유지)
--   (2) rpc_advance_tournament_winner
--       - 다음 라운드 러버를 절대 지우지 않음. 러버가 하나도 없을 때만 생성.
--       - 슬롯에 이미 같은 클럽이 있으면 아무것도 바꾸지 않음(재실행해도 안전).
--       - 슬롯에 다른 클럽이 있는데 다음 대전이 이미 시작됐으면
--         (라인업 제출/러버 완료/진행 상태) 바꾸지 않고 오류 반환.
--
-- 라이브 정의 기준(2026-09-29 조회)으로 최소 패치. 기존 데이터 변경 없음.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_record_rubber_score(p_rubber_id uuid, p_set1_a integer, p_set1_b integer, p_set2_a integer DEFAULT NULL::integer, p_set2_b integer DEFAULT NULL::integer, p_set3_a integer DEFAULT NULL::integer, p_set3_b integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_rubber RECORD;
  v_tie RECORD;
  v_sets_a INT := 0;
  v_sets_b INT := 0;
  v_winner_id UUID;
BEGIN
  SELECT * INTO v_rubber FROM tie_rubbers WHERE id = p_rubber_id;
  IF v_rubber IS NULL THEN
    RETURN json_build_object('success', false, 'error', '경기를 찾을 수 없습니다.');
  END IF;

  IF v_rubber.status = 'completed' THEN
    RETURN json_build_object('success', false, 'error', '이미 완료된 경기입니다.');
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = v_rubber.tie_id;

  -- ✅ 019: 대진 미확정(TBD) 대전은 점수 입력 불가
  IF v_tie.club_a_id IS NULL OR v_tie.club_b_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대진이 아직 확정되지 않은 대전입니다.');
  END IF;

  -- ✅ 019: 토너먼트 대전은 승부가 난 뒤 남은 러버 입력 불가 (다음 라운드 보호)
  IF v_tie.round NOT IN ('group', 'full_league') AND v_tie.round IS NOT NULL
     AND v_tie.status IN ('completed', 'bye') THEN
    RETURN json_build_object('success', false, 'error', '이미 승부가 결정된 대전입니다. 남은 복식은 입력하지 않습니다.');
  END IF;

  -- 세트 승수 계산
  IF p_set1_a IS NOT NULL AND p_set1_b IS NOT NULL THEN
    IF p_set1_a > p_set1_b THEN v_sets_a := v_sets_a + 1;
    ELSIF p_set1_b > p_set1_a THEN v_sets_b := v_sets_b + 1;
    END IF;
  END IF;

  IF p_set2_a IS NOT NULL AND p_set2_b IS NOT NULL THEN
    IF p_set2_a > p_set2_b THEN v_sets_a := v_sets_a + 1;
    ELSIF p_set2_b > p_set2_a THEN v_sets_b := v_sets_b + 1;
    END IF;
  END IF;

  IF p_set3_a IS NOT NULL AND p_set3_b IS NOT NULL THEN
    IF p_set3_a > p_set3_b THEN v_sets_a := v_sets_a + 1;
    ELSIF p_set3_b > p_set3_a THEN v_sets_b := v_sets_b + 1;
    END IF;
  END IF;

  -- 승자 결정
  IF v_sets_a > v_sets_b THEN
    v_winner_id := v_tie.club_a_id;
  ELSIF v_sets_b > v_sets_a THEN
    v_winner_id := v_tie.club_b_id;
  ELSE
    RETURN json_build_object('success', false, 'error', '승패를 결정할 수 없습니다. 스코어를 확인하세요.');
  END IF;

  -- 러버 업데이트
  UPDATE tie_rubbers SET
    set1_a = p_set1_a, set1_b = p_set1_b,
    set2_a = p_set2_a, set2_b = p_set2_b,
    set3_a = p_set3_a, set3_b = p_set3_b,
    sets_won_a = v_sets_a,
    sets_won_b = v_sets_b,
    winning_club_id = v_winner_id,
    status = 'completed'
  WHERE id = p_rubber_id;

  -- 대전 결과 자동 계산
  PERFORM rpc_calculate_tie_result(v_rubber.tie_id);

  RETURN json_build_object('success', true, 'winner_club_id', v_winner_id, 'sets', v_sets_a || '-' || v_sets_b);
END;
$function$;


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
  v_current_club uuid;
  v_started BOOLEAN;
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

  v_current_club := CASE WHEN v_is_upper THEN v_next_tie.club_a_id ELSE v_next_tie.club_b_id END;

  -- ✅ 019: 슬롯에 다른 클럽이 있고 다음 대전이 이미 시작됐으면 바꾸지 않음
  IF v_current_club IS NOT NULL AND v_current_club <> v_tie.winning_club_id THEN
    v_started := v_next_tie.status IN ('lineup_phase', 'lineup_ready', 'in_progress', 'completed')
      OR coalesce(v_next_tie.club_a_lineup_submitted, false)
      OR coalesce(v_next_tie.club_b_lineup_submitted, false)
      OR EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = v_next_tie.id AND status = 'completed');
    IF v_started THEN
      RETURN json_build_object('success', false, 'error',
        '다음 라운드 대전이 이미 시작되어 진출팀을 바꿀 수 없습니다. 운영자 확인이 필요합니다.');
    END IF;
  END IF;

  -- 슬롯 채우기 (같은 클럽이면 건너뜀)
  IF v_current_club IS DISTINCT FROM v_tie.winning_club_id THEN
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
  END IF;

  SELECT * INTO v_next_tie FROM ties WHERE id = v_next_tie.id;
  -- ✅ 019: 기존 러버는 절대 지우지 않음 — 하나도 없을 때만 생성
  IF v_next_tie.club_a_id IS NOT NULL AND v_next_tie.club_b_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = v_next_tie.id) THEN
    FOR i IN 1..v_next_tie.rubber_count LOOP
      -- ✅ F2-3: status 명시 ('pending')
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
