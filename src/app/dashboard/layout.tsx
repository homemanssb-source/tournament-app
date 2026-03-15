'use client'
// ============================================================
// src/app/dashboard/layout.tsx
// ✅ 타임테이블 메뉴 추가 (/dashboard/timetable)
// ============================================================
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter()
  const pathname = usePathname()
  const [user, setUser]       = useState<any>(null)
  const [checking, setChecking] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [eventId, setEventId] = useState('')
  const [openIndiv, setOpenIndiv] = useState(false)
  const [openTeam, setOpenTeam]   = useState(false)

  const isLoginPage = pathname === '/dashboard/login'

  // 개인전/단체전 하위 경로면 자동 펼침
  useEffect(() => {
    const indivPaths = ['/dashboard/teams', '/dashboard/groups', '/dashboard/tournament']
    const teamPaths  = ['/dashboard/teams/clubs', '/dashboard/teams/groups', '/dashboard/teams/ties', '/dashboard/teams/standings', '/dashboard/teams/bracket']
    if (teamPaths.some(p => pathname.startsWith(p)))                              { setOpenTeam(true);  setOpenIndiv(false) }
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && !isLoginPage) router.push('/dashboard/login')
      else if (session) setUser(session.user)
    })
    return () => subscription.unsubscribe()
  }, [router, isLoginPage])

  async function handleLogout() { await supabase.auth.signOut(); router.push('/') }

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
          {navLink('/dashboard/courts',    '코트 배정',   '🏟')}
          {/* ✅ 타임테이블 추가 */}
          {navLink('/dashboard/timetable', '타임테이블',  '⏱')}

          {/* ── 기타 ── */}
          {navLink('/dashboard/sync',     '앱A 연동',    '🔄')}
          {navLink('/dashboard/settings', '설정',        '⚙️')}

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