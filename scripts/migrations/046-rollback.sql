-- 046 되돌리기: 코트-대회 검사 트리거 삭제 (데이터는 건드리지 않음)
DROP TRIGGER IF EXISTS trg_a1_court_in_event ON public.matches;
DROP FUNCTION IF EXISTS public.fn_matches_court_in_event();
