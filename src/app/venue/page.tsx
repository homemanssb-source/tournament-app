'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function VenueLoginPage() {
  const router = useRouter()
  const [selectedEvent, setSelectedEvent] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // ✅ localStorage에서 대회 읽기 (운영자 대시보드와 공유)
  useEffect(() => {
    const dashboardEventId = localStorage.getItem('dashboard_event_id')
    if (dashboardEventId) {
      setSelectedEvent(dashboardEventId)
      return
    }
    // 없으면 가장 최근 active 대회 자동 선택
    supabase.from('events').select('id').eq('status', 'active')
      .order('date', { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data?.[0]?.id) setSelectedEvent(data[0].id)
      })
  }, [])

  // ✅ 운영자가 다른 창에서 대회를 바꾸면 즉시 반영
  useEffect(() => {
    function onStorageChange(e: StorageEvent) {
      if (e.key === 'dashboard_event_id' && e.newValue) {
        setSelectedEvent(e.newValue)
      }
    }
    window.addEventListener('storage', onStorageChange)
    return () => window.removeEventListener('storage', onStorageChange)
  }, [])

  async function handleSubmit() {
    if (!selectedEvent) { setError('대회 정보를 불러오는 중입니다. 잠시 후 다시 시도해주세요.'); return }
    if (pin.length !== 6) { setError('경기장 PIN 6자리를 입력해주세요.'); return }
    setError(''); setLoading(true)

    const { data, error: err } = await supabase.rpc('rpc_venue_login', {
      p_pin_code: pin,
      p_event_id: selectedEvent,
    })
    setLoading(false)
    if (err) { setError(err.message || '경기장 PIN이 올바르지 않습니다.'); return }

    sessionStorage.setItem('venue_session', JSON.stringify(data))
    router.push('/venue/manage')
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-stone-50">
      <Link href="/" className="text-stone-400 hover:text-stone-600 mb-8 text-sm">← 홈으로</Link>
      <div className="text-5xl mb-4">🏟️</div>
      <h1 className="text-2xl font-bold mb-2">부설 경기장 관리</h1>
      <p className="text-stone-500 text-sm mb-8">배정받은 경기장 PIN 6자리를 입력하세요</p>
      <div className="w-full max-w-sm space-y-4">
        <input type="tel" maxLength={6} value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          placeholder="000000"
          className="pin-input w-full" autoFocus />
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}
        <button onClick={handleSubmit} disabled={loading || pin.length !== 6}
          className="w-full bg-orange-500 text-white font-bold py-3.5 rounded-xl hover:bg-orange-600 disabled:opacity-50 transition-all">
          {loading ? '확인 중...' : '경기장 로그인'}
        </button>
      </div>
    </div>
  )
}
