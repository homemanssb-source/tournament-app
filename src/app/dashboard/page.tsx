// ============================================================
// 대시보드 메인 페이지
// src/app/dashboard/page.tsx
// P7: 진행률 바 추가
// ============================================================
'use client'
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

export default function DashboardPage() {
  const eventId = useEventId()
  const [stats, setStats] = useState<EventStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [recentActivity, setRecentActivity] = useState<any[]>([])

  const loadStats = useCallback(async () => {
    if (!eventId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [
        evRes,
        divRes,
        matchCountRes,
        matchFinRes,
        matchInpRes,
        tieCountRes,
        tieFinRes,
        tieInpRes,
        teamCountRes,
        clubCountRes,
        groupCountRes,
        recentMatchRes,
        recentTieRes,
      ] = await Promise.all([
        supabase.from('events').select('*').eq('id', eventId).single(),
        supabase.from('divisions').select('id,name').eq('event_id', eventId).order('sort_order'),
        supabase.from('matches').select('id', { count: 'exact' }).eq('event_id', eventId).neq('score', 'BYE'),
        supabase.from('matches').select('id', { count: 'exact' }).eq('event_id', eventId).eq('status', 'FINISHED').neq('score', 'BYE'),
        supabase.from('matches').select('id', { count: 'exact' }).eq('event_id', eventId).eq('status', 'IN_PROGRESS'),
        supabase.from('ties').select('id', { count: 'exact' }).eq('event_id', eventId).eq('is_bye', false),
        supabase.from('ties').select('id', { count: 'exact' }).eq('event_id', eventId).eq('status', 'completed').eq('is_bye', false),
        supabase.from('ties').select('id', { count: 'exact' }).eq('event_id', eventId).eq('status', 'in_progress'),
        supabase.from('teams').select('id', { count: 'exact' }).eq('event_id', eventId),
        supabase.from('clubs').select('id', { count: 'exact' }).eq('event_id', eventId),
        supabase.from('groups').select('id,is_finalized', { count: 'exact' }).eq('event_id', eventId),
        supabase.from('v_matches_with_teams').select('team_a_name,team_b_name,score,division_name,updated_at').eq('event_id', eventId).eq('status', 'FINISHED').order('updated_at', { ascending: false }).limit(5),
        supabase.from('ties').select('*, updated_at, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)').eq('event_id', eventId).eq('status', 'completed').order('updated_at', { ascending: false }).limit(5),
      ])

      const groups = groupCountRes.data || []
      const completedGroups = groups.filter((g: any) => g.is_finalized).length

      setStats({
        event: evRes.data,
        divisions: divRes.data || [],
        totalMatches: matchCountRes.count || 0,
        finishedMatches: matchFinRes.count || 0,
        inProgressMatches: matchInpRes.count || 0,
        totalTies: tieCountRes.count || 0,
        finishedTies: tieFinRes.count || 0,
        inProgressTies: tieInpRes.count || 0,
        totalTeams: teamCountRes.count || 0,
        totalClubs: clubCountRes.count || 0,
        completedGroups,
        totalGroups: groupCountRes.count || 0,
      })

      // 최근 활동 병합 (최신 5개)
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
    } finally {
      setLoading(false)
    }
  }, [eventId])

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
  if (!stats) return <div className="p-6 text-center text-gray-400">데이터 없음</div>

  // 전체 진행률 (개인전 + 단체전 합산)
  const totalAll = stats.totalMatches + stats.totalTies
  const finishedAll = stats.finishedMatches + stats.finishedTies
  const progressPct = totalAll > 0 ? Math.round(finishedAll / totalAll * 100) : 0

  const matchProgressPct = stats.totalMatches > 0
    ? Math.round(stats.finishedMatches / stats.totalMatches * 100) : 0
  const tieProgressPct = stats.totalTies > 0
    ? Math.round(stats.finishedTies / stats.totalTies * 100) : 0

  function getProgressColor(pct: number) {
    if (pct >= 100) return 'bg-green-500'
    if (pct >= 70) return 'bg-blue-500'
    if (pct >= 30) return 'bg-yellow-500'
    return 'bg-orange-500'
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* 이벤트 헤더 */}
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

        {/* 전체 진행률 바 */}
        <div className="mt-5">
          <div className="flex justify-between text-xs text-white/60 mb-1.5">
            <span>전체 진행률</span>
            <span>{finishedAll} / {totalAll}경기 완료</span>
          </div>
          <div className="bg-white/20 rounded-full h-3 overflow-hidden">
            <div
              className={`h-3 rounded-full transition-all duration-700 ${getProgressColor(progressPct)}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* 진행 중 강조 */}
        {(stats.inProgressMatches + stats.inProgressTies) > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            <span className="text-white/80 text-sm">
              현재 {stats.inProgressMatches + stats.inProgressTies}경기 진행 중
            </span>
          </div>
        )}
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border p-4">
          <div className="text-3xl font-black text-blue-600">{stats.totalTeams || stats.totalClubs}</div>
          <div className="text-xs text-gray-500 mt-1">참가팀</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-3xl font-black text-green-600">{finishedAll}</div>
          <div className="text-xs text-gray-500 mt-1">완료 경기</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-3xl font-black text-red-600">{stats.inProgressMatches + stats.inProgressTies}</div>
          <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
            {(stats.inProgressMatches + stats.inProgressTies) > 0 && (
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
            )}
            진행 중
          </div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-3xl font-black text-orange-600">{totalAll - finishedAll}</div>
          <div className="text-xs text-gray-500 mt-1">남은 경기</div>
        </div>
      </div>

      {/* 개인전 / 단체전 진행률 */}
      {(stats.totalMatches > 0 || stats.totalTies > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {stats.totalMatches > 0 && (
            <div className="bg-white rounded-xl border p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-sm">🎾 개인전</span>
                <span className="text-sm font-bold">{matchProgressPct}%</span>
              </div>
              <div className="bg-gray-100 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-2.5 rounded-full transition-all duration-700 ${getProgressColor(matchProgressPct)}`}
                  style={{ width: `${matchProgressPct}%` }}
                />
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
                <div
                  className={`h-2.5 rounded-full transition-all duration-700 ${getProgressColor(tieProgressPct)}`}
                  style={{ width: `${tieProgressPct}%` }}
                />
              </div>
              <div className="text-xs text-gray-400 mt-1.5">
                {stats.finishedTies} / {stats.totalTies}타이
                {stats.inProgressTies > 0 && ` · 진행중 ${stats.inProgressTies}`}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 빠른 메뉴 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { href: '/dashboard/courts', emoji: '🎾', label: '코트 배정', desc: '코트 현황 관리' },
          { href: '/dashboard/teams/ties', emoji: '🏆', label: '단체전 관리', desc: '타이 점수 입력' },
          { href: '/dashboard/teams/standings', emoji: '📊', label: '순위표', desc: '실시간 순위 확인' },
          { href: '/dashboard/bracket', emoji: '🗂️', label: '토너먼트표', desc: '대진 관리' },
          { href: '/dashboard/report', emoji: '📄', label: '리포트', desc: 'PDF·CSV 내보내기' },
          { href: '/dashboard/logs', emoji: '👥', label: '접속 로그', desc: '공개 페이지 접속 통계' },
        ].map(item => (
          <Link key={item.href} href={item.href}
            className="bg-white rounded-xl border p-4 hover:shadow-md hover:border-blue-300 transition-all">
            <div className="text-2xl mb-2">{item.emoji}</div>
            <div className="font-semibold text-sm">{item.label}</div>
            <div className="text-xs text-gray-400 mt-0.5">{item.desc}</div>
          </Link>
        ))}
      </div>

      {/* 최근 활동 */}
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
        <button onClick={loadStats} className="text-xs text-gray-400 hover:text-gray-600">
          🔄 새로고침
        </button>
      </div>
    </div>
  )
}