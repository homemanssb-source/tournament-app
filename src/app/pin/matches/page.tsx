'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

interface PinMatch {
  id: string; match_num: string; stage: string; round: string; court: string | null
  court_order: number | null; status: string; score: string | null
  locked_by_participant: boolean
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  my_side: 'A' | 'B'; division_name: string
}

interface CourtContext {
  currentOrder: number | null
  currentMatch: { team_a_name: string; team_b_name: string; division_name: string } | null
  myOrder: number
  remainingBefore: number
}

export default function PinMatchesPage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [matches, setMatches] = useState<PinMatch[]>([])
  const [courtContexts, setCourtContexts] = useState<Map<string, CourtContext>>(new Map())
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [notifEnabled, setNotifEnabled] = useState(false)
  const prevWaitingRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const raw = sessionStorage.getItem('pin_session')
    if (!raw) { router.push('/pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadData(s)
  }, [])

  // 15초 자동 새로고침
  useEffect(() => {
    if (!session) return
    const interval = setInterval(() => loadData(session), 15000)
    return () => clearInterval(interval)
  }, [session])

  const loadData = useCallback(async (s: any) => {
    // 내 경기 목록
    const { data: pinData, error } = await supabase.rpc('rpc_pin_list_matches', { p_token: s.token })
    if (error) {
      sessionStorage.removeItem('pin_session')
      router.push('/pin')
      return
    }
    const myMatches: PinMatch[] = pinData.matches || []
    setMatches(myMatches)

    // 각 코트의 현재 진행 상황 조회
    const courts = [...new Set(myMatches.map(m => m.court).filter(Boolean))]
    const ctxMap = new Map<string, CourtContext>()

    if (courts.length > 0) {
      const { data: courtMatches } = await supabase.from('v_matches_with_teams').select('*')
        .eq('event_id', s.event_id)
        .in('court', courts)
        .neq('score', 'BYE')
        .order('court').order('court_order')

      for (const court of courts) {
        const cm = (courtMatches || []).filter((m: any) => m.court === court)
        // 현재 진행 중이거나 첫 번째 대기 경기
        const activeIdx = cm.findIndex((m: any) => m.status === 'IN_PROGRESS')
        const pendingIdx = cm.findIndex((m: any) => m.status === 'PENDING')
        const currentIdx = activeIdx >= 0 ? activeIdx : pendingIdx
        const currentMatch = currentIdx >= 0 ? cm[currentIdx] : null

        // 내 경기 찾기
        const myMatch = myMatches.find(m => m.court === court)
        const myIdx = myMatch ? cm.findIndex((m: any) => m.id === myMatch.id) : -1
        const remainingBefore = (currentIdx >= 0 && myIdx >= 0) ? myIdx - currentIdx : 0

        ctxMap.set(court!, {
          currentOrder: currentMatch?.court_order || null,
          currentMatch: currentMatch ? {
            team_a_name: currentMatch.team_a_name,
            team_b_name: currentMatch.team_b_name,
            division_name: currentMatch.division_name,
          } : null,
          myOrder: myMatch?.court_order || 0,
          remainingBefore: Math.max(0, remainingBefore),
        })

        // 알림 체크: 대기1이 되면 알림
        if (notifEnabled && myMatch && remainingBefore === 1) {
          const prevRemaining = prevWaitingRef.current.get(court!) ?? 99
          if (prevRemaining > 1) {
            sendNotification(court!, myMatch)
          }
        }
        if (court) prevWaitingRef.current.set(court, remainingBefore)
      }
    }

    setCourtContexts(ctxMap)
    setLoading(false)
  }, [notifEnabled])

  function sendNotification(court: string, match: PinMatch) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('🎾 경기 준비!', {
        body: `${court}에서 다음 경기입니다! 대기코트로 이동해주세요.`,
        icon: '🎾',
        tag: `court-${court}`,
      })
    }
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      setMsg('이 브라우저는 알림을 지원하지 않습니다.')
      return
    }
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      setNotifEnabled(true)
      setMsg('✅ 알림이 활성화되었습니다. 내 차례가 다가오면 알림을 보내드립니다.')
    } else {
      setMsg('알림 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.')
    }
  }

  async function submitScore(matchId: string, winnerId: string, score: string) {
    if (!score) { setMsg('점수를 입력해주세요. (예: 6:4)'); return }
    console.log('submitScore:', { matchId, winnerId, score })
    setSubmitting(matchId); setMsg('')

    const { data, error } = await supabase.rpc('rpc_pin_submit_score', {
      p_token: session.token,
      p_match_id: matchId,
      p_score: score,
      p_winner_id: winnerId,
    })
    setSubmitting(null)

    if (error) { setMsg(error.message); return }
    setMsg('✅ 결과가 저장되었습니다!')
    loadData(session)
  }

  function handleLogout() {
    sessionStorage.removeItem('pin_session')
    router.push('/pin')
  }

  if (!session) return null

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold">🔑 {session.team_name}</h1>
            <p className="text-xs text-stone-500">{session.division}</p>
          </div>
          <button onClick={handleLogout} className="text-sm text-stone-400 hover:text-red-500">로그아웃</button>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6">
        {/* 알림 활성화 버튼 */}
        {!notifEnabled && (
          <button onClick={enableNotifications}
            className="w-full mb-4 p-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700 hover:bg-blue-100 transition-all">
            🔔 알림 켜기 — 내 차례가 다가오면 알려드립니다
          </button>
        )}
        {notifEnabled && (
          <div className="mb-4 p-2 bg-blue-50 rounded-xl text-xs text-blue-600 text-center">
            🔔 알림 활성화됨 — 대기 1번째가 되면 알림을 보내드립니다
          </div>
        )}

        {msg && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {loading ? (
          <p className="text-center py-10 text-stone-400">불러오는 중...</p>
        ) : matches.length === 0 ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-3">🎉</div>
            <p className="text-stone-500">입력할 경기가 없습니다.</p>
            <p className="text-stone-400 text-sm mt-1">모든 경기가 완료되었거나 아직 배정되지 않았습니다.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {matches.map(m => {
              const ctx = m.court ? courtContexts.get(m.court) : null
              return (
                <div key={m.id} className="bg-white rounded-xl border overflow-hidden">
                  {/* 코트 대기 상황 */}
                  {ctx && m.court && m.stage === 'GROUP' && (
                    <CourtWaitingBar court={m.court} ctx={ctx} />
                  )}

                  <div className="p-4">
                    {/* 경기 정보 */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-stone-400">{m.round} · {m.match_num}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">{m.division_name}</span>
                      </div>
                      {m.court && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[#2d5016]/10 text-[#2d5016] font-bold">
                          {m.court} #{m.court_order}
                        </span>
                      )}
                    </div>

                    {/* 팀 대결 */}
                    <div className="flex items-center justify-center gap-3 mb-3">
                      <div className={`text-center flex-1 ${m.my_side === 'A' ? 'font-bold text-tennis-700' : ''}`}>
                        <div className="text-sm">{m.team_a_name}</div>
                        {m.my_side === 'A' && <span className="text-xs text-tennis-500">내 팀</span>}
                      </div>
                      <span className="text-stone-300 font-bold">VS</span>
                      <div className={`text-center flex-1 ${m.my_side === 'B' ? 'font-bold text-tennis-700' : ''}`}>
                        <div className="text-sm">{m.team_b_name}</div>
                        {m.my_side === 'B' && <span className="text-xs text-tennis-500">내 팀</span>}
                      </div>
                    </div>

                    {/* 점수 입력 */}
                    {m.locked_by_participant ? (
                      <div className="text-center text-sm text-stone-400 py-2">
                        🔒 이미 입력 완료 ({m.score})
                      </div>
                    ) : (
                      <ScoreInput
                        match={m}
                        submitting={submitting === m.id}
                        onSubmit={(matchId, winnerId, score) => submitScore(matchId, winnerId, score)}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

// 코트 대기 상황 바
function CourtWaitingBar({ court, ctx }: { court: string; ctx: CourtContext }) {
  const { remainingBefore, currentMatch } = ctx

  let statusColor = 'bg-stone-100 text-stone-600'
  let statusText = ''
  let statusEmoji = ''

  if (remainingBefore === 0) {
    statusColor = 'bg-red-100 text-red-700'
    statusText = '지금 내 경기!'
    statusEmoji = '🔴'
  } else if (remainingBefore === 1) {
    statusColor = 'bg-amber-100 text-amber-700'
    statusText = '다음 경기 (대기코트로 이동!)'
    statusEmoji = '🟡'
  } else if (remainingBefore === 2) {
    statusColor = 'bg-green-100 text-green-700'
    statusText = `앞에 ${remainingBefore}경기 남음`
    statusEmoji = '🟢'
  } else {
    statusText = `앞에 ${remainingBefore}경기 남음`
    statusEmoji = '⏳'
  }

  return (
    <div className={`px-4 py-2.5 ${statusColor}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">{statusEmoji} {statusText}</span>
        <span className="text-xs opacity-70">{court}</span>
      </div>
      {currentMatch && remainingBefore > 0 && (
        <div className="text-xs mt-1 opacity-70">
          현재 진행: {currentMatch.team_a_name} vs {currentMatch.team_b_name} ({currentMatch.division_name})
        </div>
      )}
    </div>
  )
}

// 점수 입력 (3단계: ① 승자 선택 → ② 점수 입력 → ③ 최종 확인)
function ScoreInput({ match, submitting, onSubmit }: {
  match: PinMatch
  submitting: boolean
  onSubmit: (matchId: string, winnerId: string, score: string) => void
}) {
  const [step, setStep] = useState<'select_winner' | 'enter_score' | 'confirm'>('select_winner')
  const [winnerId, setWinnerId] = useState<string>('')
  const [score, setScore] = useState('')

  function selectWinner(id: string) {
    setWinnerId(id)
    setStep('enter_score')
  }

  function goToConfirm() {
    if (!score.trim()) return
    setStep('confirm')
  }

  function reset() {
    setStep('select_winner')
    setWinnerId('')
    setScore('')
  }

  const winnerName = winnerId === match.team_a_id ? match.team_a_name : match.team_b_name
  const loserName = winnerId === match.team_a_id ? match.team_b_name : match.team_a_name

  // ① 승자 선택
  if (step === 'select_winner') {
    return (
      <div>
        <p className="text-xs text-stone-500 text-center mb-2">승리팀을 선택하세요</p>
        <div className="flex gap-2">
          <button
            onClick={() => selectWinner(match.team_a_id)}
            className="flex-1 py-3 rounded-lg border-2 border-stone-200 hover:border-tennis-500 hover:bg-tennis-50 transition-all text-sm font-bold"
          >
            🏆 {match.team_a_name}
            {match.my_side === 'A' && <span className="block text-xs font-normal text-tennis-500">내 팀</span>}
          </button>
          <button
            onClick={() => selectWinner(match.team_b_id)}
            className="flex-1 py-3 rounded-lg border-2 border-stone-200 hover:border-tennis-500 hover:bg-tennis-50 transition-all text-sm font-bold"
          >
            🏆 {match.team_b_name}
            {match.my_side === 'B' && <span className="block text-xs font-normal text-tennis-500">내 팀</span>}
          </button>
        </div>
      </div>
    )
  }

  // ② 점수 입력
  if (step === 'enter_score') {
    return (
      <div>
        <div className="text-center mb-3">
          <span className="inline-block px-3 py-1 bg-tennis-50 text-tennis-700 rounded-full text-xs font-bold">
            🏆 승리: {winnerName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text" placeholder="점수 입력 (예: 6:4)"
            value={score}
            onChange={e => setScore(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && goToConfirm()}
            className="score-input flex-1"
            autoFocus
          />
          <button onClick={goToConfirm}
            disabled={!score.trim()}
            className="bg-amber-500 text-white font-bold px-4 py-3 rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-all whitespace-nowrap">
            다음
          </button>
          <button onClick={reset}
            className="text-stone-400 hover:text-stone-600 px-2 py-3 text-sm">
            취소
          </button>
        </div>
      </div>
    )
  }

  // ③ 최종 확인
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
      <p className="text-center text-sm font-bold text-amber-800 mb-3">⚠️ 결과를 확인해주세요</p>
      <div className="text-center space-y-1 mb-4">
        <div className="text-lg font-bold text-tennis-700">🏆 {winnerName}</div>
        <div className="text-stone-400 text-xs">vs</div>
        <div className="text-sm text-stone-500">{loserName}</div>
        <div className="text-xl font-bold mt-2">{score}</div>
      </div>
      <div className="flex gap-2">
        <button onClick={reset}
          className="flex-1 py-3 rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-100 text-sm font-medium transition-all">
          ← 다시 입력
        </button>
        <button
          onClick={() => onSubmit(match.id, winnerId, score)}
          disabled={submitting}
          className="flex-1 py-3 rounded-lg bg-red-500 text-white font-bold hover:bg-red-600 disabled:opacity-50 text-sm transition-all">
          {submitting ? '제출 중...' : '✅ 결과 확정'}
        </button>
      </div>
    </div>
  )
}
