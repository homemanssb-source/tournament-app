import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ── 앱B 서비스 롤 (서버사이드 API Route 전용) ──
export function getServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey);
}

// ── 앱A 읽기 전용 클라이언트 (연동용) ──
export function getAppAClient() {
  const appAAnonKey = process.env.APP_A_ANON_KEY;
  if (!appAAnonKey) throw new Error('APP_A_ANON_KEY not set');
  return createClient(process.env.APP_A_SUPABASE_URL!, appAAnonKey);
}

// ============================================================
// Types (기존 개인전)
// ============================================================
export interface Event {
  id: string; event_key: string; name: string; date: string; location: string; status: string
}

export interface Division {
  id: string; event_id: string; name: string; sort_order: number
}

export interface Team {
  id: string; team_num: string; team_name: string; player1_name: string; player2_name: string
  division_name: string; division_id: string; event_id: string; pin_plain?: string; group_id?: string
}

export interface Group {
  id: string; event_id: string; division_id: string; division_name: string
  group_label: string; group_num: number; advance_count: number
}

export interface Match {
  id: string; match_num: string; event_id: string; division_id: string; division_name: string
  stage: 'GROUP' | 'FINALS'; round: string; slot: number; group_id?: string
  team_a_id?: string; team_b_id?: string; score?: string; winner_team_id?: string
  status: 'PENDING' | 'IN_PROGRESS' | 'FINISHED'; court?: string
  locked_by_participant: boolean; ended_at?: string
  // joined
  team_a_name?: string; team_b_name?: string; winner_name?: string; group_label?: string
}

export interface BracketNode {
  id: string; division_name: string; round: string; match_id: string
  next_match_id?: string; next_slot?: 'A' | 'B'
  seed_a_team_id?: string; seed_b_team_id?: string; lock: boolean
  // joined from v_bracket_with_details
  team_a_name?: string; team_b_name?: string; winner_name?: string
  score?: string; status?: string; team_a_id?: string; team_b_id?: string; winner_team_id?: string
  slot?: number
}