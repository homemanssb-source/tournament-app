-- ============================================================
-- 025c: 경기장 PIN 로그인 — 없는 칸(venues.pin_hash) 조회 제거
--
-- 라이브 rpc_venue_login 에는 예전부터 venues.pin_hash 로 한 번 더 찾는 코드가 있었지만 그 칸은 없다.
-- PIN 이 맞으면 거기까지 가지 않아 문제가 없었고, 틀리면 "column pin_hash does not exist" 오류로 끝나
-- 025b 의 연속 실패 잠금이 기록되지 않았다. 그 부분만 뺀다 (나머지는 025b 와 동일).
-- ============================================================
CREATE OR REPLACE FUNCTION public.rpc_venue_login(p_pin_code text, p_event_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_venue record;
  v_token text;
  v_key text := 'venue_login:' || p_event_id::text;
  v_lock text;
BEGIN
  v_lock := _pin_check_locked(v_key);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_lock);
  END IF;

  SELECT v.* INTO v_venue FROM venues v JOIN venue_pins vp ON vp.venue_id = v.id
  WHERE v.event_id = p_event_id AND vp.pin_plain = p_pin_code;
  IF v_venue IS NULL THEN
    PERFORM _pin_record_fail(v_key, 10, 10);
    RETURN jsonb_build_object('success', false, 'error', '경기장 PIN이 올바르지 않습니다.');
  END IF;
  PERFORM _pin_record_success(v_key);

  UPDATE venue_sessions SET is_active = false
  WHERE venue_id = v_venue.id AND is_active = true;
  INSERT INTO venue_sessions(event_id, venue_id, venue_name, courts)
  VALUES (p_event_id, v_venue.id, v_venue.name, v_venue.courts)
  RETURNING token INTO v_token;
  RETURN jsonb_build_object(
    'success', true,
    'token', v_token,
    'venue_id', v_venue.id,
    'venue_name', v_venue.name,
    'courts', v_venue.courts,
    'event_id', p_event_id,
    'manager_name', v_venue.manager_name,
    'short_name', COALESCE(v_venue.short_name, ''),
    'court_count', COALESCE(v_venue.court_count, array_length(v_venue.courts, 1), 0)
  );
END;
$function$;
