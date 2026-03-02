'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('이메일과 비밀번호를 입력하세요.'); return }
    setError(''); setLoading(true)

    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)

    if (err) { setError('로그인 실패: ' + err.message); return }
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-stone-50">
      <Link href="/" className="text-stone-400 hover:text-stone-600 mb-8 text-sm">← 홈으로</Link>
      <div className="w-full max-w-sm bg-white rounded-2xl border p-6">
        <h1 className="text-xl font-bold text-center mb-1">⚙️ 운영 대시보드</h1>
        <p className="text-sm text-stone-500 text-center mb-6">운영자 계정으로 로그인하세요</p>

        <form onSubmit={handleLogin} className="space-y-3">
          <input type="email" placeholder="이메일" value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full border border-stone-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-tennis-600" />
          <input type="password" placeholder="비밀번호" value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full border border-stone-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-tennis-600" />
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-tennis-600 text-white font-bold py-3 rounded-xl hover:bg-tennis-700 disabled:opacity-50 transition-all">
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  )
}
