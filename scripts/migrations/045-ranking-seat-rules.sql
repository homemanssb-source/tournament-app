-- ============================================================
-- 045: 전체 랭킹제 부서의 조 크기·부전승·본선 자리 규칙 (개인전)
--
--   적용 대상: 부서의 모든 팀에 시드가 있을 때만 (전체 랭킹제). 시드가 없거나 상위 몇 팀만 시드인 부서,
--              단체전은 지금과 완전히 같다.
--   1) 조편성(rpc_generate_groups): 팀 수가 조 크기로 안 나눠질 때 생기는 작은 조를 앞 번호 조로 둔다.
--        → 상위 시드가 2팀 조(순위 결정전 1경기만), 하위 시드가 3팀 조.   예) 20팀·3팀 조 = 2·3·3·3·3·3·3
--   2) 본선(rpc_generate_tournament, 4-인자) — 조 1·2위 진출이고 부전승 수 ≤ 조 수일 때:
--        a. 조 1위 자리는 지금처럼 조 번호 = 시드 번호 (1조 1위 맨 위 …)
--        b. 부전승은 3팀 이상 조의 1위에게, 대진표 위·아래 절반에 고르게(그 안에서는 앞 번호 조부터).
--           2팀 조 1위는 부전승 없이 조 2위와 첫 경기.
--        c. 조 2위는 같은 조 1위의 반대쪽 절반(044 그대로). 반대쪽이 다 차면 같은 절반에서 가장 늦게 만나는 자리.
--        d. 아래쪽 절반은 경기 순서를 뒤집어 2조 1위가 대진표 맨 아래 경기에 온다 (만나는 라운드는 그대로).
--   028(rpc_generate_groups) · 044(rpc_generate_tournament) 정의 기준, 바뀐 곳은 [045] 표시.
--   데이터·컬럼 변경 없음. 멱등. 되돌리기: 045-rollback.sql
--   ※ 적용 전 라이브 정의가 028·044 와 같은지 확인할 것 (md5(prosrc)).
-- ============================================================

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

  -- [045] 전체 랭킹제(모든 팀에 시드): 작은 조를 앞 번호 조로 → 상위 시드가 2팀 조(순위 결정전만), 하위 시드가 3팀 조
  IF v_seed_cnt = v_team_count THEN
    SELECT array_agg(s ORDER BY s) INTO v_group_sizes FROM unnest(v_group_sizes) AS s;
  END IF;

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
    v_has_seed    boolean;   -- [044] 이 부서에 시드(랭킹)가 지정돼 있는가
    v_rank_mode   boolean;   -- [045] 전체 랭킹제(모든 팀 시드 + 조 2위까지 진출) → 새 자리 규칙
    v_bye_seeds   int[] := ARRAY[]::int[];   -- [045] 부전승 칸(시드 번호)
    v_best        int;
    v_best_meet   int;
    v_meet        int;
    v_p           int;
    v_q           int;
    v_cand        int;
    v_tgt         int;       -- [045] 첫 라운드 경기 위치 (아래쪽 절반은 뒤집음)
    v_bye_from    int[] := ARRAY[]::int[];   -- [045] 부전승 받는 1위의 시드 번호
    v_up_b        int := 0;  -- [045] 위쪽 절반 부전승 수
    v_lo_b        int := 0;  -- [045] 아래쪽 절반 부전승 수
    v_is_up       boolean;
  BEGIN
    v_has_seed := EXISTS (SELECT 1 FROM teams WHERE event_id = p_event_id AND division_id = p_division_id AND seed_number IS NOT NULL);
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

    -- [045] 전체 랭킹제: 모든 팀에 시드가 있고, 조 1·2위만 진출하고, 부전승 수가 조 수 이하일 때
    v_rank_mode := v_has_seed
      AND NOT EXISTS (SELECT 1 FROM teams WHERE event_id = p_event_id AND division_id = p_division_id AND seed_number IS NULL)
      AND v_advance_count = 2
      AND v_rank1_count + v_rank2_count = v_total_adv
      AND v_byes <= v_rank1_count;

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

    -- [045] 부전승은 3팀 이상 조의 1위에게 (2팀 조 1위는 순위 결정전만 했으므로 제외, 모자랄 때만 2팀 조).
    --   대진표 위·아래 절반에 고르게: 부전승이 적은 절반에서, 그 안에서는 앞 번호 조부터. 부전승 칸 = 그 1위의 맞은편 자리.
    IF v_rank_mode AND v_byes > 0 THEN
      FOR v_i IN 1..v_byes LOOP
        SELECT sm.seed_num INTO v_cand
        FROM _seed_map sm
        WHERE sm.rank = 1 AND NOT (sm.seed_num = ANY(v_bye_from))
        ORDER BY ((SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = sm.group_id) < 3),
                 CASE WHEN (SELECT ceil(tt.idx::float / 2) <= v_num_first_round / 2
                            FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt
                            WHERE tt.val = sm.seed_num) THEN v_up_b ELSE v_lo_b END,
                 sm.seed_num
        LIMIT 1;
        SELECT ceil(tt.idx::float / 2) <= v_num_first_round / 2 INTO v_is_up
        FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt WHERE tt.val = v_cand;
        IF v_is_up THEN v_up_b := v_up_b + 1; ELSE v_lo_b := v_lo_b + 1; END IF;
        v_bye_from  := array_append(v_bye_from, v_cand);
        v_bye_seeds := array_append(v_bye_seeds, v_bracket_size + 1 - v_cand);
      END LOOP;
    END IF;

    -- 2위팀: 같은 조 1위와 반대 절반 배치
    v_upper_avail := ARRAY[]::int[];
    v_lower_avail := ARRAY[]::int[];

    FOR v_i IN (v_rank1_count + 1)..(CASE WHEN v_rank_mode THEN v_bracket_size ELSE v_rank1_count + v_rank2_count END) LOOP
      CONTINUE WHEN v_rank_mode AND v_i = ANY(v_bye_seeds);   -- [045]
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

    -- [044] 시드가 있으면 2위 자리도 고정: 1위 시드 순서대로, 반대쪽 절반의 가장 뒤 번호 자리부터
    --   → 1조 2위는 2조 1위와, 2조 2위는 1조 1위와 (이웃 조 교차). 같은 조는 결승에서만 다시 만남.
    --   시드가 없으면 기존대로 랜덤.
    FOR v_adv2 IN
      SELECT a.* FROM _adv a WHERE a.rank = 2
      ORDER BY CASE WHEN v_has_seed THEN (SELECT sm.seed_num FROM _seed_map sm WHERE sm.group_id = a.group_id AND sm.rank = 1) END, random()
    LOOP
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
          IF v_has_seed THEN   -- [044] 가장 뒤 번호(가장 강한 1위와 만나는 자리)부터
            v_target_seed := v_lower_avail[array_length(v_lower_avail,1)];
            v_lower_avail := v_lower_avail[1:array_length(v_lower_avail,1)-1];
          ELSE
            v_target_seed := v_lower_avail[1];
            v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
          END IF;
        ELSIF v_rank_mode THEN
          -- [045] 반대쪽 절반이 다 찼으면 같은 절반에서 같은 조 1위와 가장 늦게 만나는 자리 (같으면 뒤 번호)
          v_best := NULL; v_best_meet := -1;
          FOREACH v_cand IN ARRAY v_upper_avail LOOP
            SELECT tt.idx INTO v_q FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt WHERE tt.val = v_cand;
            v_p := v_a1_pos - 1; v_q := v_q - 1; v_meet := 0;
            WHILE v_p <> v_q LOOP v_p := v_p / 2; v_q := v_q / 2; v_meet := v_meet + 1; END LOOP;
            IF v_meet > v_best_meet OR (v_meet = v_best_meet AND v_cand > v_best) THEN v_best := v_cand; v_best_meet := v_meet; END IF;
          END LOOP;
          v_target_seed := v_best;
          v_upper_avail := array_remove(v_upper_avail, v_best);
        ELSE
          IF v_has_seed THEN   -- [044] 가장 뒤 번호(가장 강한 1위와 만나는 자리)부터
            v_target_seed := v_upper_avail[array_length(v_upper_avail,1)];
            v_upper_avail := v_upper_avail[1:array_length(v_upper_avail,1)-1];
          ELSE
            v_target_seed := v_upper_avail[1];
            v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
          END IF;
        END IF;
      ELSE
        IF array_length(v_upper_avail, 1) > 0 THEN
          IF v_has_seed THEN   -- [044] 가장 뒤 번호(가장 강한 1위와 만나는 자리)부터
            v_target_seed := v_upper_avail[array_length(v_upper_avail,1)];
            v_upper_avail := v_upper_avail[1:array_length(v_upper_avail,1)-1];
          ELSE
            v_target_seed := v_upper_avail[1];
            v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
          END IF;
        ELSIF v_rank_mode THEN
          -- [045] 반대쪽 절반이 다 찼으면 같은 절반에서 같은 조 1위와 가장 늦게 만나는 자리 (같으면 뒤 번호)
          v_best := NULL; v_best_meet := -1;
          FOREACH v_cand IN ARRAY v_lower_avail LOOP
            SELECT tt.idx INTO v_q FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt WHERE tt.val = v_cand;
            v_p := v_a1_pos - 1; v_q := v_q - 1; v_meet := 0;
            WHILE v_p <> v_q LOOP v_p := v_p / 2; v_q := v_q / 2; v_meet := v_meet + 1; END LOOP;
            IF v_meet > v_best_meet OR (v_meet = v_best_meet AND v_cand > v_best) THEN v_best := v_cand; v_best_meet := v_meet; END IF;
          END LOOP;
          v_target_seed := v_best;
          v_lower_avail := array_remove(v_lower_avail, v_best);
        ELSE
          IF v_has_seed THEN   -- [044] 가장 뒤 번호(가장 강한 1위와 만나는 자리)부터
            v_target_seed := v_lower_avail[array_length(v_lower_avail,1)];
            v_lower_avail := v_lower_avail[1:array_length(v_lower_avail,1)-1];
          ELSE
            v_target_seed := v_lower_avail[1];
            v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
          END IF;
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

      IF (NOT v_rank_mode AND v_seed_num <= v_total_adv)
         OR (v_rank_mode AND EXISTS (SELECT 1 FROM _seed_map sm WHERE sm.seed_num = v_seed_num)) THEN   -- [045]
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
        -- [045] 전체 랭킹제: 아래쪽 절반은 경기 순서를 뒤집어 2번 시드(2조 1위)가 대진표 맨 아래 경기에 온다.
        --   이웃한 두 경기가 다음 라운드에서 만나는 구조는 그대로라 누가 언제 만나는지는 바뀌지 않는다.
        v_tgt := v_i;
        IF v_rank_mode AND v_i > v_num_first_round / 2 THEN
          v_tgt := v_num_first_round + v_num_first_round / 2 + 1 - v_i;
        END IF;

        IF (NOT v_rank_mode AND v_seed_num <= v_total_adv)
           OR (v_rank_mode AND EXISTS (SELECT 1 FROM _seed_map sm WHERE sm.seed_num = v_seed_num)) THEN   -- [045]
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
        WHERE id = v_fm[v_tgt];
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

select '045 applied' as result;
