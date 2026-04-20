'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ── 스타일 토큰 ─────────────────────────────────────────────
const SOFT_SHADOW = '0 1px 2px rgba(0,0,0,0.03), 0 8px 32px -4px rgba(0,0,0,0.06)'
const SOFT_SHADOW_LG = '0 2px 4px rgba(0,0,0,0.04), 0 16px 40px -8px rgba(0,0,0,0.08)'
const BG_COLOR = '#f5f3ee'
const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

// 앱A (jeju-tennis-app) 외부 링크
const APP_A_BASE = 'https://jeju-tennis-app.vercel.app'
const QUICK_LINKS = [
  { href: `${APP_A_BASE}/notice`,  title: '공지사항' },
  { href: `${APP_A_BASE}/apply`,   title: '신청확인' },
  { href: `${APP_A_BASE}/players`, title: '선수조회' },
]

// ── 유틸 ────────────────────────────────────────────────────
function formatToday(): string {
  const d = new Date()
  return `${d.getMonth() + 1}.${d.getDate()} · ${DAY_LABELS[d.getDay()]}`
}

function formatEventDate(ymd: string | null | undefined): string {
  if (!ymd) return ''
  return ymd.replaceAll('-', '.')
}

function daysUntil(ymd: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(ymd + 'T00:00:00')
  return Math.ceil((target.getTime() - today.getTime()) / 86400000)
}

function ddayLabel(ymd: string): string {
  const n = daysUntil(ymd)
  if (n <= 0) return 'D-DAY'
  return `D-${n}`
}

// ── 타입 ────────────────────────────────────────────────────
interface EventInfo {
  id: string
  name: string
  date: string
  event_type: 'individual' | 'team'
}

interface Stats {
  inProgress: number
  activeCourts: number
  totalTeams: number
}

type PageState =
  | { kind: 'live'; event: EventInfo }
  | { kind: 'upcoming'; event: EventInfo }
  | { kind: 'standby' }

// ── 페이지 ──────────────────────────────────────────────────
export default function HomePage() {
  const [state, setState] = useState<PageState>({ kind: 'standby' })
  const [stats, setStats] = useState<Stats>({ inProgress: 0, activeCourts: 0, totalTeams: 0 })
  const [statsLoading, setStatsLoading] = useState(true)
  const [todayLabel, setTodayLabel] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)

  // SSR 불일치 방지: 마운트 후에만 오늘 날짜 계산
  useEffect(() => {
    setTodayLabel(formatToday())
  }, [])

  // 이벤트 + 통계 조회
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        // 1) Live 먼저
        const { data: activeEvents } = await supabase
          .from('events')
          .select('id, name, date, event_type')
          .eq('status', 'active')
          .order('date', { ascending: false })

        if (cancelled) return

        if (activeEvents && activeEvents.length > 0) {
          const ev = activeEvents[0] as EventInfo
          setState({ kind: 'live', event: ev })
          await loadStats(activeEvents.map((e: any) => e.id))
          return
        }

        // 2) Upcoming
        const today = new Date().toISOString().slice(0, 10)
        const { data: nextEvents } = await supabase
          .from('events')
          .select('id, name, date, event_type')
          .gte('date', today)
          .neq('status', 'completed')
          .order('date', { ascending: true })
          .limit(1)

        if (cancelled) return

        if (nextEvents && nextEvents.length > 0) {
          setState({ kind: 'upcoming', event: nextEvents[0] as EventInfo })
          setStatsLoading(false)
          return
        }

        // 3) Standby
        setState({ kind: 'standby' })
        setStatsLoading(false)
      } catch (e) {
        console.error('home load error', e)
        if (!cancelled) setStatsLoading(false)
      }
    }

    async function loadStats(eventIds: string[]) {
      try {
        const [
          { count: matchInProgress },
          { count: tieInProgress },
          { data: courtMatches },
          { count: totalTeams },
        ] = await Promise.all([
          supabase.from('matches').select('*', { count: 'exact', head: true })
            .in('event_id', eventIds).eq('status', 'IN_PROGRESS'),
          supabase.from('ties').select('*', { count: 'exact', head: true })
            .in('event_id', eventIds).eq('status', 'in_progress'),
          supabase.from('matches').select('court')
            .in('event_id', eventIds).eq('status', 'IN_PROGRESS').not('court', 'is', null),
          supabase.from('teams').select('*', { count: 'exact', head: true })
            .in('event_id', eventIds),
        ])

        if (cancelled) return

        const activeCourts = new Set((courtMatches ?? []).map((m: any) => m.court)).size
        setStats({
          inProgress: (matchInProgress ?? 0) + (tieInProgress ?? 0),
          activeCourts,
          totalTeams: totalTeams ?? 0,
        })
      } catch (e) {
        console.error('stats load error', e)
      } finally {
        if (!cancelled) setStatsLoading(false)
      }
    }

    load()
    const iv = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [])

  // 바텀시트: ESC + body scroll lock
  useEffect(() => {
    if (!sheetOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSheetOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [sheetOpen])

  // ── 상태별 프리셋 ─────────────────────────────────────────
  const cardPreset = (() => {
    if (state.kind === 'live') {
      return {
        dotBg: 'bg-red-500',
        dotLabel: 'LIVE',
        dotLabelColor: 'text-red-500',
        badgeText: '진행중',
        badgeClass: 'text-stone-400 bg-stone-50',
        radialStyle: { background: 'radial-gradient(circle, #fef3f2 0%, transparent 70%)' },
      }
    }
    if (state.kind === 'upcoming') {
      return {
        dotBg: 'bg-blue-500',
        dotLabel: 'UPCOMING',
        dotLabelColor: 'text-blue-600',
        badgeText: ddayLabel(state.event.date),
        badgeClass: 'bg-blue-500 text-white',
        radialStyle: { background: 'radial-gradient(circle, #eff6ff 0%, transparent 70%)' },
      }
    }
    return {
      dotBg: 'bg-stone-300',
      dotLabel: 'STANDBY',
      dotLabelColor: 'text-stone-400',
      badgeText: '',
      badgeClass: '',
      radialStyle: { background: 'radial-gradient(circle, #f5f5f4 0%, transparent 70%)' },
    }
  })()

  const currentEvent =
    state.kind === 'live' || state.kind === 'upcoming' ? state.event : null

  return (
    <div className="min-h-screen" style={{ backgroundColor: BG_COLOR }}>
      <div className="max-w-sm mx-auto py-6 px-5">

        {/* 1) 헤더 */}
        <div className="flex items-center mb-6">
          <div className="text-[10px] font-black tracking-[0.15em] text-stone-500 uppercase">
            제주시테니스협회
          </div>
          <div
            className="ml-auto rounded-full px-3 py-1.5 bg-white"
            style={{ boxShadow: SOFT_SHADOW }}
          >
            <span className="text-[10px] tabular-nums text-stone-500 font-bold">
              {todayLabel || '\u00A0'}
            </span>
          </div>
        </div>

        {/* 2) 대회 대형 카드 */}
        <div
          className="relative overflow-hidden bg-white rounded-[28px] p-7 mb-4"
          style={{ boxShadow: SOFT_SHADOW_LG }}
        >
          <div
            aria-hidden="true"
            className="absolute -top-16 -right-16 w-48 h-48 rounded-full pointer-events-none"
            style={cardPreset.radialStyle}
          />

          <div className="relative">
            {/* 상태 배지 행 */}
            <div className="flex items-center gap-2 mb-5">
              {state.kind === 'live' ? (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 animate-ping opacity-80" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                </span>
              ) : (
                <span className={`inline-flex h-2 w-2 rounded-full ${cardPreset.dotBg}`} />
              )}

              <span
                className={`text-[10px] font-black tracking-[0.2em] uppercase ${cardPreset.dotLabelColor}`}
              >
                {cardPreset.dotLabel}
              </span>

              {cardPreset.badgeText && (
                <span
                  className={`ml-auto text-[10px] font-bold rounded-full px-2.5 py-1 tabular-nums ${cardPreset.badgeClass}`}
                  style={
                    state.kind === 'upcoming'
                      ? { letterSpacing: '0.05em' }
                      : undefined
                  }
                >
                  {cardPreset.badgeText}
                </span>
              )}
            </div>

            {/* 대회명 */}
            {currentEvent ? (
              <>
                <h1
                  className="text-[24px] leading-[1.15] font-black text-stone-900"
                  style={{ letterSpacing: '-0.03em' }}
                >
                  {currentEvent.name}
                </h1>

                <div className="mt-5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-bold text-stone-600 bg-stone-100 rounded-full px-2.5 py-1">
                    {currentEvent.event_type === 'team' ? '단체전' : '개인전'}
                  </span>
                  <span className="text-[11px] font-bold text-stone-600 bg-stone-100 rounded-full px-2.5 py-1 tabular-nums">
                    {formatEventDate(currentEvent.date)}
                  </span>
                </div>
              </>
            ) : (
              <>
                <h1
                  className="text-[24px] leading-[1.15] font-black text-stone-900"
                  style={{ letterSpacing: '-0.03em' }}
                >
                  다음 대회를
                  <br />
                  기다리고 있습니다
                </h1>
                <p className="mt-4 text-[12px] text-stone-400">
                  현재 진행 중인 대회가 없습니다
                </p>
              </>
            )}
          </div>
        </div>

        {/* 3) 통계 그리드 (Live 상태에만) */}
        {state.kind === 'live' && (
          <div className="grid grid-cols-3 gap-2.5 mb-4">
            {[
              { label: '진행경기', value: stats.inProgress },
              { label: '사용코트', value: stats.activeCourts },
              { label: '참가팀', value: stats.totalTeams },
            ].map(s => (
              <div
                key={s.label}
                className="bg-white rounded-2xl p-4"
                style={{ boxShadow: SOFT_SHADOW }}
              >
                <div className="text-[10px] font-bold text-stone-400 mb-1.5">
                  {s.label}
                </div>
                <div
                  className="text-[26px] tabular-nums font-black text-stone-900 leading-none"
                  style={{ letterSpacing: '-0.03em' }}
                >
                  {statsLoading ? '·' : s.value}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 4) 메뉴 카드 2개 */}
        <MenuCard
          href="/events"
          title="대회 보기"
          desc="조별리그 · 토너먼트 · 경기결과"
        />
        <MenuCard
          href="/pin"
          title="내 경기"
          desc="점수 입력 · 알람 설정 · 오더 제출"
        />

        {/* ========== 회원 서비스 퀵 링크 (앱A 외부 이동) ========== */}
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-3 px-1">
            <span className="text-[10px] font-black tracking-[0.22em] text-stone-400 uppercase">
              회원 서비스
            </span>
            <div className="flex-1 h-px bg-stone-200" />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {QUICK_LINKS.map(link => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group bg-white rounded-2xl py-4 px-3 text-center relative transition-shadow hover:shadow-md active:scale-[0.97]"
                style={{ boxShadow: SOFT_SHADOW }}
              >
                <span className="absolute top-2.5 right-2.5 text-[11px] text-stone-300 group-hover:text-stone-900 transition-colors">
                  ↗
                </span>
                <div className="text-[13px] font-black text-stone-900 tracking-tight">
                  {link.title}
                </div>
              </a>
            ))}
          </div>
        </div>

        {/* 5) 푸터 */}
        <div className="pt-10 pb-4 flex flex-col items-center gap-5">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-label="관리자 메뉴 열기"
            className="group w-10 h-10 rounded-full bg-white flex items-center justify-center gap-1"
            style={{ boxShadow: SOFT_SHADOW }}
          >
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className="w-[3px] h-[3px] rounded-full bg-stone-300 group-hover:bg-stone-700 transition-colors"
              />
            ))}
          </button>
          <div className="text-[9px] text-stone-400 tracking-[0.25em] font-bold">
            JEJU TENNIS ASSOCIATION
          </div>
        </div>
      </div>

      {/* 관리자 바텀시트 */}
      {sheetOpen && (
        <AdminSheet onClose={() => setSheetOpen(false)} />
      )}

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUpSheet {
          from { transform: translate(-50%, 100%); }
          to { transform: translate(-50%, 0); }
        }
      `}</style>
    </div>
  )
}

// ── 메뉴 카드 ──────────────────────────────────────────────
function MenuCard({
  href,
  title,
  desc,
}: {
  href: string
  title: string
  desc: string
}) {
  return (
    <Link
      href={href}
      className="group block bg-white rounded-2xl p-5 mb-2.5 active:scale-[0.99] transition-transform"
      style={{ boxShadow: SOFT_SHADOW }}
    >
      <div className="flex items-center">
        <div className="flex-1 min-w-0">
          <div className="text-[17px] font-black text-stone-900 tracking-tight">
            {title}
          </div>
          <div className="text-[11px] text-stone-400 mt-1">{desc}</div>
        </div>
        <div className="w-9 h-9 rounded-full bg-stone-50 flex items-center justify-center group-hover:bg-stone-900 transition-colors">
          <span className="text-stone-400 group-hover:text-white text-sm transition-colors">
            →
          </span>
        </div>
      </div>
    </Link>
  )
}

// ── 관리자 바텀시트 ────────────────────────────────────────
const ADMIN_MENUS: { href: string; title: string; desc: string }[] = [
  { href: '/venue', title: '현장 경기관리', desc: '경기장 PIN으로 이벤트 관리' },
  { href: '/admin-pin', title: '관리자 모드', desc: '마스터 PIN으로 점수조정 · 설정' },
  { href: '/dashboard', title: '대회 운영 대시보드', desc: '팀관리 · 조편성 · 전체 관리' },
]

function AdminSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="관리자 메뉴"
    >
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        style={{ animation: 'fadeIn 0.25s ease-out' }}
      />
      <div
        className="absolute bottom-0 left-1/2 w-full max-w-sm bg-white rounded-t-3xl p-6 pb-10"
        style={{
          transform: 'translate(-50%, 0)',
          animation: 'slideUpSheet 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        <div className="flex justify-center mb-5">
          <div className="w-10 h-1 rounded-full bg-stone-200" />
        </div>

        <div className="text-[10px] font-black tracking-[0.22em] text-stone-400 uppercase mb-3">
          관리자 기능
        </div>

        <div>
          {ADMIN_MENUS.map((m, idx) => (
            <Link
              key={m.href}
              href={m.href}
              onClick={onClose}
              className={`flex items-center py-4 px-2 -mx-2 rounded-xl hover:bg-stone-50 transition-colors ${
                idx < ADMIN_MENUS.length - 1 ? 'border-b border-stone-100' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-black text-stone-900">{m.title}</div>
                <div className="text-[11px] text-stone-400 mt-0.5">{m.desc}</div>
              </div>
              <span className="text-stone-300 text-lg font-light">→</span>
            </Link>
          ))}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full mt-6 py-3.5 rounded-2xl bg-stone-100 text-stone-600 text-sm font-bold hover:bg-stone-200 transition-colors"
        >
          닫기
        </button>
      </div>
    </div>
  )
}
