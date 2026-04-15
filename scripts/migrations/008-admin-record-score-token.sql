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


-- Step 1: 확정 마이그레이션 (2026-04-15 스키마 확인 완료)
-- ============================================================
-- 확인된 스키마:
--   admin_pin_sessions(token, event_id, is_active, expires_at)
--   토큰 검증 패턴은 rpc_admin_pin_unlock_match와 동일
--
-- 실행 시 같이 해야 할 것:
--   - 프론트 admin-pin/manage/page.tsx:211의 rpc_admin_record_score 호출에
--     p_token: session.token 추가
CREATE OR REPLACE FUNCTION public.rpc_admin_record_score(
  p_token    text,
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
  v_session admin_pin_sessions%ROWTYPE;
  v_event_id uuid;
BEGIN
  -- 1. 토큰 검증 (rpc_admin_pin_unlock_match와 동일 패턴)
  SELECT * INTO v_session FROM admin_pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;

  -- 2. 러버가 이 세션의 이벤트 소속인지 확인 (다른 이벤트 접근 차단)
  SELECT t.event_id INTO v_event_id
  FROM tie_rubbers tr
  JOIN ties t ON t.id = tr.tie_id
  WHERE tr.id = p_rubber_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '러버를 찾을 수 없습니다.');
  END IF;
  IF v_event_id != v_session.event_id THEN
    RETURN json_build_object('success', false, 'error', '다른 이벤트의 러버에 접근할 수 없습니다.');
  END IF;

  -- 3. 감사 로그
  PERFORM log_audit(v_session.event_id, 'admin_pin_score', 'admin_pin',
    left(p_token, 8), 'tie_rubbers', p_rubber_id,
    jsonb_build_object('set1', p_set1_a || ':' || p_set1_b));

  -- 4. 기존 rpc_record_rubber_score 위임
  RETURN rpc_record_rubber_score(p_rubber_id, p_set1_a, p_set1_b,
                                 p_set2_a, p_set2_b, p_set3_a, p_set3_b);
END;
$function$;


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
