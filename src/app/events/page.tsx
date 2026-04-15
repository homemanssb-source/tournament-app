'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

interface DivSlim {
  id: string
  name: string
  match_date: string | null
  sort_order: number
}

interface EventWithDivs {
  id: string
  name: string
  date: string
  location: string
  status: string
  event_type: string | null
  divisions: DivSlim[]
}

interface EventCardItem {
  event: EventWithDivs
  date: string | null
  divisions: DivSlim[]
  isMultiDay: boolean
}

function fmtDate(d: string) {
  const dt = new Date(d + 'T00:00:00')
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`
}

function splitEventToCards(e: EventWithDivs): EventCardItem[] {
  const dated = e.divisions.filter(d => d.match_date)
  const uniqueDates = [...new Set(dated.map(d => d.match_date!))].sort()
  if (uniqueDates.length > 1) {
    return uniqueDates.map(date => ({
      event: e, date,
      divisions: dated.filter(d => d.match_date === date),
      isMultiDay: true,
    }))
  }
  return [{ event: e, date: uniqueDates[0] || null, divisions: e.divisions, isMultiDay: false }]
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventWithDivs[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('events')
      .select('*, divisions(id, name, match_date, sort_order)')
      .order('date', { ascending: false })
      .then(({ data }) => {
        const evs = (data || []).map((e: any) => ({
          ...e,
          divisions: (e.divisions || []).sort((a: DivSlim, b: DivSlim) => a.sort_order - b.sort_order),
        }))
        setEvents(evs)
        setLoading(false)
      })
  }, [])

  const cards: EventCardItem[] = events.flatMap(e => splitEventToCards(e))

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/" className="text-stone-400 hover:text-stone-600">←</Link>
          <h1 className="text-lg font-bold">대회 목록</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5">
        {loading ? (
          <p className="text-center py-20 text-stone-400">불러오는 중...</p>
        ) : cards.length === 0 ? (
          <p className="text-center py-20 text-stone-400">등록된 대회가 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {cards.map((item, idx) => {
              const e = item.event
              const isPreparing = e.status === 'preparing'
              const isActive = e.status === 'active'
              const isCompleted = e.status === 'completed'
              const detailHref = item.date
                ? `/events/${e.id}?date=${item.date}`
                : `/events/${e.id}`

              // 표시할 날짜
              const displayDate = item.isMultiDay && item.date
                ? fmtDate(item.date)
                : e.date

              // 상태 뱃지
              const statusBadge = isPreparing
                ? <span className="text-xs px-2.5 py-1 rounded-full bg-stone-100 text-stone-400 font-medium">🔒 준비중</span>
                : isActive
                  ? <span className="text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium">진행중</span>
                  : isCompleted
                    ? <span className="text-xs px-2.5 py-1 rounded-full bg-stone-100 text-stone-500 font-medium">완료</span>
                    : <span className="text-xs px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">준비중</span>

              // 종목 뱃지 색
              const typeBadgeClass = isPreparing
                ? 'bg-stone-100 text-stone-400'
                : e.event_type === 'both' ? 'bg-purple-100 text-purple-700'
                : e.event_type === 'team' ? 'bg-emerald-100 text-emerald-700'
                : 'bg-sky-100 text-sky-700'

              const typeLabel = e.event_type === 'both' ? '개인+단체'
                : e.event_type === 'team' ? '단체전'
                : e.event_type === 'individual' ? '개인전'
                : null

              const cardInner = (
                <div className="flex items-center gap-3">
                  {/* 왼쪽: 상태 컬러 바 */}
                  <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${
                    isPreparing ? 'bg-stone-200' :
                    isActive ? 'bg-green-400' :
                    isCompleted ? 'bg-stone-300' : 'bg-amber-300'
                  }`} />

                  {/* 본문 */}
                  <div className="flex-1 min-w-0 py-0.5">
                    {/* 대회명 + 종목뱃지 한 줄 */}
                    <div className="flex items-center gap-2 min-w-0">
                      <h2 className={`font-bold text-base leading-snug truncate ${isPreparing ? 'text-stone-400' : 'text-stone-800'}`}>
                        {e.name}
                      </h2>
                      {typeLabel && (
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap flex-shrink-0 ${typeBadgeClass}`}>
                          {typeLabel}
                        </span>
                      )}
                    </div>

                    {/* 날짜 · 장소 */}
                    <p className={`text-xs mt-0.5 ${isPreparing ? 'text-stone-300' : 'text-stone-400'}`}>
                      {displayDate}{e.location ? ` · ${e.location}` : ''}
                    </p>

                    {/* 부서 태그 */}
                    {item.divisions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {item.divisions.map(d => (
                          <span key={d.id} className={`text-[11px] px-2 py-0.5 rounded-full ${
                            isPreparing ? 'bg-stone-100 text-stone-300' : 'bg-blue-50 text-blue-600'
                          }`}>
                            {d.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 오른쪽: 상태뱃지 + 화살표 */}
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {statusBadge}
                    {!isPreparing && (
                      <span className="text-stone-300 text-sm">→</span>
                    )}
                  </div>
                </div>
              )

              if (isPreparing) {
                return (
                  <div key={`${e.id}-${item.date || idx}`}
                    className="bg-white rounded-2xl border border-stone-100 px-4 py-3 opacity-60 cursor-not-allowed">
                    {cardInner}
                  </div>
                )
              }

              return (
                <Link key={`${e.id}-${item.date || idx}`} href={detailHref}
                  className="block bg-white rounded-2xl border border-stone-200 px-4 py-3 hover:border-[#2d5016] hover:shadow-sm transition-all active:scale-[0.99]">
                  {cardInner}
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
