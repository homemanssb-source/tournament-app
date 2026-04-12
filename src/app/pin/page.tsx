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


============================================================
FILE: src\app\pin\team\page.tsx
============================================================
// ============================================================
// src/app/pin/team/page.tsx
// ✅ 경기 시작(in_progress) 없이도 PIN으로 점수 입력 가능
//    pending / lineup_ready / in_progress 모두 허용
// ============================================================
'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { pinRecordScore } from '@/lib/team-api';
import { formatSetScore } from '@/lib/team-utils';
import type { TieRubber, Tie, Club, ClubMember } from '@/types/team';

type Step = 'pin' | 'score' | 'confirm' | 'done';

export default function TeamPinScorePage() {
  const [step, setStep]     = useState<Step>('pin');
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  const [pin, setPin]       = useState('');
  const [rubber, setRubber] = useState<TieRubber | null>(null);
  const [tie, setTie]       = useState<Tie | null>(null);
  const [clubA, setClubA]   = useState<Club | null>(null);
  const [clubB, setClubB]   = useState<Club | null>(null);
  const [playersA, setPlayersA] = useState<{ p1: ClubMember | null; p2: ClubMember | null }>({ p1: null, p2: null });
  const [playersB, setPlayersB] = useState<{ p1: ClubMember | null; p2: ClubMember | null }>({ p1: null, p2: null });

  const [set1a, setSet1a] = useState('');
  const [set1b, setSet1b] = useState('');
  const [set2a, setSet2a] = useState('');
  const [set2b, setSet2b] = useState('');
  const [set3a, setSet3a] = useState('');
  const [set3b, setSet3b] = useState('');
  const [setsPerRubber, setSetsPerRubber] = useState(1);

  // PIN 확인 → 경기 찾기
  async function handlePinSubmit() {
    if (pin.length !== 6) { setError('PIN 6자리를 입력하세요.'); return; }
    setError('');
    setLoading(true);

    try {
      // ✅ pending / lineup_ready / in_progress 모두 허용 (경기 시작 불필요)
      const { data: rubberData } = await supabase
        .from('tie_rubbers')
        .select('*')
        .eq('pin_code', pin)
        .in('status', ['pending', 'in_progress'])
        .limit(1)
        .single();

      if (!rubberData) {
        // completed 여부 확인
        const { data: anyRubber } = await supabase
          .from('tie_rubbers')
          .select('status')
          .eq('pin_code', pin)
          .limit(1)
          .single();

        if (anyRubber?.status === 'completed') {
          setError('이미 점수가 입력된 경기입니다.');
        } else {
          setError('PIN이 일치하는 경기를 찾을 수 없습니다.');
        }
        return;
      }

      setRubber(rubberData);

      const { data: tieData } = await supabase
        .from('ties')
        .select('*')
        .eq('id', rubberData.tie_id)
        .single();
      setTie(tieData);

      if (tieData) {
        const playerAQueries = rubberData.club_a_player1_id ? [
          supabase.from('club_members').select('*').eq('id', rubberData.club_a_player1_id).single(),
          rubberData.club_a_player2_id
            ? supabase.from('club_members').select('*').eq('id', rubberData.club_a_player2_id).single()
            : Promise.resolve({ data: null }),
        ] : [Promise.resolve({ data: null }), Promise.resolve({ data: null })];

        const playerBQueries = rubberData.club_b_player1_id ? [
          supabase.from('club_members').select('*').eq('id', rubberData.club_b_player1_id).single(),
          rubberData.club_b_player2_id
            ? supabase.from('club_members').select('*').eq('id', rubberData.club_b_player2_id).single()
            : Promise.resolve({ data: null }),
        ] : [Promise.resolve({ data: null }), Promise.resolve({ data: null })];

        const [
          { data: ca },
          { data: cb },
          { data: ev },
          [{ data: ap1 }, { data: ap2 }],
          [{ data: bp1 }, { data: bp2 }],
        ] = await Promise.all([
          supabase.from('clubs').select('*').eq('id', tieData.club_a_id).single(),
          supabase.from('clubs').select('*').eq('id', tieData.club_b_id).single(),
          supabase.from('events').select('team_sets_per_rubber').eq('id', tieData.event_id).single(),
          Promise.all(playerAQueries),
          Promise.all(playerBQueries),
        ]);

        setClubA(ca);
        setClubB(cb);
        setSetsPerRubber(ev?.team_sets_per_rubber || 1);
        setPlayersA({ p1: ap1, p2: ap2 });
        setPlayersB({ p1: bp1, p2: bp2 });
      }

      setStep('score');
    } catch (err: any) {
      setError('조회 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  function handleScoreNext() {
    if (!set1a || !set1b) { setError('1세트 점수를 입력하세요.'); return; }

    if (setsPerRubber === 3) {
      if (!set2a || !set2b) { setError('2세트 점수를 입력하세요.'); return; }
      const s1win = parseInt(set1a) > parseInt(set1b) ? 'a' : 'b';
      const s2win = parseInt(set2a) > parseInt(set2b) ? 'a' : 'b';
      if (s1win !== s2win && (!set3a || !set3b)) {
        setError('세트 동률입니다. 3세트 점수를 입력하세요.');
        return;
      }
    }

    setError('');
    setStep('confirm');
  }

  async function handleFinalSubmit() {
    if (!rubber) return;
    setLoading(true);
    setError('');

    try {
      const result = await pinRecordScore(
        pin,
        rubber.id,
        parseInt(set1a), parseInt(set1b),
        set2a ? parseInt(set2a) : null,
        set2b ? parseInt(set2b) : null,
        set3a ? parseInt(set3a) : null,
        set3b ? parseInt(set3b) : null,
      );

      if (!result.success) {
        setError(result.error || '점수 저장 실패');
        setStep('score');
        return;
      }

      setStep('done');
    } catch (err: any) {
      setError(err.message || '점수 저장 실패');
      setStep('score');
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep('pin');
    setPin('');
    setError('');
    setRubber(null);
    setTie(null);
    setSet1a(''); setSet1b('');
    setSet2a(''); setSet2b('');
    setSet3a(''); setSet3b('');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto p-6 space-y-6">

        <div className="text-center">
          <h1 className="text-xl font-bold">🎾 단체전 점수입력</h1>
          <div className="flex justify-center gap-2 mt-3">
            {['PIN', '점수', '확인'].map((label, i) => {
              const stepIdx = ['pin', 'score', 'confirm'].indexOf(step);
              const active  = i <= stepIdx && step !== 'done';
              return (
                <div key={label} className={`flex items-center gap-1 ${active ? 'text-blue-600' : 'text-gray-300'}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${active ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}>
                    {i + 1}
                  </div>
                  <span className="text-xs">{label}</span>
                  {i < 2 && <span className="text-gray-300 mx-1">→</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 1: PIN */}
        {step === 'pin' && (
          <div className="bg-white rounded-xl border p-6 space-y-4">
            <h2 className="font-semibold text-center">경기 PIN 입력</h2>
            <p className="text-sm text-gray-500 text-center">코트에 배정된 6자리 PIN을 입력하세요.</p>
            <input
              type="tel"
              maxLength={6}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-blue-500 outline-none"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handlePinSubmit()}
            />
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button
              onClick={handlePinSubmit}
              disabled={loading || pin.length !== 6}
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '확인중...' : '다음'}
            </button>
          </div>
        )}

        {/* Step 2: 스코어 입력 */}
        {step === 'score' && rubber && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border p-4 text-center">
              <p className="text-sm text-gray-500">러버 {rubber.rubber_number}</p>
              <div className="flex items-center justify-center gap-4 mt-2">
                <div>
                  <div className="font-bold">{clubA?.name}</div>
                  <div className="text-xs text-gray-500">
                    {playersA.p1?.name || '-'} / {playersA.p2?.name || '-'}
                  </div>
                </div>
                <span className="text-gray-400 font-bold">vs</span>
                <div>
                  <div className="font-bold">{clubB?.name}</div>
                  <div className="text-xs text-gray-500">
                    {playersB.p1?.name || '-'} / {playersB.p2?.name || '-'}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border p-4 space-y-4">
              <ScoreInput label="1세트" aVal={set1a} bVal={set1b} setA={setSet1a} setB={setSet1b} clubA={clubA?.name} clubB={clubB?.name} />
              {setsPerRubber === 3 && (<>
                <ScoreInput label="2세트" aVal={set2a} bVal={set2b} setA={setSet2a} setB={setSet2b} clubA={clubA?.name} clubB={clubB?.name} />
                <ScoreInput label="3세트" aVal={set3a} bVal={set3b} setA={setSet3a} setB={setSet3b} clubA={clubA?.name} clubB={clubB?.name} />
              </>)}
            </div>

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <div className="flex gap-3">
              <button onClick={() => setStep('pin')} className="flex-1 bg-gray-100 py-3 rounded-xl font-medium">이전</button>
              <button onClick={handleScoreNext} className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700">다음</button>
            </div>
          </div>
        )}

        {/* Step 3: 확인 */}
        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border p-6">
              <h2 className="font-semibold text-center mb-4">점수 확인</h2>
              <div className="text-center mb-4">
                <span className="font-bold">{clubA?.name}</span>
                <span className="text-gray-400 mx-2">vs</span>
                <span className="font-bold">{clubB?.name}</span>
              </div>
              <div className="space-y-2 text-center">
                <div className="text-2xl font-bold">{set1a} - {set1b}</div>
                {set2a && set2b && <div className="text-2xl font-bold">{set2a} - {set2b}</div>}
                {set3a && set3b && <div className="text-2xl font-bold">{set3a} - {set3b}</div>}
              </div>
            </div>
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setStep('score'); setError(''); }} className="flex-1 bg-gray-100 py-3 rounded-xl font-medium">수정</button>
              <button
                onClick={handleFinalSubmit}
                disabled={loading}
                className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? '저장중...' : '✓ 점수 확정'}
              </button>
            </div>
          </div>
        )}

        {/* Done */}
        {step === 'done' && (
          <div className="bg-white rounded-xl border p-8 text-center space-y-4">
            <div className="text-4xl">✅</div>
            <h2 className="text-xl font-bold">점수가 저장되었습니다!</h2>
            <button
              onClick={reset}
              className="bg-blue-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-blue-700"
            >
              다른 경기 입력
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreInput({ label, aVal, bVal, setA, setB, clubA, clubB }: {
  label: string; aVal: string; bVal: string;
  setA: (v: string) => void; setB: (v: string) => void;
  clubA?: string; clubB?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-600 mb-2">{label}</label>
      <div className="flex items-center gap-3">
        <div className="flex-1 text-center">
          <div className="text-xs text-gray-400 mb-1">{clubA?.slice(0, 6)}</div>
          <input
            type="number" min="0" max="7"
            value={aVal}
            onChange={e => setA(e.target.value)}
            className="w-full border-2 rounded-xl px-3 py-3 text-center text-2xl focus:border-blue-500 outline-none"
          />
        </div>
        <span className="text-gray-400 font-bold text-xl">:</span>
        <div className="flex-1 text-center">
          <div className="text-xs text-gray-400 mb-1">{clubB?.slice(0, 6)}</div>
          <input
            type="number" min="0" max="7"
            value={bVal}
            onChange={e => setB(e.target.value)}
            className="w-full border-2 rounded-xl px-3 py-3 text-center text-2xl focus:border-blue-500 outline-none"
          />
        </div>
      </div>
    </div>
  );
}

