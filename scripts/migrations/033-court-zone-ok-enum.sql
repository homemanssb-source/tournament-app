-- ============================================================
-- 033: 빈 코트 자동 이어 배정(026·027) 이 실서버에서 동작하지 않던 문제
--
--   실서버 matches.stage 는 text 가 아니라 enum 타입 match_stage 라서
--   fn_auto_fill_idle_court 안의 _court_zone_ok(jsonb, uuid, match_stage, text) 호출이
--   "function does not exist" 로 실패 → 트리거가 오류를 삼키고(점수 저장은 정상) 아무것도 배정하지 않았다.
--   (2026-10-16 실서버 시뮬레이션 scripts/sim-auto-court.mjs 로 발견, Postgres 로그 WARNING 확인)
--   → match_stage 를 받는 _court_zone_ok 를 하나 더 만들어 text 버전으로 넘김.
--   트리거·기존 함수 본문 변경 없음. 이 함수 추가만. 멱등.
--   026 적용 이후 ④를 켠 대회는 없었음(events.auto_fill_courts 0/7) — 실제 영향 없음.
-- ============================================================

CREATE OR REPLACE FUNCTION public._court_zone_ok(p_zones jsonb, p_div uuid, p_stage public.match_stage, p_court text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT public._court_zone_ok(p_zones, p_div, p_stage::text, p_court)
$function$;

-- 확인: match_stage 버전이 생겼고, 예선/본선 둘 다 계산되는지
SELECT 'overloads' AS obj, count(*)::text AS n FROM pg_proc WHERE proname = '_court_zone_ok'
UNION ALL SELECT 'group_no_zone', public._court_zone_ok(NULL::jsonb, NULL::uuid, 'GROUP'::public.match_stage, 'S-1')::text
UNION ALL SELECT 'finals_in_zone', public._court_zone_ok('{"00000000-0000-0000-0000-000000000001":{"finals":["S-1"]}}'::jsonb,
  '00000000-0000-0000-0000-000000000001'::uuid, 'FINALS'::public.match_stage, 'S-1')::text
UNION ALL SELECT 'finals_out_zone', public._court_zone_ok('{"00000000-0000-0000-0000-000000000001":{"finals":["S-2"]}}'::jsonb,
  '00000000-0000-0000-0000-000000000001'::uuid, 'FINALS'::public.match_stage, 'S-1')::text;
