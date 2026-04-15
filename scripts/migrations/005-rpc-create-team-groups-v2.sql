-- ============================================================
-- 005: rpc_create_team_groups v2 — 1팀 조 로직을 개인전과 동일화
--
-- 배경:
--   기존 v2는 remainder=1, tpg=2일 때 [2,1] 생성 → 1팀 조 발생
--   개인전 rpc_generate_groups는 IF-ELIF 체인으로 케이스별 처리 완벽
--
-- 해결:
--   단체전 remainder=1 분기를 개인전과 완전 동일한 if-elif로 교체
--
-- 검증 케이스:
--   - 3팀 tpg=2 → [3] ✓
--   - 5팀 tpg=2 → [2, 3] ✓
--   - 9팀 tpg=4 → [4, 3, 2] ✓
--   - 5팀 tpg=4 → [3, 2] ✓
--
-- 실행일: 2026-04-15
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_create_team_groups(
  p_event_id    uuid,
  p_group_count integer DEFAULT 2,
  p_group_size  integer DEFAULT 4,
  p_division_id uuid    DEFAULT NULL::uuid
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_all_clubs    uuid[];
  v_rubber_count int;
  v_group_ids    uuid[];
  v_gid          uuid;
  v_group_sizes  int[];
  v_gs           int;
  v_idx          int := 1;
  v_group_num    int := 0;
  v_group_clubs  uuid[];
  v_gc           int;
  v_to           int;
  v_total        int;
  v_tpg          int;
  v_remainder    int;
  v_full_groups  int;
  i              int;
  j              int;
  a              int;
  b              int;
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

  SELECT CASE WHEN e.team_match_type = '5_doubles' THEN 5 ELSE 3 END
  INTO v_rubber_count FROM events e WHERE e.id = p_event_id;
  IF v_rubber_count IS NULL THEN v_rubber_count := 3; END IF;
  UPDATE events SET team_rubber_count = v_rubber_count WHERE id = p_event_id;

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

  v_remainder   := v_total % v_tpg;
  v_full_groups := v_total / v_tpg;
  v_group_sizes := ARRAY[]::int[];

  IF v_remainder = 0 THEN
    FOR i IN 1..v_full_groups LOOP
      v_group_sizes := array_append(v_group_sizes, v_tpg);
    END LOOP;
  ELSIF v_remainder = 1 THEN
    -- ✅ 개인전(rpc_generate_groups)과 완전 동일한 로직
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
