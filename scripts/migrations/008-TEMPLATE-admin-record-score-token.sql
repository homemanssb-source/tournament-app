-- ============================================================
-- 008 (템플릿): rpc_admin_record_score에 관리자 토큰 검증 추가
--
-- ⚠️ 실행 전 스키마 확인 필수 — 아래 Step 0 먼저 돌려서
--    admin 세션 테이블 이름/컬럼 확인 후 Step 1 수정
--
-- 배경 (Bug 8):
--   현재 rpc_admin_record_score(p_rubber_id, p_set1_a, ...)는
--   인증 없이 누구나 호출 가능 (anon key로 접근 가능).
--   단체전 러버 점수를 캡틴 PIN 우회해서 조작 가능.
--
-- 목표:
--   rpc_admin_record_score에 p_token 파라미터 추가 +
--   내부에서 admin 세션 유효성 검증 후에만 진행
--
-- 주의: 프론트 코드(admin-pin/manage/page.tsx:211)도
--       p_token 넘기도록 같이 수정 필요
-- ============================================================

-- Step 0: 스키마 확인 (반드시 먼저 실행)
-- ============================================================
-- admin 세션 테이블 찾기
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND (tablename ILIKE '%admin%session%'
       OR tablename ILIKE '%admin_pin%'
       OR tablename ILIKE '%admin_session%');

-- 해당 테이블의 컬럼 확인 (테이블 이름은 위 결과로 대체)
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'admin_pin_sessions';

-- rpc_admin_pin_login 본문 확인 (토큰 저장 로직)
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'rpc_admin_pin_login';

-- rpc_admin_pin_unlock_match 본문 (토큰 검증 패턴 참고)
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'rpc_admin_pin_unlock_match';


-- Step 1: 템플릿 — admin_pin_sessions 가정 (실제 스키마에 맞춰 수정)
-- ============================================================
/*
CREATE OR REPLACE FUNCTION public.rpc_admin_record_score(
  p_token    text,   -- ✅ 신규
  p_rubber_id uuid,
  p_set1_a integer, p_set1_b integer,
  p_set2_a integer DEFAULT NULL,
  p_set2_b integer DEFAULT NULL,
  p_set3_a integer DEFAULT NULL,
  p_set3_b integer DEFAULT NULL
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_session RECORD;
  v_rubber  RECORD;
  v_tie     RECORD;
BEGIN
  -- 1. 토큰 검증 (실제 테이블/컬럼명에 맞춰 수정)
  SELECT * INTO v_session FROM admin_pin_sessions
  WHERE token = p_token
    AND is_active = true
    AND expires_at > now();
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '관리자 세션이 만료되었거나 유효하지 않습니다.');
  END IF;

  -- 2. 러버가 해당 이벤트 소속인지 확인 (토큰 하이재킹 방지)
  SELECT tr.*, t.event_id INTO v_rubber
  FROM tie_rubbers tr
  JOIN ties t ON t.id = tr.tie_id
  WHERE tr.id = p_rubber_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '러버를 찾을 수 없습니다.');
  END IF;
  IF v_rubber.event_id != v_session.event_id THEN
    RETURN json_build_object('success', false, 'error', '다른 이벤트의 러버에 접근할 수 없습니다.');
  END IF;

  -- 3. 기존 rpc_record_rubber_score 위임
  RETURN rpc_record_rubber_score(p_rubber_id, p_set1_a, p_set1_b, p_set2_a, p_set2_b, p_set3_a, p_set3_b);
END;
$function$;
*/


-- Step 2: 프론트 대응 (참고용 — 이미 적용 가능하도록 별도 PR 필요)
-- ============================================================
-- src/app/admin-pin/manage/page.tsx:211
--   supabase.rpc('rpc_admin_record_score', {
-- +   p_token: session.token,
--     p_rubber_id: scoringRubber,
--     ...
--   })


-- 롤백:
-- ============================================================
-- 토큰 파라미터 없는 이전 버전으로 CREATE OR REPLACE
