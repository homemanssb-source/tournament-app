'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

const MEMBER_CARDS = [
  {
    href: '/events',
    emoji: '📺',
    title: '대회 보기',
    desc: '조별리그 · 토너먼트 · 경기결과 · 이벤트현황',
    color: 'bg-gradient-to-br from-emerald-50 to-green-100 border-green-200 hover:border-green-400',
    iconBg: 'bg-white/70',
    badge: 'LIVE',
  },
  {
    href: '/pin',
    emoji: '📋',
    title: '점수 직접입력',
    desc: 'PIN으로 내 경기 결과 직접 입력',
    color: 'bg-gradient-to-br from-amber-50 to-yellow-100 border-amber-200 hover:border-amber-400',
    iconBg: 'bg-white/70',
    badge: null,
  },
]

const ADMIN_CARDS = [
  {
    href: '/venue',
    emoji: '🏟',
    title: '현장 경기관리',
    desc: '경기장 PIN으로 이벤트 관리',
    color: 'bg-gradient-to-br from-orange-50 to-orange-100 border-orange-200 hover:border-orange-400',
    wide: false,
  },
  {
    href: '/admin-pin',
    emoji: '🔑',
    title: '관리자 모드',
    desc: '마스터PIN으로 점수조정/설정',
    color: 'bg-gradient-to-br from-red-50 to-rose-100 border-red-200 hover:border-red-400',
    wide: false,
  },
  {
    href: '/dashboard',
    emoji: '📊',
    title: '대회 운영 대시보드',
    desc: '팀관리 · 조편성 · 경기 · 이벤트설정 전체 관리',
    color: 'bg-gradient-to-br from-blue-50 to-sky-100 border-blue-200 hover:border-blue-400',
    wide: true,
  },
]

interface Stats {
  inProgress: number
  activeCourts: number
  totalTeams: number
}

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<'member' | 'admin'>('member')
  const [stats, setStats] = useState<Stats>({ inProgress: 0, activeCourts: 0, totalTeams: 0 })
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    async function fetchStats() {
      try {
        const { data: activeEvents } = await supabase
          .from('events')
          .select('id')
          .eq('status', 'active')

        if (!activeEvents || activeEvents.length === 0) {
          setStatsLoading(false)
          return
        }

        const eventIds = activeEvents.map(e => e.id)

        const matchInProgressPromise = supabase
          .from('matches')
          .select('*', { count: 'exact', head: true })
          .in('event_id', eventIds)
          .eq('status', 'IN_PROGRESS')

        const tieInProgressPromise = supabase
          .from('ties')
          .select('*', { count: 'exact', head: true })
          .in('event_id', eventIds)
          .eq('status', 'in_progress')

        const courtMatchesPromise = supabase
          .from('matches')
          .select('court')
          .in('event_id', eventIds)
          .eq('status', 'IN_PROGRESS')
          .not('court', 'is', null)

        const totalTeamsPromise = supabase
          .from('teams')
          .select('*', { count: 'exact', head: true })
          .in('event_id', eventIds)

        const [
          { count: matchInProgress },
          { count: tieInProgress },
          { data: courtMatches },
          { count: totalTeams },
        ] = await Promise.all([
          matchInProgressPromise,
          tieInProgressPromise,
          courtMatchesPromise,
          totalTeamsPromise,
        ])

        const activeCourts = new Set(courtMatches?.map(m => m.court)).size

        setStats({
          inProgress: (matchInProgress ?? 0) + (tieInProgress ?? 0),
          activeCourts,
          totalTeams: totalTeams ?? 0,
        })
      } catch (e) {
        console.error('stats fetch error', e)
      } finally {
        setStatsLoading(false)
      }
    }

    fetchStats()
    const timer = setInterval(fetchStats, 30000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col items-center justify-start py-8 px-4">
      <div className="w-full max-w-sm">

        {/* Header */}
        <div className="rounded-3xl overflow-hidden mb-4 shadow-lg"
          style={{ background: 'linear-gradient(135deg, #1a2e1a 0%, #2d5016 50%, #3d6b1e 100%)' }}>
          <div className="px-6 py-7 flex items-center gap-4 relative overflow-hidden">
            <div className="absolute -top-8 -right-8 w-36 h-36 rounded-full bg-white/5" />
            <div className="absolute -bottom-6 -left-6 w-24 h-24 rounded-full bg-white/5" />
            <div className="relative z-10 w-14 h-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center text-3xl backdrop-blur-sm flex-shrink-0">
              🎾
            </div>
            <div className="relative z-10">
              <h1 className="text-white text-xl font-black tracking-tight leading-tight">제주시테니스대회</h1>
              <p className="text-white/50 text-xs tracking-widest uppercase mt-0.5">Tennis Tournament Manager</p>
            </div>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="bg-white rounded-2xl shadow-sm flex mb-4 p-1 gap-1">
          <button
            onClick={() => setActiveTab('member')}
            className={`flex-1 flex flex-col items-center py-3 rounded-xl text-xs font-bold transition-all gap-1
              ${activeTab === 'member'
                ? 'bg-green-600 text-white shadow-md shadow-green-200'
                : 'text-stone-400 hover:text-stone-600'}`}
          >
            <span className="text-base">🎾</span>
            회원
          </button>
          <button
            onClick={() => setActiveTab('admin')}
            className={`flex-1 flex flex-col items-center py-3 rounded-xl text-xs font-bold transition-all gap-1
              ${activeTab === 'admin'
                ? 'bg-stone-700 text-white shadow-md shadow-stone-300'
                : 'text-stone-400 hover:text-stone-600'}`}
          >
            <span className="text-base">⚙️</span>
            관리자
          </button>
        </div>

        {/* Member Tab */}
        {activeTab === 'member' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs font-bold tracking-widest uppercase text-stone-400 px-1">회원 메뉴</p>

            {MEMBER_CARDS.map(card => (
              <Link
                key={card.href}
                href={card.href}
                className={`relative flex items-center gap-4 p-5 rounded-2xl border-2 transition-all shadow-sm hover:shadow-md active:scale-[0.98] ${card.color}`}
              >
                {card.badge && (
                  <span className="absolute top-3 right-4 bg-red-500 text-white text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wide">
                    {card.badge}
                  </span>
                )}
                <div className={`w-13 h-13 min-w-[52px] min-h-[52px] rounded-2xl ${card.iconBg} flex items-center justify-center text-2xl shadow-sm`}>
                  {card.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-black text-base text-stone-800 leading-tight">{card.title}</h2>
                  <p className="text-xs text-stone-500 mt-1 leading-relaxed">{card.desc}</p>
                </div>
                <span className="text-stone-300 text-xl font-light">›</span>
              </Link>
            ))}

            {/* Quick Stats */}
            <div className="bg-white rounded-2xl p-4 shadow-sm mt-1">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-bold text-stone-400">현재 진행 현황</p>
                {statsLoading && (
                  <span className="text-[10px] text-stone-300 animate-pulse">불러오는 중...</span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { num: statsLoading ? '·' : String(stats.inProgress), label: '진행중 경기' },
                  { num: statsLoading ? '·' : String(stats.activeCourts), label: '사용 코트' },
                  { num: statsLoading ? '·' : String(stats.totalTeams), label: '참가팀' },
                ].map(s => (
                  <div key={s.label} className="bg-stone-50 rounded-xl py-3 text-center">
                    <div className="text-xl font-black text-green-700">{s.num}</div>
                    <div className="text-[10px] text-stone-400 mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Admin Tab */}
        {activeTab === 'admin' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs font-bold tracking-widest uppercase text-stone-400 px-1">관리자 기능</p>

            <div className="grid grid-cols-2 gap-3">
              {ADMIN_CARDS.filter(c => !c.wide).map(card => (
                <Link
                  key={card.href}
                  href={card.href}
                  className={`flex flex-col p-4 rounded-2xl border-2 transition-all shadow-sm hover:shadow-md active:scale-[0.98] ${card.color}`}
                >
                  <div className="text-2xl mb-3">{card.emoji}</div>
                  <h2 className="font-black text-sm text-stone-800 leading-tight">{card.title}</h2>
                  <p className="text-[11px] text-stone-500 mt-1 leading-relaxed">{card.desc}</p>
                  <div className="mt-3 inline-flex items-center gap-1 bg-black/8 rounded-full px-2 py-0.5 self-start">
                    <span className="text-[10px]">🔒</span>
                    <span className="text-[10px] font-bold text-stone-500">PIN 필요</span>
                  </div>
                </Link>
              ))}
            </div>

            {ADMIN_CARDS.filter(c => c.wide).map(card => (
              <Link
                key={card.href}
                href={card.href}
                className={`flex items-center gap-4 p-5 rounded-2xl border-2 transition-all shadow-sm hover:shadow-md active:scale-[0.98] ${card.color}`}
              >
                <div className="text-3xl">{card.emoji}</div>
                <div className="flex-1">
                  <h2 className="font-black text-base text-stone-800 leading-tight">{card.title}</h2>
                  <p className="text-xs text-stone-500 mt-1 leading-relaxed">{card.desc}</p>
                  <div className="mt-2 inline-flex items-center gap-1 bg-black/8 rounded-full px-2 py-0.5">
                    <span className="text-[10px]">🔒</span>
                    <span className="text-[10px] font-bold text-stone-500">PIN 필요</span>
                  </div>
                </div>
                <span className="text-stone-300 text-xl font-light">›</span>
              </Link>
            ))}
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-[11px] text-stone-400 mt-6">🎾 제주시테니스협회</p>
      </div>
    </div>
  )
}