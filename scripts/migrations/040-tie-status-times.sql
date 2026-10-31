-- ============================================================
-- 040: 단체전 대전 시작·종료 시각 자동 기록 (2026-10-31)
--
--   ties.started_at / ended_at 칸은 있었지만 점수 RPC 가 찍지 않아 늘 비어 있었다.
--   → 오더 미제출 현황판(039)이 "앞 대전 종료 시각"을 몰라 코트 배정 시각만으로 마감을 잡음
--     (상대 미정일 때 미리 배정한 대전이 차례가 되자마자 "마감 100분 초과")
--   → 대전 관리 화면 ▶ 시작 / ■ 종료 / ⏱ 걸린 시간, 코트판 종료 시각도 안 나옴
--
--   status 가 바뀔 때만:
--     in_progress 로 → started_at 이 비어 있으면 now()
--     completed 로   → ended_at = now()
--     completed 에서 다른 상태로 (점수 정정으로 다시 열림) → ended_at 비움
--   점수 함수(rpc_calculate_tie_result 등)는 건드리지 않음. 기존 데이터 변경 없음. 멱등.
--   되돌리기: DROP TRIGGER IF EXISTS trg_ties_status_times ON public.ties;
--             DROP FUNCTION IF EXISTS public.fn_ties_status_times();
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_ties_status_times()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'in_progress' AND NEW.started_at IS NULL THEN
      NEW.started_at := now();
    END IF;
    IF NEW.status = 'completed' THEN
      NEW.ended_at := now();
    ELSIF OLD.status = 'completed' THEN
      NEW.ended_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_ties_status_times() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ties_status_times ON public.ties;
CREATE TRIGGER trg_ties_status_times
  BEFORE UPDATE OF status ON public.ties
  FOR EACH ROW EXECUTE FUNCTION public.fn_ties_status_times();
