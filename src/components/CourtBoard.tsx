'use client'
// ============================================================
// src/components/CourtBoard.tsx
// ✅ 검색: ref 기반 doSearch, 모바일 blur 타이밍 문제 완전 해결
// ✅ 완료 경기: ▼ 펼치기 / ▲ 접기 토글
// ✅ 클럽명: 최대 6자 + … 축약
// ✅ 1열 레이아웃
// ============================================================
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

interface CourtMatch {
  id: string; match_num: string; court: string; court_order: number
  stage: string; round: string; status: string; score: string | null
  division_name: string; division_id: string
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  winner_team_id: string | null; is_team_tie?: boolean; slot?: number | null
}

interface Venue {
  id: string; name: string; short_name: string; court_count: number
}

function parsePlayers(raw: string): { name: string; club: string }[] {
  if (!raw || raw === 'TBD' || raw === 'BYE') return []
  return raw.split('/').map(p => {
    const m = p.trim().match(/^(.+?)\((.+)\)$/)
    return m ? { name: m[1].trim(), club: m[2].trim() } : { name: p.trim(), club: '' }
  })
}

function shortClub(club: string, maxLen = 6): string {
  if (!club) return ''
  return club.length > maxLen ? club.slice(0, maxLen) + '…' : club
}

function extractPlayerNames(raw: string): string[] {
  if (!raw || raw === 'TBD' || raw === 'BYE') return []
  return raw.split('/').map(p => {
    const m = p.trim().match(/^(.+?)\(/)
    return m ? m[1].trim() : p.trim()
  }).filter(Boolean)
}

function courtNumToName(courtNumber: number, venues: Venue[]): string {
  if (venues.length === 0) return `코트-${courtNumber}`
  if (venues.length === 1) {
    const v = venues[0]
    return `${v.short_name || v.name}-${courtNumber}`
  }
  let offset = 0
  for (const v of venues) {
    const count = v.court_count || 0
    if (courtNumber <= offset + count) return `${v.short_name || v.name}-${courtNumber - offset}`
    offset += count
  }
  const last = venues[venues.length - 1]
  return `${last.short_name || last.name}-${courtNumber}`
}

export default function CourtBoard({ eventId, initialDate }: { eventId: string; initialDate?: string }) {
  const [matches, setMatches]             = useState<CourtMatch[]>([])
  const [venues, setVenues]               = useState<Venue[]>([])
  // court 없는 본선 경기 (TBD 후보 계산용)
  const [allFinalsMatches, setAllFinalsMatches] = useState<CourtMatch[]>([])
  const [loading, setLoading]             = useState(true)
  const [lastUpdate, setLastUpdate]       = useState<Date>(new Date())

  const [query, setQuery]             = useState('')
  const [suggestions, setSugg]        = useState<string[]>([])
  const [showSugg, setShowSugg]       = useState(false)
  const [searchResult, setResult]     = useState<{ name: string; court: string; idx: number } | null>(null)
  const [dateFilter, setDateFilter]   = useState<string>(initialDate || 'ALL')
  const [venueFilter, setVenueFilter] = useState<string>('ALL')
  const [divMatchDates, setDivMatchDates] = useState<Record<string, string>>({})

  // 완료 경기 펼치기: Set에 있으면 펼쳐진 상태
  const [expandedCourts, setExpandedCourts] = useState<Set<string>>(new Set())
  function toggleExpand(court: string) {
    setExpandedCourts(prev => {
      const next = new Set(prev)
      if (next.has(court)) next.delete(court)
      else next.add(court)
      return next
    })
  }

  const inputRef   = useRef<HTMLInputElement>(null)
  const suggRef    = useRef<HTMLDivElement>(null)
  // ✅ 핵심: query와 matches를 ref로 유지 → 모바일 blur로 state 소실되어도 검색 동작
  const queryRef   = useRef('')
  const matchesRef = useRef<CourtMatch[]>([])
  const dateFilteredRef = useRef<CourtMatch[]>([])
  useEffect(() => { matchesRef.current = matches }, [matches])

  const loadVenues = useCallback(async () => {
    const { data } = await supabase
      .from('venues').select('id, name, short_name, court_count')
      .eq('event_id', eventId).order('created_at')
    const list = (data || []) as Venue[]
    setVenues(list)
    return list
  }, [eventId])

  const loadData = useCallback(async (venueList?: Venue[]) => {
    const currentVenues = venueList ?? venues
    const { data: matchData } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId).not('court', 'is', null).order('court').order('court_order')
    const indivMatches: CourtMatch[] = ((matchData as any[]) || [])
      .filter(m => m.score !== 'BYE').map(m => ({ ...m, is_team_tie: false }))

    const { data: tieData } = await supabase.from('ties')
      .select('id, tie_order, court_order, status, round, court_number, is_bye, club_a_rubbers_won, club_b_rubbers_won, division_id, winning_club_id, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)')
      .eq('event_id', eventId).not('court_number', 'is', null)
      .order('court_number').order('court_order', { ascending: true, nullsFirst: false })

    const sMap: Record<string, string> = {
      pending: 'PENDING', lineup_phase: 'PENDING', lineup_ready: 'PENDING',
      in_progress: 'IN_PROGRESS', completed: 'FINISHED',
    }
    const tieMatches: CourtMatch[] = ((tieData as any[]) || []).filter(t => !t.is_bye).map(t => ({
      id: 'tie_' + t.id, match_num: 'T#' + t.tie_order,
      court: courtNumToName(t.court_number, currentVenues),
      court_order: t.court_order ?? t.tie_order ?? 999,
      stage: 'TEAM', round: t.round || 'group',
      status: sMap[t.status] || 'PENDING',
      score: (t.status === 'completed' || t.status === 'in_progress')
        ? `${t.club_a_rubbers_won ?? 0}-${t.club_b_rubbers_won ?? 0}` : null,
      division_name: '단체전', division_id: t.division_id || '',
      team_a_name: t.club_a?.name || 'TBD', team_b_name: t.club_b?.name || 'TBD',
      team_a_id: t.club_a_id || '', team_b_id: t.club_b_id || '',
      winner_team_id: t.winning_club_id || null, is_team_tie: true,
    }))

    setMatches([...indivMatches, ...tieMatches])

    const [{ data: rawMatches }, { data: teamsData }] = await Promise.all([
      supabase.from('matches')
        .select('id, round, slot, stage, division_id, team_a_id, team_b_id, winner_team_id, status')
        .eq('event_id', eventId).eq('stage', 'FINALS')
        .order('slot', { ascending: true, nullsFirst: true }),
      supabase.from('teams').select('id, name').eq('event_id', eventId),
    ])
    const teamNameMap: Record<string, string> = {}
    ;(teamsData || []).forEach((t: any) => { if (t.id && t.name) teamNameMap[t.id] = t.name })
    ;(matchData as any[] || []).forEach((m: any) => {
      if (m.team_a_id && m.team_a_name) teamNameMap[m.team_a_id] = m.team_a_name
      if (m.team_b_id && m.team_b_name) teamNameMap[m.team_b_id] = m.team_b_name
    })
    // court 없는 본선 경기를 CourtMatch 형태로 변환 (TBD 후보 계산용)
    setAllFinalsMatches((rawMatches || []).map((m: any) => ({
      id: m.id, match_num: m.match_num || '',
      court: m.court || '', court_order: m.court_order || 0,
      stage: m.stage || 'FINALS', round: m.round || '',
      status: m.status || 'PENDING', score: m.score || null,
      division_name: '', division_id: m.division_id || '',
      team_a_name: m.team_a_id ? (teamNameMap[m.team_a_id] || 'TBD') : 'TBD',
      team_b_name: m.team_b_id ? (teamNameMap[m.team_b_id] || 'TBD') : 'TBD',
      team_a_id: m.team_a_id || '', team_b_id: m.team_b_id || '',
      winner_team_id: m.winner_team_id || null,
      slot: m.slot ?? null, is_team_tie: false,
    })))
    setLoading(false)
    setLastUpdate(new Date())
  }, [eventId, venues])

  useEffect(() => {
    loadVenues().then(venueList => loadData(venueList))
    const i = setInterval(() => loadData(), 15000)
    return () => clearInterval(i)
  }, [loadData])

  useEffect(() => {
    if (initialDate) return  // 외부에서 날짜 지정된 경우 스킵
    const dates = [...new Set(Object.values(divMatchDates))].sort()
    if (dates.length > 1 && dateFilter === 'ALL') {
      const today = new Date().toISOString().slice(0, 10)
      const found = dates.find(d => d === today)
      setDateFilter(found !== undefined ? found : dates[0])
    }
  }, [divMatchDates])

  useEffect(() => {
    if (!eventId) return
    supabase.from('divisions').select('id, match_date').eq('event_id', eventId)
      .then(({ data }: { data: any[] | null }) => {
        if (data) {
          const map: Record<string, string> = {}
          data.forEach((d: any) => { if (d.match_date) map[d.id] = d.match_date })
          setDivMatchDates(map)
        }
      })
  }, [eventId])

  useEffect(() => {
    function handleOutside(e: Event) {
      if (inputRef.current?.contains(e.target as Node)) return
      if (suggRef.current?.contains(e.target as Node)) return
      setShowSugg(false)
    }
    document.addEventListener('pointerdown', handleOutside)
    return () => document.removeEventListener('pointerdown', handleOutside)
  }, [])

  const dateFilteredMatches = React.useMemo(() => {
    if (dateFilter === 'ALL') return matches
    const divIds = Object.entries(divMatchDates)
      .filter(([, d]) => d === dateFilter).map(([id]) => id)
    if (divIds.length === 0) return []
    return matches.filter(m => m.is_team_tie || divIds.includes(m.division_id))
  }, [matches, dateFilter, divMatchDates])
  useEffect(() => { dateFilteredRef.current = dateFilteredMatches }, [dateFilteredMatches])

  // ✅ 전체 경기 = court 있는 경기 + court 없는 본선 경기 → TBD 후보 계산에 사용
  const allMatches = React.useMemo(() => {
    const ids = new Set(matches.map(m => m.id))
    const extra = allFinalsMatches.filter(m => !ids.has(m.id))
    return [...matches, ...extra]
  }, [matches, allFinalsMatches])

  const byCourt = React.useMemo(() => {
    const map = new Map<string, CourtMatch[]>()
    for (const m of dateFilteredMatches) {
      if (!map.has(m.court)) map.set(m.court, [])
      map.get(m.court)!.push(m)
    }
    return map
  }, [dateFilteredMatches])

  const allCourts = React.useMemo(() => Array.from(byCourt.keys()).sort((a, b) => {
    const getNum = (s: string) => {
      const last = s.split('-').pop() || ''
      return /^\d+$/.test(last) ? parseInt(last, 10) : parseInt(s.replace(/\D/g, ''), 10) || 0
    }
    const getPrefix = (s: string) => s.split('-').slice(0, -1).join('-') || s
    const pa = getPrefix(a), pb = getPrefix(b)
    if (pa !== pb) return pa.localeCompare(pb)
    return getNum(a) - getNum(b)
  }), [byCourt])

  const getVenueName = (court: string) =>
    court.includes('-') ? court.split('-').slice(0, -1).join('-') : court
  const allVenues = [...new Set(allCourts.map(getVenueName))].sort()
  const courts = venueFilter === 'ALL' ? allCourts : allCourts.filter(c => getVenueName(c) === venueFilter)

  const allPlayerNames = React.useMemo(() => {
    const s = new Set<string>()
    for (const m of matches) {
      extractPlayerNames(m.team_a_name).forEach(n => s.add(n))
      extractPlayerNames(m.team_b_name).forEach(n => s.add(n))
    }
    return Array.from(s).sort()
  }, [matches])

  function handleQuery(v: string) {
    queryRef.current = v
    setQuery(v)
    setResult(null)
    if (!v.trim()) { setSugg([]); setShowSugg(false); return }
    const filtered = allPlayerNames.filter(n => n.toLowerCase().includes(v.toLowerCase()))
    setSugg(filtered.slice(0, 8))
    setShowSugg(filtered.length > 0)
  }

  // ✅ dateFilteredRef 사용 → 날짜 필터 적용된 경기만 검색 (calcSearchInfo와 동일 기준)
  function doSearch(name?: string) {
    const target = (name !== undefined ? name : queryRef.current).trim()
    queryRef.current = target
    setQuery(target)
    setSugg([])
    setShowSugg(false)
    if (!target) return

    const grouped = new Map<string, CourtMatch[]>()
    for (const m of dateFilteredRef.current) {
      if (!m.court) continue
      if (!grouped.has(m.court)) grouped.set(m.court, [])
      grouped.get(m.court)!.push(m)
    }
    for (const [court, cms] of grouped) {
      const sorted = [...cms].sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
      const idx = sorted.findIndex(m => {
        const names = [...extractPlayerNames(m.team_a_name), ...extractPlayerNames(m.team_b_name)]
        return names.some(n => n.toLowerCase().includes(target.toLowerCase()))
      })
      if (idx >= 0) { setResult({ name: target, court, idx }); return }
    }
    setResult({ name: target, court: '', idx: -1 })
  }

  function calcSearchInfo() {
    if (!searchResult?.court) return null
    const cms = (byCourt.get(searchResult.court) || []).slice().sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
    const liveIdx = cms.findIndex(m => m.status === 'IN_PROGRESS')
    const pendIdx = cms.findIndex(m => m.status === 'PENDING')
    const curIdx  = liveIdx >= 0 ? liveIdx : pendIdx
    const idx     = searchResult.idx
    const isLive  = idx === liveIdx && liveIdx >= 0
    const hasLive = liveIdx >= 0
    const waitNum = idx > curIdx ? idx - curIdx : 0
    let posLabel = ''
    let urgency  = 0
    if (isLive) { posLabel = '현재 경기 중'; urgency = 2 }
    else if (idx === curIdx && !hasLive) { posLabel = '지금 내 차례'; urgency = 2 }
    else if (idx === curIdx &&  hasLive) { posLabel = '다음 대기';    urgency = 1 }
    else if (waitNum === 1)              { posLabel = '다음 대기';    urgency = 1 }
    else { posLabel = waitNum + '번째 대기'; urgency = 0 }
    return { urgency, posLabel, wait: waitNum - 1 < 0 ? 0 : waitNum - 1, total: cms.length, done: cms.filter(m => m.status === 'FINISHED').length }
  }
  const searchInfo = calcSearchInfo()

  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>

  return (
    <div className="space-y-4">

      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-lg">🎾 코트 현황</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">🔄 {lastUpdate.toLocaleTimeString('ko-KR')}</span>
          <button onClick={() => loadData()} className="text-xs px-2 py-1 bg-stone-100 rounded-lg hover:bg-stone-200">새로고침</button>
        </div>
      </div>

      {/* 날짜 탭 - 외부 날짜 지정 없을 때만 표시 */}
      {!initialDate && (() => {
        const uniqueDates = [...new Set(Object.values(divMatchDates))].sort()
        if (uniqueDates.length < 2) return null
        return (
          <div className="bg-white rounded-xl border p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-stone-500 font-medium whitespace-nowrap">📅 날짜:</span>
              {uniqueDates.map(date => {
                const label = new Date(date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })
                const cnt   = Object.entries(divMatchDates).filter(([, d]) => d === date).length
                return (
                  <button key={date} onClick={() => { setDateFilter(date); setVenueFilter('ALL') }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${dateFilter === date ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-600 border-stone-300 hover:border-blue-400'}`}>
                    {label} <span className="opacity-70">({cnt}부문)</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })()}

      {!courts.length && (
        <p className="text-center py-10 text-stone-400">아직 코트 배정이 없습니다.</p>
      )}

      {/* 장소 탭 */}
      {courts.length > 0 && allVenues.length > 1 && (
        <div className="bg-white rounded-xl border p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-stone-500 font-medium whitespace-nowrap">📍 장소:</span>
            <button onClick={() => setVenueFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${venueFilter === 'ALL' ? 'bg-[#2d5016] text-white border-[#2d5016]' : 'bg-white text-stone-600 border-stone-300 hover:border-stone-400'}`}>
              전체
            </button>
            {allVenues.map(v => (
              <button key={v} onClick={() => setVenueFilter(v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${venueFilter === v ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-stone-600 border-stone-300 hover:border-orange-400'}`}>
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 검색창 */}
      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => handleQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doSearch() } }}
              onFocus={() => { if (query && suggestions.length > 0) setShowSugg(true) }}
              placeholder="선수 이름으로 검색"
              autoComplete="off"
              className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2d5016]/40"
            />
            {showSugg && suggestions.length > 0 && (
              <div ref={suggRef} className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg z-20 overflow-hidden">
                {suggestions.map(s => (
                  <button
                    key={s}
                    // ✅ onPointerDown + preventDefault: blur보다 먼저 실행 → 드롭다운 유지하고 검색
                    onPointerDown={e => { e.preventDefault(); doSearch(s) }}
                    className="w-full text-left px-4 py-3 text-sm hover:bg-stone-50 border-b last:border-b-0 active:bg-stone-100"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* ✅ 검색 버튼 onPointerDown: 모바일에서 input blur → state 소실 전에 실행 */}
          <button
            onPointerDown={e => { e.preventDefault(); doSearch() }}
            className="bg-[#2d5016] text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-[#3d6b20] active:bg-[#1e3a0f] transition-colors"
          >
            🔍 검색
          </button>
        </div>

        {searchResult && (
          <div className={`mt-3 p-4 rounded-xl border-2 ${
            searchInfo?.urgency === 2 ? 'border-red-400 bg-red-50'
            : searchInfo?.urgency === 1 ? 'border-amber-400 bg-amber-50'
            : 'border-stone-200 bg-white'
          }`}>
            {searchResult.court ? (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-sm">{searchResult.name}</p>
                  <p className="text-xs text-stone-500 mt-0.5">
                    {searchResult.court} · {searchInfo?.done}/{searchInfo?.total} 완료
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`font-bold text-sm ${
                    searchInfo?.urgency === 2 ? 'text-red-600'
                    : searchInfo?.urgency === 1 ? 'text-amber-600'
                    : 'text-stone-600'
                  }`}>{searchInfo?.posLabel}</p>
                  {(searchInfo?.urgency ?? 0) < 2 && (
                    <p className="text-xs text-stone-400">{searchInfo?.wait}경기 남음</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-stone-500">"{searchResult.name}" 검색 결과 없음</p>
            )}
          </div>
        )}
      </div>

      {/* 코트 카드 — 1열 */}
      <div className="grid grid-cols-1 gap-3">
        {courts.map(court => {
          const cms        = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
          const liveIdx    = cms.findIndex(m => m.status === 'IN_PROGRESS')
          const pendIdx    = cms.findIndex(m => m.status === 'PENDING')
          const curIdx     = liveIdx >= 0 ? liveIdx : pendIdx
          const isLive     = liveIdx >= 0
          const doneMs     = cms.filter(m => m.status === 'FINISHED')
          const activeMs   = cms.filter(m => m.status !== 'FINISHED')
          const doneCount  = doneMs.length
          const isExpanded = expandedCourts.has(court)
          const isHighlight = searchResult?.court === court

          return (
            <div key={court} className={`bg-white rounded-xl border overflow-hidden transition-all ${isHighlight ? 'ring-2 ring-blue-400 shadow-lg' : 'shadow-sm'}`}>

              {/* 코트 헤더 */}
              <div className={`px-4 py-2.5 flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm">{court}</span>
                  {isLive && <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}
                </div>
                <span className="text-xs text-white/60">{doneCount}/{cms.length}</span>
              </div>

              <div className="p-2 space-y-1.5">

                {/* 완료 경기 토글 버튼 */}
                {doneCount > 0 && (
                  <button
                    onClick={() => toggleExpand(court)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-stone-50 border border-stone-100 hover:bg-stone-100 active:bg-stone-200 transition-colors text-left"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] text-stone-500 font-medium flex-shrink-0">✓ 완료 {doneCount}경기</span>
                      {!isExpanded && doneCount === 1 && (
                        <span className="text-[10px] text-stone-400 truncate">
                          — {extractPlayerNames(doneMs[0].team_a_name).join('/')} vs {extractPlayerNames(doneMs[0].team_b_name).join('/')}
                          {doneMs[0].score ? `  ${doneMs[0].score}` : ''}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-stone-400 flex-shrink-0 ml-2">
                      {isExpanded ? '▲ 접기' : '▼ 펼치기'}
                    </span>
                  </button>
                )}

                {/* 펼쳐진 완료 경기 목록 */}
                {doneCount > 0 && isExpanded && doneMs.map(m => (
                  <div key={m.id} className="rounded-lg px-3 py-2 text-xs bg-stone-50 border border-stone-100 opacity-50">
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <span className="text-stone-400 font-mono">#{cms.indexOf(m) + 1}</span>
                      <span className="text-stone-400">{m.division_name}</span>
                    </div>
                    {m.is_team_tie ? (
                      <span className="font-medium text-xs">{m.team_a_name} vs {m.team_b_name}</span>
                    ) : (
                      <div className="flex items-center gap-1 min-w-0">
                        <div className="flex-1 min-w-0"><PlayerPairInline raw={m.team_a_name} /></div>
                        <span className="text-stone-300 text-[10px] flex-shrink-0">vs</span>
                        <div className="flex-1 min-w-0"><PlayerPairInline raw={m.team_b_name} /></div>
                      </div>
                    )}
                    {m.score && <div className="mt-0.5 font-bold text-stone-500">{m.score}</div>}
                  </div>
                ))}

                {/* 진행중 / 대기 경기 */}
                {activeMs.map(m => {
                  const origIdx   = cms.indexOf(m)
                  const isLiveMat = m.status === 'IN_PROGRESS'
                  const isCurrent = origIdx === curIdx
                  const isNext    = origIdx === curIdx + 1
                  const isSearch  = searchResult?.court === court && searchResult.idx === origIdx

                  return (
                    <div key={m.id} className={`rounded-lg px-3 py-2 text-xs transition-all border ${
                      isSearch    ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-300'
                      : isLiveMat ? 'bg-red-50 border-red-200'
                      : isCurrent ? 'bg-amber-50 border-amber-200'
                      : isNext    ? 'bg-yellow-50/60 border-stone-100'
                      : m.is_team_tie ? 'bg-blue-50/40 border-blue-100'
                      : 'bg-white border-stone-100'
                    }`}>
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <div className="flex items-center gap-1">
                          <span className="text-stone-400 font-mono">#{origIdx + 1}</span>
                          {m.is_team_tie && <span className="text-[9px] bg-blue-600 text-white px-1 rounded">단체</span>}
                          {isLiveMat   && <span className="text-red-500 animate-pulse text-[10px]">● LIVE</span>}
                          {!isLiveMat && isCurrent && <span className="text-amber-600 text-[10px] font-bold">▶ 현재</span>}
                          {!isLiveMat && isNext    && <span className="text-yellow-600 text-[10px]">다음</span>}
                        </div>
                        <span className="text-stone-400">{m.division_name}</span>
                      </div>
                      {m.is_team_tie ? (
                        <span className="font-medium text-xs">{m.team_a_name} vs {m.team_b_name}</span>
                      ) : (
                        <div className="flex items-center gap-1 min-w-0">
                          <div className="flex-1 min-w-0">
                            <PlayerPairInline raw={m.team_a_name} allMatches={allMatches} match={m} abSlot="A" />
                          </div>
                          <span className="text-stone-300 text-[10px] flex-shrink-0">vs</span>
                          <div className="flex-1 min-w-0">
                            <PlayerPairInline raw={m.team_b_name} allMatches={allMatches} match={m} abSlot="B" />
                          </div>
                        </div>
                      )}
                      {m.score && <div className="mt-0.5 font-bold text-[#2d5016]">{m.score}</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ✅ TBD 예상 후보 계산 (page.tsx 방식 동일)
// allMatches: court 유무 무관한 전체 경기 목록 (GROUP + FINALS 모두)
// teamName: TBD 또는 null인 경우에만 후보 계산
// abSlot: 'A' | 'B' — 브래킷에서 위쪽/아래쪽 슬롯
function getTbdCandidates(
  allMatches: CourtMatch[],
  m: CourtMatch,
  teamName: string | null,
  abSlot: 'A' | 'B'
): string[] {
  if (teamName && teamName !== 'TBD') return []
  if (m.is_team_tie) return []

  const PREV: Record<string, string> = {
    '결승': '4강', '4강': '8강', '8강': '16강', '16강': '32강', '32강': '64강', '64강': '128강',
    'F': 'SF', 'SF': 'QF', 'QF': 'R16', 'R16': 'R32', 'R32': 'R64', 'R64': 'R128',
  }
  const prevRound = PREV[m.round]
  if (!prevRound) return []

  // 직전 라운드 경기 — slot 순 정렬
  const prevList = allMatches
    .filter(pm => pm.division_id === m.division_id && pm.round === prevRound)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  if (prevList.length === 0) return []

  // 현재 라운드 내 내 경기의 로컬 인덱스
  const curList = allMatches
    .filter(pm => pm.division_id === m.division_id && pm.round === m.round)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const myLocalIdx = curList.findIndex(pm => pm.id === m.id)
  if (myLocalIdx < 0) return []

  // A슬롯 → prevList[myLocalIdx*2], B슬롯 → prevList[myLocalIdx*2+1]
  const pm = abSlot === 'A' ? prevList[myLocalIdx * 2] : prevList[myLocalIdx * 2 + 1]
  if (!pm) return []

  const strip = (raw: string) => raw.split('/').map(p => p.replace(/\(.*?\)/g, '').trim()).join('/')
  if (pm.status === 'FINISHED' && pm.winner_team_id) {
    const winner = pm.winner_team_id === pm.team_a_id ? pm.team_a_name : pm.team_b_name
    return winner && winner !== 'TBD' ? [strip(winner)] : []
  }
  const names: string[] = []
  if (pm.team_a_name && pm.team_a_name !== 'TBD') names.push(strip(pm.team_a_name))
  if (pm.team_b_name && pm.team_b_name !== 'TBD') names.push(strip(pm.team_b_name))
  return names
}

// ✅ 선수 쌍 인라인: 이름 굵게 + 클럽명 최대 6자 축약
// allMatches: 전체 경기(court 유무 무관) — TBD 예상 후보 계산용
function PlayerPairInline({ raw, allMatches, match, abSlot }: {
  raw: string
  allMatches?: CourtMatch[]
  match?: CourtMatch
  abSlot?: 'A' | 'B'
}) {
  const isTbd = !raw || raw === 'TBD'

  if (isTbd && allMatches && match && abSlot) {
    const candidates = getTbdCandidates(allMatches, match, raw, abSlot)
    if (candidates.length > 0) {
      return (
        <div className="flex items-start gap-1 min-w-0 flex-wrap">
          {candidates.map((name, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-stone-200 text-[9px] self-center">/</span>}
              <span className="text-[10px] text-stone-400 leading-tight whitespace-nowrap">{name}</span>
            </React.Fragment>
          ))}
        </div>
      )
    }
    return <span className="text-[10px] text-stone-300 italic">TBD</span>
  }

  const players = parsePlayers(raw)
  if (players.length === 0) return <span className="font-bold text-stone-800 text-xs">{raw || 'TBD'}</span>

  return (
    <div className="flex items-start gap-0.5 min-w-0 flex-1">
      {players.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-stone-300 text-[10px] flex-shrink-0 pt-px">/</span>}
          <div className="min-w-0 flex-1">
            <div className="font-bold text-stone-800 text-[11px] leading-tight whitespace-nowrap">{p.name}</div>
            {p.club && (
              <div className="text-[9px] text-stone-400 leading-tight whitespace-nowrap" title={p.club}>
                {shortClub(p.club, 6)}
              </div>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}
