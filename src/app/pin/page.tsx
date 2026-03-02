'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Mode = 'select' | 'individual' | 'team_lineup' | 'team_score';

export default function PinPage() {
  const router = useRouter()
  const [events, setEvents] = useState<any[]>([])
  const [selectedEvent, setSelectedEvent] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<Mode>('select')

  // 단체전 라인업 검색 결과
  const [teamTies, setTeamTies] = useState<any[]>([])

  useEffect(() => {
    supabase.from('events').select('id, name, event_type').eq('status', 'active')
      .then(({ data }) => {
        setEvents(data || [])
        if (data?.length === 1) setSelectedEvent(data[0].id)
      })
  }, [])

  // 개인전 PIN 로그인
  async function handleIndividualSubmit() {
    if (!selectedEvent) { setError('대회를 선택해주세요.'); return }
    if (pin.length !== 6) { setError('PIN 6자리를 입력해주세요.'); return }
    setError(''); setLoading(true)

    const { data, error: err } = await supabase.rpc('rpc_pin_login', {
      p_pin_code: pin,
      p_event_id: selectedEvent,
    })

    setLoading(false)
    if (err) { setError(err.message || 'PIN이 올바르지 않습니다.'); return }

    sessionStorage.setItem('pin_session', JSON.stringify(data))
    router.push('/pin/matches')
  }

  // 단체전 - 주장 PIN으로 대전 찾기
  async function handleTeamLineupSubmit() {
    if (pin.length !== 6) { setError('주장 PIN 6자리를 입력해주세요.'); return }
    setError(''); setLoading(true)

    try {
      // PIN으로 클럽 찾기
      const { data: club } = await supabase
        .from('clubs')
        .select('id, name, event_id')
        .eq('captain_pin', pin)
        .limit(1)
        .single()

      if (!club) {
        setError('주장 PIN이 일치하는 클럽을 찾을 수 없습니다.')
        setLoading(false)
        return
      }

      // 해당 클럽의 진행중 대전 찾기
      const { data: ties } = await supabase
        .from('ties')
        .select(`
          id, tie_order, status, round,
          club_a:clubs!ties_club_a_id_fkey(id, name),
          club_b:clubs!ties_club_b_id_fkey(id, name)
        `)
        .or(`club_a_id.eq.${club.id},club_b_id.eq.${club.id}`)
        .in('status', ['pending', 'lineup_phase', 'lineup_ready', 'in_progress'])
        .order('tie_order')

      if (!ties || ties.length === 0) {
        setError('진행중인 대전이 없습니다.')
        setLoading(false)
        return
      }

      if (ties.length === 1) {
        // 대전이 1개면 바로 이동
        router.push(`/lineup/${ties[0].id}`)
        return
      }

      // 여러 대전이면 선택 화면 표시
      setTeamTies(ties)
    } catch (err: any) {
      setError('조회 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  // 단체전 러버 PIN 점수입력
  function handleTeamScoreSubmit() {
    router.push('/pin/team')
  }

  function resetMode() {
    setMode('select')
    setPin('')
    setError('')
    setTeamTies([])
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <Link href="/" className="text-stone-400 hover:text-stone-600 mb-8">← 홈으로</Link>

      <div className="text-5xl mb-4">🔑</div>
      <h1 className="text-2xl font-bold mb-2">참가자 입력</h1>
      <p className="text-stone-500 text-sm mb-8">대회 참가자용 PIN 입력</p>

      <div className="w-full max-w-sm space-y-4">
        {/* 대회 선택 */}
        {events.length > 1 && mode !== 'select' && (
          <select value={selectedEvent} onChange={e => setSelectedEvent(e.target.value)}
            className="w-full border border-stone-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-tennis-600">
            <option value="">대회 선택</option>
            {events.map(ev => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
          </select>
        )}

        {/* ── 모드 선택 ── */}
        {mode === 'select' && (
          <div className="space-y-3">
            <button
              onClick={() => setMode('individual')}
              className="w-full bg-amber-50 border-2 border-amber-200 rounded-2xl p-5 text-left hover:border-amber-400 transition-all"
            >
              <div className="text-2xl mb-1">🎾</div>
              <div className="font-bold">개인전 점수입력</div>
              <div className="text-sm text-stone-500 mt-1">경기 PIN으로 결과 입력</div>
            </button>

            <button
              onClick={() => setMode('team_lineup')}
              className="w-full bg-blue-50 border-2 border-blue-200 rounded-2xl p-5 text-left hover:border-blue-400 transition-all"
            >
              <div className="text-2xl mb-1">📋</div>
              <div className="font-bold">단체전 라인업 제출</div>
              <div className="text-sm text-stone-500 mt-1">주장 PIN으로 라인업 봉인 제출</div>
            </button>

            <button
              onClick={() => setMode('team_score')}
              className="w-full bg-green-50 border-2 border-green-200 rounded-2xl p-5 text-left hover:border-green-400 transition-all"
            >
              <div className="text-2xl mb-1">🏆</div>
              <div className="font-bold">단체전 점수입력</div>
              <div className="text-sm text-stone-500 mt-1">러버 PIN으로 복식 경기 결과 입력</div>
            </button>
          </div>
        )}

        {/* ── 개인전 PIN 입력 ── */}
        {mode === 'individual' && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">🎾 개인전 점수입력</p>
            <input type="tel" maxLength={6} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleIndividualSubmit()}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-amber-500 outline-none"
              autoFocus />

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <button onClick={handleIndividualSubmit} disabled={loading || pin.length !== 6}
              className="w-full bg-amber-600 text-white font-bold py-3.5 rounded-xl hover:bg-amber-700 disabled:opacity-50 transition-all">
              {loading ? '확인 중...' : '로그인'}
            </button>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">
              ← 돌아가기
            </button>
          </>
        )}

        {/* ── 단체전 라인업 - PIN 입력 ── */}
        {mode === 'team_lineup' && teamTies.length === 0 && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">📋 단체전 라인업 제출</p>
            <p className="text-xs text-stone-400 text-center">주장 PIN 6자리를 입력하세요</p>
            <input type="tel" maxLength={6} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleTeamLineupSubmit()}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-blue-500 outline-none"
              autoFocus />

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <button onClick={handleTeamLineupSubmit} disabled={loading || pin.length !== 6}
              className="w-full bg-blue-600 text-white font-bold py-3.5 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all">
              {loading ? '확인 중...' : '라인업 제출하기'}
            </button>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">
              ← 돌아가기
            </button>
          </>
        )}

        {/* ── 단체전 라인업 - 대전 선택 ── */}
        {mode === 'team_lineup' && teamTies.length > 0 && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">대전을 선택하세요</p>
            <div className="space-y-2">
              {teamTies.map((tie: any) => (
                <button
                  key={tie.id}
                  onClick={() => router.push(`/lineup/${tie.id}`)}
                  className="w-full bg-white border-2 border-blue-200 rounded-xl p-4 text-left hover:border-blue-400 transition-all"
                >
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
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">
              ← 돌아가기
            </button>
          </>
        )}

        {/* ── 단체전 점수입력 → /pin/team으로 이동 ── */}
        {mode === 'team_score' && (
          <>
            <p className="text-center text-sm text-stone-600 font-medium">🏆 단체전 점수입력</p>
            <p className="text-xs text-stone-400 text-center">러버 PIN 페이지로 이동합니다</p>
            <button onClick={handleTeamScoreSubmit}
              className="w-full bg-green-600 text-white font-bold py-3.5 rounded-xl hover:bg-green-700 transition-all">
              점수입력 페이지로 이동
            </button>
            <button onClick={resetMode} className="w-full text-stone-400 text-sm py-2 hover:text-stone-600">
              ← 돌아가기
            </button>
          </>
        )}
      </div>
    </div>
  )
}