-- ============================================================
-- 034: 부서별 진행방식 + 개인전 풀리그 (2026-10-18)
-- 되돌리기: 034-rollback.sql
--
--   divisions.format          'full_league' | 'group_knockout' | NULL(예전 방식 = 대회 설정 따름)
--   group_members.manual_rank 리그/조 동률일 때 운영자가 정한 순위 (화면에서 직접 저장, op_all 정책)
--   rpc_generate_league       개인전 풀리그: 부서 전체를 한 조('리그')로 묶고 서로 한 번씩 경기 생성
--                             경기 순서 = 원형 대진(라운드마다 모두 한 경기씩) → 한 사람이 연달아 뛰지 않음
--                             경기는 stage='GROUP', round='조별' (코트·PIN·점수·자동시작 기존 그대로)
-- 기존 함수는 바꾸지 않는다 (추가만).
-- ============================================================

ALTER TABLE public.divisions ADD COLUMN IF NOT EXISTS format text;
ALTER TABLE public.divisions DROP CONSTRAINT IF EXISTS divisions_format_chk;
ALTER TABLE public.divisions ADD CONSTRAINT divisions_format_chk
  CHECK (format IS NULL OR format IN ('full_league', 'group_knockout'));

ALTER TABLE public.group_members ADD COLUMN IF NOT EXISTS manual_rank smallint;

CREATE OR REPLACE FUNCTION public.rpc_generate_league(p_event_id uuid, p_division_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_div_name text;
  v_ids uuid[];
  v_n int;
  v_m int;
  v_arr uuid[];
  v_group_id uuid;
  v_slot int;
  v_cnt int := 0;
  v_a uuid;
  v_b uuid;
BEGIN
  IF NOT (is_operator_or_admin() OR auth.role() = 'service_role') THEN
    RAISE EXCEPTION '운영자만 실행할 수 있습니다.';
  END IF;

  SELECT name INTO v_div_name FROM divisions WHERE id = p_division_id AND event_id = p_event_id;
  IF v_div_name IS NULL THEN
    RAISE EXCEPTION '부서를 찾을 수 없습니다.';
  END IF;

  -- 기존 조·경기가 있으면 만들지 않음 (운영자가 '조편성 삭제'로 먼저 지움 — 진행 중 경기 보호)
  IF EXISTS (SELECT 1 FROM matches WHERE event_id = p_event_id AND division_id = p_division_id) THEN
    RAISE EXCEPTION '이 부서에 이미 경기가 있습니다. 기존 조편성을 먼저 삭제하세요.';
  END IF;

  -- 시드 순 → 나머지 랜덤
  SELECT array_agg(id ORDER BY seed_number NULLS LAST, random()) INTO v_ids
  FROM teams WHERE event_id = p_event_id AND division_id = p_division_id;
  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n < 2 THEN
    RAISE EXCEPTION '팀이 2팀 미만입니다. (현재: %팀)', v_n;
  END IF;

  DELETE FROM group_members WHERE group_id IN (
    SELECT id FROM groups WHERE event_id = p_event_id AND division_id = p_division_id);
  DELETE FROM groups WHERE event_id = p_event_id AND division_id = p_division_id;
  UPDATE teams SET group_id = NULL WHERE event_id = p_event_id AND division_id = p_division_id;

  INSERT INTO groups(event_id, division_id, division_name, group_label, group_num, advance_count)
  VALUES (p_event_id, p_division_id, v_div_name, '리그', 1, 0)
  RETURNING id INTO v_group_id;

  FOR i IN 1..v_n LOOP
    INSERT INTO group_members(event_id, division_id, group_id, team_id, seq)
    VALUES (p_event_id, p_division_id, v_group_id, v_ids[i], i);
  END LOOP;
  UPDATE teams SET group_id = v_group_id WHERE id = ANY (v_ids);

  -- 원형 대진: 홀수면 빈 자리(NULL) 하나 추가 → 그 상대는 그 라운드 휴식
  v_arr := v_ids;
  IF v_n % 2 = 1 THEN v_arr := array_append(v_arr, NULL::uuid); END IF;
  v_m := array_length(v_arr, 1);

  SELECT COALESCE(MAX(slot), 0) INTO v_slot FROM matches WHERE event_id = p_event_id;

  FOR r IN 1..(v_m - 1) LOOP
    FOR k IN 1..(v_m / 2) LOOP
      v_a := v_arr[k];
      v_b := v_arr[v_m - k + 1];
      IF v_a IS NOT NULL AND v_b IS NOT NULL THEN
        v_slot := v_slot + 1;
        INSERT INTO matches(
          match_num, event_id, division_id, division_name,
          stage, round, slot, group_id, team_a_id, team_b_id, status
        ) VALUES (
          next_match_num(p_event_id), p_event_id, p_division_id, v_div_name,
          'GROUP', '조별', v_slot, v_group_id, v_a, v_b, 'PENDING'
        );
        v_cnt := v_cnt + 1;
      END IF;
    END LOOP;
    -- 첫 자리 고정, 나머지 한 칸씩 회전
    v_arr := v_arr[1:1] || v_arr[v_m:v_m] || v_arr[2:v_m - 1];
  END LOOP;

  UPDATE divisions SET format = 'full_league' WHERE id = p_division_id;

  PERFORM log_audit(p_event_id, 'generate_league', 'operator',
    COALESCE(auth.uid()::text, 'system'), 'matches', p_division_id,
    jsonb_build_object('teams', v_n, 'matches_created', v_cnt));

  RETURN jsonb_build_object('success', true, 'teams', v_n, 'matches_created', v_cnt,
    'group_id', v_group_id, 'division', v_div_name);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_generate_league(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_generate_league(uuid, uuid) TO authenticated, service_role;
