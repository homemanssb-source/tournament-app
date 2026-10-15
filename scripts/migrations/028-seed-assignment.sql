-- ============================================================
-- 028: 시드 배정 (개인전·단체전 공통) — 예선 조편성 + 본선 대진
--
--   시드는 선택 사항. 운영자가 시드 수와 시드 팀을 직접 지정한다.
--     개인전: teams.seed_number (새 컬럼)     단체전: clubs.seed_number (기존 컬럼)
--   시드를 하나도 안 정하면 지금과 똑같이 전부 랜덤.
--
--   예선 조편성 (rpc_generate_groups / rpc_create_team_groups)
--     시드 k번 → k번째 조의 첫 자리. 나머지는 랜덤. 시드끼리 같은 조에 들어가지 않는다.
--     (화면은 시드 수 ≤ 조 수로 제한. 그래도 넘치면 남는 시드는 뱀 순서로 배치 — 오류 없음)
--   본선 대진 (rpc_generate_tournament 4-인자 / rpc_generate_team_tournament_v2)
--     "시드가 속한 조의 1위" 자리를 시드 번호 순으로 표준 시드 위치(1번=맨 위, 2번=맨 아래,
--     3·4번=서로 다른 4분의1 …)에 놓는다 → 시드 1·2는 결승 전에는 만나지 않는다.
--     BYE 는 표준 배열대로 상위 시드부터 받는다. 같은 조 2위는 기존처럼 반대쪽 절반.
--     미리 생성(TBD)도 같은 자리 규칙이라 조 경기가 끝난 뒤 채워져도 위치가 유지된다.
--
--   라이브 정의 기준 원본: 016(rpc_generate_groups) · 017(rpc_generate_tournament)
--                         · 021(rpc_create_team_groups, rpc_generate_team_tournament_v2)
--   바뀐 곳은 [028] 표시. 기존 데이터 변경 없음 (컬럼 추가만). 멱등.
-- ============================================================

ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS seed_number smallint;

-- ── 1) 개인전 예선 조편성 ──
CREATE OR REPLACE FUNCTION public.rpc_generate_groups(p_event_id uuid, p_division_id uuid, p_group_size integer DEFAULT 4)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_team_count int;
  v_tpg int;
  v_team_ids uuid[];
  v_group_sizes int[];
  v_group_id uuid;
  v_group_num int := 0;
  v_idx int := 1;
  v_gs int;
  v_remainder int;
  v_full_groups int;
  v_div_name text;
  v_created int := 0;
  v_advance int := 1;
  v_seed_ids uuid[];   -- [028] 시드 팀 (시드 번호 순)
  v_rest_ids uuid[];   -- [028] 비시드 팀 (랜덤)
  v_seed_cnt int := 0;
  v_ri int := 1;
  v_ng int;            -- [028] 조 수
  v_g int;
  v_off int[];         -- [028] 조별 시작 위치
  v_fill int[];        -- [028] 조별 채운 수
BEGIN
  v_tpg := GREATEST(2, LEAST(6, p_group_size));

  SELECT name INTO v_div_name FROM divisions WHERE id = p_division_id;
  IF v_div_name IS NULL THEN
    RAISE EXCEPTION '부서를 찾을 수 없습니다.';
  END IF;

  SELECT advance_count INTO v_advance
  FROM group_settings
  WHERE event_id = p_event_id AND division_id = p_division_id;
  v_advance := COALESCE(v_advance, 1);

  INSERT INTO group_settings(event_id, division_id, division_name, teams_per_group, advance_count, random_assign)
  VALUES (p_event_id, p_division_id, v_div_name, v_tpg, v_advance, true)
  ON CONFLICT (event_id, division_id) DO UPDATE SET teams_per_group = v_tpg;

  DELETE FROM group_members WHERE group_id IN (
    SELECT id FROM groups WHERE event_id = p_event_id AND division_id = p_division_id
  );
  DELETE FROM groups WHERE event_id = p_event_id AND division_id = p_division_id;
  UPDATE teams SET group_id = NULL
  WHERE event_id = p_event_id AND division_id = p_division_id;

  SELECT array_agg(id ORDER BY random()) INTO v_team_ids
  FROM teams WHERE event_id = p_event_id AND division_id = p_division_id;

  v_team_count := COALESCE(array_length(v_team_ids, 1), 0);
  IF v_team_count < 2 THEN
    RAISE EXCEPTION '팀이 2팀 미만입니다. (현재: %팀)', v_team_count;
  END IF;

  v_remainder := v_team_count % v_tpg;
  v_full_groups := v_team_count / v_tpg;
  v_group_sizes := ARRAY[]::int[];

  IF v_remainder = 0 THEN
    FOR i IN 1..v_full_groups LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
  ELSIF v_remainder = 1 THEN
    FOR i IN 1..(v_full_groups - 1) LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
    IF v_tpg = 2 THEN
      v_group_sizes := array_append(v_group_sizes, 3);
    ELSIF v_tpg = 3 THEN
      v_group_sizes := array_append(v_group_sizes, 2);
      v_group_sizes := array_append(v_group_sizes, 2);
    ELSIF v_tpg = 4 THEN
      v_group_sizes := array_append(v_group_sizes, 3);
      v_group_sizes := array_append(v_group_sizes, 2);
    ELSIF v_tpg = 5 THEN
      v_group_sizes := array_append(v_group_sizes, 3);
      v_group_sizes := array_append(v_group_sizes, 3);
    ELSIF v_tpg = 6 THEN
      v_group_sizes := array_append(v_group_sizes, 4);
      v_group_sizes := array_append(v_group_sizes, 3);
    ELSE
      v_group_sizes := array_append(v_group_sizes, v_tpg + 1);
    END IF;
  ELSE
    FOR i IN 1..v_full_groups LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
    v_group_sizes := array_append(v_group_sizes, v_remainder);
  END IF;

  -- [028] 시드: 시드 k번 → k번째 조 첫 자리 → 시드끼리 같은 조가 되지 않는다(시드 수 ≤ 조 수일 때).
  --   시드가 조 수보다 많으면 남는 시드는 뱀 순서(…3조→2조→1조)로 다음 자리에. 나머지는 랜덤.
  SELECT coalesce(array_agg(id ORDER BY seed_number, random()), '{}') INTO v_seed_ids
  FROM teams WHERE event_id = p_event_id AND division_id = p_division_id AND seed_number IS NOT NULL;
  v_seed_cnt := coalesce(array_length(v_seed_ids, 1), 0);

  IF v_seed_cnt > 0 THEN
    v_ng := array_length(v_group_sizes, 1);
    v_off := ARRAY[]::int[]; v_fill := ARRAY[]::int[]; v_ri := 0;
    FOR gi IN 1..v_ng LOOP
      v_off := array_append(v_off, v_ri);
      v_fill := array_append(v_fill, 0);
      v_ri := v_ri + v_group_sizes[gi];
    END LOOP;
    v_team_ids := array_fill(NULL::uuid, ARRAY[v_ri]);

    FOR si IN 1..v_seed_cnt LOOP
      v_g := ((si - 1) % v_ng) + 1;
      IF ((si - 1) / v_ng) % 2 = 1 THEN v_g := v_ng - v_g + 1; END IF;
      WHILE v_fill[v_g] >= v_group_sizes[v_g] LOOP v_g := (v_g % v_ng) + 1; END LOOP;
      v_fill[v_g] := v_fill[v_g] + 1;
      v_team_ids[v_off[v_g] + v_fill[v_g]] := v_seed_ids[si];
    END LOOP;

    SELECT coalesce(array_agg(id ORDER BY random()), '{}') INTO v_rest_ids
    FROM teams WHERE event_id = p_event_id AND division_id = p_division_id AND seed_number IS NULL;
    v_ri := 1;
    FOR si IN 1..array_length(v_team_ids, 1) LOOP
      IF v_team_ids[si] IS NULL THEN
        v_team_ids[si] := v_rest_ids[v_ri];
        v_ri := v_ri + 1;
      END IF;
    END LOOP;
  END IF;

  v_idx := 1;
  FOREACH v_gs IN ARRAY v_group_sizes LOOP
    v_group_num := v_group_num + 1;
    INSERT INTO groups(event_id, division_id, division_name, group_label, group_num, advance_count)
    VALUES (p_event_id, p_division_id, v_div_name, v_group_num || '조', v_group_num, v_advance)
    RETURNING id INTO v_group_id;

    FOR j IN v_idx..(v_idx + v_gs - 1) LOOP
      -- [016] seq = 조 내 순번 (1번·2번·3번…)
      INSERT INTO group_members(event_id, division_id, group_id, team_id, seq)
      VALUES (p_event_id, p_division_id, v_group_id, v_team_ids[j], (j - v_idx + 1));
      UPDATE teams SET group_id = v_group_id WHERE id = v_team_ids[j];
    END LOOP;

    v_idx := v_idx + v_gs;
    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'groups_created', v_created,
    'teams_assigned', v_team_count,
    'group_size', v_tpg,
    'seeds', v_seed_cnt,
    'division', v_div_name
  );
END;
$function$;

-- ── 2) 개인전 본선 대진 (4-인자 버전, 화면에서 사용) ──
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

    -- 3위 이상
    INSERT INTO _seed_map (seed_num, team_id, group_id, group_name, rank)
    SELECT s.seed_num,
           CASE WHEN a.group_finished THEN a.team_id ELSE NULL END,
           a.group_id, a.group_name, a.rank
    FROM _adv a
    CROSS JOIN LATERAL (
      SELECT gs AS seed_num
      FROM generate_series(1, v_bracket_size) gs
      WHERE gs NOT IN (SELECT seed_num FROM _seed_map)
      ORDER BY gs
      LIMIT 1
    ) s
    WHERE a.rank >= 3
      AND a.group_id NOT IN (SELECT group_id FROM _seed_map)
    ORDER BY a.rank, a.group_num;

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

-- ── 3) 단체전 예선 조편성 ──
CREATE OR REPLACE FUNCTION public.rpc_create_team_groups(p_event_id uuid, p_group_count integer DEFAULT 2, p_group_size integer DEFAULT 4, p_division_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_all_clubs uuid[];
  v_rubber_count int;
  v_group_ids uuid[];
  v_gid uuid;
  v_group_sizes int[];
  v_gs int;
  v_idx int := 1;
  v_group_num int := 0;
  v_group_clubs uuid[];
  v_gc int;
  v_to int;
  v_total int;
  v_tpg int;
  v_remainder int;
  v_full_groups int;
  i int;
  j int;
  a int;
  b int;
  v_seed_ids uuid[];   -- [028] 시드 클럽 (시드 번호 순)
  v_rest_ids uuid[];   -- [028] 비시드 클럽 (랜덤)
  v_seed_cnt int := 0;
  v_ri int := 1;
  v_ng int;            -- [028] 조 수
  v_g int;
  v_off int[];         -- [028] 조별 시작 위치
  v_fill int[];        -- [028] 조별 채운 수
BEGIN
  v_tpg := GREATEST(2, LEAST(6, p_group_size));

  SELECT coalesce(array_agg(id ORDER BY random()), '{}')
  INTO v_all_clubs
  FROM clubs
  WHERE event_id = p_event_id
    AND (p_division_id IS NULL OR division_id = p_division_id);

  v_total := coalesce(array_length(v_all_clubs, 1), 0);
  IF v_total < 2 THEN
    RETURN json_build_object('success', false, 'error', '최소 2팀이 필요합니다.');
  END IF;

  -- ✅ 021: 부서 경기방식 우선, 대회 값 덮어쓰기 제거
  v_rubber_count := coalesce(fn_team_rubber_count(p_event_id, p_division_id), 3);

  DELETE FROM tie_rubbers WHERE tie_id IN (
    SELECT id FROM ties WHERE event_id = p_event_id
    AND (p_division_id IS NULL OR division_id = p_division_id) AND round = 'group');
  DELETE FROM ties WHERE event_id = p_event_id
    AND (p_division_id IS NULL OR division_id = p_division_id) AND round = 'group';
  DELETE FROM team_standings WHERE event_id = p_event_id
    AND group_id IN (SELECT id FROM groups WHERE event_id = p_event_id
      AND (p_division_id IS NULL OR division_id = p_division_id));
  DELETE FROM groups WHERE event_id = p_event_id
    AND (p_division_id IS NULL OR division_id = p_division_id);

  v_remainder := v_total % v_tpg;
  v_full_groups := v_total / v_tpg;
  v_group_sizes := ARRAY[]::int[];

  IF v_remainder = 0 THEN
    FOR i IN 1..v_full_groups LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
  ELSIF v_remainder = 1 THEN
    FOR i IN 1..(v_full_groups - 1) LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
    IF v_tpg = 2 THEN
      v_group_sizes := array_append(v_group_sizes, 3);
    ELSIF v_tpg = 3 THEN
      v_group_sizes := array_append(v_group_sizes, 2);
      v_group_sizes := array_append(v_group_sizes, 2);
    ELSIF v_tpg = 4 THEN
      v_group_sizes := array_append(v_group_sizes, 3);
      v_group_sizes := array_append(v_group_sizes, 2);
    ELSIF v_tpg = 5 THEN
      v_group_sizes := array_append(v_group_sizes, 3);
      v_group_sizes := array_append(v_group_sizes, 3);
    ELSIF v_tpg = 6 THEN
      v_group_sizes := array_append(v_group_sizes, 4);
      v_group_sizes := array_append(v_group_sizes, 3);
    ELSE
      v_group_sizes := array_append(v_group_sizes, v_tpg + 1);
    END IF;
  ELSE
    FOR i IN 1..v_full_groups LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
    v_group_sizes := array_append(v_group_sizes, v_remainder);
  END IF;

  -- [028] 시드: 시드 k번 → k번째 조 첫 자리 → 시드끼리 같은 조가 되지 않는다(시드 수 ≤ 조 수일 때).
  --   시드가 조 수보다 많으면 남는 시드는 뱀 순서(…3조→2조→1조)로 다음 자리에. 나머지는 랜덤.
  SELECT coalesce(array_agg(id ORDER BY seed_number, random()), '{}') INTO v_seed_ids
  FROM clubs WHERE event_id = p_event_id
    AND (p_division_id IS NULL OR division_id = p_division_id) AND seed_number IS NOT NULL;
  v_seed_cnt := coalesce(array_length(v_seed_ids, 1), 0);

  IF v_seed_cnt > 0 THEN
    v_ng := array_length(v_group_sizes, 1);
    v_off := ARRAY[]::int[]; v_fill := ARRAY[]::int[]; v_ri := 0;
    FOR gi IN 1..v_ng LOOP
      v_off := array_append(v_off, v_ri);
      v_fill := array_append(v_fill, 0);
      v_ri := v_ri + v_group_sizes[gi];
    END LOOP;
    v_all_clubs := array_fill(NULL::uuid, ARRAY[v_ri]);

    FOR si IN 1..v_seed_cnt LOOP
      v_g := ((si - 1) % v_ng) + 1;
      IF ((si - 1) / v_ng) % 2 = 1 THEN v_g := v_ng - v_g + 1; END IF;
      WHILE v_fill[v_g] >= v_group_sizes[v_g] LOOP v_g := (v_g % v_ng) + 1; END LOOP;
      v_fill[v_g] := v_fill[v_g] + 1;
      v_all_clubs[v_off[v_g] + v_fill[v_g]] := v_seed_ids[si];
    END LOOP;

    SELECT coalesce(array_agg(id ORDER BY random()), '{}') INTO v_rest_ids
    FROM clubs WHERE event_id = p_event_id
    AND (p_division_id IS NULL OR division_id = p_division_id) AND seed_number IS NULL;
    v_ri := 1;
    FOR si IN 1..array_length(v_all_clubs, 1) LOOP
      IF v_all_clubs[si] IS NULL THEN
        v_all_clubs[si] := v_rest_ids[v_ri];
        v_ri := v_ri + 1;
      END IF;
    END LOOP;
  END IF;

  v_idx := 1;
  FOREACH v_gs IN ARRAY v_group_sizes LOOP
    v_group_num := v_group_num + 1;
    INSERT INTO groups (event_id, division_id, group_label, group_num)
    VALUES (p_event_id, p_division_id, chr(64 + v_group_num) || '조', v_group_num)
    RETURNING id INTO v_gid;
    v_group_ids := array_append(v_group_ids, v_gid);

    FOR j IN v_idx..(v_idx + v_gs - 1) LOOP
      IF j <= array_length(v_all_clubs, 1) THEN
        INSERT INTO team_standings (event_id, group_id, club_id)
        VALUES (p_event_id, v_gid, v_all_clubs[j]);
      END IF;
    END LOOP;
    v_idx := v_idx + v_gs;
  END LOOP;

  FOR i IN 1..array_length(v_group_ids, 1) LOOP
    SELECT coalesce(array_agg(club_id), '{}')
    INTO v_group_clubs FROM team_standings WHERE group_id = v_group_ids[i];
    v_gc := coalesce(array_length(v_group_clubs, 1), 0);
    v_to := 0;
    FOR a IN 1..v_gc LOOP
      FOR b IN (a + 1)..v_gc LOOP
        v_to := v_to + 1;
        INSERT INTO ties (event_id, division_id, group_id, round, tie_order, club_a_id, club_b_id, rubber_count)
        VALUES (p_event_id, p_division_id, v_group_ids[i], 'group', v_to, v_group_clubs[a], v_group_clubs[b], v_rubber_count);
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM rpc_create_rubbers_for_event_ties(p_event_id, 'group');

  RETURN json_build_object(
    'success', true, 'group_count', array_length(v_group_sizes, 1),
    'group_sizes', v_group_sizes, 'total_clubs', v_total, 'rubber_count', v_rubber_count,
    'seeds', v_seed_cnt
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ── 4) 단체전 본선 대진 ──
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

select '028 applied' as result;
