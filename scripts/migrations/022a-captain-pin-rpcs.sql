-- ============================================================
-- 022a: 주장 PIN 보안 1단계 — 추가만 (2026-09-29)
--
-- 목적: 주장 PIN·공개 전 라인업을 익명 조회에서 숨기기 위한 준비.
--   이 단계는 기존 동작을 바꾸지 않는다 (현재 배포된 화면 그대로 동작).
--   새 화면 배포 후 022b 에서 clubs.captain_pin 비우기·권한 회수를 한다.
--
-- 추가:
--   club_pins            — 주장 PIN 보관 (익명 접근 불가, 로그인 운영자·서버만)
--   trg_clubs_capture_pin — clubs.captain_pin 에 쓰면 club_pins 로 복사 (기존 코드 호환)
--   _club_captain_pin()  — 서버 함수용 PIN 조회
--   rpc_captain_login          — /pin 주장 로그인 (대회당 10회 연속 실패 시 10분 잠금)
--   rpc_captain_tie            — 라인업 페이지 주장 확인 + 내 라인업 (대전당 20회 실패 시 5분 잠금)
--   rpc_captain_record_score   — 라인업 페이지 점수 입력 (그 대전 양 팀 주장만, 공개 후, 첫 입력만)
--   rpc_admin_pin_clubs        — 관리자 PIN 화면: 주장 PIN 목록 (세션 토큰 확인)
--   rpc_admin_pin_tie_lineups  — 관리자 PIN 화면: 대전 라인업 (공개 전 포함)
--   rpc_admin_pin_rubber_score — 관리자 PIN 화면: 러버 점수 입력/정정
--   rpc_submit_lineup          — PIN 비교를 club_pins 기준으로 (나머지 동일)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.club_pins (
  club_id     uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  captain_pin text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.club_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_pins FROM PUBLIC, anon;
GRANT ALL ON public.club_pins TO authenticated, service_role;
DROP POLICY IF EXISTS club_pins_authenticated_all ON public.club_pins;
CREATE POLICY club_pins_authenticated_all ON public.club_pins FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.club_pins (club_id, captain_pin)
SELECT id, captain_pin FROM public.clubs WHERE captain_pin IS NOT NULL
ON CONFLICT (club_id) DO UPDATE SET captain_pin = EXCLUDED.captain_pin, updated_at = now();


-- clubs.captain_pin 에 쓰면 club_pins 로 복사 (022b 에서 clubs 쪽 값은 비우도록 교체)
CREATE OR REPLACE FUNCTION public.fn_clubs_capture_pin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.captain_pin IS NOT NULL THEN
    INSERT INTO club_pins (club_id, captain_pin, updated_at)
    VALUES (NEW.id, NEW.captain_pin, now())
    ON CONFLICT (club_id) DO UPDATE SET captain_pin = EXCLUDED.captain_pin, updated_at = now();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_clubs_capture_pin ON public.clubs;
CREATE TRIGGER trg_clubs_capture_pin
  BEFORE INSERT OR UPDATE OF captain_pin ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_clubs_capture_pin();


CREATE OR REPLACE FUNCTION public._club_captain_pin(p_club_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT captain_pin FROM club_pins WHERE club_id = p_club_id;
$function$;
REVOKE EXECUTE ON FUNCTION public._club_captain_pin(uuid) FROM PUBLIC, anon, authenticated;


-- ── /pin 주장 로그인 ──
CREATE OR REPLACE FUNCTION public.rpc_captain_login(p_event_id uuid, p_pin text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := 'captain_login:' || p_event_id::text;
  v_lock text;
  v_clubs json;
BEGIN
  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock);
  END IF;

  SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'event_id', c.event_id,
                                    'division_id', c.division_id, 'division_name', d.name)
                  ORDER BY d.sort_order NULLS LAST, c.name)
    INTO v_clubs
  FROM clubs c
  JOIN club_pins cp ON cp.club_id = c.id
  LEFT JOIN divisions d ON d.id = c.division_id
  WHERE c.event_id = p_event_id AND cp.captain_pin = p_pin AND p_pin ~ '^[0-9]{6}$';

  IF v_clubs IS NULL THEN
    PERFORM _pin_record_fail(v_key, 10, 10);
    RETURN json_build_object('success', false, 'error', '팀 PIN에 해당하는 클럽을 찾을 수 없습니다.');
  END IF;

  PERFORM _pin_record_success(v_key);
  RETURN json_build_object('success', true, 'clubs', v_clubs);
END;
$function$;


-- ── 라인업 페이지: 주장 확인 + 내 라인업 ──
CREATE OR REPLACE FUNCTION public.rpc_captain_tie(p_tie_id uuid, p_pin text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := 'captain_tie:' || p_tie_id::text;
  v_lock text;
  v_tie ties%ROWTYPE;
  v_side text;
  v_club uuid;
  v_opp uuid;
BEGIN
  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock);
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  IF p_pin IS NOT NULL AND v_tie.club_a_id IS NOT NULL AND _club_captain_pin(v_tie.club_a_id) = p_pin THEN
    v_side := 'a'; v_club := v_tie.club_a_id; v_opp := v_tie.club_b_id;
  ELSIF p_pin IS NOT NULL AND v_tie.club_b_id IS NOT NULL AND _club_captain_pin(v_tie.club_b_id) = p_pin THEN
    v_side := 'b'; v_club := v_tie.club_b_id; v_opp := v_tie.club_a_id;
  ELSE
    PERFORM _pin_record_fail(v_key, 20, 5);
    RETURN json_build_object('success', false, 'error', 'PIN이 일치하지 않습니다.');
  END IF;

  PERFORM _pin_record_success(v_key);
  RETURN json_build_object(
    'success', true,
    'side', v_side,
    'club_id', v_club,
    'opponent_id', v_opp,
    'my_lineups', coalesce((
      SELECT json_agg(json_build_object('rubber_number', l.rubber_number,
                                        'player1_id', l.player1_id, 'player2_id', l.player2_id)
                      ORDER BY l.rubber_number)
      FROM team_lineups l WHERE l.tie_id = p_tie_id AND l.club_id = v_club), '[]'::json)
  );
END;
$function$;


-- ── 라인업 페이지: 점수 입력 (그 대전 주장만, 라인업 공개 후, 첫 입력만) ──
CREATE OR REPLACE FUNCTION public.rpc_captain_record_score(p_tie_id uuid, p_pin text, p_rubber_id uuid, p_set1_a integer, p_set1_b integer, p_set2_a integer DEFAULT NULL::integer, p_set2_b integer DEFAULT NULL::integer, p_set3_a integer DEFAULT NULL::integer, p_set3_b integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_check json;
  v_tie ties%ROWTYPE;
  v_rubber tie_rubbers%ROWTYPE;
BEGIN
  v_check := rpc_captain_tie(p_tie_id, p_pin);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  SELECT * INTO v_rubber FROM tie_rubbers WHERE id = p_rubber_id;
  IF NOT FOUND OR v_rubber.tie_id <> p_tie_id THEN
    RETURN json_build_object('success', false, 'error', '이 대전의 경기가 아닙니다.');
  END IF;
  IF NOT coalesce(v_tie.lineup_revealed, false) THEN
    RETURN json_build_object('success', false, 'error', '라인업이 공개된 뒤에 점수를 입력할 수 있습니다.');
  END IF;

  RETURN rpc_record_rubber_score(p_rubber_id, p_set1_a, p_set1_b, p_set2_a, p_set2_b, p_set3_a, p_set3_b);
END;
$function$;


-- ── 관리자 PIN 세션 확인 → 대회 id (만료/무효면 NULL) ──
CREATE OR REPLACE FUNCTION public._admin_pin_event(p_token text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT event_id FROM admin_pin_sessions
  WHERE token = p_token AND is_active = true AND expires_at > now()
  LIMIT 1;
$function$;
REVOKE EXECUTE ON FUNCTION public._admin_pin_event(text) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.rpc_admin_pin_clubs(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  RETURN json_build_object('success', true, 'clubs', coalesce((
    SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'captain_name', c.captain_name,
                                      'captain_pin', cp.captain_pin, 'division_id', c.division_id)
                    ORDER BY c.name)
    FROM clubs c LEFT JOIN club_pins cp ON cp.club_id = c.id
    WHERE c.event_id = v_event), '[]'::json));
END;
$function$;


CREATE OR REPLACE FUNCTION public.rpc_admin_pin_tie_lineups(p_token text, p_tie_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ties WHERE id = p_tie_id AND event_id = v_event) THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;
  RETURN json_build_object('success', true, 'lineups', coalesce((
    SELECT json_agg(to_json(l) ORDER BY l.rubber_number) FROM team_lineups l WHERE l.tie_id = p_tie_id), '[]'::json));
END;
$function$;


CREATE OR REPLACE FUNCTION public.rpc_admin_pin_rubber_score(p_token text, p_rubber_id uuid, p_set1_a integer, p_set1_b integer, p_set2_a integer DEFAULT NULL::integer, p_set2_b integer DEFAULT NULL::integer, p_set3_a integer DEFAULT NULL::integer, p_set3_b integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event uuid := _admin_pin_event(p_token);
  v_rubber tie_rubbers%ROWTYPE;
BEGIN
  IF v_event IS NULL THEN
    RETURN json_build_object('success', false, 'error', '마스터 PIN 세션이 만료되었습니다.');
  END IF;
  SELECT r.* INTO v_rubber FROM tie_rubbers r JOIN ties t ON t.id = r.tie_id
  WHERE r.id = p_rubber_id AND t.event_id = v_event;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '경기를 찾을 수 없습니다.');
  END IF;
  -- 완료된 러버면 정정(재배정까지), 아니면 일반 입력
  RETURN rpc_admin_correct_rubber_score(p_rubber_id, p_set1_a, p_set1_b, p_set2_a, p_set2_b, p_set3_a, p_set3_b);
END;
$function$;


-- ── 라인업 제출: PIN 비교를 club_pins 기준으로 (라이브 정의 기준, 그 외 동일) ──
CREATE OR REPLACE FUNCTION public.rpc_submit_lineup(p_tie_id uuid, p_club_id uuid, p_captain_pin text, p_lineups jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tie RECORD;
  v_club RECORD;
  v_lineup JSONB;
  v_event RECORD;
  v_both_submitted BOOLEAN;
  v_target_key text;
  v_lock_msg text;
  v_pin text;
BEGIN
  v_target_key := 'club:' || p_club_id::text;

  v_lock_msg := _pin_check_locked(v_target_key);
  IF v_lock_msg IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', v_lock_msg);
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  IF v_tie IS NULL THEN
    RETURN json_build_object('success', false, 'error', '대전을 찾을 수 없습니다.');
  END IF;

  SELECT * INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club IS NULL THEN
    RETURN json_build_object('success', false, 'error', '클럽을 찾을 수 없습니다.');
  END IF;

  IF v_tie.club_a_id != p_club_id AND v_tie.club_b_id != p_club_id THEN
    RETURN json_build_object('success', false, 'error', '이 대전에 참가하는 클럽이 아닙니다.');
  END IF;

  SELECT * INTO v_event FROM events WHERE id = v_tie.event_id;
  IF v_event.lineup_mode = 'captain_pin' THEN
    v_pin := _club_captain_pin(p_club_id);   -- ✅ 022a: club_pins 기준
    IF v_pin IS NULL OR v_pin != p_captain_pin THEN
      PERFORM _pin_record_fail(v_target_key);
      RETURN json_build_object('success', false, 'error', 'PIN이 일치하지 않습니다.');
    END IF;
  END IF;

  PERFORM _pin_record_success(v_target_key);

  IF v_tie.lineup_revealed = true THEN
    RETURN json_build_object('success', false, 'error', '라인업이 이미 확정되어 수정할 수 없습니다.');
  END IF;

  IF jsonb_array_length(p_lineups) != v_tie.rubber_count THEN
    RETURN json_build_object('success', false, 'error',
      '라인업 수(' || jsonb_array_length(p_lineups) || ')가 복식 수(' || v_tie.rubber_count || ')와 다릅니다.');
  END IF;

  DELETE FROM team_lineups WHERE tie_id = p_tie_id AND club_id = p_club_id;

  FOR v_lineup IN SELECT * FROM jsonb_array_elements(p_lineups)
  LOOP
    INSERT INTO team_lineups (tie_id, club_id, rubber_number, player1_id, player2_id, submitted_by)
    VALUES (
      p_tie_id, p_club_id,
      (v_lineup->>'rubber_number')::INT,
      (v_lineup->>'player1_id')::UUID,
      (v_lineup->>'player2_id')::UUID,
      'captain'
    );
  END LOOP;

  IF p_club_id = v_tie.club_a_id THEN
    UPDATE ties SET club_a_lineup_submitted = true, status = 'lineup_phase' WHERE id = p_tie_id;
  ELSIF p_club_id = v_tie.club_b_id THEN
    UPDATE ties SET club_b_lineup_submitted = true, status = 'lineup_phase' WHERE id = p_tie_id;
  END IF;

  SELECT * INTO v_tie FROM ties WHERE id = p_tie_id;
  v_both_submitted := v_tie.club_a_lineup_submitted AND v_tie.club_b_lineup_submitted;

  IF v_both_submitted THEN
    UPDATE ties SET
      lineup_revealed = true, lineup_locked_at = now(),
      status = 'lineup_ready'
    WHERE id = p_tie_id;
    UPDATE team_lineups SET is_revealed = true WHERE tie_id = p_tie_id;
    PERFORM rpc_apply_lineups_to_rubbers(p_tie_id);
  END IF;

  RETURN json_build_object('success', true, 'revealed', v_both_submitted);
END;
$function$;
