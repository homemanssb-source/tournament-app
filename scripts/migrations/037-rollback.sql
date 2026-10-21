-- ============================================================
-- 037 되돌리기: 개인전 fn_auto_fill_idle_court 를 027 본문으로, 단체전 트리거·새 함수 삭제
--   court_zones 의 rounds/_avail 값은 남아 있어도 027 은 무시한다 (데이터 변경 없음)
-- ============================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_z_auto_fill_idle_court_tie ON public.ties;
DROP FUNCTION IF EXISTS public.fn_auto_fill_idle_court_tie();

CREATE OR REPLACE FUNCTION public.fn_auto_fill_idle_court()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_fill   boolean;
  v_steal  boolean;
  v_zones  jsonb;
  v_date   date;
  v_pick   uuid;
  v_from   text;      -- 데려온 경기의 원래 코트 (NULL = 미배정 경기)
  v_order  int;
  v_rows   int;
  v_busy   text[];    -- 027: 지금 경기 중인 선수 키
  v_rest   text[];    -- 027: 방금 경기를 끝낸 선수 키
BEGIN
  -- FINISHED 로 바뀔 때만, 코트가 있을 때만
  IF NEW.status IS DISTINCT FROM 'FINISHED' OR OLD.status = 'FINISHED' OR NEW.court IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT COALESCE(e.auto_fill_courts, false), COALESCE(e.auto_steal_courts, false), e.court_zones::jsonb
      INTO v_fill, v_steal, v_zones
      FROM events e WHERE e.id = NEW.event_id;
    IF NOT COALESCE(v_fill, false) THEN
      RETURN NEW;
    END IF;

    SELECT d.match_date INTO v_date FROM divisions d WHERE d.id = NEW.division_id;

    -- 이 코트에 같은 날 진행/대기 경기가 남아 있으면 할 일 없음 (기존 자동 시작 몫)
    IF EXISTS (
      SELECT 1 FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
      WHERE m.event_id = NEW.event_id AND m.court = NEW.court
        AND m.status IN ('PENDING', 'IN_PROGRESS')
        AND (m.score IS NULL OR m.score <> 'BYE')
        AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
    ) THEN
      RETURN NEW;
    END IF;

    -- 027: 선수 단위 — 경기 중인 선수, 방금 끝낸 선수
    SELECT COALESCE(array_agg(DISTINCT k), '{}'::text[]) INTO v_busy
      FROM matches x,
           LATERAL unnest(public._team_player_keys(x.team_a_id) || public._team_player_keys(x.team_b_id)) AS k
     WHERE x.event_id = NEW.event_id AND x.status = 'IN_PROGRESS';
    v_rest := public._team_player_keys(NEW.team_a_id) || public._team_player_keys(NEW.team_b_id);

    -- ① 코트 없는 경기 데려오기
    SELECT m.id INTO v_pick
    FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
    WHERE m.event_id = NEW.event_id
      AND m.court IS NULL
      AND m.status = 'PENDING'
      AND (m.score IS NULL OR m.score <> 'BYE')
      AND m.team_a_id IS NOT NULL AND m.team_b_id IS NOT NULL
      AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
      AND public._court_zone_ok(v_zones, m.division_id, m.stage, NEW.court)
      AND NOT EXISTS (
        SELECT 1 FROM matches x
        WHERE x.event_id = NEW.event_id AND x.status = 'IN_PROGRESS'
          AND (x.team_a_id IN (m.team_a_id, m.team_b_id) OR x.team_b_id IN (m.team_a_id, m.team_b_id))
      )
      AND NOT ((public._team_player_keys(m.team_a_id) || public._team_player_keys(m.team_b_id)) && v_busy)
    ORDER BY
      COALESCE(NEW.group_id IS NOT NULL AND m.group_id = NEW.group_id, false) DESC,
      COALESCE(m.division_id = NEW.division_id, false) DESC,
      (COALESCE(m.team_a_id IN (NEW.team_a_id, NEW.team_b_id) OR m.team_b_id IN (NEW.team_a_id, NEW.team_b_id), false)
        OR ((public._team_player_keys(m.team_a_id) || public._team_player_keys(m.team_b_id)) && v_rest)) ASC,
      (m.stage = 'GROUP') DESC,
      m.slot NULLS LAST,
      m.match_num
    LIMIT 1;

    -- ② (옵션) 같은 경기장에서 가장 밀린 코트의 맨 마지막 대기 경기 데려오기
    IF v_pick IS NULL AND COALESCE(v_steal, false) THEN
      SELECT c.id, c.court INTO v_pick, v_from
      FROM (
        SELECT DISTINCT ON (m.court)
               m.id, m.court, m.division_id, m.stage, m.team_a_id, m.team_b_id,
               count(*) OVER (PARTITION BY m.court) AS n
        FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
        WHERE m.event_id = NEW.event_id
          AND m.status = 'PENDING'
          AND m.court IS NOT NULL AND m.court <> NEW.court
          AND public._court_venue(m.court) = public._court_venue(NEW.court)
          AND (m.score IS NULL OR m.score <> 'BYE')
          AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
        ORDER BY m.court, m.court_order DESC NULLS LAST
      ) c
      WHERE c.n >= 2
        AND c.team_a_id IS NOT NULL AND c.team_b_id IS NOT NULL
        AND public._court_zone_ok(v_zones, c.division_id, c.stage, NEW.court)
        AND NOT EXISTS (
          SELECT 1 FROM matches x
          WHERE x.event_id = NEW.event_id AND x.status = 'IN_PROGRESS'
            AND (x.team_a_id IN (c.team_a_id, c.team_b_id) OR x.team_b_id IN (c.team_a_id, c.team_b_id))
        )
        AND NOT ((public._team_player_keys(c.team_a_id) || public._team_player_keys(c.team_b_id)) && v_busy)
      ORDER BY c.n DESC, c.court
      LIMIT 1;
    END IF;

    IF v_pick IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT COALESCE(max(m.court_order), 0) + 1 INTO v_order
      FROM matches m WHERE m.event_id = NEW.event_id AND m.court = NEW.court;

    -- 그 사이 다른 코트가 먼저 데려갔으면(동시 종료) 0행 → 아무것도 안 함
    UPDATE matches
       SET court = NEW.court, court_order = v_order,
           status = 'IN_PROGRESS', started_at = now(),
           auto_assigned_at = now(), auto_notified_at = NULL
     WHERE id = v_pick AND status = 'PENDING' AND court IS NOT DISTINCT FROM v_from;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows > 0 THEN
      PERFORM log_audit(NEW.event_id, 'auto_court_fill', 'system', 'trg_z_auto_fill_idle_court', 'matches', v_pick,
        jsonb_build_object('court', NEW.court, 'from_court', v_from, 'after_match', NEW.id,
                           'mode', CASE WHEN v_from IS NULL THEN 'fill' ELSE 'steal' END));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_auto_fill_idle_court failed: %', SQLERRM;  -- 점수 저장은 절대 막지 않는다
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_auto_fill_idle_court() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public._court_zone_ok2(jsonb, uuid, text, text, text);
DROP FUNCTION IF EXISTS public._court_round_listed(jsonb, uuid, text, text, text);
DROP FUNCTION IF EXISTS public._court_round_key(text, text);
DROP FUNCTION IF EXISTS public._court_open(jsonb, date, text, timestamptz);
DROP FUNCTION IF EXISTS public._event_court_names(uuid);

COMMIT;

SELECT md5(prosrc) = '9d8a6289fdbc4ea5e6b16a0d2fbbf8c1' AS is_027 FROM pg_proc WHERE proname = 'fn_auto_fill_idle_court';
