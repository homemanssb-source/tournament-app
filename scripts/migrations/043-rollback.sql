-- 043 되돌리기: 2026-11-15 라이브 덤프(043 적용 전) 그대로 복원 + 새로 만든 것 삭제
DROP TRIGGER IF EXISTS trg_b_unadvance_on_clear ON public.matches;
DROP FUNCTION IF EXISTS public.fn_trg_unadvance_on_clear();
DROP FUNCTION IF EXISTS public.fn_unadvance_winner(uuid, uuid);
DROP FUNCTION IF EXISTS public.rpc_venue_admin_place_match(text, uuid, text, uuid, boolean);
DROP FUNCTION IF EXISTS public.rpc_venue_admin_set_match_pending(text, uuid);

CREATE OR REPLACE FUNCTION public.rpc_pin_submit_score(p_token text, p_match_id uuid, p_score text, p_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_auto_start_next_match()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_next_id   uuid;
  v_cur_date  date;
BEGIN
  -- FINISHED로 바뀔 때만 실행
  IF NEW.status <> 'FINISHED' OR OLD.status = 'FINISHED' THEN
    RETURN NEW;
  END IF;

  -- 코트 배정 없으면 스킵
  IF NEW.court IS NULL THEN
    RETURN NEW;
  END IF;

  -- 현재 경기 부서의 날짜
  SELECT match_date INTO v_cur_date
  FROM divisions WHERE id = NEW.division_id;

  -- 같은 코트에서 다음 PENDING 경기 찾기
  SELECT m.id INTO v_next_id
  FROM matches m
  LEFT JOIN divisions d ON d.id = m.division_id
  WHERE m.event_id    = NEW.event_id
    AND m.court       = NEW.court
    AND m.status      = 'PENDING'
    AND (m.score IS NULL OR m.score <> 'BYE')
    AND m.court_order > NEW.court_order
    -- 날짜 필터: 둘 다 날짜 있으면 같은 날짜만, 없으면 무조건 포함
    AND (
      v_cur_date IS NULL
      OR d.match_date IS NULL
      OR d.match_date = v_cur_date
    )
  ORDER BY m.court_order ASC
  LIMIT 1;

  -- 다음 경기 시작
  IF v_next_id IS NOT NULL THEN
    UPDATE matches
    SET status     = 'IN_PROGRESS',
        started_at = now()
    WHERE id = v_next_id;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rpc_admin_pin_unlock_match(p_token text, p_match_id uuid, p_reason text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_session admin_pin_sessions%ROWTYPE;
  v_match matches%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM admin_pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION '마스터 PIN 세션이 만료되었습니다.'; END IF;

  SELECT * INTO v_match FROM matches
  WHERE id = p_match_id AND event_id = v_session.event_id;
  IF NOT FOUND THEN RAISE EXCEPTION '경기를 찾을 수 없습니다.'; END IF;

  UPDATE matches SET
    locked_by_participant = false,
    locked_reason = '관리자 해제: ' || COALESCE(p_reason, ''),
    status = 'PENDING',
    winner_team_id = NULL,
    score = NULL,
    ended_at = NULL
  WHERE id = p_match_id;

  PERFORM log_audit(v_session.event_id, 'admin_pin_unlock', 'admin_pin',
    left(p_token, 8), 'matches', p_match_id,
    jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('success', true, 'match_id', p_match_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_reseat_group_qualifiers(p_event_id uuid, p_group_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_div_id     uuid;
  v_group_name text;
  v_unfinished int;
  v_rows       jsonb;
  v_el         jsonb;
  v_blocked    int := 0;
  v_action     text;
BEGIN
  SELECT division_id, group_label INTO v_div_id, v_group_name
  FROM groups WHERE id = p_group_id AND event_id = p_event_id;
  IF v_div_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '그룹을 찾을 수 없습니다.');
  END IF;

  SELECT COUNT(*) INTO v_unfinished
  FROM matches
  WHERE event_id = p_event_id AND group_id = p_group_id
    AND stage = 'GROUP' AND status IS DISTINCT FROM 'FINISHED';
  IF v_unfinished > 0 THEN
    RETURN jsonb_build_object('success', true, 'changed', 0, 'note', 'group not finished');
  END IF;

  -- 이 조 출신 자리(seats) 와 현재 순위(ranked) 비교 → 달라진 자리만
  -- 순위: 승수 → 게임 득실(승자 기준) → (완전 동률이면 지금 앉은 순서 유지) → team_id
  WITH seats AS (
    SELECT m.id AS match_id, 'A'::text AS side,
           (regexp_match(m.qualifier_src_a, '(\d+)위$'))[1]::int AS rnk,
           m.team_a_id AS cur_team, m.match_num,
           (m.status IN ('PENDING', 'IN_PROGRESS') AND m.score IS NULL AND m.winner_team_id IS NULL) AS editable
    FROM matches m
    WHERE m.event_id = p_event_id AND m.division_id = v_div_id AND m.stage = 'FINALS'
      AND m.qualifier_label_a IS NULL AND m.qualifier_src_a LIKE v_group_name || ' %'
    UNION ALL
    SELECT m.id, 'B'::text,
           (regexp_match(m.qualifier_src_b, '(\d+)위$'))[1]::int,
           m.team_b_id, m.match_num,
           (m.status IN ('PENDING', 'IN_PROGRESS') AND m.score IS NULL AND m.winner_team_id IS NULL)
    FROM matches m
    WHERE m.event_id = p_event_id AND m.division_id = v_div_id AND m.stage = 'FINALS'
      AND m.qualifier_label_b IS NULL AND m.qualifier_src_b LIKE v_group_name || ' %'
  ),
  ranked AS (
    SELECT gm.team_id,
           ROW_NUMBER() OVER (ORDER BY COALESCE(w.wins, 0) DESC, COALESCE(gd.game_diff, 0) DESC,
                                       COALESCE(s.rnk, 999), gm.team_id)::int AS rnk
    FROM group_members gm
    LEFT JOIN (
      SELECT winner_team_id AS team_id, COUNT(*) AS wins
      FROM matches
      WHERE event_id = p_event_id AND group_id = p_group_id
        AND stage = 'GROUP' AND winner_team_id IS NOT NULL
      GROUP BY winner_team_id
    ) w ON gm.team_id = w.team_id
    LEFT JOIN fn_group_game_diff(p_event_id, v_div_id) gd ON gm.team_id = gd.team_id
    LEFT JOIN seats s ON s.cur_team = gm.team_id
    WHERE gm.group_id = p_group_id
  )
  SELECT jsonb_agg(jsonb_build_object(
           'match_id', s.match_id, 'match_num', s.match_num, 'side', s.side, 'rank', s.rnk,
           'from', s.cur_team, 'to', r.team_id, 'editable', s.editable))
  INTO v_rows
  FROM seats s
  JOIN ranked r ON r.rnk = s.rnk
  WHERE s.cur_team IS DISTINCT FROM r.team_id;

  IF v_rows IS NULL THEN
    RETURN jsonb_build_object('success', true, 'changed', 0);
  END IF;

  SELECT COUNT(*) INTO v_blocked
  FROM jsonb_array_elements(v_rows) e WHERE NOT (e->>'editable')::boolean;

  IF v_blocked > 0 THEN
    v_action := 'reseat_skipped';
  ELSE
    v_action := 'reseat_applied';
    FOR v_el IN SELECT * FROM jsonb_array_elements(v_rows) LOOP
      IF v_el->>'side' = 'A' THEN
        UPDATE matches SET team_a_id = (v_el->>'to')::uuid WHERE id = (v_el->>'match_id')::uuid;
      ELSE
        UPDATE matches SET team_b_id = (v_el->>'to')::uuid WHERE id = (v_el->>'match_id')::uuid;
      END IF;
    END LOOP;
  END IF;

  BEGIN
    PERFORM log_audit(p_event_id, v_action, 'system', 'reseat', 'groups', p_group_id,
      jsonb_build_object('group', v_group_name, 'changes', v_rows));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', v_blocked = 0,
    'changed', CASE WHEN v_blocked = 0 THEN jsonb_array_length(v_rows) ELSE 0 END,
    'blocked', v_blocked,
    'changes', v_rows);
END;
$function$
;

SELECT '043 rolled back' AS result;
