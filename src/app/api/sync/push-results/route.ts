// ============================================================
// [앱B] 개인전 본선 결과 → 앱A 전송 API
// src/app/api/sync/push-results/route.ts
//
// 앱B의 FINALS 경기 결과를 앱A의 tournament_results에 전송
// - 토너먼트 라운드로 순위 자동 계산
// - 복식 팀 2명 각각 개별 포인트 부여
// - 이름 + 클럽으로 앱A member 매칭
// ★ 수정: p1_club / p2_club 개별 조회로 동명이인 오매칭 방지
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

// ── 토너먼트 라운드 → 순위 매핑 ──
function getRankFromRound(round: string, isWinner: boolean): string {
  const r = round.toUpperCase().replace(/\s/g, '');

  if (r === 'F' || r === 'FINAL' || r === '결승') {
    return isWinner ? '우승' : '준우승';
  }
  if (r === 'SF' || r === 'SEMIFINAL' || r === '4강' || r === 'R4') {
    return '4강';
  }
  if (r === 'QF' || r === 'QUARTERFINAL' || r === '8강' || r === 'R8') {
    return '8강';
  }
  if (r === 'R16' || r === '16강') {
    return '16강';
  }
  if (r === 'R32' || r === '32강') {
    return '32강';
  }
  return '참가';
}

// ── 각 팀의 최고 순위만 유지 ──
const RANK_PRIORITY: Record<string, number> = {
  '우승': 1, '준우승': 2, '4강': 3, '8강': 4, '16강': 5, '32강': 6, '참가': 7,
};

// ── 앱A에서 이름+클럽으로 회원 매칭 ──
async function findMemberByNameAndClub(
  appA: any,
  playerName: string,
  clubName: string | null,
): Promise<{ member_id: string; name: string } | null> {
  // 1차: 이름 + 클럽 매칭
  if (clubName) {
    const { data } = await appA
      .from('members')
      .select('member_id, name, display_name')
      .eq('name', playerName)
      .eq('club', clubName)
      .neq('status', '삭제')
      .limit(1);

    if (data && data.length === 1) {
      return { member_id: data[0].member_id, name: data[0].display_name || data[0].name };
    }

    // display_name으로도 시도
    const { data: data2 } = await appA
      .from('members')
      .select('member_id, name, display_name')
      .eq('display_name', playerName)
      .eq('club', clubName)
      .neq('status', '삭제')
      .limit(1);

    if (data2 && data2.length === 1) {
      return { member_id: data2[0].member_id, name: data2[0].display_name || data2[0].name };
    }
  }

  // 2차: 이름만으로 매칭 (1명만 있을 때)
  const { data: byName } = await appA
    .from('members')
    .select('member_id, name, display_name')
    .or(`name.eq.${playerName},display_name.eq.${playerName}`)
    .neq('status', '삭제');

  if (byName && byName.length === 1) {
    return { member_id: byName[0].member_id, name: byName[0].display_name || byName[0].name };
  }

  // 매칭 실패
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const { event_id, app_a_event_id, tournament_name, tournament_date } = await request.json();

    if (!event_id || !app_a_event_id) {
      return NextResponse.json(
        { success: false, error: 'event_id와 app_a_event_id가 필요합니다.' },
        { status: 400, headers: corsHeaders },
      );
    }

    const appA = getAppAClient();
    const appB = getAppBServiceClient();

    // ── 1. 앱B에서 본선 경기 조회 ──
    const { data: matches, error: matchErr } = await appB
      .from('matches')
      .select('id, round, status, score, team_a_id, team_b_id, winner_team_id, division_id')
      .eq('event_id', event_id)
      .eq('stage', 'FINALS')
      .eq('status', 'FINISHED');

    if (matchErr) {
      return NextResponse.json(
        { success: false, error: '앱B 경기 조회 실패: ' + matchErr.message },
        { status: 500, headers: corsHeaders },
      );
    }

    if (!matches || matches.length === 0) {
      return NextResponse.json(
        { success: true, message: '전송할 본선 결과가 없습니다.', synced: 0 },
        { headers: corsHeaders },
      );
    }

    // ── 2. 관련 팀 정보 조회 ──
    // ★ 수정: p1_club, p2_club 추가 조회
    const teamIds = [...new Set(matches.flatMap(m => [m.team_a_id, m.team_b_id].filter(Boolean)))];
    const { data: teamsData } = await appB
      .from('teams')
      .select('id, player1_name, player2_name, division_name, club_name, p1_club, p2_club')
      .in('id', teamIds);

    const teamMap = new Map((teamsData || []).map(t => [t.id, t]));

    // ── 3. 부서 정보 조회 ──
    const divIds = [...new Set(matches.map(m => m.division_id).filter(Boolean))];
    const { data: divsData } = await appB
      .from('divisions')
      .select('id, name')
      .in('id', divIds);

    const divMap = new Map((divsData || []).map(d => [d.id, d.name]));

    // ── 4. 각 팀의 최고 순위 계산 ──
    const teamBestRank = new Map<string, { rank: string; divisionName: string }>();

    for (const match of matches) {
      if (!match.round || !match.winner_team_id) continue;

      const loserId = match.team_a_id === match.winner_team_id ? match.team_b_id : match.team_a_id;
      const divName = divMap.get(match.division_id) || '';

      // 승자 순위
      const winnerRank = getRankFromRound(match.round, true);
      const existing = teamBestRank.get(match.winner_team_id);
      if (!existing || RANK_PRIORITY[winnerRank] < RANK_PRIORITY[existing.rank]) {
        teamBestRank.set(match.winner_team_id, { rank: winnerRank, divisionName: divName });
      }

      // 패자 순위
      if (loserId) {
        const loserRank = getRankFromRound(match.round, false);
        const existingLoser = teamBestRank.get(loserId);
        if (!existingLoser || RANK_PRIORITY[loserRank] < RANK_PRIORITY[existingLoser.rank]) {
          teamBestRank.set(loserId, { rank: loserRank, divisionName: divName });
        }
      }
    }

    // ── 5. 앱A에 포인트 규정 조회 ──
    const { data: pointRules } = await appA.from('point_rules').select('*');
    const RANK_MAP: Record<string, string> = {
      '우승': 'points_1', '준우승': 'points_2', '4강': 'points_3',
      '8강': 'points_4', '16강': 'points_5', '32강': 'points_6', '참가': 'points_7',
    };

    function calcPoints(division: string, rank: string): number {
      if (!pointRules) return 0;
      const rule = pointRules.find((r: any) => r.division === division);
      if (!rule) return 0;
      const col = RANK_MAP[rank];
      return col ? (rule[col] || 0) : 0;
    }

    // ── 6. 앱B 이벤트 정보 (대회명, 날짜) ──
    const { data: eventData } = await appB.from('events').select('name, date').eq('id', event_id).single();
    const tourName = tournament_name || eventData?.name || '대회';
    const tourDate = tournament_date || eventData?.date || new Date().toISOString().slice(0, 10);
    const seasonYear = parseInt(tourDate.substring(0, 4)) || new Date().getFullYear();

    // ── 7. tournaments_master upsert (앱A) ──
    const { data: existingTour } = await appA
      .from('tournaments_master')
      .select('tournament_id')
      .eq('tournament_name', tourName)
      .limit(1);

    if (!existingTour || existingTour.length === 0) {
      await appA.from('tournaments_master').insert({
        tournament_name: tourName,
        date: tourDate,
        year: tourDate.substring(0, 4),
      });
    }

    // ── 8. 각 팀의 각 선수를 앱A에 결과 전송 ──
    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    const unmatchedPlayers: string[] = [];

    for (const [teamId, { rank, divisionName }] of teamBestRank) {
      const team = teamMap.get(teamId);
      if (!team) continue;

      const points = calcPoints(divisionName, rank);
      // ★ 수정: player1은 p1_club, player2는 p2_club 사용 (없으면 club_name 폴백)
      const players = [
        { name: team.player1_name, club: team.p1_club || team.club_name },
        { name: team.player2_name, club: team.p2_club || team.club_name },
      ];

      for (const player of players) {
        if (!player.name) continue;

        try {
          // 앱A에서 회원 매칭
          const member = await findMemberByNameAndClub(appA, player.name, player.club);

          if (!member) {
            unmatchedPlayers.push(`${player.name} (${player.club || '클럽없음'}) - ${divisionName} ${rank}`);
            continue;
          }

          // 중복 체크
          const { data: dup } = await appA
            .from('tournament_results')
            .select('id')
            .eq('member_id', member.member_id)
            .eq('tournament_name', tourName)
            .eq('division', divisionName)
            .eq('season_year', seasonYear)
            .limit(1);

          if (dup && dup.length > 0) {
            skippedCount++;
            continue;
          }

          // 결과 삽입
          const { error: insertErr } = await appA.from('tournament_results').insert({
            member_id: member.member_id,
            member_name: member.name,
            tournament_name: tourName,
            date: tourDate,
            season_year: seasonYear,
            division: divisionName,
            rank: rank,
            points: points,
          });

          if (insertErr) {
            errors.push(`${player.name}: ${insertErr.message}`);
          } else {
            syncedCount++;
          }
        } catch (e: any) {
          errors.push(`${player.name}: ${e.message}`);
        }
      }
    }

    // ── 9. 동기화 로그 (앱B) ──
    await appB.from('sync_log').insert({
      event_id,
      sync_type: 'individual',
      app_a_record_id: `push-results-${Date.now()}`,
      app_b_record_id: null,
      app_b_table: 'matches→tournament_results',
      status: errors.length === 0 && unmatchedPlayers.length === 0 ? 'synced' : 'partial',
    });

    return NextResponse.json({
      success: true,
      synced: syncedCount,
      skipped: skippedCount,
      total: teamBestRank.size * 2,
      unmatched: unmatchedPlayers.length > 0 ? unmatchedPlayers : undefined,
      errors: errors.length > 0 ? errors : undefined,
    }, { headers: corsHeaders });

  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500, headers: corsHeaders },
    );
  }
}
