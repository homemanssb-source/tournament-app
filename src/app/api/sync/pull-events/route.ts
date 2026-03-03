// ============================================================
// [앱B] 앱A 대회 목록 가져오기 API
// src/app/api/sync/pull-events/route.ts
//
// 앱A events → 앱B events 동기화
// - 앱A event_id를 앱B app_a_event_id에 저장
// - 중복 체크: app_a_event_id 기준
// - 새 대회는 INSERT, 기존 대회는 UPDATE
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

function getAppAClient() {
  const url = 'https://bhvtfptvtepljrohfeic.supabase.co';
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

// 앱A status → 앱B status 매핑
function mapStatus(appAStatus: string): string {
  const s = (appAStatus || '').toUpperCase();
  if (s === 'OPEN' || s === 'ACTIVE') return 'active';
  if (s === 'CLOSED' || s === 'COMPLETED') return 'completed';
  return 'draft';
}

export async function POST(request: NextRequest) {
  try {
    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // 1. 앱A에서 대회 목록 조회
    const { data: appAEvents, error: fetchErr } = await appA
      .from('events')
      .select('event_id, event_name, event_date, event_type, status, description, team_member_limit, team_match_type')
      .order('event_date', { ascending: false });

    if (fetchErr) {
      return NextResponse.json(
        { success: false, error: '앱A 대회 조회 실패: ' + fetchErr.message },
        { status: 500, headers: corsHeaders },
      );
    }

    if (!appAEvents || appAEvents.length === 0) {
      return NextResponse.json(
        { success: true, message: '앱A에 대회가 없습니다.', synced: 0, skipped: 0 },
        { headers: corsHeaders },
      );
    }

    // 2. 앱B에서 이미 연결된 대회 조회
    const { data: existingEvents } = await appB
      .from('events')
      .select('id, app_a_event_id, name');

    const existingMap = new Map(
      (existingEvents || [])
        .filter(e => e.app_a_event_id)
        .map(e => [e.app_a_event_id, e])
    );

    let syncedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    const errors: string[] = [];

    for (const ae of appAEvents) {
      try {
        const existing = existingMap.get(ae.event_id);

        if (existing) {
          // 이미 존재 → 이름/상태 업데이트
          const { error: updateErr } = await appB
            .from('events')
            .update({
              name: ae.event_name,
              date: ae.event_date,
              event_type: ae.event_type || 'individual',
              status: mapStatus(ae.status),
            })
            .eq('id', existing.id);

          if (updateErr) {
            errors.push(`${ae.event_name}: 업데이트 실패 - ${updateErr.message}`);
          } else {
            updatedCount++;
          }
        } else {
          // 신규 대회 → INSERT
          const { error: insertErr } = await appB
            .from('events')
            .insert({
              name: ae.event_name,
              date: ae.event_date,
              event_type: ae.event_type || 'individual',
              status: mapStatus(ae.status),
              location: '',
              app_a_event_id: ae.event_id,
              app_a_connected: true,
            });

          if (insertErr) {
            errors.push(`${ae.event_name}: 추가 실패 - ${insertErr.message}`);
          } else {
            syncedCount++;
          }
        }
      } catch (e: any) {
        errors.push(`${ae.event_name}: ${e.message}`);
      }
    }

    return NextResponse.json({
      success: true,
      synced: syncedCount,
      updated: updatedCount,
      skipped: skippedCount,
      total: appAEvents.length,
      errors: errors.length > 0 ? errors : undefined,
    }, { headers: corsHeaders });

  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500, headers: corsHeaders },
    );
  }
}
