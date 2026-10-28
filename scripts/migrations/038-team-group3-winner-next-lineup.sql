-- ============================================================
-- 038: 단체전 3팀 조 "승자 우선" — 남은 대전에 라인업을 미리 내도 순서 교체
--   036은 남은 두 대전이 모두 'pending'일 때만 순서를 바꿨다.
--   주장들이 3대전 오더를 한꺼번에 내면 상태가 lineup_phase / lineup_ready 가 되어
--   승자 대전이 앞으로 오지 않았다 → 시작 전 상태(pending, lineup_phase, lineup_ready)면 교체.
--   in_progress / completed 대전이 있으면 지금처럼 아무것도 하지 않음.
--   클럽·라인업·러버는 대전(id)에 붙어 있어 그대로 유효 (tie_order / court_order 만 교체).
-- 안전장치: 실서버 함수가 036 그대로일 때만 교체 (md5 비교, 다르면 중단)
-- 되돌리기: 036-team-group3-winner-next.sql 을 다시 실행
-- ============================================================
DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(replace(prosrc, E'\r', '')) INTO v FROM pg_proc WHERE proname = 'fn_team_group3_winner_next' AND pronamespace = 'public'::regnamespace;
  IF v IS NULL THEN RAISE EXCEPTION '038 중단: fn_team_group3_winner_next 없음'; END IF;
  IF v NOT IN ('5c0b76addd5c3a90830b10d71d093236', '84ad196c99314d4c54491f4aabb35f06') THEN
    RAISE EXCEPTION '038 중단: 실서버 함수가 036과 다름 (md5 %)', v;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_team_group3_winner_next()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_cnt   int;
  v_clubs int;
  v_loser uuid;
  v_w     ties%ROWTYPE;
  v_l     ties%ROWTYPE;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' OR OLD.status = 'completed'
     OR NEW.group_id IS NULL OR NEW.round IS DISTINCT FROM 'group'
     OR NEW.winning_club_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT count(*) INTO v_cnt FROM ties WHERE group_id = NEW.group_id AND round = 'group';
    SELECT count(DISTINCT c) INTO v_clubs FROM (
      SELECT club_a_id AS c FROM ties WHERE group_id = NEW.group_id AND round = 'group'
      UNION ALL
      SELECT club_b_id FROM ties WHERE group_id = NEW.group_id AND round = 'group'
    ) x WHERE c IS NOT NULL;
    IF v_cnt <> 3 OR v_clubs <> 3 THEN RETURN NEW; END IF;

    -- 첫 대전일 때만 (나머지 둘이 아직 시작 전 — 038: 라인업 제출·공개 상태도 시작 전으로 봄)
    IF EXISTS (SELECT 1 FROM ties WHERE group_id = NEW.group_id AND round = 'group'
               AND id <> NEW.id AND status NOT IN ('pending', 'lineup_phase', 'lineup_ready')) THEN
      RETURN NEW;
    END IF;

    v_loser := CASE WHEN NEW.winning_club_id = NEW.club_a_id THEN NEW.club_b_id ELSE NEW.club_a_id END;

    SELECT * INTO v_w FROM ties WHERE group_id = NEW.group_id AND round = 'group' AND id <> NEW.id
       AND NEW.winning_club_id IN (club_a_id, club_b_id) LIMIT 1;
    SELECT * INTO v_l FROM ties WHERE group_id = NEW.group_id AND round = 'group' AND id <> NEW.id
       AND v_loser IN (club_a_id, club_b_id) LIMIT 1;
    IF v_w.id IS NULL OR v_l.id IS NULL OR v_w.id = v_l.id THEN RETURN NEW; END IF;

    -- 승자 대전이 뒤에 있으면 앞으로 (임시값을 거쳐 교체 — 유니크 제약이 있어도 안전)
    IF v_w.tie_order IS NOT NULL AND v_l.tie_order IS NOT NULL AND v_w.tie_order > v_l.tie_order THEN
      UPDATE ties SET tie_order = -1 * v_w.tie_order WHERE id = v_w.id;
      UPDATE ties SET tie_order = v_w.tie_order WHERE id = v_l.id;
      UPDATE ties SET tie_order = v_l.tie_order WHERE id = v_w.id;
    END IF;

    IF v_w.court_number IS NOT DISTINCT FROM v_l.court_number
       AND v_w.court_order IS NOT NULL AND v_l.court_order IS NOT NULL
       AND v_w.court_order > v_l.court_order THEN
      UPDATE ties SET court_order = -1 * v_w.court_order WHERE id = v_w.id;
      UPDATE ties SET court_order = v_w.court_order WHERE id = v_l.id;
      UPDATE ties SET court_order = v_l.court_order WHERE id = v_w.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_team_group3_winner_next: %', SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_team_group3_winner_next() FROM public, anon, authenticated;

SELECT md5(replace(prosrc, E'\r', '')) = '84ad196c99314d4c54491f4aabb35f06' AS applied_038 FROM pg_proc
 WHERE proname = 'fn_team_group3_winner_next' AND pronamespace = 'public'::regnamespace;
