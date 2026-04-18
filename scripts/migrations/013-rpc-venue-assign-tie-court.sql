-- ============================================================
-- 013: rpc_venue_assign_tie_court — 현장관리에서 단체전 코트 배정
--
-- 배경:
--   현장관리(venue/manage)에서 단체전 코트 배정 버튼 눌러도 반영 안 됨.
--   진단: anon 키로 ties.update → RLS 차단 → 0 rows affected
--         프론트는 error: null로 받아 "배정됨" 메시지만 뜨고 DB는 안 바뀜.
--   matches는 RLS 허용 상태라 정상 작동했음.
--
-- 해결:
--   matches의 rpc_venue_submit_score / rpc_venue_start_match 패턴 동일하게
--   토큰 검증 후 ties 업데이트하는 SECURITY DEFINER 함수 추가.
--
-- 실행일: 2026-04-17
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_venue_assign_tie_court(
  p_token text,
  p_tie_id uuid,
  p_court_number integer,   -- null이면 배정 해제
  p_court_order  integer    -- null 허용
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_tie     ties%ROWTYPE;
BEGIN
  -- 1. 세션 검증 (기존 헬퍼 사용)
  v_session := _venue_session(p_token);

  -- 2. tie가 venue의 event에 속해있는지 확인 (토큰 하이재킹 방지)
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  IF v_tie.event_id <> v_session.event_id THEN
    RETURN json_build_object('success', false, 'error', '다른 이벤트의 대전에 접근할 수 없습니다.');
  END IF;

  -- 3. 업데이트
  UPDATE ties
     SET court_number = p_court_number,
         court_order  = p_court_order
   WHERE id = p_tie_id;

  RETURN json_build_object(
    'success', true,
    'tie_id', p_tie_id,
    'court_number', p_court_number,
    'court_order', p_court_order
  );
END;
$function$;

-- 검증
SELECT proname FROM pg_proc WHERE proname = 'rpc_venue_assign_tie_court';
