// 대시보드 → 운영자 전용 API 호출 시 로그인 토큰을 붙인다 (서버: src/lib/api-auth.ts)
import { supabase } from '@/lib/supabase';

export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token || ''}`,
  };
}
