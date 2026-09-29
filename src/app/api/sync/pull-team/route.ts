// ============================================================
// 앱A → 앱B 단체전 데이터 Pull API
// src/app/api/sync/pull-team/route.ts
//
// 앱A의 team_event_entries + team_event_members를
// 앱B의 clubs + club_members에 동기화
// 본체는 src/lib/team-sync.ts (여러 번 돌아도 안전한 갱신 방식)
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { operatorOrCron } from '@/lib/api-auth';
import { createClient } from '@supabase/supabase-js';
import { syncTeamEntries, appATeamSource } from '@/lib/team-sync';

const corsHeaders = {
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
    // 운영자 로그인 또는 Vercel Cron 만 (그동안 인증 없이 누구나 동기화를 실행할 수 있었음)
    if (!(await operatorOrCron(request))) {
      return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });
    }
    const { event_id, app_a_event_id, auto_create_divisions = true } = await request.json();
    if (!event_id || !app_a_event_id) {
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id가 필요합니다.' }, { status: 400, headers: corsHeaders });
    }

    const result = await syncTeamEntries(
      getAppBServiceClient(),
      appATeamSource(getAppAClient(), app_a_event_id),
      event_id,
      { autoCreateDivisions: auto_create_divisions },
    );
    return NextResponse.json(result, { status: result.success ? 200 : 500, headers: corsHeaders });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500, headers: corsHeaders });
  }
}
