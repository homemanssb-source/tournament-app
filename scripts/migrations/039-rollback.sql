-- ============================================================
-- 039 되돌리기: 대리입력 함수 삭제 + rpc_submit_lineup 을 023 정의로 복원
-- ============================================================
DROP FUNCTION IF EXISTS public.rpc_admin_pin_submit_lineup(text, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.rpc_admin_submit_lineup(uuid, uuid, jsonb);
DROP TRIGGER IF EXISTS trg_ties_court_assigned_at ON public.ties;
DROP FUNCTION IF EXISTS public.fn_ties_court_assigned_at();
ALTER TABLE public.ties DROP COLUMN IF EXISTS court_assigned_at;
ALTER TABLE public.ties DROP COLUMN IF EXISTS lineup_alerted_at;

-- ── 라인업 제출: 검증 + 공오더 ──
CREATE OR REPLACE FUNCTION public.rpc_submit_lineup(p_tie_id uuid, p_club_id uuid, p_captain_pin text, p_lineups jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tie RECORD;
  v_club RECORD;
  v_lineup JSONB;
  v_event RECORD;
  v_both_submitted BOOLEAN;
  v_target_key text;
  v_lock_msg text;
  v_pin text;
  v_allow_empty boolean;
  v_rn int;
  v_p1 uuid;
  v_p2 uuid;
  v_nums int[] := '{}';
  v_used uuid[] := '{}';
  v_empty int := 0;
BEGIN
  v_target_key := 'club:' || p_club_id::text;

  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock_msg);
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  SELECT * INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club IS NULL THEN
    RETURN json_build_object('success', false, 'error', '클럽을 찾을 수 없습니다.');
  END IF;

  IF v_tie.club_a_id != p_club_id AND v_tie.club_b_id != p_club_id THEN
    RETURN json_build_object('success', false, 'error', '이 대전에 참가하는 클럽이 아닙니다.');
  END IF;

  SELECT * INTO v_event FROM events WHERE id = v_tie.event_id;
  IF v_event.lineup_mode = 'captain_pin' THEN
    v_pin := _club_captain_pin(p_club_id);
    IF v_pin IS NULL OR v_pin != p_captain_pin THEN
      PERFORM _pin_record_fail(v_target_key);
      RETURN json_build_object('success', false, 'error', 'PIN이 일치하지 않습니다.');
    END IF;
  END IF;

  PERFORM _pin_record_success(v_target_key);

  IF v_tie.lineup_revealed = true THEN
    RETURN json_build_object('success', false, 'error', '라인업이 이미 확정되어 수정할 수 없습니다.');
  END IF;

  IF jsonb_array_length(p_lineups) != v_tie.rubber_count THEN
    RETURN json_build_object('success', false, 'error',
      '라인업 수(' || jsonb_array_length(p_lineups) || ')가 복식 수(' || v_tie.rubber_count || ')와 다릅니다.');
  END IF;

  -- ✅ 023: 검증 (복식 번호, 공오더, 선수 2명, 중복, 소속)
  v_allow_empty := coalesce((SELECT allow_empty_order FROM divisions WHERE id = v_tie.division_id), false);
  FOR v_lineup IN SELECT * FROM jsonb_array_elements(p_lineups)
  LOOP
    v_rn := (v_lineup->>'rubber_number')::int;
    IF v_rn IS NULL OR v_rn < 1 OR v_rn > v_tie.rubber_count OR v_rn = ANY(v_nums) THEN
      RETURN json_build_object('success', false, 'error', '복식 번호가 올바르지 않습니다.');
    END IF;
    v_nums := v_nums || v_rn;
    v_p1 := nullif(v_lineup->>'player1_id', '')::uuid;
    v_p2 := nullif(v_lineup->>'player2_id', '')::uuid;

    IF v_p1 IS NULL AND v_p2 IS NULL THEN
      v_empty := v_empty + 1;
      IF NOT v_allow_empty THEN
        RETURN json_build_object('success', false, 'error', '복식 ' || v_rn || '의 선수를 선택하세요. (이 부서는 공오더를 허용하지 않습니다)');
      END IF;
      IF v_empty > 1 THEN
        RETURN json_build_object('success', false, 'error', '공오더는 대전당 1개 복식까지만 가능합니다.');
      END IF;
      CONTINUE;
    END IF;
    IF v_p1 IS NULL OR v_p2 IS NULL THEN
      RETURN json_build_object('success', false, 'error', '복식 ' || v_rn || '의 선수 2명을 모두 선택하세요.');
    END IF;
    IF v_p1 = v_p2 THEN
      RETURN json_build_object('success', false, 'error', '복식 ' || v_rn || '에 같은 선수를 두 번 넣을 수 없습니다.');
    END IF;
    IF v_p1 = ANY(v_used) OR v_p2 = ANY(v_used) THEN
      RETURN json_build_object('success', false, 'error', '선수 중복: 한 선수는 한 대전에서 복식 1개에만 출전할 수 있습니다. (복식 ' || v_rn || ')');
    END IF;
    IF (SELECT count(*) FROM club_members WHERE id IN (v_p1, v_p2) AND club_id = p_club_id) <> 2 THEN
      RETURN json_build_object('success', false, 'error', '복식 ' || v_rn || '에 소속 클럽이 아닌 선수가 있습니다.');
    END IF;
    v_used := v_used || v_p1 || v_p2;
  END LOOP;

  DELETE FROM team_lineups WHERE tie_id = p_tie_id AND club_id = p_club_id;

  FOR v_lineup IN SELECT * FROM jsonb_array_elements(p_lineups)
  LOOP
    INSERT INTO team_lineups (tie_id, club_id, rubber_number, player1_id, player2_id, submitted_by)
    VALUES (
      p_tie_id, p_club_id,
      (v_lineup->>'rubber_number')::INT,
      nullif(v_lineup->>'player1_id', '')::UUID,
      nullif(v_lineup->>'player2_id', '')::UUID,
      'captain'
    );
  END LOOP;

  IF p_club_id = v_tie.club_a_id THEN
    UPDATE ties SET club_a_lineup_submitted = true, status = 'lineup_phase' WHERE id = p_tie_id;
  ELSIF p_club_id = v_tie.club_b_id THEN
    UPDATE ties SET club_b_lineup_submitted = true, status = 'lineup_phase' WHERE id = p_tie_id;
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  v_both_submitted := v_tie.club_a_lineup_submitted AND v_tie.club_b_lineup_submitted;

  IF v_both_submitted THEN
    UPDATE ties SET
      lineup_revealed = true, lineup_locked_at = now(),
      status = 'lineup_ready'
    WHERE id = p_tie_id;
    UPDATE team_lineups SET is_revealed = true WHERE tie_id = p_tie_id;
    PERFORM rpc_apply_lineups_to_rubbers(p_tie_id);
    PERFORM fn_team_apply_walkovers(p_tie_id);   -- ✅ 023: 공오더 러버 자동 기록
  END IF;

  RETURN json_build_object('success', true, 'revealed', v_both_submitted, 'empty_rubbers', v_empty);
END;
$function$;

DROP FUNCTION IF EXISTS public._team_store_lineup(uuid, uuid, jsonb, text);
