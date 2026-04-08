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

// 목록에 표시할 카드 단위 (날짜별로 분리됨)
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

// 이벤트 → 날짜별 카드 목록으로 분리
function splitEventToCards(e: EventWithDivs): EventCardItem[] {
  const dated = e.divisions.filter(d => d.match_date)
  const uniqueDates = [...new Set(dated.map(d => d.match_date!))].sort()

  // 2일 이상 → 날짜별 카드 분리
  if (uniqueDates.length > 1) {
    return uniqueDates.map(date => ({
      event: e,
      date,
      divisions: dated.filter(d => d.match_date === date),
      isMultiDay: true,
    }))
  }

  // 1일 또는 날짜 미지정 → 카드 1개
  return [{
    event: e,
    date: uniqueDates[0] || null,
    divisions: e.divisions,
    isMultiDay: false,
  }]
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

  // 2일 대회는 날짜별 카드 2개로 분리
  const cards: EventCardItem[] = events.flatMap(e => splitEventToCards(e))

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/" className="text-stone-400 hover:text-stone-600">←</Link>
          <h1 className="text-lg font-bold">🎾 대회 목록</h1>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-6">
        {loading ? (
          <p className="text-center py-20 text-stone-400">불러오는 중...</p>
        ) : cards.length === 0 ? (
          <p className="text-center py-20 text-stone-400">등록된 대회가 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {cards.map((item, idx) => {
              const e = item.event
              const isPreparing = e.status === 'preparing'
              const detailHref = item.date
                ? `/events/${e.id}?date=${item.date}`
                : `/events/${e.id}`

              const cardInner = (
                <div>
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className={`font-bold text-lg ${isPreparing ? 'text-stone-400' : ''}`}>
                          {e.name}
                        </h2>
                        {e.event_type && (
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            isPreparing ? 'bg-stone-100 text-stone-400' :
                            e.event_type === 'both' ? 'bg-purple-100 text-purple-700' :
                            e.event_type === 'team' ? 'bg-green-100 text-green-700' :
                            'bg-blue-100 text-blue-700'
                          }`}>
                            {e.event_type === 'both' ? '개인+단체' : e.event_type === 'team' ? '단체전' : '개인전'}
                          </span>
                        )}
                      </div>
                      {/* 날짜 표시: 2일 대회면 해당 날짜, 아니면 event.date */}
                      <p className={`text-sm mt-1 ${isPreparing ? 'text-stone-400' : 'text-stone-500'}`}>
                        {item.isMultiDay && item.date ? fmtDate(item.date) : e.date} · {e.location}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        isPreparing ? 'bg-amber-100 text-amber-700' :
                        e.status === 'active' ? 'bg-green-100 text-green-700' :
                        e.status === 'completed' ? 'bg-stone-100 text-stone-500' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {isPreparing ? '🔒 준비중' : e.status === 'active' ? '진행중' : e.status === 'completed' ? '완료' : '준비중'}
                      </span>
                      {!isPreparing && <span className="text-stone-400">→</span>}
                    </div>
                  </div>

                  {/* 부서 태그 */}
                  {item.divisions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {item.divisions.map(d => (
                        <span key={d.id} className={`text-xs px-2 py-0.5 rounded-full ${
                          isPreparing ? 'bg-stone-100 text-stone-400' : 'bg-blue-50 text-blue-700'
                        }`}>
                          {d.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )

              if (isPreparing) {
                return (
                  <div key={`${e.id}-${item.date || idx}`}
                    className="block bg-stone-50 rounded-xl border border-stone-200 p-4 opacity-60 cursor-not-allowed">
                    {cardInner}
                  </div>
                )
              }

              return (
                <Link key={`${e.id}-${item.date || idx}`} href={detailHref}
                  className="block bg-white rounded-xl border p-4 hover:border-stone-400 transition-all">
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
