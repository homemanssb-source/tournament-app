// 045 생성기: 028(rpc_generate_groups) + 044(rpc_generate_tournament) 본문에 최소 수정만 얹는다.
const fs = require('fs')
const MIG = __dirname + '/../migrations/'
const rep = (s, a, b) => { if (s.split(a).length !== 2) throw new Error('match count != 1: ' + a.slice(0, 60)); return s.replace(a, b) }

// ── 1) rpc_generate_groups (028) ──
const m028 = fs.readFileSync(MIG + '028-seed-assignment.sql', 'utf8').replace(/\r\n/g, '\n')
const gStart = m028.indexOf('CREATE OR REPLACE FUNCTION public.rpc_generate_groups(')
const gEnd = m028.indexOf('$function$;', gStart) + '$function$;'.length
const groupsOrig = m028.slice(gStart, gEnd)
let groups = rep(groupsOrig, `  IF v_seed_cnt > 0 THEN
    v_ng := array_length(v_group_sizes, 1);`, `  -- [045] 전체 랭킹제(모든 팀에 시드): 작은 조를 앞 번호 조로 → 상위 시드가 2팀 조(순위 결정전만), 하위 시드가 3팀 조
  IF v_seed_cnt = v_team_count THEN
    SELECT array_agg(s ORDER BY s) INTO v_group_sizes FROM unnest(v_group_sizes) AS s;
  END IF;

  IF v_seed_cnt > 0 THEN
    v_ng := array_length(v_group_sizes, 1);`)

// ── 2) rpc_generate_tournament (044) ──
const m044 = fs.readFileSync(MIG + '044-ranking-seed-second-place.sql', 'utf8').replace(/\r\n/g, '\n')
const tStart = m044.indexOf('CREATE OR REPLACE FUNCTION public.rpc_generate_tournament(')
const tEnd = m044.indexOf('$function$\n;', tStart) + '$function$\n;'.length
const tourOrig = m044.slice(tStart, tEnd)
let t = tourOrig
t = rep(t, `    v_has_seed    boolean;   -- [044] 이 부서에 시드(랭킹)가 지정돼 있는가
  BEGIN`, `    v_has_seed    boolean;   -- [044] 이 부서에 시드(랭킹)가 지정돼 있는가
    v_rank_mode   boolean;   -- [045] 전체 랭킹제(모든 팀 시드 + 조 2위까지 진출) → 새 자리 규칙
    v_bye_seeds   int[] := ARRAY[]::int[];   -- [045] 부전승 칸(시드 번호)
    v_best        int;
    v_best_meet   int;
    v_meet        int;
    v_p           int;
    v_q           int;
    v_cand        int;
    v_tgt         int;       -- [045] 첫 라운드 경기 위치 (아래쪽 절반은 뒤집음)
    v_bye_from    int[] := ARRAY[]::int[];   -- [045] 부전승 받는 1위의 시드 번호
    v_up_b        int := 0;  -- [045] 위쪽 절반 부전승 수
    v_lo_b        int := 0;  -- [045] 아래쪽 절반 부전승 수
    v_is_up       boolean;
  BEGIN`)
t = rep(t, `    SELECT COUNT(*) INTO v_rank1_count FROM _adv WHERE rank = 1;
    SELECT COUNT(*) INTO v_rank2_count FROM _adv WHERE rank = 2;
`, `    SELECT COUNT(*) INTO v_rank1_count FROM _adv WHERE rank = 1;
    SELECT COUNT(*) INTO v_rank2_count FROM _adv WHERE rank = 2;

    -- [045] 전체 랭킹제: 모든 팀에 시드가 있고, 조 1·2위만 진출하고, 부전승 수가 조 수 이하일 때
    v_rank_mode := v_has_seed
      AND NOT EXISTS (SELECT 1 FROM teams WHERE event_id = p_event_id AND division_id = p_division_id AND seed_number IS NULL)
      AND v_advance_count = 2
      AND v_rank1_count + v_rank2_count = v_total_adv
      AND v_byes <= v_rank1_count;
`)
// 1위 배치 뒤: 부전승 칸 결정
t = rep(t, `    -- 2위팀: 같은 조 1위와 반대 절반 배치
    v_upper_avail := ARRAY[]::int[];
    v_lower_avail := ARRAY[]::int[];

    FOR v_i IN (v_rank1_count + 1)..(v_rank1_count + v_rank2_count) LOOP
      SELECT t.idx INTO v_pos`, `    -- [045] 부전승은 3팀 이상 조의 1위에게 (2팀 조 1위는 순위 결정전만 했으므로 제외, 모자랄 때만 2팀 조).
    --   대진표 위·아래 절반에 고르게: 부전승이 적은 절반에서, 그 안에서는 앞 번호 조부터. 부전승 칸 = 그 1위의 맞은편 자리.
    IF v_rank_mode AND v_byes > 0 THEN
      FOR v_i IN 1..v_byes LOOP
        SELECT sm.seed_num INTO v_cand
        FROM _seed_map sm
        WHERE sm.rank = 1 AND NOT (sm.seed_num = ANY(v_bye_from))
        ORDER BY ((SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = sm.group_id) < 3),
                 CASE WHEN (SELECT ceil(tt.idx::float / 2) <= v_num_first_round / 2
                            FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt
                            WHERE tt.val = sm.seed_num) THEN v_up_b ELSE v_lo_b END,
                 sm.seed_num
        LIMIT 1;
        SELECT ceil(tt.idx::float / 2) <= v_num_first_round / 2 INTO v_is_up
        FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt WHERE tt.val = v_cand;
        IF v_is_up THEN v_up_b := v_up_b + 1; ELSE v_lo_b := v_lo_b + 1; END IF;
        v_bye_from  := array_append(v_bye_from, v_cand);
        v_bye_seeds := array_append(v_bye_seeds, v_bracket_size + 1 - v_cand);
      END LOOP;
    END IF;

    -- 2위팀: 같은 조 1위와 반대 절반 배치
    v_upper_avail := ARRAY[]::int[];
    v_lower_avail := ARRAY[]::int[];

    FOR v_i IN (v_rank1_count + 1)..(CASE WHEN v_rank_mode THEN v_bracket_size ELSE v_rank1_count + v_rank2_count END) LOOP
      CONTINUE WHEN v_rank_mode AND v_i = ANY(v_bye_seeds);   -- [045]
      SELECT t.idx INTO v_pos`)
// 반대쪽 절반이 비었을 때: 같은 절반에서 가장 늦게 만나는 자리
const ownUpper = `        ELSE
          IF v_has_seed THEN   -- [044] 가장 뒤 번호(가장 강한 1위와 만나는 자리)부터
            v_target_seed := v_upper_avail[array_length(v_upper_avail,1)];
            v_upper_avail := v_upper_avail[1:array_length(v_upper_avail,1)-1];
          ELSE
            v_target_seed := v_upper_avail[1];
            v_upper_avail := v_upper_avail[2:array_length(v_upper_avail,1)];
          END IF;
        END IF;
      ELSE`
const pick = half => `        ELSIF v_rank_mode THEN
          -- [045] 반대쪽 절반이 다 찼으면 같은 절반에서 같은 조 1위와 가장 늦게 만나는 자리 (같으면 뒤 번호)
          v_best := NULL; v_best_meet := -1;
          FOREACH v_cand IN ARRAY v_${half}_avail LOOP
            SELECT tt.idx INTO v_q FROM (SELECT unnest(v_bp) AS val, generate_series(1, array_length(v_bp, 1)) AS idx) tt WHERE tt.val = v_cand;
            v_p := v_a1_pos - 1; v_q := v_q - 1; v_meet := 0;
            WHILE v_p <> v_q LOOP v_p := v_p / 2; v_q := v_q / 2; v_meet := v_meet + 1; END LOOP;
            IF v_meet > v_best_meet OR (v_meet = v_best_meet AND v_cand > v_best) THEN v_best := v_cand; v_best_meet := v_meet; END IF;
          END LOOP;
          v_target_seed := v_best;
          v_${half}_avail := array_remove(v_${half}_avail, v_best);
`
t = rep(t, ownUpper, pick('upper') + ownUpper)
const ownLower = `        ELSE
          IF v_has_seed THEN   -- [044] 가장 뒤 번호(가장 강한 1위와 만나는 자리)부터
            v_target_seed := v_lower_avail[array_length(v_lower_avail,1)];
            v_lower_avail := v_lower_avail[1:array_length(v_lower_avail,1)-1];
          ELSE
            v_target_seed := v_lower_avail[1];
            v_lower_avail := v_lower_avail[2:array_length(v_lower_avail,1)];
          END IF;
        END IF;
      END IF;

      INSERT INTO _seed_map`
t = rep(t, ownLower, pick('lower') + ownLower)
// 자리 채움: 칸이 차 있는지 판정 + 아래쪽 절반 뒤집기
t = rep(t, `      IF v_seed_num <= v_total_adv THEN
        -- [2] v_r_idx 오용 제거 → v_rank_a 사용`, `      IF (NOT v_rank_mode AND v_seed_num <= v_total_adv)
         OR (v_rank_mode AND EXISTS (SELECT 1 FROM _seed_map sm WHERE sm.seed_num = v_seed_num)) THEN   -- [045]
        -- [2] v_r_idx 오용 제거 → v_rank_a 사용`)
t = rep(t, `        IF v_seed_num <= v_total_adv THEN
          SELECT sm.team_id, sm.group_name, sm.rank
          INTO   v_seed_team_b, v_label_b_val, v_rank_b`, `        IF (NOT v_rank_mode AND v_seed_num <= v_total_adv)
           OR (v_rank_mode AND EXISTS (SELECT 1 FROM _seed_map sm WHERE sm.seed_num = v_seed_num)) THEN   -- [045]
          SELECT sm.team_id, sm.group_name, sm.rank
          INTO   v_seed_team_b, v_label_b_val, v_rank_b`)
t = rep(t, `          qualifier_label_b = v_label_b_val
        WHERE id = v_fm[v_i];`, `          qualifier_label_b = v_label_b_val
        WHERE id = v_fm[v_tgt];`)
t = rep(t, `        v_seed_team_b := NULL; v_label_b_val := NULL; v_rank_b := NULL;
`, `        v_seed_team_b := NULL; v_label_b_val := NULL; v_rank_b := NULL;
        -- [045] 전체 랭킹제: 아래쪽 절반은 경기 순서를 뒤집어 2번 시드(2조 1위)가 대진표 맨 아래 경기에 온다.
        --   이웃한 두 경기가 다음 라운드에서 만나는 구조는 그대로라 누가 언제 만나는지는 바뀌지 않는다.
        v_tgt := v_i;
        IF v_rank_mode AND v_i > v_num_first_round / 2 THEN
          v_tgt := v_num_first_round + v_num_first_round / 2 + 1 - v_i;
        END IF;
`)

const head = `-- ============================================================
-- 045: 전체 랭킹제 부서의 조 크기·부전승·본선 자리 규칙 (개인전)
--
--   적용 대상: 부서의 모든 팀에 시드가 있을 때만 (전체 랭킹제). 시드가 없거나 상위 몇 팀만 시드인 부서,
--              단체전은 지금과 완전히 같다.
--   1) 조편성(rpc_generate_groups): 팀 수가 조 크기로 안 나눠질 때 생기는 작은 조를 앞 번호 조로 둔다.
--        → 상위 시드가 2팀 조(순위 결정전 1경기만), 하위 시드가 3팀 조.   예) 20팀·3팀 조 = 2·3·3·3·3·3·3
--   2) 본선(rpc_generate_tournament, 4-인자) — 조 1·2위 진출이고 부전승 수 ≤ 조 수일 때:
--        a. 조 1위 자리는 지금처럼 조 번호 = 시드 번호 (1조 1위 맨 위 …)
--        b. 부전승은 3팀 이상 조의 1위에게, 대진표 위·아래 절반에 고르게(그 안에서는 앞 번호 조부터).
--           2팀 조 1위는 부전승 없이 조 2위와 첫 경기.
--        c. 조 2위는 같은 조 1위의 반대쪽 절반(044 그대로). 반대쪽이 다 차면 같은 절반에서 가장 늦게 만나는 자리.
--        d. 아래쪽 절반은 경기 순서를 뒤집어 2조 1위가 대진표 맨 아래 경기에 온다 (만나는 라운드는 그대로).
--   028(rpc_generate_groups) · 044(rpc_generate_tournament) 정의 기준, 바뀐 곳은 [045] 표시.
--   데이터·컬럼 변경 없음. 멱등. 되돌리기: 045-rollback.sql
--   ※ 적용 전 라이브 정의가 028·044 와 같은지 확인할 것 (md5(prosrc)).
-- ============================================================

`
fs.writeFileSync(MIG + '045-ranking-seat-rules.sql', head + groups + '\n\n' + t + "\n\nselect '045 applied' as result;\n")
fs.writeFileSync(MIG + '045-rollback.sql', '-- 045 되돌리기: rpc_generate_groups(028) · rpc_generate_tournament(044) 원래 정의\n\n' + groupsOrig + '\n\n' + tourOrig + "\n\nselect '045 rolled back' as result;\n")
// 라이브 대조용: 함수 본문($function$ 사이)의 md5
const crypto = require('crypto')
const body = s => s.slice(s.indexOf('$function$') + '$function$'.length, s.lastIndexOf('$function$'))
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const info = {}
for (const [k, v] of Object.entries({ groups_028: groupsOrig, tour_044: tourOrig, groups_045: groups, tour_045: t })) info[k] = { lf: md5(body(v)), crlf: md5(body(v).replace(/\n/g, '\r\n')), len: body(v).length }
fs.writeFileSync(__dirname + '/045-md5.json', JSON.stringify(info, null, 1))
console.log(JSON.stringify(info, null, 1))
