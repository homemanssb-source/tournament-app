// ============================================================
// 앱A → 앱B 단체전 데이터 Pull API
// src/app/api/sync/pull-team/route.ts
//
// 앱A의 team_event_entries + team_event_members를
// 앱B의 clubs + club_members로 동기화
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// 앱A 클라이언트 (읽기 전용)
function getAppAClient() {
  const url = 'https://bhvtfptvtepljrohfeic.supabase.co';
  const key = process.env.APP_A_ANON_KEY;
  if (!key) throw new Error('APP_A_ANON_KEY not set');
  return createClient(url, key);
}

// 앱B 서비스 클라이언트 (쓰기 가능)
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
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id가 필요합니다.' }, { status: 400 });
    }

    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // 1. 앱A에서 단체전 신청 데이터 가져오기
    const { data: entries, error: entriesErr } = await appA
      .from('team_event_entries')
      .select('*')
      .eq('event_id', app_a_event_id)
      .in('status', ['pending', 'confirmed']);

    if (entriesErr) {
      return NextResponse.json({ success: false, error: '앱A 데이터 조회 실패: ' + entriesErr.message }, { status: 500 });
    }

    if (!entries || entries.length === 0) {
      return NextResponse.json({ success: true, message: '동기화할 데이터가 없습니다.', synced: 0 });
    }

    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        // 2. 이미 동기화된 클럽인지 확인 (sync_log 체크)
        const { data: existingLog } = await appB
          .from('sync_log')
          .select('id')
          .eq('event_id', event_id)
          .eq('app_a_record_id', entry.id)
          .eq('sync_type', 'team')
          .limit(1);

        if (existingLog && existingLog.length > 0) {
          skippedCount++;
          continue;
        }

        // 3. 앱B에 같은 이름의 클럽이 이미 있는지 확인
        const { data: existingClub } = await appB
          .from('clubs')
          .select('id')
          .eq('event_id', event_id)
          .eq('name', entry.club_name)
          .limit(1);

        let clubId: string;

        if (existingClub && existingClub.length > 0) {
          // 기존 클럽 업데이트
          clubId = existingClub[0].id;
          await appB.from('clubs').update({
            captain_name: entry.captain_name,
            captain_pin: entry.captain_pin,
          }).eq('id', clubId);
        } else {
          // 새 클럽 생성
          const { data: newClub, error: clubErr } = await appB
            .from('clubs')
            .insert({
              event_id: event_id,
              name: entry.club_name,
              captain_name: entry.captain_name,
              captain_pin: entry.captain_pin,   // 6자리 PIN 그대로 가져옴
            })
            .select('id')
            .single();

          if (clubErr) {
            errors.push(`${entry.club_name}: 클럽 생성 실패 - ${clubErr.message}`);
            continue;
          }
          clubId = newClub.id;
        }

        // 4. 앱A에서 선수 명단 가져오기
        const { data: members, error: membersErr } = await appA
          .from('team_event_members')
          .select('*')
          .eq('entry_id', entry.id)
          .order('member_order');

        if (membersErr) {
          errors.push(`${entry.club_name}: 선수 조회 실패 - ${membersErr.message}`);
          continue;
        }

        // 5. 기존 선수 삭제 후 재입력 (동기화 갱신)
        await appB.from('club_members').delete().eq('club_id', clubId);

        if (members && members.length > 0) {
          const memberRows = members.map((m: any, idx: number) => ({
            club_id: clubId,
            name: m.member_name,
            gender: m.gender || null,
            grade: m.grade || null,
            is_captain: m.member_name === entry.captain_name,
            member_order: m.member_order || idx + 1,
          }));

          const { error: insertErr } = await appB.from('club_members').insert(memberRows);
          if (insertErr) {
            errors.push(`${entry.club_name}: 선수 등록 실패 - ${insertErr.message}`);
            continue;
          }
        }

        // 6. 동기화 로그 기록
        await appB.from('sync_log').insert({
          event_id: event_id,
          sync_type: 'team',
          app_a_record_id: entry.id,
          app_b_record_id: clubId,
          app_b_table: 'clubs',
          status: 'synced',
        });

        // 7. 앱A 쪽 동기화 상태 업데이트 (가능하면)
        try {
          await appA.from('team_event_entries').update({
            synced_to_app_b: true,
            synced_at: new Date().toISOString(),
          }).eq('id', entry.id);
        } catch {
          // 앱A 쓰기 실패해도 앱B 동기화는 성공으로 처리
        }

        syncedCount++;
      } catch (err: any) {
        errors.push(`${entry.club_name}: ${err.message}`);
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
