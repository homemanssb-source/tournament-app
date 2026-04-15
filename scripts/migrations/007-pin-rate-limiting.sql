-- ============================================================
-- 007: PIN 브루트포스 방어 — Rate limiting
--
-- 정책:
--   - 같은 타겟에 5회 실패 → 10분 잠금
--   - 잠금 중이면 올바른 PIN이어도 거부
--   - 성공 시 카운터 리셋
--   - 잠금 만료 후 첫 실패부터 카운터 리셋
--
-- 보호 대상:
--   - rpc_submit_lineup  → club:{club_id} 기준
--   - rpc_team_pin_score → rubber:{rubber_id} 기준
--   - rpc_pin_login      → login:{event_id}:{md5(pin)} 기준
--                          (PIN 평문을 DB에 저장 안 하기 위해 md5)
--
-- 실행일: 2026-04-15
-- ============================================================

BEGIN;

-- ========================================
-- 1. pin_attempts 추적 테이블
-- ========================================
CREATE TABLE IF NOT EXISTS pin_attempts (
  target_key    text PRIMARY KEY,
  fail_count    int  DEFAULT 0,
  locked_until  timestamptz,
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pin_attempts_locked
  ON pin_attempts(locked_until)
  WHERE locked_until IS NOT NULL;

-- ========================================
-- 2. Helper 함수 3개
-- ========================================

-- 2-1. 잠금 체크
CREATE OR REPLACE FUNCTION public._pin_check_locked(p_target_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_locked_until timestamptz;
  v_seconds int;
BEGIN
  SELECT locked_until INTO v_locked_until
  FROM pin_attempts WHERE target_key = p_target_key;

  IF v_locked_until IS NULL OR v_locked_until < now() THEN
    RETURN NULL;
  END IF;

  v_seconds := EXTRACT(EPOCH FROM (v_locked_until - now()))::int;
  RETURN 'PIN 시도 횟수 초과. 약 ' || (v_seconds / 60 + 1) || '분 후 다시 시도하세요.';
END;
$$;

-- 2-2. 실패 기록
CREATE OR REPLACE FUNCTION public._pin_record_fail(
  p_target_key text,
  p_max_attempts int DEFAULT 5,
  p_lockout_minutes int DEFAULT 10
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_count int;
BEGIN
  INSERT INTO pin_attempts (target_key, fail_count, updated_at)
  VALUES (p_target_key, 1, now())
  ON CONFLICT (target_key) DO UPDATE SET
    fail_count =
      CASE WHEN pin_attempts.locked_until IS NOT NULL
            AND pin_attempts.locked_until < now()
           THEN 1
           ELSE pin_attempts.fail_count + 1
      END,
    updated_at = now()
  RETURNING fail_count INTO v_new_count;

  IF v_new_count >= p_max_attempts THEN
    UPDATE pin_attempts
    SET locked_until = now() + (p_lockout_minutes || ' minutes')::interval
    WHERE target_key = p_target_key;
  END IF;
END;
$$;

-- 2-3. 성공 시 리셋
CREATE OR REPLACE FUNCTION public._pin_record_success(p_target_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM pin_attempts WHERE target_key = p_target_key;
END;
$$;

-- ========================================
-- 3. rpc_submit_lineup (captain PIN + rate limit)
-- ========================================
CREATE OR REPLACE FUNCTION public.rpc_submit_lineup(
  p_tie_id uuid, p_club_id uuid, p_captain_pin text, p_lineups jsonb
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tie RECORD;
  v_club RECORD;
  v_lineup JSONB;
  v_event RECORD;
  v_both_submitted BOOLEAN;
  v_target_key text;
  v_lock_msg text;
BEGIN
  v_target_key := 'club:' || p_club_id::text;

  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock_msg);
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  SELECT * INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club IS NULL THEN
    RETURN json_build_object('success', false, 'error', '클럽을 찾을 수 없습니다.');
  END IF;

  IF v_tie.club_a_id != p_club_id AND v_tie.club_b_id != p_club_id THEN
    RETURN json_build_object('success', false, 'error', '이 대전에 참가하는 클럽이 아닙니다.');
  END IF;

  SELECT * INTO v_event FROM events WHERE id = v_tie.event_id;
  IF v_event.lineup_mode = 'captain_pin' THEN
    IF v_club.captain_pin IS NULL OR v_club.captain_pin != p_captain_pin THEN
      PERFORM _pin_record_fail(v_target_key);
      RETURN json_build_object('success', false, 'error', 'PIN이 일치하지 않습니다.');
    END IF;
  END IF;

  PERFORM _pin_record_success(v_target_key);

  IF v_tie.lineup_revealed = true THEN
    RETURN json_build_object('success', false, 'error', '라인업이 이미 확정되어 수정할 수 없습니다.');
  END IF;

  IF jsonb_array_length(p_lineups) != v_tie.rubber_count THEN
    RETURN json_build_object('success', false, 'error',
      '라인업 수(' || jsonb_array_length(p_lineups) || ')가 복식 수(' || v_tie.rubber_count || ')와 다릅니다.');
  END IF;

  DELETE FROM team_lineups WHERE tie_id = p_tie_id AND club_id = p_club_id;

  FOR v_lineup IN SELECT * FROM jsonb_array_elements(p_lineups)
  LOOP
    INSERT INTO team_lineups (tie_id, club_id, rubber_number, player1_id, player2_id, submitted_by)
    VALUES (
      p_tie_id, p_club_id,
      (v_lineup->>'rubber_number')::INT,
      (v_lineup->>'player1_id')::UUID,
      (v_lineup->>'player2_id')::UUID,
      'captain'
    );
  END LOOP;

  IF p_club_id = v_tie.club_a_id THEN
    UPDATE ties SET club_a_lineup_submitted = true, status = 'lineup_phase' WHERE id = p_tie_id;
  ELSIF p_club_id = v_tie.club_b_id THEN
    UPDATE ties SET club_b_lineup_submitted = true, status = 'lineup_phase' WHERE id = p_tie_id;
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  v_both_submitted := v_tie.club_a_lineup_submitted AND v_tie.club_b_lineup_submitted;

  IF v_both_submitted THEN
    UPDATE ties SET
      lineup_revealed = true, lineup_locked_at = now(),
      status = 'lineup_ready'
    WHERE id = p_tie_id;
    UPDATE team_lineups SET is_revealed = true WHERE tie_id = p_tie_id;
    PERFORM rpc_apply_lineups_to_rubbers(p_tie_id);
  END IF;

  RETURN json_build_object('success', true, 'revealed', v_both_submitted);
END;
$function$;

-- ========================================
-- 4. rpc_team_pin_score (rubber PIN + rate limit)
-- ========================================
CREATE OR REPLACE FUNCTION public.rpc_team_pin_score(
  p_pin text, p_rubber_id uuid,
  p_set1_a integer, p_set1_b integer,
  p_set2_a integer DEFAULT NULL::integer, p_set2_b integer DEFAULT NULL::integer,
  p_set3_a integer DEFAULT NULL::integer, p_set3_b integer DEFAULT NULL::integer
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_rubber RECORD;
  v_target_key text;
  v_lock_msg text;
BEGIN
  v_target_key := 'rubber:' || p_rubber_id::text;

  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock_msg);
  END IF;

  SELECT * INTO v_rubber FROM tie_rubbers WHERE id = p_rubber_id AND pin_code = p_pin;
  IF v_rubber IS NULL THEN
    PERFORM _pin_record_fail(v_target_key);
    RETURN json_build_object('success', false, 'error', 'PIN이 일치하지 않습니다.');
  END IF;

  PERFORM _pin_record_success(v_target_key);

  IF v_rubber.status = 'completed' THEN
    RETURN json_build_object('success', false, 'error', '이미 완료된 경기입니다.');
  END IF;

  RETURN rpc_record_rubber_score(p_rubber_id, p_set1_a, p_set1_b, p_set2_a, p_set2_b, p_set3_a, p_set3_b);
END;
$function$;

-- ========================================
-- 5. rpc_pin_login (team PIN login + rate limit)
-- ========================================
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
  v_target_key text;
  v_lock_msg text;
BEGIN
  -- PIN 평문 방지를 위해 md5 해시
  v_target_key := 'login:' || p_event_id::text || ':' || md5(p_pin_code);

  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_lock_msg;
  END IF;

  SELECT * INTO v_team FROM teams
  WHERE event_id = p_event_id
    AND pin_plain = p_pin_code
    AND (p_division_name IS NULL OR division_name = p_division_name)
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM _pin_record_fail(v_target_key);
    RAISE EXCEPTION 'PIN이 올바르지 않습니다.';
  END IF;

  PERFORM _pin_record_success(v_target_key);

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

COMMIT;

-- ========================================
-- 검증
-- ========================================
SELECT proname, pg_get_function_identity_arguments(oid) AS sig
FROM pg_proc
WHERE proname IN (
  '_pin_check_locked', '_pin_record_fail', '_pin_record_success',
  'rpc_submit_lineup', 'rpc_team_pin_score', 'rpc_pin_login'
)
ORDER BY proname;
-- 기대: 6 rows

-- ========================================
-- 운영: 수동 잠금 해제
-- ========================================
-- 특정 클럽 PIN 잠금 해제
--   DELETE FROM pin_attempts WHERE target_key = 'club:{club_id}';
--
-- 특정 러버 PIN 잠금 해제
--   DELETE FROM pin_attempts WHERE target_key = 'rubber:{rubber_id}';
--
-- 모든 잠금 해제
--   TRUNCATE pin_attempts;
