-- 043: 2026-11-15 혼디모영배에서 나온 문제 6건 (개인전 matches)
--   라이브 정의(.live-defs/1115, 2026-11-15 덤프)를 최소 수정. 되돌리기: 043-rollback.sql
--
--   ① rpc_pin_submit_score      : 상대 미정이면 거절 + 같은 팀 앞 경기가 2분 안에 끝났으면 거절 (다음 경기 중복 입력 방지)
--   ② fn_auto_start_next_match  : 그 코트에 이미 진행 중 경기가 있거나 다음 경기 팀이 미정이면 시작하지 않음
--   ③ rpc_admin_pin_unlock_match: 다음 라운드에 올라간 팀도 되돌림 (다음 경기에 결과가 있으면 거절)
--                                 + 그 경기가 끝나며 자동으로 켜진 같은 코트 '진행 중'도 대기로
--      fn_unadvance_winner / trg_b_unadvance_on_clear: 다른 경로(대시보드)로 결과를 지워도 같은 되돌림 (실패해도 저장은 막지 않음)
--   ④ fn_reseat_group_qualifiers: 순위 자리가 부전승(BYE) 경기여도, 다음 경기에 결과가 없으면 재배치 + 다음 라운드 자리까지 교체
--   ⑤ rpc_venue_admin_place_match      : 경기를 '몇 번 코트, 어느 경기 앞'에 넣기 (뒤 경기는 한 칸씩 밀림)
--   ⑥ rpc_venue_admin_set_match_pending: 잘못 켜진 '진행 중'을 대기로 되돌리기
--      (⑤ 에 p_set_pending 을 주면 진행 중 경기를 대기로 바꿔서 옮김)

-- ───────────────────────── ① 선수 PIN 점수 입력 ─────────────────────────
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

  -- 043: 상대가 아직 안 정해진 경기에는 점수를 넣을 수 없음
  IF v_match.team_a_id IS NULL OR v_match.team_b_id IS NULL THEN
    RAISE EXCEPTION '상대 팀이 아직 정해지지 않은 경기입니다. 앞 경기 점수가 이미 저장됐는지 확인해주세요.';
  END IF;
  -- 043: 같은 팀의 앞 경기가 방금(2분 안) 끝났으면 다음 경기 점수는 받지 않음 (같은 점수를 다음 경기에 한 번 더 넣는 실수 방지)
  IF EXISTS (
    SELECT 1 FROM matches pm
    WHERE pm.event_id = v_match.event_id AND pm.id <> p_match_id
      AND pm.status = 'FINISHED' AND pm.score IS DISTINCT FROM 'BYE'
      AND pm.ended_at > now() - interval '2 minutes'
      AND (pm.team_a_id = ANY(v_team_ids) OR pm.team_b_id = ANY(v_team_ids))
  ) THEN
    RAISE EXCEPTION '방금 앞 경기 점수가 저장되었습니다. 이 경기는 그 다음 경기입니다. 정말 이 경기가 끝났다면 2분 뒤 다시 입력하거나 운영자에게 알려주세요.';
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

-- ───────────────────────── ② 자동 시작 ─────────────────────────
CREATE OR REPLACE FUNCTION public.fn_auto_start_next_match()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_next_id   uuid;
  v_next_ready boolean;
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

  -- 043: 그 코트에 이미 진행 중인 경기가 있으면 더 켜지 않음 (점수 정정·재입력 때마다 하나씩 늘던 문제)
  IF EXISTS (
    SELECT 1 FROM matches m
    LEFT JOIN divisions d ON d.id = m.division_id
    WHERE m.event_id = NEW.event_id AND m.court = NEW.court
      AND m.id <> NEW.id AND m.status = 'IN_PROGRESS'
      AND (v_cur_date IS NULL OR d.match_date IS NULL OR d.match_date = v_cur_date)
  ) THEN
    RETURN NEW;
  END IF;

  -- 같은 코트에서 다음 PENDING 경기 찾기
  SELECT m.id, (m.team_a_id IS NOT NULL AND m.team_b_id IS NOT NULL) INTO v_next_id, v_next_ready
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

  -- 다음 경기 시작 (043: 두 팀이 모두 정해진 경기만)
  IF v_next_id IS NOT NULL AND v_next_ready THEN
    UPDATE matches
    SET status     = 'IN_PROGRESS',
        started_at = now()
    WHERE id = v_next_id;
  END IF;

  RETURN NEW;
END;
$function$;

-- ───────────────────────── ③ 결과를 지우면 다음 라운드 자리도 되돌림 ─────────────────────────
-- 결과: {changed:true|false, blocked:true|false, next_match_id}
CREATE OR REPLACE FUNCTION public.fn_unadvance_winner(p_match_id uuid, p_old_winner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bn   bracket_nodes%ROWTYPE;
  v_next matches%ROWTYPE;
BEGIN
  IF p_old_winner IS NULL THEN RETURN jsonb_build_object('changed', false); END IF;
  SELECT * INTO v_bn FROM bracket_nodes WHERE match_id = p_match_id;
  IF NOT FOUND OR v_bn.next_match_id IS NULL OR v_bn.lock THEN RETURN jsonb_build_object('changed', false); END IF;
  SELECT * INTO v_next FROM matches WHERE id = v_bn.next_match_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('changed', false); END IF;

  -- 그 자리에 앉은 팀이 지워진 승자가 아니면 건드리지 않음
  IF (v_bn.next_slot = 'A' AND v_next.team_a_id IS DISTINCT FROM p_old_winner)
     OR (v_bn.next_slot = 'B' AND v_next.team_b_id IS DISTINCT FROM p_old_winner)
     OR v_bn.next_slot NOT IN ('A', 'B') THEN
    RETURN jsonb_build_object('changed', false);
  END IF;
  -- 다음 경기에 이미 결과가 있으면 되돌리지 않음
  IF v_next.status = 'FINISHED' OR v_next.score IS NOT NULL OR v_next.winner_team_id IS NOT NULL THEN
    RETURN jsonb_build_object('changed', false, 'blocked', true, 'next_match_id', v_next.id, 'next_match_num', v_next.match_num);
  END IF;

  UPDATE matches SET
    team_a_id  = CASE WHEN v_bn.next_slot = 'A' THEN NULL ELSE team_a_id END,
    team_b_id  = CASE WHEN v_bn.next_slot = 'B' THEN NULL ELSE team_b_id END,
    status     = 'PENDING',          -- 한 팀이 빠졌으므로 '진행 중'일 수 없음
    started_at = NULL,
    updated_at = now()
  WHERE id = v_next.id;
  RETURN jsonb_build_object('changed', true, 'next_match_id', v_next.id, 'next_match_num', v_next.match_num);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_unadvance_winner(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_unadvance_winner(uuid, uuid) TO service_role;

-- 어떤 경로로든(대시보드 직접 수정 포함) 본선 경기의 승자가 지워지면 되돌림. 실패해도 원래 저장은 막지 않음.
CREATE OR REPLACE FUNCTION public.fn_trg_unadvance_on_clear()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_res jsonb;
BEGIN
  IF NEW.stage = 'FINALS' AND OLD.winner_team_id IS NOT NULL AND NEW.winner_team_id IS NULL THEN
    BEGIN
      v_res := fn_unadvance_winner(NEW.id, OLD.winner_team_id);
      IF COALESCE((v_res->>'changed')::boolean, false) OR COALESCE((v_res->>'blocked')::boolean, false) THEN
        PERFORM log_audit(NEW.event_id,
          CASE WHEN (v_res->>'changed')::boolean THEN 'unadvance_applied' ELSE 'unadvance_skipped' END,
          'system', 'unadvance', 'matches', NEW.id, v_res || jsonb_build_object('old_winner', OLD.winner_team_id));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fn_unadvance_winner failed: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_trg_unadvance_on_clear() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_b_unadvance_on_clear ON public.matches;
CREATE TRIGGER trg_b_unadvance_on_clear
  AFTER UPDATE OF winner_team_id ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.fn_trg_unadvance_on_clear();

CREATE OR REPLACE FUNCTION public.rpc_admin_pin_unlock_match(p_token text, p_match_id uuid, p_reason text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session admin_pin_sessions%ROWTYPE;
  v_match matches%ROWTYPE;
  v_bn bracket_nodes%ROWTYPE;
  v_next matches%ROWTYPE;
  v_stopped int := 0;
BEGIN
  SELECT * INTO v_session FROM admin_pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION '마스터 PIN 세션이 만료되었습니다.'; END IF;

  SELECT * INTO v_match FROM matches
  WHERE id = p_match_id AND event_id = v_session.event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '경기를 찾을 수 없습니다.'; END IF;

  -- 043: 이 경기 승자가 다음 라운드에서 이미 경기를 끝냈으면 초기화 불가 (다음 경기부터 되돌려야 함)
  IF v_match.stage = 'FINALS' AND v_match.winner_team_id IS NOT NULL THEN
    SELECT * INTO v_bn FROM bracket_nodes WHERE match_id = p_match_id;
    IF FOUND AND v_bn.next_match_id IS NOT NULL THEN
      SELECT * INTO v_next FROM matches WHERE id = v_bn.next_match_id;
      IF FOUND
         AND ((v_bn.next_slot = 'A' AND v_next.team_a_id = v_match.winner_team_id)
           OR (v_bn.next_slot = 'B' AND v_next.team_b_id = v_match.winner_team_id))
         AND (v_next.status = 'FINISHED' OR v_next.score IS NOT NULL OR v_next.winner_team_id IS NOT NULL) THEN
        RAISE EXCEPTION '다음 라운드 경기(%)에 이미 결과가 있어 초기화할 수 없습니다. 그 경기를 먼저 초기화해주세요.', v_next.match_num;
      END IF;
    END IF;
  END IF;

  UPDATE matches SET
    locked_by_participant = false,
    locked_reason = '관리자 해제: ' || COALESCE(p_reason, ''),
    status = 'PENDING',
    winner_team_id = NULL,
    score = NULL,
    ended_at = NULL
  WHERE id = p_match_id;
  -- (다음 라운드 자리 되돌림은 trg_b_unadvance_on_clear 가 처리)

  -- 043: 이 경기가 끝나는 순간 자동으로 켜진 같은 코트의 '진행 중' 경기를 대기로 (점수 없는 것만)
  IF v_match.status = 'FINISHED' AND v_match.court IS NOT NULL AND v_match.ended_at IS NOT NULL THEN
    UPDATE matches SET status = 'PENDING', started_at = NULL, updated_at = now()
    WHERE event_id = v_match.event_id AND court = v_match.court AND id <> p_match_id
      AND status = 'IN_PROGRESS' AND score IS NULL AND winner_team_id IS NULL
      AND court_order > v_match.court_order
      AND started_at BETWEEN v_match.ended_at - interval '5 seconds' AND v_match.ended_at + interval '5 seconds';
    GET DIAGNOSTICS v_stopped = ROW_COUNT;
  END IF;

  PERFORM log_audit(v_session.event_id, 'admin_pin_unlock', 'admin_pin',
    left(p_token, 8), 'matches', p_match_id,
    jsonb_build_object('reason', p_reason, 'old_score', v_match.score, 'old_winner', v_match.winner_team_id, 'stopped_next', v_stopped));

  RETURN jsonb_build_object('success', true, 'match_id', p_match_id, 'stopped_next', v_stopped);
END;
$function$;

-- ───────────────────────── ④ 조 순위 재배치 (부전승 자리 포함) ─────────────────────────
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
  -- 043: 부전승(BYE) 자리도 바꿀 수 있음 — 단, 그 팀이 올라간 다음 경기에 아직 결과가 없을 때만
  WITH seats0 AS (
    SELECT m.id AS match_id, 'A'::text AS side,
           (regexp_match(m.qualifier_src_a, '(\d+)위$'))[1]::int AS rnk,
           m.team_a_id AS cur_team, m.match_num, m.status, m.score, m.winner_team_id
    FROM matches m
    WHERE m.event_id = p_event_id AND m.division_id = v_div_id AND m.stage = 'FINALS'
      AND m.qualifier_label_a IS NULL AND m.qualifier_src_a LIKE v_group_name || ' %'
    UNION ALL
    SELECT m.id, 'B'::text,
           (regexp_match(m.qualifier_src_b, '(\d+)위$'))[1]::int,
           m.team_b_id, m.match_num, m.status, m.score, m.winner_team_id
    FROM matches m
    WHERE m.event_id = p_event_id AND m.division_id = v_div_id AND m.stage = 'FINALS'
      AND m.qualifier_label_b IS NULL AND m.qualifier_src_b LIKE v_group_name || ' %'
  ),
  seats AS (
    SELECT s.match_id, s.side, s.rnk, s.cur_team, s.match_num,
           (s.score = 'BYE' AND s.status = 'FINISHED' AND s.winner_team_id IS NOT DISTINCT FROM s.cur_team) AS is_bye,
           (
             (s.status IN ('PENDING', 'IN_PROGRESS') AND s.score IS NULL AND s.winner_team_id IS NULL)
             OR (
               s.score = 'BYE' AND s.status = 'FINISHED' AND s.winner_team_id IS NOT DISTINCT FROM s.cur_team
               AND NOT EXISTS (
                 SELECT 1 FROM bracket_nodes bn JOIN matches nm ON nm.id = bn.next_match_id
                 WHERE bn.match_id = s.match_id
                   AND (bn.lock
                        OR nm.status = 'FINISHED' OR nm.score IS NOT NULL OR nm.winner_team_id IS NOT NULL
                        OR (bn.next_slot = 'A' AND nm.team_a_id IS DISTINCT FROM s.cur_team)
                        OR (bn.next_slot = 'B' AND nm.team_b_id IS DISTINCT FROM s.cur_team))
               )
             )
           ) AS editable
    FROM seats0 s
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
           'from', s.cur_team, 'to', r.team_id, 'editable', s.editable, 'bye', s.is_bye))
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
      IF COALESCE((v_el->>'bye')::boolean, false) THEN
        -- 부전승 경기: 팀과 승자를 함께 바꾸고, 다음 라운드 자리도 새 팀으로
        IF v_el->>'side' = 'A' THEN
          UPDATE matches SET team_a_id = (v_el->>'to')::uuid, winner_team_id = (v_el->>'to')::uuid WHERE id = (v_el->>'match_id')::uuid;
        ELSE
          UPDATE matches SET team_b_id = (v_el->>'to')::uuid, winner_team_id = (v_el->>'to')::uuid WHERE id = (v_el->>'match_id')::uuid;
        END IF;
        PERFORM advance_winner((v_el->>'match_id')::uuid);
      ELSIF v_el->>'side' = 'A' THEN
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
$function$;

-- ───────────────────────── ⑤⑥ 코트·순서 지정 / 대기로 되돌리기 (마스터 PIN 경기장 세션) ─────────────────────────
-- p_before_match_id: 그 코트에서 이 경기 '앞'에 넣음 (NULL = 맨 뒤). 뒤 경기들은 court_order 가 1씩 밀림.
-- p_set_pending    : 옮기는 경기가 '진행 중'이면 대기로 바꿔서 옮김
CREATE OR REPLACE FUNCTION public.rpc_venue_admin_place_match(p_token text, p_match_id uuid, p_court text,
                                                              p_before_match_id uuid DEFAULT NULL, p_set_pending boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_match   matches%ROWTYPE;
  v_before  matches%ROWTYPE;
  v_order   int;
  v_row     record;
  v_pending boolean := false;
BEGIN
  IF NOT _venue_admin_ok(p_token) THEN
    RETURN jsonb_build_object('success', false, 'error', '코트 배정·변경은 마스터 PIN 으로만 할 수 있습니다.');
  END IF;
  v_session := _venue_session(p_token);
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND OR v_match.event_id <> v_session.event_id THEN
    RETURN jsonb_build_object('success', false, 'error', '이 대회의 경기가 아닙니다.');
  END IF;
  IF p_court IS NULL OR NOT (p_court = ANY(v_session.courts)) THEN
    RETURN jsonb_build_object('success', false, 'error', '자기 경기장 코트에만 배정할 수 있습니다.');
  END IF;
  IF v_match.status = 'FINISHED' THEN
    RETURN jsonb_build_object('success', false, 'error', '끝난 경기는 옮길 수 없습니다.');
  END IF;

  IF v_match.status = 'IN_PROGRESS' THEN
    IF p_set_pending THEN
      v_pending := true;
    ELSIF EXISTS (SELECT 1 FROM matches WHERE event_id = v_match.event_id AND court = p_court
                    AND id <> p_match_id AND status = 'IN_PROGRESS') THEN
      RETURN jsonb_build_object('success', false, 'code', 'target_busy',
        'error', p_court || '에 이미 진행 중인 경기가 있습니다. 이 경기를 대기 상태로 바꿔서 옮기세요.');
    END IF;
  END IF;

  IF p_before_match_id IS NOT NULL THEN
    SELECT * INTO v_before FROM matches WHERE id = p_before_match_id;
    IF NOT FOUND OR v_before.event_id <> v_match.event_id OR v_before.court IS DISTINCT FROM p_court
       OR v_before.id = p_match_id OR v_before.court_order IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', '넣을 자리를 찾지 못했습니다. 화면을 새로고침한 뒤 다시 해주세요.');
    END IF;
    IF v_before.status = 'FINISHED' THEN
      RETURN jsonb_build_object('success', false, 'error', '끝난 경기 앞에는 넣을 수 없습니다.');
    END IF;
    v_order := v_before.court_order;
    -- 뒤에서부터 한 칸씩 밀기
    FOR v_row IN SELECT id FROM matches
                 WHERE event_id = v_match.event_id AND court = p_court AND id <> p_match_id AND court_order >= v_order
                 ORDER BY court_order DESC, id LOOP
      UPDATE matches SET court_order = court_order + 1, updated_at = now() WHERE id = v_row.id;
    END LOOP;
  ELSE
    SELECT COALESCE(MAX(court_order), 0) + 1 INTO v_order FROM matches
    WHERE event_id = v_match.event_id AND court = p_court AND id <> p_match_id;
  END IF;

  UPDATE matches SET court = p_court, court_order = v_order,
         status = CASE WHEN v_pending THEN 'PENDING' ELSE status END,
         started_at = CASE WHEN v_pending THEN NULL ELSE started_at END,
         updated_at = now()
  WHERE id = p_match_id;

  PERFORM log_audit(v_match.event_id, 'venue_place_match', 'venue_manager', v_session.venue_name, 'matches', p_match_id,
    jsonb_build_object('from_court', v_match.court, 'from_order', v_match.court_order, 'court', p_court, 'order', v_order,
                       'before', p_before_match_id, 'set_pending', v_pending));
  RETURN jsonb_build_object('success', true, 'court', p_court, 'court_order', v_order, 'set_pending', v_pending);
END;
$function$;
REVOKE ALL ON FUNCTION public.rpc_venue_admin_place_match(text, uuid, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_venue_admin_place_match(text, uuid, text, uuid, boolean) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_venue_admin_set_match_pending(p_token text, p_match_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_match   matches%ROWTYPE;
BEGIN
  IF NOT _venue_admin_ok(p_token) THEN
    RETURN jsonb_build_object('success', false, 'error', '마스터 PIN 으로만 할 수 있습니다.');
  END IF;
  v_session := _venue_session(p_token);
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND OR v_match.event_id <> v_session.event_id THEN
    RETURN jsonb_build_object('success', false, 'error', '이 대회의 경기가 아닙니다.');
  END IF;
  IF v_match.status <> 'IN_PROGRESS' OR v_match.score IS NOT NULL OR v_match.winner_team_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '진행 중(점수 없음)인 경기만 대기로 되돌릴 수 있습니다.');
  END IF;
  UPDATE matches SET status = 'PENDING', started_at = NULL, updated_at = now() WHERE id = p_match_id;
  PERFORM log_audit(v_match.event_id, 'venue_set_pending', 'venue_manager', v_session.venue_name, 'matches', p_match_id,
    jsonb_build_object('court', v_match.court, 'court_order', v_match.court_order));
  RETURN jsonb_build_object('success', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.rpc_venue_admin_set_match_pending(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_venue_admin_set_match_pending(text, uuid) TO anon, authenticated, service_role;

SELECT '043 applied' AS result;
