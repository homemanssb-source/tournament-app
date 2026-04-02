'use client'
// ============================================================
// src/components/CourtBoard.tsx
// ✅ [FIX-①⑨] 단체전 court명: '코트 N' → venues 기반 short_name-N 통일
// ✅ [FIX-⑤⑨] 단체전 court_order: 100+tie_order → DB 실제값 사용
// ✅ [FIX-⑨]  allCourts 정렬: 숫자+접두어 혼재 안전 처리
// ============================================================
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

interface CourtMatch {
  id: string; match_num: string; court: string; court_order: number
  stage: string; round: string; status: string; score: string | null
  division_name: string; division_id: string
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  winner_team_id: string | null; is_team_tie?: boolean
}

interface Venue {
  id: string; name: string; short_name: string; court_count: number
}

// ✅ courts/page.tsx, timetable/page.tsx와 동일한 변환 함수
function courtNumToName(courtNumber: number, venues: Venue[]): string {
  if (venues.length === 0) return `코트-${courtNumber}`
  if (venues.length === 1) {
    const v = venues[0]
    return `${v.short_name || v.name}-${courtNumber}`
  }
  let offset = 0
  for (const v of venues) {
    const count = v.court_count || 0
    if (courtNumber <= offset + count) {
      return `${v.short_name || v.name}-${courtNumber - offset}`
    }
    offset += count
  }
  const last = venues[venues.length - 1]
  return `${last.short_name || last.name}-${courtNumber}`
}

export default function CourtBoard({ eventId }: { eventId: string }) {
  const [matches, setMatches]       = useState<CourtMatch[]>([])
  const [venues, setVenues]         = useState<Venue[]>([])
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  const [query, setQuery]           = useState('')
  const [suggestions, setSugg]      = useState<string[]>([])
  const [showSugg, setShowSugg]     = useState(false)
  const [searchResult, setResult]   = useState<{ name: string; court: string; idx: number } | null>(null)
  const [dateFilter, setDateFilter] = useState<string>('ALL')
  const [venueFilter, setVenueFilter] = useState<string>('ALL')
  const [divMatchDates, setDivMatchDates] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const suggRef  = useRef<HTMLDivElement>(null)

  // ✅ venues 먼저 로드
  const loadVenues = useCallback(async () => {
    const { data } = await supabase
      .from('venues')
      .select('id, name, short_name, court_count')
      .eq('event_id', eventId)
      .order('created_at')
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
      in_progress: 'IN_PROGRESS', completed: 'FINISHED'
    }
    const tieMatches: CourtMatch[] = ((tieData as any[]) || []).filter(t => !t.is_bye).map(t => ({
      id: 'tie_' + t.id,
      match_num: 'T#' + t.tie_order,
      // ✅ [FIX-①⑨] short_name-N 포맷 통일
      court: courtNumToName(t.court_number, currentVenues),
      // ✅ [FIX-⑤⑨] DB 실제 court_order 사용
      court_order: t.court_order ?? t.tie_order ?? 999,
      stage: 'TEAM', round: t.round || 'group',
      status: sMap[t.status] || 'PENDING',
      score: (t.status === 'completed' || t.status === 'in_progress')
        ? `${t.club_a_rubbers_won ?? 0}-${t.club_b_rubbers_won ?? 0}`
        : null,
      division_name: '단체전', division_id: t.division_id || '',
      team_a_name: t.club_a?.name || 'TBD', team_b_name: t.club_b?.name || 'TBD',
      team_a_id: t.club_a_id || '', team_b_id: t.club_b_id || '',
      winner_team_id: t.winning_club_id || null, is_team_tie: true,
    }))

    setMatches([...indivMatches, ...tieMatches])
    setLoading(false)
    setLastUpdate(new Date())
  }, [eventId, venues])

  useEffect(() => {
    loadVenues().then(venueList => loadData(venueList))
    const i = setInterval(() => loadData(), 15000)
    return () => clearInterval(i)
  }, [loadData])

  // 첫 번째 날짜 자동 선택
  useEffect(() => {
    const dates = [...new Set(Object.values(divMatchDates))].sort()
    if (dates.length > 1 && dateFilter === 'ALL') setDateFilter(dates[0])
  }, [divMatchDates])

  // 부서별 날짜 로드
  useEffect(() => {
    if (!eventId) return
    supabase.from('divisions').select('id, match_date').eq('event_id', eventId)
      .then(({ data }) => {
        if (data) {
          const map: Record<string, string> = {}
          data.forEach((d: any) => { if (d.match_date) map[d.id] = d.match_date })
          setDivMatchDates(map)
        }
      })
  }, [eventId])

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (inputRef.current?.contains(e.target as Node)) return
      if (suggRef.current?.contains(e.target as Node)) return
      setShowSugg(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // 날짜 필터 적용
  const dateFilteredMatches = React.useMemo(() => {
    if (dateFilter === 'ALL') return matches
    const divIds = Object.entries(divMatchDates)
      .filter(([, d]) => d === dateFilter).map(([id]) => id)
    if (divIds.length === 0) return []
    return matches.filter(m => m.is_team_tie || divIds.includes(m.division_id))
  }, [matches, dateFilter, divMatchDates])

  const byCourt = new Map<string, CourtMatch[]>()
  for (const m of dateFilteredMatches) {
    if (!byCourt.has(m.court)) byCourt.set(m.court, [])
    byCourt.get(m.court)!.push(m)
  }

  // ✅ [FIX-⑨] 코트 정렬: short_name-N 포맷 대응 (접두어 알파벳 → 숫자 순)
  const allCourts = Array.from(byCourt.keys()).sort((a, b) => {
    const getNum = (s: string) => {
      const last = s.split('-').pop() || ''
      return /^\d+$/.test(last) ? parseInt(last, 10) : parseInt(s.replace(/\D/g, ''), 10) || 0
    }
    const getPrefix = (s: string) => s.split('-').slice(0, -1).join('-') || s
    const prefixA = getPrefix(a), prefixB = getPrefix(b)
    if (prefixA !== prefixB) return prefixA.localeCompare(prefixB)
    return getNum(a) - getNum(b)
  })

  const getVenueName = (court: string) =>
    court.includes('-') ? court.split('-').slice(0, -1).join('-') : court
  const allVenues = [...new Set(allCourts.map(getVenueName))].sort()
  const courts = venueFilter === 'ALL' ? allCourts : allCourts.filter(c => getVenueName(c) === venueFilter)

  const allTeams = Array.from(new Set(
    matches.flatMap(m => [m.team_a_name, m.team_b_name]).filter(n => n && n !== 'TBD')
  )).sort()

  function handleQuery(v: string) {
    setQuery(v); setResult(null)
    if (!v.trim()) { setSugg([]); setShowSugg(false); return }
    const filtered = allTeams.filter(t => t.toLowerCase().includes(v.toLowerCase()))
    setSugg(filtered.slice(0, 6)); setShowSugg(filtered.length > 0)
  }

  function doSearch(name?: string) {
    const target = (name ?? query).trim()
    setQuery(target); setSugg([]); setShowSugg(false)
    if (!target) return
    for (const [court, cms] of byCourt) {
      const sorted = [...cms].sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
      const idx = sorted.findIndex(m =>
        m.team_a_name.toLowerCase().includes(target.toLowerCase()) ||
        m.team_b_name.toLowerCase().includes(target.toLowerCase())
      )
      if (idx >= 0) { setResult({ name: target, court, idx }); return }
    }
    setResult({ name: target, court: '', idx: -1 })
  }

  const searchInfo = searchResult?.court ? (() => {
    const cms     = (byCourt.get(searchResult.court) || []).sort((a,b) => (a.court_order||0)-(b.court_order||0))
    const liveIdx = cms.findIndex(m => m.status === 'IN_PROGRESS')
    const pendIdx = cms.findIndex(m => m.status === 'PENDING')
    const curIdx  = liveIdx >= 0 ? liveIdx : pendIdx
    const idx     = searchResult.idx
    const isLive  = idx === liveIdx && liveIdx >= 0
    const hasLive = liveIdx >= 0
    const waitNum = idx > curIdx ? idx - curIdx : 0
    let posLabel = ''
    let urgency  = 0
    if (isLive) {
      posLabel = '현재 경기 중'; urgency = 2
    } else if (idx === curIdx && !hasLive) {
      posLabel = '지금 내 차례'; urgency = 2
    } else if (idx === curIdx && hasLive) {
      posLabel = '다음 대기'; urgency = 1
    } else if (waitNum === 1) {
      posLabel = '다음 대기'; urgency = 1
    } else {
      posLabel = `${waitNum}번째 대기`; urgency = 0
    }
    return {
      isLive, hasLive,
      wait: waitNum - 1 < 0 ? 0 : waitNum - 1,
      urgency, posLabel,
      total: cms.length,
      done: cms.filter(m => m.status === 'FINISHED').length,
    }
  })() : null

  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!courts.length) return <p className="text-center py-10 text-stone-400">아직 코트 배정이 없습니다.</p>

  return (
    <div className="space-y-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-lg">🎾 코트 현황</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">🔄 {lastUpdate.toLocaleTimeString('ko-KR')} 업데이트</span>
          <button onClick={() => loadData()} className="text-xs px-2 py-1 bg-stone-100 rounded-lg hover:bg-stone-200">새로고침</button>
        </div>
      </div>

      {/* 날짜 탭 */}
      {Object.keys(divMatchDates).length > 0 && (() => {
        const uniqueDates = [...new Set(Object.values(divMatchDates))].sort()
        if (uniqueDates.length < 2) return null
        return (
          <div className="bg-white rounded-xl border p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-stone-500 font-medium whitespace-nowrap">📅 날짜:</span>
              {uniqueDates.map(date => {
                const label = new Date(date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })
                const divsOnDate = Object.entries(divMatchDates)
                  .filter(([, d]) => d === date).map(([id]) => id)
                return (
                  <button key={date} onClick={() => { setDateFilter(date); setVenueFilter('ALL') }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${dateFilter === date ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-600 border-stone-300 hover:border-blue-400'}`}>
                    {label} <span className="opacity-70">({divsOnDate.length}부문)</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* 장소 탭 */}
      {allVenues.length > 1 && (
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

      {/* 이름 검색 */}
      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input ref={inputRef} type="text" value={query}
              onChange={e => handleQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              onFocus={() => query && suggestions.length > 0 && setShowSugg(true)}
              placeholder="팀/선수 이름으로 검색"
              className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-tennis-400" />
            {showSugg && suggestions.length > 0 && (
              <div ref={suggRef} className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg z-10 overflow-hidden">
                {suggestions.map(s => (
                  <button key={s} onClick={() => doSearch(s)}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-stone-50 border-b last:border-b-0 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => doSearch()}
            className="bg-[#2d5016] text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-[#3d6b20] transition-colors">
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

      {/* 코트 카드 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {courts.map(court => {
          const cms = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
          const liveIdx  = cms.findIndex(m => m.status === 'IN_PROGRESS')
          const pendIdx  = cms.findIndex(m => m.status === 'PENDING')
          const curIdx   = liveIdx >= 0 ? liveIdx : pendIdx
          const isLive   = liveIdx >= 0
          const finished = cms.filter(m => m.status === 'FINISHED').length
          const isHighlight = searchResult?.court === court

          return (
            <div key={court} className={`bg-white rounded-xl border overflow-hidden transition-all ${isHighlight ? 'ring-2 ring-blue-400 shadow-lg' : 'shadow-sm'}`}>
              <div className={`px-4 py-2.5 flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm">{court}</span>
                  {isLive && <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}
                </div>
                <span className="text-xs text-white/60">{finished}/{cms.length}</span>
              </div>
              <div className="p-2 space-y-1.5 max-h-[50vh] overflow-y-auto">
                {cms.map((m, idx) => {
                  const isDone = m.status === 'FINISHED'
                  const isLiveMat = m.status === 'IN_PROGRESS'
                  const isCurrent = idx === curIdx
                  const isNext = idx === curIdx + 1
                  const isSearch = searchResult?.court === court && searchResult.idx === idx

                  return (
                    <div key={m.id} className={`rounded-lg px-3 py-2 text-xs transition-all border ${
                      isSearch   ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-300'
                      : isDone   ? 'bg-stone-50 border-stone-100 opacity-50'
                      : isLiveMat ? 'bg-red-50 border-red-200'
                      : isCurrent ? 'bg-amber-50 border-amber-200'
                      : isNext   ? 'bg-yellow-50/50 border-stone-100'
                      : m.is_team_tie ? 'bg-blue-50/40 border-blue-100'
                      : 'bg-white border-stone-100'
                    }`}>
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <div className="flex items-center gap-1">
                          <span className="text-stone-400 font-mono">#{idx + 1}</span>
                          {m.is_team_tie && (
                            <span className="text-[9px] bg-blue-600 text-white px-1 rounded">단체</span>
                          )}
                          {isLiveMat && <span className="text-red-500 animate-pulse text-[10px]">● LIVE</span>}
                          {!isLiveMat && isCurrent && <span className="text-amber-600 text-[10px] font-bold">▶ 현재</span>}
                          {!isLiveMat && isNext   && <span className="text-yellow-600 text-[10px]">다음</span>}
                        </div>
                        <span className="text-stone-400">{m.division_name}</span>
                      </div>
                      <div className={`font-medium leading-snug ${isDone ? 'line-through text-stone-400' : ''}`}>
                        {m.team_a_name}
                        <span className="text-stone-300 mx-1">vs</span>
                        {m.team_b_name}
                      </div>
                      {m.score && <div className={`mt-0.5 font-bold ${isDone ? 'text-stone-500' : 'text-tennis-700'}`}>{m.score}</div>}
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
