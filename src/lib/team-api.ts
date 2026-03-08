// ============================================================
// team-api.ts 수정 함수 3개
// 기존 generateFullLeague, createTeamGroups, generateTeamTournament
// 함수를 아래 내용으로 교체하세요
// ============================================================

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
