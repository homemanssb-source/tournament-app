-- 035 되돌리기: 028/020/019 시점 정의 복원

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

  -- 2. rubber_count — ✅ 021: 부서 경기방식 우선
  v_rubber_count := coalesce(fn_team_rubber_count(p_event_id, p_division_id), 3);

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

  -- 8. 1위 자리 — [028] 시드 클럽이 있는 조의 1위가 시드 순서대로 1·2·3…번 자리
  --    (1번=맨 위, 2번=맨 아래 → 결승에서만 만남). 시드 없는 조는 그 다음 (완료 조 먼저, 랜덤)
  INSERT INTO _seed_map (seed_num, club_id, group_id, group_name, rank)
  SELECT
    ROW_NUMBER() OVER (ORDER BY
      (SELECT MIN(sc.seed_number) FROM team_standings sts JOIN clubs sc ON sc.id = sts.club_id
        WHERE sts.group_id = _adv.group_id) NULLS LAST,
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


CREATE OR REPLACE FUNCTION public.rpc_advance_tournament_winner(p_tie_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tie RECORD;
  v_next_round TEXT;
  v_next_position INT;
  v_next_tie RECORD;
  v_is_upper BOOLEAN;
  v_current_club uuid;
  v_started BOOLEAN;
BEGIN
  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie.winning_club_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', '아직 승자가 결정되지 않았습니다.');
  END IF;
  CASE v_tie.round
    WHEN 'round_of_16' THEN v_next_round := 'quarter';
    WHEN 'quarter'     THEN v_next_round := 'semi';
    WHEN 'semi'        THEN v_next_round := 'final';
    WHEN 'final'       THEN
      RETURN json_build_object('success', true, 'message', '결승 완료! 우승 확정.');
    ELSE
      RETURN json_build_object('success', false, 'error', '알 수 없는 라운드: ' || v_tie.round);
  END CASE;
  v_next_position := ceil(v_tie.bracket_position::NUMERIC / 2);
  v_is_upper      := (v_tie.bracket_position % 2 = 1);

  SELECT * INTO v_next_tie FROM ties
  WHERE event_id = v_tie.event_id
    AND (
      (v_tie.division_id IS NULL AND division_id IS NULL)
      OR division_id = v_tie.division_id
    )
    AND round = v_next_round
    AND bracket_position = v_next_position
  LIMIT 1;

  IF v_next_tie.id IS NULL THEN
    RETURN json_build_object('success', false, 'error',
      '다음 라운드 대전을 찾을 수 없습니다. round=' || v_next_round || ' pos=' || v_next_position);
  END IF;

  v_current_club := CASE WHEN v_is_upper THEN v_next_tie.club_a_id ELSE v_next_tie.club_b_id END;

  -- ✅ 019: 슬롯에 다른 클럽이 있고 다음 대전이 이미 시작됐으면 바꾸지 않음
  IF v_current_club IS NOT NULL AND v_current_club <> v_tie.winning_club_id THEN
    v_started := v_next_tie.status IN ('lineup_phase', 'lineup_ready', 'in_progress', 'completed')
      OR coalesce(v_next_tie.club_a_lineup_submitted, false)
      OR coalesce(v_next_tie.club_b_lineup_submitted, false)
      OR EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = v_next_tie.id AND status = 'completed');
    IF v_started THEN
      RETURN json_build_object('success', false, 'error',
        '다음 라운드 대전이 이미 시작되어 진출팀을 바꿀 수 없습니다. 운영자 확인이 필요합니다.');
    END IF;
  END IF;

  -- 슬롯 채우기 (같은 클럽이면 건너뜀)
  IF v_current_club IS DISTINCT FROM v_tie.winning_club_id THEN
    -- ✅ F2-2: club_id 채울 때 qualifier_label도 NULL로 정리
    IF v_is_upper THEN
      UPDATE ties
        SET club_a_id = v_tie.winning_club_id,
            qualifier_label_a = NULL
        WHERE id = v_next_tie.id;
    ELSE
      UPDATE ties
        SET club_b_id = v_tie.winning_club_id,
            qualifier_label_b = NULL
        WHERE id = v_next_tie.id;
    END IF;
  END IF;

  SELECT * INTO v_next_tie FROM ties WHERE id = v_next_tie.id;
  -- ✅ 019: 기존 러버는 절대 지우지 않음 — 하나도 없을 때만 생성
  IF v_next_tie.club_a_id IS NOT NULL AND v_next_tie.club_b_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tie_rubbers WHERE tie_id = v_next_tie.id) THEN
    FOR i IN 1..v_next_tie.rubber_count LOOP
      -- ✅ F2-3: status 명시 ('pending')
      INSERT INTO tie_rubbers (tie_id, rubber_number, status, pin_code)
      VALUES (v_next_tie.id, i, 'pending', LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0'));
    END LOOP;
  END IF;
  RETURN json_build_object(
    'success', true,
    'next_round', v_next_round,
    'next_position', v_next_position,
    'winner', v_tie.winning_club_id
  );
END;
$function$;


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

select '035 rolled back' as result;
