// ============================================================
// 서버 API 호출자 확인 (service role 로 동작하는 라우트용)
// src/lib/api-auth.ts
//
// - 운영자: Authorization: Bearer <Supabase JWT> + user_profiles.role in (admin, operator)
// - 경기장 관리자: body.venue_token → venue_sessions (활성·미만료·같은 대회)
// - 선수(개인전 PIN): body.pin_token → pin_sessions (활성·미만료·같은 대회)
// 클라이언트 쪽 헤더는 authHeaders() 로 만든다.
// ============================================================
import { NextRequest } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

type Svc = ReturnType<typeof getServiceClient>;

export async function operatorFromRequest(req: NextRequest, svc: Svc = getServiceClient()): Promise<{ id: string; role: string } | null> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const { data } = await svc.auth.getUser(token);
  const uid = data?.user?.id;
  if (!uid) return null;
  const { data: profile } = await svc.from('user_profiles').select('role').eq('id', uid).single();
  const role = (profile as any)?.role;
  return role === 'admin' || role === 'operator' ? { id: uid, role } : null;
}

async function sessionValid(svc: Svc, table: 'venue_sessions' | 'pin_sessions' | 'admin_pin_sessions', token: unknown, eventId: string): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const { data } = await svc.from(table).select('event_id')
    .eq('token', token).eq('is_active', true).gt('expires_at', new Date().toISOString()).maybeSingle();
  return !!data && (data as any).event_id === eventId;
}

// 운영자 또는 그 대회의 경기장/선수/관리자 PIN 세션
export async function callerForEvent(req: NextRequest, body: any, eventId: string, svc: Svc = getServiceClient()): Promise<'operator' | 'venue' | 'pin' | 'admin_pin' | null> {
  if (await operatorFromRequest(req, svc)) return 'operator';
  if (await sessionValid(svc, 'venue_sessions', body?.venue_token, eventId)) return 'venue';
  if (await sessionValid(svc, 'pin_sessions', body?.pin_token, eventId)) return 'pin';
  if (await sessionValid(svc, 'admin_pin_sessions', body?.admin_pin_token, eventId)) return 'admin_pin';
  return null;
}

// Vercel Cron: CRON_SECRET 이 설정돼 있고 헤더가 일치할 때만 (설정이 없으면 항상 거부 — 열어두지 않음)
export function isCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
}

// 운영자 로그인 또는 Cron
export async function operatorOrCron(req: NextRequest): Promise<boolean> {
  return isCronRequest(req) || !!(await operatorFromRequest(req));
}
