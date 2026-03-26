'use client'
// ============================================================
// src/app/dashboard/layout.tsx
// ✅ 타임테이블 메뉴 추가 (/dashboard/timetable)
// ✅ 대회 선택 드롭다운 복구
// ============================================================
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter()
  const pathname = usePathname()
  const [user, setUser]         = useState<any>(null)
  const [checking, setChecking] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [eventId, setEventId]   = useState('')
  const [events, setEvents]     = useState<{ id: string; name: string }[]>([])
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

    const stored = sessionStorage.getItem('dashboard_event_id')

    const authPromise  = supabase.auth.getSession()
    const eventPromise = stored
      ? Promise.resolve(stored)
      : supabase.from('events').select('id').order('date', { ascending: false }).limit(1)
          .then(({ data }) => {
            const id = data?.[0]?.id || ''
            if (id) sessionStorage.setItem('dashboard_event_id', id)
            return id
          })

    Promise.all([authPromise, eventPromise]).then(([{ data: { session } }, resolvedEventId]) => {
      if (!session) { router.push('/dashboard/login'); return }
      setUser(session.user)
      if (resolvedEventId) setEventId(resolvedEventId)
      setChecking(false)
    })

    // 대회 목록 로드
    supabase.from('events')
      .select('id, name')
      .order('date', { ascending: false })
      .then(({ data }) => setEvents(data || []))

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && !isLoginPage) router.push('/dashboard/login')
      else if (session) setUser(session.user)
    })
    return () => subscription.unsubscribe()
  }, [router, isLoginPage])

  async function handleLogout() { await supabase.auth.signOut(); router.push('/') }

  function handleEventChange(id: string) {
    setEventId(id)
    sessionStorage.setItem('dashboard_event_id', id)
    router.refresh()
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
            {events.length === 0 && (
              <option value="">대회 없음</option>
            )}
            {events.map(ev => (
              <option key={ev.id} value={ev.id}>{ev.name}</option>
            ))}
          </select>
        </div>

        <nav className="p-2 space-y-0.5">
          {/* 홈 */}
          {navLink('/dashboard', '홈', '🏠')}

          {/* ── 개인전 ── */}
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

          {/* ── 단체전 ── */}
          <button onClick={() => setOpenTeam(!openTeam)}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all ${
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

          {/* ── 코트 배정 ── */}
          {navLink('/dashboard/courts',    '코트 배정',  '🏟')}
          {/* ✅ 타임테이블 추가 */}
          {navLink('/dashboard/timetable', '타임테이블', '⏱')}

          {/* ── 기타 ── */}
          {navLink('/dashboard/sync',     '앱A 연동', '🔄')}
          {navLink('/dashboard/settings', '설정',     '⚙️')}

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