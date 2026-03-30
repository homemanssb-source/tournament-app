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

export async function POST(request: NextRequest) {
  try {
    const { event_id, app_a_event_id } = await request.json();
    if (!event_id || !app_a_event_id) {
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id 필요' }, { status: 400 });
    }

    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // 1. 앱B divisions 로드 (name 기준 매핑용)
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
    const { data: entries, error: entErr } = await appA
      .from('event_entries')
      .select('*, team:teams(*)')
      .eq('event_id', app_a_event_id);
    if (entErr) {
      return NextResponse.json({ success: false, error: 'appA entries 조회 실패: ' + entErr.message }, { status: 500 });
    }
    if (!entries || entries.length === 0) {
      return NextResponse.json({ success: true, message: '동기화할 데이터 없음', synced: 0, total: 0 });
    }

    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    const unmatched: string[] = [];

    for (const entry of entries) {
      try {
        // 중복 확인
        const recordId = entry.entry_id || entry.id || entry.team?.id;
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
          const p1 = team.player1_name || team.member1_name || '';
          const p2 = team.player2_name || team.member2_name || '';
          unmatched.push(`부서 매핑 실패: "${divName}" (${p1}/${p2})`);
          continue;
        }

        // 앱B division_name
        const divisionName = appBDivisions.find(d => d.id === appBDivisionId)?.name || '';

        // 선수 이름
        const p1 = team.player1_name || team.member1_name || '';
        const p2 = team.player2_name || team.member2_name || '';
        const teamName = p2 ? `${p1}/${p2}` : p1;

        // 앱B teams insert
        const { data: newTeam, error: teamErr } = await appB
          .from('teams')
          .insert({
            event_id: event_id,
            division_id: appBDivisionId,
            division_name: divisionName,
            team_name: teamName,
            player1_name: p1,
            player2_name: p2,
            group_id: null,
          })
          .select('id')
          .single();

        if (teamErr) {
          errors.push(`팀 생성 실패: ${teamErr.message}`);
          continue;
        }

        // sync_log 기록
        await appB.from('sync_log').insert({
          event_id: event_id,
          sync_type: 'individual',
          app_a_record_id: recordId,
          app_b_record_id: newTeam.id,
          app_b_table: 'teams',
          status: 'synced',
        });

        syncedCount++;
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    return NextResponse.json({
      success: true,
      synced: syncedCount,
      skipped: skippedCount,
      total: entries.length,
      unmatched: unmatched.length > 0 ? unmatched : undefined,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}