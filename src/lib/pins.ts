// 대시보드(로그인 운영자) 전용: PIN 보관 테이블에서 팀·경기장 PIN 을 합쳐 준다.
// teams.pin_plain / venues.pin_plain 은 외부 노출을 막기 위해 비워 두고(025b) team_pins / venue_pins 에 보관한다.
import { supabase } from '@/lib/supabase';

export async function withTeamPins<T extends { id: string; pin_plain?: string | null }>(rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const { data } = await supabase.from('team_pins').select('team_id, pin_plain').in('team_id', rows.map(r => r.id));
  const map = new Map((data || []).map((p: any) => [p.team_id, p.pin_plain]));
  return rows.map(r => ({ ...r, pin_plain: map.get(r.id) ?? r.pin_plain ?? '' }));
}

export async function withVenuePins<T extends { id: string; pin_plain?: string | null }>(rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const { data } = await supabase.from('venue_pins').select('venue_id, pin_plain').in('venue_id', rows.map(r => r.id));
  const map = new Map((data || []).map((p: any) => [p.venue_id, p.pin_plain]));
  return rows.map(r => ({ ...r, pin_plain: map.get(r.id) ?? r.pin_plain ?? '' }));
}
