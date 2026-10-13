-- ============================================================
-- 026: 빈 코트 자동 이어 배정 (개인전만, 대회별 스위치 — 기본 꺼짐)
--
--   경기가 끝났는데 그 코트에 같은 날 진행/대기 경기가 하나도 없으면
--   (기존 trg_auto_start_next_match 가 다음 경기를 시작하지 못한 경우)
--   ① events.auto_fill_courts  : 아직 코트가 없는 경기 중 다음 경기를 이 코트에 배정하고 바로 시작
--        우선순위: 같은 조 → 같은 부서 → 방금 끝낸 팀이 없는 경기 → 예선 먼저 → 생성 순서
--        조건: 같은 경기일, 두 팀 확정(TBD 아님), 두 팀 모두 다른 코트에서 경기 중 아님,
--              부서별 코트 구역(events.court_zones)이 있으면 그 구역 안 코트일 때만
--   ② events.auto_steal_courts : ①에서 못 찾으면, 같은 경기장의 대기 2경기 이상 코트 중
--        가장 밀린 코트의 맨 마지막 대기 경기를 데려와 시작 (①이 켜져 있어야 동작)
--
--   단체전(ties)은 대상 아님. 기존 함수(fn_auto_start_next_match)는 건드리지 않음.
--   트리거 이름 trg_z_… → 알파벳상 마지막이라 trg_a0_group3_winner_next, trg_auto_start_next_match,
--   trg_fill_tournament_slots 뒤에 실행된다(모두 AFTER 행 트리거). 본선 자리 채움이 끝난 상태를 본다.
--   어떤 오류도 점수 저장을 막지 않는다(EXCEPTION 흡수). 결과는 audit_log 에 auto_court_fill 로 남김.
--   matches.auto_assigned_at / auto_notified_at : 자동 배정 표시 + 선수 알림 1회 발송용 (notify/court API)
-- 멱등 — 여러 번 실행해도 안전. 기존 데이터 변경 없음(컬럼 추가만).
-- ============================================================

ALTER TABLE public.events  ADD COLUMN IF NOT EXISTS auto_fill_courts  boolean NOT NULL DEFAULT false;
ALTER TABLE public.events  ADD COLUMN IF NOT EXISTS auto_steal_courts boolean NOT NULL DEFAULT false;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS auto_assigned_at  timestamptz;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS auto_notified_at  timestamptz;

-- 부서별 코트 구역 확인: 구역이 없거나 비어 있으면 어느 코트든 OK
CREATE OR REPLACE FUNCTION public._court_zone_ok(p_zones jsonb, p_div uuid, p_stage text, p_court text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN z IS NULL OR jsonb_typeof(z) <> 'array' OR jsonb_array_length(z) = 0 THEN true
    ELSE z ? p_court
  END
  FROM (SELECT p_zones -> (p_div::text) -> (CASE WHEN p_stage = 'GROUP' THEN 'group' ELSE 'finals' END) AS z) s
$function$;

-- 코트 이름에서 경기장 부분 ('한라-3' → '한라')
CREATE OR REPLACE FUNCTION public._court_venue(p_court text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT regexp_replace(COALESCE(p_court, ''), '-[^-]*$', '')
$function$;

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
    ORDER BY
      COALESCE(NEW.group_id IS NOT NULL AND m.group_id = NEW.group_id, false) DESC,
      COALESCE(m.division_id = NEW.division_id, false) DESC,
      COALESCE(m.team_a_id IN (NEW.team_a_id, NEW.team_b_id) OR m.team_b_id IN (NEW.team_a_id, NEW.team_b_id), false) ASC,
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

DROP TRIGGER IF EXISTS trg_z_auto_fill_idle_court ON public.matches;
CREATE TRIGGER trg_z_auto_fill_idle_court
  AFTER UPDATE OF status ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.fn_auto_fill_idle_court();

-- 확인
SELECT 'events_cols' AS obj, count(*)::text AS n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'events' AND column_name IN ('auto_fill_courts', 'auto_steal_courts')
UNION ALL SELECT 'matches_cols', count(*)::text FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'matches' AND column_name IN ('auto_assigned_at', 'auto_notified_at')
UNION ALL SELECT 'trigger', count(*)::text FROM pg_trigger WHERE tgname = 'trg_z_auto_fill_idle_court';
