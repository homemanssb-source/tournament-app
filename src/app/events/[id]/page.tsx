// ============================================================
// src/app/events/[id]/page.tsx
// ✅ TeamBracketView: 가로 브래킷 형태로 교체 (운영자와 동일)
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

async function logAccess(eventId: string, page: string, tab?: string) {
  try {
    const device = window.innerWidth < 768 ? 'mobile' : 'desktop'
    await supabase.from('access_logs').insert({ event_id: eventId, page, tab: tab || null, device })
  } catch {}
}

export default function EventDetailPage() {
  const { id } = useParams()
  const eventId = id as string
  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('individual')

  const [divisions, setDivisions] = useState<Division[]>([])
  const [activeDivision, setActiveDivision] = useState('')
  const [iTab, setITab] = useState<IndividualTab>('groups')

  const [tTab, setTTab] = useState<TeamTab>('standings')
  const [teamConfig, setTeamConfig] = useState<EventTeamConfig | null>(null)
  const [clubs, setClubs] = useState<Club[]>([])
  const [ties, setTies] = useState<TieWithClubs[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [standingsMap, setStandingsMap] = useState<Record<string, StandingWithClub[]>>({})

  const [teamDivisions, setTeamDivisions] = useState<Division[]>([])
  const [selectedTeamDiv, setSelectedTeamDiv] = useState<string>('')

  useEffect(() => {
    (async () => {
      const { data: ev } = await supabase.from('events').select('*').eq('id', eventId).single()
      setEvent(ev)
      if (ev?.event_type === 'team') setMode('team')
      else setMode('individual')

      const { data: divs } = await supabase.from('divisions').select('*').eq('event_id', eventId).order('sort_order')
      setDivisions(divs || [])
      if (divs?.length) setActiveDivision(divs[0].id)
      setTeamDivisions(divs || [])
      if (divs?.length) setSelectedTeamDiv(divs[0].id)

      await loadTeamData(divs?.[0]?.id)
      setLoading(false)
      logAccess(eventId, 'event_detail')
    })()
  }, [eventId])

  useEffect(() => {
    if (!eventId || loading) return
    if (mode === 'individual') logAccess(eventId, 'event_detail', iTab)
  }, [iTab, mode, eventId, loading])

  useEffect(() => {
    if (!eventId || loading) return
    if (mode === 'team') logAccess(eventId, 'event_detail', `team_${tTab}`)
  }, [tTab, mode, eventId, loading])

  const loadTeamData = useCallback(async (divisionId?: string) => {
    const divId = divisionId || selectedTeamDiv || undefined
    const [cfg, clubList, tieList] = await Promise.all([
      fetchEventTeamConfig(eventId),
      fetchClubs(eventId, divId || null),
      fetchTies(eventId),
    ])
    setTeamConfig(cfg)
    setClubs(clubList)
    const filteredTies = divId ? tieList.filter(t => (t as any).division_id === divId) : tieList
    setTies(filteredTies)

    const map: Record<string, StandingWithClub[]> = {}
    if (cfg?.team_format === 'full_league') {
      map['full'] = await fetchStandings(eventId, null)
    } else {
      const { data: grps } = await supabase.from('groups').select('*').eq('event_id', eventId).order('group_num')
      const filteredGrps = divId ? (grps || []).filter((g: any) => g.division_id === divId) : (grps || [])
      setGroups(filteredGrps)
      for (const g of filteredGrps) {
        map[g.id] = await fetchStandings(eventId, g.id)
      }
    }
    setStandingsMap(map)
  }, [eventId, selectedTeamDiv])

  async function handleTeamDivChange(divId: string) {
    setSelectedTeamDiv(divId)
    await loadTeamData(divId)
  }

  useEffect(() => {
    if (mode !== 'team') return
    const interval = setInterval(() => loadTeamData(), 30000)
    return () => clearInterval(interval)
  }, [mode, loadTeamData])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-stone-400">불러오는 중...</div>
  if (!event) return <div className="min-h-screen flex items-center justify-center text-stone-400">대회를 찾을 수 없습니다.</div>

  const individualTabs: { key: IndividualTab; label: string; emoji: string }[] = [
    { key: 'groups', label: '조편성', emoji: '📋' },
    { key: 'tournament', label: '토너먼트', emoji: '🏆' },
    { key: 'results', label: '경기결과', emoji: '📊' },
    { key: 'courts', label: '코트현황', emoji: '🎾' },
  ]
  const teamTabs: { key: TeamTab; label: string; emoji: string }[] = [
    { key: 'standings', label: '순위', emoji: '📊' },
    { key: 'matches', label: '경기결과', emoji: '📋' },
    { key: 'bracket', label: '토너먼트', emoji: '🏆' },
    { key: 'courts', label: '코트현황', emoji: '🎾' },
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

        {(!event.event_type || event.event_type === 'both') && (
          <div className="max-w-5xl mx-auto px-4 flex gap-2 pb-2">
            <button onClick={() => setMode('individual')}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${mode === 'individual' ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'}`}>
              🎾 개인전
            </button>
            <button onClick={() => setMode('team')}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${mode === 'team' ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'}`}>
              🏆 단체전
            </button>
          </div>
        )}

        {event.event_type && event.event_type !== 'both' && (
          <div className="max-w-5xl mx-auto px-4 pb-2">
            <span className="px-4 py-1.5 rounded-full text-sm font-medium bg-white text-[#2d5016]">
              {event.event_type === 'team' ? '🏆 단체전' : '🎾 개인전'}
            </span>
          </div>
        )}

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

        {mode === 'team' && teamDivisions.length > 1 && tTab !== 'courts' && (
          <div className="max-w-5xl mx-auto px-4 flex gap-1 overflow-x-auto pb-2">
            {teamDivisions.map(d => (
              <button key={d.id} onClick={() => handleTeamDivChange(d.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                  selectedTeamDiv === d.id ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'
                }`}>{d.name}</button>
            ))}
          </div>
        )}

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
        {mode === 'individual' && (<>
          {iTab === 'groups'     && <GroupsView eventId={eventId} divisionId={activeDivision} />}
          {iTab === 'tournament' && <TournamentView eventId={eventId} divisionId={activeDivision} />}
          {iTab === 'results'    && <ResultsView eventId={eventId} divisionId={activeDivision} />}
          {iTab === 'courts'     && <CourtBoard eventId={eventId} />}
        </>)}

        {mode === 'team' && (<>
          {liveTies.length > 0 && (
            <div className="bg-gradient-to-r from-red-50 to-orange-50 border-2 border-red-300 rounded-xl p-4 mb-6 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex items-center gap-1.5 bg-red-500 text-white text-xs font-bold px-3 py-1 rounded-full animate-pulse">
                  🔴 LIVE
                </span>
                <h2 className="font-bold text-red-800">지금 진행 중인 경기</h2>
                <span className="text-xs text-red-500 ml-auto">{liveTies.length}경기</span>
              </div>
              <div className="space-y-2">
                {liveTies.map(tie => (
                  <div key={tie.id} className="bg-white rounded-xl p-3 flex items-center justify-between shadow-sm border border-red-100">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm">{tie.club_a?.name}</span>
                        <span className="text-gray-400 text-xs">vs</span>
                        <span className="font-bold text-sm">{tie.club_b?.name}</span>
                      </div>
                      {tie.court_number && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded mt-1 inline-block">
                          코트 {tie.court_number}
                        </span>
                      )}
                    </div>
                    <div className="text-2xl font-black text-red-600">
                      {tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tTab === 'standings' && <TeamStandingsView standingsMap={standingsMap} groups={groups} />}
          {tTab === 'matches'   && <TeamMatchesView ties={ties} />}
          {tTab === 'bracket'   && <TeamBracketView ties={ties} />}
          {tTab === 'courts'    && <CourtBoard eventId={eventId} />}

          <div className="text-center mt-6">
            <button onClick={() => loadTeamData()} className="text-sm text-gray-400 hover:text-gray-600">
              🔄 새로고침
            </button>
            <p className="text-xs text-gray-300 mt-1">30초마다 자동 갱신</p>
          </div>
        </>)}
      </main>
    </div>
  )
}

// =====================================
// 개인전 뷰
// =====================================
function GroupsView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    supabase.from('v_group_board').select('*').eq('event_id', eventId).eq('division_id', divisionId)
      .order('group_num').order('team_num')
      .then(({ data: rows }) => {
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
  if (!data.length) return <p className="text-center py-10 text-stone-400">아직 조편성이 없습니다.</p>
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {data.map(g => (
        <div key={g.label} className="bg-white rounded-xl border overflow-hidden">
          <div className="bg-tennis-600 text-white px-4 py-2 font-bold text-sm">{g.label}</div>
          <div className="p-3">
            {g.teams.map((t: any, i: number) => (
              <div key={t.team_id} className="flex items-center gap-2 py-2 border-b border-stone-100 last:border-0">
                <span className="w-6 h-6 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-500">{i + 1}</span>
                <span className="font-bold text-base text-stone-800">{t.team_name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TournamentView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    supabase.from('matches').select('*')
      .eq('event_id', eventId).eq('division_id', divisionId).eq('stage', 'FINALS')
      .order('round').order('match_num')
      .then(({ data }) => { setMatches(data || []); setLoading(false) })
  }, [eventId, divisionId])
  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!matches.length) return <p className="text-center py-10 text-stone-400">아직 토너먼트가 없습니다.</p>
  return <TournamentBracket matches={matches} />
}

function ResultsView({ eventId, divisionId }: { eventId: string; divisionId: string }) {
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId).eq('division_id', divisionId).eq('status', 'FINISHED')
      .neq('score', 'BYE').order('updated_at', { ascending: false }).limit(50)
      .then(({ data }) => { setMatches(data || []); setLoading(false) })
  }, [eventId, divisionId])
  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!matches.length) return <p className="text-center py-10 text-stone-400">완료된 경기가 없습니다.</p>
  return (
    <div className="space-y-2">
      {(matches as any[]).map((m: any) => (
        <div key={m.id} className="bg-white rounded-xl border p-3">
          <div className="flex items-center justify-between text-xs text-stone-400 mb-1">
            <span>{m.round} · {m.match_num}</span>
            {m.court && <span className="text-green-700 font-medium">{m.court}</span>}
          </div>
          <div className="flex items-center justify-between">
            <span className={`font-bold text-base ${m.winner_team_id === m.team_a_id ? 'text-green-700' : 'text-stone-800'}`}>{m.team_a_name}</span>
            <span className="text-2xl font-black mx-4 text-stone-900">{m.score}</span>
            <span className={`font-bold text-base ${m.winner_team_id === m.team_b_id ? 'text-green-700' : 'text-stone-800'}`}>{m.team_b_name}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// =====================================
// 단체전 뷰
// =====================================
function TeamStandingsView({ standingsMap, groups }: { standingsMap: Record<string, StandingWithClub[]>; groups: any[] }) {
  if (Object.keys(standingsMap).length === 0) {
    return <p className="text-center py-10 text-stone-400">아직 순위 데이터가 없습니다.</p>
  }
  return (
    <div className="space-y-4">
      {Object.entries(standingsMap).map(([key, standings]) => {
        const title = key === 'full' ? '풀리그 순위' : groups.find(g => g.id === key)?.group_name || ''
        return (
          <div key={key} className="bg-white rounded-xl border overflow-hidden">
            <div className="bg-gray-50 px-4 py-3 font-semibold text-sm">{title}</div>
            <table className="w-full text-sm">
              <thead className="border-t bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left w-12">#</th>
                  <th className="px-3 py-2 text-left">클럽</th>
                  <th className="px-3 py-2 text-center w-10">승</th>
                  <th className="px-3 py-2 text-center w-10">패</th>
                  <th className="px-3 py-2 text-center w-14">득실</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {standings.map(s => (
                  <tr key={s.id} className={s.is_tied ? 'bg-yellow-50' : ''}>
                    <td className="px-3 py-2 font-bold">{s.rank ?? <span className="text-yellow-500 text-xs">동점</span>}</td>
                    <td className="px-3 py-2 font-medium">
                      {s.club?.name}
                      {s.club?.seed_number && <span className="ml-1 text-xs text-yellow-600">[{s.club.seed_number}]</span>}
                    </td>
                    <td className="px-3 py-2 text-center font-medium">{s.won}</td>
                    <td className="px-3 py-2 text-center">{s.lost}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={s.rubber_diff > 0 ? 'text-green-600' : s.rubber_diff < 0 ? 'text-red-600' : ''}>
                        {s.rubber_diff > 0 ? '+' : ''}{s.rubber_diff}
                      </span>
                    </td>
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
  if (ties.length === 0) return <div className="text-center text-gray-400 py-8">타이가 없습니다.</div>
  return (
    <div className="space-y-2">
      {ties.map(tie => (
        <div key={tie.id} className={`bg-white rounded-xl border p-4 ${tie.is_bye ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">{getRoundLabel(tie.round || '')} #{tie.tie_order}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>{getTieStatusLabel(tie.status)}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <span className={`font-medium ${tie.winning_club_id === tie.club_a_id ? 'text-green-700' : ''}`}>
                {tie.club_a?.name || 'TBD'}
              </span>
            </div>
            <div className="text-center px-4">
              {tie.status === 'completed' || tie.status === 'in_progress' ? (
                <span className={`text-xl font-bold ${tie.status === 'in_progress' ? 'text-red-600' : ''}`}>
                  {tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}
                </span>
              ) : tie.is_bye ? (
                <span className="text-sm text-gray-400">BYE</span>
              ) : (
                <span className="text-sm text-gray-400">vs</span>
              )}
            </div>
            <div className="flex-1 text-right">
              <span className={`font-medium ${tie.winning_club_id === tie.club_b_id ? 'text-green-700' : ''}`}>
                {tie.club_b?.name || 'TBD'}
              </span>
            </div>
          </div>
          {tie.court_number && <div className="text-xs text-center text-green-600 mt-2">코트 {tie.court_number}</div>}
          {tie.status === 'lineup_phase' && (
            <div className="text-xs text-center text-yellow-600 mt-2">
              라인업: {tie.club_a_lineup_submitted ? '✅' : '⏳'} {tie.club_a?.name}
              {' · '}
              {tie.club_b_lineup_submitted ? '✅' : '⏳'} {tie.club_b?.name}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ✅ 가로 브래킷 형태 (운영자 대시보드와 동일)
function TeamBracketView({ ties }: { ties: TieWithClubs[] }) {
  const ROUND_ORDER = ['round_of_16', 'quarter', 'semi', 'final']
  const roundLabels: Record<string, string> = {
    round_of_16: '16강', quarter: '8강', semi: '4강', final: '결승',
  }

  const tournamentTies = ties.filter(t =>
    ['round_of_16', 'quarter', 'semi', 'final'].includes(t.round || '')
  )

  if (tournamentTies.length === 0) {
    return <div className="text-center text-gray-400 py-8">토너먼트가 아직 시작되지 않았습니다.</div>
  }

  const tiesByRound: Record<string, TieWithClubs[]> = {}
  tournamentTies.forEach(t => {
    const r = t.round || ''
    if (!tiesByRound[r]) tiesByRound[r] = []
    tiesByRound[r].push(t)
  })
  const sortedRounds = ROUND_ORDER.filter(r => tiesByRound[r])

  const finalTie = tiesByRound['final']?.[0]
  const winner = finalTie?.winning_club_id
    ? (finalTie.winning_club_id === finalTie.club_a_id ? finalTie.club_a?.name : finalTie.club_b?.name)
    : null

  return (
    <div className="space-y-4">
      {winner && (
        <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-4 text-center">
          <div className="text-3xl mb-1">🏆</div>
          <div className="text-xl font-bold">{winner}</div>
          <div className="text-sm text-yellow-700 mt-1">우승!</div>
        </div>
      )}
      <div className="overflow-x-auto">
        <div className="flex gap-4 min-w-max pb-2">
          {sortedRounds.map((round, roundIdx) => {
            const roundTies = (tiesByRound[round] || []).sort(
              (a, b) => (a.bracket_position || 0) - (b.bracket_position || 0)
            )
            const gap = Math.pow(2, roundIdx) * 12
            return (
              <div key={round} className="flex flex-col" style={{ minWidth: 180 }}>
                <div className="text-center mb-3">
                  <span className="text-xs font-semibold text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
                    {roundLabels[round] || round}
                  </span>
                </div>
                <div className="flex flex-col justify-around flex-1" style={{ gap }}>
                  {roundTies.map(tie => {
                    const aWin = tie.winning_club_id === tie.club_a_id
                    const bWin = tie.winning_club_id === tie.club_b_id
                    return (
                      <div key={tie.id} className={`border rounded-xl overflow-hidden shadow-sm ${
                        tie.status === 'completed' ? 'border-green-300' :
                        tie.status === 'in_progress' ? 'border-red-300' :
                        tie.is_bye ? 'border-gray-100 bg-gray-50' : 'border-gray-200'
                      }`} style={{ minHeight: 68 }}>
                        {tie.status === 'in_progress' && (
                          <div className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />LIVE
                          </div>
                        )}
                        <div className={`flex items-center justify-between px-3 py-2 text-sm ${aWin ? 'bg-green-50 font-bold' : ''}`}>
                          <span className="truncate">{tie.club_a?.name || (tie.is_bye && !tie.club_a_id ? 'BYE' : 'TBD')}</span>
                          {(tie.status === 'completed' || tie.status === 'in_progress') && (
                            <span className={`ml-2 font-bold flex-shrink-0 ${aWin ? 'text-green-700' : tie.status === 'in_progress' ? 'text-red-600' : 'text-gray-400'}`}>
                              {tie.club_a_rubbers_won}
                            </span>
                          )}
                        </div>
                        <div className="border-t border-gray-100" />
                        <div className={`flex items-center justify-between px-3 py-2 text-sm ${bWin ? 'bg-green-50 font-bold' : ''}`}>
                          <span className="truncate">{tie.club_b?.name || (tie.is_bye && !tie.club_b_id ? 'BYE' : 'TBD')}</span>
                          {(tie.status === 'completed' || tie.status === 'in_progress') && (
                            <span className={`ml-2 font-bold flex-shrink-0 ${bWin ? 'text-green-700' : tie.status === 'in_progress' ? 'text-red-600' : 'text-gray-400'}`}>
                              {tie.club_b_rubbers_won}
                            </span>
                          )}
                        </div>
                        {tie.is_bye && (
                          <div className="text-center py-0.5 border-t border-gray-100 bg-gray-50">
                            <span className="text-[10px] text-gray-400">부전승</span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div className="flex flex-col justify-center" style={{ minWidth: 120 }}>
            <div className="text-center mb-3">
              <span className="text-xs font-semibold text-yellow-600 bg-yellow-50 px-3 py-1 rounded-full">🏆 우승</span>
            </div>
            <div className="border-2 border-dashed border-yellow-200 rounded-xl p-4 text-center">
              {winner
                ? <div className="font-bold text-yellow-700">{winner}</div>
                : <div className="text-gray-300 text-sm">?</div>
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}