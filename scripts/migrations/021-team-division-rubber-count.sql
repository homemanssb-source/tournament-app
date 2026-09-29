-- ============================================================
-- 021: 부서별 복식 수(3/5복식) + 앱A 선수 ID (2026-09-29)
--
-- 배경: 10/24 대회는 한 대회 안에서 1부 5복식, 나머지 3복식.
--   앱A는 event_divisions.team_match_type(부서 값 우선)을 지원하지만 앱B는 대회 값 하나만 썼고,
--   조편성/풀리그 생성 때마다 대회 값을 덮어썼다.
--
-- 수정:
--   divisions.team_match_type        — 부서 경기방식 (NULL 이면 대회 값)
--   club_members.app_a_member_id     — 앱A 선수 ID (동기화 시 선수 행을 지우지 않고 맞춰 갱신)
--   fn_team_rubber_count(event, div) — 부서 값 → 대회 값 → team_rubber_count → 3
--   rpc_create_team_groups / rpc_generate_full_league(2-arg) / rpc_generate_team_tournament_v2
--     → 부서 기준 복식 수 사용, 대회 값 덮어쓰기 제거
--   (러버 생성 rpc_create_rubbers_for_event_ties 는 이미 ties.rubber_count 사용 — 변경 없음)
--
-- 기존 데이터 변경 없음 (컬럼 추가만). 라이브 정의(2026-09-29 조회, v2 는 020) 기준.
-- ============================================================

ALTER TABLE public.divisions ADD COLUMN IF NOT EXISTS team_match_type text;
ALTER TABLE public.club_members ADD COLUMN IF NOT EXISTS app_a_member_id text;


CREATE OR REPLACE FUNCTION public.fn_team_rubber_count(p_event_id uuid, p_division_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE coalesce(
                (SELECT d.team_match_type FROM divisions d WHERE d.id = p_division_id),
                e.team_match_type)
           WHEN '5_doubles' THEN 5
           WHEN '3_doubles' THEN 3
           ELSE coalesce(e.team_rubber_count, 3)
         END
  FROM events e WHERE e.id = p_event_id;
$function$;


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
    'group_sizes', v_group_sizes, 'total_clubs', v_total, 'rubber_count', v_rubber_count
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;


CREATE OR REPLACE FUNCTION public.rpc_generate_full_league(p_event_id uuid, p_division_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_clubs UUID[]; v_count INT; v_rubber_count INT; i INT; j INT; v_tie_order INT := 0;
BEGIN
  SELECT array_agg(id ORDER BY seed_number NULLS LAST, created_at) INTO v_clubs
  FROM clubs WHERE event_id = p_event_id AND (p_division_id IS NULL OR division_id = p_division_id);

  v_count := coalesce(array_length(v_clubs,1),0);
  IF v_count < 2 THEN RETURN json_build_object('success',false,'error','최소 2팀 이상 필요합니다.'); END IF;
  IF v_count > 5 THEN RETURN json_build_object('success',false,'error','풀리그는 5팀 이하에서만 가능합니다.'); END IF;

  -- ✅ 021: 부서 경기방식 우선, 대회 값 덮어쓰기 제거
  v_rubber_count := coalesce(fn_team_rubber_count(p_event_id, p_division_id), 3);

  DELETE FROM tie_rubbers WHERE tie_id IN (SELECT id FROM ties WHERE event_id=p_event_id AND (p_division_id IS NULL OR division_id=p_division_id) AND round='full_league');
  DELETE FROM ties WHERE event_id=p_event_id AND (p_division_id IS NULL OR division_id=p_division_id) AND round='full_league';
  DELETE FROM team_standings WHERE event_id=p_event_id AND group_id IS NULL AND club_id IN (SELECT id FROM clubs WHERE event_id=p_event_id AND (p_division_id IS NULL OR division_id=p_division_id));

  FOR i IN 1..v_count LOOP FOR j IN (i+1)..v_count LOOP
    v_tie_order := v_tie_order+1;
    INSERT INTO ties (event_id, division_id, round, tie_order, club_a_id, club_b_id, rubber_count, status)
    VALUES (p_event_id, p_division_id, 'full_league', v_tie_order, v_clubs[i], v_clubs[j], v_rubber_count, 'pending');
  END LOOP; END LOOP;

  PERFORM rpc_create_rubbers_for_event_ties(p_event_id, 'full_league');
  FOR i IN 1..v_count LOOP INSERT INTO team_standings (event_id,group_id,club_id) VALUES (p_event_id,NULL,v_clubs[i]); END LOOP;
  UPDATE events SET team_format='full_league' WHERE id=p_event_id;

  RETURN json_build_object('success',true,'tie_count',v_tie_order,'club_count',v_count,'rubber_count',v_rubber_count);
END;
$function$;


-- ── 본선 대진 생성 (020 정의 + 021 부서별 복식 수) ──
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
