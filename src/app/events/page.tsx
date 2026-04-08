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

function fmtDate(d: string) {
  const dt = new Date(d + 'T00:00:00')
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`
}

function DivisionSchedule({ divisions }: { divisions: DivSlim[] }) {
  if (!divisions || divisions.length === 0) return null

  const dated = divisions.filter(d => d.match_date)
  const undated = divisions.filter(d => !d.match_date)
  const uniqueDates = [...new Set(dated.map(d => d.match_date!))].sort()

  // 날짜 지정 없으면 부서명만 간단히
  if (uniqueDates.length === 0) {
    return (
      <div className="flex flex-wrap gap-1 mt-2">
        {divisions.map(d => (
          <span key={d.id} className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-500">
            {d.name}
          </span>
        ))}
      </div>
    )
  }

  // 날짜별 그룹 표시
  return (
    <div className="mt-2 space-y-1">
      {uniqueDates.map(date => {
        const divs = dated.filter(d => d.match_date === date)
        return (
          <div key={date} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-blue-600 shrink-0">{fmtDate(date)}</span>
            <span className="text-xs text-stone-300">·</span>
            {divs.map(d => (
              <span key={d.id} className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                {d.name}
              </span>
            ))}
          </div>
        )
      })}
      {undated.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-stone-400 shrink-0">날짜 미지정</span>
          <span className="text-xs text-stone-300">·</span>
          {undated.map(d => (
            <span key={d.id} className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-500">
              {d.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
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
        ) : events.length === 0 ? (
          <p className="text-center py-20 text-stone-400">등록된 대회가 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {events.map(e => {
              const isPreparing = e.status === 'preparing'

              // ✅ 준비중 → 클릭 불가, 잠금 표시
              if (isPreparing) {
                return (
                  <div key={e.id}
                    className="block bg-stone-50 rounded-xl border border-stone-200 p-4 opacity-60 cursor-not-allowed">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className="font-bold text-lg text-stone-400">{e.name}</h2>
                          {e.event_type && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-400">
                              {e.event_type === 'both' ? '개인+단체' : e.event_type === 'team' ? '단체전' : '개인전'}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-stone-400 mt-1">{e.date} · {e.location}</p>
                        <DivisionSchedule divisions={e.divisions} />
                      </div>
                      <div className="flex items-center gap-2 ml-3 shrink-0">
                        <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                          🔒 준비중
                        </span>
                      </div>
                    </div>
                  </div>
                )
              }

              // 일반 대회
              return (
                <Link key={e.id} href={'/events/' + e.id}
                  className="block bg-white rounded-xl border p-4 hover:border-stone-400 transition-all">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="font-bold text-lg">{e.name}</h2>
                        {e.event_type && (
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            e.event_type === 'both' ? 'bg-purple-100 text-purple-700' :
                            e.event_type === 'team' ? 'bg-green-100 text-green-700' :
                            'bg-blue-100 text-blue-700'
                          }`}>
                            {e.event_type === 'both' ? '개인+단체' : e.event_type === 'team' ? '단체전' : '개인전'}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-stone-500 mt-1">{e.date} · {e.location}</p>
                      <DivisionSchedule divisions={e.divisions} />
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <span className={'text-xs px-2 py-1 rounded-full ' + (e.status === 'active' ? 'bg-green-100 text-green-700' : e.status === 'completed' ? 'bg-stone-100 text-stone-500' : 'bg-amber-100 text-amber-700')}>
                        {e.status === 'active' ? '진행중' : e.status === 'completed' ? '완료' : '준비중'}
                      </span>
                      <span className="text-stone-400">→</span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
