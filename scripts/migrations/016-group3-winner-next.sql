-- ============================================================
-- 016: 3팀 조 "승자 우선" 경기 순서
--   규칙: 1번 vs 2번 먼저 → 이긴 팀이 곧바로(같은 코트) 3번과 → 마지막에 진 팀이 3번과
--   4팀 이상 조는 기존 방식 그대로.
--
--   (1) group_members.seq : 조 내 순번(1·2·3…)을 처음으로 저장
--   (2) rpc_generate_groups : 조편성 시 seq 기록 (실DB 버전에 INSERT 한 줄만 패치)
--   (3) rpc_generate_group_matches : seq 순으로 짝 생성 → 1v2, 1v3, 2v3
--   (4) 트리거 trg_a0_group3_winner_next : 3팀 조의 첫 경기가 끝나면 남은 두 경기 중
--       승자 경기를 앞으로(slot·court_order 교체). 이름이 trg_auto_start_next_match보다
--       알파벳상 앞이라 "다음 경기 자동 시작"보다 먼저 실행된다.
--       어떤 오류가 나도 점수 저장은 막지 않는다(EXCEPTION 삼킴).
-- 멱등 — 여러 번 실행해도 안전
-- ============================================================

alter table group_members add column if not exists seq smallint;

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
    'division', v_div_name
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_generate_group_matches(p_event_id uuid, p_division_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_group RECORD;
  v_members uuid[];
  v_match_count int := 0;
  v_match_num text;
  v_div_name text;
  v_slot int;
BEGIN
  SELECT name INTO v_div_name FROM divisions WHERE id = p_division_id;

  -- 현재 최대 슬롯
  SELECT COALESCE(MAX(slot), 0) INTO v_slot FROM matches WHERE event_id = p_event_id;

  -- 이미 존재 체크
  IF EXISTS (
    SELECT 1 FROM matches
    WHERE event_id = p_event_id AND division_id = p_division_id AND stage = 'GROUP'
  ) THEN
    RAISE EXCEPTION '이미 해당 부서의 조 경기가 존재합니다.';
  END IF;

  -- 조별 라운드 로빈 경기 생성
  FOR v_group IN
    SELECT g.id, g.group_label FROM groups g
    WHERE g.event_id = p_event_id AND g.division_id = p_division_id
    ORDER BY g.group_num
  LOOP
    -- [016] 조 내 순번(seq) 순 → 1v2, 1v3, 2v3 … (seq 없는 옛 조편성은 기존처럼 team_id 순)
    SELECT array_agg(gm.team_id ORDER BY gm.seq NULLS LAST, gm.team_id) INTO v_members
    FROM group_members gm WHERE gm.group_id = v_group.id;

    IF v_members IS NULL OR array_length(v_members, 1) < 2 THEN
      CONTINUE;
    END IF;

    -- 라운드 로빈: 모든 팀 쌍
    FOR i IN 1..array_length(v_members, 1) LOOP
      FOR j IN (i+1)..array_length(v_members, 1) LOOP
        v_slot := v_slot + 1;
        v_match_num := next_match_num(p_event_id);

        INSERT INTO matches(
          match_num, event_id, division_id, division_name,
          stage, round, slot, group_id,
          team_a_id, team_b_id, status
        ) VALUES (
          v_match_num, p_event_id, p_division_id, v_div_name,
          'GROUP', '조별', v_slot, v_group.id,
          v_members[i], v_members[j], 'PENDING'
        );

        v_match_count := v_match_count + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM log_audit(p_event_id, 'generate_group_matches', 'operator',
    COALESCE(auth.uid()::text, 'system'), 'matches', p_division_id,
    jsonb_build_object('matches_created', v_match_count));

  RETURN jsonb_build_object(
    'success', true,
    'matches_created', v_match_count,
    'division', v_div_name
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_group3_winner_next()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_cnt   int;
  v_n     int;
  v_loser uuid;
  v_w     matches%ROWTYPE;   -- 승자가 포함된 남은 경기
  v_l     matches%ROWTYPE;   -- 패자가 포함된 남은 경기
BEGIN
  -- FINISHED로 바뀌는 조별 경기만
  IF NEW.status <> 'FINISHED' OR OLD.status = 'FINISHED' THEN RETURN NEW; END IF;
  IF NEW.stage <> 'GROUP' OR NEW.group_id IS NULL OR NEW.winner_team_id IS NULL THEN RETURN NEW; END IF;

  BEGIN
    -- 3팀 조만 (4팀 이상은 기존 방식)
    SELECT count(*) INTO v_cnt FROM group_members WHERE group_id = NEW.group_id;
    IF v_cnt <> 3 THEN RETURN NEW; END IF;

    -- 남은 경기가 정확히 2개(=이 경기가 조의 첫 경기)일 때만
    SELECT count(*) INTO v_n FROM matches
     WHERE group_id = NEW.group_id AND stage = 'GROUP' AND id <> NEW.id AND status <> 'FINISHED';
    IF v_n <> 2 THEN RETURN NEW; END IF;

    v_loser := CASE WHEN NEW.winner_team_id = NEW.team_a_id THEN NEW.team_b_id ELSE NEW.team_a_id END;

    -- 둘 다 아직 시작 전(PENDING)이어야 함 — 이미 시작된 경기는 건드리지 않는다
    SELECT * INTO v_w FROM matches
     WHERE group_id = NEW.group_id AND stage = 'GROUP' AND id <> NEW.id
       AND status = 'PENDING' AND (score IS NULL OR score <> 'BYE')
       AND (team_a_id = NEW.winner_team_id OR team_b_id = NEW.winner_team_id)
     LIMIT 1;
    SELECT * INTO v_l FROM matches
     WHERE group_id = NEW.group_id AND stage = 'GROUP' AND id <> NEW.id
       AND status = 'PENDING' AND (score IS NULL OR score <> 'BYE')
       AND (team_a_id = v_loser OR team_b_id = v_loser)
     LIMIT 1;
    IF v_w.id IS NULL OR v_l.id IS NULL OR v_w.id = v_l.id THEN RETURN NEW; END IF;

    -- 승자 경기가 뒤에 있으면 앞으로 (slot: 자동배정 순서)
    IF v_w.slot IS NOT NULL AND v_l.slot IS NOT NULL AND v_w.slot > v_l.slot THEN
      UPDATE matches SET slot = CASE WHEN id = v_w.id THEN v_l.slot ELSE v_w.slot END
       WHERE id IN (v_w.id, v_l.id);
    END IF;
    -- 같은 코트에 이미 배정돼 있으면 코트 순서도 교체
    IF v_w.court IS NOT NULL AND v_w.court = v_l.court
       AND v_w.court_order IS NOT NULL AND v_l.court_order IS NOT NULL
       AND v_w.court_order > v_l.court_order THEN
      UPDATE matches SET court_order = CASE WHEN id = v_w.id THEN v_l.court_order ELSE v_w.court_order END
       WHERE id IN (v_w.id, v_l.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- 어떤 오류도 점수 저장을 막지 않는다
  END;

  RETURN NEW;
END;
$function$;

drop trigger if exists trg_a0_group3_winner_next on matches;
create trigger trg_a0_group3_winner_next
  after update of status on matches
  for each row execute function fn_group3_winner_next();

-- 확인
select 'seq_col' as obj, count(*)::text as n from information_schema.columns where table_name = 'group_members' and column_name = 'seq'
union all select 'trigger', count(*)::text from pg_trigger where tgname = 'trg_a0_group3_winner_next'
union all select 'fn', count(*)::text from pg_proc where proname = 'fn_group3_winner_next';
