-- ============================================================
-- 025b 되돌리기 — 문제가 생기면 이것만 실행 (025a 추가분은 그대로 둬도 무해)
-- ============================================================

-- 1) PIN 복원 + 트리거는 복사만
UPDATE public.teams t SET pin_plain = p.pin_plain FROM public.team_pins p WHERE p.team_id = t.id AND t.pin_plain IS DISTINCT FROM p.pin_plain;
UPDATE public.venues v SET pin_plain = p.pin_plain FROM public.venue_pins p WHERE p.venue_id = v.id AND v.pin_plain IS DISTINCT FROM p.pin_plain;
CREATE OR REPLACE FUNCTION public.fn_teams_capture_pin()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.pin_plain IS NOT NULL THEN
    INSERT INTO team_pins (team_id, pin_plain, updated_at) VALUES (NEW.id, NEW.pin_plain, now())
    ON CONFLICT (team_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
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
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) 직접 쓰기 정책 복원
CREATE POLICY matches_insert ON public.matches FOR INSERT TO public WITH CHECK (true);
CREATE POLICY matches_update ON public.matches FOR UPDATE TO public USING (true);
CREATE POLICY matches_delete ON public.matches FOR DELETE TO public USING (true);
CREATE POLICY teams_insert ON public.teams FOR INSERT TO public WITH CHECK (true);
CREATE POLICY teams_update ON public.teams FOR UPDATE TO public USING (true);
CREATE POLICY teams_delete ON public.teams FOR DELETE TO public USING (true);
CREATE POLICY groups_insert ON public.groups FOR INSERT TO public WITH CHECK (true);
CREATE POLICY groups_update ON public.groups FOR UPDATE TO public USING (true);
CREATE POLICY groups_delete ON public.groups FOR DELETE TO public USING (true);
CREATE POLICY gm_insert ON public.group_members FOR INSERT TO public WITH CHECK (true);
CREATE POLICY gm_delete ON public.group_members FOR DELETE TO public USING (true);
CREATE POLICY gs_insert ON public.group_settings FOR INSERT TO public WITH CHECK (true);
CREATE POLICY gs_update ON public.group_settings FOR UPDATE TO public USING (true);

-- 3) 세션·잠금
CREATE POLICY public_read_venue_sessions ON public.venue_sessions FOR SELECT TO public USING (true);
ALTER TABLE public.pin_attempts DISABLE ROW LEVEL SECURITY;

-- 4) 실행 권한 복원
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'rpc_submit_match_result', 'advance_winner', 'rpc_fill_tournament_slots', 'rpc_fill_tournament_slots_manual',
        'rpc_generate_tournament', 'rpc_generate_groups', 'rpc_generate_group_matches',
        '_pin_check_locked', '_pin_record_fail', '_pin_record_success', '_venue_session', 'log_audit',
        'next_match_num', 'next_team_num')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- 5) 뷰 권한
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.v_group_board, public.v_court_board,
  public.v_matches_with_teams, public.v_bracket_with_details TO anon;

-- 6) 로그인 함수는 결과 반환 방식 그대로 둬도 새 화면에서 동작 (되돌릴 필요 없음)
