-- ============================================================
-- 018: TBD 본선 슬롯 채움의 두 가지 구멍 (2026-09-19 H.B컵 여자 베테랑부에서 발견)
--
-- (1) "N조 1위" 슬롯이 안 채워짐
--     조 마지막 경기가 끝나면 trg_auto_start_next_match 가 먼저 돌아 같은 코트의 다음 경기를
--     IN_PROGRESS 로 바꾼다. 그 경기가 바로 이 조를 기다리던 TBD 본선 경기면
--     rpc_fill_tournament_slots 의 status = 'PENDING' 필터에 걸려 건너뛰었다.
--     → PENDING + IN_PROGRESS 모두 대상 (team_x_id IS NULL 가드가 이미 채운 슬롯을 보호).
--
-- (2) 슬롯을 채운 뒤 조별 점수를 정정해도 본선 자리가 그대로
--     채움은 조 완료 시 1회뿐이고 라벨을 지워버려 어느 슬롯이 "1조 1위"였는지 알 수 없었다.
--     → matches.qualifier_src_a/b 에 출처를 보존하고,
--       fn_reseat_group_qualifiers 가 (승수 → 승자 기준 게임 득실)로 다시 계산해 자리를 바로잡는다.
--       바뀌어야 할 자리가 하나라도 점수 입력/종료된 경기면 아무것도 바꾸지 않는다(전부 or 전무).
--       결과는 audit_log 에 reseat_applied / reseat_skipped 로 남긴다.
--       조별 경기의 점수·승자가 바뀔 때 기존 트리거(trigger_fill_tournament_slots)가 호출한다.
--       재배정 실패는 점수 저장을 절대 막지 않는다(EXCEPTION 흡수).
--
-- 한계: 조가 끝난 뒤 생성해 팀이 바로 들어간 슬롯은 출처가 없어 재배정 대상이 아니다
--       (rpc_generate_tournament 는 이번에 건드리지 않음).
-- 라이브 정의 기준(2026-09-20 덤프)으로 패치. 기존 데이터 변경 없음(컬럼 추가만).
-- 실행일: 2026-09-20
-- ============================================================

ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS qualifier_src_a text;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS qualifier_src_b text;

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
      AND m.status      IN ('PENDING', 'IN_PROGRESS')  -- 018: 같은 코트 자동 시작된 경기도 채움
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
        SET team_a_id = v_team_id_a, qualifier_src_a = qualifier_label_a, qualifier_label_a = NULL
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
        SET team_b_id = v_team_id_b, qualifier_src_b = qualifier_label_b, qualifier_label_b = NULL
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
$function$;

REVOKE ALL ON FUNCTION public.fn_reseat_group_qualifiers(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reseat_group_qualifiers(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_fill_tournament_slots()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NEW.stage = 'GROUP'
     AND NEW.status = 'FINISHED'
     AND NEW.group_id IS NOT NULL
  THEN
    IF (OLD.status IS DISTINCT FROM 'FINISHED') THEN
      IF EXISTS (
        SELECT 1 FROM matches
        WHERE event_id    = NEW.event_id
          AND division_id = NEW.division_id
          AND stage       = 'FINALS'
          AND (qualifier_label_a IS NOT NULL OR qualifier_label_b IS NOT NULL)
      ) THEN
        SELECT rpc_fill_tournament_slots(NEW.event_id, NEW.group_id)
        INTO v_result;
      END IF;
    END IF;

    -- 018: 조 결과(점수/승자)가 바뀌면 이미 채운 본선 자리를 다시 맞춘다. 실패해도 점수 저장은 막지 않는다.
    IF (OLD.status IS DISTINCT FROM 'FINISHED')
       OR NEW.score IS DISTINCT FROM OLD.score
       OR NEW.winner_team_id IS DISTINCT FROM OLD.winner_team_id
    THEN
      BEGIN
        PERFORM fn_reseat_group_qualifiers(NEW.event_id, NEW.group_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'fn_reseat_group_qualifiers failed: %', SQLERRM;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

select '018 applied' as result;
