// ============================================================
// [앱B] 앱A 대회 목록 + 부서 가져오기 API
// src/app/api/sync/pull-events/route.ts
//
// 앱A events → 앱B events 동기화
// 앱A event_divisions → 앱B divisions 동기화
// ★ 수정: team_match_type 동기화 추가
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

function mapStatus(appAStatus: string): string {
  const s = (appAStatus || '').toUpperCase();
  if (s === 'OPEN' || s === 'ACTIVE') return 'active';
  if (s === 'CLOSED' || s === 'COMPLETED') return 'completed';
  return 'draft';
}

// ★ 신규: team_match_type → rubber_count 매핑
function getRubberCount(teamMatchType: string | null): number {
  if (teamMatchType === '5_doubles') return 5;
  return 3; // 기본값
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
    let divisionsSynced = 0;
    const errors: string[] = [];

    for (const ae of appAEvents) {
      try {
        const existing = existingMap.get(ae.event_id);
        let appBEventId: string;

        if (existing) {
          appBEventId = existing.id;
          // ★ 수정: team_match_type, team_rubber_count 업데이트 추가
          const { error: updateErr } = await appB
            .from('events')
            .update({
              name: ae.event_name,
              date: ae.event_date,
              event_type: ae.event_type || 'individual',
              status: mapStatus(ae.status),
              team_match_type: ae.team_match_type || null,
              team_rubber_count: getRubberCount(ae.team_match_type),
            })
            .eq('id', existing.id);

          if (updateErr) {
            errors.push(`${ae.event_name}: 업데이트 실패 - ${updateErr.message}`);
            continue;
          }
          updatedCount++;
        } else {
          // ★ 수정: team_match_type, team_rubber_count 삽입 추가
          const { data: newEvent, error: insertErr } = await appB
            .from('events')
            .insert({
              name: ae.event_name,
              date: ae.event_date,
              event_type: ae.event_type || 'individual',
              status: mapStatus(ae.status),
              location: '',
              app_a_event_id: ae.event_id,
              app_a_connected: true,
              team_match_type: ae.team_match_type || null,
              team_rubber_count: getRubberCount(ae.team_match_type),
            })
            .select('id')
            .single();

          if (insertErr || !newEvent) {
            errors.push(`${ae.event_name}: 추가 실패 - ${insertErr?.message}`);
            continue;
          }
          appBEventId = newEvent.id;
          syncedCount++;
        }

        // 3. 해당 대회의 부서(divisions) 동기화
        const { data: appADivs } = await appA
          .from('event_divisions')
          .select('division_id, division_name')
          .eq('event_id', ae.event_id)
          .order('created_at');

        if (appADivs && appADivs.length > 0) {
          // 앱B에 이미 있는 부서 조회
          const { data: existingDivs } = await appB
            .from('divisions')
            .select('id, name')
            .eq('event_id', appBEventId);

          const existingDivNames = new Set(
            (existingDivs || []).map(d => d.name)
          );

          for (let i = 0; i < appADivs.length; i++) {
            const div = appADivs[i];
            if (existingDivNames.has(div.division_name)) continue;

            const { error: divErr } = await appB
              .from('divisions')
              .insert({
                event_id: appBEventId,
                name: div.division_name,
                sort_order: i + 1,
              });

            if (divErr) {
              errors.push(`${ae.event_name} 부서 ${div.division_name}: ${divErr.message}`);
            } else {
              divisionsSynced++;
            }
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
      divisionsSynced,
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