-- ============================================================
-- 029: 개인전 본선 — 조별 3위 진출 시 3위 자리가 비는 버그 수정
--
--   증상: 본선 생성에서 "각 조 3위"까지 진출로 고르면 3위 팀이 대진에 안 들어가고
--         그 자리가 BYE/빈칸이 됨.
--   원인: rpc_generate_tournament 의 3위 이상 배치 쿼리가
--         (1) "_seed_map 에 이미 있는 조 제외" 조건 → 모든 조에 1위가 있으므로 전부 제외
--         (2) LATERAL 로 "남은 가장 작은 번호" 를 한 번에 골라 모든 팀이 같은 번호
--   수정: 3위 이상을 (순위 → 조 번호) 순으로 한 팀씩 남은 시드 번호에 배정.
--         가능하면 1라운드 상대가 같은 조 팀이 아닌 자리를 고른다.
--   028 정의 기준, 바뀐 곳은 [029] 표시. 데이터 변경 없음. 멱등.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_generate_tournament(p_event_id uuid, p_division_id uuid, p_advance_per_group integer DEFAULT 2, p_allow_tbd boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_div_name        text;
  v_advance_count   int;
  v_total_adv       int;
  v_bracket_size    int;
  v_byes            int;
  v_slot            int;
  v_size            int;
  v_round_name      text;
  v_match_id        uuid;
  v_match_num       text;
  v_match_count     int := 0;
  v_bye_applied     int := 0;
  v_r_idx           int;   -- 라운드 루프 전용 (rank에 오용 금지)
  v_m_idx           int;
  v_next_match_id   uuid;
  v_next_slot       text;
  v_first_round_name text;
  v_curr            RECORD;
  v_bye_winner      uuid;
  v_fm              uuid[];
  v_num_first_round int;
  v_i               int;
  v_tbd_count       int := 0;
BEGIN
  SELECT name INTO v_div_name FROM divisions WHERE id = p_division_id;
  IF v_div_name IS NULL THEN RAISE EXCEPTION '부서를 찾을 수 없습니다.'; END IF;

  IF EXISTS (
    SELECT 1 FROM matches
    WHERE event_id = p_event_id AND division_id = p_division_id AND stage = 'FINALS'
  ) THEN
    RAISE EXCEPTION '이미 해당 부서의 본선이 존재합니다.';
  END IF;

  -- p_allow_tbd=false 일 때만 예선 완료 체크
  IF NOT p_allow_tbd THEN
    IF EXISTS (
      SELECT 1 FROM matches
      WHERE event_id = p_event_id AND division_id = p_division_id
        AND stage = 'GROUP'
        -- [5] NULL status 포함 처리
        AND status IS DISTINCT FROM 'FINISHED'
    ) THEN
      RAISE EXCEPTION '예선이 완료되지 않은 경기가 있습니다.';
    END IF;
  END IF;

  v_advance_count := GREATEST(1, COALESCE(p_advance_per_group, 2));

  CREATE TEMP TABLE _adv (
    team_id uuid, group_id uuid, group_num int, group_name text,
    wins int, rank int, group_finished boolean
  ) ON COMMIT DROP;

  -- 그룹별 완료 여부 계산
  -- [SQL-3 대응] 경기 0개 조 방어: total > 0 AND all finished
  INSERT INTO _adv (team_id, group_id, group_num, group_name, wins, rank, group_finished)
  SELECT
    sub.team_id, sub.group_id, sub.group_num, sub.group_name, sub.wins,
    ROW_NUMBER() OVER (PARTITION BY sub.group_id ORDER BY sub.wins DESC, COALESCE((SELECT gd.game_diff FROM fn_group_game_diff(p_event_id, p_division_id) gd WHERE gd.team_id = sub.team_id), 0) DESC, random()),
    sub.group_finished
  FROM (
    SELECT
      gm.team_id, gm.group_id, g.group_num, g.group_label AS group_name,
      COALESCE(w.wins, 0) AS wins,
      (
        SELECT
          COUNT(*) > 0
          AND COUNT(*) FILTER (WHERE m2.status = 'FINISHED') = COUNT(*)
        FROM matches m2
        WHERE m2.event_id    = p_event_id
          AND m2.division_id = p_division_id
          AND m2.stage       = 'GROUP'
          AND m2.group_id    = gm.group_id
      ) AS group_finished
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    LEFT JOIN (
      SELECT winner_team_id, COUNT(*) AS wins FROM matches
      WHERE event_id = p_event_id AND division_id = p_division_id
        AND stage = 'GROUP' AND winner_team_id IS NOT NULL
      GROUP BY winner_team_id
    ) w ON gm.team_id = w.winner_team_id
    WHERE gm.event_id = p_event_id AND gm.division_id = p_division_id
  ) sub;

  DELETE FROM _adv WHERE rank > v_advance_count;
  SELECT COUNT(*) INTO v_total_adv FROM _adv;
  IF v_total_adv < 2 THEN
    RAISE EXCEPTION '진출팀이 2팀 미만입니다. (%팀)', v_total_adv;
  END IF;

  v_bracket_size    := 1;
  WHILE v_bracket_size < v_total_adv LOOP
    v_bracket_size := v_bracket_size * 2;
  END LOOP;
  v_byes            := v_bracket_size - v_total_adv;
  v_num_first_round := v_bracket_size / 2;

  SELECT COALESCE(MAX(slot), 0) INTO v_slot FROM matches WHERE event_id = p_event_id;

  CREATE TEMP TABLE _round_matches (
    round_idx int, match_idx int, match_id uuid, round_name text
  ) ON COMMIT DROP;

  -- 라운드별 경기 생성
  v_size  := v_bracket_size;
  v_r_idx := 0;
  WHILE v_size >= 2 LOOP
    v_round_name := size_to_round(v_size);
    v_m_idx := 0;
    FOR i IN 1..(v_size / 2) LOOP
      v_slot      := v_slot + 1;
      v_match_num := next_match_num(p_event_id);
      v_m_idx     := v_m_idx + 1;
      INSERT INTO matches(
        match_num, event_id, division_id, division_name,
        stage, round, slot, status, is_tbd_bracket
      )
      VALUES (
        v_match_num, p_event_id, p_division_id, v_div_name,
        'FINALS', v_round_name, v_slot, 'PENDING', p_allow_tbd
      )
      RETURNING id INTO v_match_id;
      INSERT INTO _round_matches VALUES (v_r_idx, v_m_idx, v_match_id, v_round_name);
      v_match_count := v_match_count + 1;
    END LOOP;
    v_size  := v_size / 2;
    v_r_idx := v_r_idx + 1;
  END LOOP;

  -- bracket_nodes 연결
  FOR v_curr IN SELECT * FROM _round_matches ORDER BY round_idx, match_idx LOOP
    v_next_match_id := NULL; v_next_slot := NULL;
    SELECT match_id INTO v_next_match_id FROM _round_matches
    WHERE round_idx = v_curr.round_idx + 1
      AND match_idx = ((v_curr.match_idx - 1) / 2) + 1;
    IF v_next_match_id IS NOT NULL THEN
      v_next_slot := CASE WHEN (v_curr.match_idx - 1) % 2 = 0 THEN 'A' ELSE 'B' END;
    END IF;
    INSERT INTO bracket_nodes(
      event_id, division_id, division_name, round,
      match_id, next_match_id, next_slot, lock
    )
    VALUES (
      p_event_id, p_division_id, v_div_name, v_curr.round_name,
      v_curr.match_id, v_next_match_id, v_next_slot, false
    );
  END LOOP;

  SELECT array_agg(match_id ORDER BY match_idx) INTO v_fm
  FROM _round_matches WHERE round_idx = 0;

  -- ============================================================
  -- 시드 배치
  -- ============================================================
  DECLARE
    v_bp          int[];
    v_seed_team   uuid;
    v_seed_num    int;
    v_rank1_count int;
    v_rank2_count int;
    v_a1_seed     int;
    v_a1_pos      int;
    v_a1_half     int;
    v_target_seed int;
    v_adv2        RECORD;
    v_upper_avail int[];
    v_lower_avail int[];
    v_pos         int;
    v_label_a     text;
    -- [2] v_r_idx 오용 수정: rank 전용 변수 별도 선언
    v_rank_a      int;
  BEGIN
    -- 표준 시드 브래킷 배열 생성
    v_bp := ARRAY[1, 2];
    WHILE array_length(v_bp, 1) < v_bracket_size LOOP
      DECLARE
        v_new int[];
        v_n   int;
        v_sum int;
      BEGIN
        v_n   := array_length(v_bp, 1);
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
      seed_num int, team_id uuid, group_id uuid, group_name text, rank int
    ) ON COMMIT DROP;

    -- 1위 자리: [028] 시드 선수가 있는 조의 1위가 시드 순서대로 1·2·3…번 자리
    --   (1번=맨 위, 2번=맨 아래 → 결승에서만 만남, 3·4번=서로 다른 4분의1)
    --   시드 없는 조는 그 다음 (완료 조 먼저, 랜덤). 미완료 조는 NULL team_id
    INSERT INTO _seed_map (seed_num, team_id, group_id, group_name, rank)
    SELECT
      ROW_NUMBER() OVER (ORDER BY
        (SELECT MIN(st.seed_number) FROM group_members sgm JOIN teams st ON st.id = sgm.team_id
          WHERE sgm.group_id = _adv.group_id) NULLS LAST,
        CASE WHEN group_finished THEN 0 ELSE 1 END,
        random()
      ) AS seed_num,
      CASE WHEN group_finished THEN team_id ELSE NULL END,
      group_id, group_name, rank
    FROM _adv
    WHERE rank = 1;

    -- 2위팀: 같은 조 1위와 반대 절반 배치
    v_upper_avail := ARRAY[]::int[];
    v_lower_avail := ARRAY[]::int[];

    FOR v_i IN (v_rank1_count + 1)..(v_rank1_count + v_rank2_count) LOOP
      SELECT t.idx INTO v_pos
      FROM (
        SELECT unnest(v_bp) AS val,
               generate_series(1, array_length(v_bp, 1)) AS idx
      ) t
      WHERE t.val = v_i;

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
      ) t
      WHERE t.val = v_a1_seed;

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

      INSERT INTO _seed_map (seed_num, team_id, group_id, group_name, rank)
      VALUES (
        v_target_seed,
        CASE WHEN v_adv2.group_finished THEN v_adv2.team_id ELSE NULL END,
        v_adv2.group_id, v_adv2.group_name, v_adv2.rank
      );
    END LOOP;

    -- 3위 이상 — [029] 한 팀씩 남은 시드 번호(작은 수부터)를 차례로 배정
    --   (기존: 1위가 있는 조를 모두 제외하는 조건 때문에 한 팀도 안 들어갔고, 들어가도 전부 같은 번호였음)
    DECLARE
      v_adv3 RECORD;
      v_free int;
    BEGIN
      FOR v_adv3 IN SELECT * FROM _adv WHERE rank >= 3 ORDER BY rank, group_num LOOP
        --   1R 상대(표준 배열: 시드 s ↔ 시드 bracket_size+1−s)가 같은 조면 피한다
        SELECT gs INTO v_free
        FROM generate_series(1, v_total_adv) gs
        WHERE gs NOT IN (SELECT seed_num FROM _seed_map)
        ORDER BY EXISTS (SELECT 1 FROM _seed_map sm
                         WHERE sm.seed_num = v_bracket_size + 1 - gs
                           AND sm.group_id = v_adv3.group_id), gs
        LIMIT 1;
        EXIT WHEN v_free IS NULL;
        INSERT INTO _seed_map (seed_num, team_id, group_id, group_name, rank)
        VALUES (v_free,
                CASE WHEN v_adv3.group_finished THEN v_adv3.team_id ELSE NULL END,
                v_adv3.group_id, v_adv3.group_name, v_adv3.rank);
      END LOOP;
    END;

    -- 1라운드 슬롯 배치 + qualifier_label 설정
    FOR v_i IN 1..v_num_first_round LOOP

      -- ── A 슬롯 ──────────────────────────────────────────
      v_seed_num  := v_bp[(v_i - 1) * 2 + 1];
      v_seed_team := NULL;
      v_label_a   := NULL;
      v_rank_a    := NULL;  -- [2] 별도 rank 변수

      IF v_seed_num <= v_total_adv THEN
        -- [2] v_r_idx 오용 제거 → v_rank_a 사용
        SELECT sm.team_id, sm.group_name, sm.rank
        INTO   v_seed_team, v_label_a, v_rank_a
        FROM   _seed_map sm WHERE sm.seed_num = v_seed_num;

        IF v_seed_team IS NULL AND p_allow_tbd THEN
          -- [1] NULL 연결 버그 수정: COALESCE 적용
          v_label_a   := COALESCE(v_label_a, '?') || ' ' || COALESCE(v_rank_a::text, '?') || '위';
          v_tbd_count := v_tbd_count + 1;
        ELSE
          v_label_a := NULL;
        END IF;
      END IF;

      -- ── B 슬롯 ──────────────────────────────────────────
      v_seed_num := v_bp[(v_i - 1) * 2 + 2];
      DECLARE
        v_seed_team_b uuid;
        v_label_b_val text;
        v_rank_b      int;
      BEGIN
        v_seed_team_b := NULL; v_label_b_val := NULL; v_rank_b := NULL;

        IF v_seed_num <= v_total_adv THEN
          SELECT sm.team_id, sm.group_name, sm.rank
          INTO   v_seed_team_b, v_label_b_val, v_rank_b
          FROM   _seed_map sm WHERE sm.seed_num = v_seed_num;

          IF v_seed_team_b IS NULL AND p_allow_tbd THEN
            -- [1] NULL 연결 버그 수정: COALESCE 적용
            v_label_b_val := COALESCE(v_label_b_val, '?') || ' ' || COALESCE(v_rank_b::text, '?') || '위';
            v_tbd_count   := v_tbd_count + 1;
          ELSE
            v_label_b_val := NULL;
          END IF;
        END IF;

        UPDATE matches
        SET
          team_a_id         = v_seed_team,
          team_b_id         = v_seed_team_b,
          qualifier_label_a = v_label_a,
          qualifier_label_b = v_label_b_val
        WHERE id = v_fm[v_i];
      END;

    END LOOP;
  END;

  -- BYE 처리 (qualifier_label 있는 슬롯 제외)
  v_first_round_name := size_to_round(v_bracket_size);

  FOR v_curr IN
    SELECT m.id, m.team_a_id, m.team_b_id,
           m.qualifier_label_a, m.qualifier_label_b,
           bn.next_match_id, bn.next_slot
    FROM matches m
    JOIN bracket_nodes bn ON bn.match_id = m.id
    WHERE m.event_id    = p_event_id
      AND m.division_id = p_division_id
      AND m.stage       = 'FINALS'
      AND m.round       = v_first_round_name
      AND (m.team_a_id IS NULL OR m.team_b_id IS NULL)
      AND NOT (
        p_allow_tbd AND (
          m.qualifier_label_a IS NOT NULL OR
          m.qualifier_label_b IS NOT NULL
        )
      )
  LOOP
    IF v_curr.team_a_id IS NULL AND v_curr.team_b_id IS NULL THEN
      UPDATE matches SET status = 'FINISHED', score = 'BYE', ended_at = now()
      WHERE id = v_curr.id;
      v_bye_applied := v_bye_applied + 1;
      CONTINUE;
    END IF;

    v_bye_winner := COALESCE(v_curr.team_a_id, v_curr.team_b_id);
    UPDATE matches
    SET winner_team_id = v_bye_winner, status = 'FINISHED', score = 'BYE', ended_at = now()
    WHERE id = v_curr.id;

    IF v_curr.next_match_id IS NOT NULL THEN
      IF v_curr.next_slot = 'A' THEN
        UPDATE matches SET team_a_id = v_bye_winner WHERE id = v_curr.next_match_id;
      ELSE
        UPDATE matches SET team_b_id = v_bye_winner WHERE id = v_curr.next_match_id;
      END IF;
    END IF;
    v_bye_applied := v_bye_applied + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success',        true,
    'matches_created', v_match_count,
    'bracket_size',    v_bracket_size,
    'adv_teams',       v_total_adv,
    'byes',            v_byes,
    'byes_applied',    v_bye_applied,
    'tbd_slots',       v_tbd_count,
    'division',        v_div_name
  );
END;
$function$
;

select '029 applied' as result;
