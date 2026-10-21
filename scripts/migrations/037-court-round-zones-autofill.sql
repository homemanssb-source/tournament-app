-- ============================================================
-- 037: ⚡ 빈 코트 자동 이어 배정 — 라운드별 코트 구역 + 코트 사용 시간 + 단체전
--
--   events.court_zones 에 새 키 (프론트 src/lib/court-zones.ts 와 같은 규칙):
--     "<division_id>": { "group": [...], "finals": [...], "rounds": { "32강": [...], ... } }
--     "_avail": { "<경기일 YYYY-MM-DD>" | "*": { "<코트>": { "from": "HH:MM", "until": "HH:MM" } } }
--   새 키가 없으면 예전(026·027·033)과 똑같이 동작한다.
--
--   (1) 개인전 fn_auto_fill_idle_court — 027 버전에서 아래만 바뀜
--       · 라운드 칸에 코트가 있으면 그 라운드 경기는 그 코트로만 (없으면 본선 공통/예선 — 기존)
--       · 라운드 칸에 이 코트를 직접 넣은 경기를 먼저 데려옴
--       · 코트 사용 시간 밖이면(한국 시각) 아무것도 안 함
--       · 같은 코트에 단체전 대전이 남아 있으면 비어 있지 않은 것으로 봄
--   (2) 단체전 fn_auto_fill_idle_court_tie (새 트리거 trg_z_auto_fill_idle_court_tie, ties)
--       대전이 끝났는데 그 코트에 남은 대전·경기가 없으면, 코트 없는 대전 중 다음 대전을 그 코트에 **배정만**
--       (상태는 그대로 — 라인업 제출 후 진행). 같은 조 → 같은 부서 → 방금 끝낸 클럽 없는 대전 → 예선 먼저.
--       두 클럽 확정, 같은 날, 두 클럽 모두 진행 중 대전 없음, 구역·사용 시간 지킴.
--   스위치는 기존 그대로 events.auto_fill_courts (대회별, 기본 꺼짐). 어떤 오류도 점수 저장을 막지 않는다.
--
--   안전장치: 라이브 fn_auto_fill_idle_court 가 027 본문과 다르면 아무것도 바꾸지 않고 중단한다.
--   되돌리기: 037-rollback.sql
-- 멱등 — 여러 번 실행해도 안전. 데이터 변경 없음.
-- ============================================================

BEGIN;

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
    FROM pg_proc p WHERE p.proname = 'fn_auto_fill_idle_court' AND p.pronamespace = 'public'::regnamespace;
  -- 027 본문 = 9d8a…, 037 본문(재실행) = 아래 함수가 이미 들어간 경우 → 통과
  IF v_md5 IS DISTINCT FROM '9d8a6289fdbc4ea5e6b16a0d2fbbf8c1'
     AND position('_court_zone_ok2' in (SELECT prosrc FROM pg_proc WHERE proname = 'fn_auto_fill_idle_court' AND pronamespace = 'public'::regnamespace)) = 0 THEN
    RAISE EXCEPTION '037 중단: 라이브 fn_auto_fill_idle_court 가 027 과 다릅니다 (md5 %). 바꾸지 않았습니다.', v_md5;
  END IF;
END
$guard$;

-- 경기의 stage/round → 'group' | '128강' … '결승' | NULL(본선이지만 라운드 모름)
CREATE OR REPLACE FUNCTION public._court_round_key(p_stage text, p_round text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN upper(COALESCE(p_stage, '')) = 'GROUP' OR p_round IN ('group', 'GROUP', '조별') THEN 'group'
    WHEN p_round IN ('128강', 'R128', 'round_of_128') THEN '128강'
    WHEN p_round IN ('64강', 'R64', 'round_of_64') THEN '64강'
    WHEN p_round IN ('32강', 'R32', 'round_of_32') THEN '32강'
    WHEN p_round IN ('16강', 'R16', 'round_of_16') THEN '16강'
    WHEN p_round IN ('8강', 'QF', 'quarter') THEN '8강'
    WHEN p_round IN ('4강', 'SF', 'semi') THEN '4강'
    WHEN p_round IN ('결승', 'F', 'final') THEN '결승'
    ELSE NULL
  END
$function$;

-- 라운드 칸에 이 코트를 직접 넣었는지
CREATE OR REPLACE FUNCTION public._court_round_listed(p_zones jsonb, p_div uuid, p_stage text, p_round text, p_court text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT COALESCE(jsonb_typeof(z) = 'array' AND z ? p_court, false)
  FROM (SELECT p_zones -> (p_div::text) -> 'rounds' -> public._court_round_key(p_stage, p_round) AS z) s
$function$;

-- 구역 확인: 라운드 칸이 비어 있지 않으면 그 칸, 아니면 기존 규칙(예선/본선 공통, 비면 어디든)
CREATE OR REPLACE FUNCTION public._court_zone_ok2(p_zones jsonb, p_div uuid, p_stage text, p_round text, p_court text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN k IS NOT NULL AND k <> 'group' AND jsonb_typeof(z) = 'array' AND jsonb_array_length(z) > 0 THEN z ? p_court
    ELSE public._court_zone_ok(p_zones, p_div, CASE WHEN k = 'group' THEN 'GROUP' ELSE 'FINALS' END, p_court)
  END
  FROM (SELECT public._court_round_key(p_stage, p_round) AS k) a,
  LATERAL (SELECT p_zones -> (p_div::text) -> 'rounds' -> a.k AS z) b
$function$;

-- 코트 사용 시간: 이 시각(한국 시각)에 이 코트에서 경기를 시작해도 되는지. 설정 없으면 true
CREATE OR REPLACE FUNCTION public._court_open(p_zones jsonb, p_date date, p_court text, p_at timestamptz DEFAULT now())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  w jsonb;
  t time;
BEGIN
  w := COALESCE(p_zones -> '_avail' -> (p_date::text) -> p_court, p_zones -> '_avail' -> '*' -> p_court);
  IF w IS NULL OR jsonb_typeof(w) <> 'object' THEN RETURN true; END IF;
  t := (p_at AT TIME ZONE 'Asia/Seoul')::time;
  RETURN (NULLIF(w ->> 'from', '') IS NULL OR t >= (w ->> 'from')::time)
     AND (NULLIF(w ->> 'until', '') IS NULL OR t < (w ->> 'until')::time);
END;
$function$;

-- 대회 전체 코트 이름 (경기장 생성 순 — 단체전 ties.court_number 는 이 배열의 1부터 번호)
--   프론트 venueCourts(): courts 가 있으면 그대로, 없으면 (약칭 또는 이름)-1..N
CREATE OR REPLACE FUNCTION public._event_court_names(p_event uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path = public
AS $function$
  SELECT COALESCE(array_agg(x.c ORDER BY v.created_at, v.id, x.ord), '{}'::text[])
  FROM venues v,
  LATERAL unnest(
    CASE WHEN v.courts IS NOT NULL AND COALESCE(array_length(v.courts, 1), 0) > 0 THEN v.courts
         ELSE ARRAY(SELECT COALESCE(NULLIF(trim(COALESCE(v.short_name, v.name, '')), ''), '코트') || '-' || i
                    FROM generate_series(1, COALESCE(v.court_count, 0)) i)
    END) WITH ORDINALITY AS x(c, ord)
  WHERE v.event_id = p_event
$function$;

-- ── (1) 개인전: 027 + 라운드 구역 + 사용 시간 + 단체전 대전 확인 ──
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
  v_cno    int;       -- 037: 이 코트의 단체전 번호
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

    -- 037: 코트 사용 시간 밖이면 아무것도 안 함
    IF NOT public._court_open(v_zones, v_date, NEW.court) THEN
      RETURN NEW;
    END IF;

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

    -- 037: 같은 코트에 단체전 대전이 남아 있어도 비어 있지 않음
    v_cno := array_position(public._event_court_names(NEW.event_id), NEW.court);
    IF v_cno IS NOT NULL AND EXISTS (
      SELECT 1 FROM ties t LEFT JOIN divisions d ON d.id = t.division_id
      WHERE t.event_id = NEW.event_id AND t.court_number = v_cno
        AND NOT COALESCE(t.is_bye, false) AND t.status NOT IN ('completed', 'bye')
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
      AND public._court_zone_ok2(v_zones, m.division_id, m.stage::text, m.round, NEW.court)
      AND NOT EXISTS (
        SELECT 1 FROM matches x
        WHERE x.event_id = NEW.event_id AND x.status = 'IN_PROGRESS'
          AND (x.team_a_id IN (m.team_a_id, m.team_b_id) OR x.team_b_id IN (m.team_a_id, m.team_b_id))
      )
      AND NOT ((public._team_player_keys(m.team_a_id) || public._team_player_keys(m.team_b_id)) && v_busy)
    ORDER BY
      public._court_round_listed(v_zones, m.division_id, m.stage::text, m.round, NEW.court) DESC,
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
               m.id, m.court, m.division_id, m.stage, m.round, m.team_a_id, m.team_b_id,
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
        AND public._court_zone_ok2(v_zones, c.division_id, c.stage::text, c.round, NEW.court)
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

-- ── (2) 단체전: 대전이 끝나면 빈 코트에 다음 대전 배정 ──
CREATE OR REPLACE FUNCTION public.fn_auto_fill_idle_court_tie()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_fill   boolean;
  v_zones  jsonb;
  v_date   date;
  v_court  text;
  v_pick   uuid;
  v_order  int;
  v_rows   int;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' OR OLD.status = 'completed' OR NEW.court_number IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT COALESCE(e.auto_fill_courts, false), e.court_zones::jsonb INTO v_fill, v_zones
      FROM events e WHERE e.id = NEW.event_id;
    IF NOT COALESCE(v_fill, false) THEN
      RETURN NEW;
    END IF;

    SELECT d.match_date INTO v_date FROM divisions d WHERE d.id = NEW.division_id;
    v_court := (public._event_court_names(NEW.event_id))[NEW.court_number];
    IF v_court IS NULL OR NOT public._court_open(v_zones, v_date, v_court) THEN
      RETURN NEW;
    END IF;

    -- 이 코트에 같은 날 남은 대전·경기가 있으면 할 일 없음
    IF EXISTS (
      SELECT 1 FROM ties t LEFT JOIN divisions d ON d.id = t.division_id
      WHERE t.event_id = NEW.event_id AND t.court_number = NEW.court_number AND t.id <> NEW.id
        AND NOT COALESCE(t.is_bye, false) AND t.status NOT IN ('completed', 'bye')
        AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
    ) OR EXISTS (
      SELECT 1 FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
      WHERE m.event_id = NEW.event_id AND m.court = v_court
        AND m.status IN ('PENDING', 'IN_PROGRESS')
        AND (m.score IS NULL OR m.score <> 'BYE')
        AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
    ) THEN
      RETURN NEW;
    END IF;

    SELECT t.id INTO v_pick
    FROM ties t LEFT JOIN divisions d ON d.id = t.division_id
    WHERE t.event_id = NEW.event_id
      AND t.court_number IS NULL
      AND NOT COALESCE(t.is_bye, false)
      AND t.status NOT IN ('completed', 'bye', 'in_progress')
      AND t.club_a_id IS NOT NULL AND t.club_b_id IS NOT NULL
      AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
      AND public._court_zone_ok2(v_zones, t.division_id, CASE WHEN t.round = 'group' THEN 'GROUP' ELSE 'FINALS' END, t.round, v_court)
      AND NOT EXISTS (
        SELECT 1 FROM ties x
        WHERE x.event_id = NEW.event_id AND x.status = 'in_progress'
          AND (x.club_a_id IN (t.club_a_id, t.club_b_id) OR x.club_b_id IN (t.club_a_id, t.club_b_id))
      )
    ORDER BY
      public._court_round_listed(v_zones, t.division_id, CASE WHEN t.round = 'group' THEN 'GROUP' ELSE 'FINALS' END, t.round, v_court) DESC,
      COALESCE(NEW.group_id IS NOT NULL AND t.group_id = NEW.group_id, false) DESC,
      COALESCE(t.division_id = NEW.division_id, false) DESC,
      COALESCE(t.club_a_id IN (NEW.club_a_id, NEW.club_b_id) OR t.club_b_id IN (NEW.club_a_id, NEW.club_b_id), false) ASC,
      (t.round = 'group') DESC,
      t.tie_order NULLS LAST,
      t.bracket_position NULLS LAST,
      t.id
    LIMIT 1;

    IF v_pick IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT GREATEST(
      (SELECT COALESCE(max(t.court_order), 0) FROM ties t WHERE t.event_id = NEW.event_id AND t.court_number = NEW.court_number),
      (SELECT COALESCE(max(m.court_order), 0) FROM matches m WHERE m.event_id = NEW.event_id AND m.court = v_court)
    ) + 1 INTO v_order;

    -- 배정만 (상태는 그대로 — 라인업 제출 후 진행). 동시에 다른 코트가 가져갔으면 0행
    UPDATE ties SET court_number = NEW.court_number, court_order = v_order
     WHERE id = v_pick AND court_number IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows > 0 THEN
      PERFORM log_audit(NEW.event_id, 'auto_court_fill', 'system', 'trg_z_auto_fill_idle_court_tie', 'ties', v_pick,
        jsonb_build_object('court', v_court, 'court_number', NEW.court_number, 'after_tie', NEW.id, 'mode', 'fill', 'kind', 'tie'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_auto_fill_idle_court_tie failed: %', SQLERRM;  -- 점수 저장은 절대 막지 않는다
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_auto_fill_idle_court_tie() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_z_auto_fill_idle_court_tie ON public.ties;
CREATE TRIGGER trg_z_auto_fill_idle_court_tie
  AFTER UPDATE OF status ON public.ties
  FOR EACH ROW EXECUTE FUNCTION public.fn_auto_fill_idle_court_tie();

COMMIT;

-- 확인 (모두 1 / true 여야 함)
SELECT 'fn_matches_037' AS obj, (position('_court_zone_ok2' in pg_get_functiondef('public.fn_auto_fill_idle_court'::regproc)) > 0)::text AS v
UNION ALL SELECT 'trigger_ties', count(*)::text FROM pg_trigger WHERE tgname = 'trg_z_auto_fill_idle_court_tie'
UNION ALL SELECT 'round_key', public._court_round_key('FINALS', 'round_of_16')
UNION ALL SELECT 'zone_round', public._court_zone_ok2('{"00000000-0000-0000-0000-000000000001":{"finals":["A-1"],"rounds":{"16강":["A-2"]}}}'::jsonb,
  '00000000-0000-0000-0000-000000000001'::uuid, 'FINALS', '16강', 'A-2')::text
UNION ALL SELECT 'zone_round_blocks_other', (NOT public._court_zone_ok2('{"00000000-0000-0000-0000-000000000001":{"finals":["A-1"],"rounds":{"16강":["A-2"]}}}'::jsonb,
  '00000000-0000-0000-0000-000000000001'::uuid, 'FINALS', '16강', 'A-1'))::text
UNION ALL SELECT 'zone_fallback_finals', public._court_zone_ok2('{"00000000-0000-0000-0000-000000000001":{"finals":["A-1"],"rounds":{"16강":["A-2"]}}}'::jsonb,
  '00000000-0000-0000-0000-000000000001'::uuid, 'FINALS', '8강', 'A-1')::text
UNION ALL SELECT 'open_no_setting', public._court_open('{}'::jsonb, '2026-10-25', 'A-1')::text
UNION ALL SELECT 'events_auto_fill_on', count(*)::text FROM events WHERE auto_fill_courts;
