'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { usePushSubscription } from '@/hooks/usePushSubscription'

type Mode = 'select' | 'individual' | 'team';

const NOTIF_DONE_KEY = 'pin_notif_done'

export default function PinPage() {
  const router = useRouter()
  const [selectedEvent, setSelectedEvent] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<Mode>('select')
  const [teamTies, setTeamTies] = useState<any[]>([])

  const { status: pushStatus, message: pushMessage, subscribeWithPin } = usePushSubscription()
  const [loginSuccess, setLoginSuccess] = useState(false)
  const [loginPin, setLoginPin] = useState('')
  const [checkinLoading, setCheckinLoading] = useState(false)

  // ✅ localStorage 우선 → 없으면 오늘 기준 가장 가까운 대회 자동 선택 (휴대폰 대응)
  useEffect(() => {
    const dashboardEventId = localStorage.getItem('dashboard_event_id')
    if (dashboardEventId) {
      setSelectedEvent(dashboardEventId)
      return
    }
    supabase.from('events').select('id, date')
      .order('date', { ascending: true })
      .then(({ data }) => {
        if (!data || data.length === 0) return
        const today = new Date().toISOString().split('T')[0]
        const upcoming = data.filter(e => e.date >= today)
        const best = upcoming[0] ?? data[data.length - 1]
        if (best?.id) setSelectedEvent(best.id)
      })
  }, [])

  // ✅ 같은 기기 내 다른 탭에서 대회 바꾸면 즉시 반영
  useEffect(() => {
    function onStorageChange(e: StorageEvent) {
      if (e.key === 'dashboard_event_id' && e.newValue) {
        setSelectedEvent(e.newValue)
      }
    }
    window.addEventListener('storage', onStorageChange)
    return () => window.removeEventListener('storage', onStorageChange)
  }, [])

  useEffect(() => {
    if (pushStatus === 'success') {
      const t = setTimeout(() => router.push('/pin/matches'), 1500)
      return () => clearTimeout(t)
    }
  }, [pushStatus, router])

  async function handleIndividualSubmit() {
    if (!selectedEvent) { setError('대회 정보를 불러오는 중입니다. 잠시 후 다시 시도해주세요.'); return }
    if (pin.length !== 6) { setError('PIN 6자리를 입력해주세요.'); return }
    setError(''); setLoading(true)
    const { data, error: err } = await supabase.rpc('rpc_pin_login', {
      p_pin_code: pin, p_event_id: selectedEvent,
    })
    setLoading(false)
    if (err) { setError(err.message || 'PIN이 올바르지 않습니다.'); return }

    const sessionData = { ...data, _savedAt: Date.now() }
    sessionStorage.setItem('pin_session', JSON.stringify(sessionData))
    sessionStorage.setItem('venue_pin', pin)
    sessionStorage.setItem('pin_event_id', selectedEvent)
    // ✅ localStorage에도 저장 → 다른 페이지 갔다 와도 튕기지 않음 (12시간 유효)
    localStorage.setItem('pin_session', JSON.stringify(sessionData))

    try {
      const donePins = JSON.parse(localStorage.getItem(NOTIF_DONE_KEY) || '[]') as string[]
      if (donePins.includes(pin)) {
        router.push('/pin/matches')
        return
      }
    } catch {}

    setLoginPin(pin)
    setLoginSuccess(true)
  }

  async function handleAllowNotification() {
    setCheckinLoading(true)
    let subscribeOk = false
    try {
      subscribeOk = await subscribeWithPin(loginPin)
      await supabase
        .from('teams')
        .update({ checked_in: true, checked_in_at: new Date().toISOString() })
        .eq('pin_plain', loginPin)
        .eq('event_id', selectedEvent)
      markNotifDone(loginPin)
    } finally {
      setCheckinLoading(false)
    }
    if (!subscribeOk) {
      router.push('/pin/matches')
    }
  }

  function handleSkipNotification() {
    router.push('/pin/matches')
  }

  function markNotifDone(pinCode: string) {
    try {
      const donePins = JSON.parse(localStorage.getItem(NOTIF_DONE_KEY) || '[]') as string[]
      if (!donePins.includes(pinCode)) {
        donePins.push(pinCode)
        if (donePins.length > 20) donePins.shift()
        localStorage.setItem(NOTIF_DONE_KEY, JSON.stringify(donePins))
      }
    } catch {}
  }

  async function handleTeamSubmit() {
    if (pin.length !== 6) { setError('팀 PIN 6자리를 입력해주세요.'); return }
    setError(''); setLoading(true)
    try {
      const { data: club } = await supabase
        .from('clubs').select('id, name, event_id')
        .eq('captain_pin', pin).limit(1).single()
      if (!club) { setError('팀 PIN에 해당하는 클럽을 찾을 수 없습니다.'); setLoading(false); return }

      const { data: ties } = await supabase
        .from('ties')
        .select('id, tie_order, status, round, club_a:clubs!ties_club_a_id_fkey(id, name), club_b:clubs!ties_club_b_id_fkey(id, name)')
        .or(`club_a_id.eq.${club.id},club_b_id.eq.${club.id}`)
        .in('status', ['pending', 'lineup_phase', 'lineup_ready', 'in_progress'])
        .order('tie_order')

      if (!ties || ties.length === 0) { setError('진행중인 타이가 없습니다.'); setLoading(false); return }

      sessionStorage.setItem('captain_pin', pin)

      if (ties.length === 1) { router.push(`/lineup/${ties[0].id}`); return }
      setTeamTies(ties)
    } catch { setError('서버 오류가 발생했습니다.') }
    finally { setLoading(false) }
  }

  function goToTie(tieId: string) {
    sessionStorage.setItem('captain_pin', pin)
    router.push(`/lineup/${tieId}`)
  }

  function resetMode() { setMode('select'); setPin(''); setError(''); setTeamTies([]) }

  if (loginSuccess) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="text-6xl mb-4">🔔</div>
        <h1 className="text-xl font-bold mb-2 text-center">참석 확인 &amp; 알림 받기</h1>
        <p className="text-stone-500 text-sm mb-2 text-center">
          알림을 허용하면 <strong>참석 확인</strong>이 자동으로 완료됩니다.
        </p>
        <p className="text-stone-400 text-xs mb-8 text-center">
          내 코트 차례가 되면 앱이 꺼져 있어도 알림이 와요
        </p>
        <div className="w-full max-w-sm space-y-3">
          {pushStatus === 'success' ? (
            <div className="text-center py-4">
              <div className="text-4xl mb-3">✅</div>
              <p className="text-green-600 font-bold text-lg">참석 확인 완료!</p>
              <p className="text-green-500 text-sm mt-1">{pushMessage}</p>
              <p className="text-stone-400 text-sm mt-2">경기 목록으로 이동 중...</p>
            </div>
          ) : (
            <>
              <button
                onClick={handleAllowNotification}
                disabled={pushStatus === 'loading' || checkinLoading}
                className="w-full bg-green-600 text-white font-bold py-4 rounded-xl hover:bg-green-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2 text-lg shadow-lg"
              >
                {(pushStatus === 'loading' || checkinLoading) ? (
                  <><span className="animate-spin">⏳</span> 처리 중...</>
                ) : (
                  <>✅ 참석 확인 &amp; 알림 켜기</>
                )}
              </button>
              {pushStatus === 'error' && (
                <p className="text-xs text-red-500 text-center">{pushMessage}</p>
              )}
              <button
                onClick={handleSkipNotification}
                className="w-full text-stone-400 text-sm py-3 hover:text-stone-600"
              >
                알림 없이 계속하기
              </button>
              <p className="text-xs text-stone-300 text-center">
                건너뛰면 참석 확인이 되지 않습니다
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <Link href="/" className="text-stone-400 hover:text-stone-600 mb-8">← 홈으로</Link>
      <div className="text-5xl mb-4">🎾</div>
      <h1 className="text-2xl font-bold mb-2">점수 입력</h1>
      <p className="text-stone-500 text-sm mb-8">내 팀 전용 PIN 입력</p>

      <div className="w-full max-w-sm space-y-4">
        {mode === 'select' && (
          <div className="space-y-3">
            <button onClick={() => setMode('individual')}
              className="w-full bg-amber-50 border-2 border-amber-200 rounded-2xl p-5 text-left hover:border-amber-400 transition-all">
              <div className="text-2xl mb-1">🎾</div>
              <div className="font-bold">개인전</div>
              <div className="text-sm text-stone-500 mt-1">선수 PIN으로 점수 입력</div>
            </button>
            <button onClick={() => setMode('team')}
              className="w-full bg-blue-50 border-2 border-blue-200 rounded-2xl p-5 text-left hover:border-blue-400 transition-all">
              <div className="text-2xl mb-1">🏆</div>
              <div className="font-bold">단체전</div>
              <div className="text-sm text-stone-500 mt-1">팀장 PIN으로 로그인 후 점수 입력</div>
            </button>
          </div>
        )}

        {mode === 'individual' && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">개인전 점수입력</p>
            <input type="tel" maxLength={6} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleIndividualSubmit()}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-amber-500 outline-none" autoFocus />
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={handleIndividualSubmit} disabled={loading || pin.length !== 6}
              className="w-full bg-amber-600 text-white font-bold py-3.5 rounded-xl hover:bg-amber-700 disabled:opacity-50 transition-all">
              {loading ? '확인 중...' : '로그인'}
            </button>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">← 뒤로가기</button>
          </>
        )}

        {mode === 'team' && teamTies.length === 0 && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">단체전</p>
            <p className="text-xs text-stone-400 text-center">팀장 PIN 6자리를 입력하세요</p>
            <input type="tel" maxLength={6} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleTeamSubmit()}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-blue-500 outline-none" autoFocus />
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={handleTeamSubmit} disabled={loading || pin.length !== 6}
              className="w-full bg-blue-600 text-white font-bold py-3.5 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all">
              {loading ? '확인 중...' : '확인'}
            </button>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">← 뒤로가기</button>
          </>
        )}

        {mode === 'team' && teamTies.length > 0 && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">타이를 선택하세요</p>
            <div className="space-y-2">
              {teamTies.map((tie: any) => (
                <button key={tie.id} onClick={() => goToTie(tie.id)}
                  className="w-full bg-white border-2 border-blue-200 rounded-xl p-4 text-left hover:border-blue-400 transition-all">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-semibold">{tie.club_a?.name}</span>
                      <span className="text-stone-400 mx-2">vs</span>
                      <span className="font-semibold">{tie.club_b?.name}</span>
                    </div>
                    <span className="text-xs text-stone-400">#{tie.tie_order}</span>
                  </div>
                </button>
              ))}
            </div>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">← 뒤로가기</button>
          </>
        )}
      </div>
    </div>
  )
}
