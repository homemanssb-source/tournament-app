// ============================================================
// src/app/pin/team/page.tsx
// 러버 PIN 점수 입력은 사용하지 않음 (2026-09 주장 PIN 보안 작업에서 끔 — migration 022b)
// 단체전 점수는 주장 라인업 페이지(/lineup/[tie_id]) 또는 운영본부(대시보드·관리자 PIN)에서 입력한다.
// ============================================================
import Link from 'next/link';

export default function TeamPinScorePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-sm w-full bg-white rounded-xl border p-6 text-center space-y-3">
        <div className="text-3xl">🎾</div>
        <h1 className="font-bold text-lg">러버 PIN 점수 입력은 사용하지 않습니다</h1>
        <p className="text-sm text-gray-500">
          단체전 점수는 주장 PIN으로 라인업 화면에서 입력하거나, 운영본부에 알려주세요.
        </p>
        <Link href="/pin" className="inline-block bg-blue-600 text-white px-4 py-2 rounded-lg text-sm">주장 로그인으로</Link>
      </div>
    </div>
  );
}
