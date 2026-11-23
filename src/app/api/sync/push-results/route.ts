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
import { operatorFromRequest } from '@/lib/api-auth';
import { createClient } from '@supabase/supabase-js';
import { findParticipantOnlyTeams } from '@/lib/participation';
import { getAppAClient } from '@/lib/app-a-server';
import { fetchLeaguePlacements } from '@/lib/league-results';

const corsHeaders = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
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
// 클럽 이름 비교용: 가져오기(pull-individual)의 shortenClub 과 같은 규칙 + 공백 제거
//   앱B 팀에는 줄인 이름("아라")이, 앱A 회원에는 원래 이름("아라클럽")이 들어 있어 그대로 비교하면 항상 어긋남
function clubKey(club: string | null | undefined): string {
  if (!club) return '';
  return club.replace(/테니스클럽$/, '').replace(/클럽$/, '').replace(/테니스$/, '').replace(/s+/g, '').trim();
}

async function findMemberByNameAndClub(
  appA: any,
  playerName: string,
  clubName: string | null,
  entrantIds?: Set<string>,   // 이 대회 앱A 신청서에 있는 회원 ID (동명이인을 가장 확실하게 가림)
): Promise<{ member_id: string; name: string } | null> {
  // 같은 이름(name 또는 display_name)의 회원을 모두 가져옴
  const { data: byName } = await appA
    .from('members')
    .select('member_id, name, display_name, club')
    .or(`name.eq.${playerName},display_name.eq.${playerName}`)
    .neq('status', '삭제');
  const list: any[] = byName || [];
  const pick = (m: any) => ({ member_id: m.member_id, name: m.display_name || m.name });

  // 0차: 같은 이름 가운데 이 대회에 실제로 신청한 회원 (클럽까지 같은 동명이인도 가려짐)
  if (entrantIds && entrantIds.size > 0) {
    const inEvent = list.filter(m => entrantIds.has(m.member_id));
    if (inEvent.length === 1) return pick(inEvent[0]);
    if (inEvent.length > 1) {
      // 동명이인이 둘 다 신청함 → 클럽으로 가림, 그래도 안 되면 실패로 알림
      const key = clubKey(clubName);
      const sameClub = inEvent.filter(m => clubKey(m.club) === key);
      return sameClub.length === 1 ? pick(sameClub[0]) : null;
    }
  }

  // 1차: 이름 + 클럽 (줄인 이름끼리 비교) — 동명이인을 클럽으로 가림
  if (clubName) {
    const key = clubKey(clubName);
    const sameClub = list.filter(m => clubKey(m.club) === key);
    if (sameClub.length === 1) return pick(sameClub[0]);
    if (sameClub.length > 1) return null;   // 같은 클럽에 동명이인 → 잘못 넣지 않고 실패로 알림
  }

  // 2차: 이름만으로 매칭 (1명만 있을 때)
  if (list.length === 1) return pick(list[0]);

  // 매칭 실패
  return null;
}

export async function POST(request: NextRequest) {
  try {
    // 앱A 랭킹 포인트를 쓰는 작업 — 운영자 로그인 필요 (그동안 인증 없이 열려 있었음)
    if (!(await operatorFromRequest(request))) {
      return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401, headers: corsHeaders });
    }
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

    // ── 1-0. 풀리그 부서: 리그 순위로 입상 (경기가 다 끝나고 순위가 다 정해진 부서만) ──
    const league = await fetchLeaguePlacements(appB, event_id);
    const leagueWarnings = [
      ...league.unfinished.map(n => `${n}: 풀리그 경기가 남아 있어 전송하지 않았습니다.`),
      ...league.unresolved.map(n => `${n}: 풀리그 동률 순위를 조편성 화면에서 먼저 지정하세요 (전송 안 함).`),
    ];

    if ((!matches || matches.length === 0) && league.placements.length === 0) {
      return NextResponse.json(
        { success: true, message: '전송할 본선 결과가 없습니다.', synced: 0, warnings: leagueWarnings.length ? leagueWarnings : undefined },
        { headers: corsHeaders },
      );
    }

    // ── 1-1. 본선 순위가 없는 참가팀(예선 탈락 등) → '참가' 포인트 대상 ──
    const { data: allMatches } = await appB
      .from('matches')
      .select('stage, status, score, group_id, division_id, team_a_id, team_b_id')
      .eq('event_id', event_id);

    const placedIds = new Set<string>(
      (matches || []).filter(m => m.round && m.winner_team_id)
        .flatMap(m => [m.team_a_id, m.team_b_id].filter(Boolean) as string[]),
    );
    const participantOnly = findParticipantOnlyTeams(allMatches || [], placedIds);

    // ── 2. 관련 팀 정보 조회 ──
    // ★ 수정: p1_club, p2_club 추가 조회
    const teamIds = [...new Set([
      ...(matches || []).flatMap(m => [m.team_a_id, m.team_b_id].filter(Boolean)),
      ...participantOnly.map(p => p.team_id),
      ...league.placements.map(p => p.team_id),
    ])];
    const { data: teamsData } = await appB
      .from('teams')
      .select('id, player1_name, player2_name, division_name, club_name, p1_club, p2_club')
      .in('id', teamIds);

    const teamMap = new Map((teamsData || []).map(t => [t.id, t]));

    // ── 3. 부서 정보 조회 ──
    const divIds = [...new Set([
      ...(matches || []).map(m => m.division_id),
      ...participantOnly.map(p => p.division_id),
      ...league.placements.map(p => p.division_id),
    ].filter(Boolean))];
    const { data: divsData } = await appB
      .from('divisions')
      .select('id, name')
      .in('id', divIds);

    const divMap = new Map((divsData || []).map(d => [d.id, d.name]));

    // ── 4. 각 팀의 최고 순위 계산 ──
    const teamBestRank = new Map<string, { rank: string; divisionName: string }>();

    for (const match of matches || []) {
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

    // 풀리그 부서: 1위 우승 · 2위 준우승 · 3·4위 4강 · (6팀 이상) 5~8위 8강 · 나머지 참가
    for (const p of league.placements) {
      teamBestRank.set(p.team_id, { rank: p.appA, divisionName: p.division_name });
    }

    // 예선 탈락 등 본선 순위가 없는 팀은 '참가'
    for (const p of participantOnly) {
      if (!teamBestRank.has(p.team_id)) {
        teamBestRank.set(p.team_id, { rank: '참가', divisionName: divMap.get(p.division_id) || '' });
      }
    }

    // ── 5. 앱A에 포인트 규정 조회 ──
    const { data: pointRules } = await appA.from('point_rules').select('*');
    const RANK_MAP: Record<string, string> = {
      '우승': 'points_1', '준우승': 'points_2', '4강': 'points_3',
      '8강': 'points_4', '16강': 'points_5', '32강': 'points_6', '참가': 'points_7',
    };

    // 부서명은 띄어쓰기를 무시하고 비교한다 ('여자베테랑부' = '여자 베테랑부').
    //   2026-11 협회장배: 글자 그대로 비교해서 여자베테랑부 32건이 전부 0점으로 들어갔다.
    const divKey = (s: string | null | undefined) => (s || '').replace(/\s+/g, '');
    const noRuleDivisions = new Set<string>();   // 포인트 규칙이 없는 부서 → 응답에 경고
    function calcPoints(division: string, rank: string): number {
      if (!pointRules) return 0;
      const rule = pointRules.find((r: any) => divKey(r.division) === divKey(division));
      if (!rule) { noRuleDivisions.add(division); return 0; }
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
    let updatedCount = 0;   // 0점으로 들어가 있던 행에 포인트를 채운 수
    const errors: string[] = [];
    const unmatchedPlayers: string[] = [];

    // 이 대회 앱A 신청서의 회원 ID — 동명이인 구분용 (못 불러오면 이름·클럽만으로 매칭)
    const entrantIds = new Set<string>();
    try {
      const { data: ents } = await appA
        .from('event_entries')
        .select('entry_status, cancelled_at, team:teams(member1_id, member2_id)')
        .eq('event_id', app_a_event_id);
      for (const e of (ents || []) as any[]) {
        if (e.cancelled_at) continue;
        if (e.team?.member1_id) entrantIds.add(e.team.member1_id);
        if (e.team?.member2_id) entrantIds.add(e.team.member2_id);
      }
    } catch { /* 신청서를 못 읽어도 전송은 계속 */ }

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
          const member = await findMemberByNameAndClub(appA, player.name, player.club, entrantIds);

          if (!member) {
            unmatchedPlayers.push(`${player.name} (${player.club || '클럽없음'}) - ${divisionName} ${rank}`);
            continue;
          }

          // 중복 체크
          const { data: dup } = await appA
            .from('tournament_results')
            .select('id, points')
            .eq('member_id', member.member_id)
            .eq('tournament_name', tourName)
            .eq('division', divisionName)
            .eq('season_year', seasonYear)
            .limit(1);

          if (dup && dup.length > 0) {
            // 이미 들어간 행이 0점인데 지금은 규칙이 있으면 포인트만 채운다 (규칙을 나중에 만들었거나 부서명이 안 맞았던 경우).
            // 이미 포인트가 있는 행은 건드리지 않는다.
            if (!(dup[0] as any).points && points > 0) {
              const { error: updErr } = await appA.from('tournament_results').update({ points }).eq('id', (dup[0] as any).id);
              if (updErr) errors.push(`${player.name}: ${updErr.message}`);
              else updatedCount++;
            } else {
              skippedCount++;
            }
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

    const allWarnings = [
      ...leagueWarnings,
      ...[...noRuleDivisions].map(d => `'${d}' 부서는 협회 앱에 포인트 규칙이 없어 0점으로 들어갔습니다. 규칙을 만든 뒤 다시 전송하면 포인트가 채워집니다.`),
    ];

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
      updated: updatedCount,
      total: teamBestRank.size * 2,
      unmatched: unmatchedPlayers.length > 0 ? unmatchedPlayers : undefined,
      errors: errors.length > 0 ? errors : undefined,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    }, { headers: corsHeaders });

  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500, headers: corsHeaders },
    );
  }
}
