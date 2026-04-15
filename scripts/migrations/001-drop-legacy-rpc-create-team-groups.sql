-- ============================================================
-- 001: Legacy rpc_create_team_groups 3-arg 버전 삭제
--
-- 배경:
--   v1(3-arg, division 미지원)과 v2(4-arg, division 지원)이 공존
--   프론트는 항상 v2로 호출하므로 v1 불필요 + 데이터 사고 위험
--   (v1 호출 시 모든 부서 ties 삭제됨)
--
-- 실행일: 2026-04-15
-- ============================================================

-- 삭제
DROP FUNCTION IF EXISTS public.rpc_create_team_groups(uuid, integer, integer);

-- 검증 (1 row만 나와야 정상 — v2만 존재)
SELECT proname, pg_get_function_identity_arguments(oid) AS sig
FROM pg_proc WHERE proname = 'rpc_create_team_groups';
-- 기대: p_event_id uuid, p_group_count integer, p_group_size integer, p_division_id uuid
