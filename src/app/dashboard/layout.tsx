'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

const NAV_MAIN = [
  { href: '/dashboard', label: '홈', emoji: '🏠' },
  { href: '/dashboard/teams', label: '팀 관리', emoji: '👥' },
  { href: '/dashboard/groups', label: '조편성', emoji: '🔢' },
  { href: '/dashboard/tournament', label: '본선 토너먼트', emoji: '🏆' },
  { href: '/dashboard/courts', label: '코트 배정', emoji: '🏟' },
]

const NAV_TEAM = [
  { href: '/dashboard/teams/clubs', label: '단체전 클럽', emoji: '🏟️' },
  { href: '/dashboard/teams/groups', label: '단체전 조편성', emoji: '⚔️' },
  { href: '/dashboard/teams/ties', label: '단체전 대전', emoji: '🎾' },
  { href: '/dashboard/teams/standings', label: '단체전 순위', emoji: '📊' },
  { href: '/dashboard/teams/bracket', label: '단체전 토너먼트', emoji: '🏆' },
  { href: '/dashboard/sync', label: '앱A 연동', emoji: '🔄' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<any>(null)
  const [checking, setChecking] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [eventId, setEventId] = useState('')

  const isLoginPage = pathname === '/dashboard/login'

  useEffect(() => {
    if (isLoginPage) {
      setChecking(false)
      return
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push('/dashboard/login'); return }
      setUser(session.user)
      setChecking(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && !isLoginPage) router.push('/dashboard/login')
      else if (session) setUser(session.user)
    })
    return () => subscription.unsubscribe()
  }, [router, isLoginPage])

  // event_id 가져오기: sessionStorage 우선, 없으면 DB에서 조회
  useEffect(() => {
    const stored = sessionStorage.getItem('dashboard_event_id')
    if (stored) {
      setEventId(stored)
    } else {
      supabase.from('events').select('id').order('date', { ascending: false }).limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) {
            setEventId(data[0].id)
            sessionStorage.setItem('dashboard_event_id', data[0].id)
          }
        })
    }
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/')
  }

  if (isLoginPage) return <>{children}</>

  if (checking) return <div className="min-h-screen flex items-center justify-center text-stone-400">인증 확인 중...</div>

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
          {NAV_MAIN.map(n => (
            <Link key={n.href} href={n.href} onClick={() => setMenuOpen(false)}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-all ${
                pathname === n.href
                  ? 'bg-tennis-50 text-tennis-700 font-bold'
                  : 'text-stone-600 hover:bg-stone-50'
              }`}>
              <span>{n.emoji}</span> {n.label}
            </Link>
          ))}
          <hr className="my-2" />
          <p className="px-3 py-1 text-xs text-stone-400 font-medium">단체전</p>
          {NAV_TEAM.map(n => {
            const fullHref = n.href === '/dashboard/sync' ? n.href : `${n.href}?event_id=${eventId}`;
            return (
              <Link key={n.href} href={fullHref} onClick={() => setMenuOpen(false)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-all ${
                  pathname.startsWith(n.href)
                    ? 'bg-tennis-50 text-tennis-700 font-bold'
                    : 'text-stone-600 hover:bg-stone-50'
                }`}>
                <span>{n.emoji}</span> {n.label}
              </Link>
            );
          })}
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
