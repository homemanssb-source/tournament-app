// src/lib/app-a-server.ts
// 앱A(jeju-tennis) DB 접속 — 서버(API route) 전용. 클라이언트 컴포넌트에서 import 하지 말 것.
//
// 앱A 는 회원 원본 테이블(PIN·전화번호 등)을 공개 키(anon)로 읽을 수 없게 잠근다(보안 2단계).
// 동기화(가져오기·결과 보내기)는 운영자/크론만 호출하는 서버 경로이므로 앱A service_role 키를 쓴다.
// 키가 아직 설정되지 않은 환경에서는 기존처럼 anon 키로 동작한다.
import { createClient } from '@supabase/supabase-js'

export function getAppAClient() {
  const url = process.env.APP_A_SUPABASE_URL
  const key = process.env.APP_A_SERVICE_ROLE_KEY || process.env.APP_A_ANON_KEY
  if (!url) throw new Error('APP_A_SUPABASE_URL not set')
  if (!key) throw new Error('APP_A_SERVICE_ROLE_KEY / APP_A_ANON_KEY not set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// 앱A 공개(anon) 접속 — 누구나 부르는 공개 API 용.
// 앱A 가 공개로 열어 둔 것(members_public 뷰, get_member_history 등)만 읽히므로 PIN·전화번호는 원천적으로 안 나온다.
export function getAppAPublicClient() {
  const url = process.env.APP_A_SUPABASE_URL
  // anon 키가 없으면 서비스 키로 대신 (호출하는 쪽이 공개 열만 골라 읽으므로 내보내는 정보는 같다)
  const key = process.env.APP_A_ANON_KEY || process.env.APP_A_SERVICE_ROLE_KEY
  if (!url) throw new Error('APP_A_SUPABASE_URL not set')
  if (!key) throw new Error('APP_A_ANON_KEY not set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// 앱A 서비스 키가 설정돼 있는지 (키 값은 노출하지 않음)
export function hasAppAServiceKey(): boolean {
  return !!process.env.APP_A_SERVICE_ROLE_KEY
}
