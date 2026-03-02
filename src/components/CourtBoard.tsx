'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

interface CourtMatch {
  id: string; match_num: string; court: string; court_order: number
  stage: string; round: string; status: string; score: string | null
  division_name: string
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  winner_team_id: string | null
}

export default function CourtBoard({ eventId }: { eventId: string }) {
  const [matches, setMatches] = useState<CourtMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  const loadMatches = useCallback(async () => {
    const { data } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId)
      .not('court', 'is', null)
      .order('court').order('court_order')
    // BYE 제외 (프론트 필터 - DB의 neq는 NULL score를 제외시킴)
    const filtered = (data as any[] || []).filter(m => m.score !== 'BYE')
    setMatches(filtered)
    setLoading(false)
    setLastUpdate(new Date())
  }, [eventId])

  useEffect(() => {
    loadMatches()
    // 15초마다 자동 새로고침
    const interval = setInterval(loadMatches, 15000)
    return () => clearInterval(interval)
  }, [loadMatches])

  // 코트별 그룹핑
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

  if (loading) return <p className="text-center py-10 text-stone-400">불러오는 중...</p>
  if (!courts.length) return <p className="text-center py-10 text-stone-400">아직 코트 배정이 없습니다.</p>

  return (
    <div className="space-y-6">
      {/* 헤더 + 자동 새로고침 표시 */}
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-lg">🎾 코트 현황</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">
            🔄 {lastUpdate.toLocaleTimeString('ko-KR')} 업데이트
          </span>
          <button onClick={loadMatches} className="text-xs px-2 py-1 bg-stone-100 rounded-lg hover:bg-stone-200">
            새로고침
          </button>
        </div>
      </div>

      {/* 코트 카드들 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {courts.map(court => {
          const courtMatches = byCourt.get(court) || []
          // 현재 진행 or 첫 번째 미완료 경기
          const currentIdx = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
          const firstPendingIdx = courtMatches.findIndex(m => m.status === 'PENDING')
          const activeIdx = currentIdx >= 0 ? currentIdx : firstPendingIdx
          const finishedCount = courtMatches.filter(m => m.status === 'FINISHED').length
          const totalCount = courtMatches.length

          const currentMatch = activeIdx >= 0 ? courtMatches[activeIdx] : null
          const waiting1 = activeIdx >= 0 && activeIdx + 1 < courtMatches.length ? courtMatches[activeIdx + 1] : null
          const waiting2 = activeIdx >= 0 && activeIdx + 2 < courtMatches.length ? courtMatches[activeIdx + 2] : null

          const allDone = finishedCount === totalCount

          return (
            <div key={court} className="bg-white rounded-xl border overflow-hidden">
              {/* 코트 헤더 */}
              <div className={`px-4 py-2.5 font-bold text-sm flex items-center justify-between ${
                allDone ? 'bg-stone-400 text-white' : 'bg-[#2d5016] text-white'
              }`}>
                <span>{court}</span>
                <span className="text-white/70 text-xs font-normal">
                  {finishedCount}/{totalCount} 완료
                </span>
              </div>

              <div className="p-3 space-y-2">
                {allDone ? (
                  <div className="text-center py-4 text-stone-400">
                    <div className="text-2xl mb-1">✅</div>
                    <div className="text-sm">모든 경기 완료</div>
                  </div>
                ) : (
                  <>
                    {/* 🔴 현재 경기 */}
                    {currentMatch && (
                      <CourtSlot
                        label="🔴 현재 경기"
                        labelColor="bg-red-50 text-red-700 border-red-200"
                        match={currentMatch}
                      />
                    )}

                    {/* 🟡 대기 1 */}
                    {waiting1 && (
                      <CourtSlot
                        label="🟡 다음 대기"
                        labelColor="bg-amber-50 text-amber-700 border-amber-200"
                        match={waiting1}
                      />
                    )}

                    {/* 🟢 대기 2 */}
                    {waiting2 && (
                      <CourtSlot
                        label="🟢 대기 2"
                        labelColor="bg-green-50 text-green-700 border-green-200"
                        match={waiting2}
                      />
                    )}

                    {/* 나머지 대기 (접힘) */}
                    {activeIdx >= 0 && activeIdx + 3 < courtMatches.length && (
                      <RemainingMatches
                        matches={courtMatches.slice(activeIdx + 3).filter(m => m.status !== 'FINISHED')}
                      />
                    )}
                  </>
                )}

                {/* 완료된 경기 (접힘) */}
                {finishedCount > 0 && (
                  <FinishedMatches
                    matches={courtMatches.filter(m => m.status === 'FINISHED')}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 코트 슬롯 (현재/대기 표시)
function CourtSlot({ label, labelColor, match }: {
  label: string; labelColor: string; match: CourtMatch
}) {
  return (
    <div className={`rounded-lg border p-2.5 ${labelColor}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold">{label}</span>
        <span className="text-xs opacity-70">#{match.court_order} · {match.round}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm truncate">{match.team_a_name || 'TBD'}</div>
          <div className="text-xs opacity-60">vs</div>
          <div className="font-bold text-sm truncate">{match.team_b_name || 'TBD'}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/50">
            {match.division_name}
          </div>
          {match.score && match.status === 'FINISHED' && (
            <div className="text-sm font-bold mt-1">{match.score}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// 나머지 대기 경기 (토글)
function RemainingMatches({ matches }: { matches: CourtMatch[] }) {
  const [open, setOpen] = useState(false)
  if (!matches.length) return null

  return (
    <div>
      <button onClick={() => setOpen(!open)}
        className="text-xs text-stone-400 hover:text-stone-600 w-full text-left py-1">
        {open ? '▼' : '▶'} 이후 대기 {matches.length}경기
      </button>
      {open && (
        <div className="space-y-1 ml-3">
          {matches.map((m, i) => (
            <div key={m.id} className="text-xs py-1 border-b border-stone-50 last:border-0">
              <span className="text-stone-400">#{m.court_order}</span>{' '}
              <span className="font-medium">{m.team_a_name}</span>
              <span className="text-stone-300"> vs </span>
              <span className="font-medium">{m.team_b_name}</span>
              <span className="text-stone-400 ml-1">({m.division_name})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 완료 경기 (토글)
function FinishedMatches({ matches }: { matches: CourtMatch[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-stone-100 pt-2 mt-2">
      <button onClick={() => setOpen(!open)}
        className="text-xs text-stone-400 hover:text-stone-600 w-full text-left">
        {open ? '▼' : '▶'} 완료 {matches.length}경기
      </button>
      {open && (
        <div className="space-y-1 mt-1 ml-3">
          {matches.map(m => (
            <div key={m.id} className="text-xs py-1 text-stone-400 border-b border-stone-50 last:border-0">
              <span>#{m.court_order}</span>{' '}
              <span>{m.team_a_name} vs {m.team_b_name}</span>
              {m.score && <span className="font-bold text-tennis-600 ml-1">{m.score}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
