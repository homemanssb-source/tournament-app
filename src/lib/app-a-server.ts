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

// 앱A 서비스 키가 설정돼 있는지 (키 값은 노출하지 않음)
export function hasAppAServiceKey(): boolean {
  return !!process.env.APP_A_SERVICE_ROLE_KEY
}
