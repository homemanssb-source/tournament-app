-- ============================================================
-- 039: 단체전 오더 운영자 대리입력 (2026-10-30)
--
--   주장이 오더를 안 내는 경우 → 운영본부가 종이·구두로 받은 오더를 대신 넣는다.
--   1) _team_store_lineup: 검증·저장·양팀 제출 시 공개 (rpc_submit_lineup 023 본문을 그대로 옮김)
--   2) rpc_submit_lineup: PIN 확인 후 _team_store_lineup(..., 'captain') — 동작 변화 없음
--   3) rpc_admin_pin_submit_lineup: 마스터 PIN 세션(현장 운영자)으로 대리입력, submitted_by = 'admin'
--   4) rpc_admin_submit_lineup: 대시보드 로그인 운영자 대리입력, submitted_by = 'admin'
--
--   5) ties.court_assigned_at: 코트 배정(변경) 시각 — 트리거로 자동 기록
--      오더 미제출 현황판이 "차례가 된 시각" = max(앞 경기 종료, 코트 배정) + 10분을 마감으로 씀
--   6) ties.lineup_alerted_at: 차례가 된 미제출 팀 주장에게 자동 푸시를 보낸 시각
--      운영자 화면 여러 대가 동시에 보내지 않도록 /api/notify/lineup 이 이 칸을 먼저 찍은 1곳만 발송
--
--   대리입력도 주장 제출과 같은 규칙(선수 중복 금지·공오더·소속)으로 검사하고,
--   상대가 이미 냈으면 바로 양팀 공개된다. 공개 전이면 주장이 다시 제출해 덮어쓸 수 있다.
--   기존 데이터 변경 없음 (court_assigned_at 은 앞으로 배정되는 것부터). 멱등. 되돌리기: 039-rollback.sql
-- ============================================================

-- 사전 확인: team_lineups.submitted_by 에 'admin' 을 막는 CHECK 제약이 있으면 아무것도 바꾸지 않고 중단
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.team_lineups'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%submitted_by%'
               AND pg_get_constraintdef(oid) NOT LIKE '%admin%') THEN
    RAISE EXCEPTION '039 중단: team_lineups.submitted_by CHECK 제약이 ''admin'' 을 허용하지 않습니다.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._team_store_lineup(p_tie_id uuid, p_club_id uuid, p_lineups jsonb, p_submitted_by text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tie RECORD;
  v_lineup JSONB;
  v_both_submitted BOOLEAN;
  v_allow_empty boolean;
  v_rn int;
  v_p1 uuid;
  v_p2 uuid;
  v_nums int[] := '{}';
  v_used uuid[] := '{}';
  v_empty int := 0;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;
  IF v_tie.club_a_id IS DISTINCT FROM p_club_id AND v_tie.club_b_id IS DISTINCT FROM p_club_id THEN
    RETURN json_build_object('success', false, 'error', '이 대전에 참가하는 클럽이 아닙니다.');
  END IF;

  IF v_tie.lineup_revealed = true THEN
    RETURN json_build_object('success', false, 'error', '라인업이 이미 확정되어 수정할 수 없습니다.');
  END IF;

  IF jsonb_array_length(p_lineups) != v_tie.rubber_count THEN
    RETURN json_build_object('success', false, 'error',
      '라인업 수(' || jsonb_array_length(p_lineups) || ')가 복식 수(' || v_tie.rubber_count || ')와 다릅니다.');
  END IF;

  -- 검증 (복식 번호, 공오더, 선수 2명, 중복, 소속) — 023
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
      p_submitted_by
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
    PERFORM fn_team_apply_walkovers(p_tie_id);   -- 023: 공오더 러버 자동 기록
  END IF;

  RETURN json_build_object('success', true, 'revealed', v_both_submitted, 'empty_rubbers', v_empty);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public._team_store_lineup(uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;


-- ── 주장 제출: PIN 확인 → 저장 (023 과 같은 동작) ──
CREATE OR REPLACE FUNCTION public.rpc_submit_lineup(p_tie_id uuid, p_club_id uuid, p_captain_pin text, p_lineups jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tie RECORD;
  v_club RECORD;
  v_event RECORD;
  v_target_key text;
  v_lock_msg text;
  v_pin text;
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

  RETURN _team_store_lineup(p_tie_id, p_club_id, p_lineups, 'captain');
END;
$function$;


-- ── 현장 운영자(마스터 PIN) 대리입력 ──
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_submit_lineup(p_token text, p_tie_id uuid, p_club_id uuid, p_lineups jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
  v_res json;
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ties WHERE id = p_tie_id AND event_id = v_event) THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  v_res := _team_store_lineup(p_tie_id, p_club_id, p_lineups, 'admin');
  IF (v_res->>'success')::boolean THEN
    PERFORM log_audit(v_event, 'admin_pin_submit_lineup', 'admin_pin', left(p_token, 8), 'ties', p_tie_id,
      jsonb_build_object('club_id', p_club_id, 'lineups', p_lineups));
  END IF;
  RETURN v_res;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_admin_pin_submit_lineup(text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_pin_submit_lineup(text, uuid, uuid, jsonb) TO anon, authenticated, service_role;


-- ── 대시보드(로그인 운영자) 대리입력 ──
CREATE OR REPLACE FUNCTION public.rpc_admin_submit_lineup(p_tie_id uuid, p_club_id uuid, p_lineups jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid;
  v_res json;
BEGIN
  SELECT event_id INTO v_event FROM ties WHERE id = p_tie_id;
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  v_res := _team_store_lineup(p_tie_id, p_club_id, p_lineups, 'admin');
  IF (v_res->>'success')::boolean THEN
    PERFORM log_audit(v_event, 'admin_submit_lineup', 'operator', coalesce(auth.uid()::text, ''), 'ties', p_tie_id,
      jsonb_build_object('club_id', p_club_id, 'lineups', p_lineups));
  END IF;
  RETURN v_res;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_admin_submit_lineup(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_admin_submit_lineup(uuid, uuid, jsonb) TO authenticated, service_role;


-- ── 코트 배정 시각 (오더 마감 계산용) ──
ALTER TABLE public.ties ADD COLUMN IF NOT EXISTS court_assigned_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_ties_court_assigned_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- 코트가 바뀌면 차례도 새로 → 자동 오더 알림(lineup_alerted_at)도 다시 보낼 수 있게
  IF NEW.court_number IS NULL THEN
    NEW.court_assigned_at := NULL;
    NEW.lineup_alerted_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.court_number IS DISTINCT FROM OLD.court_number THEN
    NEW.court_assigned_at := now();
    NEW.lineup_alerted_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_ties_court_assigned_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ties_court_assigned_at ON public.ties;
CREATE TRIGGER trg_ties_court_assigned_at
  BEFORE INSERT OR UPDATE OF court_number ON public.ties
  FOR EACH ROW EXECUTE FUNCTION public.fn_ties_court_assigned_at();


-- ── 오더 자동 알림 1회 표시 ──
ALTER TABLE public.ties ADD COLUMN IF NOT EXISTS lineup_alerted_at timestamptz;
