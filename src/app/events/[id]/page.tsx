'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase, Division, Match, BracketNode } from '@/lib/supabase'
import TournamentBracket from '@/components/TournamentBracket'
import CourtBoard from '@/components/CourtBoard'

type Tab = 'groups' | 'tournament' | 'results' | 'courts'

export default function EventDetailPage() {
  const { id } = useParams()
  const eventId = id as string
  const [event, setEvent] = useState<any>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  const [activeDivision, setActiveDivision] = useState('')
  const [tab, setTab] = useState<Tab>('groups')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      supabase.from('events').select('*').eq('id', eventId).single(),
      supabase.from('divisions').select('*').eq('event_id', eventId).order('sort_order'),
    ]).then(([{ data: ev }, { data: divs }]) => {
      setEvent(ev)
      setDivisions(divs || [])
      if (divs?.length) setActiveDivision(divs[0].id)
      setLoading(false)
    })
  }, [eventId])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-stone-400">불러오는 중...</div>
  if (!event) return <div className="min-h-screen flex items-center justify-center text-stone-400">대회를 찾을 수 없습니다.</div>

  const tabs: { key: Tab; label: string; emoji: string }[] = [
    { key: 'groups', label: '조 게시', emoji: '👥' },
    { key: 'tournament', label: '토너먼트', emoji: '🏆' },
    { key: 'results', label: '경기결과', emoji: '📋' },
    { key: 'courts', label: '코트현황', emoji: '🎾' },
  ]

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-[#2d5016] text-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/events" className="text-white/60 hover:text-white">←</Link>
          <div>
            <h1 className="font-bold text-lg">{event.name}</h1>
            <p className="text-xs text-white/60">{event.date} · {event.location}</p>
          </div>
        </div>

        {/* 부서 탭 */}
        {divisions.length > 1 && tab !== 'courts' && (
          <div className="max-w-5xl mx-auto px-4 flex gap-1 overflow-x-auto pb-2">
            {divisions.map(d => (
              <button key={d.id} onClick={() => setActiveDivision(d.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                  activeDivision === d.id ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'
                }`}>
                {d.name}
              </button>
            ))}
          </div>
        )}

        {/* 뷰 탭 */}
        <div className="max-w-5xl mx-auto px-4 flex border-t border-white/10">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-all ${
                tab === t.key ? 'border-white text-white' : 'border-transparent text-white/50'
              }`}>
              {t.emoji} {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-6">
        {tab === 'groups' && <GroupsView eventId={eventId} divisionId={activeDivision} />}
        {tab === 'tournament' && <TournamentView eventId={eventId} divisionId={activeDivision} />}
        {tab === 'results' && <ResultsView eventId={eventId} divisionId={activeDivision} />}
        {tab === 'courts' && <CourtBoard eventId={eventId} />}
      </main>
    </div>
  )
}

// ===== 조 게시 뷰 =====
function GroupsView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    supabase.from('v_group_board').select('*')
      .eq('event_id', eventId).eq('division_id', divisionId)
      .order('group_num').order('team_num')
      .then(({ data: rows }) => {
        // group by group_id
        const map = new Map<string, { label: string; num: number; teams: any[] }>()
        for (const r of (rows || [])) {
          if (!map.has(r.group_id)) map.set(r.group_id, { label: r.group_label, num: r.group_num, teams: [] })
          map.get(r.group_id)!.teams.push(r)
        }
        setData(Array.from(map.values()).sort((a, b) => a.num - b.num))
        setLoading(false)
      })
  }, [eventId, divisionId])

  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!data.length) return <p className="text-center py-10 text-stone-400">아직 조 편성이 없습니다.</p>

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {data.map(g => (
        <div key={g.label} className="bg-white rounded-xl border overflow-hidden">
          <div className="bg-tennis-600 text-white px-4 py-2 font-bold text-sm">{g.label}</div>
          <div className="p-3">
            {g.teams.map((t: any, i: number) => (
              <div key={t.team_id} className="flex items-center gap-2 py-2 border-b border-stone-100 last:border-0">
                <span className="w-6 h-6 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-500">{i + 1}</span>
                <span className="font-medium text-sm">{t.team_name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ===== 토너먼트 뷰 =====
function TournamentView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    supabase.from('v_bracket_with_details').select('*')
      .eq('event_id', eventId).eq('division_id', divisionId)
      .order('slot')
      .then(({ data }) => { setMatches(data || []); setLoading(false) })
  }, [eventId, divisionId])

  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!matches.length) return <p className="text-center py-10 text-stone-400">아직 본선 토너먼트가 없습니다.</p>

  return <TournamentBracket matches={matches} />
}

// ===== 경기 결과 뷰 =====
function ResultsView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId).eq('division_id', divisionId)
      .order('slot')
      .then(({ data }) => { setMatches(data || []); setLoading(false) })
  }, [eventId, divisionId])

  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>

  const grouped = { GROUP: matches.filter(m => m.stage === 'GROUP'), FINALS: matches.filter(m => m.stage === 'FINALS') }

  return (
    <div className="space-y-8">
      {grouped.GROUP.length > 0 && (
        <section>
          <h3 className="font-bold text-lg mb-3">📋 예선 (조별)</h3>
          <div className="space-y-2">{grouped.GROUP.map(m => <MatchRow key={m.id} m={m} />)}</div>
        </section>
      )}
      {grouped.FINALS.length > 0 && (
        <section>
          <h3 className="font-bold text-lg mb-3">🏆 본선</h3>
          <div className="space-y-2">{grouped.FINALS.filter(m => m.score !== 'BYE').map(m => <MatchRow key={m.id} m={m} />)}</div>
        </section>
      )}
    </div>
  )
}

function MatchRow({ m }: { m: Match }) {
  const done = m.status === 'FINISHED'
  return (
    <div className="bg-white rounded-xl border p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className={`font-bold truncate ${m.winner_team_id === m.team_a_id ? 'text-tennis-700' : ''}`}>
            {m.team_a_name || 'TBD'}
          </span>
          <span className="text-stone-300 flex-shrink-0">vs</span>
          <span className={`font-bold truncate ${m.winner_team_id === m.team_b_id ? 'text-tennis-700' : ''}`}>
            {m.team_b_name || 'TBD'}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-stone-400">
          <span>{m.round}</span>
          {m.group_label && <span>· {m.group_label}</span>}
          {m.court && <span className="px-1.5 py-0.5 rounded bg-[#2d5016]/10 text-[#2d5016] font-medium">{m.court}</span>}
        </div>
      </div>
      <div className="flex-shrink-0 text-right">
        {m.score && m.score !== 'BYE' && <div className="text-sm font-bold">{m.score}</div>}
        <span className={`text-xs px-2 py-0.5 rounded-full ${done ? 'bg-tennis-100 text-tennis-700' : 'bg-stone-100 text-stone-500'}`}>
          {done ? (m.score === 'BYE' ? 'BYE' : '완료') : '대기'}
        </span>
      </div>
    </div>
  )
}
