// src/app/api/sync/update-clubs/route.ts
// 기존에 sync된 팀들의 p1_club, p2_club, team_name을 앱A에서 가져와 업데이트

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

function shortenClub(club: string | null | undefined): string {
  if (!club) return '';
  return club.replace(/테니스클럽$/, '').replace(/클럽$/, '').replace(/테니스$/, '').trim();
}

function buildTeamName(p1Name: string, p1Club: string | null, p2Name: string, p2Club: string | null): string {
  const p1 = p1Club ? `${p1Name}(${p1Club})` : p1Name;
  const p2 = p2Name ? (p2Club ? `${p2Name}(${p2Club})` : p2Name) : '';
  return p2 ? `${p1}/${p2}` : p1;
}

export async function POST(request: NextRequest) {
  try {
    const { event_id, app_a_event_id } = await request.json();
    if (!event_id || !app_a_event_id) {
      return NextResponse.json({ success: false, error: 'event_id와 app_a_event_id 필요' }, { status: 400 });
    }

    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // 1. 앱B에서 해당 대회의 모든 팀 조회
    const { data: teams, error: teamsErr } = await appB
      .from('teams')
      .select('id, player1_name, player2_name, p1_club, p2_club')
      .eq('event_id', event_id);

    if (teamsErr) {
      return NextResponse.json({ success: false, error: '팀 조회 실패: ' + teamsErr.message }, { status: 500 });
    }
    if (!teams || teams.length === 0) {
      return NextResponse.json({ success: true, updated: 0, message: '팀이 없습니다.' });
    }

    // 2. 앱A에서 선수 이름으로 club 조회
    const playerNames = [...new Set(
      teams.flatMap(t => [t.player1_name, t.player2_name].filter(Boolean))
    )];

    const { data: membersData } = await appA
      .from('members')
      .select('member_id, name, club')
      .in('name', playerNames);

    // 이름 → club 매핑 (동명이인 있을 수 있으므로 첫 번째 매칭 사용)
    const nameClubMap: Record<string, string> = {};
    for (const m of (membersData || [])) {
      if (m.name && !nameClubMap[m.name]) {
        nameClubMap[m.name] = m.club || '';
      }
    }

    // 3. 각 팀 업데이트
    let updatedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const team of teams) {
      // 이미 클럽 정보 있으면 스킵
      if (team.p1_club || team.p2_club) {
        skippedCount++;
        continue;
      }

      const p1Club = shortenClub(nameClubMap[team.player1_name]) || null;
      const p2Club = shortenClub(nameClubMap[team.player2_name]) || null;

      // 클럽 정보가 없으면 스킵
      if (!p1Club && !p2Club) {
        skippedCount++;
        continue;
      }

      const newTeamName = buildTeamName(
        team.player1_name, p1Club,
        team.player2_name, p2Club
      );

      const { error } = await appB
        .from('teams')
        .update({
          p1_club:   p1Club,
          p2_club:   p2Club,
          team_name: newTeamName,
        })
        .eq('id', team.id);

      if (error) {
        errors.push(`${team.player1_name}/${team.player2_name}: ${error.message}`);
      } else {
        updatedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      total:   teams.length,
      updated: updatedCount,
      skipped: skippedCount,
      errors:  errors.length > 0 ? errors : undefined,
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
