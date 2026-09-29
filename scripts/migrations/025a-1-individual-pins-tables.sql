-- 025a 1부: PIN 보관 테이블 + 복사 + 트리거 (2부 전에 실행)
-- Supabase 편집기가 끝에 RLS 켜기 문을 덧붙여도 무해함 (이미 켜져 있음)
-- ============================================================
-- 025a: 개인전·경기장 보안 1단계 — 추가만 (2026-09-29)
--
-- 이 단계는 현재 배포된 화면을 깨지 않는다. 새 화면 배포 후 025b 에서 잠근다.
--
--   team_pins / venue_pins   — 팀 PIN·경기장 PIN 보관 (익명 접근 불가, 로그인 운영자·서버 함수만)
--                              teams.pin_plain / venues.pin_plain 에 쓰면 복사 (025b 부터는 옮기고 비움)
--   rpc_pin_login / rpc_pin_list_matches / rpc_pin_submit_score / rpc_venue_login
--                            — PIN 비교를 보관 테이블 기준으로 (동작 동일). list 는 team_ids 도 돌려줌
--   rpc_pin_check_in(token)  — PIN 로그인 = 출전 체크인 (그동안 화면이 teams 를 직접 수정)
--   rpc_venue_set_match_court(token, match, court, order)
--                            — 경기장 화면의 코트 배정·해제·순서 변경 (그동안 matches 직접 수정)
--   rpc_venue_* 기존 함수    — 다른 대회 경기에 손대지 못하게 event 확인 추가
--   rpc_admin_pin_teams / _locks / _unlock / _force_score / _fill_slots
--                            — 관리자 PIN 화면용 (세션 토큰 확인). 그동안 테이블 직접 조회·수정
-- ============================================================

-- ── PIN 보관 테이블 ──
CREATE TABLE IF NOT EXISTS public.team_pins (
  team_id    uuid PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  pin_plain  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_pins_pin_idx ON public.team_pins (pin_plain);
CREATE TABLE IF NOT EXISTS public.venue_pins (
  venue_id   uuid PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  pin_plain  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['team_pins', 'venue_pins'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format('GRANT ALL ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_operator_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (is_operator_or_admin()) WITH CHECK (is_operator_or_admin())', t || '_operator_all', t);
  END LOOP;
END $$;

INSERT INTO public.team_pins (team_id, pin_plain)
SELECT id, pin_plain FROM public.teams WHERE pin_plain IS NOT NULL
ON CONFLICT (team_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
INSERT INTO public.venue_pins (venue_id, pin_plain)
SELECT id, pin_plain FROM public.venues WHERE pin_plain IS NOT NULL
ON CONFLICT (venue_id) DO UPDATE SET pin_plain = EXCLUDED.pin_plain, updated_at = now();
-- 복사한 행의 FK 확인을 지금 끝낸다 (미뤄 둔 확인이 남아 있으면 뒤의 트리거 생성이 실패함)
SET CONSTRAINTS ALL IMMEDIATE;

-- 쓰면 복사 (025b 에서 "옮기고 비움" 으로 교체)
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
DROP TRIGGER IF EXISTS trg_teams_capture_pin ON public.teams;
CREATE TRIGGER trg_teams_capture_pin BEFORE INSERT OR UPDATE OF pin_plain ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.fn_teams_capture_pin();

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
DROP TRIGGER IF EXISTS trg_venues_capture_pin ON public.venues;
CREATE TRIGGER trg_venues_capture_pin BEFORE INSERT OR UPDATE OF pin_plain ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.fn_venues_capture_pin();

