// ============================================================
// 앱A → 앱B 단체전 데이터 Pull API
// src/app/api/sync/pull-team/route.ts
//
// 앱A의 team_event_entries + team_event_members를
// 앱B의 clubs + club_members에 동기화
// - 클럽 매칭: name + division_id 기준 (부서별 분리)
// ★ 수정: team_match_type 기반 rubber_count 동기화
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

export async function POST(request: NextRequest) {
  try {
    const { event_id, app_a_event_id } = await request.json();
    if (!event_id || !app_a_event_id) {
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id가 필요합니다.' }, { status: 400, headers: corsHeaders });
    }

    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // ★ 신규: 앱A에서 해당 대회의 경기방식 조회
    const { data: appAEvent } = await appA
      .from('events')
      .select('team_match_type')
      .eq('event_id', app_a_event_id)
      .single();

    const teamMatchType = appAEvent?.team_match_type || '3_doubles';
    const rubberCount = teamMatchType === '5_doubles' ? 5 : 3;

    // ★ 신규: 앱B events 테이블에 team_match_type, team_rubber_count 업데이트
    await appB.from('events').update({
      team_match_type: teamMatchType,
      team_rubber_count: rubberCount,
    }).eq('id', event_id);

    // 앱A에서 단체전 엔트리 가져오기
    const { data: entries, error: entriesErr } = await appA
      .from('team_event_entries')
      .select('*')
      .eq('event_id', app_a_event_id)
      .in('status', ['pending', 'confirmed']);

    if (entriesErr) {
      return NextResponse.json({ success: false, error: '앱A 데이터 조회 실패: ' + entriesErr.message }, { status: 500, headers: corsHeaders });
    }

    if (!entries || entries.length === 0) {
      return NextResponse.json({
        success: true,
        message: '동기화할 데이터가 없습니다.',
        synced: 0,
        team_match_type: teamMatchType,
        rubber_count: rubberCount,
      }, { headers: corsHeaders });
    }

    // 앱A 부서 정보 조회
    const { data: appADivisions } = await appA
      .from('event_divisions')
      .select('division_id, division_name')
      .eq('event_id', app_a_event_id);

    const divMap = new Map(
      (appADivisions || []).map(d => [d.division_id, d.division_name])
    );

    // 앱B 부서 조회 (매칭용)
    const { data: appBDivisions } = await appB
      .from('divisions')
      .select('id, name')
      .eq('event_id', event_id);

    // 앱A division_name → 앱B division_id 매핑
    const appBDivByName = new Map(
      (appBDivisions || []).map(d => [d.name, d.id])
    );

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
          .eq('app_a_record_id', entry.id)
          .eq('sync_type', 'team')
          .limit(1);

        if (existingLog && existingLog.length > 0) {
          skippedCount++;
          continue;
        }

        // 부서 정보 결정
        const appADivName = entry.division_name || (entry.division_id ? divMap.get(entry.division_id) : null) || null;
        const appBDivId = appADivName ? appBDivByName.get(appADivName) : null;

        // 클럽 upsert (이름 + 부서 기준)
        let clubQuery = appB
          .from('clubs')
          .select('id')
          .eq('event_id', event_id)
          .eq('name', entry.club_name);

        if (appBDivId) {
          clubQuery = clubQuery.eq('division_id', appBDivId);
        } else if (appADivName) {
          clubQuery = clubQuery.is('division_id', null);
        }

        const { data: existingClub } = await clubQuery.limit(1);

        let clubId: string;

        if (existingClub && existingClub.length > 0) {
          clubId = existingClub[0].id;
          await appB.from('clubs').update({
            captain_name: entry.captain_name,
            captain_pin: entry.captain_pin,
            division_id: appBDivId || undefined,
          }).eq('id', clubId);
        } else {
          const insertData: any = {
            event_id,
            name: entry.club_name,
            captain_name: entry.captain_name,
            captain_pin: entry.captain_pin,
          };
          if (appBDivId) insertData.division_id = appBDivId;

          const { data: newClub, error: clubErr } = await appB
            .from('clubs')
            .insert(insertData)
            .select('id')
            .single();

          if (clubErr) {
            errors.push(`${entry.club_name}${appADivName ? ' (' + appADivName + ')' : ''}: ${clubErr.message}`);
            continue;
          }
          clubId = newClub.id;
        }

        // 멤버 가져오기
        const { data: members, error: membersErr } = await appA
          .from('team_event_members')
          .select('*')
          .eq('entry_id', entry.id)
          .order('member_order');

        if (membersErr) {
          errors.push(`${entry.club_name} members: ${membersErr.message}`);
        }

        // 기존 멤버 삭제 후 재삽입
        await appB.from('club_members').delete().eq('club_id', clubId);

        if (members && members.length > 0) {
          const toGender = (g: string | null | undefined): string | null => {
            if (!g) return null;
            if (g === '남' || g.toUpperCase() === 'M' || g.toLowerCase() === 'male') return 'M';
            if (g === '여' || g.toUpperCase() === 'F' || g.toLowerCase() === 'female') return 'F';
            return null;
          };

          const rows = members.map((m: any, idx: number) => ({
            club_id: clubId,
            name: m.member_name,
            gender: toGender(m.gender),
            grade: m.grade || null,
            is_captain: m.member_name === entry.captain_name,
            member_order: m.member_order || idx + 1,
          }));

          const { error: insertErr } = await appB.from('club_members').insert(rows);
          if (insertErr) {
            errors.push(`${entry.club_name} insert: ${insertErr.message}`);
          }
        }

        // 동기화 로그
        await appB.from('sync_log').insert({
          event_id,
          sync_type: 'team',
          app_a_record_id: entry.id,
          app_b_record_id: clubId,
          app_b_table: 'clubs',
          status: 'synced',
        });

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
      team_match_type: teamMatchType,   // ★ 응답에 경기방식 포함
      rubber_count: rubberCount,        // ★ 응답에 rubber_count 포함
      errors: errors.length > 0 ? errors : undefined,
    }, { headers: corsHeaders });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500, headers: corsHeaders });
  }
}