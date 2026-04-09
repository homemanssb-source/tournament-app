import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAppAClient() {
  const url = process.env.APP_A_SUPABASE_URL!;
  const key = process.env.APP_A_ANON_KEY;
  if (!key) throw new Error('APP_A_ANON_KEY not set');
  return createClient(url, key);
}
function getAppBServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(url, key);
}

function generatePin(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}

// 클럽명 축약: "제주하나클럽" → "제주하나"
function shortenClub(club: string | null | undefined): string {
  if (!club) return '';
  return club.replace(/테니스클럽$/, '').replace(/클럽$/, '').replace(/테니스$/, '').trim();
}

// "홍길동(제주하나)/홍길금(제주아라)" 형식 생성
function buildTeamName(p1Name: string, p1Club: string | null, p2Name: string, p2Club: string | null): string {
  const p1 = p1Name ? (p1Club ? `${p1Name}(${p1Club})` : p1Name) : '';
  const p2 = p2Name ? (p2Club ? `${p2Name}(${p2Club})` : p2Name) : '';
  if (p1 && p2) return `${p1}/${p2}`;
  return p1 || p2;
}

// 삭제/취소로 간주할 team.status 값 목록 (클라이언트 필터)
const EXCLUDED_TEAM_STATUSES = ['deleted', 'cancelled', 'canceled', '삭제', '취소', 'withdrawn'];

export async function POST(request: NextRequest) {
  try {
    const { event_id, app_a_event_id } = await request.json();
    if (!event_id || !app_a_event_id) {
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id 필요' }, { status: 400 });
    }

    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // 1. 앱B divisions 로드
    const { data: appBDivisions, error: divErr } = await appB
      .from('divisions')
      .select('id, name')
      .eq('event_id', event_id);
    if (divErr || !appBDivisions) {
      return NextResponse.json({ success: false, error: 'appB divisions 조회 실패: ' + divErr?.message }, { status: 500 });
    }

    // 2. 앱A event_divisions 로드
    const { data: appADivisions, error: aDivErr } = await appA
      .from('event_divisions')
      .select('division_id, division_name')
      .eq('event_id', app_a_event_id);
    if (aDivErr || !appADivisions) {
      return NextResponse.json({ success: false, error: 'appA divisions 조회 실패: ' + aDivErr?.message }, { status: 500 });
    }

    // 3. 앱A division_id -> 앱B division_id 매핑 (이름 기준)
    const divisionMap: Record<string, string> = {};
    for (const aDiv of appADivisions) {
      const aName = (aDiv.division_name || '').trim().replace(/\s+/g, ' ');
      const matched = appBDivisions.find(b => (b.name || '').trim().replace(/\s+/g, ' ') === aName);
      if (matched) divisionMap[aDiv.division_id] = matched.id;
    }

    // 4. 앱A event_entries + teams 전체 가져오기 (status 컬럼 없으므로 필터 없이 조회)
    const { data: allEntries, error: entErr } = await appA
      .from('event_entries')
      .select('*, team:teams(*)')
      .eq('event_id', app_a_event_id);
    if (entErr) {
      return NextResponse.json({ success: false, error: 'appA entries 조회 실패: ' + entErr.message }, { status: 500 });
    }
    if (!allEntries || allEntries.length === 0) {
      return NextResponse.json({ success: true, message: '동기화할 데이터 없음', synced: 0, total: 0 });
    }

    // 5. 삭제/취소 팀 클라이언트 필터링 (team.status 기준)
    const entries = allEntries.filter((entry: any) => {
      const teamStatus = entry.team?.status;
      if (!teamStatus) return true; // status 컬럼 없으면 포함
      return !EXCLUDED_TEAM_STATUSES.includes(String(teamStatus).toLowerCase());
    });

    const excludedCount = allEntries.length - entries.length;

    // 6. 필요한 member_id 목록 수집 → 한 번에 조회
    const memberIds = new Set<string>();
    for (const entry of entries) {
      if (entry.team?.member1_id) memberIds.add(entry.team.member1_id);
      if (entry.team?.member2_id) memberIds.add(entry.team.member2_id);
    }
    const memberMap: Record<string, any> = {};
    if (memberIds.size > 0) {
      const { data: membersData } = await appA
        .from('members')
        .select('member_id, name, pin_code, grade, club')
        .in('member_id', [...memberIds]);
      for (const m of (membersData || [])) {
        memberMap[m.member_id] = m;
      }
    }

    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    const unmatched: string[] = [];

    for (const entry of entries) {
      try {
        // 중복 확인
        const recordId = entry.entry_id || entry.id || entry.team?.team_id;
        const { data: existingLog } = await appB
          .from('sync_log')
          .select('id')
          .eq('event_id', event_id)
          .eq('app_a_record_id', recordId)
          .eq('sync_type', 'individual')
          .limit(1);
        if (existingLog && existingLog.length > 0) { skippedCount++; continue; }

        const team = entry.team;
        if (!team) { skippedCount++; continue; }

        // division_id 매핑
        const appBDivisionId = entry.division_id ? divisionMap[entry.division_id] : null;
        if (!appBDivisionId) {
          const divName = appADivisions.find(d => d.division_id === entry.division_id)?.division_name || entry.division_id || 'unknown';
          unmatched.push(`부서 매핑 실패: "${divName}" (${team.team_name || ''})`);
          continue;
        }

        const divisionName = appBDivisions.find(d => d.id === appBDivisionId)?.name || '';

        // 선수 정보: members 테이블에서 가져오기
        const member1 = team.member1_id ? memberMap[team.member1_id] : null;
        const member2 = team.member2_id ? memberMap[team.member2_id] : null;

        const p1Name  = member1?.name || '';
        const p2Name  = member2?.name || '';
        const p1Club  = shortenClub(member1?.club) || null;
        const p2Club  = shortenClub(member2?.club) || null;
        // team_name: "홍길동(제주하나)/홍길금(제주아라)" 형식
        const teamName = buildTeamName(p1Name, p1Club, p2Name, p2Club);
        // PIN: member1의 pin_code 사용, 없으면 랜덤 생성
        const pinPlain = member1?.pin_code ? String(member1.pin_code) : generatePin();
        // 등급
        const p1Grade = member1?.grade || null;
        const p2Grade = member2?.grade || null;

        // 앱B teams insert
        const { data: newTeam, error: teamErr } = await appB
          .from('teams')
          .insert({
            event_id:      event_id,
            division_id:   appBDivisionId,
            division_name: divisionName,
            team_name:     teamName,
            player1_name:  p1Name,
            player2_name:  p2Name,
            p1_club:       p1Club,
            p2_club:       p2Club,
            pin_plain:     pinPlain,
            p1_grade:      p1Grade,
            p2_grade:      p2Grade,
            group_id:      null,
          })
          .select('id')
          .single();

        if (teamErr) {
          errors.push(`팀 생성 실패: ${teamErr.message}`);
          continue;
        }

        // sync_log 기록
        await appB.from('sync_log').insert({
          event_id:        event_id,
          sync_type:       'individual',
          app_a_record_id: recordId,
          app_b_record_id: newTeam.id,
          app_b_table:     'teams',
          status:          'synced',
        });

        syncedCount++;
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    return NextResponse.json({
      success:   true,
      synced:    syncedCount,
      skipped:   skippedCount,
      excluded:  excludedCount,
      total:     allEntries.length,
      unmatched: unmatched.length > 0 ? unmatched : undefined,
      errors:    errors.length > 0 ? errors : undefined,
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
