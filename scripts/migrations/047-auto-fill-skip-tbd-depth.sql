-- 047: ⚡ 빈 코트 자동 이어 배정 — 빈틈 두 가지 보완 (2026-11-22 협회장배 주니어·동호인 점검)
--
--   ⚡(events.auto_fill_courts) 를 켠 대회에만 영향. 꺼진 대회는 예전과 완전히 같음.
--   바꾸는 것은 fn_auto_fill_idle_court (개인전) 하나 + 새 도우미 _match_depth. 자동 시작(fn_auto_start_next_match)은 그대로.
--
--   ① 줄 맨 앞이 '선수 미정' 경기면 코트가 비던 문제
--      예전: 그 코트에 대기 경기가 하나라도 남아 있으면 아무것도 안 함. 자동 시작은 미정 경기를 켜지 않으므로(043) 코트가 그냥 빔.
--      이제: 그 코트에 '진행 중'이 없으면
--        ⓪ 같은 코트 줄에서 두 팀이 정해진 가장 앞 대기 경기를 시작 (미정 경기는 건너뜀, 순서 번호는 그대로)
--        ① 없으면 코트 없는 경기를 데려옴 (기존)   ② 없으면 (옵션) 다른 코트에서 가져옴 (기존)
--   ② 라운드가 많은 부서가 맨 뒤로 밀리던 문제
--      데려올 경기 우선순위에 '결승까지 남은 경기 수'(_match_depth)를 추가: 구역 지정 → 같은 조 → [남은 경기 많은 쪽] → 같은 부서 → …
--   ③ (옵션 '다른 코트에서 가져오기') 그 코트 맨 뒤 대기 경기가 선수 미정이면 못 가져오던 것 → 준비된 경기 중 맨 뒤 것
--
--   안전장치: 라이브 함수가 037 본문과 다르면 중단. 여러 번 실행해도 안전. 되돌리기: 047-rollback.sql

BEGIN;

DO $guard$
DECLARE v_src text; v_md5 text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'fn_auto_fill_idle_court' AND p.pronamespace = 'public'::regnamespace;
  v_md5 := md5(replace(v_src, E'\r', ''));
  -- 037 본문 = cbdb28a5ac4a5c9ffca46832ede1d6a6 / 이미 047 이 들어가 있으면(재실행) 통과
  IF v_md5 IS DISTINCT FROM 'cbdb28a5ac4a5c9ffca46832ede1d6a6' AND position('_match_depth' in COALESCE(v_src, '')) = 0 THEN
    RAISE EXCEPTION '047 중단: 라이브 fn_auto_fill_idle_court 가 037 과 다릅니다 (md5 %). 바꾸지 않았습니다.', v_md5;
  END IF;
END
$guard$;

-- 결승까지 남은 경기 수 (클수록 먼저 쳐야 대회가 일찍 끝남)
--   본선: 결승 1 · 4강 2 · 8강 3 · 16강 4 · 32강 5 · 64강 6 · 128강 7 (모르는 라운드 1)
--   조별: 그 부서 본선의 가장 앞 라운드 값 + 이 경기 두 팀 중 남은 조별 경기가 더 많은 쪽의 경기 수
--         (본선이 없는 풀리그 부서는 남은 조별 경기 수만)
CREATE OR REPLACE FUNCTION public._match_depth(p_match uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  SELECT CASE
    WHEN public._court_round_key(m.stage::text, m.round) = 'group' THEN
      COALESCE((SELECT max(CASE public._court_round_key(f.stage::text, f.round)
                             WHEN '결승' THEN 1 WHEN '4강' THEN 2 WHEN '8강' THEN 3 WHEN '16강' THEN 4
                             WHEN '32강' THEN 5 WHEN '64강' THEN 6 WHEN '128강' THEN 7 ELSE 1 END)
                  FROM matches f
                 WHERE f.event_id = m.event_id AND f.division_id = m.division_id
                   AND public._court_round_key(f.stage::text, f.round) IS DISTINCT FROM 'group'), 0)
      + GREATEST(1, COALESCE((
          SELECT max(q.c) FROM (
            SELECT count(*)::int AS c
              FROM unnest(ARRAY[m.team_a_id, m.team_b_id]) AS t(id)
              JOIN matches g ON g.event_id = m.event_id AND g.division_id = m.division_id
                            AND public._court_round_key(g.stage::text, g.round) = 'group'
                            AND g.status <> 'FINISHED'
                            AND (g.team_a_id = t.id OR g.team_b_id = t.id)
             WHERE t.id IS NOT NULL
             GROUP BY t.id) q), 1))
    ELSE CASE public._court_round_key(m.stage::text, m.round)
           WHEN '결승' THEN 1 WHEN '4강' THEN 2 WHEN '8강' THEN 3 WHEN '16강' THEN 4
           WHEN '32강' THEN 5 WHEN '64강' THEN 6 WHEN '128강' THEN 7 ELSE 1 END
  END
  FROM matches m WHERE m.id = p_match
$function$;
REVOKE ALL ON FUNCTION public._match_depth(uuid) FROM PUBLIC, anon, authenticated;

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
  v_mode   text;      -- 047: fill / steal / skip_tbd
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

    -- 이 코트에 같은 날 진행 중 경기가 있으면 할 일 없음 (기존 자동 시작이 다음 경기를 이미 켰거나, 원래 진행 중)
    -- 047: 예전엔 '대기' 경기만 남아 있어도 여기서 끝났다 → 줄 맨 앞이 선수 미정이면 코트가 그냥 비었음
    IF EXISTS (
      SELECT 1 FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
      WHERE m.event_id = NEW.event_id AND m.court = NEW.court
        AND m.status = 'IN_PROGRESS'
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

    -- 047 ⓪ 이 코트 줄에 이미 있는 대기 경기 중, 두 팀이 정해진 가장 앞 경기를 시작 (미정 경기는 건너뜀)
    SELECT m.id INTO v_pick
    FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
    WHERE m.event_id = NEW.event_id
      AND m.court = NEW.court
      AND m.status = 'PENDING'
      AND (m.score IS NULL OR m.score <> 'BYE')
      AND m.team_a_id IS NOT NULL AND m.team_b_id IS NOT NULL
      AND (v_date IS NULL OR d.match_date IS NULL OR d.match_date = v_date)
      AND NOT EXISTS (
        SELECT 1 FROM matches x
        WHERE x.event_id = NEW.event_id AND x.status = 'IN_PROGRESS'
          AND (x.team_a_id IN (m.team_a_id, m.team_b_id) OR x.team_b_id IN (m.team_a_id, m.team_b_id))
      )
      AND NOT ((public._team_player_keys(m.team_a_id) || public._team_player_keys(m.team_b_id)) && v_busy)
    ORDER BY m.court_order NULLS LAST, m.slot NULLS LAST, m.match_num
    LIMIT 1;

    IF v_pick IS NOT NULL THEN
      UPDATE matches
         SET status = 'IN_PROGRESS', started_at = now(),
             auto_assigned_at = now(), auto_notified_at = NULL
       WHERE id = v_pick AND status = 'PENDING' AND court = NEW.court;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN
        PERFORM log_audit(NEW.event_id, 'auto_court_fill', 'system', 'trg_z_auto_fill_idle_court', 'matches', v_pick,
          jsonb_build_object('court', NEW.court, 'from_court', NEW.court, 'after_match', NEW.id, 'mode', 'skip_tbd'));
      END IF;
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
      public._match_depth(m.id) DESC,          -- 047: 결승까지 남은 경기가 많은 쪽 먼저 (라운드 많은 부서가 맨 뒤로 밀리지 않게)
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
        -- 047: 코트마다 '두 팀이 정해진' 대기 경기 중 맨 뒤 것 (예전엔 맨 뒤가 미정 경기면 그 코트에서 못 가져옴)
        --      n = 그 코트의 준비된 대기 경기 수 + 진행 중 경기 수 → 2 이상이어야 (바로 칠 경기는 남겨 둠)
        SELECT DISTINCT ON (m.court)
               m.id, m.court, m.division_id, m.stage, m.round, m.team_a_id, m.team_b_id,
               count(*) OVER (PARTITION BY m.court)
                 + (SELECT count(*) FROM matches p WHERE p.event_id = NEW.event_id AND p.court = m.court AND p.status = 'IN_PROGRESS') AS n
        FROM matches m LEFT JOIN divisions d ON d.id = m.division_id
        WHERE m.event_id = NEW.event_id
          AND m.status = 'PENDING'
          AND m.court IS NOT NULL AND m.court <> NEW.court
          AND m.team_a_id IS NOT NULL AND m.team_b_id IS NOT NULL
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

COMMIT;

-- 확인: 2 가 나와야 함 (도우미 1 + 본문에 _match_depth 포함 1)
SELECT (SELECT count(*) FROM pg_proc WHERE proname = '_match_depth' AND pronamespace = 'public'::regnamespace)
     + (SELECT count(*) FROM pg_proc WHERE proname = 'fn_auto_fill_idle_court' AND pronamespace = 'public'::regnamespace
          AND position('_match_depth' in prosrc) > 0 AND position('skip_tbd' in prosrc) > 0) AS auto_fill_047;
