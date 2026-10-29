// src/app/dashboard/bracket-view/page.tsx
// 대진표 보기 (보기 전용) — 보조운영자용. 생성·삭제·채우기는 메인 관리자 화면(/dashboard/teams/bracket)에서만
'use client'
import { useEventId } from '@/components/useDashboard'
import AdminBracketView from '@/components/AdminBracketView'

export default function BracketViewPage() {
  const eventId = useEventId()
  if (!eventId) return <div className="text-center py-10 text-stone-400 text-sm">대회를 선택하세요</div>
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-bold">🏆 대진표 <span className="text-xs font-normal text-stone-400">보기 전용</span></h1>
      <AdminBracketView key={eventId} eventId={eventId} />
    </div>
  )
}
