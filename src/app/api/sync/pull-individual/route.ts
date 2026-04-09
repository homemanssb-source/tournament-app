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

    // 4. 앱A event_entries 가져오기
    //    entry_status = '신청' 이고 cancelled_at IS NULL 인 것만
    const { data: allEntries, error: entErr } = await appA
      .from('event_entries')
      .select('*, team:teams(*)')
      .eq('event_id', app_a_event_id)
      .eq('entry_status', '신청')
      .is('cancelled_at', null);
    if (entErr) {
      return NextResponse.json({ success: false, error: 'appA entries 조회 실패: ' + entErr.message }, { status: 500 });
    }
    if (!allEntries || allEntries.length === 0) {
      return NextResponse.json({ success: true, message: '동기화할 데이터 없음', synced: 0, total: 0 });
    }

    // 5. 필요한 member_id 목록 수집 → 한 번에 조회
    const memberIds = new Set<string>();
    for (const entry of allEntries) {
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

    // 6. 앱B 기존 sync_log 한 번에 로드 → Set으로 빠른 중복 체크
    const { data: existingLogs } = await appB
      .from('sync_log')
      .select('app_a_record_id')
      .eq('event_id', event_id)
      .eq('sync_type', 'individual');
    const syncedIds = new Set((existingLogs || []).map((l: any) => l.app_a_record_id));

    // 7. 앱B 기존 teams 한 번에 로드 → player1+player2+division 기준 중복 체크
    const { data: existingTeams } = await appB
      .from('teams')
      .select('player1_name, player2_name, division_id')
      .eq('event_id', event_id);
    const existingTeamKeys = new Set(
      (existingTeams || []).map((t: any) => `${t.division_id}|${t.player1_name}|${t.player2_name}`)
    );

    let syncedCount = 0;
    let skippedCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];
    const unmatched: string[] = [];

    for (const entry of allEntries) {
      try {
        const recordId = entry.entry_id || entry.id || entry.team?.team_id;

        // sync_log 기반 중복 체크
        if (syncedIds.has(recordId)) { skippedCount++; continue; }

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

        // 선수 정보
        const member1 = team.member1_id ? memberMap[team.member1_id] : null;
        const member2 = team.member2_id ? memberMap[team.member2_id] : null;

        const p1Name = member1?.name || '';
        const p2Name = member2?.name || '';
        const p1Club = shortenClub(member1?.club) || null;
        const p2Club = shortenClub(member2?.club) || null;
        const teamName = buildTeamName(p1Name, p1Club, p2Name, p2Club);
        const pinPlain = member1?.pin_code ? String(member1.pin_code) : generatePin();
        const p1Grade = member1?.grade || null;
        const p2Grade = member2?.grade || null;

        // teams 테이블 기반 중복 체크
        const teamKey = `${appBDivisionId}|${p1Name}|${p2Name}`;
        if (existingTeamKeys.has(teamKey)) {
          duplicateCount++;
          await appB.from('sync_log').insert({
            event_id, sync_type: 'individual',
            app_a_record_id: recordId, app_b_record_id: null,
            app_b_table: 'teams', status: 'duplicate',
          });
          continue;
        }

        // 앱B teams insert
        const { data: newTeam, error: teamErr } = await appB
          .from('teams')
          .insert({
            event_id, division_id: appBDivisionId, division_name: divisionName,
            team_name: teamName, player1_name: p1Name, player2_name: p2Name,
            p1_club: p1Club, p2_club: p2Club, pin_plain: pinPlain,
            p1_grade: p1Grade, p2_grade: p2Grade, group_id: null,
          })
          .select('id')
          .single();

        if (teamErr) { errors.push(`팀 생성 실패: ${teamErr.message}`); continue; }

        await appB.from('sync_log').insert({
          event_id, sync_type: 'individual',
          app_a_record_id: recordId, app_b_record_id: newTeam.id,
          app_b_table: 'teams', status: 'synced',
        });

        existingTeamKeys.add(teamKey);
        syncedCount++;

      } catch (e: any) {
        errors.push(e.message);
      }
    }

    return NextResponse.json({
      success:   true,
      synced:    syncedCount,
      skipped:   skippedCount,
      duplicate: duplicateCount,
      total:     allEntries.length,
      unmatched: unmatched.length > 0 ? unmatched : undefined,
      errors:    errors.length > 0 ? errors : undefined,
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
