// ============================================================
// 앱A → 앱B 개인전 데이터 Pull API
// src/app/api/sync/pull-individual/route.ts
//
// 앱A의 event_entries + teams를 앱B의 teams에 동기화
// ============================================================

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

    // 앱A에서 팀(복식 쌍) 가져오기
    const { data: entries, error: err } = await appA
      .from('event_entries')
      .select(`
        *,
        team:teams(*)
      `)
      .eq('event_id', app_a_event_id);

    if (err) {
      return NextResponse.json({ success: false, error: '앱A 조회 실패: ' + err.message }, { status: 500 });
    }

    if (!entries || entries.length === 0) {
      return NextResponse.json({ success: true, message: '동기화할 데이터 없음', synced: 0 });
    }

    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        // 이미 동기화 확인
        const { data: existingLog } = await appB
          .from('sync_log')
          .select('id')
          .eq('event_id', event_id)
          .eq('app_a_record_id', entry.id || entry.team?.id)
          .eq('sync_type', 'individual')
          .limit(1);

        if (existingLog && existingLog.length > 0) {
          skippedCount++;
          continue;
        }

        const team = entry.team;
        if (!team) { skippedCount++; continue; }

        // 앱B teams 테이블에 삽입
        const { data: newTeam, error: teamErr } = await appB
          .from('teams')
          .insert({
            event_id: event_id,
            player1_name: team.player1_name || team.member1_name,
            player2_name: team.player2_name || team.member2_name,
            group_id: null,
          })
          .select('id')
          .single();

        if (teamErr) {
          errors.push(`팀 생성 실패: ${teamErr.message}`);
          continue;
        }

        // 동기화 로그
        await appB.from('sync_log').insert({
          event_id: event_id,
          sync_type: 'individual',
          app_a_record_id: entry.id || team.id,
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
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}