'use client'
// ============================================================
// src/app/dashboard/timetable/page.tsx
// ✅ [FIX-①] 단체전 코트명 포맷 통일: venues 로드 후 short_name-N 변환
// ✅ [FIX-⑤] 단체전 court_order: DB 실제값 사용 (100+tie_order 하드코딩 제거)
// ✅ [FIX] 개인전 BYE 필터: .neq('score','BYE') 제거 → 클라이언트 필터
// ============================================================
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId } from '@/components/useDashboard'

interface Venue {
  id: string
  name: string
  short_name: string
  court_count: number
}

interface MatchRow {
  id: string
  match_num: string
  court: string
  court_order: number
  status: string
  score: string | null
  team_a_name: string
  team_b_name: string
  division_name: string
  round: string
  started_at: string | null
  ended_at: string | null
  is_team: boolean
}

interface CourtTimeline {
  court: string
  matches: (MatchRow & {
    estimated_start: Date | null
    estimated_end: Date | null
  })[]
}

// ✅ court_number(숫자) → short_name-N 포맷 변환
// courts/page.tsx의 tiesToMatchSlim()과 동일한 로직
function courtNumToName(courtNumber: number, venues: Venue[]): string {
  if (venues.length === 0) return `코트-${courtNumber}`
  // 베뉴가 1개면 단순 매핑
  if (venues.length === 1) {
    const v = venues[0]
    return `${v.short_name || v.name}-${courtNumber}`
  }
  // 베뉴가 여러 개: court_number를 글로벌 순서로 해석
  // 베뉴 순서대로 코트를 순차 할당한 것으로 가정
  let offset = 0
  for (const v of venues) {
    const count = v.court_count || 0
    if (courtNumber <= offset + count) {
      const localNum = courtNumber - offset
      return `${v.short_name || v.name}-${localNum}`
    }
    offset += count
  }
  // 범위 초과 시 마지막 베뉴 기준
  const last = venues[venues.length - 1]
  return `${last.short_name || last.name}-${courtNumber}`
}

export default function TimetablePage() {
  const eventId = useEventId()

  const [matches, setMatches]   = useState<MatchRow[]>([])
  const [venues, setVenues]     = useState<Venue[]>([])
  const [loading, setLoading]   = useState(true)

  const [startTime, setStartTime] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T09:00`
  })
  const [matchDuration, setMatchDuration]   = useState(60)
  const [warmupDuration, setWarmupDuration] = useState(10)
  const [showFinished, setShowFinished]     = useState(true)

  // ✅ venues 먼저 로드 (court_number → courtName 변환에 필요)
  const loadVenues = useCallback(async () => {
    if (!eventId) return
    const { data } = await supabase
      .from('venues')
      .select('id, name, short_name, court_count')
      .eq('event_id', eventId)
      .order('created_at')
    setVenues((data || []) as Venue[])
    return (data || []) as Venue[]
  }, [eventId])

  const loadData = useCallback(async (venueList?: Venue[]) => {
    if (!eventId) return
    try {
      const currentVenues = venueList ?? venues

      // ✅ 개인전: .neq('score','BYE') 제거 → 클라이언트 필터 (NULL score 포함)
      const { data: matchData } = await supabase
        .from('v_matches_with_teams')
        .select('id, match_num, court, court_order, status, score, team_a_name, team_b_name, division_name, round, started_at, ended_at')
        .eq('event_id', eventId)
        .not('court', 'is', null)
        .order('court')
        .order('court_order', { ascending: true, nullsFirst: false })

      const indivRows: MatchRow[] = (matchData || [])
        .filter((m: any) => m.score !== 'BYE')  // ✅ 클라이언트 필터
        .map((m: any) => ({
          id: m.id, match_num: m.match_num,
          court: m.court, court_order: m.court_order ?? 999,
          status: m.status, score: m.score,
          team_a_name: m.team_a_name, team_b_name: m.team_b_name,
          division_name: m.division_name, round: m.round,
          started_at: m.started_at ?? null, ended_at: m.ended_at ?? null,
          is_team: false,
        }))

      // ✅ 단체전: court_order DB 실제값 사용 + courtName 포맷 통일
      const { data: tieData } = await supabase
        .from('ties')
        .select('id, tie_order, court_order, status, round, court_number, is_bye, club_a_rubbers_won, club_b_rubbers_won, started_at, ended_at, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)')
        .eq('event_id', eventId)
        .not('court_number', 'is', null)
        .eq('is_bye', false)
        .order('court_order', { ascending: true, nullsFirst: false })

      const tieRows: MatchRow[] = (tieData || []).map((t: any) => {
        // ✅ [FIX-①] courts/page.tsx의 tiesToMatchSlim과 동일한 courtName 생성
        const courtName = courtNumToName(t.court_number, currentVenues)
        // ✅ [FIX-⑤] DB의 실제 court_order 사용 (100+tie_order 하드코딩 제거)
        const courtOrder = t.court_order ?? t.tie_order ?? 999
        return {
          id: t.id, match_num: `T#${t.tie_order}`,
          court: courtName, court_order: courtOrder,
          status: t.status === 'completed' ? 'FINISHED' : t.status === 'in_progress' ? 'IN_PROGRESS' : 'PENDING',
          score: (t.status === 'completed' || t.status === 'in_progress') ? `${t.club_a_rubbers_won ?? 0}-${t.club_b_rubbers_won ?? 0}` : null,
          team_a_name: t.club_a?.name ?? 'TBD', team_b_name: t.club_b?.name ?? 'TBD',
          division_name: '단체전', round: t.round ?? 'group',
          started_at: t.started_at ?? null, ended_at: t.ended_at ?? null,
          is_team: true,
        }
      })

      setMatches([...indivRows, ...tieRows])
    } finally {
      setLoading(false)
    }
  }, [eventId, venues])

  useEffect(() => {
    if (!eventId) return
    // venues 먼저 로드한 뒤 loadData에 직접 전달 (venues state 반영 타이밍 이슈 방지)
    loadVenues().then(venueList => loadData(venueList))
  }, [eventId])

  useEffect(() => {
    if (!eventId) return
    const iv = setInterval(() => loadData(), 15000)
    return () => clearInterval(iv)
  }, [loadData])

  function buildTimeline(): CourtTimeline[] {
    const base = new Date(startTime)
    if (isNaN(base.getTime())) return []

    const sorted = [...matches].sort((a, b) =>
      a.court !== b.court ? a.court.localeCompare(b.court) : a.court_order - b.court_order
    )

    const courtMap = new Map<string, MatchRow[]>()
    for (const m of sorted) {
      if (!courtMap.has(m.court)) courtMap.set(m.court, [])
      courtMap.get(m.court)!.push(m)
    }

    const result: CourtTimeline[] = []
    const durMs  = matchDuration * 60 * 1000
    const warmMs = warmupDuration * 60 * 1000

    for (const [court, courtMatches] of Array.from(courtMap.entries()).sort()) {
      let cursor = new Date(base)
      const withTime = courtMatches.map(m => {
        let estStart: Date | null = null
        let estEnd:   Date | null = null

        if (m.status === 'FINISHED' && m.started_at && m.ended_at) {
          estStart = new Date(m.started_at)
          estEnd   = new Date(m.ended_at)
          const next = new Date(estEnd.getTime() + warmMs)
          if (next > cursor) cursor = next
        } else if (m.status === 'FINISHED' && m.started_at) {
          estStart = new Date(m.started_at)
          estEnd   = new Date(estStart.getTime() + durMs)
          cursor   = new Date(estEnd.getTime() + warmMs)
        } else if (m.status === 'IN_PROGRESS' && m.started_at) {
          estStart = new Date(m.started_at)
          estEnd   = new Date(estStart.getTime() + durMs)
          cursor   = new Date(estEnd.getTime() + warmMs)
        } else {
          estStart = new Date(cursor)
          estEnd   = new Date(cursor.getTime() + durMs)
          cursor   = new Date(estEnd.getTime() + warmMs)
        }
        return { ...m, estimated_start: estStart, estimated_end: estEnd }
      })
      result.push({ court, matches: withTime })
    }
    return result
  }

  const timeline = buildTimeline()

  function fmt(d: Date | null) {
    if (!d) return '-'
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })
  }
  function fmtDuration(start: string, end?: string | null) {
    const mins = Math.round(((end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()) / 60000)
    return mins < 60 ? `${mins}분` : `${Math.floor(mins/60)}시간 ${mins%60}분`
  }
  function statusBadge(m: MatchRow) {
    if (m.status === 'FINISHED')    return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">완료</span>
    if (m.status === 'IN_PROGRESS') return <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />LIVE</span>
    return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">대기</span>
  }

  const stats = {
    total:    matches.length,
    finished: matches.filter(m => m.status === 'FINISHED').length,
    live:     matches.filter(m => m.status === 'IN_PROGRESS').length,
    pending:  matches.filter(m => m.status === 'PENDING').length,
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">⏱ 경기 타임테이블</h1>

      {/* 설정 */}
      <div className="bg-white rounded-xl border p-4 space-y-3">
        <h3 className="font-semibold text-sm text-stone-600">⚙️ 타임테이블 설정</h3>
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="text-xs text-stone-500 block mb-1">대회 시작 시간</label>
            <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-stone-500 block mb-1">경기당 예상 시간</label>
            <select value={matchDuration} onChange={e => setMatchDuration(Number(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm">
              {[30,45,60,75,90,120].map(n => <option key={n} value={n}>{n}분</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-stone-500 block mb-1">경기 간 준비 시간</label>
            <select value={warmupDuration} onChange={e => setWarmupDuration(Number(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm">
              {[0,5,10,15,20].map(n => <option key={n} value={n}>{n}분</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-600 cursor-pointer">
            <input type="checkbox" checked={showFinished} onChange={e => setShowFinished(e.target.checked)} className="rounded" />
            완료 경기 표시
          </label>
        </div>
        <p className="text-xs text-stone-400">* 완료 경기는 실제 시간 기준 · 대기 경기는 앞 경기 종료 후 준비시간 더해 계산</p>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: '전체', value: stats.total,    color: 'bg-stone-100 text-stone-700' },
          { label: '완료', value: stats.finished, color: 'bg-green-100 text-green-700' },
          { label: 'LIVE', value: stats.live,     color: 'bg-red-100 text-red-700'    },
          { label: '대기', value: stats.pending,  color: 'bg-amber-100 text-amber-700'},
        ].map(s => (
          <div key={s.label} className={`rounded-xl p-3 text-center ${s.color}`}>
            <div className="text-2xl font-black">{s.value}</div>
            <div className="text-xs font-medium mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <p className="text-center py-10 text-stone-400">불러오는 중...</p>
      ) : timeline.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center text-amber-700 text-sm">
          코트가 배정된 경기가 없습니다. 코트 배정 페이지에서 경기를 배정해주세요.
        </div>
      ) : (
        <div className="space-y-4">
          {timeline.map(({ court, matches: cm }) => {
            const visible   = showFinished ? cm : cm.filter(m => m.status !== 'FINISHED')
            if (visible.length === 0) return null
            const isLive    = cm.some(m => m.status === 'IN_PROGRESS')
            const doneCount = cm.filter(m => m.status === 'FINISHED').length
            const nextPend  = cm.find(m => m.status === 'PENDING')

            return (
              <div key={court} className="bg-white rounded-xl border overflow-hidden">
                <div className={`px-4 py-2.5 flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{court}</span>
                    {isLive && <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-white/70">
                    <span>{doneCount}/{cm.length} 완료</span>
                    {nextPend?.estimated_start && <span>다음: {fmt(nextPend.estimated_start)}</span>}
                  </div>
                </div>

                <div className="divide-y">
                  {visible.map((m, idx) => {
                    const isDone    = m.status === 'FINISHED'
                    const isLiveMat = m.status === 'IN_PROGRESS'
                    const isPending = m.status === 'PENDING'
                    return (
                      <div key={m.id} className={`flex items-center gap-3 px-4 py-3 text-sm ${isLiveMat ? 'bg-red-50' : isDone ? 'opacity-60' : ''}`}>
                        <span className={`text-xs font-bold w-5 text-center flex-shrink-0 ${isLiveMat ? 'text-red-600' : 'text-stone-400'}`}>{idx+1}</span>

                        <div className="w-24 flex-shrink-0 text-center">
                          {isDone && m.started_at ? (
                            <><div className="font-medium text-xs text-green-700">{fmt(new Date(m.started_at))}</div>
                            <div className="text-xs text-stone-400">{m.ended_at && fmtDuration(m.started_at, m.ended_at)}</div></>
                          ) : isLiveMat && m.started_at ? (
                            <><div className="font-medium text-xs text-red-600">{fmt(new Date(m.started_at))} ~</div>
                            <div className="text-xs text-red-400">{fmtDuration(m.started_at)} 경과</div></>
                          ) : (
                            <><div className={`font-medium text-xs ${isPending ? 'text-amber-700' : 'text-stone-400'}`}>{fmt(m.estimated_start)}</div>
                            <div className="text-xs text-stone-300">예상</div></>
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className={`font-medium truncate ${isDone ? 'text-stone-400 line-through' : ''}`}>
                            {m.team_a_name}<span className="text-stone-300 mx-1.5">vs</span>{m.team_b_name}
                          </div>
                          <div className="text-xs text-stone-400 flex items-center gap-1.5 mt-0.5">
                            <span>{m.division_name}</span><span>·</span><span>{m.match_num}</span>
                            {m.is_team && <span className="bg-blue-100 text-blue-600 px-1 rounded">단체</span>}
                          </div>
                        </div>

                        <div className="flex-shrink-0">
                          {isDone && m.score
                            ? <span className="text-base font-black text-stone-700">{m.score}</span>
                            : statusBadge(m)}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {(() => {
                  const last = cm[cm.length - 1]
                  if (!last?.estimated_end) return null
                  return (
                    <div className="px-4 py-2 bg-stone-50 border-t text-xs text-stone-500 flex justify-between">
                      <span>예상 종료</span>
                      <span className="font-medium">{fmt(last.estimated_end)}</span>
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}
      <p className="text-xs text-stone-400 text-center pb-4">♻ 15초 자동 갱신</p>
    </div>
  )
}
