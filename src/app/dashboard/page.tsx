'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function DashboardHome() {
  const [events, setEvents] = useState<any[]>([])
  const [selectedEvent, setSelectedEvent] = useState('')
  const [stats, setStats] = useState({ teams: 0, groups: 0, matches: 0, finished: 0, divisions: 0 })
  const [teamStats, setTeamStats] = useState({ clubs: 0, ties: 0, tiesFinished: 0, rubbers: 0, rubbersFinished: 0 })
  const [eventType, setEventType] = useState<string>('individual')
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

    const ev = events.find(e => e.id === selectedEvent)
    setEventType(ev?.event_type || 'individual')

    // 개인전 통계
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

    // 단체전 통계
    if (ev?.event_type === 'team' || ev?.event_type === 'both') {
      Promise.all([
        supabase.from('clubs').select('id', { count: 'exact', head: true }).eq('event_id', selectedEvent),
        supabase.from('ties').select('id, status').eq('event_id', selectedEvent),
        supabase.from('rubbers').select('id, status, tie_id')
          .in('tie_id',
            // rubbers는 tie_id로 필터 — ties에서 해당 event의 tie id를 가져옴
            // Supabase에서 서브쿼리 대신 별도 쿼리로 처리
            []
          ),
      ]).then(async ([clubsRes, tiesRes]) => {
        const tieIds = (tiesRes.data || []).map(t => t.id)
        const tiesAll = tiesRes.data || []

        let rubbersAll: any[] = []
        if (tieIds.length > 0) {
          const { data: rData } = await supabase
            .from('rubbers')
            .select('id, status')
            .in('tie_id', tieIds)
          rubbersAll = rData || []
        }

        setTeamStats({
          clubs: clubsRes.count || 0,
          ties: tiesAll.length,
          tiesFinished: tiesAll.filter(t => t.status === 'FINISHED').length,
          rubbers: rubbersAll.length,
          rubbersFinished: rubbersAll.filter(r => r.status === 'FINISHED').length,
        })
      })
    } else {
      setTeamStats({ clubs: 0, ties: 0, tiesFinished: 0, rubbers: 0, rubbersFinished: 0 })
    }
  }, [selectedEvent, events])

  if (loading) return <p className="text-stone-400">불러오는 중...</p>

  const ev = events.find(e => e.id === selectedEvent)
  const showIndiv = eventType === 'individual' || eventType === 'both'
  const showTeam = eventType === 'team' || eventType === 'both'

  const indivCards = [
    { label: '부서', value: stats.divisions, emoji: '🏷️', color: 'bg-blue-50 text-blue-700' },
    { label: '참가팀', value: stats.teams, emoji: '👥', color: 'bg-green-50 text-green-700' },
    { label: '조', value: stats.groups, emoji: '🎯', color: 'bg-purple-50 text-purple-700' },
    { label: '전체 경기', value: stats.matches, emoji: '📋', color: 'bg-amber-50 text-amber-700' },
    { label: '완료 경기', value: stats.finished, emoji: '✅', color: 'bg-tennis-50 text-tennis-700' },
    { label: '진행률', value: stats.matches > 0 ? Math.round(stats.finished / stats.matches * 100) + '%' : '-', emoji: '📊', color: 'bg-red-50 text-red-700' },
  ]

  const teamCards = [
    { label: '클럽', value: teamStats.clubs, emoji: '🏟️', color: 'bg-indigo-50 text-indigo-700' },
    { label: '대전', value: teamStats.ties, emoji: '⚔️', color: 'bg-orange-50 text-orange-700' },
    { label: '대전 완료', value: teamStats.tiesFinished, emoji: '✅', color: 'bg-teal-50 text-teal-700' },
    { label: '개별 경기', value: teamStats.rubbers, emoji: '🎾', color: 'bg-pink-50 text-pink-700' },
    { label: '경기 완료', value: teamStats.rubbersFinished, emoji: '🏆', color: 'bg-emerald-50 text-emerald-700' },
    { label: '진행률', value: teamStats.ties > 0 ? Math.round(teamStats.tiesFinished / teamStats.ties * 100) + '%' : '-', emoji: '📊', color: 'bg-cyan-50 text-cyan-700' },
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
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-lg">{ev.name}</h2>
            {ev.event_type && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                ev.event_type === 'both' ? 'bg-purple-100 text-purple-700' :
                ev.event_type === 'team' ? 'bg-green-100 text-green-700' :
                'bg-blue-100 text-blue-700'
              }`}>
                {ev.event_type === 'both' ? '개인+단체' : ev.event_type === 'team' ? '단체전' : '개인전'}
              </span>
            )}
          </div>
          <p className="text-sm text-stone-500">{ev.date} · {ev.location}</p>
          <p className="text-xs text-stone-400 mt-1">마스터PIN: {ev.master_pin_hash ? '설정됨 🔒' : '미설정'}</p>
        </div>
      )}

      {/* 개인전 통계 */}
      {showIndiv && (
        <>
          <h3 className="text-sm font-semibold text-stone-500 mb-2">🎾 개인전</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            {indivCards.map(c => (
              <div key={c.label} className={`rounded-xl p-4 ${c.color}`}>
                <div className="text-2xl mb-1">{c.emoji}</div>
                <div className="text-2xl font-bold">{c.value}</div>
                <div className="text-xs opacity-70">{c.label}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 단체전 통계 */}
      {showTeam && (
        <>
          <h3 className="text-sm font-semibold text-stone-500 mb-2">📋 단체전</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {teamCards.map(c => (
              <div key={c.label} className={`rounded-xl p-4 ${c.color}`}>
                <div className="text-2xl mb-1">{c.emoji}</div>
                <div className="text-2xl font-bold">{c.value}</div>
                <div className="text-xs opacity-70">{c.label}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}