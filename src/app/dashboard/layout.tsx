// ============================================================
// src/app/dashboard/layout.tsx
// ✅ 타임테이블 메뉴 추가 (/dashboard/timetable)
// ✅ 대회 선택 드롭다운 복구
// ✅ 페이지 이동 시 대회 고정 (router.refresh 제거)
// ✅ AggregateError 방지 (async/await + try/finally)
// ✅ 대회 자동 선택: 오늘 기준 가장 가까운 미래 대회 우선
// ✅ localStorage 사용 → 다른 탭/창과 대회 선택 동기화
// ✅ 푸시 알림 로그 메뉴 추가 (/dashboard/push-logs)
// ============================================================
'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter()
  const pathname = usePathname()
  const [user, setUser]           = useState<any>(null)
  const [checking, setChecking]   = useState(true)
  const [menuOpen, setMenuOpen]   = useState(false)
  const [eventId, setEventId]     = useState('')
  const [events, setEvents]       = useState<{ id: string; name: string }[]>([])
  const [openIndiv, setOpenIndiv] = useState(false)
  const [openTeam, setOpenTeam]   = useState(false)

  const isLoginPage = pathname === '/dashboard/login'

  // 개인전/단체전 하위 경로면 자동 펼침
  useEffect(() => {
    const indivPaths = ['/dashboard/teams', '/dashboard/groups', '/dashboard/tournament']
    const teamPaths  = ['/dashboard/teams/clubs', '/dashboard/teams/groups', '/dashboard/teams/ties', '/dashboard/teams/standings', '/dashboard/teams/bracket']
    if (teamPaths.some(p => pathname.startsWith(p)))                               { setOpenTeam(true);  setOpenIndiv(false) }
    else if (indivPaths.some(p => pathname === p || pathname.startsWith(p + '/'))) { setOpenIndiv(true); setOpenTeam(false)  }
  }, [pathname])

  useEffect(() => {
    if (isLoginPage) { setChecking(false); return }

    let unsubFn = () => {}

    async function init() {
      try {
        // 1. 세션 확인
        const { data: authData } = await supabase.auth.getSession()
        const session = authData?.session ?? null
        if (!session) { router.push('/dashboard/login'); return }
        setUser(session.user)

        // 2. 대회 목록 로드 (날짜 오름차순)
        const { data: evList } = await supabase
          .from('events').select('id, name, date')
          .order('date', { ascending: true })
        setEvents(evList ?? [])

        // 3. 대회 ID 결정 (localStorage 사용 → 다른 창과 공유)
        const stored = localStorage.getItem('dashboard_event_id')
        const storedValid = stored && (evList ?? []).some(e => e.id === stored)

        if (storedValid) {
          setEventId(stored!)
        } else {
          const today = new Date().toISOString().split('T')[0]
          const list = evList ?? []
          const upcoming = list.filter(e => e.date >= today)
          const fallback = [...list].reverse()
          const best = upcoming[0] ?? fallback[0]
          const id = best?.id ?? ''
          if (id) {
            setEventId(id)
            localStorage.setItem('dashboard_event_id', id)
            window.dispatchEvent(new Event('dashboard_event_changed'))
          }
        }

      } catch (e) {
        console.error('[Dashboard] init error:', e)
        router.push('/dashboard/login')
      } finally {
        setChecking(false)
      }
    }

    init()

    // 4. 인증 상태 변화 감지
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_ev, session) => {
      if (!session && !isLoginPage) router.push('/dashboard/login')
      else if (session) setUser(session.user)
    })
    unsubFn = () => subscription.unsubscribe()
    return () => unsubFn()
  }, [router, isLoginPage])

  async function handleLogout() { await supabase.auth.signOut(); router.push('/') }

  function handleEventChange(id: string) {
    setEventId(id)
    localStorage.setItem('dashboard_event_id', id)
    window.dispatchEvent(new Event('dashboard_event_changed'))
  }

  if (isLoginPage) return <>{children}</>
  if (checking) return <div className="min-h-screen flex items-center justify-center text-stone-400">인증 확인 중...</div>

  function navLink(href: string, label: string, emoji: string, indent = false) {
    const fullHref = href.includes('event_id') ? href
      : (href.startsWith('/dashboard/teams/') && href !== '/dashboard/teams'
          ? `${href}?event_id=${eventId}` : href)
    const isActive = pathname === href || pathname.startsWith(href + '/') || pathname.startsWith(href + '?')
    return (
      <Link key={href} href={fullHref} onClick={() => setMenuOpen(false)}
        className={`flex items-center gap-2 ${indent ? 'pl-8' : 'px-3'} pr-3 py-2 rounded-lg text-sm transition-all ${
          isActive ? 'bg-tennis-50 text-tennis-700 font-bold' : 'text-stone-600 hover:bg-stone-50'
        }`}>
        <span className="text-sm">{emoji}</span> {label}
      </Link>
    )
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden bg-white border-b px-4 py-3 flex items-center justify-between sticky top-0 z-20">
        <button onClick={() => setMenuOpen(!menuOpen)} className="text-xl">☰</button>
        <span className="font-bold text-sm">⚙️ 운영 대시보드</span>
        <button onClick={handleLogout} className="text-xs text-stone-400">로그아웃</button>
      </div>

      {/* Sidebar */}
      <aside className={`${menuOpen ? 'block' : 'hidden'} md:block w-full md:w-56 bg-white border-r border-stone-200 md:min-h-screen flex-shrink-0`}>
        <div className="hidden md:block p-4 border-b">
          <Link href="/" className="text-xs text-stone-400 hover:text-stone-600">← 홈으로</Link>
          <h2 className="font-bold mt-1">⚙️ 운영 대시보드</h2>
          <p className="text-xs text-stone-400 mt-0.5 truncate">{user?.email}</p>
        </div>

        {/* 대회 선택 드롭다운 */}
        <div className="p-3 border-b bg-stone-50">
          <label className="text-xs text-stone-400 block mb-1">📅 대회 선택</label>
          <select
            value={eventId}
            onChange={e => handleEventChange(e.target.value)}
            className="w-full text-xs border border-stone-200 rounded-lg px-2 py-1.5 bg-white text-stone-700 focus:outline-none focus:border-tennis-400"
          >
            {events.length === 0 && <option value="">대회 없음</option>}
            {events.map(ev => (
              <option key={ev.id} value={ev.id}>{ev.name}</option>
            ))}
          </select>
        </div>

        <nav className="p-2 space-y-0.5">
          {navLink('/dashboard', '홈', '🏠')}

          {/* 개인전 */}
          <button onClick={() => setOpenIndiv(!openIndiv)}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all ${
              openIndiv ? 'bg-stone-100 text-stone-800 font-bold' : 'text-stone-600 hover:bg-stone-50'
            }`}>
            <span>🎾 개인전</span>
            <span className="text-xs text-stone-400">{openIndiv ? '▲' : '▼'}</span>
          </button>
          {openIndiv && (
            <div className="space-y-0.5">
              {navLink('/dashboard/teams',      '팀 관리',      '👥', true)}
              {navLink('/dashboard/groups',     '조편성',       '🔢', true)}
              {navLink('/dashboard/tournament', '본선 토너먼트', '🏆', true)}
            </div>
          )}

          {/* 단체전 */}
          <button onClick={() => setOpenTeam(!openTeam)}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-all ${
              openTeam ? 'bg-stone-100 text-stone-800 font-bold' : 'text-stone-600 hover:bg-stone-50'
            }`}>
            <span>📋 단체전</span>
            <span className="text-xs text-stone-400">{openTeam ? '▲' : '▼'}</span>
          </button>
          {openTeam && (
            <div className="space-y-0.5">
              {navLink('/dashboard/teams/clubs',     '클럽 관리', '🏟️', true)}
              {navLink('/dashboard/teams/groups',    '조편성',    '⚔️', true)}
              {navLink('/dashboard/teams/ties',      '대전 관리', '🎾', true)}
              {navLink('/dashboard/teams/standings', '순위',      '📊', true)}
              {navLink('/dashboard/teams/bracket',   '토너먼트',  '🏆', true)}
            </div>
          )}

          <hr className="my-2" />
          {navLink('/dashboard/courts',    '코트 배정',  '🏟')}
          {navLink('/dashboard/timetable', '타임테이블', '⏱')}
          {navLink('/dashboard/sync',      '앱A 연동',   '🔄')}
          {/* ✅ [FIX] label에서 이모지 제거 → emoji 파라미터와 중복 방지 */}
          {navLink('/dashboard/push-logs', '알림 로그',  '📡')}
          {navLink('/dashboard/settings',  '설정',       '⚙️')}
          <hr className="my-2" />

          <button onClick={handleLogout}
            className="hidden md:flex w-full items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-stone-400 hover:text-red-500 hover:bg-red-50">
            🚪 로그아웃
          </button>
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 p-4 md:p-6 max-w-5xl">{children}</main>
    </div>
  )
}
