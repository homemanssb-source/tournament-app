-- 046: 경기의 코트는 그 대회 경기장의 코트만 저장 가능
--   2026-11-22 같은 날 두 대회(주니어=회천, 동호인=연정)를 진행하다가 동호인 경기가 '회천-7'로 저장돼
--   연정 코트판에서 사라졌다. 화면 쪽 방지와 별개로, 어느 화면·어느 경로로 저장하든 DB 에서 한 번 더 막는다.
--
--   규칙: matches.court 를 새로 넣거나 바꿀 때
--     - 비우는 것(null)은 항상 허용
--     - 그 대회에 등록된 경기장이 하나도 없으면 허용 (경기장 없이 '코트-1' 식으로 쓰는 대회)
--     - 경기장이 있으면: venues.courts 배열에 있거나 '약칭-번호'(1..court_count) 꼴이어야 함
--     - 아니면 오류 (저장 안 됨)
--   court 값이 안 바뀌는 수정(점수 입력·순서 변경 등)은 검사하지 않는다 → 기존 경기에는 영향 없음.
--   적용 전 라이브 확인(2026-11-23): 코트가 있는 경기 928건 전부 이 규칙을 만족.
--   단체전(ties.court_number)은 번호 방식이라 이 트리거 대상이 아님.
--   여러 번 실행해도 안전.

CREATE OR REPLACE FUNCTION public.fn_matches_court_in_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.court IS NULL OR btrim(NEW.court) = '' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.court IS NOT DISTINCT FROM OLD.court
     AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id THEN
    RETURN NEW;
  END IF;
  -- 경기장을 등록하지 않은 대회는 검사하지 않음
  IF NOT EXISTS (SELECT 1 FROM venues v WHERE v.event_id = NEW.event_id) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM venues v
    WHERE v.event_id = NEW.event_id
      AND ( NEW.court = ANY (COALESCE(v.courts, ARRAY[]::text[]))
            OR EXISTS (
              SELECT 1
              FROM generate_series(1, COALESCE(v.court_count, array_length(v.courts, 1), 0)) gs
              WHERE NEW.court = COALESCE(NULLIF(btrim(v.short_name), ''), NULLIF(btrim(v.name), ''), '코트') || '-' || gs
            ) )
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% 은(는) 이 대회 경기장의 코트가 아닙니다. 화면의 대회를 확인해 주세요.', NEW.court
    USING ERRCODE = 'P0001';
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_matches_court_in_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_a1_court_in_event ON public.matches;
CREATE TRIGGER trg_a1_court_in_event
  BEFORE INSERT OR UPDATE OF court, event_id ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.fn_matches_court_in_event();

-- 확인
SELECT count(*) AS court_guard_trigger FROM pg_trigger WHERE tgname = 'trg_a1_court_in_event' AND NOT tgisinternal;   -- 1
