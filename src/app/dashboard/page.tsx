'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function DashboardHome() {
  const [events, setEvents] = useState<any[]>([])
  const [selectedEvent, setSelectedEvent] = useState('')
  const [stats, setStats] = useState({ teams: 0, groups: 0, matches: 0, finished: 0, divisions: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('events').select('*').order('date', { ascending: false })
      .then(({ data }) => {
        setEvents(data || [])
        const stored = sessionStorage.getItem('dashboard_event_id')
        const first = stored && data?.find(e => e.id === stored) ? stored : data?.[0]?.id || ''
        setSelectedEvent(first)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!selectedEvent) return
    sessionStorage.setItem('dashboard_event_id', selectedEvent)

    Promise.all([
      supabase.from('divisions').select('id', { count: 'exact', head: true }).eq('event_id', selectedEvent),
      supabase.from('teams').select('id', { count: 'exact', head: true }).eq('event_id', selectedEvent),
      supabase.from('groups').select('id', { count: 'exact', head: true }).eq('event_id', selectedEvent),
      supabase.from('matches').select('id, status').eq('event_id', selectedEvent),
    ]).then(([divs, teams, groups, matches]) => {
      const all = matches.data || []
      setStats({
        divisions: divs.count || 0,
        teams: teams.count || 0,
        groups: groups.count || 0,
        matches: all.length,
        finished: all.filter(m => m.status === 'FINISHED').length,
      })
    })
  }, [selectedEvent])

  if (loading) return <p className="text-stone-400">불러오는 중...</p>

  const ev = events.find(e => e.id === selectedEvent)

  const cards = [
    { label: '부서', value: stats.divisions, emoji: '🏷️', color: 'bg-blue-50 text-blue-700' },
    { label: '참가팀', value: stats.teams, emoji: '👥', color: 'bg-green-50 text-green-700' },
    { label: '조', value: stats.groups, emoji: '🎯', color: 'bg-purple-50 text-purple-700' },
    { label: '전체 경기', value: stats.matches, emoji: '📋', color: 'bg-amber-50 text-amber-700' },
    { label: '완료 경기', value: stats.finished, emoji: '✅', color: 'bg-tennis-50 text-tennis-700' },
    { label: '진행률', value: stats.matches > 0 ? Math.round(stats.finished / stats.matches * 100) + '%' : '-', emoji: '📊', color: 'bg-red-50 text-red-700' },
  ]

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">🏠 대시보드</h1>
        {events.length > 1 && (
          <select value={selectedEvent} onChange={e => setSelectedEvent(e.target.value)}
            className="border border-stone-300 rounded-lg px-3 py-1.5 text-sm">
            {events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
      </div>

      {ev && (
        <div className="bg-white rounded-xl border p-4 mb-6">
          <h2 className="font-bold text-lg">{ev.name}</h2>
          <p className="text-sm text-stone-500">{ev.date} · {ev.location}</p>
          <p className="text-xs text-stone-400 mt-1">마스터PIN: {ev.master_pin_hash ? '설정됨 🔒' : '미설정'}</p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cards.map(c => (
          <div key={c.label} className={`rounded-xl p-4 ${c.color}`}>
            <div className="text-2xl mb-1">{c.emoji}</div>
            <div className="text-2xl font-bold">{c.value}</div>
            <div className="text-xs opacity-70">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
