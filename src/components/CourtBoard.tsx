'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

interface CourtMatch {
  id: string; match_num: string; court: string; court_order: number
  stage: string; round: string; status: string; score: string | null
  division_name: string
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  winner_team_id: string | null; is_team_tie?: boolean
}

export default function CourtBoard({ eventId }: { eventId: string }) {
  const [matches, setMatches]       = useState<CourtMatch[]>([])
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  // 이름 검색
  const [query, setQuery]           = useState('')
  const [suggestions, setSugg]      = useState<string[]>([])
  const [showSugg, setShowSugg]     = useState(false)
  const [searchResult, setResult]   = useState<{ name: string; court: string; idx: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggRef  = useRef<HTMLDivElement>(null)

  const loadData = useCallback(async () => {
    const { data: matchData } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId).not('court', 'is', null).order('court').order('court_order')
    const indivMatches: CourtMatch[] = ((matchData as any[]) || [])
      .filter(m => m.score !== 'BYE').map(m => ({ ...m, is_team_tie: false }))

    const { data: tieData } = await supabase.from('ties')
      .select('*, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)')
      .eq('event_id', eventId).not('court_number', 'is', null).order('court_number').order('tie_order')
    const sMap: Record<string, string> = { pending:'PENDING', lineup_phase:'PENDING', in_progress:'IN_PROGRESS', completed:'FINISHED' }
    const tieMatches: CourtMatch[] = ((tieData as any[]) || []).filter(t => !t.is_bye).map(t => ({
      id: 'tie_' + t.id, match_num: 'T#' + t.tie_order,
      court: '코트 ' + t.court_number,
      court_order: 100 + (t.tie_order || 0),
      stage: 'TEAM', round: t.round || 'group',
      status: sMap[t.status] || 'PENDING',
      score: (t.status === 'completed' || t.status === 'in_progress') ? t.club_a_rubbers_won + '-' + t.club_b_rubbers_won : null,
      division_name: '단체전',
      team_a_name: t.club_a?.name || 'TBD', team_b_name: t.club_b?.name || 'TBD',
      team_a_id: t.club_a_id || '', team_b_id: t.club_b_id || '',
      winner_team_id: t.winning_club_id || null, is_team_tie: true,
    }))

    setMatches([...indivMatches, ...tieMatches])
    setLoading(false)
    setLastUpdate(new Date())
  }, [eventId])

  useEffect(() => { loadData(); const i = setInterval(loadData, 15000); return () => clearInterval(i) }, [loadData])

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

  // byCourt 맵
  const byCourt = new Map<string, CourtMatch[]>()
  for (const m of matches) {
    if (!byCourt.has(m.court)) byCourt.set(m.court, [])
    byCourt.get(m.court)!.push(m)
  }
  const courts = Array.from(byCourt.keys()).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, '')) || 0
    const nb = parseInt(b.replace(/\D/g, '')) || 0
    return na - nb
  })

  // 전체 팀명 목록
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

  // 검색한 팀의 대기 상태
  const searchInfo = searchResult?.court ? (() => {
    const cms = (byCourt.get(searchResult.court) || []).sort((a,b) => (a.court_order||0)-(b.court_order||0))
    const liveIdx = cms.findIndex(m => m.status === 'IN_PROGRESS')
    const pendIdx = cms.findIndex(m => m.status === 'PENDING')
    const curIdx  = liveIdx >= 0 ? liveIdx : pendIdx
    const wait    = searchResult.idx > curIdx ? searchResult.idx - curIdx - 1 : 0
    return { wait, total: cms.length, done: cms.filter(m => m.status === 'FINISHED').length }
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
          <button onClick={loadData} className="text-xs px-2 py-1 bg-stone-100 rounded-lg hover:bg-stone-200">새로고침</button>
        </div>
      </div>

      {/* 이름 검색 */}
      <div className="bg-white rounded-xl border p-4">
        <div className="text-xs font-bold text-stone-500 mb-2">🔍 팀명으로 내 코트 찾기</div>
        <div className="relative">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input ref={inputRef} type="text" value={query}
                onChange={e => handleQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') doSearch(); if (e.key === 'Escape') setShowSugg(false) }}
                onFocus={() => suggestions.length > 0 && setShowSugg(true)}
                placeholder="팀명 입력 (예: 한라산, 탐라)"
                className="w-full border border-stone-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#2d5016]" />
              {showSugg && suggestions.length > 0 && (
                <div ref={suggRef} className="absolute top-full left-0 right-0 bg-white border border-stone-200 rounded-xl shadow-lg z-20 mt-1 overflow-hidden">
                  {suggestions.map(t => (
                    <button key={t} onClick={() => doSearch(t)}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-stone-50 border-b border-stone-50 last:border-0 transition-colors">
                      🎾 {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => doSearch()} className="px-4 py-2.5 bg-[#2d5016] text-white rounded-xl text-sm font-bold hover:bg-[#1e3a0f] transition-colors">검색</button>
            {query && (
              <button onClick={() => { setQuery(''); setSugg([]); setResult(null); setShowSugg(false) }}
                className="px-3 py-2.5 border border-stone-300 rounded-xl text-sm text-stone-400 hover:text-stone-600">✕</button>
            )}
          </div>
        </div>

        {/* 검색 결과 요약 */}
        {searchResult && (
          <div className={`mt-3 px-4 py-3 rounded-xl text-sm font-medium ${searchResult.court ? 'bg-blue-50 border border-blue-200 text-blue-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            {searchResult.court ? (
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <span className="font-bold">{searchResult.name}</span>
                  <span className="mx-2 text-blue-400">→</span>
                  <span className="font-black text-[#2d5016] text-base">📍 {searchResult.court}</span>
                  <span className="ml-2 text-blue-600 font-normal text-xs">({searchResult.idx + 1}번째 대기)</span>
                </div>
                {searchInfo && (
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${searchInfo.wait === 0 ? 'bg-red-100 text-red-700' : searchInfo.wait === 1 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                    {searchInfo.wait === 0 ? '⚡ 곧 내 차례!' : `⏳ ${searchInfo.wait}경기 후 내 차례`}
                  </span>
                )}
              </div>
            ) : (
              <span>"{searchResult.name}" 팀의 배정된 경기가 없습니다.</span>
            )}
          </div>
        )}
      </div>

      {/* 코트 그리드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {courts.map(court => {
          const cm      = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
          const ci      = cm.findIndex(m => m.status === 'IN_PROGRESS')
          const pi      = cm.findIndex(m => m.status === 'PENDING')
          const ai      = ci >= 0 ? ci : pi
          const fc      = cm.filter(m => m.status === 'FINISHED').length
          const tc      = cm.length
          const cur     = ai >= 0 ? cm[ai] : null
          const w1      = ai >= 0 && ai + 1 < cm.length ? cm[ai + 1] : null
          const w2      = ai >= 0 && ai + 2 < cm.length ? cm[ai + 2] : null
          const allDone = fc === tc
          const isSearchCourt = searchResult?.court === court

          return (
            <div key={court} className={`bg-white rounded-xl border overflow-hidden transition-all ${isSearchCourt ? 'ring-2 ring-blue-500 shadow-lg' : ''}`}>
              <div className={`px-4 py-2.5 font-bold text-sm flex items-center justify-between ${allDone ? 'bg-stone-400 text-white' : ci >= 0 ? 'bg-red-700 text-white' : 'bg-[#2d5016] text-white'}`}>
                <div className="flex items-center gap-2">
                  <span>{court}</span>
                  {ci >= 0 && !allDone && <span className="text-xs bg-white/20 px-1.5 py-0.5 rounded-full animate-pulse">LIVE</span>}
                  {isSearchCourt && <span className="text-xs bg-blue-500 px-1.5 py-0.5 rounded-full font-normal">← 검색</span>}
                </div>
                <span className="text-white/70 text-xs font-normal">{fc}/{tc} 완료</span>
              </div>
              <div className="p-3 space-y-2">
                {allDone ? (
                  <div className="text-center py-4 text-stone-400"><div className="text-2xl mb-1">✅</div><div className="text-sm">모든 경기 완료</div></div>
                ) : (<>
                  {cur && (
                    <CourtSlot label="🔴 현재 경기" labelColor="bg-red-50 text-red-700 border-red-200" match={cur}
                      highlight={isSearchCourt && (cur.team_a_name.toLowerCase().includes((searchResult?.name||'').toLowerCase()) || cur.team_b_name.toLowerCase().includes((searchResult?.name||'').toLowerCase()))} />
                  )}
                  {w1 && (
                    <CourtSlot label="🟡 다음 대기" labelColor="bg-amber-50 text-amber-700 border-amber-200" match={w1}
                      highlight={isSearchCourt && (w1.team_a_name.toLowerCase().includes((searchResult?.name||'').toLowerCase()) || w1.team_b_name.toLowerCase().includes((searchResult?.name||'').toLowerCase()))} />
                  )}
                  {w2 && (
                    <CourtSlot label="🟢 대기 2" labelColor="bg-green-50 text-green-700 border-green-200" match={w2}
                      highlight={isSearchCourt && (w2.team_a_name.toLowerCase().includes((searchResult?.name||'').toLowerCase()) || w2.team_b_name.toLowerCase().includes((searchResult?.name||'').toLowerCase()))} />
                  )}
                  {ai >= 0 && ai + 3 < cm.length && (
                    <RemainingMatches
                      matches={cm.slice(ai + 3).filter(m => m.status !== 'FINISHED')}
                      searchName={isSearchCourt ? searchResult?.name : undefined} />
                  )}
                </>)}
                {fc > 0 && <FinishedMatches matches={cm.filter(m => m.status === 'FINISHED')} />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CourtSlot({ label, labelColor, match, highlight }: { label: string; labelColor: string; match: CourtMatch; highlight?: boolean }) {
  const isTeam = match.is_team_tie
  return (
    <div className={`rounded-lg border p-2.5 ${highlight ? 'ring-2 ring-blue-400 ' : ''}${labelColor}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold">{label}</span>
        <span className="text-xs opacity-70">#{match.court_order > 100 ? match.match_num : match.court_order} · {match.round}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm truncate">{match.team_a_name || 'TBD'}</div>
          <div className="text-xs opacity-60">vs</div>
          <div className="font-bold text-sm truncate">{match.team_b_name || 'TBD'}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className={`text-xs font-medium px-2 py-0.5 rounded-full ${isTeam ? 'bg-blue-100 text-blue-700' : 'bg-white/50'}`}>
            {isTeam ? '📋 단체전' : match.division_name}
          </div>
          {match.score && <div className={`text-sm font-bold mt-1 ${isTeam ? 'text-blue-700' : ''}`}>{match.score}</div>}
        </div>
      </div>
    </div>
  )
}

function RemainingMatches({ matches, searchName }: { matches: CourtMatch[]; searchName?: string }) {
  const [open, setOpen] = useState(false)
  if (!matches.length) return null
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="text-xs text-stone-400 hover:text-stone-600 w-full text-left py-1">
        {open ? '▼' : '▶'} 이후 대기 {matches.length}경기
      </button>
      {open && (
        <div className="space-y-1 ml-3">
          {matches.map(m => {
            const isHit = searchName && (
              m.team_a_name.toLowerCase().includes(searchName.toLowerCase()) ||
              m.team_b_name.toLowerCase().includes(searchName.toLowerCase())
            )
            return (
              <div key={m.id} className={`text-xs py-1 border-b border-stone-50 last:border-0 ${isHit ? 'font-bold text-blue-700 bg-blue-50 px-1 rounded' : ''}`}>
                <span className="text-stone-400">#{m.is_team_tie ? m.match_num : m.court_order}</span>{' '}
                {m.is_team_tie && <span className="text-blue-600 mr-1">[단체]</span>}
                <span>{m.team_a_name}</span><span className="text-stone-300"> vs </span><span>{m.team_b_name}</span>
                {!m.is_team_tie && <span className="text-stone-400 ml-1">({m.division_name})</span>}
                {isHit && <span className="ml-1 text-blue-500">← 검색한 팀</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FinishedMatches({ matches }: { matches: CourtMatch[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-stone-100 pt-2 mt-2">
      <button onClick={() => setOpen(!open)} className="text-xs text-stone-400 hover:text-stone-600 w-full text-left">
        {open ? '▼' : '▶'} 완료 {matches.length}경기
      </button>
      {open && (
        <div className="space-y-1 mt-1 ml-3">
          {matches.map(m => (
            <div key={m.id} className="text-xs py-1 text-stone-400 border-b border-stone-50 last:border-0">
              <span>#{m.is_team_tie ? m.match_num : m.court_order}</span>{' '}
              {m.is_team_tie && <span className="text-blue-500 mr-1">[단체]</span>}
              <span>{m.team_a_name} vs {m.team_b_name}</span>
              {m.score && <span className={`font-bold ml-1 ${m.is_team_tie ? 'text-blue-600' : 'text-tennis-600'}`}>{m.score}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
