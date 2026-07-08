-- ============================================================
-- 015: pin_sessions 만료 시간 4시간 → 12시간 연장
--
-- 배경 (2026-07-08 개인전 운영 중 발견):
--   대회 진행 중 어느 시점부터 /pin/matches에서 내 경기 목록이 안 뜸.
--   로그아웃 후 재로그인하면 다시 뜸.
--
-- 진단:
--   1. pin_sessions.expires_at 기본값이 4시간 (01_tables.sql)
--   2. 클라이언트(localStorage)는 세션을 12시간 캐시
--   3. 로그인 4시간 후 rpc_pin_list_matches가
--      'PIN 세션이 만료되었거나 유효하지 않습니다.' 예외를 던짐
--   4. 클라이언트는 한글 만료 메시지를 인증 에러로 인식하지 못하고
--      빈 목록 상태로 15초마다 재시도 → "내 경기 없음" 화면 고착
--   5. 에러 3회 후 /pin으로 이동하지만 localStorage 세션은 남아 있어
--      /pin이 죽은 세션을 복원 → /pin/matches로 다시 보냄 (무한 루프)
--
-- 수정 (2단계):
--   [클라이언트] pin/matches/page.tsx — 만료 감지 시 보관된 PIN으로
--     자동 재로그인 + 실패 시 localStorage까지 완전 삭제
--   [DB — 이 파일] 세션 기본 만료를 12시간으로 연장
--     (대회는 하루 종일 진행되므로 4시간은 너무 짧음.
--      클라이언트 캐시 12시간과 일치시킴)
--
-- 실행: Supabase SQL Editor에서 실행
-- ============================================================

BEGIN;

ALTER TABLE pin_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '12 hours');

-- 현재 진행 중인 활성 세션도 연장 (대회 당일 즉시 효과)
UPDATE pin_sessions
SET expires_at = created_at + interval '12 hours'
WHERE is_active = true
  AND created_at > now() - interval '12 hours';

COMMIT;

-- ============================================================
-- 검증
-- ============================================================
-- 1) 기본값 확인
--   SELECT column_default FROM information_schema.columns
--   WHERE table_name = 'pin_sessions' AND column_name = 'expires_at';
--   기대: (now() + '12:00:00'::interval)
--
-- 2) 활성 세션 만료 시간 확인
--   SELECT token, created_at, expires_at FROM pin_sessions
--   WHERE is_active = true ORDER BY created_at DESC LIMIT 10;
