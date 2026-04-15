-- ============================================================
-- 006: pin_hash 평문 저장 버그 제거
--
-- 배경:
--   teams.pin_hash / venues.pin_hash 컬럼이 평문을 저장 중
--   "hash" 이름인데 실제로는 pin_plain과 같은 값 → 감사 오해 소지
--   rpc_pin_login도 이걸 bcrypt인양 crypt() 매칭 시도 (의미 없음)
--
-- 해결:
--   1. rpc_pin_login에서 pin_hash 참조 제거 (평문 경로만)
--   2. teams.pin_hash / venues.pin_hash 컬럼 DROP
--
-- 주의: events.master_pin_hash는 진짜 bcrypt (rpc_set_master_pin에서
--       crypt(pin, gen_salt('bf')) 사용) → 건드리지 않음
--
-- 실행일: 2026-04-15
-- ============================================================

BEGIN;

-- Step 1: rpc_pin_login에서 pin_hash bcrypt 분기 제거
CREATE OR REPLACE FUNCTION public.rpc_pin_login(
  p_pin_code text, p_event_id uuid, p_division_name text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_team teams%ROWTYPE;
  v_token text;
BEGIN
  SELECT * INTO v_team FROM teams
  WHERE event_id = p_event_id
    AND pin_plain = p_pin_code
    AND (p_division_name IS NULL OR division_name = p_division_name)
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PIN이 올바르지 않습니다.';
  END IF;

  INSERT INTO pin_sessions(event_id, team_id, division_name)
  VALUES (p_event_id, v_team.id, v_team.division_name)
  RETURNING token INTO v_token;

  PERFORM log_audit(p_event_id, 'pin_login', 'pin_user',
    left(v_token, 8), 'teams', v_team.id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'success', true, 'token', v_token,
    'team_id', v_team.id, 'team_name', v_team.team_name,
    'division', v_team.division_name, 'event_id', p_event_id
  );
END;
$function$;

-- Step 2: 쓸모없는 pin_hash 컬럼 삭제
ALTER TABLE teams   DROP COLUMN IF EXISTS pin_hash;
ALTER TABLE venues  DROP COLUMN IF EXISTS pin_hash;

COMMIT;

-- 검증 (pin_hash 없어야 함, events.master_pin_hash는 유지)
SELECT table_name, column_name
FROM information_schema.columns
WHERE column_name LIKE '%pin%'
  AND table_name IN ('teams','venues','events','clubs','tie_rubbers')
ORDER BY table_name, column_name;
-- 기대:
--   clubs.captain_pin
--   events.master_pin_hash
--   teams.pin_plain
--   tie_rubbers.pin_code
--   venues.pin_plain
