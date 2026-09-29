-- 025a 2부: 서버 함수 (1부 실행 후)
-- 같은 대회에서 같은 PIN 을 쓰는 팀들 (부서별 중복 등록)
CREATE OR REPLACE FUNCTION public._same_pin_team_ids(p_team_id uuid, p_event_id uuid)
 RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT t.id), ARRAY[p_team_id])
  FROM team_pins o
  JOIN team_pins p ON p.pin_plain = o.pin_plain
  JOIN teams t ON t.id = p.team_id AND t.event_id = p_event_id
  WHERE o.team_id = p_team_id AND o.pin_plain IS NOT NULL;
$function$;
REVOKE EXECUTE ON FUNCTION public._same_pin_team_ids(uuid, uuid) FROM PUBLIC, anon, authenticated;


-- ── 선수 PIN 로그인 (라이브 정의 + team_pins) ──
CREATE OR REPLACE FUNCTION public.rpc_pin_login(p_pin_code text, p_event_id uuid, p_division_name text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_team teams%ROWTYPE;
  v_token text;
  v_target_key text;
  v_lock_msg text;
BEGIN
  v_target_key := 'login:' || p_event_id::text || ':' || md5(p_pin_code);

  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_lock_msg;
  END IF;

  SELECT t.* INTO v_team FROM teams t JOIN team_pins tp ON tp.team_id = t.id
  WHERE t.event_id = p_event_id
    AND tp.pin_plain = p_pin_code
    AND (p_division_name IS NULL OR t.division_name = p_division_name)
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


-- ── 선수 경기 목록 (라이브 정의 + team_pins, team_ids 추가) ──
CREATE OR REPLACE FUNCTION public.rpc_pin_list_matches(p_token text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session pin_sessions%ROWTYPE;
  v_team_ids uuid[];
  v_result jsonb;
BEGIN
  SELECT * INTO v_session FROM pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PIN 세션이 만료되었거나 유효하지 않습니다.';
  END IF;

  v_team_ids := _same_pin_team_ids(v_session.team_id, v_session.event_id);
  IF v_team_ids IS NULL OR array_length(v_team_ids, 1) IS NULL THEN
    v_team_ids := ARRAY[v_session.team_id];
  END IF;

  SELECT jsonb_agg(row_to_json(sub)) INTO v_result
  FROM (
    SELECT m.id, m.match_num, m.stage::text, m.round, m.court, m.court_order,
           m.status::text, m.score, m.locked_by_participant,
           m.team_a_id, m.team_b_id,
           m.division_id, m.division_name,
           ta.team_name AS team_a_name, tb.team_name AS team_b_name,
           CASE WHEN m.team_a_id = ANY(v_team_ids) THEN 'A' ELSE 'B' END AS my_side
    FROM matches m
    LEFT JOIN teams ta ON m.team_a_id = ta.id
    LEFT JOIN teams tb ON m.team_b_id = tb.id
    WHERE m.event_id = v_session.event_id
      AND (m.team_a_id = ANY(v_team_ids) OR m.team_b_id = ANY(v_team_ids))
      AND m.status::text != 'FINISHED'
      AND (m.score IS NULL OR m.score != 'BYE')
    ORDER BY m.slot NULLS LAST
  ) sub;

  RETURN jsonb_build_object(
    'success', true,
    'team_id', v_session.team_id,
    'team_ids', to_jsonb(v_team_ids),
    'team_count', COALESCE(array_length(v_team_ids, 1), 0),
    'matches', COALESCE(v_result, '[]'::jsonb)
  );
END;
$function$;


-- ── 선수 점수 입력 (라이브 정의 + team_pins) ──
CREATE OR REPLACE FUNCTION public.rpc_pin_submit_score(p_token text, p_match_id uuid, p_score text, p_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session pin_sessions%ROWTYPE;
  v_team_ids uuid[];
  v_match matches%ROWTYPE;
  v_winner_id uuid;
  v_clean_score text;
  v_parts text[];
  v_a int;
  v_b int;
  v_winner_score int;
  v_loser_score int;
BEGIN
  SELECT * INTO v_session FROM pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PIN 세션이 만료되었습니다. 다시 로그인해주세요.';
  END IF;

  v_team_ids := _same_pin_team_ids(v_session.team_id, v_session.event_id);

  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '경기를 찾을 수 없습니다.'; END IF;

  IF NOT (v_match.team_a_id = ANY(v_team_ids) OR v_match.team_b_id = ANY(v_team_ids)) THEN
    RAISE EXCEPTION '본인 팀의 경기가 아닙니다.';
  END IF;

  IF v_match.locked_by_participant THEN
    RAISE EXCEPTION '이미 결과가 입력되어 수정할 수 없습니다. 운영자에게 문의하세요.';
  END IF;
  IF v_match.status = 'FINISHED' THEN
    RAISE EXCEPTION '이미 완료된 경기입니다.';
  END IF;
  v_clean_score := replace(replace(p_score, '-', ':'), ' ', ':');
  v_parts := string_to_array(v_clean_score, ':');
  IF array_length(v_parts, 1) != 2 THEN
    RAISE EXCEPTION '점수 형식이 올바르지 않습니다. (예: 6:4 또는 6-4)';
  END IF;
  BEGIN
    v_a := v_parts[1]::int;
    v_b := v_parts[2]::int;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '점수는 숫자여야 합니다. (예: 6:4)';
  END;
  IF v_a = v_b THEN
    RAISE EXCEPTION '동점은 허용되지 않습니다.';
  END IF;
  IF p_winner_id IS NOT NULL THEN
    IF p_winner_id != v_match.team_a_id AND p_winner_id != v_match.team_b_id THEN
      RAISE EXCEPTION '선택한 승자가 이 경기의 팀이 아닙니다.';
    END IF;
    v_winner_id := p_winner_id;
  ELSE
    IF v_a > v_b THEN v_winner_id := v_match.team_a_id;
    ELSE v_winner_id := v_match.team_b_id;
    END IF;
  END IF;
  v_winner_score := GREATEST(v_a, v_b);
  v_loser_score := LEAST(v_a, v_b);
  UPDATE matches SET
    score = v_winner_score::text || ':' || v_loser_score::text,
    winner_team_id = v_winner_id,
    status = 'FINISHED',
    locked_by_participant = true,
    locked_reason = 'PIN 입력',
    ended_at = now()
  WHERE id = p_match_id;
  IF v_match.stage = 'FINALS' THEN
    PERFORM advance_winner(p_match_id);
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'match_id', p_match_id,
    'score', v_winner_score::text || ':' || v_loser_score::text,
    'winner_team_id', v_winner_id
  );
END;
$function$;


-- ── PIN 로그인 = 출전 체크인 ──
CREATE OR REPLACE FUNCTION public.rpc_pin_check_in(p_token text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session pin_sessions%ROWTYPE;
  v_n int;
BEGIN
  SELECT * INTO v_session FROM pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN 세션이 만료되었습니다.');
  END IF;
  UPDATE teams SET checked_in = true, checked_in_at = now()
  WHERE id = ANY(_same_pin_team_ids(v_session.team_id, v_session.event_id)) AND NOT coalesce(checked_in, false);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'checked_in', v_n);
END;
$function$;


-- ── 경기장 PIN 로그인 (라이브 정의 + venue_pins) ──
CREATE OR REPLACE FUNCTION public.rpc_venue_login(p_pin_code text, p_event_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_venue record;
  v_token text;
BEGIN
  SELECT v.* INTO v_venue FROM venues v JOIN venue_pins vp ON vp.venue_id = v.id
  WHERE v.event_id = p_event_id AND vp.pin_plain = p_pin_code;
  IF v_venue IS NULL THEN
    SELECT * INTO v_venue FROM venues
    WHERE event_id = p_event_id AND pin_hash = crypt(p_pin_code, pin_hash);
  END IF;
  IF v_venue IS NULL THEN
    RAISE EXCEPTION '경기장 PIN이 올바르지 않습니다.';
  END IF;
  UPDATE venue_sessions SET is_active = false
  WHERE venue_id = v_venue.id AND is_active = true;
  INSERT INTO venue_sessions(event_id, venue_id, venue_name, courts)
  VALUES (p_event_id, v_venue.id, v_venue.name, v_venue.courts)
  RETURNING token INTO v_token;
  RETURN jsonb_build_object(
    'token', v_token,
    'venue_id', v_venue.id,
    'venue_name', v_venue.name,
    'courts', v_venue.courts,
    'event_id', p_event_id,
    'manager_name', v_venue.manager_name,
    'short_name', COALESCE(v_venue.short_name, ''),
    'court_count', COALESCE(v_venue.court_count, array_length(v_venue.courts, 1), 0)
  );
END;
$function$;


-- ── 경기장: 코트 배정·해제·순서 (그 대회 경기, 내 코트만) ──
CREATE OR REPLACE FUNCTION public.rpc_venue_set_match_court(p_token text, p_match_id uuid, p_court text, p_court_order integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_match matches%ROWTYPE;
BEGIN
  v_session := _venue_session(p_token);
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF NOT FOUND OR v_match.event_id <> v_session.event_id THEN
    RETURN jsonb_build_object('success', false, 'error', '이 대회의 경기가 아닙니다.');
  END IF;
  IF p_court IS NOT NULL AND NOT (p_court = ANY(v_session.courts)) THEN
    RETURN jsonb_build_object('success', false, 'error', '자기 경기장 코트에만 배정할 수 있습니다.');
  END IF;
  UPDATE matches SET court = p_court, court_order = CASE WHEN p_court IS NULL THEN NULL ELSE p_court_order END, updated_at = now()
  WHERE id = p_match_id;
  RETURN jsonb_build_object('success', true);
END;
$function$;


-- ── 기존 경기장 함수: 다른 대회 경기 차단 (라이브 정의 + event 확인) ──
CREATE OR REPLACE FUNCTION public.rpc_venue_start_match(p_token text, p_match_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_match record;
BEGIN
  v_session := _venue_session(p_token);
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match IS NULL OR v_match.event_id <> v_session.event_id THEN RAISE EXCEPTION '경기를 찾을 수 없습니다.'; END IF;
  IF NOT (v_match.court = ANY(v_session.courts)) THEN
    RAISE EXCEPTION '이 코트의 관리 권한이 없습니다.';
  END IF;
  UPDATE matches SET status = 'IN_PROGRESS', updated_at = now()
  WHERE id = p_match_id AND status = 'PENDING';
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_venue_submit_score(p_token text, p_match_id uuid, p_score text, p_winner_team_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_match record;
BEGIN
  v_session := _venue_session(p_token);
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match IS NULL OR v_match.event_id <> v_session.event_id THEN RAISE EXCEPTION '경기를 찾을 수 없습니다.'; END IF;
  IF NOT (v_match.court = ANY(v_session.courts)) THEN
    RAISE EXCEPTION '이 코트의 관리 권한이 없습니다. (담당: %)', array_to_string(v_session.courts, ', ');
  END IF;
  IF p_winner_team_id IS DISTINCT FROM v_match.team_a_id AND p_winner_team_id IS DISTINCT FROM v_match.team_b_id THEN
    RAISE EXCEPTION '승자는 경기에 참가한 팀이어야 합니다.';
  END IF;
  UPDATE matches SET
    score = p_score,
    winner_team_id = p_winner_team_id,
    status = 'FINISHED',
    ended_at = now(),
    updated_at = now()
  WHERE id = p_match_id;
  PERFORM advance_winner(p_match_id);
  INSERT INTO audit_log(event_id, action, actor_type, actor_id, target_table, target_id, details)
  VALUES (v_session.event_id, 'venue_submit_score', 'venue_manager', v_session.venue_name,
          'matches', p_match_id,
          jsonb_build_object('score', p_score, 'winner', p_winner_team_id));
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_venue_assign_court(p_token text, p_match_id uuid, p_court text, p_court_order integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
BEGIN
  v_session := _venue_session(p_token);
  IF NOT (p_court = ANY(v_session.courts)) THEN
    RAISE EXCEPTION '이 코트의 관리 권한이 없습니다. (담당: %)', array_to_string(v_session.courts, ', ');
  END IF;
  UPDATE matches SET court = p_court, court_order = p_court_order, updated_at = now()
  WHERE id = p_match_id AND event_id = v_session.event_id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_venue_unassign_court(p_token text, p_match_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_match record;
BEGIN
  v_session := _venue_session(p_token);
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match IS NULL OR v_match.event_id <> v_session.event_id OR NOT (v_match.court = ANY(v_session.courts)) THEN
    RAISE EXCEPTION '이 코트의 관리 권한이 없습니다.';
  END IF;
  UPDATE matches SET court = NULL, court_order = NULL, updated_at = now()
  WHERE id = p_match_id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;


-- ── 관리자 PIN 화면 ──
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_teams(p_token text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  RETURN json_build_object('success', true, 'teams', coalesce((
    SELECT json_agg(json_build_object('id', t.id, 'team_num', t.team_num, 'team_name', t.team_name,
                                      'division_name', t.division_name, 'pin_plain', tp.pin_plain)
                    ORDER BY t.division_name, t.team_num)
    FROM teams t LEFT JOIN team_pins tp ON tp.team_id = t.id
    WHERE t.event_id = v_event), '[]'::json));
END;
$function$;

-- 이 대회와 관련된 잠금 키인지
CREATE OR REPLACE FUNCTION public._pin_key_in_event(p_key text, p_event uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT p_key LIKE '%' || p_event::text || '%'
      OR (p_key LIKE 'club:%' AND EXISTS (SELECT 1 FROM clubs WHERE id::text = substring(p_key FROM 6) AND event_id = p_event))
      OR (p_key LIKE 'captain_tie:%' AND EXISTS (SELECT 1 FROM ties WHERE id::text = substring(p_key FROM 13) AND event_id = p_event))
      OR (p_key LIKE 'rubber:%' AND EXISTS (SELECT 1 FROM tie_rubbers r JOIN ties t ON t.id = r.tie_id
                                             WHERE r.id::text = substring(p_key FROM 8) AND t.event_id = p_event));
$function$;
REVOKE EXECUTE ON FUNCTION public._pin_key_in_event(text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_admin_pin_locks(p_token text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  RETURN json_build_object('success', true, 'locks', coalesce((
    SELECT json_agg(to_json(a) ORDER BY a.updated_at DESC) FROM pin_attempts a
    WHERE a.locked_until > now() AND _pin_key_in_event(a.target_key, v_event)), '[]'::json));
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_admin_pin_unlock(p_token text, p_keys text[])
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
  v_n int;
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  DELETE FROM pin_attempts WHERE target_key = ANY(p_keys) AND _pin_key_in_event(target_key, v_event);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM log_audit(v_event, 'admin_pin_unlock_pins', 'admin_pin', left(p_token, 8), 'pin_attempts', NULL,
    jsonb_build_object('count', v_n));
  RETURN json_build_object('success', true, 'unlocked', v_n);
END;
$function$;

-- 다음 라운드가 이미 끝났어도 강제로 결과 수정 (그동안 화면이 matches 를 직접 수정)
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_force_score(p_token text, p_match_id uuid, p_score text, p_winner_team_id uuid)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
  v_match matches%ROWTYPE;
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND OR v_match.event_id <> v_event THEN
    RETURN json_build_object('success', false, 'error', '경기를 찾을 수 없습니다.');
  END IF;
  IF p_winner_team_id IS DISTINCT FROM v_match.team_a_id AND p_winner_team_id IS DISTINCT FROM v_match.team_b_id THEN
    RETURN json_build_object('success', false, 'error', '승자는 경기에 참가한 팀이어야 합니다.');
  END IF;
  UPDATE matches SET score = p_score, winner_team_id = p_winner_team_id, status = 'FINISHED',
         ended_at = coalesce(v_match.ended_at, now()), locked_by_participant = false, locked_reason = '관리자 강제 수정'
  WHERE id = p_match_id;
  IF v_match.stage = 'FINALS' THEN
    PERFORM advance_winner(p_match_id);
  END IF;
  PERFORM log_audit(v_event, 'admin_pin_force_score', 'admin_pin', left(p_token, 8), 'matches', p_match_id,
    jsonb_build_object('score', p_score, 'new_winner', p_winner_team_id, 'old_winner', v_match.winner_team_id));
  RETURN json_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_admin_pin_fill_slots(p_token text, p_group_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
BEGIN
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM groups WHERE id = p_group_id AND event_id = v_event) THEN
    RETURN jsonb_build_object('success', false, 'error', '그룹을 찾을 수 없습니다.');
  END IF;
  RETURN rpc_fill_tournament_slots(v_event, p_group_id);
END;
$function$;
