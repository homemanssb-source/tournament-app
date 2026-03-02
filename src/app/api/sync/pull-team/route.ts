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

export async function POST(request: NextRequest) {
  try {
    const { event_id, app_a_event_id } = await request.json();
    if (!event_id || !app_a_event_id) {
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id가 필요합니다.' }, { status: 400, headers: corsHeaders });
    }
    const appA = getAppAClient();
    const appB = getAppBServiceClient();
    const { data: entries, error: entriesErr } = await appA.from('team_event_entries').select('*').eq('event_id', app_a_event_id).in('status', ['pending', 'confirmed']);
    if (entriesErr) {
      return NextResponse.json({ success: false, error: '앱A 데이터 조회 실패: ' + entriesErr.message }, { status: 500, headers: corsHeaders });
    }
    if (!entries || entries.length === 0) {
      return NextResponse.json({ success: true, message: '동기화할 데이터가 없습니다.', synced: 0 }, { headers: corsHeaders });
    }
    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    for (const entry of entries) {
      try {
        const { data: existingLog } = await appB.from('sync_log').select('id').eq('event_id', event_id).eq('app_a_record_id', entry.id).eq('sync_type', 'team').limit(1);
        if (existingLog && existingLog.length > 0) { skippedCount++; continue; }
        const { data: existingClub } = await appB.from('clubs').select('id').eq('event_id', event_id).eq('name', entry.club_name).limit(1);
        let clubId: string;
        if (existingClub && existingClub.length > 0) {
          clubId = existingClub[0].id;
          await appB.from('clubs').update({ captain_name: entry.captain_name, captain_pin: entry.captain_pin }).eq('id', clubId);
        } else {
          const { data: newClub, error: clubErr } = await appB.from('clubs').insert({ event_id, name: entry.club_name, captain_name: entry.captain_name, captain_pin: entry.captain_pin }).select('id').single();
          if (clubErr) { errors.push(`${entry.club_name}: ${clubErr.message}`); continue; }
          clubId = newClub.id;
        }
        const { data: members } = await appA.from('team_event_members').select('*').eq('entry_id', entry.id).order('member_order');
        await appB.from('club_members').delete().eq('club_id', clubId);
        if (members && members.length > 0) {
          const rows = members.map((m: any, idx: number) => ({ club_id: clubId, name: m.member_name, gender: m.gender || null, grade: m.grade || null, is_captain: m.member_name === entry.captain_name, member_order: m.member_order || idx + 1 }));
          await appB.from('club_members').insert(rows);
        }
        await appB.from('sync_log').insert({ event_id, sync_type: 'team', app_a_record_id: entry.id, app_b_record_id: clubId, app_b_table: 'clubs', status: 'synced' });
        syncedCount++;
      } catch (err: any) { errors.push(`${entry.club_name}: ${err.message}`); }
    }
    return NextResponse.json({ success: true, synced: syncedCount, skipped: skippedCount, total: entries.length, errors: errors.length > 0 ? errors : undefined }, { headers: corsHeaders });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500, headers: corsHeaders });
  }
}