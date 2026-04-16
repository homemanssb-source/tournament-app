-- ============================================================
-- 010: rpc_venue_list_matches — division_id + group_id 추가
--
-- 배경:
--   현장관리 페이지의 날짜 필터(division.match_date 기준)와
--   라운드/조 배지 표시를 위해 division_id, group_id를 반환해야 함.
--   기존 RPC는 division_name만 반환 → 프론트의 m.division_id가 undefined →
--   날짜 필터가 모든 경기를 통과시켜 무력화되는 문제 발생.
--
-- 변경:
--   - 개인전: m.division_id, m.group_id 추가
--   - 단체전 ties: t.division_id, t.group_id 추가
--   - division_name도 단체전은 divisions 조인으로 실제 부서명 반환
--
-- 실행일: 2026-04-16
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_venue_list_matches(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_session venue_sessions;
  v_venue   venues%ROWTYPE;
  v_matches jsonb;
  v_ties    jsonb;
  v_court_map jsonb;
BEGIN
  v_session := _venue_session(p_token);
  SELECT * INTO v_venue FROM venues WHERE id = v_session.venue_id;

  WITH venue_ordered AS (
    SELECT v.*, ROW_NUMBER() OVER (ORDER BY v.created_at) AS venue_rank
    FROM venues v
    WHERE v.event_id = v_session.event_id
  ),
  expanded AS (
    SELECT
      ROW_NUMBER() OVER (ORDER BY vo.venue_rank, gs) AS court_num,
      COALESCE(NULLIF(TRIM(vo.short_name), ''), NULLIF(TRIM(vo.name), ''), '코트') || '-' || gs AS court_name
    FROM venue_ordered vo
    CROSS JOIN LATERAL generate_series(
      1,
      COALESCE(vo.court_count, array_length(vo.courts, 1), 0)
    ) gs
  )
  SELECT jsonb_object_agg(court_num::text, court_name)
  INTO v_court_map
  FROM expanded;

  -- 개인전 경기 (+ division_id, group_id)
  SELECT jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.court NULLS LAST, sub.court_order)
  INTO v_matches
  FROM (
    SELECT m.id, m.match_num, m.stage, m.round, m.court, m.court_order,
           m.status, m.score, m.locked_by_participant,
           m.team_a_id, m.team_b_id, m.winner_team_id,
           m.division_name, m.division_id, m.group_id,
           COALESCE(ta.team_name, 'TBD') AS team_a_name,
           COALESCE(tb.team_name, 'TBD') AS team_b_name,
           false AS is_team_tie
    FROM matches m
      LEFT JOIN teams ta ON ta.id = m.team_a_id
      LEFT JOIN teams tb ON tb.id = m.team_b_id
    WHERE m.event_id = v_session.event_id
      AND COALESCE(m.score, '') != 'BYE'
      AND (
        m.court = ANY(v_session.courts)
        OR (
          m.court IS NULL
          AND (
            v_venue.division_ids IS NULL
            OR array_length(v_venue.division_ids, 1) IS NULL
            OR m.division_id = ANY(v_venue.division_ids)
          )
        )
      )
  ) sub;

  -- 단체전 ties (+ division_id, group_id, 실제 division_name)
  SELECT jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.court NULLS LAST, sub.court_order)
  INTO v_ties
  FROM (
    SELECT
      t.id,
      'T#' || t.tie_order AS match_num,
      'TEAM' AS stage,
      COALESCE(t.round, 'group') AS round,
      CASE WHEN t.court_number IS NOT NULL
        THEN v_court_map ->> t.court_number::text
        ELSE NULL
      END AS court,
      CASE WHEN t.court_number IS NOT NULL THEN 100 + COALESCE(t.tie_order, 0) ELSE NULL END AS court_order,
      CASE t.status
        WHEN 'completed'   THEN 'FINISHED'
        WHEN 'in_progress' THEN 'IN_PROGRESS'
        ELSE 'PENDING'
      END AS status,
      CASE WHEN t.status IN ('completed','in_progress')
        THEN t.club_a_rubbers_won || '-' || t.club_b_rubbers_won
        ELSE NULL
      END AS score,
      false AS locked_by_participant,
      t.club_a_id  AS team_a_id,
      t.club_b_id  AS team_b_id,
      t.winning_club_id AS winner_team_id,
      COALESCE(d.name, '단체전') AS division_name,
      t.division_id,
      t.group_id,
      COALESCE(ca.name, 'TBD') AS team_a_name,
      COALESCE(cb.name, 'TBD') AS team_b_name,
      true AS is_team_tie
    FROM ties t
      LEFT JOIN clubs ca ON ca.id = t.club_a_id
      LEFT JOIN clubs cb ON cb.id = t.club_b_id
      LEFT JOIN divisions d ON d.id = t.division_id
    WHERE t.event_id = v_session.event_id
      AND t.is_bye = false
      AND (
        (t.court_number IS NOT NULL AND (v_court_map ->> t.court_number::text) = ANY(v_session.courts))
        OR (
          t.court_number IS NULL
          AND (
            v_venue.division_ids IS NULL
            OR array_length(v_venue.division_ids, 1) IS NULL
            OR t.division_id = ANY(v_venue.division_ids)
          )
        )
      )
  ) sub;

  RETURN jsonb_build_object(
    'venue_name', v_session.venue_name,
    'courts',     v_session.courts,
    'matches',    COALESCE(v_matches, '[]'::jsonb),
    'ties',       COALESCE(v_ties,    '[]'::jsonb)
  );
END;
$function$;
