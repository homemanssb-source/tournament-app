'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase, Event } from '@/lib/supabase'

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([])
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
              <Link key={e.id} href={`/events/${e.id}`}
                className="block bg-white rounded-xl border border-stone-200 p-4 hover:shadow-lg transition-all">
                <h2 className="font-bold text-lg">{e.name}</h2>
                <p className="text-sm text-stone-500 mt-1">
                  {e.date && <span>📅 {e.date}</span>}
                  {e.location && <span className="ml-3">📍 {e.location}</span>}
                </p>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
