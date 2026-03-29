'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { usePushSubscription } from '@/hooks/usePushSubscription'

// ────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────
interface PinMatch {
  id: string; match_num: string; stage: string; round: string
  court: string | null; court_order: number | null
  status: string; score: string | null; locked_by_participant: boolean
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  my_side: 'A' | 'B'; division_name: string; group_label: string | null
}

interface CourtQueueMatch {
  id: string; court_order: number; status: string
  team_a_name: string; team_b_name: string; division_name: string
}

const ROUND_ORDER: Record<string, number> = { group:0, GROUP:0, R32:1, R16:2, QF:3, SF:4, F:5 }
const ROUND_LABEL: Record<string, string> = { group:'예선', GROUP:'예선', R32:'32강', R16:'16강', QF:'8강', SF:'4강', F:'결승' }

// ────────────────────────────────────────────
// 메인
// ────────────────────────────────────────────
export default function PinMatchesPage() {
  const router = useRouter()
  const [session, setSession]     = useState<any>(null)
  const [matches, setMatches]     = useState<PinMatch[]>([])
  const [courtQueues, setCourtQueues] = useState<Map<string, CourtQueueMatch[]>>(new Map())
  const [loading, setLoading]     = useState(true)
  const [msg, setMsg]             = useState('')

  // 점수 입력
  const [scores, setScores]         = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState<string | null>(null)

  // 알림 상태
  const [notifAllowed, setNotifAllowed]     = useState(false)
  const [notifRequested, setNotifRequested] = useState(false)
  const prevWaitRef = useRef<Map<string, number>>(new Map())

  const { autoResubscribe, subscribeWithPin } = usePushSubscription()

  // ── 초기화 ──────────────────────────────────
  useEffect(() => {
    const raw = sessionStorage.getItem('pin_session')
    if (!raw) { router.replace('/pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadData(s)

    if ('Notification' in window) {
      const perm = Notification.permission
      setNotifAllowed(perm === 'granted')
      setNotifRequested(perm !== 'default')
    }
    // Web Push 자동 재구독 (백그라운드)
    autoResubscribe()
  }, [])

  // ── 15초 자동갱신 ───────────────────────────
  useEffect(() => {
    if (!session) return
    const iv = setInterval(() => loadData(session), 15000)
    return () => clearInterval(iv)
  }, [session])

  // ── 데이터 로드 ─────────────────────────────
  const loadData = useCallback(async (s: any) => {
    // 내 경기만 (rpc_pin_list_matches)
    const { data, error } = await supabase.rpc('rpc_pin_list_matches', { p_token: s.token })
    if (error) { sessionStorage.removeItem('pin_session'); router.replace('/pin'); return }

    const myMatches: PinMatch[] = data.matches || []
    setMatches(myMatches)

    // ── 코트 대기열 조회 ──
    const courts = [...new Set(myMatches.map(m => m.court).filter(Boolean))] as string[]
    const queueMap = new Map<string, CourtQueueMatch[]>()

    if (courts.length > 0) {
      const { data: allMatches } = await supabase
        .from('v_matches_with_teams')
        .select('id, court, court_order, status, team_a_name, team_b_name, division_name')
        .eq('event_id', s.event_id)
        .in('court', courts)
        .neq('score', 'BYE')
        .order('court').order('court_order')

      for (const court of courts) {
        const q = (allMatches || [])
          .filter((m: any) => m.court === court)
          .sort((a: any, b: any) => (a.court_order || 0) - (b.court_order || 0))
        queueMap.set(court, q as CourtQueueMatch[])
      }
    }

    // ── 알림: 1경기 전이 되면 발송 ──
    for (const m of myMatches) {
      if (!m.court) continue
      const queue   = queueMap.get(m.court) || []
      const liveIdx = queue.findIndex(q => q.status === 'IN_PROGRESS')
      const pendIdx = queue.findIndex(q => q.status === 'PENDING')
      const curIdx  = liveIdx >= 0 ? liveIdx : pendIdx
      const myIdx   = queue.findIndex(q => q.id === m.id)
      const remaining = curIdx >= 0 && myIdx >= 0 ? Math.max(0, myIdx - curIdx) : 0

      if (notifAllowed && remaining === 1) {
        const prev = prevWaitRef.current.get(m.court) ?? 99
        if (prev > 1) sendBrowserNotif(m.court)
      }
      if (m.court) prevWaitRef.current.set(m.court, remaining)
    }

    setCourtQueues(queueMap)
    setLoading(false)
  }, [notifAllowed])

  // ── 브라우저 알림 발송 ──
  function sendBrowserNotif(court: string) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    new Notification('🎾 곧 내 차례!', {
      body: `${court}에서 다음 경기로 이동해주세요.`,
      icon: '/icon.png',
      tag: `court-${court}`,
    })
  }

  // ── 알림 권한 요청 ──
  async function requestNotification() {
    setNotifRequested(true)
    if (!('Notification' in window)) {
      alert('이 브라우저는 알림을 지원하지 않습니다.')
      return
    }
    try {
      const perm = await Notification.requestPermission()
      setNotifAllowed(perm === 'granted')
      if (perm === 'granted') {
        new Notification('제주 테니스 토너먼트', { body: '경기 알림이 활성화되었습니다.', icon: '/icon.png' })
        // Web Push도 함께 등록
        const pin = sessionStorage.getItem('venue_pin')
        if (pin) await subscribeWithPin(pin)
        else autoResubscribe()
      } else if (perm === 'denied') {
        alert('알림이 차단되어 있습니다.\n브라우저 설정 → 이 사이트 → 알림 허용으로 변경해주세요.')
      }
    } catch { setNotifAllowed(false) }
  }

  // ── 점수 입력 (1회, 수정 불가) ──
  async function submitScore(matchId: string) {
    const score = scores[matchId]?.trim()
    if (!score) { setMsg('점수를 입력해주세요. (예: 6:4)'); return }
    setSubmitting(matchId); setMsg('')
    const { error } = await supabase.rpc('rpc_pin_submit_score', {
      p_token: session.token, p_match_id: matchId, p_score: score,
    })
    setSubmitting(null)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 점수가 제출됐습니다!')
    loadData(session)
  }

  function handleLogout() {
    sessionStorage.removeItem('pin_session')
    sessionStorage.removeItem('venue_pin')
    sessionStorage.removeItem('pin_event_id')
    router.replace('/pin')
  }

  // ── 알림 버튼 ──
  function NotifButton() {
    if (notifAllowed) {
      return (
        <button
          onClick={() => { autoResubscribe(); sendBrowserNotif('테스트') }}
          className="text-xs text-white/60 hover:text-white/90 flex items-center gap-1"
          title="알림 켜짐 — 탭하면 테스트">
          🔔 알림 켜짐
        </button>
      )
    }
    if (notifRequested && !notifAllowed) {
      return (
        <button onClick={() => alert('알림이 차단되어 있습니다.\n브라우저 설정 → 이 사이트 → 알림 허용으로 변경해주세요.')}
          className="text-xs bg-red-500/80 text-white px-2.5 py-1 rounded-full">
          🔕 알림 차단됨
        </button>
      )
    }
    return (
      <button onClick={requestNotification}
        className="text-xs bg-amber-500 text-white px-2.5 py-1 rounded-full animate-pulse">
        🔔 알림 켜기
      </button>
    )
  }

  // ── 라운드별 그룹핑 ──
  const rounds = [...new Set(matches.map(m => m.round))].sort((a, b) => (ROUND_ORDER[a] ?? 9) - (ROUND_ORDER[b] ?? 9))

  if (!session) return null

  return (
    <div className="min-h-screen bg-stone-50">

      {/* 헤더 */}
      <header className="bg-[#2d5016] text-white sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-bold text-base">🎾 {session.team_name}</h1>
              <p className="text-xs text-white/60">{session.division} · 내 경기 · 15초 자동갱신</p>
            </div>
            <div className="flex items-center gap-2">
              <NotifButton />
              <button onClick={() => loadData(session)} className="text-sm bg-white/20 px-3 py-1.5 rounded-full">🔄</button>
              <button onClick={handleLogout} className="text-xs text-white/50 hover:text-white/80">로그아웃</button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-5">
        {msg && (
          <div className={`mb-4 p-3 rounded-xl text-sm font-medium ${msg.startsWith('✅') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
            {msg}
          </div>
        )}

        {loading ? (
          <p className="text-center py-12 text-stone-400">불러오는 중...</p>
        ) : matches.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">🎾</div>
            <p className="text-stone-500">배정된 경기가 없습니다.</p>
            <p className="text-stone-400 text-sm mt-1">코트 배정 후 여기에 표시됩니다.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {rounds.map(round => {
              const roundMatches = matches.filter(m => m.round === round)
              return (
                <section key={round}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-[#2d5016]" />
                    <span className="text-sm font-bold text-stone-600 tracking-wide">{ROUND_LABEL[round] || round}</span>
                    <span className="text-xs text-stone-400">{roundMatches.length}경기</span>
                  </div>
                  <div className="space-y-3">
                    {roundMatches.map(m => {
                      const isLive   = m.status === 'IN_PROGRESS'
                      const isDone   = m.status === 'FINISHED'
                      const canInput = isLive && !m.locked_by_participant
                      const queue    = m.court ? courtQueues.get(m.court) || [] : []
                      return (
                        <div key={m.id} className={`bg-white rounded-2xl border overflow-hidden shadow-sm ${isLive ? 'border-red-300 shadow-red-100' : isDone ? 'border-stone-100' : 'border-stone-200'}`}>

                          {/* LIVE 배너 */}
                          {isLive && (
                            <div className="bg-red-500 text-white px-4 py-1.5 flex items-center gap-2 text-xs font-bold">
                              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                              LIVE — 진행중
                            </div>
                          )}

                          {/* 코트 대기열 (슬라이딩 윈도우) */}
                          {m.court && !isDone && queue.length > 0 && (
                            <CourtQueue queue={queue} myMatchId={m.id} court={m.court} />
                          )}

                          <div className="p-4">
                            {/* 경기 정보 */}
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-xs text-stone-400">{m.match_num}</span>
                                <span className="text-xs px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">{m.division_name}</span>
                                {m.group_label && <span className="text-xs text-stone-400">{m.group_label}</span>}
                              </div>
                              {m.court ? (
                                <span className="text-xs px-2.5 py-0.5 rounded-full bg-[#2d5016]/10 text-[#2d5016] font-bold">📍 {m.court} #{m.court_order}</span>
                              ) : (
                                <span className="text-xs text-stone-400">코트 미배정</span>
                              )}
                            </div>

                            {/* 팀 vs 팀 */}
                            <div className="flex items-center justify-center gap-3 mb-4">
                              <div className={`text-center flex-1 ${m.my_side === 'A' ? 'font-bold' : ''}`}>
                                <div className={`text-sm ${m.my_side === 'A' ? 'text-[#2d5016]' : 'text-stone-700'}`}>{m.team_a_name}</div>
                                {m.my_side === 'A' && <span className="text-xs text-[#2d5016]/70 font-medium">내 팀 ▲</span>}
                              </div>
                              <div className="px-2 text-center">
                                {isDone && m.score ? (
                                  <span className="text-lg font-black text-stone-700">{m.score}</span>
                                ) : isLive ? (
                                  <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-0.5 rounded-full">진행중</span>
                                ) : (
                                  <span className="text-stone-300 font-bold text-sm">VS</span>
                                )}
                              </div>
                              <div className={`text-center flex-1 ${m.my_side === 'B' ? 'font-bold' : ''}`}>
                                <div className={`text-sm ${m.my_side === 'B' ? 'text-[#2d5016]' : 'text-stone-700'}`}>{m.team_b_name}</div>
                                {m.my_side === 'B' && <span className="text-xs text-[#2d5016]/70 font-medium">내 팀 ▲</span>}
                              </div>
                            </div>

                            {/* 점수 입력 영역 */}
                            {isDone && m.locked_by_participant && (
                              <div className="flex items-center justify-center gap-2 py-2 bg-stone-50 rounded-xl">
                                <span className="text-stone-400 text-sm">✅ 점수 제출 완료</span>
                                <span className="text-stone-500 font-bold text-sm">{m.score}</span>
                              </div>
                            )}
                            {isDone && !m.locked_by_participant && (
                              <div className="text-center py-2 text-xs text-stone-400">경기 완료 — 결과: {m.score || '-'}</div>
                            )}
                            {canInput && (
                              <div className="space-y-2">
                                <p className="text-xs text-stone-400 text-center">점수 입력 후 제출하면 수정할 수 없습니다</p>
                                <div className="flex items-center gap-2">
                                  <input type="text" placeholder="예: 6:4"
                                    value={scores[m.id] || ''}
                                    onChange={e => setScores(prev => ({ ...prev, [m.id]: e.target.value }))}
                                    onKeyDown={e => e.key === 'Enter' && submitScore(m.id)}
                                    className="flex-1 border-2 border-amber-300 rounded-xl px-4 py-3 text-center text-lg font-bold focus:outline-none focus:border-amber-500" />
                                  <button onClick={() => submitScore(m.id)} disabled={submitting === m.id || !scores[m.id]?.trim()}
                                    className="bg-amber-500 text-white font-bold px-5 py-3 rounded-xl hover:bg-amber-600 disabled:opacity-50 transition-all whitespace-nowrap text-sm">
                                    {submitting === m.id ? '...' : '제출'}
                                  </button>
                                </div>
                              </div>
                            )}
                            {!isDone && !isLive && (
                              <div className="text-center py-2 text-xs text-stone-400">⏳ 경기 대기중 — 진행중이 되면 점수 입력 가능</div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

// ────────────────────────────────────────────
// 코트 대기열 슬라이딩 윈도우
// ────────────────────────────────────────────
function CourtQueue({ queue, myMatchId, court }: {
  queue: CourtQueueMatch[]; myMatchId: string; court: string
}) {
  const [expanded, setExpanded] = useState(false)

  const liveIdx = queue.findIndex(m => m.status === 'IN_PROGRESS')
  const pendIdx = queue.findIndex(m => m.status === 'PENDING')
  const curIdx  = liveIdx >= 0 ? liveIdx : pendIdx
  const myIdx   = queue.findIndex(m => m.id === myMatchId)
  const remaining = curIdx >= 0 && myIdx >= 0 ? Math.max(0, myIdx - curIdx) : 0

  const cfg =
    remaining === 0 ? { bg:'bg-red-50',   text:'text-red-700',   emoji:'🔴', label:'지금 내 차례!' } :
    remaining === 1 ? { bg:'bg-amber-50', text:'text-amber-700', emoji:'🟡', label:'다음 경기 — 준비해주세요!' } :
    remaining === 2 ? { bg:'bg-green-50', text:'text-green-700', emoji:'🟢', label:`앞에 ${remaining}경기 남음` } :
                      { bg:'bg-stone-50', text:'text-stone-500', emoji:'⏳', label:`앞에 ${remaining}경기 남음` }

  // 슬라이딩 윈도우: 현재 경기 + 내 경기 사이 접기
  const hiddenBetween = myIdx > curIdx + 1 ? myIdx - curIdx - 1 : 0

  const currentMatch = curIdx >= 0 ? queue[curIdx] : null
  const myMatch      = myIdx >= 0   ? queue[myIdx]  : null

  return (
    <div className={`${cfg.bg} border-b border-stone-100`}>
      {/* 상태 요약 */}
      <div className="px-4 py-2.5">
        <div className="flex items-center justify-between">
          <span className={`text-sm font-bold ${cfg.text}`}>{cfg.emoji} {cfg.label}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">📍 {court}</span>
            <button onClick={() => setExpanded(!expanded)}
              className="text-xs text-stone-400 hover:text-stone-600">
              {expanded ? '접기 ▲' : '전체보기 ▼'}
            </button>
          </div>
        </div>
        {/* 현재 진행 경기 표시 (내 경기가 아닐 때) */}
        {currentMatch && remaining > 0 && (
          <p className="text-xs text-stone-400 mt-0.5">
            현재: {currentMatch.team_a_name} vs {currentMatch.team_b_name} ({currentMatch.division_name})
          </p>
        )}
      </div>

      {/* 전체보기 펼치면 대기열 표시 */}
      {expanded && (
        <div className="px-4 pb-3 space-y-1.5">
          {queue.map((q, i) => {
            const isDone  = q.status === 'FINISHED'
            const isLive  = q.status === 'IN_PROGRESS'
            const isMe    = q.id === myMatchId
            const isCur   = i === curIdx
            const badge   = isLive ? '🔴' : i === curIdx ? '🔴' : i === curIdx + 1 ? '🟡' : i === curIdx + 2 ? '🟢' : ''

            // 완료된 경기 + 내 경기 이전 중간 경기 숨김 처리
            if (isDone) return null  // 완료 경기 숨김
            if (!expanded && i > curIdx && i < myIdx - 1) return null  // 중간 접기

            return (
              <div key={q.id}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${isMe ? 'bg-blue-600 text-white font-bold' : isLive ? 'bg-red-50 border border-red-200' : 'bg-white/70'}`}>
                <span className="text-[11px] w-4">{badge}</span>
                <span className={isMe ? 'text-white/70' : 'text-stone-400'}>#{q.court_order}</span>
                <span className={`flex-1 truncate ${isMe ? 'text-white' : 'text-stone-600'}`}>
                  {q.team_a_name} vs {q.team_b_name}
                </span>
                {isMe && <span className="text-blue-200 text-[10px] flex-shrink-0">← 내 경기</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* 접힌 상태: 현재경기 → [N경기 숨김] → 내 경기 요약 */}
      {!expanded && hiddenBetween > 0 && (
        <div className="px-4 pb-2.5 space-y-1">
          {/* 현재 경기 */}
          {currentMatch && remaining > 0 && !expanded && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-white/70">
              <span className="text-[11px] w-4">🔴</span>
              <span className="text-stone-400">#{currentMatch.court_order}</span>
              <span className="flex-1 truncate text-stone-600">{currentMatch.team_a_name} vs {currentMatch.team_b_name}</span>
            </div>
          )}
          {/* 중간 접기 표시 */}
          <button onClick={() => setExpanded(true)}
            className="w-full text-xs text-stone-400 hover:text-stone-600 py-1 text-center">
            ▸ {hiddenBetween}경기 대기중 (탭하면 전체보기)
          </button>
          {/* 내 경기 */}
          {myMatch && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white font-bold">
              <span className="text-[11px] w-4">📍</span>
              <span className="text-blue-200">#{myMatch.court_order}</span>
              <span className="flex-1 truncate">{myMatch.team_a_name} vs {myMatch.team_b_name}</span>
              <span className="text-blue-200 text-[10px] flex-shrink-0">← 내 경기</span>
            </div>
          )}
        </div>
      )}

      {/* 접힌 상태: 바로 다음 or 현재가 내 경기 */}
      {!expanded && hiddenBetween === 0 && currentMatch && (
        <div className="px-4 pb-2.5 space-y-1">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs ${currentMatch.id === myMatchId ? 'bg-blue-600 text-white font-bold' : 'bg-white/70'}`}>
            <span className="text-[11px] w-4">🔴</span>
            <span className={currentMatch.id === myMatchId ? 'text-blue-200' : 'text-stone-400'}>#{currentMatch.court_order}</span>
            <span className={`flex-1 truncate ${currentMatch.id === myMatchId ? 'text-white' : 'text-stone-600'}`}>{currentMatch.team_a_name} vs {currentMatch.team_b_name}</span>
            {currentMatch.id === myMatchId && <span className="text-blue-200 text-[10px] flex-shrink-0">← 내 경기</span>}
          </div>
          {myMatch && myMatch.id !== currentMatch.id && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white font-bold">
              <span className="text-[11px] w-4">📍</span>
              <span className="text-blue-200">#{myMatch.court_order}</span>
              <span className="flex-1 truncate">{myMatch.team_a_name} vs {myMatch.team_b_name}</span>
              <span className="text-blue-200 text-[10px] flex-shrink-0">← 내 경기</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
