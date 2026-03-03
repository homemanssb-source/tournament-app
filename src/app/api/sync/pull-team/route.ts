CREATE OR REPLACE FUNCTION rpc_submit_team_entry(
  p_event_id UUID,
  p_captain_name TEXT,
  p_captain_pin TEXT,
  p_club_name TEXT,
  p_members JSONB,
  p_division_id UUID DEFAULT NULL,
  p_division_name TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_captain RECORD;
  v_entry_id UUID;
  v_member JSONB;
  v_member_record RECORD;
  v_member_limit INT;
  v_member_count INT;
BEGIN
  SELECT * INTO v_captain FROM members
  WHERE name = p_captain_name 
    AND pin_code = p_captain_pin 
    AND status = '활성'
  LIMIT 1;
  IF v_captain IS NULL THEN
    RETURN json_build_object('ok', false, 'message', '대표자 이름 또는 PIN이 일치하지 않습니다.');
  END IF;

  SELECT team_member_limit INTO v_member_limit FROM events WHERE event_id = p_event_id;
  v_member_count := jsonb_array_length(p_members);
  IF v_member_limit IS NOT NULL AND v_member_count > v_member_limit THEN
    RETURN json_build_object('ok', false, 'message', 
      '인원 제한(' || v_member_limit || '명)을 초과했습니다. 현재 ' || v_member_count || '명');
  END IF;

  FOR v_member IN SELECT * FROM jsonb_array_elements(p_members)
  LOOP
    IF (v_member->>'member_id') IS NOT NULL AND (v_member->>'member_id') != '' THEN
      SELECT * INTO v_member_record FROM members
      WHERE member_id = (v_member->>'member_id') AND status = '활성';
      IF v_member_record IS NULL THEN
        RETURN json_build_object('ok', false, 'message',
          (v_member->>'name') || ' 선수는 활성 회원이 아닙니다.');
      END IF;
    ELSE
      RETURN json_build_object('ok', false, 'message',
        (v_member->>'name') || ' 선수는 동호인등록이 되어 있지 않습니다.');
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM team_event_entries
    WHERE event_id = p_event_id AND club_name = p_club_name 
      AND (p_division_id IS NULL OR division_id = p_division_id)
      AND status != 'cancelled'
  ) THEN
    RETURN json_build_object('ok', false, 'message', '이미 해당 클럽으로 신청된 내역이 있습니다.');
  END IF;

  INSERT INTO team_event_entries (event_id, club_name, captain_member_id, captain_name, captain_pin, member_limit, division_id, division_name)
  VALUES (p_event_id, p_club_name, v_captain.member_id, v_captain.name, p_captain_pin, v_member_limit, p_division_id, p_division_name)
  RETURNING id INTO v_entry_id;

  FOR v_member IN SELECT * FROM jsonb_array_elements(p_members)
  LOOP
    INSERT INTO team_event_members (entry_id, member_id, member_name, gender, grade, member_order)
    VALUES (
      v_entry_id,
      v_member->>'member_id',
      v_member->>'name',
      v_member->>'gender',
      v_member->>'grade',
      (v_member->>'order')::INT
    );
  END LOOP;

  RETURN json_build_object('ok', true, 'message', '단체전 참가 신청이 완료되었습니다.', 'entry_id', v_entry_id);
END;
$fn$;