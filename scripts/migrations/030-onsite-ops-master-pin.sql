-- ============================================================
-- 030: 현장 운영 — 마스터 PIN 중심 + 경기장 PIN 축소 + w.o(기권)
--
--   1) 마스터 PIN 세션 30분 → 12시간 (경기장·선수 PIN 과 같게)
--   2) 마스터 PIN 을 바꾸면 그 대회의 마스터 PIN 로그인이 모두 끊김
--   3) 마스터 PIN 으로 "경기장 코트 관리" 열기 — venue_sessions.is_admin 세션
--      · 경기장 PIN 로그인이 같은 경기장 세션을 끊을 때도 관리자 세션은 유지
--   4) 경기장 PIN 은 코트 배정·변경·해제 불가, 끝난 경기 점수 정정 불가 (서버에서 차단)
--      · 기존 rpc_venue_* 코트 함수는 외부 실행 권한만 회수, 정의는 그대로
--      · 관리자 세션 전용 래퍼 rpc_venue_admin_* 로만 호출
--   5) 단체전 클럽 불참 → 남은 복식 전부 w.o (rpc_admin_pin_tie_walkover)
--   6) 단체전 동률 순위 — 마스터 PIN 으로 (rpc_admin_pin_set_manual_rank)
--
--   기존 함수 정의는 하나도 바꾸지 않는다 (추가 + 권한 회수만). 데이터 변경 없음. 멱등.
--   되돌리기: 030-rollback.sql
-- ============================================================

-- ── 1) 마스터 PIN 세션 12시간 ──
ALTER TABLE public.admin_pin_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '12 hours');


-- ── 3) 관리자용 경기장 세션 표시 ──
ALTER TABLE public.venue_sessions
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- 경기장 PIN 로그인은 같은 경기장 세션을 is_active=false 로 끊는다 → 관리자 세션은 제외
CREATE OR REPLACE FUNCTION public.fn_venue_sessions_keep_admin()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.is_admin AND OLD.is_active AND NOT NEW.is_active THEN
    NEW.is_active := true;   -- 관리자 세션은 만료 시각(expires_at)으로만 끝남
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_venue_sessions_keep_admin ON public.venue_sessions;
CREATE TRIGGER trg_venue_sessions_keep_admin
  BEFORE UPDATE OF is_active ON public.venue_sessions
  FOR EACH ROW EXECUTE FUNCTION public.fn_venue_sessions_keep_admin();


-- ── 2) 마스터 PIN 변경 → 마스터 PIN 로그인 전부 종료 ──
CREATE OR REPLACE FUNCTION public.fn_event_secrets_end_admin_sessions()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.master_pin_hash IS DISTINCT FROM OLD.master_pin_hash THEN
    UPDATE admin_pin_sessions SET is_active = false
    WHERE event_id = NEW.event_id AND is_active = true;
    UPDATE venue_sessions SET expires_at = now()
    WHERE event_id = NEW.event_id AND is_admin = true AND expires_at > now();
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_event_secrets_end_admin_sessions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_event_secrets_end_admin_sessions ON public.event_secrets;
CREATE TRIGGER trg_event_secrets_end_admin_sessions
  AFTER UPDATE OF master_pin_hash ON public.event_secrets
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_secrets_end_admin_sessions();


-- ── 3) 마스터 PIN → 경기장 코트 관리 열기 ──
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_open_venue(p_token text, p_venue_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_admin admin_pin_sessions%ROWTYPE;
  v_venue venues%ROWTYPE;
  v_token text;
BEGIN
  SELECT * INTO v_admin FROM admin_pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  SELECT * INTO v_venue FROM venues WHERE id = p_venue_id AND event_id = v_admin.event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', '이 대회의 경기장이 아닙니다.');
  END IF;

  INSERT INTO venue_sessions(event_id, venue_id, venue_name, courts, is_admin, expires_at)
  VALUES (v_admin.event_id, v_venue.id, v_venue.name, v_venue.courts, true, v_admin.expires_at)
  RETURNING token INTO v_token;

  PERFORM log_audit(v_admin.event_id, 'admin_pin_open_venue', 'admin_pin', left(p_token, 8),
    'venues', v_venue.id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'success', true,
    'token', v_token,
    'venue_id', v_venue.id,
    'venue_name', v_venue.name,
    'courts', v_venue.courts,
    'event_id', v_admin.event_id,
    'manager_name', v_venue.manager_name,
    'short_name', COALESCE(v_venue.short_name, ''),
    'court_count', COALESCE(v_venue.court_count, array_length(v_venue.courts, 1), 0),
    'is_admin', true
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_admin_pin_open_venue(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_pin_open_venue(text, uuid) TO anon, authenticated, service_role;


-- ── 4) 코트 배정은 관리자 경기장 세션만 ──
CREATE OR REPLACE FUNCTION public._venue_admin_ok(p_token text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM venue_sessions
                 WHERE token = p_token AND is_admin = true AND is_active = true AND expires_at > now());
$function$;
REVOKE EXECUTE ON FUNCTION public._venue_admin_ok(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_venue_admin_set_match_court(p_token text, p_match_id uuid, p_court text, p_court_order integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT _venue_admin_ok(p_token) THEN
    RETURN jsonb_build_object('success', false, 'error', '코트 배정·변경은 마스터 PIN 으로만 할 수 있습니다.');
  END IF;
  RETURN rpc_venue_set_match_court(p_token, p_match_id, p_court, p_court_order);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_admin_set_match_court(text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_venue_admin_set_match_court(text, uuid, text, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_venue_admin_assign_tie_court(p_token text, p_tie_id uuid, p_court_number integer, p_court_order integer)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT _venue_admin_ok(p_token) THEN
    RETURN json_build_object('success', false, 'error', '코트 배정·변경은 마스터 PIN 으로만 할 수 있습니다.');
  END IF;
  RETURN rpc_venue_assign_tie_court(p_token, p_tie_id, p_court_number, p_court_order);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_admin_assign_tie_court(text, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_venue_admin_assign_tie_court(text, uuid, integer, integer) TO anon, authenticated, service_role;

-- 경기장 PIN 점수 입력: 끝나지 않은 경기만 (끝난 경기 정정은 마스터 PIN)
CREATE OR REPLACE FUNCTION public.rpc_venue_record_score(p_token text, p_match_id uuid, p_score text, p_winner_team_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM matches WHERE id = p_match_id AND status = 'FINISHED') THEN
    RETURN jsonb_build_object('success', false, 'error', '이미 끝난 경기입니다. 점수 정정은 마스터 PIN 으로 해주세요.');
  END IF;
  RETURN rpc_venue_submit_score(p_token, p_match_id, p_score, p_winner_team_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_record_score(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_venue_record_score(text, uuid, text, uuid) TO anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_submit_score(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- 경기장 PIN 이 직접 부르던 코트 함수는 외부 실행 권한 회수 (위 래퍼는 정의자 권한으로 계속 호출)
REVOKE EXECUTE ON FUNCTION public.rpc_venue_set_match_court(text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_assign_tie_court(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_assign_court(text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_unassign_court(text, uuid) FROM PUBLIC, anon, authenticated;


-- ── 5) 단체전 클럽 불참 → 남은 복식 전부 w.o ──
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_tie_walkover(p_token text, p_tie_id uuid, p_winner_club_id uuid)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
  v_tie ties%ROWTYPE;
  v_a boolean;
  v_n int;
  v_res json;
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id AND event_id = v_event FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;
  IF v_tie.club_a_id IS NULL OR v_tie.club_b_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', '상대 클럽이 정해지지 않은 대전입니다.');
  END IF;
  IF p_winner_club_id IS DISTINCT FROM v_tie.club_a_id AND p_winner_club_id IS DISTINCT FROM v_tie.club_b_id THEN
    RETURN json_build_object('success', false, 'error', '승리 클럽은 대전에 참가한 클럽이어야 합니다.');
  END IF;
  IF v_tie.status = 'completed' THEN
    RETURN json_build_object('success', false, 'error', '이미 끝난 대전입니다. 점수 정정으로 고쳐주세요.');
  END IF;
  v_a := (p_winner_club_id = v_tie.club_a_id);

  -- 단체전 순위는 승수·복식 득실만 보므로 6:0 은 기록용 (화면에는 w.o 로 표시)
  UPDATE tie_rubbers SET
    status = 'completed', is_walkover = true, winning_club_id = p_winner_club_id,
    set1_a = CASE WHEN v_a THEN 6 ELSE 0 END, set1_b = CASE WHEN v_a THEN 0 ELSE 6 END,
    set2_a = NULL, set2_b = NULL, set3_a = NULL, set3_b = NULL,
    sets_won_a = CASE WHEN v_a THEN 1 ELSE 0 END, sets_won_b = CASE WHEN v_a THEN 0 ELSE 1 END
  WHERE tie_id = p_tie_id AND status <> 'completed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN json_build_object('success', false, 'error', '남은 복식이 없습니다.');
  END IF;

  v_res := rpc_calculate_tie_result(p_tie_id);

  PERFORM log_audit(v_event, 'admin_pin_tie_walkover', 'admin_pin', left(p_token, 8), 'ties', p_tie_id,
    jsonb_build_object('winner_club_id', p_winner_club_id, 'rubbers', v_n));

  RETURN json_build_object('success', true, 'rubbers', v_n, 'result', v_res);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_admin_pin_tie_walkover(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_pin_tie_walkover(text, uuid, uuid) TO anon, authenticated, service_role;


-- ── 6) 단체전 동률 순위 (마스터 PIN) ──
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_set_manual_rank(p_token text, p_club_id uuid, p_rank integer)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
  v_res json;
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = p_club_id AND event_id = v_event) THEN
    RETURN json_build_object('success', false, 'error', '이 대회의 클럽이 아닙니다.');
  END IF;
  v_res := rpc_set_manual_rank(v_event, p_club_id, p_rank, '현장 관리자 판단');
  PERFORM log_audit(v_event, 'admin_pin_set_manual_rank', 'admin_pin', left(p_token, 8), 'clubs', p_club_id,
    jsonb_build_object('rank', p_rank));
  RETURN v_res;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_admin_pin_set_manual_rank(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_pin_set_manual_rank(text, uuid, integer) TO anon, authenticated, service_role;


-- ── 확인 ──
SELECT
  (SELECT column_default FROM information_schema.columns
    WHERE table_name = 'admin_pin_sessions' AND column_name = 'expires_at') AS admin_session_default,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('rpc_admin_pin_open_venue', 'rpc_venue_admin_set_match_court', 'rpc_venue_admin_assign_tie_court',
     'rpc_admin_pin_tie_walkover', 'rpc_admin_pin_set_manual_rank', 'rpc_venue_record_score')) AS new_fns,   -- 6
  has_function_privilege('anon', 'public.rpc_venue_set_match_court(text, uuid, text, integer)', 'EXECUTE') AS anon_can_set_court;  -- false
