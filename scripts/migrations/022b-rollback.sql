-- ============================================================
-- 022b 되돌리기 — 문제가 생기면 이것만 실행 (022a 추가분은 그대로 둬도 무해)
-- ============================================================

-- 1) clubs.captain_pin 복원 + 트리거는 복사만
UPDATE public.clubs c SET captain_pin = cp.captain_pin
FROM public.club_pins cp WHERE cp.club_id = c.id AND c.captain_pin IS DISTINCT FROM cp.captain_pin;

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
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) team_lineups 전체 공개로
DROP POLICY IF EXISTS anon_read_revealed_team_lineups ON public.team_lineups;
DROP POLICY IF EXISTS authenticated_all_team_lineups ON public.team_lineups;
DROP POLICY IF EXISTS public_read_team_lineups ON public.team_lineups;
CREATE POLICY public_read_team_lineups ON public.team_lineups FOR SELECT TO public USING (true);

-- 3) 실행 권한 복원
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
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- 4) 관리자 PIN 로그인: 잠금 버전을 그대로 둬도 새/옛 화면 모두 동작 (되돌릴 필요 없음)
