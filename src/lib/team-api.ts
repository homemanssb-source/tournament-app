// ============================================================
// 단체전 Supabase API 함수
// src/lib/team-api.ts
// ============================================================

import { supabase } from './supabase';
import type {
  Club, ClubMember, ClubWithMembers,
  Tie, TieWithClubs, TieRubber,
  TeamStanding, StandingWithClub, TeamLineup,
  LineupEntry, RpcResult, EventTeamConfig,
} from '@/types/team';

// ========================================
// 클럽 CRUD
// ========================================

export async function fetchClubs(eventId: string, divisionId?: string | null): Promise<Club[]> {
  let query = supabase
    .from('clubs')
    .select('*')
    .eq('event_id', eventId);
  if (divisionId) query = query.eq('division_id', divisionId);
  const { data, error } = await query
    .order('seed_number', { ascending: true, nullsFirst: false })
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function fetchClubWithMembers(clubId: string): Promise<ClubWithMembers | null> {
  const { data: club, error: ce } = await supabase
    .from('clubs')
    .select('*')
    .eq('id', clubId)
    .single();
  if (ce) throw ce;
  if (!club) return null;

  const { data: members, error: me } = await supabase
    .from('club_members')
    .select('*')
    .eq('club_id', clubId)
    .order('member_order', { ascending: true, nullsFirst: false })
    .order('name');
  if (me) throw me;

  return { ...club, members: members || [] };
}

export async function fetchClubMembers(clubId: string): Promise<ClubMember[]> {
  const { data, error } = await supabase
    .from('club_members')
    .select('*')
    .eq('club_id', clubId)
    .order('member_order', { ascending: true, nullsFirst: false })
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function createClub(
  eventId: string,
  name: string,
  captainName?: string,
  captainPin?: string,
  seedNumber?: number | null,
): Promise<Club> {
  const { data, error } = await supabase
    .from('clubs')
    .insert({
      event_id: eventId,
      name,
      captain_name: captainName || null,
      captain_pin: captainPin || null,
      seed_number: seedNumber ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateClub(
  clubId: string,
  updates: Partial<Pick<Club, 'name' | 'captain_name' | 'captain_pin' | 'seed_number'>>,
): Promise<Club> {
  const { data, error } = await supabase
    .from('clubs')
    .update(updates)
    .eq('id', clubId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClub(clubId: string): Promise<void> {
  const { error } = await supabase.from('clubs').delete().eq('id', clubId);
  if (error) throw error;
}

export async function addClubMember(
  clubId: string,
  name: string,
  gender?: 'M' | 'F',
  grade?: string,
  isCaptain?: boolean,
): Promise<ClubMember> {
  const { data, error } = await supabase
    .from('club_members')
    .insert({
      club_id: clubId,
      name,
      gender: gender || null,
      grade: grade || null,
      is_captain: isCaptain || false,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function addClubMembersBatch(
  clubId: string,
  members: { name: string; gender?: 'M' | 'F'; grade?: string; is_captain?: boolean; member_order?: number }[],
): Promise<ClubMember[]> {
  const rows = members.map((m, idx) => ({
    club_id: clubId,
    name: m.name,
    gender: m.gender || null,
    grade: m.grade || null,
    is_captain: m.is_captain || false,
    member_order: m.member_order ?? idx + 1,
  }));
  const { data, error } = await supabase
    .from('club_members')
    .insert(rows)
    .select();
  if (error) throw error;
  return data || [];
}

export async function deleteClubMember(memberId: string): Promise<void> {
  const { error } = await supabase.from('club_members').delete().eq('id', memberId);
  if (error) throw error;
}

// ========================================
// 주장(캡틴) 변경
// ========================================

export async function setCaptain(
  clubId: string,
  memberId: string,
): Promise<{ success: boolean; error?: string }> {
  const { error: resetError } = await supabase
    .from('club_members')
    .update({ is_captain: false })
    .eq('club_id', clubId)
    .eq('is_captain', true);
  if (resetError) return { success: false, error: resetError.message };

  const { error: setError } = await supabase
    .from('club_members')
    .update({ is_captain: true })
    .eq('id', memberId)
    .eq('club_id', clubId);
  if (setError) return { success: false, error: setError.message };
  return { success: true };
}

// ========================================
// 대전(Tie) 조회
// ========================================

export async function fetchTies(eventId: string, round?: string, divisionId?: string | null): Promise<TieWithClubs[]> {
  let query = supabase
    .from('ties')
    .select(`
      *,
      club_a:clubs!ties_club_a_id_fkey(*),
      club_b:clubs!ties_club_b_id_fkey(*)
    `)
    .eq('event_id', eventId)
    .order('tie_order');

  if (round) query = query.eq('round', round);
  if (divisionId) query = query.eq('division_id', divisionId);
  if (divisionId) query = query.eq('division_id', divisionId);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as TieWithClubs[];
}

export async function fetchTieWithRubbers(tieId: string) {
  const { data: tie, error: te } = await supabase
    .from('ties')
    .select(`
      *,
      club_a:clubs!ties_club_a_id_fkey(*),
      club_b:clubs!ties_club_b_id_fkey(*)
    `)
    .eq('id', tieId)
    .single();
  if (te) throw te;

  const { data: rubbers, error: re } = await supabase
    .from('tie_rubbers')
    .select('*')
    .eq('tie_id', tieId)
    .order('rubber_number');
  if (re) throw re;

  return { ...tie, rubbers: rubbers || [] };
}

export async function fetchRubbers(tieId: string): Promise<TieRubber[]> {
  const { data, error } = await supabase
    .from('tie_rubbers')
    .select('*')
    .eq('tie_id', tieId)
    .order('rubber_number');
  if (error) throw error;
  return data || [];
}

// ========================================
// 순위 조회
// ========================================

export async function fetchStandings(eventId: string, groupId?: string | null): Promise<StandingWithClub[]> {
  let query = supabase
    .from('team_standings')
    .select(`*, club:clubs(*)`)
    .eq('event_id', eventId);

  if (groupId === null || groupId === undefined) {
    query = query.is('group_id', null);
  } else if (groupId) {
    query = query.eq('group_id', groupId);
  }

  const { data, error } = await query
    .order('rank', { ascending: true, nullsFirst: false })
    .order('won', { ascending: false })
    .order('rubber_diff', { ascending: false });
  if (error) throw error;

  const standings = (data || []) as (TeamStanding & { club: Club })[];
  return standings.map((s) => {
    const isTied = s.rank === null && s.played > 0;
    return { ...s, is_tied: isTied };
  });
}

// ========================================
// 라인업 조회
// ========================================

export async function fetchLineups(tieId: string, clubId: string): Promise<TeamLineup[]> {
  const { data, error } = await supabase
    .from('team_lineups')
    .select('*')
    .eq('tie_id', tieId)
    .eq('club_id', clubId)
    .order('rubber_number');
  if (error) throw error;
  return data || [];
}

export async function fetchRevealedLineups(tieId: string): Promise<TeamLineup[]> {
  const { data, error } = await supabase
    .from('team_lineups')
    .select('*')
    .eq('tie_id', tieId)
    .eq('is_revealed', true)
    .order('rubber_number');
  if (error) throw error;
  return data || [];
}

// ========================================
// RPC 호출
// ========================================

export async function submitLineup(
  tieId: string, clubId: string, captainPin: string, lineups: LineupEntry[],
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_submit_lineup', {
    p_tie_id: tieId,
    p_club_id: clubId,
    p_captain_pin: captainPin,
    p_lineups: lineups,
  });
  if (error) throw error;
  return data as RpcResult;
}

// ✅ divisionId 추가
export async function generateFullLeague(
  eventId: string,
  divisionId?: string,
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_generate_full_league', {
    p_event_id: eventId,
    p_division_id: divisionId || null,
  });
  if (error) throw error;
  return data as RpcResult;
}

// ✅ divisionId 추가
export async function createTeamGroups(
  eventId: string,
  groupCount: number,
  groupSize: number,
  divisionId?: string,
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_create_team_groups', {
    p_event_id: eventId,
    p_group_count: groupCount,
    p_group_size: groupSize,
    p_division_id: divisionId || null,
  });
  if (error) throw error;
  return data as RpcResult;
}

export async function recordRubberScore(
  rubberId: string,
  set1a: number, set1b: number,
  set2a?: number | null, set2b?: number | null,
  set3a?: number | null, set3b?: number | null,
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_admin_record_score', {
    p_rubber_id: rubberId,
    p_set1_a: set1a,
    p_set1_b: set1b,
    p_set2_a: set2a ?? null,
    p_set2_b: set2b ?? null,
    p_set3_a: set3a ?? null,
    p_set3_b: set3b ?? null,
  });
  if (error) throw error;
  return data as RpcResult;
}

export async function pinRecordScore(
  pin: string, rubberId: string,
  set1a: number, set1b: number,
  set2a?: number | null, set2b?: number | null,
  set3a?: number | null, set3b?: number | null,
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_team_pin_score', {
    p_pin: pin,
    p_rubber_id: rubberId,
    p_set1_a: set1a,
    p_set1_b: set1b,
    p_set2_a: set2a ?? null,
    p_set2_b: set2b ?? null,
    p_set3_a: set3a ?? null,
    p_set3_b: set3b ?? null,
  });
  if (error) throw error;
  return data as RpcResult;
}

export async function setManualRank(
  eventId: string, clubId: string, rank: number, notes?: string,
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_set_manual_rank', {
    p_event_id: eventId,
    p_club_id: clubId,
    p_rank: rank,
    p_notes: notes || null,
  });
  if (error) throw error;
  return data as RpcResult;
}

// ✅ divisionId 추가
export async function generateTeamTournament(
  eventId: string,
  seededClubs?: { club_id: string; seed_number: number }[],
  divisionId?: string,
): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_generate_team_tournament', {
    p_event_id: eventId,
    p_division_id: divisionId || null,
    p_seeded_clubs: seededClubs || [],
  });
  if (error) throw error;
  return data as RpcResult;
}

export async function advanceTournamentWinner(tieId: string): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_advance_tournament_winner', {
    p_tie_id: tieId,
  });
  if (error) throw error;
  return data as RpcResult;
}

export async function calculateStandings(eventId: string, groupId?: string | null): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('rpc_calculate_standings', {
    p_event_id: eventId,
    p_group_id: groupId ?? null,
  });
  if (error) throw error;
  return data as RpcResult;
}

// ========================================
// 대회 단체전 설정 조회/수정
// ========================================

export async function fetchEventTeamConfig(eventId: string): Promise<EventTeamConfig | null> {
  const { data, error } = await supabase
    .from('events')
    .select('event_type, team_format, team_rubber_count, team_sets_per_rubber, allow_player_reuse, lineup_mode, team_member_limit, team_match_type')
    .eq('id', eventId)
    .single();
  if (error) throw error;
  return data as EventTeamConfig;
}

export async function updateEventTeamConfig(eventId: string, config: Partial<EventTeamConfig>): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update(config)
    .eq('id', eventId);
  if (error) throw error;
}

// ========================================
// 개인전 결선 결과 연동 (App B → App A)
// ========================================

export async function fetchFinalsMatches(eventId: string) {
  const { data, error } = await supabase
    .from('matches')
    .select(`
      id, match_num, event_id, division_id, division_name,
      stage, round, team_a_id, team_b_id, score,
      winner_team_id, status, ended_at,
      team_a_name, team_b_name, winner_name
    `)
    .eq('event_id', eventId)
    .eq('stage', 'FINALS')
    .eq('status', 'FINISHED')
    .in('round', ['R32', 'R16', 'QF', 'SF', 'F'])
    .order('round')
    .order('slot');

  if (error) throw error;
  return data || [];
}

export async function sendResultsToAppA(
  appAClient: any,
  eventId: string,
  matches: any[],
): Promise<{ success: boolean; synced: number; skipped: number; errors: string[] }> {
  const roundMap: Record<string, string> = {
    'R32': '32', 'R16': '16', 'QF': '8', 'SF': '4', 'F': 'final',
  };

  let synced = 0, skipped = 0;
  const errors: string[] = [];

  for (const m of matches) {
    const { data: existing } = await appAClient
      .from('app_b_match_results')
      .select('id')
      .eq('event_id', eventId)
      .eq('external_match_id', m.id)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    const { error } = await appAClient.from('app_b_match_results').insert([{
      event_id: eventId,
      division_id: m.division_id || null,
      division_name: m.division_name || null,
      round: roundMap[m.round] || m.round,
      match_num: m.match_num || null,
      external_match_id: m.id,
      team_a_name: m.team_a_name || null,
      team_b_name: m.team_b_name || null,
      team_a_id: m.team_a_id || null,
      team_b_id: m.team_b_id || null,
      score: m.score || null,
      winner_name: m.winner_name || null,
      winner_id: m.winner_team_id || null,
      completed_at: m.ended_at || new Date().toISOString(),
    }]);

    if (error) {
      errors.push(`${m.match_num || m.id}: ${error.message}`);
    } else {
      synced++;
    }
  }

  return { success: errors.length === 0, synced, skipped, errors };
}