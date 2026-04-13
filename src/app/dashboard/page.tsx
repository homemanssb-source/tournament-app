'use client'
import React from 'react'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useEventId } from '@/components/useDashboard'

interface EventStats {
  event: any
  divisions: any[]
  totalMatches: number
  finishedMatches: number
  inProgressMatches: number
  totalTies: number
  finishedTies: number
  inProgressTies: number
  totalTeams: number
  totalClubs: number
  completedGroups: number
  totalGroups: number
}

interface MatchRow {
  id: string
  match_num: string
  division_name: string
  division_id: string
  group_label: string | null
  stage: string
  round: string
  team_a_name: string
  team_b_name: string
  team_a_id: string
  team_b_id: string
  winner_team_id: string | null
  score: string | null
  court: string | null
  status: string
  updated_at: string
}

export default function DashboardPage() {
  const eventId = useEventId()
  const [stats, setStats] = useState<EventStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [recentActivity, setRecentActivity] = useState<any[]>([])

  const [allMatches, setAllMatches] = useState<MatchRow[]>([])
  const [matchFilter, setMatchFilter] = useState<string>('ALL')
  const [showResults, setShowResults] = useState(false)

  const [tiedGroups, setTiedGroups] = useState<any[]>([])
  const [showTieAdjust, setShowTieAdjust] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [adjustMsg, setAdjustMsg] = useState('')
  const [dateMatchFilter, setDateMatchFilter] = useState<string>('ALL_DATE')

  const loadStats = useCallback(async () => {
    if (!eventId) { setLoading(false); return }
    setLoading(true)
    try {
      // ✅ 최적화: 14개 → 8개 쿼리로 통합, detectTied도 동시 실행
      const [
        evRes, divRes,
        matchRes,           // status별 집계를 클라이언트에서 처리 (3개→1개)
        tieRes,             // status별 집계를 클라이언트에서 처리 (3개→1개)
        teamCountRes, clubCountRes,
        groupRes,           // count + is_finalized 동시 (1개)
        recentMatchRes, recentTieRes,
        allMatchRes,
        allGroupMatchRes,   // detectTied용 — 전체 한 번에 조회 (N개→1개)
        allTeamsRes,        // detectTied용 — teams 전체 한 번에 조회 (M개→1개)
      ] = await Promise.all([
        supabase.from('events').select('*').eq('id', eventId).single(),
        supabase.from('divisions').select('id,name,match_date').eq('event_id', eventId).order('sort_order'),
        // ✅ matches: status별 3번 count → 한 번에 id+status만 조회
        supabase.from('matches').select('id,status').eq('event_id', eventId).neq('score', 'BYE'),
        // ✅ ties: status별 3번 count → 한 번에 id+status만 조회
        supabase.from('ties').select('id,status').eq('event_id', eventId).eq('is_bye', false),
        supabase.from('teams').select('id', { count: 'exact' }).eq('event_id', eventId),
        supabase.from('clubs').select('id', { count: 'exact' }).eq('event_id', eventId),
        // ✅ groups: count + is_finalized 한 번에
        supabase.from('groups').select('id,is_finalized,group_label,division_id,division_name').eq('event_id', eventId),
        supabase.from('v_matches_with_teams').select('team_a_name,team_b_name,score,division_name,updated_at').eq('event_id', eventId).eq('status', 'FINISHED').order('updated_at', { ascending: false }).limit(5),
        supabase.from('ties').select('*, updated_at, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)').eq('event_id', eventId).eq('status', 'completed').order('updated_at', { ascending: false }).limit(5),
        supabase.from('v_matches_with_teams')
          .select('id,match_num,division_name,division_id,group_label,stage,round,team_a_name,team_b_name,team_a_id,team_b_id,winner_team_id,score,court,status,updated_at')
          .eq('event_id', eventId).eq('status', 'FINISHED').neq('score', 'BYE')
          .order('updated_at', { ascending: false }).limit(200),
        // ✅ detectTied용: group_id 있는 완료 경기 전체를 한 번에
        supabase.from('v_matches_with_teams')
          .select('team_a_id,team_b_id,team_a_name,team_b_name,winner_team_id,score,group_id')
          .eq('event_id', eventId).eq('status', 'FINISHED').neq('score', 'BYE')
          .not('group_id', 'is', null),
        // ✅ detectTied용: teams 전체를 한 번에
        supabase.from('teams').select('id,team_name,manual_rank').eq('event_id', eventId),
      ])

      // ✅ matches status 집계 — 클라이언트에서 처리
      const matchList = matchRes.data || []
      const totalMatches    = matchList.length
      const finishedMatches = matchList.filter((m: any) => m.status === 'FINISHED').length
      const inProgressMatches = matchList.filter((m: any) => m.status === 'IN_PROGRESS').length

      // ✅ ties status 집계 — 클라이언트에서 처리
      const tieList = tieRes.data || []
      const totalTies    = tieList.length
      const finishedTies = tieList.filter((t: any) => t.status === 'completed').length
      const inProgressTies = tieList.filter((t: any) => t.status === 'in_progress').length

      const groups = groupRes.data || []
      const completedGroups = groups.filter((g: any) => g.is_finalized).length

      setStats({
        event: evRes.data,
        divisions: divRes.data || [],
        totalMatches, finishedMatches, inProgressMatches,
        totalTies, finishedTies, inProgressTies,
        totalTeams: teamCountRes.count || 0,
        totalClubs: clubCountRes.count || 0,
        completedGroups,
        totalGroups: groups.length,
      })

      const recentMatches = (recentMatchRes.data || []).map((m: any) => ({
        type: 'match',
        desc: `${m.team_a_name} vs ${m.team_b_name}`,
        detail: `${m.division_name} · ${m.score}`,
        time: m.updated_at,
      }))
      const recentTies = (recentTieRes.data || []).map((t: any) => ({
        type: 'tie',
        desc: `${t.club_a?.name || 'TBD'} vs ${t.club_b?.name || 'TBD'}`,
        detail: `단체전 · ${t.club_a_rubbers_won}-${t.club_b_rubbers_won}`,
        time: t.updated_at,
      }))
      const combined = [...recentMatches, ...recentTies]
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, 8)
      setRecentActivity(combined)
      setAllMatches((allMatchRes.data || []) as MatchRow[])

      // ✅ detectTied 인라인 처리 — 별도 await 없이 동시에 받은 데이터로 계산
      const groupMatchData = allGroupMatchRes.data || []
      const teamsData = allTeamsRes.data || []
      const rankMap = Object.fromEntries(teamsData.map((r: any) => [r.id, r.manual_rank]))

      // group_id별로 경기 분류
      const matchesByGroup = new Map<string, any[]>()
      for (const m of groupMatchData) {
        if (!m.group_id) continue
        if (!matchesByGroup.has(m.group_id)) matchesByGroup.set(m.group_id, [])
        matchesByGroup.get(m.group_id)!.push(m)
      }

      const tiedList: any[] = []
      for (const g of groups) {
        const gMatches = matchesByGroup.get(g.id) || []
        if (!gMatches.length) continue

        const teamWins: Record<string, { name: string; id: string; wins: number; diff: number; manualRank?: number }> = {}
        for (const m of gMatches) {
          if (!teamWins[m.team_a_id]) teamWins[m.team_a_id] = { name: m.team_a_name, id: m.team_a_id, wins: 0, diff: 0 }
          if (!teamWins[m.team_b_id]) teamWins[m.team_b_id] = { name: m.team_b_name, id: m.team_b_id, wins: 0, diff: 0 }
          const [sa, sb] = (m.score || '0:0').split(':').map(Number)
          if (m.winner_team_id === m.team_a_id) { teamWins[m.team_a_id].wins++; teamWins[m.team_a_id].diff += (sa - sb) }
          else if (m.winner_team_id === m.team_b_id) { teamWins[m.team_b_id].wins++; teamWins[m.team_b_id].diff += (sb - sa) }
        }

        const teams = Object.values(teamWins)
        const winCounts = teams.map(t => t.wins)
        const hasTie = winCounts.some((w, i) => winCounts.findIndex(x => x === w) !== i ||
          (winCounts.filter(x => x === w).length > 1))

        if (hasTie) {
          teams.forEach(t => { t.manualRank = rankMap[t.id] ?? null })
          tiedList.push({ ...g, teams: teams.sort((a, b) => b.wins - a.wins || b.diff - a.diff) })
        }
      }
      setTiedGroups(tiedList)

    } finally {
      setLoading(false)
    }
  }, [eventId])

  // ── 수동 순위 저장 ─────────────────────────────────────────
  async function saveManualRank(teamId: string, rank: number | null) {
    setAdjusting(true); setAdjustMsg('')
    const { error } = await supabase.from('teams').update({ manual_rank: rank }).eq('id', teamId)
    setAdjusting(false)
    if (error) {
      if (error.message.includes('column')) {
        setAdjustMsg('⚠️ teams 테이블에 manual_rank 컬럼이 없습니다. SQL 추가 필요:\nALTER TABLE teams ADD COLUMN IF NOT EXISTS manual_rank int;')
      } else {
        setAdjustMsg('❌ ' + error.message)
      }
    } else {
      setAdjustMsg('✅ 저장됐습니다.')
      await loadStats()
    }
  }

  useEffect(() => { loadStats() }, [loadStats])

  if (!eventId) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-center text-gray-400 mt-20">
        <div className="text-4xl mb-4">🏆</div>
        <p className="font-medium">이벤트를 선택해주세요.</p>
        <p className="text-sm mt-1">상단 헤더에서 이벤트를 선택하면 대시보드가 나타납니다.</p>
      </div>
    )
  }

  if (loading) return <div className="p-6 text-center text-gray-400">불러오는 중...</div>
  if (!stats)  return <div className="p-6 text-center text-gray-400">데이터 없음</div>

  const totalAll    = stats.totalMatches + stats.totalTies
  const finishedAll = stats.finishedMatches + stats.finishedTies
  const progressPct = totalAll > 0 ? Math.round(finishedAll / totalAll * 100) : 0
  const matchProgressPct = stats.totalMatches > 0 ? Math.round(stats.finishedMatches / stats.totalMatches * 100) : 0
  const tieProgressPct   = stats.totalTies > 0    ? Math.round(stats.finishedTies   / stats.totalTies   * 100) : 0

  function getProgressColor(pct: number) {
    if (pct >= 100) return 'bg-green-500'
    if (pct >= 70)  return 'bg-blue-500'
    if (pct >= 30)  return 'bg-yellow-500'
    return 'bg-orange-500'
  }
  function formatTime(iso: string) {
    return new Date(iso).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })
  }

  const divisions = stats.divisions
  const uniqueDates = [...new Set(divisions.map((d: any) => d.match_date).filter(Boolean))].sort() as string[]

  const filteredMatches = (() => {
    let list = matchFilter === 'ALL' ? allMatches : allMatches.filter(m => m.division_id === matchFilter)
    if (dateMatchFilter !== 'ALL_DATE') {
      const divsOnDate = divisions.filter((d: any) => d.match_date === dateMatchFilter).map((d: any) => d.id)
      list = list.filter(m => divsOnDate.includes(m.division_id))
    }
    return list
  })()

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* ── 이벤트 헤더 ── */}
      <div className="bg-gradient-to-r from-[#2d5016] to-[#4a7c59] rounded-2xl p-6 text-white">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{stats.event?.name}</h1>
            <p className="text-white/70 mt-1 text-sm">{stats.event?.date} · {stats.event?.location}</p>
            <div className="mt-2 flex gap-2 flex-wrap">
              {stats.divisions.map(d => (
                <span key={d.id} className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{d.name}</span>
              ))}
            </div>
          </div>
          <div className="text-right">
            <div className="text-5xl font-black">{progressPct}%</div>
            <div className="text-white/70 text-sm mt-1">전체 진행률</div>
          </div>
        </div>
        <div className="mt-5">
          <div className="flex justify-between text-xs text-white/60 mb-1.5">
            <span>전체 진행률</span>
            <span>{finishedAll} / {totalAll}경기 완료</span>
          </div>
          <div className="bg-white/20 rounded-full h-3 overflow-hidden">
            <div className={`h-3 rounded-full transition-all duration-700 ${getProgressColor(progressPct)}`}
              style={{ width: `${progressPct}%` }} />
          </div>
        </div>
        {(stats.inProgressMatches + stats.inProgressTies) > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            <span className="text-white/80 text-sm">현재 {stats.inProgressMatches + stats.inProgressTies}경기 진행 중</span>
          </div>
        )}
      </div>

      {/* ── 통계 카드 ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { val: stats.totalTeams || stats.totalClubs, label: '참가팀', color: 'text-blue-600' },
          { val: finishedAll,                          label: '완료 경기', color: 'text-green-600' },
          { val: stats.inProgressMatches + stats.inProgressTies, label: '진행 중', color: 'text-red-600', pulse: true },
          { val: totalAll - finishedAll,               label: '남은 경기', color: 'text-orange-600' },
        ].map((c, i) => (
          <div key={i} className="bg-white rounded-xl border p-4">
            <div className={`text-3xl font-black ${c.color}`}>{c.val}</div>
            <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
              {c.pulse && c.val > 0 && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />}
              {c.label}
            </div>
          </div>
        ))}
      </div>

      {/* ── 개인전 / 단체전 진행률 ── */}
      {(stats.totalMatches > 0 || stats.totalTies > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {stats.totalMatches > 0 && (
            <div className="bg-white rounded-xl border p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-sm">🎾 개인전</span>
                <span className="text-sm font-bold">{matchProgressPct}%</span>
              </div>
              <div className="bg-gray-100 rounded-full h-2.5 overflow-hidden">
                <div className={`h-2.5 rounded-full transition-all duration-700 ${getProgressColor(matchProgressPct)}`}
                  style={{ width: `${matchProgressPct}%` }} />
              </div>
              <div className="text-xs text-gray-400 mt-1.5">
                {stats.finishedMatches} / {stats.totalMatches}경기
                {stats.inProgressMatches > 0 && ` · 진행중 ${stats.inProgressMatches}`}
              </div>
            </div>
          )}
          {stats.totalTies > 0 && (
            <div className="bg-white rounded-xl border p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-sm">🏆 단체전</span>
                <span className="text-sm font-bold">{tieProgressPct}%</span>
              </div>
              <div className="bg-gray-100 rounded-full h-2.5 overflow-hidden">
                <div className={`h-2.5 rounded-full transition-all duration-700 ${getProgressColor(tieProgressPct)}`}
                  style={{ width: `${tieProgressPct}%` }} />
              </div>
              <div className="text-xs text-gray-400 mt-1.5">
                {stats.finishedTies} / {stats.totalTies}타이
                {stats.inProgressTies > 0 && ` · 진행중 ${stats.inProgressTies}`}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── ✅ 동률 수동 조정 ── */}
      {tiedGroups.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowTieAdjust(!showTieAdjust)}
            className="w-full flex items-center justify-between px-4 py-3 text-left">
            <div className="flex items-center gap-2">
              <span className="text-amber-600 font-bold text-sm">⚠️ 동률 발생 — 수동 순위 조정 필요</span>
              <span className="bg-amber-500 text-white text-xs px-2 py-0.5 rounded-full">{tiedGroups.length}그룹</span>
            </div>
            <span className="text-amber-500 text-sm">{showTieAdjust ? '▲ 접기' : '▼ 열기'}</span>
          </button>

          {showTieAdjust && (
            <div className="px-4 pb-4 space-y-4 border-t border-amber-200">
              <p className="text-xs text-amber-600 pt-3">
                동률인 팀의 순위를 직접 지정해주세요. (1 = 1위, 2 = 2위 등)<br />
                단, teams 테이블에 <code className="bg-amber-100 px-1 rounded">manual_rank</code> 컬럼이 필요합니다.
              </p>
              {adjustMsg && (
                <div className={`text-xs px-3 py-2 rounded-lg whitespace-pre-wrap ${adjustMsg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  {adjustMsg}
                </div>
              )}
              {tiedGroups.map(g => (
                <div key={g.id} className="bg-white rounded-xl border border-amber-200 overflow-hidden">
                  <div className="bg-amber-100 px-3 py-2 text-xs font-bold text-amber-800">
                    {g.division_name} · {g.group_label}
                  </div>
                  <div className="divide-y divide-stone-100">
                    {g.teams.map((t: any) => (
                      <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                        <span className="flex-1 text-sm font-medium text-stone-800">{t.name}</span>
                        <span className="text-xs text-stone-400">{t.wins}승 / 득실 {t.diff > 0 ? '+' : ''}{t.diff}</span>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-stone-400">순위:</span>
                          <select
                            defaultValue={t.manualRank ?? ''}
                            disabled={adjusting}
                            onChange={e => saveManualRank(t.id, e.target.value ? parseInt(e.target.value) : null)}
                            className="border border-amber-300 rounded-lg px-2 py-1 text-sm font-bold text-stone-700 bg-white focus:outline-none focus:border-amber-500 disabled:opacity-50">
                            <option value="">-</option>
                            {g.teams.map((_: any, i: number) => (
                              <option key={i+1} value={i+1}>{i+1}위</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-amber-500">
                * SQL 한 줄 추가: <code className="bg-amber-100 px-1 rounded">ALTER TABLE teams ADD COLUMN IF NOT EXISTS manual_rank int;</code>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── ✅ 경기결과 목록 ── */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <button
          onClick={() => setShowResults(!showResults)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-stone-50">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">📋 경기결과 목록</span>
            <span className="bg-[#2d5016] text-white text-xs px-2 py-0.5 rounded-full">{allMatches.length}경기</span>
          </div>
          <span className="text-stone-400 text-sm">{showResults ? '▲ 접기' : '▼ 열기'}</span>
        </button>

        {showResults && (
          <div className="border-t">
            <div className="flex gap-2 px-4 py-3 overflow-x-auto border-b bg-stone-50">
              {uniqueDates.length > 0 && (
                <>
                  <button onClick={() => setDateMatchFilter('ALL_DATE')}
                    className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all ${dateMatchFilter === 'ALL_DATE' ? 'bg-stone-700 text-white' : 'bg-white border text-stone-600'}`}>
                    전체 날짜
                  </button>
                  {uniqueDates.map(date => (
                    <button key={date} onClick={() => setDateMatchFilter(date)}
                      className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all ${dateMatchFilter === date ? 'bg-blue-600 text-white' : 'bg-white border text-stone-600'}`}>
                      {new Date(date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })}
                    </button>
                  ))}
                  <div className="w-px bg-stone-200 mx-1" />
                </>
              )}
              <button onClick={() => setMatchFilter('ALL')}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all ${matchFilter === 'ALL' ? 'bg-[#2d5016] text-white' : 'bg-white border text-stone-600'}`}>
                전체 ({allMatches.length})
              </button>
              {divisions.map((d: any) => {
                const cnt = allMatches.filter(m => m.division_id === d.id).length
                return (
                  <button key={d.id} onClick={() => setMatchFilter(d.id)}
                    className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all ${matchFilter === d.id ? 'bg-[#2d5016] text-white' : 'bg-white border text-stone-600'}`}>
                    {d.name}{d.match_date ? ` (${new Date(d.match_date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })})` : ''} ({cnt})
                  </button>
                )
              })}
            </div>

            {filteredMatches.length === 0 ? (
              <div className="text-center py-8 text-stone-400 text-sm">완료된 경기가 없습니다.</div>
            ) : (
              <div className="divide-y max-h-[480px] overflow-y-auto">
                {filteredMatches.map(m => (
                  <div key={m.id} className="flex items-center px-4 py-2.5 hover:bg-stone-50">
                    <div className="flex-shrink-0 w-16 text-xs text-stone-400 leading-tight">
                      <div>{m.group_label || m.round}</div>
                      {m.court && <div className="text-[#2d5016]">{m.court}</div>}
                    </div>
                    <div className="flex-1 flex items-center gap-2 min-w-0">
                      <span className={`flex-1 text-sm truncate text-right ${m.winner_team_id === m.team_a_id ? 'font-bold text-[#2d5016]' : 'text-stone-600'}`}>
                        {m.team_a_name}
                      </span>
                      <span className="flex-shrink-0 text-base font-black text-stone-800 px-2">{m.score}</span>
                      <span className={`flex-1 text-sm truncate ${m.winner_team_id === m.team_b_id ? 'font-bold text-[#2d5016]' : 'text-stone-600'}`}>
                        {m.team_b_name}
                      </span>
                    </div>
                    <div className="flex-shrink-0 w-12 text-right text-xs text-stone-400">
                      {formatTime(m.updated_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 빠른 메뉴 ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { href: '/dashboard/courts',          emoji: '🎾', label: '코트 배정',   desc: '코트 현황 관리' },
          { href: '/dashboard/teams/ties',      emoji: '🏆', label: '단체전 관리', desc: '타이 점수 입력' },
          { href: '/dashboard/teams/standings', emoji: '📊', label: '순위표',      desc: '실시간 순위 확인' },
          { href: '/dashboard/bracket',         emoji: '🗂️', label: '토너먼트표', desc: '대진 관리' },
          { href: '/dashboard/report',          emoji: '📄', label: '리포트',      desc: 'PDF·CSV 내보내기' },
          { href: '/dashboard/logs',            emoji: '👥', label: '접속 로그',   desc: '공개 페이지 접속 통계' },
        ].map(item => (
          <Link key={item.href} href={item.href}
            className="bg-white rounded-xl border p-4 hover:shadow-md hover:border-blue-300 transition-all">
            <div className="text-2xl mb-2">{item.emoji}</div>
            <div className="font-semibold text-sm">{item.label}</div>
            <div className="text-xs text-gray-400 mt-0.5">{item.desc}</div>
          </Link>
        ))}
      </div>

      {/* ── 최근 활동 ── */}
      {recentActivity.length > 0 && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-4 py-3 border-b font-semibold text-sm">최근 완료 경기</div>
          <div className="divide-y">
            {recentActivity.map((a, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-lg">{a.type === 'tie' ? '🏆' : '🎾'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{a.desc}</div>
                  <div className="text-xs text-gray-400">{a.detail}</div>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">{formatTime(a.time)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-center">
        <button onClick={loadStats} className="text-xs text-gray-400 hover:text-gray-600">🔄 새로고침</button>
      </div>
    </div>
  )
}
