-- ============================================================
-- 024: 대회 마스터 PIN 해시 숨기기 (2026-09-29 개인전·공통 보안 점검)
--
-- 문제: events.master_pin_hash 를 익명으로 읽을 수 있었다 (events 공개 조회).
--       PIN 은 숫자 4자리 이상이라 bcrypt 해시라도 컴퓨터로 금방 풀림
--       → 관리자 PIN 화면 접근 (점수 수정·잠금 해제·단체전 주장 PIN 목록).
-- 수정:
--   event_secrets(event_id, master_pin_hash) — 익명·로그인 사용자 모두 직접 접근 불가(서버 함수만)
--   rpc_set_master_pin / rpc_admin_pin_login 이 event_secrets 사용 (그 외 동작 동일, 022b 잠금 유지)
--   rpc_master_pin_status(event_id) — 대시보드 "설정됨/미설정" 표시용 (해시는 돌려주지 않음)
--   events.master_pin_hash 는 비우고, 앞으로 여기에 쓰면 event_secrets 로 옮긴다 (트리거)
-- 되돌리기: 맨 아래 주석 참고
-- ============================================================

CREATE TABLE IF NOT EXISTS public.event_secrets (
  event_id        uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  master_pin_hash text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_secrets ENABLE ROW LEVEL SECURITY;   -- 정책 없음 = 서버 함수(definer)·service_role 만
REVOKE ALL ON public.event_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_secrets TO service_role;

INSERT INTO public.event_secrets (event_id, master_pin_hash)
SELECT id, master_pin_hash FROM public.events WHERE master_pin_hash IS NOT NULL
ON CONFLICT (event_id) DO UPDATE SET master_pin_hash = EXCLUDED.master_pin_hash, updated_at = now();


-- events.master_pin_hash 에 쓰면 event_secrets 로 옮기고 events 쪽은 비움
CREATE OR REPLACE FUNCTION public.fn_events_capture_master_pin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.master_pin_hash IS NOT NULL THEN
    INSERT INTO event_secrets (event_id, master_pin_hash, updated_at)
    VALUES (NEW.id, NEW.master_pin_hash, now())
    ON CONFLICT (event_id) DO UPDATE SET master_pin_hash = EXCLUDED.master_pin_hash, updated_at = now();
    NEW.master_pin_hash := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_events_capture_master_pin ON public.events;
CREATE TRIGGER trg_events_capture_master_pin
  AFTER INSERT ON public.events FOR EACH ROW WHEN (NEW.master_pin_hash IS NOT NULL)
  EXECUTE FUNCTION public.fn_events_capture_master_pin();
-- INSERT 는 FK 때문에 AFTER 로 복사 후 아래 UPDATE 트리거가 비움, UPDATE 는 BEFORE 로 바로 비움
DROP TRIGGER IF EXISTS trg_events_capture_master_pin_upd ON public.events;
CREATE TRIGGER trg_events_capture_master_pin_upd
  BEFORE UPDATE OF master_pin_hash ON public.events FOR EACH ROW
  EXECUTE FUNCTION public.fn_events_capture_master_pin();

CREATE OR REPLACE FUNCTION public.fn_events_clear_master_pin_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE events SET master_pin_hash = NULL WHERE id = NEW.id AND master_pin_hash IS NOT NULL;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS trg_events_clear_master_pin_ins ON public.events;
CREATE TRIGGER trg_events_clear_master_pin_ins
  AFTER INSERT ON public.events FOR EACH ROW WHEN (NEW.master_pin_hash IS NOT NULL)
  EXECUTE FUNCTION public.fn_events_clear_master_pin_after_insert();

UPDATE public.events SET master_pin_hash = NULL WHERE master_pin_hash IS NOT NULL;


-- ── 마스터 PIN 설정 (대시보드 로그인 운영자만 — 022b 권한 유지) ──
CREATE OR REPLACE FUNCTION public.rpc_set_master_pin(p_event_id uuid, p_new_pin text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF length(p_new_pin) < 4 THEN
    RAISE EXCEPTION 'PIN은 최소 4자리 이상이어야 합니다.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
    RAISE EXCEPTION '대회를 찾을 수 없습니다.';
  END IF;

  INSERT INTO event_secrets (event_id, master_pin_hash, updated_at)
  VALUES (p_event_id, crypt(p_new_pin, gen_salt('bf')), now())
  ON CONFLICT (event_id) DO UPDATE SET master_pin_hash = EXCLUDED.master_pin_hash, updated_at = now();

  RETURN json_build_object('success', true);
END;
$function$;


-- ── 대시보드 표시용: 설정 여부만 ──
CREATE OR REPLACE FUNCTION public.rpc_master_pin_status(p_event_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM event_secrets WHERE event_id = p_event_id AND master_pin_hash IS NOT NULL);
$function$;


-- ── 관리자 PIN 로그인 (022b 정의 + event_secrets) ──
CREATE OR REPLACE FUNCTION public.rpc_admin_pin_login(p_master_pin text, p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_event events%ROWTYPE;
  v_hash text;
  v_token text;
  v_key text := 'admin_pin:' || p_event_id::text;
  v_lock text;
BEGIN
  SELECT * INTO v_event FROM events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION '대회를 찾을 수 없습니다.'; END IF;

  SELECT master_pin_hash INTO v_hash FROM event_secrets WHERE event_id = p_event_id;   -- ✅ 024
  IF v_hash IS NULL THEN
    RAISE EXCEPTION '마스터 PIN이 설정되지 않았습니다.';
  END IF;

  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock);
  END IF;

  IF v_hash != crypt(p_master_pin, v_hash) THEN
    PERFORM _pin_record_fail(v_key, 5, 10);
    RETURN jsonb_build_object('success', false, 'error', '마스터 PIN이 올바르지 않습니다.');
  END IF;

  PERFORM _pin_record_success(v_key);

  INSERT INTO admin_pin_sessions(event_id)
  VALUES (p_event_id)
  RETURNING token INTO v_token;

  PERFORM log_audit(p_event_id, 'admin_pin_login', 'admin_pin',
    left(v_token, 8), 'events', p_event_id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'success', true,
    'token', v_token,
    'event_id', p_event_id,
    'event_name', v_event.name,
    'expires_in', '30분'
  );
END;
$function$;

-- 되돌리기(필요 시):
--   UPDATE events e SET master_pin_hash = s.master_pin_hash FROM event_secrets s WHERE s.event_id = e.id;
--   DROP TRIGGER trg_events_capture_master_pin ON events; DROP TRIGGER trg_events_capture_master_pin_upd ON events;
--   DROP TRIGGER trg_events_clear_master_pin_ins ON events;
--   그리고 rpc_admin_pin_login / rpc_set_master_pin 을 022b / 라이브 이전 정의로 되돌림
