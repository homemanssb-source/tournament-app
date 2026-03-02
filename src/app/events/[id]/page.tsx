// ============================================================
// 대회 보기 (개인전 + 단체전 항상 모두 표시)
// src/app/events/[id]/page.tsx
// ============================================================
'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase, Division, Match } from '@/lib/supabase'
import TournamentBracket from '@/components/TournamentBracket'
import CourtBoard from '@/components/CourtBoard'
import { fetchClubs, fetchTies, fetchStandings, fetchEventTeamConfig } from '@/lib/team-api'
import { getFormatLabel, getRoundLabel, getTieStatusLabel, getTieStatusColor, getMajority } from '@/lib/team-utils'
import type { Club, TieWithClubs, StandingWithClub, EventTeamConfig } from '@/types/team'

type Mode = 'individual' | 'team'
type IndividualTab = 'groups' | 'tournament' | 'results' | 'courts'
type TeamTab = 'standings' | 'matches' | 'bracket' | 'courts'

export default function EventDetailPage() {
  const { id } = useParams()
  const eventId = id as string
  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('individual')

  // 개인전
  const [divisions, setDivisions] = useState<Division[]>([])
  const [activeDivision, setActiveDivision] = useState('')
  const [iTab, setITab] = useState<IndividualTab>('groups')

  // 단체전
  const [tTab, setTTab] = useState<TeamTab>('standings')
  const [teamConfig, setTeamConfig] = useState<EventTeamConfig | null>(null)
  const [clubs, setClubs] = useState<Club[]>([])
  const [ties, setTies] = useState<TieWithClubs[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [standingsMap, setStandingsMap] = useState<Record<string, StandingWithClub[]>>({})

  useEffect(() => {
    (async () => {
      const { data: ev } = await supabase.from('events').select('*').eq('id', eventId).single()
      setEvent(ev)

      // 개인전 데이터
      const { data: divs } = await supabase.from('divisions').select('*').eq('event_id', eventId).order('sort_order')
      setDivisions(divs || [])
      if (divs?.length) setActiveDivision(divs[0].id)

      // 단체전 데이터 (항상 로드)
      await loadTeamData()
      setLoading(false)
    })()
  }, [eventId])

  const loadTeamData = useCallback(async () => {
    const [cfg, clubList, tieList] = await Promise.all([
      fetchEventTeamConfig(eventId), fetchClubs(eventId), fetchTies(eventId),
    ])
    setTeamConfig(cfg); setClubs(clubList); setTies(tieList)
    const map: Record<string, StandingWithClub[]> = {}
    if (cfg?.team_format === 'full_league') {
      map['full'] = await fetchStandings(eventId, null)
    } else {
      const { data: grps } = await supabase.from('groups').select('*').eq('event_id', eventId).order('group_num')
      setGroups(grps || [])
      for (const g of (grps || [])) { map[g.id] = await fetchStandings(eventId, g.id) }
    }
    setStandingsMap(map)
  }, [eventId])

  // 단체전 30초 자동 갱신
  useEffect(() => {
    if (mode !== 'team') return
    const interval = setInterval(loadTeamData, 30000)
    return () => clearInterval(interval)
  }, [mode, loadTeamData])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-stone-400">불러오는 중...</div>
  if (!event) return <div className="min-h-screen flex items-center justify-center text-stone-400">대회를 찾을 수 없습니다.</div>

  const individualTabs: { key: IndividualTab; label: string; emoji: string }[] = [
    { key: 'groups', label: '조 게시', emoji: '👥' },
    { key: 'tournament', label: '토너먼트', emoji: '🏆' },
    { key: 'results', label: '경기결과', emoji: '📋' },
    { key: 'courts', label: '코트현황', emoji: '🎾' },
  ]
  const teamTabs: { key: TeamTab; label: string; emoji: string }[] = [
    { key: 'standings', label: '순위', emoji: '📊' },
    { key: 'matches', label: '대전', emoji: '⚔️' },
    { key: 'bracket', label: '토너먼트', emoji: '🏅' },
    { key: 'courts', label: '코트', emoji: '🎾' },
  ]

  const liveTies = ties.filter(t => t.status === 'in_progress')

  return (
    <div className="min-h-screen">
      <header className="bg-[#2d5016] text-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/events" className="text-white/60 hover:text-white">←</Link>
          <div className="flex-1">
            <h1 className="font-bold text-lg">{event.name}</h1>
            <p className="text-xs text-white/60">{event.date} · {event.location}</p>
          </div>
        </div>

        {/* 개인전 / 단체전 모드 전환 (항상 표시) */}
        <div className="max-w-5xl mx-auto px-4 flex gap-2 pb-2">
          <button onClick={() => setMode('individual')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${mode === 'individual' ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'}`}>
            🎾 개인전</button>
          <button onClick={() => setMode('team')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${mode === 'team' ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'}`}>
            📋 단체전</button>
        </div>

        {/* 개인전 부서 탭 */}
        {mode === 'individual' && divisions.length > 1 && iTab !== 'courts' && (
          <div className="max-w-5xl mx-auto px-4 flex gap-1 overflow-x-auto pb-2">
            {divisions.map(d => (
              <button key={d.id} onClick={() => setActiveDivision(d.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                  activeDivision === d.id ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'
                }`}>{d.name}</button>
            ))}
          </div>
        )}

        {/* 뷰 탭 */}
        <div className="max-w-5xl mx-auto px-4 flex border-t border-white/10">
          {mode === 'individual' ? (
            individualTabs.map(t => (
              <button key={t.key} onClick={() => setITab(t.key)}
                className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-all ${
                  iTab === t.key ? 'border-white text-white' : 'border-transparent text-white/50'
                }`}>{t.emoji} {t.label}</button>
            ))
          ) : (
            teamTabs.map(t => (
              <button key={t.key} onClick={() => setTTab(t.key)}
                className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-all ${
                  tTab === t.key ? 'border-white text-white' : 'border-transparent text-white/50'
                }`}>{t.emoji} {t.label}</button>
            ))
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* ═══ 개인전 ═══ */}
        {mode === 'individual' && (<>
          {iTab === 'groups' && <GroupsView eventId={eventId} divisionId={activeDivision} />}
          {iTab === 'tournament' && <TournamentView eventId={eventId} divisionId={activeDivision} />}
          {iTab === 'results' && <ResultsView eventId={eventId} divisionId={activeDivision} />}
          {iTab === 'courts' && <CourtBoard eventId={eventId} />}
        </>)}

        {/* ═══ 단체전 ═══ */}
        {mode === 'team' && (<>
          {liveTies.length > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-6">
              <h2 className="font-semibold text-green-800 mb-2">🔴 진행중</h2>
              <div className="space-y-2">
                {liveTies.map(tie => (
                  <div key={tie.id} className="bg-white rounded-lg p-3 flex items-center justify-between">
                    <div>
                      <span className="font-medium">{tie.club_a?.name}</span>
                      <span className="text-gray-400 mx-2">vs</span>
                      <span className="font-medium">{tie.club_b?.name}</span>
                      {tie.court_number && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded ml-2">코트 {tie.court_number}</span>}
                    </div>
                    <span className="text-lg font-bold text-green-700">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tTab === 'standings' && <TeamStandingsView standingsMap={standingsMap} groups={groups} />}
          {tTab === 'matches' && <TeamMatchesView ties={ties} />}
          {tTab === 'bracket' && <TeamBracketView ties={ties} />}
          {tTab === 'courts' && <TeamCourtsView ties={ties} />}

          <div className="text-center mt-6">
            <button onClick={loadTeamData} className="text-sm text-gray-400 hover:text-gray-600">🔄 새로고침</button>
            <p className="text-xs text-gray-300 mt-1">30초마다 자동 갱신</p>
          </div>
        </>)}
      </main>
    </div>
  )
}

// ═══════════════════════════════════════
// 개인전 뷰
// ═══════════════════════════════════════
function GroupsView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [data, setData] = useState<any[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    supabase.from('v_group_board').select('*').eq('event_id', eventId).eq('division_id', divisionId)
      .order('group_num').order('team_num')
      .then(({ data: rows }) => {
        const map = new Map<string, { label: string; num: number; teams: any[] }>()
        for (const r of (rows || [])) { if (!map.has(r.group_id)) map.set(r.group_id, { label: r.group_label, num: r.group_num, teams: [] }); map.get(r.group_id)!.teams.push(r) }
        setData(Array.from(map.values()).sort((a, b) => a.num - b.num)); setLoading(false)
      })
  }, [eventId, divisionId])
  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!data.length) return <p className="text-center py-10 text-stone-400">아직 조 편성이 없습니다.</p>
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {data.map(g => (
        <div key={g.label} className="bg-white rounded-xl border overflow-hidden">
          <div className="bg-tennis-600 text-white px-4 py-2 font-bold text-sm">{g.label}</div>
          <div className="p-3">{g.teams.map((t: any, i: number) => (
            <div key={t.team_id} className="flex items-center gap-2 py-2 border-b border-stone-100 last:border-0">
              <span className="w-6 h-6 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-500">{i+1}</span>
              <span className="font-medium text-sm">{t.team_name}</span>
            </div>
          ))}</div>
        </div>
      ))}
    </div>
  )
}

function TournamentView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [matches, setMatches] = useState<Match[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    supabase.from('v_bracket_with_details').select('*').eq('event_id', eventId).eq('division_id', divisionId).order('slot')
      .then(({ data }) => { setMatches(data || []); setLoading(false) })
  }, [eventId, divisionId])
  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!matches.length) return <p className="text-center py-10 text-stone-400">아직 본선 토너먼트가 없습니다.</p>
  return <TournamentBracket matches={matches} />
}

function ResultsView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [matches, setMatches] = useState<Match[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId).eq('division_id', divisionId).order('slot')
      .then(({ data }) => { setMatches(data || []); setLoading(false) })
  }, [eventId, divisionId])
  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  const grouped = { GROUP: matches.filter(m => m.stage === 'GROUP'), FINALS: matches.filter(m => m.stage === 'FINALS') }
  return (
    <div className="space-y-8">
      {grouped.GROUP.length > 0 && <section><h3 className="font-bold text-lg mb-3">📋 예선 (조별)</h3><div className="space-y-2">{grouped.GROUP.map(m => <MatchRow key={m.id} m={m} />)}</div></section>}
      {grouped.FINALS.length > 0 && <section><h3 className="font-bold text-lg mb-3">🏆 본선</h3><div className="space-y-2">{grouped.FINALS.filter(m => m.score !== 'BYE').map(m => <MatchRow key={m.id} m={m} />)}</div></section>}
      {matches.length === 0 && <p className="text-center py-10 text-stone-400">경기 결과가 없습니다.</p>}
    </div>
  )
}

function MatchRow({ m }: { m: Match }) {
  const done = m.status === 'FINISHED'
  return (
    <div className="bg-white rounded-xl border p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className={`font-bold truncate ${m.winner_team_id === m.team_a_id ? 'text-tennis-700' : ''}`}>{m.team_a_name || 'TBD'}</span>
          <span className="text-stone-300 flex-shrink-0">vs</span>
          <span className={`font-bold truncate ${m.winner_team_id === m.team_b_id ? 'text-tennis-700' : ''}`}>{m.team_b_name || 'TBD'}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-stone-400">
          <span>{m.round}</span>{m.group_label && <span>· {m.group_label}</span>}
          {m.court && <span className="px-1.5 py-0.5 rounded bg-[#2d5016]/10 text-[#2d5016] font-medium">{m.court}</span>}
        </div>
      </div>
      <div className="flex-shrink-0 text-right">
        {m.score && m.score !== 'BYE' && <div className="text-sm font-bold">{m.score}</div>}
        <span className={`text-xs px-2 py-0.5 rounded-full ${done ? 'bg-tennis-100 text-tennis-700' : 'bg-stone-100 text-stone-500'}`}>
          {done ? (m.score === 'BYE' ? 'BYE' : '완료') : '대기'}</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════
// 단체전 뷰
// ═══════════════════════════════════════
function TeamStandingsView({ standingsMap, groups }: { standingsMap: Record<string, StandingWithClub[]>; groups: any[] }) {
  const entries = Object.entries(standingsMap)
  if (entries.length === 0) return <div className="text-center text-gray-400 py-8">아직 순위 데이터가 없습니다.</div>
  return (
    <div className="space-y-4">
      {entries.map(([key, standings]) => {
        const group = groups.find(g => g.id === key)
        const title = key === 'full' ? '풀리그 순위' : (group?.group_label || group?.group_name || key)
        return (
          <div key={key} className="bg-white rounded-xl border overflow-hidden">
            <div className="bg-gray-50 px-4 py-3 font-semibold text-sm">{title}</div>
            <table className="w-full text-sm">
              <thead className="border-t bg-gray-50"><tr><th className="px-3 py-2 text-left w-12">#</th><th className="px-3 py-2 text-left">클럽</th><th className="px-3 py-2 text-center w-10">승</th><th className="px-3 py-2 text-center w-10">패</th><th className="px-3 py-2 text-center w-14">득실</th></tr></thead>
              <tbody className="divide-y">
                {standings.map(s => (
                  <tr key={s.id} className={s.is_tied ? 'bg-yellow-50' : ''}>
                    <td className="px-3 py-2 font-bold">{s.rank ?? <span className="text-yellow-500 text-xs">⚠️</span>}</td>
                    <td className="px-3 py-2 font-medium">{s.club?.name}{s.club?.seed_number && <span className="ml-1 text-xs text-yellow-600">[{s.club.seed_number}]</span>}</td>
                    <td className="px-3 py-2 text-center font-medium">{s.won}</td>
                    <td className="px-3 py-2 text-center">{s.lost}</td>
                    <td className="px-3 py-2 text-center"><span className={s.rubber_diff > 0 ? 'text-green-600' : s.rubber_diff < 0 ? 'text-red-600' : ''}>{s.rubber_diff > 0 ? '+' : ''}{s.rubber_diff}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

function TeamMatchesView({ ties }: { ties: TieWithClubs[] }) {
  if (ties.length === 0) return <div className="text-center text-gray-400 py-8">대전이 없습니다.</div>
  return (
    <div className="space-y-2">
      {ties.map(tie => (
        <div key={tie.id} className={`bg-white rounded-xl border p-4 ${tie.is_bye ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">{getRoundLabel(tie.round || '')} #{tie.tie_order}
              {tie.court_number && <span className="ml-2 text-green-700 font-medium">코트 {tie.court_number}</span>}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>{getTieStatusLabel(tie.status)}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex-1"><span className={`font-medium ${tie.winning_club_id === tie.club_a_id ? 'text-green-700' : ''}`}>{tie.club_a?.name || 'TBD'}</span></div>
            <div className="text-center px-4">
              {tie.status === 'completed' || tie.status === 'in_progress'
                ? <span className="text-xl font-bold">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span>
                : tie.is_bye ? <span className="text-sm text-gray-400">BYE</span> : <span className="text-sm text-gray-400">vs</span>}
            </div>
            <div className="flex-1 text-right"><span className={`font-medium ${tie.winning_club_id === tie.club_b_id ? 'text-green-700' : ''}`}>{tie.club_b?.name || 'TBD'}</span></div>
          </div>
          {tie.status === 'lineup_phase' && (
            <div className="text-xs text-center text-yellow-600 mt-2">라인업: {tie.club_a_lineup_submitted ? '✅' : '⏳'} {tie.club_a?.name} · {tie.club_b_lineup_submitted ? '✅' : '⏳'} {tie.club_b?.name}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function TeamBracketView({ ties }: { ties: TieWithClubs[] }) {
  const tournamentTies = ties.filter(t => ['round_of_16', 'quarter', 'semi', 'final'].includes(t.round || ''))
  if (tournamentTies.length === 0) return <div className="text-center text-gray-400 py-8">토너먼트가 아직 시작되지 않았습니다.</div>
  const rounds = [...new Set(tournamentTies.map(t => t.round))].sort((a, b) => {
    const order = ['round_of_16', 'quarter', 'semi', 'final']; return order.indexOf(a || '') - order.indexOf(b || '')
  })
  const finalTie = tournamentTies.find(t => t.round === 'final')
  const winner = finalTie?.winning_club_id ? (finalTie.winning_club_id === finalTie.club_a_id ? finalTie.club_a?.name : finalTie.club_b?.name) : null
  return (
    <div className="space-y-4">
      {rounds.map(round => (
        <div key={round} className="bg-white rounded-xl border overflow-hidden">
          <div className="bg-gray-50 px-4 py-3 font-semibold text-sm">{getRoundLabel(round || '')}</div>
          <div className="divide-y">
            {tournamentTies.filter(t => t.round === round).sort((a, b) => (a.bracket_position || 0) - (b.bracket_position || 0)).map(tie => (
              <div key={tie.id} className="p-3">
                <div className="flex items-center">
                  <div className={`flex-1 ${tie.winning_club_id === tie.club_a_id ? 'font-bold' : ''}`}>
                    {tie.club_a?.seed_number && <span className="text-xs text-yellow-600 mr-1">[{tie.club_a.seed_number}]</span>}{tie.club_a?.name || (tie.is_bye ? 'BYE' : 'TBD')}</div>
                  <div className="px-4 font-bold">{tie.status === 'completed' || tie.status === 'in_progress' ? `${tie.club_a_rubbers_won} - ${tie.club_b_rubbers_won}` : tie.is_bye ? 'BYE' : 'vs'}</div>
                  <div className={`flex-1 text-right ${tie.winning_club_id === tie.club_b_id ? 'font-bold' : ''}`}>
                    {tie.club_b?.name || (tie.is_bye ? 'BYE' : 'TBD')}{tie.club_b?.seed_number && <span className="text-xs text-yellow-600 ml-1">[{tie.club_b.seed_number}]</span>}</div>
                </div>
                {tie.court_number && <div className="text-xs text-center text-green-600 mt-1">코트 {tie.court_number}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {winner && <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-6 text-center"><div className="text-4xl mb-2">🏆</div><div className="text-2xl font-bold">{winner}</div><div className="text-sm text-yellow-700 mt-1">우승!</div></div>}
    </div>
  )
}

function TeamCourtsView({ ties }: { ties: TieWithClubs[] }) {
  const courtTies = ties.filter(t => t.court_number && !t.is_bye)
  const unassigned = ties.filter(t => !t.court_number && !t.is_bye && t.status !== 'completed')
  const courtNums = [...new Set(courtTies.map(t => t.court_number!))].sort((a, b) => a - b)
  if (courtTies.length === 0 && unassigned.length === 0) return <div className="text-center text-gray-400 py-8">코트 배정 정보가 없습니다.</div>
  return (
    <div className="space-y-4">
      {courtNums.map(court => {
        const ct = courtTies.filter(t => t.court_number === court)
        const live = ct.some(t => t.status === 'in_progress')
        return (
          <div key={court} className="bg-white rounded-xl border overflow-hidden">
            <div className={`px-4 py-2 font-bold text-sm text-white flex items-center justify-between ${live ? 'bg-red-700' : 'bg-[#2d5016]'}`}>
              <span>코트 {court} {live && <span className="ml-2 text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}</span>
              <span className="text-white/60 text-xs">{ct.filter(t => t.status === 'completed').length}/{ct.length}</span>
            </div>
            <div className="divide-y">
              {ct.map(tie => (
                <div key={tie.id} className="p-3 flex items-center justify-between">
                  <div className="text-sm">
                    <span className={`font-medium ${tie.winning_club_id === tie.club_a_id ? 'text-green-700' : ''}`}>{tie.club_a?.name}</span>
                    <span className="text-gray-400 mx-2">vs</span>
                    <span className={`font-medium ${tie.winning_club_id === tie.club_b_id ? 'text-green-700' : ''}`}>{tie.club_b?.name}</span>
                  </div>
                  <div className="text-right">
                    {(tie.status === 'completed' || tie.status === 'in_progress') && <span className="font-bold">{tie.club_a_rubbers_won}-{tie.club_b_rubbers_won}</span>}
                    <span className={`ml-2 text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>{getTieStatusLabel(tie.status)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {unassigned.length > 0 && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="bg-gray-500 text-white px-4 py-2 font-bold text-sm">미배정 ({unassigned.length})</div>
          <div className="divide-y">
            {unassigned.map(tie => (
              <div key={tie.id} className="p-3 flex items-center justify-between text-sm">
                <div><span className="font-medium">{tie.club_a?.name || 'TBD'}</span><span className="text-gray-400 mx-2">vs</span><span className="font-medium">{tie.club_b?.name || 'TBD'}</span></div>
                <span className={`text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>{getTieStatusLabel(tie.status)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
