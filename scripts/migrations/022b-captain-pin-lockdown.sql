-- ============================================================
-- 022b: 주장 PIN 보안 2단계 — 잠그기 (새 화면 배포 후 실행!)
--
-- 전제: 022a 적용 + 주장 로그인/라인업/관리자 PIN 화면이 새 RPC 를 쓰는 버전으로 배포됨.
-- 되돌리기: 022b-rollback.sql
--
--   1) clubs.captain_pin 비우기 — 앞으로 clubs.captain_pin 에 쓰면 club_pins 로 옮기고 clubs 쪽은 NULL
--   2) team_lineups: 익명은 공개된 라인업만, 로그인 운영자는 전체
--   3) 운영 함수 익명 실행 권한 회수 (대진·조편성·순위·점수 입력/정정 등 → 대시보드 로그인 필요)
--      + rpc_set_master_pin (권한 확인 없이 누구나 마스터 PIN 을 바꿀 수 있었음)
--      + rpc_team_pin_score (러버 PIN 점수 입력 — 사용 안 함, 끔)
--      + rpc_modify_lineup (미사용, clubs.captain_pin 기준 PIN 비교)
--   4) rpc_admin_pin_login: 대회당 5회 연속 실패 시 10분 잠금
--      (실패를 기록하려면 예외 대신 결과로 반환해야 함 — 새 화면은 두 방식 모두 처리)
-- ============================================================

-- 1) clubs.captain_pin 비우기
CREATE OR REPLACE FUNCTION public.fn_clubs_capture_pin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.captain_pin IS NOT NULL THEN
    INSERT INTO club_pins (club_id, captain_pin, updated_at)
    VALUES (NEW.id, NEW.captain_pin, now())
    ON CONFLICT (club_id) DO UPDATE SET captain_pin = EXCLUDED.captain_pin, updated_at = now();
    NEW.captain_pin := NULL;   -- ✅ 022b: 익명 조회 가능한 clubs 에는 남기지 않음
  END IF;
  RETURN NEW;
END;
$function$;

-- 비우기 전 한 번 더 동기화 (022a 이후 트리거로 이미 복사돼 있지만 안전하게)
INSERT INTO public.club_pins (club_id, captain_pin)
SELECT id, captain_pin FROM public.clubs WHERE captain_pin IS NOT NULL
ON CONFLICT (club_id) DO UPDATE SET captain_pin = EXCLUDED.captain_pin, updated_at = now();
UPDATE public.clubs SET captain_pin = NULL WHERE captain_pin IS NOT NULL;


-- 2) team_lineups: 익명은 공개된 것만
DROP POLICY IF EXISTS public_read_team_lineups ON public.team_lineups;
DROP POLICY IF EXISTS anon_read_revealed_team_lineups ON public.team_lineups;
DROP POLICY IF EXISTS authenticated_all_team_lineups ON public.team_lineups;
CREATE POLICY anon_read_revealed_team_lineups ON public.team_lineups FOR SELECT TO anon USING (is_revealed = true);
CREATE POLICY authenticated_all_team_lineups ON public.team_lineups FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- 3) 운영 함수 익명 실행 권한 회수 (로그인 운영자·서버는 그대로, 함수 안에서 서로 부르는 것은 영향 없음)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'rpc_admin_record_score', 'rpc_admin_correct_rubber_score', 'rpc_record_rubber_score',
        'rpc_calculate_tie_result', 'rpc_advance_tournament_winner', 'rpc_calculate_standings',
        'rpc_create_rubbers_for_event_ties', 'rpc_create_team_groups', 'rpc_fill_team_tournament_slots',
        'rpc_generate_full_league', 'rpc_generate_team_tournament', 'rpc_generate_team_tournament_v2',
        'rpc_set_manual_rank', 'rpc_apply_lineups_to_rubbers', 'rpc_team_pin_score', 'rpc_modify_lineup',
        'rpc_set_master_pin',
        'fn_team_tie_started', 'fn_team_next_tie', 'fn_team_set_next_slot', 'fn_team_resolve_tie',
        'fn_team_rubber_count')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- rpc_team_pin_score / rpc_modify_lineup 는 로그인 운영자도 쓸 일이 없음
REVOKE EXECUTE ON FUNCTION public.rpc_team_pin_score(text, uuid, integer, integer, integer, integer, integer, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_modify_lineup(uuid, uuid, text, jsonb) FROM authenticated;


-- 4) 관리자 PIN 로그인 잠금
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_login(p_master_pin text, p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_event events%ROWTYPE;
  v_token text;
  v_key text := 'admin_pin:' || p_event_id::text;
  v_lock text;
BEGIN
  SELECT * INTO v_event FROM events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION '대회를 찾을 수 없습니다.'; END IF;

  IF v_event.master_pin_hash IS NULL THEN
    RAISE EXCEPTION '마스터 PIN이 설정되지 않았습니다.';
  END IF;

  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock);
  END IF;

  IF v_event.master_pin_hash != crypt(p_master_pin, v_event.master_pin_hash) THEN
    -- ✅ 022b: 예외를 던지면 실패 기록이 롤백되므로 결과로 반환
    PERFORM _pin_record_fail(v_key, 5, 10);
    RETURN jsonb_build_object('success', false, 'error', '마스터 PIN이 올바르지 않습니다.');
  END IF;

  PERFORM _pin_record_success(v_key);

  INSERT INTO admin_pin_sessions(event_id)
  VALUES (p_event_id)
  RETURNING token INTO v_token;

  PERFORM log_audit(p_event_id, 'admin_pin_login', 'admin_pin',
    left(v_token, 8), 'events', p_event_id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'success', true,
    'token', v_token,
    'event_id', p_event_id,
    'event_name', v_event.name,
    'expires_in', '30분'
  );
END;
$function$;
