-- ============================================================
-- 032: 경기장 PIN — 같은 경기장에 여러 폰 동시 로그인
--
--   증상: 경기장 PIN 으로 로그인하면 rpc_venue_login 이 같은 경기장의 기존 세션을
--         is_active=false 로 끊음 → 한 경기장에 두 사람이 있거나 다른 폰으로 다시 로그인하면
--         먼저 쓰던 사람이 점수 입력 중 로그인 화면으로 튕김.
--   수정: 030 의 "관리자 세션은 끊지 않음" 트리거를 모든 경기장 세션으로 넓힘.
--         세션은 만료 시각(12시간)으로만 끝남. 강제로 끝낼 때는 expires_at = now().
--   rpc_venue_login 정의는 그대로. 데이터 변경 없음. 멱등.
--   되돌리기: 032-rollback.sql
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_venue_sessions_keep_active()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    NEW.is_active := true;   -- 경기장 세션은 만료 시각(expires_at)으로만 끝남
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_venue_sessions_keep_active() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_venue_sessions_keep_admin ON public.venue_sessions;
DROP TRIGGER IF EXISTS trg_venue_sessions_keep_active ON public.venue_sessions;
CREATE TRIGGER trg_venue_sessions_keep_active
  BEFORE UPDATE OF is_active ON public.venue_sessions
  FOR EACH ROW EXECUTE FUNCTION public.fn_venue_sessions_keep_active();

-- 확인: 경기장 세션 트리거가 새 것 하나만
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.venue_sessions'::regclass AND NOT tgisinternal;   -- trg_venue_sessions_keep_active
