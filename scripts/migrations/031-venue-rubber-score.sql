-- ============================================================
-- 031: 경기장 PIN(현장관리) — 단체전 복식 점수 입력
--
--   조건 (주장 PIN 입력과 같은 규칙 + 경기장 범위)
--   · 그 대회 대전이고, 대전 코트가 이 경기장 코트일 것 (코트 미배정 대전은 불가)
--   · 라인업이 공개된 뒤일 것
--   · 아직 입력 안 된 복식만 (정정은 마스터 PIN) — rpc_record_rubber_score 도 거절
--   실제 기록·대전 결과 계산은 기존 rpc_record_rubber_score 그대로 사용.
--   기존 함수 정의 변경 없음. 데이터 변경 없음. 멱등.
--   되돌리기: DROP FUNCTION public.rpc_venue_rubber_score(text, uuid, integer, integer, integer, integer, integer, integer);
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_venue_rubber_score(p_token text, p_rubber_id uuid,
  p_set1_a integer, p_set1_b integer,
  p_set2_a integer DEFAULT NULL::integer, p_set2_b integer DEFAULT NULL::integer,
  p_set3_a integer DEFAULT NULL::integer, p_set3_b integer DEFAULT NULL::integer)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session venue_sessions;
  v_rubber tie_rubbers%ROWTYPE;
  v_tie ties%ROWTYPE;
  v_court text;
  v_res json;
BEGIN
  v_session := _venue_session(p_token);   -- 만료면 예외

  SELECT * INTO v_rubber FROM tie_rubbers WHERE id = p_rubber_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '경기를 찾을 수 없습니다.');
  END IF;
  SELECT * INTO v_tie FROM ties WHERE id = v_rubber.tie_id;
  IF NOT FOUND OR v_tie.event_id <> v_session.event_id THEN
    RETURN json_build_object('success', false, 'error', '이 대회의 대전이 아닙니다.');
  END IF;

  -- 대전 코트 번호 → 코트 이름 (rpc_venue_list_matches 와 같은 규칙: 경기장 생성 순 × 코트 수)
  WITH venue_ordered AS (
    SELECT v.*, ROW_NUMBER() OVER (ORDER BY v.created_at) AS venue_rank
    FROM venues v WHERE v.event_id = v_session.event_id
  ), expanded AS (
    SELECT ROW_NUMBER() OVER (ORDER BY vo.venue_rank, gs) AS court_num,
           COALESCE(NULLIF(TRIM(vo.short_name), ''), NULLIF(TRIM(vo.name), ''), '코트') || '-' || gs AS court_name
    FROM venue_ordered vo
    CROSS JOIN LATERAL generate_series(1, COALESCE(vo.court_count, array_length(vo.courts, 1), 0)) gs
  )
  SELECT court_name INTO v_court FROM expanded WHERE court_num = v_tie.court_number;
  IF v_court IS NULL OR NOT (v_court = ANY(v_session.courts)) THEN
    RETURN json_build_object('success', false, 'error', '이 경기장 코트에 배정된 대전만 입력할 수 있습니다.');
  END IF;

  IF NOT coalesce(v_tie.lineup_revealed, false) THEN
    RETURN json_build_object('success', false, 'error', '라인업이 공개된 뒤에 점수를 입력할 수 있습니다.');
  END IF;
  IF v_rubber.status = 'completed' THEN
    RETURN json_build_object('success', false, 'error', '이미 입력된 점수입니다. 정정은 마스터 PIN 으로 해주세요.');
  END IF;

  v_res := rpc_record_rubber_score(p_rubber_id, p_set1_a, p_set1_b, p_set2_a, p_set2_b, p_set3_a, p_set3_b);

  IF coalesce((v_res->>'success')::boolean, false) THEN
    INSERT INTO audit_log(event_id, action, actor_type, actor_id, target_table, target_id, details)
    VALUES (v_session.event_id, 'venue_rubber_score', 'venue_manager', v_session.venue_name,
            'tie_rubbers', p_rubber_id,
            jsonb_build_object('set1', p_set1_a || ':' || p_set1_b,
                               'set2', p_set2_a || ':' || p_set2_b,
                               'set3', p_set3_a || ':' || p_set3_b));
  END IF;
  RETURN v_res;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_venue_rubber_score(text, uuid, integer, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_venue_rubber_score(text, uuid, integer, integer, integer, integer, integer, integer) TO anon, authenticated, service_role;

-- 확인
SELECT count(*) AS venue_rubber_fn FROM pg_proc WHERE proname = 'rpc_venue_rubber_score';   -- 1
