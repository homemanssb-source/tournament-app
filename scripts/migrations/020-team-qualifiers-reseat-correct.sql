-- ============================================================
-- 020: 단체전 본선 진출 로직 정리 + 운영자 점수 정정 (2026-09-29 점검)
--
-- 문제:
--   (1) 수동 동률 결정(rpc_set_manual_rank)이 rank_locked 로 순위를 영구 고정 →
--       이후 성적 변화 미반영, 잠기지 않은 팀과 순위 번호 중복 가능. 본선 채움도 안 돌았다.
--   (2) rpc_generate_team_tournament_v2 가 조 순위를 (승, 러버득실, random()) 으로 다시 매겨
--       본부가 정한 동률 순위를 무시했다.
--   (3) 본선 슬롯을 채우면 qualifier_label 이 지워져 조 점수 정정 후 재배정 불가.
--   (4) 완료된 러버 점수를 정정할 방법이 없었다 (rpc_record_rubber_score 가 항상 거부).
--
-- 수정:
--   team_standings.manual_tiebreak — "승·득실이 같을 때만 쓰는 순서". 동률이 풀리면 자동 무시·삭제.
--     rank_locked 는 이제 "동률을 본부 결정으로 해소함" 표시로만 쓴다(계산에서 제외하지 않음).
--   ties.qualifier_src_a/b — 본선 슬롯의 출처 '<group_id>:<순위>' 를 영구 보존.
--   rpc_calculate_standings  — 부서·조별로 순위, manual_tiebreak 반영, 본선 대전은 집계 제외.
--   rpc_set_manual_rank      — manual_tiebreak 저장 → 순위 재계산 → 본선 재배정.
--   rpc_fill_team_tournament_slots — 출처 기준 채움 + 재배정. 바꿔야 할 본선 대전이 하나라도
--     시작됐으면 전부 보류(audit: team_reseat_skipped). 동률 미결정 자리는 이름표로 비워둔다.
--   rpc_generate_team_tournament_v2 — 조 순위표 그대로 사용(random 제거), 미결정 자리는 이름표,
--     출처 기록, 조별 진출은 최대 2팀(3위 진출 미지원).
--   rpc_calculate_tie_result — 조별 대전 승자를 항상 현재 러버 결과로 갱신(정정 대응).
--   rpc_admin_correct_rubber_score (신규) — 완료된 러버 점수 정정.
--     토너먼트는 다음 라운드가 시작되기 전까지만. audit: team_score_corrected.
--
-- 기존 데이터: 새 컬럼 추가 + 과거 rank_locked 순위를 manual_tiebreak 로 옮겨 적기만 함.
-- 라이브 정의 기준(2026-09-29 조회)으로 작성.
-- ============================================================

ALTER TABLE public.team_standings ADD COLUMN IF NOT EXISTS manual_tiebreak int;
ALTER TABLE public.ties ADD COLUMN IF NOT EXISTS qualifier_src_a text;
ALTER TABLE public.ties ADD COLUMN IF NOT EXISTS qualifier_src_b text;

UPDATE public.team_standings
   SET manual_tiebreak = rank
 WHERE rank_locked = true AND rank IS NOT NULL AND manual_tiebreak IS NULL;


-- ── 대전이 시작됐는지 (라인업 제출 / 진행 상태 / 완료 러버) ──
CREATE OR REPLACE FUNCTION public.fn_team_tie_started(p_tie_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce((
    SELECT t.status IN ('lineup_phase', 'lineup_ready', 'in_progress', 'completed')
        OR coalesce(t.club_a_lineup_submitted, false)
        OR coalesce(t.club_b_lineup_submitted, false)
        OR EXISTS (SELECT 1 FROM tie_rubbers r WHERE r.tie_id = t.id AND r.status = 'completed')
    FROM ties t WHERE t.id = p_tie_id), false);
$function$;


-- ── 토너먼트 다음 라운드 대전 id ──
CREATE OR REPLACE FUNCTION public.fn_team_next_tie(p_tie_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT n.id
  FROM ties t
  JOIN ties n ON n.event_id = t.event_id
             AND n.division_id IS NOT DISTINCT FROM t.division_id
             AND n.round = CASE t.round WHEN 'round_of_16' THEN 'quarter'
                                        WHEN 'quarter' THEN 'semi'
                                        WHEN 'semi' THEN 'final' END
             AND n.bracket_position = ceil(t.bracket_position::numeric / 2)
  WHERE t.id = p_tie_id
  LIMIT 1;
$function$;


-- ── 다음 라운드 슬롯에 클럽 넣기/비우기 (시작 여부는 호출 측에서 확인) ──
CREATE OR REPLACE FUNCTION public.fn_team_set_next_slot(p_tie_id uuid, p_club_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tie RECORD;
  v_next RECORD;
  v_next_id uuid;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  v_next_id := fn_team_next_tie(p_tie_id);
  IF v_next_id IS NULL THEN RETURN; END IF;

  IF v_tie.bracket_position % 2 = 1 THEN
    UPDATE ties SET club_a_id = p_club_id, qualifier_label_a = NULL
     WHERE id = v_next_id AND club_a_id IS DISTINCT FROM p_club_id;
  ELSE
    UPDATE ties SET club_b_id = p_club_id, qualifier_label_b = NULL
     WHERE id = v_next_id AND club_b_id IS DISTINCT FROM p_club_id;
  END IF;

  SELECT * INTO v_next FROM ties WHERE id = v_next_id;
  IF v_next.club_a_id IS NOT NULL AND v_next.club_b_id IS NOT NULL AND v_next.is_bye = false
     AND NOT EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = v_next.id) THEN
    FOR i IN 1..v_next.rubber_count LOOP
      INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
      VALUES (v_next.id, i, 'pending', LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0'));
    END LOOP;
  END IF;
END;
$function$;


-- ── 1라운드 대전 정리: 부전승 판정/해제, 러버 생성 ──
CREATE OR REPLACE FUNCTION public.fn_team_resolve_tie(p_tie_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t RECORD;
  v_a_empty boolean;
  v_b_empty boolean;
  v_winner uuid;
BEGIN
  SELECT * INTO t FROM ties WHERE id = p_tie_id;
  IF t IS NULL THEN RETURN; END IF;
  -- 출처도 이름표도 클럽도 없는 쪽 = 진짜 빈자리(부전승 상대)
  v_a_empty := t.club_a_id IS NULL AND t.qualifier_src_a IS NULL AND t.qualifier_label_a IS NULL;
  v_b_empty := t.club_b_id IS NULL AND t.qualifier_src_b IS NULL AND t.qualifier_label_b IS NULL;

  IF v_a_empty AND v_b_empty THEN
    RETURN;
  ELSIF v_a_empty OR v_b_empty THEN
    v_winner := coalesce(t.club_a_id, t.club_b_id);
    IF v_winner IS NOT NULL THEN
      UPDATE ties SET is_bye = true, status = 'bye', winning_club_id = v_winner WHERE id = t.id;
    ELSE
      -- 상대가 아직 미정: 부전승 보류
      UPDATE ties SET is_bye = false, status = 'pending', winning_club_id = NULL WHERE id = t.id;
    END IF;
    PERFORM fn_team_set_next_slot(t.id, v_winner);
  ELSE
    IF t.is_bye THEN
      UPDATE ties SET is_bye = false, status = 'pending', winning_club_id = NULL WHERE id = t.id;
    END IF;
    IF t.club_a_id IS NOT NULL AND t.club_b_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = t.id) THEN
      FOR i IN 1..t.rubber_count LOOP
        INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
        VALUES (t.id, i, 'pending', LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0'));
      END LOOP;
    END IF;
  END IF;
END;
$function$;


-- ── 순위 계산 ──
CREATE OR REPLACE FUNCTION public.rpc_calculate_standings(p_event_id uuid, p_group_id uuid DEFAULT NULL::uuid, p_division_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- 1) 성적 집계 (조별/풀리그 대전만, 완료된 것만)
  UPDATE team_standings ts SET
    played = s.played, won = s.won, lost = s.lost,
    rubbers_for = s.rf, rubbers_against = s.ra, rubber_diff = s.rf - s.ra
  FROM (
    SELECT ts2.id,
      COUNT(t.id) FILTER (WHERE t.is_bye = false) AS played,
      COUNT(t.id) FILTER (WHERE t.winning_club_id = ts2.club_id) AS won,
      COUNT(t.id) FILTER (WHERE t.winning_club_id IS NOT NULL AND t.winning_club_id <> ts2.club_id) AS lost,
      coalesce(SUM(CASE WHEN t.club_a_id = ts2.club_id THEN t.club_a_rubbers_won
                        WHEN t.club_b_id = ts2.club_id THEN t.club_b_rubbers_won END), 0) AS rf,
      coalesce(SUM(CASE WHEN t.club_a_id = ts2.club_id THEN t.club_b_rubbers_won
                        WHEN t.club_b_id = ts2.club_id THEN t.club_a_rubbers_won END), 0) AS ra
    FROM team_standings ts2
    JOIN clubs c ON c.id = ts2.club_id
    LEFT JOIN ties t
      ON t.event_id = p_event_id
     AND t.status = 'completed'
     AND (t.round IN ('group', 'full_league') OR t.round IS NULL)
     AND (t.club_a_id = ts2.club_id OR t.club_b_id = ts2.club_id)
     AND t.group_id IS NOT DISTINCT FROM ts2.group_id
    WHERE ts2.event_id = p_event_id
      AND ((p_group_id IS NULL AND ts2.group_id IS NULL) OR ts2.group_id = p_group_id)
      AND (p_division_id IS NULL OR c.division_id = p_division_id)
    GROUP BY ts2.id
  ) s
  WHERE ts.id = s.id;

  -- 2) 순위 + 동률 판정 (조·부서 단위)
  --    동률 = 같은 조·부서에서 승수·러버득실이 같은 팀이 있음 (경기 치른 팀만)
  --    해소 = 그 동률 묶음 전원이 서로 다른 manual_tiebreak 를 가짐
  WITH sc AS (
    SELECT ts.id, ts.group_id, c.division_id, ts.club_id, ts.won, ts.rubber_diff, ts.played, ts.manual_tiebreak
    FROM team_standings ts JOIN clubs c ON c.id = ts.club_id
    WHERE ts.event_id = p_event_id
      AND ((p_group_id IS NULL AND ts.group_id IS NULL) OR ts.group_id = p_group_id)
      AND (p_division_id IS NULL OR c.division_id = p_division_id)
  ),
  blk AS (
    SELECT group_id, division_id, won, rubber_diff,
           COUNT(*) AS n, COUNT(manual_tiebreak) AS n_mt, COUNT(DISTINCT manual_tiebreak) AS n_dmt
    FROM sc GROUP BY group_id, division_id, won, rubber_diff
  ),
  rk AS (
    SELECT sc.id,
      ROW_NUMBER() OVER (PARTITION BY sc.group_id, sc.division_id
                         ORDER BY sc.won DESC, sc.rubber_diff DESC, sc.manual_tiebreak ASC NULLS LAST, sc.club_id) AS rn,
      (sc.played > 0 AND b.n > 1) AS tied,
      (b.n_mt = b.n AND b.n_dmt = b.n) AS resolved
    FROM sc
    JOIN blk b ON b.group_id IS NOT DISTINCT FROM sc.group_id
              AND b.division_id IS NOT DISTINCT FROM sc.division_id
              AND b.won = sc.won AND b.rubber_diff = sc.rubber_diff
  )
  UPDATE team_standings ts SET
    rank = CASE WHEN rk.tied AND NOT rk.resolved THEN NULL ELSE rk.rn END,
    rank_locked = (rk.tied AND rk.resolved),
    manual_tiebreak = CASE WHEN rk.tied THEN ts.manual_tiebreak ELSE NULL END
  FROM rk
  WHERE ts.id = rk.id;

  RETURN json_build_object('success', true);
END;
$function$;


-- ── 수동 동률 결정 ──
CREATE OR REPLACE FUNCTION public.rpc_set_manual_rank(p_event_id uuid, p_club_id uuid, p_rank integer, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_rec RECORD;
  v_fill jsonb;
BEGIN
  UPDATE team_standings SET
    manual_tiebreak = p_rank,
    notes = coalesce(p_notes, '본부 판단')
  WHERE event_id = p_event_id AND club_id = p_club_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '해당 클럽의 순위 데이터를 찾을 수 없습니다.');
  END IF;

  FOR v_rec IN
    SELECT DISTINCT ts.group_id, c.division_id
    FROM team_standings ts JOIN clubs c ON c.id = ts.club_id
    WHERE ts.event_id = p_event_id AND ts.club_id = p_club_id
  LOOP
    PERFORM rpc_calculate_standings(p_event_id, v_rec.group_id, v_rec.division_id);
    IF v_rec.group_id IS NOT NULL THEN
      v_fill := rpc_fill_team_tournament_slots(p_event_id, v_rec.group_id);
    END IF;
  END LOOP;

  RETURN json_build_object('success', true, 'reseat', v_fill);
END;
$function$;


-- ── 본선 슬롯 채움 + 재배정 ──
CREATE OR REPLACE FUNCTION public.rpc_fill_team_tournament_slots(p_event_id uuid, p_group_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group    RECORD;
  v_slot     RECORD;
  v_prefix   text;
  v_blocked  jsonb := '[]'::jsonb;
  v_changed  jsonb := '[]'::jsonb;
  v_filled   int := 0;
  v_tie_ids  uuid[] := '{}';
  v_tid      uuid;
  v_next     uuid;
BEGIN
  SELECT * INTO v_group FROM groups WHERE id = p_group_id;
  IF v_group IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '그룹을 찾을 수 없습니다.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM ties
    WHERE event_id = p_event_id AND group_id = p_group_id
      AND round = 'group' AND is_bye = false AND status != 'completed'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', '조 경기가 아직 완료되지 않았습니다.');
  END IF;

  v_prefix := p_group_id::text || ':';

  -- 020 이전에 만든 대진: 이름표("A조 1위")에서 출처를 복원
  UPDATE ties SET qualifier_src_a = v_prefix || substring(qualifier_label_a FROM ' ([0-9]+)위$')
   WHERE event_id = p_event_id AND division_id IS NOT DISTINCT FROM v_group.division_id
     AND qualifier_src_a IS NULL AND qualifier_label_a ~ ('^' || v_group.group_label || ' [0-9]+위$');
  UPDATE ties SET qualifier_src_b = v_prefix || substring(qualifier_label_b FROM ' ([0-9]+)위$')
   WHERE event_id = p_event_id AND division_id IS NOT DISTINCT FROM v_group.division_id
     AND qualifier_src_b IS NULL AND qualifier_label_b ~ ('^' || v_group.group_label || ' [0-9]+위$');

  -- 1차: 바뀔 자리 확인 (하나라도 시작된 대전이면 전부 보류)
  FOR v_slot IN
    SELECT s.*, (SELECT ts.club_id FROM team_standings ts
                  WHERE ts.group_id = p_group_id AND ts.rank = s.rnk LIMIT 1) AS desired
    FROM (
      SELECT t.id AS tie_id, t.round, t.bracket_position, t.is_bye, v.side, v.cur,
             split_part(v.src, ':', 2)::int AS rnk
      FROM ties t
      CROSS JOIN LATERAL (VALUES ('a', t.club_a_id, t.qualifier_src_a),
                                 ('b', t.club_b_id, t.qualifier_src_b)) v(side, cur, src)
      WHERE t.event_id = p_event_id AND v.src LIKE v_prefix || '%'
    ) s
  LOOP
    CONTINUE WHEN v_slot.cur IS NOT DISTINCT FROM v_slot.desired;
    v_next := fn_team_next_tie(v_slot.tie_id);
    IF fn_team_tie_started(v_slot.tie_id)
       OR (v_slot.is_bye AND v_next IS NOT NULL AND fn_team_tie_started(v_next)) THEN
      v_blocked := v_blocked || jsonb_build_object('tie_id', v_slot.tie_id, 'round', v_slot.round,
                     'position', v_slot.bracket_position, 'slot', v_group.group_label || ' ' || v_slot.rnk || '위');
    END IF;
    v_changed := v_changed || jsonb_build_object('tie_id', v_slot.tie_id, 'side', v_slot.side,
                   'rank', v_slot.rnk, 'from_club', v_slot.cur, 'to_club', v_slot.desired);
  END LOOP;

  IF jsonb_array_length(v_blocked) > 0 THEN
    PERFORM log_audit(p_event_id, 'team_reseat_skipped', 'system', 'reseat', 'groups', p_group_id,
      jsonb_build_object('group', v_group.group_label, 'blocked', v_blocked, 'wanted', v_changed));
    RETURN jsonb_build_object('success', false, 'reseat_skipped', true,
      'error', v_group.group_label || ' 순위가 바뀌었지만 본선 대전이 이미 시작되어 자리를 바꾸지 않았습니다. 운영자 확인이 필요합니다.',
      'blocked', v_blocked);
  END IF;

  -- 2차: 적용
  FOR v_slot IN SELECT * FROM jsonb_to_recordset(v_changed) AS x(tie_id uuid, side text, rank int, from_club uuid, to_club uuid)
  LOOP
    IF v_slot.side = 'a' THEN
      UPDATE ties SET club_a_id = v_slot.to_club,
             qualifier_label_a = CASE WHEN v_slot.to_club IS NULL THEN v_group.group_label || ' ' || v_slot.rank || '위' END
       WHERE id = v_slot.tie_id;
    ELSE
      UPDATE ties SET club_b_id = v_slot.to_club,
             qualifier_label_b = CASE WHEN v_slot.to_club IS NULL THEN v_group.group_label || ' ' || v_slot.rank || '위' END
       WHERE id = v_slot.tie_id;
    END IF;
    IF v_slot.to_club IS NOT NULL THEN v_filled := v_filled + 1; END IF;
    IF NOT v_slot.tie_id = ANY(v_tie_ids) THEN v_tie_ids := v_tie_ids || v_slot.tie_id; END IF;
  END LOOP;

  FOREACH v_tid IN ARRAY v_tie_ids LOOP
    PERFORM fn_team_resolve_tie(v_tid);
  END LOOP;

  IF jsonb_array_length(v_changed) > 0 THEN
    PERFORM log_audit(p_event_id, 'team_reseat_applied', 'system', 'reseat', 'groups', p_group_id,
      jsonb_build_object('group', v_group.group_label, 'changes', v_changed));
  END IF;

  RETURN jsonb_build_object('success', true, 'filled', v_filled, 'changed', jsonb_array_length(v_changed));

-- 재배정 실패가 점수 저장을 막지 않도록 흡수 (기존 동작 유지)
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;


-- ── 대전 결과 계산 (조별 대전 승자를 항상 현재 러버 기준으로) ──
CREATE OR REPLACE FUNCTION public.rpc_calculate_tie_result(p_tie_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tie RECORD;
  v_a_wins INT;
  v_b_wins INT;
  v_completed INT;
  v_majority INT;
  v_is_group BOOLEAN;
  v_winner_id uuid;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  SELECT
    coalesce(COUNT(*) FILTER (WHERE winning_club_id = v_tie.club_a_id), 0),
    coalesce(COUNT(*) FILTER (WHERE winning_club_id = v_tie.club_b_id), 0),
    coalesce(COUNT(*) FILTER (WHERE status = 'completed'), 0)
  INTO v_a_wins, v_b_wins, v_completed
  FROM tie_rubbers WHERE tie_id = p_tie_id;

  v_majority := (v_tie.rubber_count / 2) + 1;
  v_is_group := v_tie.round IN ('group', 'full_league') OR v_tie.round IS NULL;

  UPDATE ties SET
    club_a_rubbers_won = v_a_wins,
    club_b_rubbers_won = v_b_wins
  WHERE id = p_tie_id;

  v_winner_id := NULL;
  IF v_a_wins >= v_majority THEN
    v_winner_id := v_tie.club_a_id;
  ELSIF v_b_wins >= v_majority THEN
    v_winner_id := v_tie.club_b_id;
  END IF;

  -- 토너먼트 라운드: 과반 즉시 종료
  IF NOT v_is_group AND v_winner_id IS NOT NULL THEN
    UPDATE ties SET
      winning_club_id = v_winner_id,
      status = 'completed'
    WHERE id = p_tie_id;

    IF v_tie.round IN ('round_of_16', 'quarter', 'semi', 'final') THEN
      PERFORM rpc_advance_tournament_winner(p_tie_id);
    END IF;

    RETURN json_build_object('success', true, 'winner_club_id', v_winner_id, 'completed', true);
  END IF;

  -- 예선 라운드: 모든 러버 완료 시 종료
  IF v_is_group THEN
    IF v_completed >= v_tie.rubber_count THEN
      IF v_winner_id IS NULL THEN
        IF v_a_wins > v_b_wins THEN
          v_winner_id := v_tie.club_a_id;
        ELSIF v_b_wins > v_a_wins THEN
          v_winner_id := v_tie.club_b_id;
        END IF;
      END IF;

      UPDATE ties SET
        winning_club_id = v_winner_id,
        status = 'completed'
      WHERE id = p_tie_id;

      PERFORM rpc_calculate_standings(v_tie.event_id, v_tie.group_id, v_tie.division_id);

      IF v_tie.round = 'group' AND v_tie.group_id IS NOT NULL THEN
        PERFORM rpc_fill_team_tournament_slots(v_tie.event_id, v_tie.group_id);
      END IF;

      RETURN json_build_object('success', true, 'winner_club_id', v_winner_id, 'completed', true);
    END IF;

    -- ✅ 020: 진행 중에도 승자는 현재 러버 결과 그대로 (정정으로 과반이 풀릴 수 있음)
    UPDATE ties SET winning_club_id = v_winner_id
     WHERE id = p_tie_id AND winning_club_id IS DISTINCT FROM v_winner_id;

    IF v_completed > 0 AND v_tie.status NOT IN ('completed', 'lineup_ready') THEN
      UPDATE ties SET status = 'in_progress' WHERE id = p_tie_id;
    END IF;

    RETURN json_build_object(
      'success', true,
      'completed', false,
      'a_wins', v_a_wins,
      'b_wins', v_b_wins,
      'winner_decided', v_winner_id IS NOT NULL
    );
  END IF;

  IF v_completed > 0 AND v_tie.status NOT IN ('completed', 'lineup_ready') THEN
    UPDATE ties SET status = 'in_progress' WHERE id = p_tie_id;
  END IF;

  RETURN json_build_object('success', true, 'completed', false, 'a_wins', v_a_wins, 'b_wins', v_b_wins);
END;
$function$;


-- ── 운영자 러버 점수 정정 (신규) ──
CREATE OR REPLACE FUNCTION public.rpc_admin_correct_rubber_score(p_rubber_id uuid, p_set1_a integer, p_set1_b integer, p_set2_a integer DEFAULT NULL::integer, p_set2_b integer DEFAULT NULL::integer, p_set3_a integer DEFAULT NULL::integer, p_set3_b integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rubber RECORD;
  v_tie RECORD;
  v_next uuid;
  v_sets_a INT := 0;
  v_sets_b INT := 0;
  v_winner_id uuid;
  v_a_wins INT;
  v_b_wins INT;
  v_majority INT;
  v_is_group BOOLEAN;
  v_reseat jsonb;
BEGIN
  SELECT * INTO v_rubber FROM tie_rubbers WHERE id = p_rubber_id;
  IF v_rubber IS NULL THEN
    RETURN json_build_object('success', false, 'error', '경기를 찾을 수 없습니다.');
  END IF;

  -- 아직 입력 전이면 일반 입력으로
  IF v_rubber.status <> 'completed' THEN
    RETURN rpc_record_rubber_score(p_rubber_id, p_set1_a, p_set1_b, p_set2_a, p_set2_b, p_set3_a, p_set3_b);
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = v_rubber.tie_id;
  v_is_group := v_tie.round IN ('group', 'full_league') OR v_tie.round IS NULL;

  IF NOT v_is_group THEN
    v_next := fn_team_next_tie(v_tie.id);
    IF v_next IS NOT NULL AND fn_team_tie_started(v_next) THEN
      RETURN json_build_object('success', false, 'error',
        '다음 라운드 대전이 이미 시작되어 이 대전의 점수는 정정할 수 없습니다.');
    END IF;
  END IF;

  IF p_set1_a IS NOT NULL AND p_set1_b IS NOT NULL THEN
    IF p_set1_a > p_set1_b THEN v_sets_a := v_sets_a + 1;
    ELSIF p_set1_b > p_set1_a THEN v_sets_b := v_sets_b + 1; END IF;
  END IF;
  IF p_set2_a IS NOT NULL AND p_set2_b IS NOT NULL THEN
    IF p_set2_a > p_set2_b THEN v_sets_a := v_sets_a + 1;
    ELSIF p_set2_b > p_set2_a THEN v_sets_b := v_sets_b + 1; END IF;
  END IF;
  IF p_set3_a IS NOT NULL AND p_set3_b IS NOT NULL THEN
    IF p_set3_a > p_set3_b THEN v_sets_a := v_sets_a + 1;
    ELSIF p_set3_b > p_set3_a THEN v_sets_b := v_sets_b + 1; END IF;
  END IF;

  IF v_sets_a > v_sets_b THEN
    v_winner_id := v_tie.club_a_id;
  ELSIF v_sets_b > v_sets_a THEN
    v_winner_id := v_tie.club_b_id;
  ELSE
    RETURN json_build_object('success', false, 'error', '승패를 결정할 수 없습니다. 스코어를 확인하세요.');
  END IF;

  UPDATE tie_rubbers SET
    set1_a = p_set1_a, set1_b = p_set1_b,
    set2_a = p_set2_a, set2_b = p_set2_b,
    set3_a = p_set3_a, set3_b = p_set3_b,
    sets_won_a = v_sets_a, sets_won_b = v_sets_b,
    winning_club_id = v_winner_id
  WHERE id = p_rubber_id;

  -- 토너먼트: 정정으로 과반이 풀리면 대전을 다시 진행 중으로, 다음 라운드 자리 비움
  IF NOT v_is_group AND v_tie.status = 'completed' THEN
    SELECT COUNT(*) FILTER (WHERE winning_club_id = v_tie.club_a_id),
           COUNT(*) FILTER (WHERE winning_club_id = v_tie.club_b_id)
      INTO v_a_wins, v_b_wins
      FROM tie_rubbers WHERE tie_id = v_tie.id;
    v_majority := (v_tie.rubber_count / 2) + 1;
    IF v_a_wins < v_majority AND v_b_wins < v_majority THEN
      UPDATE ties SET status = 'in_progress', winning_club_id = NULL,
             club_a_rubbers_won = v_a_wins, club_b_rubbers_won = v_b_wins
       WHERE id = v_tie.id;
      PERFORM fn_team_set_next_slot(v_tie.id, NULL);
    END IF;
  END IF;

  PERFORM rpc_calculate_tie_result(v_tie.id);

  -- 조별: 재배정 결과를 함께 돌려줌 (보류되면 운영자에게 경고)
  IF v_tie.round = 'group' AND v_tie.group_id IS NOT NULL THEN
    v_reseat := rpc_fill_team_tournament_slots(v_tie.event_id, v_tie.group_id);
  END IF;

  PERFORM log_audit(v_tie.event_id, 'team_score_corrected', 'admin', NULL, 'tie_rubbers', p_rubber_id,
    jsonb_build_object('tie_id', v_tie.id, 'rubber_number', v_rubber.rubber_number,
      'before', jsonb_build_object('set1', v_rubber.set1_a || ':' || v_rubber.set1_b,
                                   'set2', v_rubber.set2_a || ':' || v_rubber.set2_b,
                                   'set3', v_rubber.set3_a || ':' || v_rubber.set3_b,
                                   'winner', v_rubber.winning_club_id),
      'after', jsonb_build_object('set1', p_set1_a || ':' || p_set1_b,
                                  'set2', p_set2_a || ':' || p_set2_b,
                                  'set3', p_set3_a || ':' || p_set3_b,
                                  'winner', v_winner_id)));

  RETURN json_build_object('success', true, 'corrected', true, 'winner_club_id', v_winner_id,
    'sets', v_sets_a || '-' || v_sets_b, 'reseat', v_reseat);
END;
$function$;


-- ── 본선 대진 생성 (조 순위표 그대로, 미결정 자리는 이름표, 출처 기록) ──
CREATE OR REPLACE FUNCTION public.rpc_generate_team_tournament_v2(p_event_id uuid, p_division_id uuid DEFAULT NULL::uuid, p_advance_per_group integer DEFAULT 2, p_allow_tbd boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_advance_count int;
  v_total_adv int;
  v_bracket_size int;
  v_byes int;
  v_round_name text;
  v_new_tie_id uuid;
  v_ties_created int := 0;
  v_bye_applied int := 0;
  v_tbd_count int := 0;
  v_r_idx int;
  v_m_idx int;
  v_curr RECORD;
  v_bye_winner uuid;
  v_fm uuid[];
  v_num_first_round int;
  v_i int;
  v_rubber_count int;
  v_round_names text[] := ARRAY[]::text[];
  v_total_rounds int;
  v_g RECORD;

  v_bp int[];
  v_seed_team uuid;
  v_seed_num int;
  v_rank1_count int;
  v_rank2_count int;
  v_a1_seed int;
  v_a1_pos int;
  v_a1_half int;
  v_target_seed int;
  v_adv2 RECORD;
  v_upper_avail int[];
  v_lower_avail int[];
  v_pos int;
  v_label_a text;
  v_rank_a int;
  v_src_a text;
  v_gid_a uuid;
  v_undecided text[];
BEGIN
  -- 1. 기존 토너먼트 삭제
  DELETE FROM tie_rubbers WHERE tie_id IN (
    SELECT id FROM ties WHERE event_id = p_event_id
      AND (p_division_id IS NULL AND division_id IS NULL OR division_id = p_division_id)
      AND round IN ('round_of_16','quarter','semi','final')
  );
  DELETE FROM ties WHERE event_id = p_event_id
    AND (p_division_id IS NULL AND division_id IS NULL OR division_id = p_division_id)
    AND round IN ('round_of_16','quarter','semi','final');

  -- 2. rubber_count
  SELECT COALESCE(team_rubber_count, 3) INTO v_rubber_count
  FROM events WHERE id = p_event_id;

  -- ✅ 020: 조 순위 최신화 (동률 결정 반영)
  FOR v_g IN SELECT id, division_id FROM groups
             WHERE event_id = p_event_id AND (p_division_id IS NULL OR division_id = p_division_id)
  LOOP
    PERFORM rpc_calculate_standings(p_event_id, v_g.id, v_g.division_id);
  END LOOP;

  -- 3. 진출 자리 수집 — ✅ 020: 조 순위표(rank) 그대로. 조 미완료/동률 미결정 자리는 club_id NULL
  --    조별 진출은 최대 2팀 (3위 진출 미지원)
  v_advance_count := LEAST(2, GREATEST(1, COALESCE(p_advance_per_group, 2)));

  CREATE TEMP TABLE _adv (
    club_id uuid,
    group_id uuid,
    group_num int,
    group_name text,
    wins int,
    rank int,
    group_finished boolean
  ) ON COMMIT DROP;

  INSERT INTO _adv (club_id, group_id, group_num, group_name, wins, rank, group_finished)
  SELECT d.club_id, g.id, g.group_num, g.group_label, 0, r.rk,
         (fin.finished AND d.club_id IS NOT NULL)
  FROM groups g
  CROSS JOIN LATERAL (
    SELECT COUNT(*) > 0 AND COUNT(*) FILTER (WHERE t2.status = 'completed') = COUNT(*) AS finished
    FROM ties t2
    WHERE t2.event_id = p_event_id AND t2.group_id = g.id AND t2.round = 'group' AND t2.is_bye = false
  ) fin
  CROSS JOIN LATERAL generate_series(1,
    LEAST(v_advance_count, (SELECT COUNT(*) FROM team_standings ts WHERE ts.group_id = g.id))::int) r(rk)
  LEFT JOIN LATERAL (
    SELECT ts.club_id FROM team_standings ts
    WHERE ts.group_id = g.id AND ts.rank = r.rk AND fin.finished
    LIMIT 1
  ) d ON true
  WHERE g.event_id = p_event_id
    AND (p_division_id IS NULL OR g.division_id = p_division_id);

  SELECT COUNT(*) INTO v_total_adv FROM _adv;

  IF v_total_adv < 2 THEN
    RETURN jsonb_build_object('success', false,
      'error', '진출팀이 2팀 미만입니다. 조편성 및 순위를 확인하세요.');
  END IF;

  -- 조는 끝났지만 동률 미결정인 조 (안내용)
  SELECT array_agg(DISTINCT a.group_name) INTO v_undecided
  FROM _adv a
  WHERE a.club_id IS NULL
    AND EXISTS (SELECT 1 FROM ties t2 WHERE t2.group_id = a.group_id AND t2.round = 'group')
    AND NOT EXISTS (SELECT 1 FROM ties t2 WHERE t2.group_id = a.group_id AND t2.round = 'group'
                      AND t2.is_bye = false AND t2.status <> 'completed');

  -- 4. 브래킷 사이즈
  v_bracket_size := 1;
  WHILE v_bracket_size < v_total_adv LOOP
    v_bracket_size := v_bracket_size * 2;
  END LOOP;
  v_byes := v_bracket_size - v_total_adv;
  v_num_first_round := v_bracket_size / 2;

  -- 5. 라운드 배열
  IF v_bracket_size >= 16 THEN v_round_names := array_append(v_round_names, 'round_of_16'); END IF;
  IF v_bracket_size >= 8  THEN v_round_names := array_append(v_round_names, 'quarter');     END IF;
  IF v_bracket_size >= 4  THEN v_round_names := array_append(v_round_names, 'semi');        END IF;
  v_round_names := array_append(v_round_names, 'final');
  v_total_rounds := array_length(v_round_names, 1);

  -- 6. 전체 라운드 ties 미리 생성
  CREATE TEMP TABLE _round_ties (
    round_idx int, tie_idx int, tie_id uuid, round_name text
  ) ON COMMIT DROP;

  FOR v_r_idx IN 1..v_total_rounds LOOP
    v_round_name := v_round_names[v_r_idx];
    v_m_idx := v_bracket_size / (2 ^ v_r_idx)::int;
    FOR v_i IN 1..v_m_idx LOOP
      INSERT INTO ties (
        event_id, division_id, round, bracket_position,
        is_bye, status, rubber_count
      ) VALUES (
        p_event_id, p_division_id, v_round_name, v_i,
        false, 'pending', v_rubber_count
      ) RETURNING id INTO v_new_tie_id;

      INSERT INTO _round_ties VALUES (v_r_idx - 1, v_i, v_new_tie_id, v_round_name);
      v_ties_created := v_ties_created + 1;
    END LOOP;
  END LOOP;

  SELECT array_agg(tie_id ORDER BY tie_idx) INTO v_fm
  FROM _round_ties WHERE round_idx = 0;

  -- 7. 표준 시드 브래킷 배열
  v_bp := ARRAY[1, 2];
  WHILE array_length(v_bp, 1) < v_bracket_size LOOP
    DECLARE
      v_new int[];
      v_n int;
      v_sum int;
    BEGIN
      v_n := array_length(v_bp, 1);
      v_sum := v_n * 2 + 1;
      v_new := ARRAY[]::int[];
      FOR v_i IN 1..v_n LOOP
        v_new := array_append(v_new, v_bp[v_i]);
        v_new := array_append(v_new, v_sum - v_bp[v_i]);
      END LOOP;
      v_bp := v_new;
    END;
  END LOOP;

  SELECT COUNT(*) INTO v_rank1_count FROM _adv WHERE rank = 1;
  SELECT COUNT(*) INTO v_rank2_count FROM _adv WHERE rank = 2;

  CREATE TEMP TABLE _seed_map (
    seed_num int,
    club_id uuid,
    group_id uuid,
    group_name text,
    rank int
  ) ON COMMIT DROP;

  -- 8. 1위 자리 시드 (완료 조 먼저, 랜덤 셔플)
  INSERT INTO _seed_map (seed_num, club_id, group_id, group_name, rank)
  SELECT
    ROW_NUMBER() OVER (ORDER BY
      CASE WHEN group_finished THEN 0 ELSE 1 END,
      random()
    ) AS seed_num,
    CASE WHEN group_finished THEN club_id ELSE NULL END,
    group_id, group_name, rank
  FROM _adv WHERE rank = 1;

  -- 9. 2위 자리: 같은 조 1위와 반대 절반
  v_upper_avail := ARRAY[]::int[];
  v_lower_avail := ARRAY[]::int[];

  FOR v_i IN (v_rank1_count + 1)..(v_rank1_count + v_rank2_count) LOOP
    SELECT t.idx INTO v_pos
    FROM (
      SELECT unnest(v_bp) AS val,
             generate_series(1, array_length(v_bp, 1)) AS idx
    ) t WHERE t.val = v_i;

    IF ceil(v_pos::float / 2) <= v_num_first_round / 2 THEN
      v_upper_avail := array_append(v_upper_avail, v_i);
    ELSE
      v_lower_avail := array_append(v_lower_avail, v_i);
    END IF;
  END LOOP;

  FOR v_adv2 IN SELECT * FROM _adv WHERE rank = 2 ORDER BY random() LOOP
    SELECT sm.seed_num INTO v_a1_seed
    FROM _seed_map sm
    WHERE sm.group_id = v_adv2.group_id AND sm.rank = 1;

    SELECT t.idx INTO v_a1_pos
    FROM (
      SELECT unnest(v_bp) AS val,
             generate_series(1, array_length(v_bp, 1)) AS idx
    ) t WHERE t.val = v_a1_seed;

    v_a1_half := CASE
      WHEN ceil(v_a1_pos::float / 2) <= v_num_first_round / 2 THEN 0
      ELSE 1
    END;

    IF v_a1_half = 0 THEN
      IF array_length(v_lower_avail, 1) > 0 THEN
        v_target_seed := v_lower_avail[1];
        v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
      ELSE
        v_target_seed := v_upper_avail[1];
        v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
      END IF;
    ELSE
      IF array_length(v_upper_avail, 1) > 0 THEN
        v_target_seed := v_upper_avail[1];
        v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
      ELSE
        v_target_seed := v_lower_avail[1];
        v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
      END IF;
    END IF;

    INSERT INTO _seed_map (seed_num, club_id, group_id, group_name, rank)
    VALUES (
      v_target_seed,
      CASE WHEN v_adv2.group_finished THEN v_adv2.club_id ELSE NULL END,
      v_adv2.group_id, v_adv2.group_name, v_adv2.rank
    );
  END LOOP;

  -- 11. 1라운드 슬롯 배치 — ✅ 020: 조 출신 자리는 항상 출처 기록, 미정이면 이름표
  FOR v_i IN 1..v_num_first_round LOOP
    v_seed_num := v_bp[(v_i - 1) * 2 + 1];
    v_seed_team := NULL; v_label_a := NULL; v_rank_a := NULL; v_src_a := NULL; v_gid_a := NULL;

    IF v_seed_num <= v_total_adv THEN
      SELECT sm.club_id, sm.group_name, sm.rank, sm.group_id
      INTO v_seed_team, v_label_a, v_rank_a, v_gid_a
      FROM _seed_map sm WHERE sm.seed_num = v_seed_num;

      v_src_a := v_gid_a::text || ':' || v_rank_a;
      IF v_seed_team IS NULL THEN
        v_label_a := COALESCE(v_label_a, '?') || ' ' || COALESCE(v_rank_a::text, '?') || '위';
        v_tbd_count := v_tbd_count + 1;
      ELSE
        v_label_a := NULL;
      END IF;
    END IF;

    v_seed_num := v_bp[(v_i - 1) * 2 + 2];
    DECLARE
      v_seed_team_b uuid;
      v_label_b text;
      v_rank_b int;
      v_gid_b uuid;
      v_src_b text;
    BEGIN
      v_seed_team_b := NULL; v_label_b := NULL; v_rank_b := NULL; v_gid_b := NULL; v_src_b := NULL;

      IF v_seed_num <= v_total_adv THEN
        SELECT sm.club_id, sm.group_name, sm.rank, sm.group_id
        INTO v_seed_team_b, v_label_b, v_rank_b, v_gid_b
        FROM _seed_map sm WHERE sm.seed_num = v_seed_num;

        v_src_b := v_gid_b::text || ':' || v_rank_b;
        IF v_seed_team_b IS NULL THEN
          v_label_b := COALESCE(v_label_b, '?') || ' ' || COALESCE(v_rank_b::text, '?') || '위';
          v_tbd_count := v_tbd_count + 1;
        ELSE
          v_label_b := NULL;
        END IF;
      END IF;

      UPDATE ties SET
        club_a_id = v_seed_team,
        club_b_id = v_seed_team_b,
        qualifier_label_a = v_label_a,
        qualifier_label_b = v_label_b,
        qualifier_src_a = v_src_a,
        qualifier_src_b = v_src_b
      WHERE id = v_fm[v_i];
    END;
  END LOOP;

  -- 12. BYE 처리 — ✅ 020: 미정 이름표가 있는 대전은 부전승 아님 (채워질 때 판정)
  FOR v_curr IN
    SELECT t.id, t.club_a_id, t.club_b_id,
           t.qualifier_label_a, t.qualifier_label_b,
           rt.tie_idx
    FROM ties t
    JOIN _round_ties rt ON rt.tie_id = t.id
    WHERE rt.round_idx = 0
      AND (t.club_a_id IS NULL OR t.club_b_id IS NULL)
      AND t.qualifier_label_a IS NULL
      AND t.qualifier_label_b IS NULL
  LOOP
    IF v_curr.club_a_id IS NULL AND v_curr.club_b_id IS NULL THEN
      UPDATE ties SET is_bye = true, status = 'bye' WHERE id = v_curr.id;
      v_bye_applied := v_bye_applied + 1;
      CONTINUE;
    END IF;

    v_bye_winner := COALESCE(v_curr.club_a_id, v_curr.club_b_id);
    UPDATE ties SET
      winning_club_id = v_bye_winner,
      is_bye = true,
      status = 'bye'
    WHERE id = v_curr.id;

    DECLARE
      v_next_tie_id uuid;
      v_next_pos int := ((v_curr.tie_idx - 1) / 2) + 1;
      v_is_upper boolean := (v_curr.tie_idx % 2 = 1);
    BEGIN
      SELECT tie_id INTO v_next_tie_id FROM _round_ties
      WHERE round_idx = 1 AND tie_idx = v_next_pos;

      IF v_next_tie_id IS NOT NULL THEN
        IF v_is_upper THEN
          UPDATE ties SET club_a_id = v_bye_winner WHERE id = v_next_tie_id;
        ELSE
          UPDATE ties SET club_b_id = v_bye_winner WHERE id = v_next_tie_id;
        END IF;
      END IF;
    END;
    v_bye_applied := v_bye_applied + 1;
  END LOOP;

  -- 13. 양쪽 다 채워진 2라운드+ ties 러버 생성
  FOR v_curr IN
    SELECT t.id, t.club_a_id, t.club_b_id, t.rubber_count
    FROM ties t
    JOIN _round_ties rt ON rt.tie_id = t.id
    WHERE rt.round_idx >= 1
      AND t.club_a_id IS NOT NULL
      AND t.club_b_id IS NOT NULL
      AND t.is_bye = false
  LOOP
    FOR v_i IN 1..v_curr.rubber_count LOOP
      INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
      VALUES (v_curr.id, v_i, 'pending', LPAD(FLOOR(RANDOM()*1000000)::TEXT,6,'0'));
    END LOOP;
  END LOOP;

  -- 14. 1라운드 실제 경기 러버 생성
  FOR v_curr IN
    SELECT t.id, t.rubber_count
    FROM ties t
    JOIN _round_ties rt ON rt.tie_id = t.id
    WHERE rt.round_idx = 0
      AND t.is_bye = false
      AND t.club_a_id IS NOT NULL
      AND t.club_b_id IS NOT NULL
  LOOP
    FOR v_i IN 1..v_curr.rubber_count LOOP
      INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
      VALUES (v_curr.id, v_i, 'pending', LPAD(FLOOR(RANDOM()*1000000)::TEXT,6,'0'));
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'ties_created', v_ties_created,
    'bracket_size', v_bracket_size,
    'byes', v_byes,
    'byes_applied', v_bye_applied,
    'tbd_slots', v_tbd_count,
    'undecided_groups', to_jsonb(coalesce(v_undecided, ARRAY[]::text[]))
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
