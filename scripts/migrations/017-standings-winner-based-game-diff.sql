-- ============================================================
-- 017: 조별 순위 게임 득실을 "승자 기준"으로 계산 (본선 진출 로직)
--
-- 배경:
--   점수는 승자 먼저("6:0")로 저장된다 (rpc_pin_submit_score 가 재정렬, 운영자도 승자 먼저 입력).
--   그런데 rpc_fill_tournament_slots 는 score 를 team_a:team_b 위치로 파싱해
--   팀B 승리 경기마다 득실이 뒤집혔고, rpc_generate_tournament 는 득실을 아예 보지 않고
--   승수 동률을 random() 으로 갈랐다. 3팀 조 1승1패 동률에서 엉뚱한 팀이 본선에 올라감.
--
-- 수정:
--   fn_group_game_diff(event, division): 승자 = max, 패자 = min 으로 게임 득실 계산 (두 저장 방식 모두 안전)
--   rpc_generate_tournament (두 오버로드): ORDER BY 승수 DESC, 득실 DESC, random()
--   rpc_fill_tournament_slots: 위치 파싱 블록 2개 → fn_group_game_diff 조인
--   화면(조편성 순위표)과 동일한 기준: 승수 → 게임 득실.
--
-- 라이브 정의 기준(2026-09-18 덤프)으로 패치. 데이터 변경 없음.
-- 실행일: 2026-09-18
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_group_game_diff(p_event_id uuid, p_division_id uuid)
RETURNS TABLE(team_id uuid, game_diff int)
LANGUAGE sql STABLE
AS $function$
  WITH s AS (
    SELECT m.team_a_id, m.team_b_id, m.winner_team_id,
           split_part(m.score, ':', 1)::int AS p1,
           split_part(m.score, ':', 2)::int AS p2
    FROM matches m
    WHERE m.event_id = p_event_id
      AND m.division_id = p_division_id
      AND m.stage = 'GROUP'
      AND m.score ~ '^[0-9]+:[0-9]+$'
  ),
  g AS (
    SELECT team_a_id AS team_id,
      CASE WHEN winner_team_id = team_a_id THEN GREATEST(p1, p2)
           WHEN winner_team_id = team_b_id THEN LEAST(p1, p2)
           ELSE p1 END AS games_for,
      CASE WHEN winner_team_id = team_a_id THEN LEAST(p1, p2)
           WHEN winner_team_id = team_b_id THEN GREATEST(p1, p2)
           ELSE p2 END AS games_against
    FROM s WHERE team_a_id IS NOT NULL
    UNION ALL
    SELECT team_b_id AS team_id,
      CASE WHEN winner_team_id = team_b_id THEN GREATEST(p1, p2)
           WHEN winner_team_id = team_a_id THEN LEAST(p1, p2)
           ELSE p2 END,
      CASE WHEN winner_team_id = team_b_id THEN LEAST(p1, p2)
           WHEN winner_team_id = team_a_id THEN GREATEST(p1, p2)
           ELSE p1 END
    FROM s WHERE team_b_id IS NOT NULL
  )
  SELECT team_id, (SUM(games_for) - SUM(games_against))::int AS game_diff
  FROM g GROUP BY team_id
$function$;

GRANT EXECUTE ON FUNCTION public.fn_group_game_diff(uuid, uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_generate_tournament(p_event_id uuid, p_division_id uuid, p_advance_per_group integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_div_name text;
  v_advance_count int;
  v_total_adv int;
  v_bracket_size int;
  v_byes int;
  v_slot int;
  v_size int;
  v_round_name text;
  v_match_id uuid;
  v_match_num text;
  v_match_count int := 0;
  v_bye_applied int := 0;
  v_r_idx int;
  v_m_idx int;
  v_next_match_id uuid;
  v_next_slot text;
  v_first_round_name text;
  v_curr RECORD;
  v_bye_winner uuid;
  v_fm uuid[];
  v_num_first_round int;
  v_i int;
BEGIN
  SELECT name INTO v_div_name FROM divisions WHERE id = p_division_id;
  IF v_div_name IS NULL THEN RAISE EXCEPTION '부서를 찾을 수 없습니다.'; END IF;

  IF EXISTS (
    SELECT 1 FROM matches
    WHERE event_id = p_event_id AND division_id = p_division_id AND stage = 'FINALS'
  ) THEN
    RAISE EXCEPTION '이미 해당 부서의 본선이 존재합니다.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM matches
    WHERE event_id = p_event_id AND division_id = p_division_id
      AND stage = 'GROUP' AND status != 'FINISHED'
  ) THEN
    RAISE EXCEPTION '예선이 완료되지 않은 경기가 있습니다.';
  END IF;

  v_advance_count := GREATEST(1, COALESCE(p_advance_per_group, 2));

  CREATE TEMP TABLE _adv (
    team_id uuid, group_id uuid, group_num int, wins int, rank int
  ) ON COMMIT DROP;

  INSERT INTO _adv (team_id, group_id, group_num, wins, rank)
  SELECT sub.team_id, sub.group_id, sub.group_num, sub.wins,
    ROW_NUMBER() OVER (PARTITION BY sub.group_id ORDER BY sub.wins DESC, COALESCE((SELECT gd.game_diff FROM fn_group_game_diff(p_event_id, p_division_id) gd WHERE gd.team_id = sub.team_id), 0) DESC, random())
  FROM (
    SELECT gm.team_id, gm.group_id, g.group_num, COALESCE(w.wins, 0) AS wins
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

  v_bracket_size := 1;
  WHILE v_bracket_size < v_total_adv LOOP
    v_bracket_size := v_bracket_size * 2;
  END LOOP;
  v_byes            := v_bracket_size - v_total_adv;
  v_num_first_round := v_bracket_size / 2;

  SELECT COALESCE(MAX(slot), 0) INTO v_slot FROM matches WHERE event_id = p_event_id;

  CREATE TEMP TABLE _round_matches (
    round_idx int, match_idx int, match_id uuid, round_name text
  ) ON COMMIT DROP;

  v_size  := v_bracket_size;
  v_r_idx := 0;
  WHILE v_size >= 2 LOOP
    v_round_name := size_to_round(v_size);
    v_m_idx := 0;
    FOR i IN 1..(v_size / 2) LOOP
      v_slot      := v_slot + 1;
      v_match_num := next_match_num(p_event_id);
      v_m_idx     := v_m_idx + 1;
      INSERT INTO matches(match_num, event_id, division_id, division_name, stage, round, slot, status)
      VALUES (v_match_num, p_event_id, p_division_id, v_div_name, 'FINALS', v_round_name, v_slot, 'PENDING')
      RETURNING id INTO v_match_id;
      INSERT INTO _round_matches VALUES (v_r_idx, v_m_idx, v_match_id, v_round_name);
      v_match_count := v_match_count + 1;
    END LOOP;
    v_size  := v_size / 2;
    v_r_idx := v_r_idx + 1;
  END LOOP;

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
  -- ✅ 설계 원칙 (브래킷 크기 무관하게 동일 적용):
  --   1위팀: seed 1 ~ rank1_count (랜덤)
  --   2위팀: seed rank1_count+1 ~ rank1_count+rank2_count
  --          같은 조 1위와 브래킷 반대 절반에 배치
  --          (상반부 1위 → 하반부 2위, 하반부 1위 → 상반부 2위)
  --   bye:   seed total_adv+1 ~ bracket_size
  --          → v_bp에서 bye 자리의 반대편 = 1위팀 낮은 seed → 1위팀 부전승
  --   3위+:  남은 seed 순서대로
  -- ============================================================
  DECLARE
    v_bp            int[];
    v_seed_team     uuid;
    v_seed_num      int;
    v_rank1_count   int;
    v_rank2_count   int;
    v_a1_seed       int;
    v_a1_pos        int;
    v_a1_half       int;
    v_target_seed   int;
    v_adv2          RECORD;
    v_upper_avail   int[];
    v_lower_avail   int[];
    v_pos           int;
  BEGIN
    -- 표준 시드 브래킷 배열 생성 (재귀)
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
      seed_num int, team_id uuid
    ) ON COMMIT DROP;

    -- ✅ 1위팀: seed 1 ~ rank1_count (랜덤)
    -- bye 슬롯(seed total_adv+1 ~ bracket_size)의 v_bp 반대편이
    -- seed 낮은 번호 1위팀 → 1위팀이 bye 받아 부전승
    INSERT INTO _seed_map (seed_num, team_id)
    SELECT
      ROW_NUMBER() OVER (ORDER BY random()) AS seed_num,
      team_id
    FROM _adv
    WHERE rank = 1;

    -- ✅ 2위팀: 같은 조 1위와 다른 절반(상반부/하반부)에 배치
    -- 상반부 = v_bp 배열 앞쪽 절반 (경기 1 ~ num_first_round/2)
    -- 하반부 = v_bp 배열 뒤쪽 절반 (경기 num_first_round/2+1 ~ num_first_round)
    -- 2위팀 가용 seed: rank1_count+1 ~ rank1_count+rank2_count

    v_upper_avail := ARRAY[]::int[];
    v_lower_avail := ARRAY[]::int[];

    FOR v_i IN (v_rank1_count + 1)..(v_rank1_count + v_rank2_count) LOOP
      -- v_bp에서 seed v_i의 위치 (1-indexed)
      SELECT t.idx INTO v_pos
      FROM (
        SELECT unnest(v_bp) AS val,
               generate_series(1, array_length(v_bp, 1)) AS idx
      ) t
      WHERE t.val = v_i;

      -- 경기 번호 = ceil(pos / 2), 상반부 = 경기 1 ~ num_first_round/2
      IF ceil(v_pos::float / 2) <= v_num_first_round / 2 THEN
        v_upper_avail := array_append(v_upper_avail, v_i);
      ELSE
        v_lower_avail := array_append(v_lower_avail, v_i);
      END IF;
    END LOOP;

    -- 2위팀 배치: 같은 조 1위와 반대 절반
    FOR v_adv2 IN SELECT * FROM _adv WHERE rank = 2 ORDER BY random() LOOP
      -- 같은 조 1위 seed 조회
      SELECT sm.seed_num INTO v_a1_seed
      FROM _seed_map sm
      JOIN _adv a1 ON a1.team_id = sm.team_id
      WHERE a1.group_id = v_adv2.group_id AND a1.rank = 1;

      -- 1위 seed의 v_bp 위치로 절반 판단
      SELECT t.idx INTO v_a1_pos
      FROM (
        SELECT unnest(v_bp) AS val,
               generate_series(1, array_length(v_bp, 1)) AS idx
      ) t
      WHERE t.val = v_a1_seed;

      v_a1_half := CASE
        WHEN ceil(v_a1_pos::float / 2) <= v_num_first_round / 2 THEN 0  -- 상반부
        ELSE 1  -- 하반부
      END;

      -- 반대 절반에서 seed 배정 (없으면 같은 절반에 배정)
      IF v_a1_half = 0 THEN
        -- 1위 상반부 → 2위 하반부
        IF array_length(v_lower_avail, 1) > 0 THEN
          v_target_seed := v_lower_avail[1];
          v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
        ELSE
          v_target_seed := v_upper_avail[1];
          v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
        END IF;
      ELSE
        -- 1위 하반부 → 2위 상반부
        IF array_length(v_upper_avail, 1) > 0 THEN
          v_target_seed := v_upper_avail[1];
          v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
        ELSE
          v_target_seed := v_lower_avail[1];
          v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
        END IF;
      END IF;

      INSERT INTO _seed_map (seed_num, team_id) VALUES (v_target_seed, v_adv2.team_id);
    END LOOP;

    -- 3위 이상: 남은 seed 순서대로
    INSERT INTO _seed_map (seed_num, team_id)
    SELECT s.seed_num, a.team_id
    FROM _adv a
    CROSS JOIN LATERAL (
      SELECT gs AS seed_num
      FROM generate_series(1, v_bracket_size) gs
      WHERE gs NOT IN (SELECT seed_num FROM _seed_map)
      ORDER BY gs
      LIMIT 1
    ) s
    WHERE a.rank >= 3
      AND a.team_id NOT IN (SELECT team_id FROM _seed_map)
    ORDER BY a.rank, a.group_num;

    -- 1라운드 슬롯에 팀 배치
    FOR v_i IN 1..v_num_first_round LOOP
      -- A슬롯
      v_seed_num := v_bp[(v_i - 1) * 2 + 1];
      IF v_seed_num <= v_total_adv THEN
        SELECT team_id INTO v_seed_team FROM _seed_map WHERE seed_num = v_seed_num;
        UPDATE matches SET team_a_id = v_seed_team WHERE id = v_fm[v_i];
      END IF;
      -- B슬롯
      v_seed_num := v_bp[(v_i - 1) * 2 + 2];
      IF v_seed_num <= v_total_adv THEN
        SELECT team_id INTO v_seed_team FROM _seed_map WHERE seed_num = v_seed_num;
        UPDATE matches SET team_b_id = v_seed_team WHERE id = v_fm[v_i];
      END IF;
    END LOOP;
  END;

  -- BYE 처리
  v_first_round_name := size_to_round(v_bracket_size);

  FOR v_curr IN
    SELECT m.id, m.team_a_id, m.team_b_id, bn.next_match_id, bn.next_slot
    FROM matches m
    JOIN bracket_nodes bn ON bn.match_id = m.id
    WHERE m.event_id = p_event_id AND m.division_id = p_division_id
      AND m.stage = 'FINALS' AND m.round = v_first_round_name
      AND (m.team_a_id IS NULL OR m.team_b_id IS NULL)
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
    'success', true,
    'matches_created', v_match_count,
    'bracket_size', v_bracket_size,
    'adv_teams', v_total_adv,
    'byes', v_byes,
    'byes_applied', v_bye_applied,
    'division', v_div_name
  );
END;
$function$
;

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

    -- 1위팀: 완료 조 먼저, 미완료 조는 NULL team_id
    INSERT INTO _seed_map (seed_num, team_id, group_id, group_name, rank)
    SELECT
      ROW_NUMBER() OVER (ORDER BY
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

CREATE OR REPLACE FUNCTION public.rpc_fill_tournament_slots(p_event_id uuid, p_group_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_div_id        uuid;
  v_group_name    text;
  v_group_num     int;
  v_filled        int := 0;
  v_bye_processed int := 0;
  v_curr          RECORD;
  v_cur_match_id  uuid;
  v_winner        uuid;
  v_pending_count int;
  v_unfinished    int;
  v_rank_a        int;
  v_rank_b        int;
  v_team_id_a     uuid;
  v_team_id_b     uuid;
  v_m             RECORD;
  v_bn            RECORD;
  v_bye_rec       RECORD;
  v_filled_ids    uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT division_id, group_label, group_num
  INTO   v_div_id, v_group_name, v_group_num
  FROM   groups WHERE id = p_group_id;

  IF v_div_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '그룹을 찾을 수 없습니다.');
  END IF;

  SELECT COUNT(*) INTO v_unfinished
  FROM matches
  WHERE event_id = p_event_id
    AND group_id = p_group_id
    AND stage    = 'GROUP'
    AND status IS DISTINCT FROM 'FINISHED';

  IF v_unfinished > 0 THEN
    RETURN jsonb_build_object(
      'success',   false,
      'error',     '그룹 경기가 아직 완료되지 않았습니다.',
      'remaining', v_unfinished
    );
  END IF;

  -- ============================================================
  -- qualifier_label 기반 슬롯 채우기
  -- ============================================================
  FOR v_curr IN
    SELECT
      m.id AS match_id, m.team_a_id, m.team_b_id,
      m.qualifier_label_a, m.qualifier_label_b,
      bn.next_match_id, bn.next_slot, m.round
    FROM matches m
    JOIN bracket_nodes bn ON bn.match_id = m.id
    WHERE m.event_id    = p_event_id
      AND m.division_id = v_div_id
      AND m.stage       = 'FINALS'
      AND m.status      = 'PENDING'
      AND (
        m.qualifier_label_a LIKE v_group_name || ' %' OR
        m.qualifier_label_b LIKE v_group_name || ' %'
      )
  LOOP
    v_cur_match_id := v_curr.match_id;
    v_team_id_a    := NULL;
    v_team_id_b    := NULL;

    -- A슬롯 처리
    IF v_curr.qualifier_label_a LIKE v_group_name || ' %'
       AND v_curr.team_a_id IS NULL
    THEN
      v_rank_a := (regexp_match(v_curr.qualifier_label_a, '(\d+)위$'))[1]::int;

      -- 승수 → 게임득실 순으로 순위 결정
      SELECT gm.team_id INTO v_team_id_a
      FROM group_members gm
      LEFT JOIN (
        SELECT winner_team_id AS team_id, COUNT(*) AS wins
        FROM matches
        WHERE event_id      = p_event_id
          AND division_id   = v_div_id
          AND stage         = 'GROUP'
          AND winner_team_id IS NOT NULL
        GROUP BY winner_team_id
      ) w ON gm.team_id = w.team_id
      LEFT JOIN fn_group_game_diff(p_event_id, v_div_id) gd ON gm.team_id = gd.team_id  -- 017: 승자 기준 게임 득실
      WHERE gm.group_id = p_group_id
      ORDER BY
        COALESCE(w.wins, 0)      DESC,  -- 1순위: 승수
        COALESCE(gd.game_diff, 0) DESC  -- 2순위: 게임 득실
      LIMIT 1
      OFFSET v_rank_a - 1;

      IF v_team_id_a IS NOT NULL THEN
        UPDATE matches
        SET team_a_id = v_team_id_a, qualifier_label_a = NULL
        WHERE id = v_cur_match_id;
        v_filled     := v_filled + 1;
        v_filled_ids := array_append(v_filled_ids, v_cur_match_id);
      END IF;
    END IF;

    -- B슬롯 처리
    IF v_curr.qualifier_label_b LIKE v_group_name || ' %'
       AND v_curr.team_b_id IS NULL
    THEN
      v_rank_b := (regexp_match(v_curr.qualifier_label_b, '(\d+)위$'))[1]::int;

      SELECT gm.team_id INTO v_team_id_b
      FROM group_members gm
      LEFT JOIN (
        SELECT winner_team_id AS team_id, COUNT(*) AS wins
        FROM matches
        WHERE event_id      = p_event_id
          AND division_id   = v_div_id
          AND stage         = 'GROUP'
          AND winner_team_id IS NOT NULL
        GROUP BY winner_team_id
      ) w ON gm.team_id = w.team_id
      LEFT JOIN fn_group_game_diff(p_event_id, v_div_id) gd ON gm.team_id = gd.team_id  -- 017: 승자 기준 게임 득실
      WHERE gm.group_id = p_group_id
      ORDER BY
        COALESCE(w.wins, 0)       DESC,
        COALESCE(gd.game_diff, 0) DESC
      LIMIT 1
      OFFSET v_rank_b - 1;

      IF v_team_id_b IS NOT NULL THEN
        UPDATE matches
        SET team_b_id = v_team_id_b, qualifier_label_b = NULL
        WHERE id = v_cur_match_id;
        v_filled := v_filled + 1;
        IF NOT (v_cur_match_id = ANY(v_filled_ids)) THEN
          v_filled_ids := array_append(v_filled_ids, v_cur_match_id);
        END IF;
      END IF;
    END IF;

    -- 슬롯 채운 후 BYE 처리 (해당 슬롯만)
    SELECT m.id, m.team_a_id, m.team_b_id,
           m.qualifier_label_a, m.qualifier_label_b
    INTO v_m FROM matches m WHERE m.id = v_cur_match_id;

    SELECT next_match_id, next_slot INTO v_bn
    FROM bracket_nodes WHERE match_id = v_cur_match_id;

    IF v_m.qualifier_label_a IS NULL AND v_m.qualifier_label_b IS NULL THEN
      IF v_m.team_a_id IS NULL AND v_m.team_b_id IS NULL THEN
        UPDATE matches
        SET status = 'FINISHED', score = 'BYE', ended_at = now()
        WHERE id = v_cur_match_id;
        v_bye_processed := v_bye_processed + 1;

      ELSIF v_m.team_a_id IS NULL OR v_m.team_b_id IS NULL THEN
        v_winner := COALESCE(v_m.team_a_id, v_m.team_b_id);
        UPDATE matches
        SET winner_team_id = v_winner, status = 'FINISHED',
            score = 'BYE', ended_at = now()
        WHERE id = v_cur_match_id;

        IF v_bn.next_match_id IS NOT NULL THEN
          IF v_bn.next_slot = 'A' THEN
            UPDATE matches SET team_a_id = v_winner WHERE id = v_bn.next_match_id;
          ELSE
            UPDATE matches SET team_b_id = v_winner WHERE id = v_bn.next_match_id;
          END IF;
        END IF;
        v_bye_processed := v_bye_processed + 1;
      END IF;
    END IF;

  END LOOP;

  -- 이번에 채운 슬롯 중 BYE인 것만 처리 (전체 division 스캔 금지)
  IF array_length(v_filled_ids, 1) > 0 THEN
    FOR v_bye_rec IN
      SELECT m.id, m.team_a_id, m.team_b_id
      FROM matches m
      WHERE m.id = ANY(v_filled_ids)
        AND m.status = 'PENDING'
        AND m.qualifier_label_a IS NULL
        AND m.qualifier_label_b IS NULL
        AND (
          (m.team_a_id IS NOT NULL AND m.team_b_id IS NULL) OR
          (m.team_b_id IS NOT NULL AND m.team_a_id IS NULL)
        )
    LOOP
      v_winner := COALESCE(v_bye_rec.team_a_id, v_bye_rec.team_b_id);

      UPDATE matches
      SET winner_team_id = v_winner, status = 'FINISHED',
          score = 'BYE', ended_at = now()
      WHERE id = v_bye_rec.id;

      SELECT next_match_id, next_slot INTO v_bn
      FROM bracket_nodes WHERE match_id = v_bye_rec.id;

      IF v_bn.next_match_id IS NOT NULL THEN
        IF v_bn.next_slot = 'A' THEN
          UPDATE matches SET team_a_id = v_winner WHERE id = v_bn.next_match_id;
        ELSE
          UPDATE matches SET team_b_id = v_winner WHERE id = v_bn.next_match_id;
        END IF;
      END IF;
      v_bye_processed := v_bye_processed + 1;
    END LOOP;
  END IF;

  -- 모든 TBD 해소 시 is_tbd_bracket 초기화
  SELECT COUNT(*) INTO v_pending_count
  FROM matches
  WHERE event_id    = p_event_id
    AND division_id = v_div_id
    AND stage       = 'FINALS'
    AND (qualifier_label_a IS NOT NULL OR qualifier_label_b IS NOT NULL);

  IF v_pending_count = 0 THEN
    UPDATE matches SET is_tbd_bracket = false
    WHERE event_id    = p_event_id
      AND division_id = v_div_id
      AND stage       = 'FINALS';
  END IF;

  RETURN jsonb_build_object(
    'success',       true,
    'filled',        v_filled,
    'bye_processed', v_bye_processed,
    'remaining_tbd', v_pending_count
  );
END;
$function$
;

select '017 applied' as result;
