'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function EventsPage() {
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('events').select('*').order('date', { ascending: false })
      .then(({ data }) => { setEvents(data || []); setLoading(false) })
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
            {events.map(e => (
              <Link key={e.id} href={'/events/' + e.id}
                className="block bg-white rounded-xl border p-4 hover:border-stone-400 transition-all">
                <div className="flex items-center justify-between">
                  <div>
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
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={'text-xs px-2 py-1 rounded-full ' + (e.status === 'active' ? 'bg-green-100 text-green-700' : e.status === 'completed' ? 'bg-stone-100 text-stone-500' : 'bg-amber-100 text-amber-700')}>
                      {e.status === 'active' ? '진행중' : e.status === 'completed' ? '완료' : '준비중'}
                    </span>
                    <span className="text-stone-400">→</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}