-- ============================================================
-- 036: 단체전 3팀 조 "승자 우선" 대전 순서 (개인전 016과 같은 규칙)
--   규칙: 1번 vs 2번 먼저 → 이긴 클럽이 곧바로 3번과 → 마지막에 진 클럽이 3번과
--   첫 대전이 끝나면(status → completed) 남은 두 대전 중 승자 대전을 앞으로 당긴다
--   (tie_order 교체, 같은 코트면 court_order도 교체). 클럽·라인업·러버는 건드리지 않는다.
--   - 3클럽·3대전인 조(round='group')에서만, 나머지 두 대전이 모두 pending일 때만 동작
--   - 승자가 없는 대전(무효 0:0)은 아무것도 하지 않음
--   - 어떤 오류가 나도 점수 저장은 막지 않는다(EXCEPTION → WARNING)
--   - 새 함수·새 트리거만 추가 (기존 함수 수정 없음)
-- 멱등 — 여러 번 실행해도 안전
-- 되돌리기:
--   DROP TRIGGER IF EXISTS trg_a0_team_group3_winner_next ON public.ties;
--   DROP FUNCTION IF EXISTS public.fn_team_group3_winner_next();
-- ============================================================

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

    -- 첫 대전일 때만 (나머지 둘이 아직 시작 전)
    IF EXISTS (SELECT 1 FROM ties WHERE group_id = NEW.group_id AND round = 'group'
               AND id <> NEW.id AND status <> 'pending') THEN
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

DROP TRIGGER IF EXISTS trg_a0_team_group3_winner_next ON public.ties;
CREATE TRIGGER trg_a0_team_group3_winner_next
  AFTER UPDATE OF status ON public.ties
  FOR EACH ROW EXECUTE FUNCTION public.fn_team_group3_winner_next();
