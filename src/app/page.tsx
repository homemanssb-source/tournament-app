'use client'
import Link from 'next/link'

const CARDS = [
  { href: '/events', emoji: '📺', title: '대회 보기', desc: '조 게시 · 토너먼트 · 경기결과 · 코트현황', color: 'bg-tennis-50 border-tennis-200 hover:border-tennis-400' },
  { href: '/pin', emoji: '🔑', title: '참가자 입력', desc: 'PIN으로 내 경기 결과 입력', color: 'bg-amber-50 border-amber-200 hover:border-amber-400' },
  { href: '/venue', emoji: '🏟️', title: '부설 경기장', desc: '경기장 PIN으로 내 코트 관리', color: 'bg-orange-50 border-orange-200 hover:border-orange-400' },
  { href: '/admin-pin', emoji: '🛡️', title: '관리자 도구', desc: '마스터PIN으로 잠금해제/수정', color: 'bg-red-50 border-red-200 hover:border-red-400' },
  { href: '/dashboard', emoji: '⚙️', title: '운영 대시보드', desc: '팀관리 · 조편성 · 경기 · 코트배정', color: 'bg-blue-50 border-blue-200 hover:border-blue-400' },
]

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="text-6xl mb-4">🎾</div>
      <h1 className="text-3xl font-bold mb-2">테니스 대회 운영</h1>
      <p className="text-stone-500 mb-8">Tennis Tournament Manager</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg">
        {CARDS.map(c => (
          <Link key={c.href} href={c.href}
            className={`block rounded-2xl border-2 p-5 transition-all ${c.color}`}>
            <div className="text-3xl mb-2">{c.emoji}</div>
            <h2 className="font-bold text-lg">{c.title}</h2>
            <p className="text-sm text-stone-500 mt-1">{c.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
