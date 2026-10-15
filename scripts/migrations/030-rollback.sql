-- 030 되돌리기 — 경기장 PIN 코트 권한 복구, 마스터 PIN 세션 30분, 추가 함수·트리거 삭제
GRANT EXECUTE ON FUNCTION public.rpc_venue_set_match_court(text, uuid, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_venue_assign_tie_court(text, uuid, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_venue_assign_court(text, uuid, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_venue_unassign_court(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_venue_submit_score(text, uuid, text, uuid) TO anon, authenticated;
DROP FUNCTION IF EXISTS public.rpc_venue_record_score(text, uuid, text, uuid);

ALTER TABLE public.admin_pin_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 minutes');

DROP FUNCTION IF EXISTS public.rpc_admin_pin_set_manual_rank(text, uuid, integer);
DROP FUNCTION IF EXISTS public.rpc_admin_pin_tie_walkover(text, uuid, uuid);
DROP FUNCTION IF EXISTS public.rpc_venue_admin_assign_tie_court(text, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.rpc_venue_admin_set_match_court(text, uuid, text, integer);
DROP FUNCTION IF EXISTS public._venue_admin_ok(text);
DROP FUNCTION IF EXISTS public.rpc_admin_pin_open_venue(text, uuid);

DROP TRIGGER IF EXISTS trg_event_secrets_end_admin_sessions ON public.event_secrets;
DROP FUNCTION IF EXISTS public.fn_event_secrets_end_admin_sessions();
DROP TRIGGER IF EXISTS trg_venue_sessions_keep_admin ON public.venue_sessions;
DROP FUNCTION IF EXISTS public.fn_venue_sessions_keep_admin();

-- 관리자 경기장 세션 끝내고 칸 삭제
UPDATE public.venue_sessions SET is_active = false WHERE is_admin = true;
ALTER TABLE public.venue_sessions DROP COLUMN IF EXISTS is_admin;
