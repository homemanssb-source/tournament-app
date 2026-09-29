-- ============================================================
-- 023: 라인업 규칙 — 선수 중복 금지 + 공오더 (2026-09-29)
--
-- 1) 선수 중복 금지 (모든 부서): 한 대전에서 한 선수는 복식 1개에만. 같은 복식에 같은 선수 2번 금지.
--    소속 클럽 선수만. (그동안은 화면에서만, 그것도 대회 설정이 꺼져 있을 때만 검사)
-- 2) 공오더 (부서별 허용): divisions.allow_empty_order = true 인 부서만, 대전당 1개 복식을 비워 제출.
--    양 팀 라인업이 공개될 때 비운 복식은 상대의 6:0 승리(is_walkover)로 자동 기록.
--    양 팀이 같은 복식을 비우면 그 복식은 승자 없이 0:0 (둘 다 패배), 나머지 복식으로 승부.
--    그래서 대전이 동률이면 승자 없이 끝남 → 운영본부 판단(순위표 수동 결정 / 점수 정정).
-- rpc_submit_lineup 은 022a 정의 기준 + 검증·공오더 처리 추가.
-- ============================================================

ALTER TABLE public.divisions ADD COLUMN IF NOT EXISTS allow_empty_order boolean NOT NULL DEFAULT false;
ALTER TABLE public.team_lineups ALTER COLUMN player1_id DROP NOT NULL;
ALTER TABLE public.team_lineups ALTER COLUMN player2_id DROP NOT NULL;
ALTER TABLE public.tie_rubbers ADD COLUMN IF NOT EXISTS is_walkover boolean NOT NULL DEFAULT false;


-- ── 공개 시 공오더 러버 자동 기록 ──
CREATE OR REPLACE FUNCTION public.fn_team_apply_walkovers(p_tie_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tie ties%ROWTYPE;
  r RECORD;
  v_a_empty boolean;
  v_b_empty boolean;
  v_n int := 0;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  FOR r IN SELECT * FROM tie_rubbers WHERE tie_id = p_tie_id AND status <> 'completed' LOOP
    v_a_empty := EXISTS (SELECT 1 FROM team_lineups WHERE tie_id = p_tie_id AND club_id = v_tie.club_a_id
                          AND rubber_number = r.rubber_number AND player1_id IS NULL AND player2_id IS NULL);
    v_b_empty := EXISTS (SELECT 1 FROM team_lineups WHERE tie_id = p_tie_id AND club_id = v_tie.club_b_id
                          AND rubber_number = r.rubber_number AND player1_id IS NULL AND player2_id IS NULL);
    IF v_a_empty AND v_b_empty THEN
      UPDATE tie_rubbers SET status = 'completed', is_walkover = true, winning_club_id = NULL,
             set1_a = 0, set1_b = 0, sets_won_a = 0, sets_won_b = 0 WHERE id = r.id;
    ELSIF v_a_empty THEN
      UPDATE tie_rubbers SET status = 'completed', is_walkover = true, winning_club_id = v_tie.club_b_id,
             set1_a = 0, set1_b = 6, sets_won_a = 0, sets_won_b = 1 WHERE id = r.id;
    ELSIF v_b_empty THEN
      UPDATE tie_rubbers SET status = 'completed', is_walkover = true, winning_club_id = v_tie.club_a_id,
             set1_a = 6, set1_b = 0, sets_won_a = 1, sets_won_b = 0 WHERE id = r.id;
    ELSE
      CONTINUE;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  IF v_n > 0 THEN
    PERFORM rpc_calculate_tie_result(p_tie_id);
  END IF;
  RETURN v_n;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_team_apply_walkovers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_team_apply_walkovers(uuid) TO authenticated, service_role;


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
