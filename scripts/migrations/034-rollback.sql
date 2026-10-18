-- 034 되돌리기 (풀리그로 만든 조·경기는 그대로 남음 — 일반 조처럼 보임)
DROP FUNCTION IF EXISTS public.rpc_generate_league(uuid, uuid);
ALTER TABLE public.group_members DROP COLUMN IF EXISTS manual_rank;
ALTER TABLE public.divisions DROP CONSTRAINT IF EXISTS divisions_format_chk;
ALTER TABLE public.divisions DROP COLUMN IF EXISTS format;
