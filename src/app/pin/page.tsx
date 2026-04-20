'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { usePushSubscription } from '@/hooks/usePushSubscription'

type Mode = 'select' | 'individual' | 'team';

interface DivisionChoice {
  division_id: string | null
  division_name: string
  clubs: { id: string; name: string }[]
}

const NOTIF_DONE_KEY = 'pin_notif_done'

export default function PinPage() {
  const router = useRouter()
  const [selectedEvent, setSelectedEvent] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<Mode>('select')
  const [teamTies, setTeamTies] = useState<any[]>([])
  const [divisionChoices, setDivisionChoices] = useState<DivisionChoice[]>([])
  const [selectedDivName, setSelectedDivName] = useState<string>('')
  const [teamNotifPrompt, setTeamNotifPrompt] = useState(false)
  const [teamNextState, setTeamNextState] = useState<{ choices?: DivisionChoice[]; clubIds?: string[] } | null>(null)

  const { status: pushStatus, message: pushMessage, subscribeWithPin } = usePushSubscription()
  const [loginSuccess, setLoginSuccess] = useState(false)
  const [loginPin, setLoginPin] = useState('')
  const [checkinLoading, setCheckinLoading] = useState(false)

  // ✅ 이미 로그인된 세션 있으면 바로 /pin/matches로 이동
  useEffect(() => {
    let raw = sessionStorage.getItem('pin_session')
    if (!raw) {
      const lsRaw = localStorage.getItem('pin_session')
      if (lsRaw) {
        try {
          const parsed = JSON.parse(lsRaw)
          if (parsed._savedAt && Date.now() - parsed._savedAt < 12 * 60 * 60 * 1000) {
            sessionStorage.setItem('pin_session', lsRaw)
            raw = lsRaw
          } else {
            localStorage.removeItem('pin_session')
          }
        } catch {
          localStorage.removeItem('pin_session')
        }
      }
    }
    if (raw) router.replace('/pin/matches')
  }, [])

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
        // 오늘 날짜와 절댓값 기준 가장 가까운 대회 선택 (과거 포함)
        const best = data.reduce((prev, curr) => {
          const prevDiff = Math.abs(new Date(prev.date).getTime() - new Date(today).getTime())
          const currDiff = Math.abs(new Date(curr.date).getTime() - new Date(today).getTime())
          return currDiff < prevDiff ? curr : prev
        })
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
      subscribeOk = await subscribeWithPin(loginPin, { mode: 'individual', eventId: selectedEvent })
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
      // 같은 팀이 여러 부서로 신청한 경우 clubs 테이블에 부서별 row가 생기므로 전체 조회
      const { data: clubs } = await supabase
        .from('clubs').select('id, name, event_id, division_id')
        .eq('captain_pin', pin)
      if (!clubs || clubs.length === 0) { setError('팀 PIN에 해당하는 클럽을 찾을 수 없습니다.'); setLoading(false); return }

      // 부서 이름 맵핑 — 여러 부서에 걸친 경우만 조회
      const divIds = [...new Set(clubs.map(c => c.division_id).filter(Boolean))] as string[]
      const divNameMap: Record<string, string> = {}
      if (divIds.length > 0) {
        const { data: divs } = await supabase.from('divisions').select('id, name').in('id', divIds)
        for (const d of (divs || [])) divNameMap[(d as any).id] = (d as any).name
      }

      // 부서별 그룹핑
      const divMap = new Map<string, DivisionChoice>()
      for (const c of clubs) {
        const key = c.division_id || '_nodiv'
        const name = c.division_id ? (divNameMap[c.division_id] || '(부서 미지정)') : '단체전'
        if (!divMap.has(key)) divMap.set(key, { division_id: c.division_id, division_name: name, clubs: [] })
        divMap.get(key)!.clubs.push({ id: c.id, name: c.name })
      }

      sessionStorage.setItem('captain_pin', pin)
      setLoginPin(pin)

      const allChoices = [...divMap.values()]
      const allClubIds = clubs.map(c => c.id)

      // 이미 알림 등록한 PIN이면 바로 다음 단계로
      let alreadyDone = false
      try {
        const donePins = JSON.parse(localStorage.getItem(NOTIF_DONE_KEY) || '[]') as string[]
        alreadyDone = donePins.includes(pin)
      } catch {}

      if (alreadyDone) {
        if (divMap.size > 1) { setDivisionChoices(allChoices); setLoading(false); return }
        await loadTiesForClubs(allClubIds)
        return
      }

      // 알림 등록 안 한 PIN → 알림 켜기 화면 표시 후 계속
      setTeamNextState(divMap.size > 1 ? { choices: allChoices } : { clubIds: allClubIds })
      setTeamNotifPrompt(true)
    } catch { setError('서버 오류가 발생했습니다.') }
    finally { setLoading(false) }
  }

  async function handleTeamAllowNotification() {
    setCheckinLoading(true)
    try {
      await subscribeWithPin(loginPin, { mode: 'team', eventId: selectedEvent })
      markNotifDone(loginPin)
    } finally {
      setCheckinLoading(false)
    }
    proceedTeamAfterNotif()
  }

  function handleTeamSkipNotification() {
    proceedTeamAfterNotif()
  }

  function proceedTeamAfterNotif() {
    setTeamNotifPrompt(false)
    if (teamNextState?.choices) {
      setDivisionChoices(teamNextState.choices)
    } else if (teamNextState?.clubIds) {
      loadTiesForClubs(teamNextState.clubIds)
    }
    setTeamNextState(null)
  }

  async function loadTiesForClubs(clubIds: string[], divName?: string) {
    setError(''); setLoading(true)
    try {
      const orFilter = clubIds
        .flatMap(id => [`club_a_id.eq.${id}`, `club_b_id.eq.${id}`])
        .join(',')

      const { data: ties } = await supabase
        .from('ties')
        .select('id, tie_order, status, round, club_a:clubs!ties_club_a_id_fkey(id, name), club_b:clubs!ties_club_b_id_fkey(id, name)')
        .or(orFilter)
        .in('status', ['pending', 'lineup_phase', 'lineup_ready', 'in_progress'])
        // ✅ 승자 확정된 tie는 숨김 (예선 과반 후 winning_club_id 있어도 status는 in_progress 유지되므로 별도 필터 필요)
        .is('winning_club_id', null)
        .order('tie_order')

      if (!ties || ties.length === 0) { setError(`${divName ? divName + ' · ' : ''}진행중인 타이가 없습니다.`); return }

      if (divName) setSelectedDivName(divName)

      // ✅ 같은 팀이 여러 라운드(예선+본선)에 있을 수 있어, tie 1개만 있어도 라운드를 보고
      //    선택할 수 있도록 리스트로 표시 (자동 push 제거)
      if (ties.length === 1) { router.push(`/lineup/${ties[0].id}`); return }
      setTeamTies(ties)
    } finally { setLoading(false) }
  }

  // round 한글 라벨
  function roundKR(round: string | null): string {
    if (!round) return ''
    const m: Record<string, string> = {
      group: '예선', full_league: '풀리그',
      round_of_32: '32강', round_of_16: '16강',
      quarter: '8강', semi: '4강', final: '결승',
    }
    return m[round] || round
  }
  function roundColor(round: string | null): string {
    if (!round) return 'bg-stone-100 text-stone-600'
    const tournament = ['round_of_32','round_of_16','quarter','semi','final']
    return tournament.includes(round)
      ? 'bg-purple-100 text-purple-700 border border-purple-200'
      : 'bg-blue-100 text-blue-700 border border-blue-200'
  }

  async function pickDivision(choice: DivisionChoice) {
    setDivisionChoices([])
    await loadTiesForClubs(choice.clubs.map(c => c.id), choice.division_name)
  }

  function goToTie(tieId: string) {
    // ✅ tie별 키 + 일반 키 + localStorage(12시간) 모두 저장
    //    /lineup 페이지가 tie별 키를 먼저 보므로 반드시 같이 저장해야 PIN 재입력 방지
    sessionStorage.setItem('captain_pin', pin)
    sessionStorage.setItem(`captain_pin_${tieId}`, pin)
    try {
      localStorage.setItem('captain_pin_session', JSON.stringify({ pin, _savedAt: Date.now() }))
    } catch {}
    router.push(`/lineup/${tieId}`)
  }

  function resetMode() {
    setMode('select'); setPin(''); setError('')
    setTeamTies([]); setDivisionChoices([]); setSelectedDivName('')
    setTeamNotifPrompt(false); setTeamNextState(null)
  }

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

        {mode === 'team' && teamNotifPrompt && (
          <div className="space-y-4 text-center">
            <div className="text-5xl">🔔</div>
            <h2 className="font-bold text-lg">알림 받기 (휴대폰 꺼져 있어도 OK)</h2>
            <p className="text-xs text-stone-500">
              내 팀 코트 차례가 오면 앱이 꺼져 있어도 알림이 와요.<br />
              <span className="text-stone-400">여러 부서 등록시 모든 부서 알림 한 번에 등록됩니다.</span>
            </p>
            {pushStatus === 'success' ? (
              <div className="py-2">
                <div className="text-3xl mb-2">✅</div>
                <p className="text-green-600 font-bold">알림 설정 완료!</p>
                <button onClick={proceedTeamAfterNotif}
                  className="mt-3 w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700">다음</button>
              </div>
            ) : (
              <>
                <button onClick={handleTeamAllowNotification}
                  disabled={pushStatus === 'loading' || checkinLoading}
                  className="w-full bg-green-600 text-white font-bold py-4 rounded-xl hover:bg-green-700 disabled:opacity-50 transition-all text-lg shadow-lg">
                  {(pushStatus === 'loading' || checkinLoading) ? '⏳ 처리 중...' : '✅ 알림 켜기'}
                </button>
                {pushStatus === 'error' && <p className="text-xs text-red-500">{pushMessage}</p>}
                <button onClick={handleTeamSkipNotification} className="w-full text-stone-400 text-sm py-3 hover:text-stone-600">
                  건너뛰기
                </button>
              </>
            )}
          </div>
        )}

        {mode === 'team' && !teamNotifPrompt && teamTies.length === 0 && divisionChoices.length === 0 && (
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

        {mode === 'team' && divisionChoices.length > 0 && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">부서를 선택하세요</p>
            <p className="text-xs text-stone-400 text-center">동일 팀장 PIN으로 여러 부서에 신청되어 있습니다</p>
            <div className="space-y-2">
              {divisionChoices.map(c => (
                <button key={c.division_id || '_nodiv'} onClick={() => pickDivision(c)}
                  disabled={loading}
                  className="w-full bg-white border-2 border-blue-200 rounded-xl p-4 text-left hover:border-blue-400 disabled:opacity-50 transition-all">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-bold text-blue-700">{c.division_name}</div>
                      <div className="text-xs text-stone-500 mt-0.5">
                        {c.clubs.map(cl => cl.name).join(', ')}
                      </div>
                    </div>
                    <span className="text-stone-400">→</span>
                  </div>
                </button>
              ))}
            </div>
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">← 뒤로가기</button>
          </>
        )}

        {mode === 'team' && teamTies.length > 0 && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">
              {selectedDivName ? `${selectedDivName} · 대전 선택` : '타이를 선택하세요'}
            </p>
            <div className="space-y-2">
              {(() => {
                // 같은 두 팀 조합이 여러 번 나타나면 표시 강조 (예선+본선 케이스)
                const pairCount = new Map<string, number>()
                for (const t of teamTies) {
                  const key = [t.club_a?.id, t.club_b?.id].sort().join('|')
                  pairCount.set(key, (pairCount.get(key) || 0) + 1)
                }
                return teamTies.map((tie: any) => {
                  const key = [tie.club_a?.id, tie.club_b?.id].sort().join('|')
                  const isDup = (pairCount.get(key) || 0) > 1
                  return (
                    <button key={tie.id} onClick={() => goToTie(tie.id)}
                      className={`w-full bg-white border-2 rounded-xl p-4 text-left transition-all ${
                        isDup ? 'border-amber-300 hover:border-amber-500' : 'border-blue-200 hover:border-blue-400'
                      }`}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className={`text-xs px-2 py-0.5 rounded font-bold ${roundColor(tie.round)}`}>
                          {roundKR(tie.round)}
                        </span>
                        <span className="text-xs text-stone-400">#{tie.tie_order || '-'}</span>
                      </div>
                      <div className="flex items-center">
                        <span className="font-semibold">{tie.club_a?.name}</span>
                        <span className="text-stone-400 mx-2">vs</span>
                        <span className="font-semibold">{tie.club_b?.name}</span>
                      </div>
                      {isDup && (
                        <p className="text-[10px] text-amber-600 mt-1.5">⚠️ 같은 팀이 여러 라운드에 있어요. 라운드를 잘 확인하세요.</p>
                      )}
                    </button>
                  )
                })
              })()}
            </div>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">← 뒤로가기</button>
          </>
        )}
      </div>
    </div>
  )
}

