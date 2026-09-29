-- ============================================================
-- 025b: 개인전·공통 보안 2단계 — 잠그기 (025a 적용 + 새 화면 배포 후 실행!)
-- 되돌리기: 025b-rollback.sql
--
--   1) 팀·경기장 PIN: teams.pin_plain / venues.pin_plain 비우기 (앞으로 쓰면 보관 테이블로 옮김)
--   2) 테이블 직접 쓰기 차단: matches / teams / groups / group_members / group_settings 의
--      "누구나 추가·수정·삭제" 정책 삭제 (공개 조회 + 로그인 운영자(op_all) 정책은 유지)
--   3) venue_sessions 공개 조회 삭제 (경기장 로그인 토큰 노출), pin_attempts 보호 켜기
--   4) 운영 함수 익명 실행 회수 (결과 입력·진출·슬롯 채움·대진/조 생성, 잠금 도우미 등)
--   5) 뷰(v_*) 익명 쓰기 권한 회수
--   6) 선수·경기장 PIN 로그인: 연속 실패 잠금이 실제로 기록되도록 (예외 대신 결과로 반환)
-- ============================================================

-- 1) PIN 비우기 ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_teams_capture_pin()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.pin_plain IS NOT NULL THEN
    INSERT INTO team_pins (team_id, pin_plain, updated_at) VALUES (NEW.id, NEW.pin_plain, now())
    ON CONFLICT (team_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
    NEW.pin_plain := NULL;   -- ✅ 025b
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_venues_capture_pin()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.pin_plain IS NOT NULL THEN
    INSERT INTO venue_pins (venue_id, pin_plain, updated_at) VALUES (NEW.id, NEW.pin_plain, now())
    ON CONFLICT (venue_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
    NEW.pin_plain := NULL;   -- ✅ 025b
  END IF;
  RETURN NEW;
END;
$function$;

INSERT INTO public.team_pins (team_id, pin_plain)
SELECT id, pin_plain FROM public.teams WHERE pin_plain IS NOT NULL
ON CONFLICT (team_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
INSERT INTO public.venue_pins (venue_id, pin_plain)
SELECT id, pin_plain FROM public.venues WHERE pin_plain IS NOT NULL
ON CONFLICT (venue_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
UPDATE public.teams  SET pin_plain = NULL WHERE pin_plain IS NOT NULL;
UPDATE public.venues SET pin_plain = NULL WHERE pin_plain IS NOT NULL;


-- 2) 테이블 직접 쓰기 차단 ─────────────────────────────────
DROP POLICY IF EXISTS matches_insert ON public.matches;
DROP POLICY IF EXISTS matches_update ON public.matches;
DROP POLICY IF EXISTS matches_delete ON public.matches;
DROP POLICY IF EXISTS teams_insert ON public.teams;
DROP POLICY IF EXISTS teams_update ON public.teams;
DROP POLICY IF EXISTS teams_delete ON public.teams;
DROP POLICY IF EXISTS groups_insert ON public.groups;
DROP POLICY IF EXISTS groups_update ON public.groups;
DROP POLICY IF EXISTS groups_delete ON public.groups;
DROP POLICY IF EXISTS gm_insert ON public.group_members;
DROP POLICY IF EXISTS gm_delete ON public.group_members;
DROP POLICY IF EXISTS gs_insert ON public.group_settings;
DROP POLICY IF EXISTS gs_update ON public.group_settings;


-- 3) 세션 토큰·잠금 기록 ────────────────────────────────────
DROP POLICY IF EXISTS public_read_venue_sessions ON public.venue_sessions;
ALTER TABLE public.pin_attempts ENABLE ROW LEVEL SECURITY;   -- 정책 없음 = 서버 함수만


-- 4) 운영 함수 익명 실행 회수 ───────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'rpc_submit_match_result', 'advance_winner', 'rpc_fill_tournament_slots', 'rpc_fill_tournament_slots_manual',
        'rpc_generate_tournament', 'rpc_generate_groups', 'rpc_generate_group_matches',
        'rpc_generate_full_league',
        '_pin_check_locked', '_pin_record_fail', '_pin_record_success', '_venue_session', 'log_audit',
        'next_match_num', 'next_team_num')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;


-- 5) 뷰 익명 쓰기 회수 ──────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.v_group_board, public.v_court_board,
  public.v_matches_with_teams, public.v_bracket_with_details FROM anon;


-- 6) 선수·경기장 PIN 로그인 잠금 ────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_pin_login(p_pin_code text, p_event_id uuid, p_division_name text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_team teams%ROWTYPE;
  v_token text;
  v_target_key text;
  v_lock_msg text;
BEGIN
  v_target_key := 'login:' || p_event_id::text || ':' || md5(p_pin_code);
  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock_msg);
  END IF;
  -- 대회 전체 연속 실패도 제한 (PIN 을 바꿔가며 대입하는 것 방지)
  v_lock_msg := _pin_check_locked('login_event:' || p_event_id::text);
  IF v_lock_msg IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock_msg);
  END IF;

  SELECT t.* INTO v_team FROM teams t JOIN team_pins tp ON tp.team_id = t.id
  WHERE t.event_id = p_event_id
    AND tp.pin_plain = p_pin_code
    AND (p_division_name IS NULL OR t.division_name = p_division_name)
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM _pin_record_fail(v_target_key);
    PERFORM _pin_record_fail('login_event:' || p_event_id::text, 30, 5);
    RETURN jsonb_build_object('success', false, 'error', 'PIN이 올바르지 않습니다.');
  END IF;

  PERFORM _pin_record_success(v_target_key);
  PERFORM _pin_record_success('login_event:' || p_event_id::text);

  INSERT INTO pin_sessions(event_id, team_id, division_name)
  VALUES (p_event_id, v_team.id, v_team.division_name)
  RETURNING token INTO v_token;

  PERFORM log_audit(p_event_id, 'pin_login', 'pin_user',
    left(v_token, 8), 'teams', v_team.id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'success', true, 'token', v_token,
    'team_id', v_team.id, 'team_name', v_team.team_name,
    'division', v_team.division_name, 'event_id', p_event_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_venue_login(p_pin_code text, p_event_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_venue record;
  v_token text;
  v_key text := 'venue_login:' || p_event_id::text;
  v_lock text;
BEGIN
  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock);
  END IF;

  SELECT v.* INTO v_venue FROM venues v JOIN venue_pins vp ON vp.venue_id = v.id
  WHERE v.event_id = p_event_id AND vp.pin_plain = p_pin_code;
  IF v_venue IS NULL THEN
    SELECT * INTO v_venue FROM venues
    WHERE event_id = p_event_id AND pin_hash = crypt(p_pin_code, pin_hash);
  END IF;
  IF v_venue IS NULL THEN
    PERFORM _pin_record_fail(v_key, 10, 10);
    RETURN jsonb_build_object('success', false, 'error', '경기장 PIN이 올바르지 않습니다.');
  END IF;
  PERFORM _pin_record_success(v_key);

  UPDATE venue_sessions SET is_active = false
  WHERE venue_id = v_venue.id AND is_active = true;
  INSERT INTO venue_sessions(event_id, venue_id, venue_name, courts)
  VALUES (p_event_id, v_venue.id, v_venue.name, v_venue.courts)
  RETURNING token INTO v_token;
  RETURN jsonb_build_object(
    'success', true,
    'token', v_token,
    'venue_id', v_venue.id,
    'venue_name', v_venue.name,
    'courts', v_venue.courts,
    'event_id', p_event_id,
    'manager_name', v_venue.manager_name,
    'short_name', COALESCE(v_venue.short_name, ''),
    'court_count', COALESCE(v_venue.court_count, array_length(v_venue.courts, 1), 0)
  );
END;
$function$;
