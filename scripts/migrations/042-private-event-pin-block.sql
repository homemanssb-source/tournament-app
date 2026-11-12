-- ============================================================
-- 042: 비공개(준비중) 대회는 PIN 로그인 막기 (2026-11-10)
--
--   대회를 비공개(events.status = 'preparing')로 둬도 /pin 에서 본인 PIN 을 넣으면
--   로그인되어 대진·경기 목록을 볼 수 있었다 (대회 상세 화면만 잠겨 있었음).
--   → rpc_pin_login(개인전)·rpc_captain_login(단체전 주장) 맨 앞에서 대회 상태를 보고
--     비공개(또는 status 비어 있음)면 바로 거절. 이때는 PIN 실패 횟수로 세지 않음.
--   함수 본문은 025b / 022a 그대로, 상태 확인 몇 줄만 추가. 권한(GRANT)은 OR REPLACE 라 유지.
--   공개(active)·완료(completed) 대회는 지금과 같음. 기존 데이터 변경 없음. 멱등.
--   되돌리기: 025b 의 rpc_pin_login, 022a 의 rpc_captain_login 블록을 다시 실행.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_pin_login(p_pin_code text, p_event_id uuid, p_division_name text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_team teams%ROWTYPE;
  v_token text;
  v_target_key text;
  v_lock_msg text;
BEGIN
  -- 비공개(준비중) 대회는 PIN 로그인 불가 — 실패 횟수에도 넣지 않음
  IF NOT EXISTS (SELECT 1 FROM events e WHERE e.id = p_event_id
                  AND COALESCE(e.status, 'preparing') <> 'preparing') THEN
    RETURN jsonb_build_object('success', false, 'error', '아직 공개되지 않은 대회입니다. 대회가 공개되면 확인할 수 있습니다.');
  END IF;
  v_target_key := 'login:' || p_event_id::text || ':' || md5(p_pin_code);
  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock_msg);
  END IF;
  -- 대회 전체 연속 실패도 제한 (PIN 을 바꿔가며 대입하는 것 방지)
  v_lock_msg := _pin_check_locked('login_event:' || p_event_id::text);
  IF v_lock_msg IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock_msg);
  END IF;

  SELECT t.* INTO v_team FROM teams t JOIN team_pins tp ON tp.team_id = t.id
  WHERE t.event_id = p_event_id
    AND tp.pin_plain = p_pin_code
    AND (p_division_name IS NULL OR t.division_name = p_division_name)
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM _pin_record_fail(v_target_key);
    PERFORM _pin_record_fail('login_event:' || p_event_id::text, 30, 5);
    RETURN jsonb_build_object('success', false, 'error', 'PIN이 올바르지 않습니다.');
  END IF;

  PERFORM _pin_record_success(v_target_key);
  PERFORM _pin_record_success('login_event:' || p_event_id::text);

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

CREATE OR REPLACE FUNCTION public.rpc_captain_login(p_event_id uuid, p_pin text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := 'captain_login:' || p_event_id::text;
  v_lock text;
  v_clubs json;
BEGIN
  -- 비공개(준비중) 대회는 PIN 로그인 불가 — 실패 횟수에도 넣지 않음
  IF NOT EXISTS (SELECT 1 FROM events e WHERE e.id = p_event_id
                  AND COALESCE(e.status, 'preparing') <> 'preparing') THEN
    RETURN json_build_object('success', false, 'error', '아직 공개되지 않은 대회입니다. 대회가 공개되면 확인할 수 있습니다.');
  END IF;
  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock);
  END IF;

  SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'event_id', c.event_id,
                                    'division_id', c.division_id, 'division_name', d.name)
                  ORDER BY d.sort_order NULLS LAST, c.name)
    INTO v_clubs
  FROM clubs c
  JOIN club_pins cp ON cp.club_id = c.id
  LEFT JOIN divisions d ON d.id = c.division_id
  WHERE c.event_id = p_event_id AND cp.captain_pin = p_pin AND p_pin ~ '^[0-9]{6}$';

  IF v_clubs IS NULL THEN
    PERFORM _pin_record_fail(v_key, 10, 10);
    RETURN json_build_object('success', false, 'error', '팀 PIN에 해당하는 클럽을 찾을 수 없습니다.');
  END IF;

  PERFORM _pin_record_success(v_key);
  RETURN json_build_object('success', true, 'clubs', v_clubs);
END;
$function$;
