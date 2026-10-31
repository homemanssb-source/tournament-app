-- ============================================================
-- 041: 같은 클럽 팀끼리 붙은 대전 — 주장이 어느 팀으로 들어갈지 고르기 (2026-10-31)
--
--   같은 클럽의 A·B 팀(예: 라온클럽 / 라온클럽 B)은 주장 PIN 이 같다.
--   rpc_captain_tie(022a)는 A팀 PIN 부터 맞춰 보므로 그 PIN 은 늘 A팀 → B팀 오더를 주장이 못 냄
--   (10/31 3부 8강 라온클럽 B vs 라온클럽: 한쪽은 운영본부 대리입력)
--
--   rpc_captain_tie(p_tie_id, p_pin, p_side) 3인자 버전 추가 (기존 2인자는 그대로 — 점수 입력 RPC 가 씀)
--     PIN 이 한쪽만 맞으면 그쪽 (p_side 무시)
--     양쪽 다 맞으면 p_side('a'|'b', 없으면 'a') + both_sides = true → 화면이 팀 고르기를 띄움
--   오더 제출(rpc_submit_lineup)·점수 입력(rpc_captain_record_score)은 클럽별로 PIN 을 보므로 변경 없음.
--   기존 데이터 변경 없음. 멱등. 되돌리기: DROP FUNCTION IF EXISTS public.rpc_captain_tie(uuid, text, text);
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_captain_tie(p_tie_id uuid, p_pin text, p_side text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := 'captain_tie:' || p_tie_id::text;
  v_lock text;
  v_tie ties%ROWTYPE;
  v_a_ok boolean;
  v_b_ok boolean;
  v_side text;
  v_club uuid;
  v_opp uuid;
BEGIN
  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock);
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  v_a_ok := p_pin IS NOT NULL AND v_tie.club_a_id IS NOT NULL AND _club_captain_pin(v_tie.club_a_id) = p_pin;
  v_b_ok := p_pin IS NOT NULL AND v_tie.club_b_id IS NOT NULL AND _club_captain_pin(v_tie.club_b_id) = p_pin;

  IF v_a_ok AND v_b_ok THEN
    v_side := CASE WHEN p_side = 'b' THEN 'b' ELSE 'a' END;
  ELSIF v_a_ok THEN
    v_side := 'a';
  ELSIF v_b_ok THEN
    v_side := 'b';
  ELSE
    PERFORM _pin_record_fail(v_key, 20, 5);
    RETURN json_build_object('success', false, 'error', 'PIN이 일치하지 않습니다.');
  END IF;

  IF v_side = 'a' THEN
    v_club := v_tie.club_a_id; v_opp := v_tie.club_b_id;
  ELSE
    v_club := v_tie.club_b_id; v_opp := v_tie.club_a_id;
  END IF;

  PERFORM _pin_record_success(v_key);
  RETURN json_build_object(
    'success', true,
    'side', v_side,
    'both_sides', v_a_ok AND v_b_ok,
    'club_id', v_club,
    'opponent_id', v_opp,
    'my_lineups', coalesce((
      SELECT json_agg(json_build_object('rubber_number', l.rubber_number,
                                        'player1_id', l.player1_id, 'player2_id', l.player2_id)
                      ORDER BY l.rubber_number)
      FROM team_lineups l WHERE l.tie_id = p_tie_id AND l.club_id = v_club), '[]'::json)
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.rpc_captain_tie(uuid, text, text) TO anon, authenticated, service_role;
