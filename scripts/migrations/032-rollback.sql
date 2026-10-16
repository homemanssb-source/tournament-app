-- 032 되돌리기 — 030 상태로 (관리자 경기장 세션만 유지, 일반 경기장 세션은 재로그인 시 끊김)
DROP TRIGGER IF EXISTS trg_venue_sessions_keep_active ON public.venue_sessions;
CREATE TRIGGER trg_venue_sessions_keep_admin
  BEFORE UPDATE OF is_active ON public.venue_sessions
  FOR EACH ROW EXECUTE FUNCTION public.fn_venue_sessions_keep_admin();
DROP FUNCTION IF EXISTS public.fn_venue_sessions_keep_active();
