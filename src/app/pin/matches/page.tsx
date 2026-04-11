'use client'
import React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { usePushSubscription } from '@/hooks/usePushSubscription'

interface PinMatch {
  id: string; match_num: string; stage: string; round: string
  court: string | null; court_order: number | null
  status: string; score: string | null; locked_by_participant: boolean
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  my_side: 'A' | 'B'; division_name: string; division_id: string; group_label: string | null
  match_date?: string | null; slot?: number | null
}

interface FinalsMatch {
  id: string; round: string; slot: number | null
  division_id: string; team_a_name: string | null; team_b_name: string | null
  team_a_id: string | null; team_b_id: string | null
  winner_team_id: string | null; status: string
}

interface CourtQueueMatch {
  id: string; court_order: number; status: string
  team_a_name: string; team_b_name: string; division_name: string; division_id: string
}

interface InAppNotif {
  id: number
  title: string
  body: string
}

const ROUND_ORDER: Record<string, number> = {
  group: 0, GROUP: 0,
  R32: 1, R16: 2, QF: 3, SF: 4, F: 5,
  '본선32강': 1, '본선16강': 1, '16강': 2, '8강': 3, '4강': 4, '결승': 5,
}
const ROUND_LABEL: Record<string, string> = {
  group: '예선', GROUP: '예선',
  R32: '32강', R16: '16강', QF: '8강', SF: '4강', F: '결승',
  '본선32강': '32강', '본선16강': '16강', '16강': '16강', '8강': '8강', '4강': '4강', '결승': '결승',
}

const MAX_ERRORS = 3

export default function PinMatchesPage() {
  const router = useRouter()
  const [session, setSession]     = useState<any>(null)
  const [matches, setMatches]     = useState<PinMatch[]>([])
  const [courtQueues, setCourtQueues] = useState<Map<string, CourtQueueMatch[]>>(new Map())
  const [loading, setLoading]     = useState(true)   // 최초 진입 시만 true, loadData finally에서 항상 해제
  const [msg, setMsg]             = useState('')

  const [finalsMatches, setFinalsMatches] = useState<FinalsMatch[]>([])
  const [loserScores, setLoserScores] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState<string | null>(null)

  const [notifAllowed, setNotifAllowed]     = useState(false)
  const [notifRequested, setNotifRequested] = useState(false)
  const prevWaitRef = useRef<Map<string, number>>(new Map())
  const errorCountRef = useRef(0)

  const [inAppNotifs, setInAppNotifs] = useState<InAppNotif[]>([])
  const notifIdRef = useRef(0)

  const { autoResubscribe, subscribeWithPin } = usePushSubscription()

  const showInAppNotif = useCallback((title: string, body: string) => {
    const id = ++notifIdRef.current
    setInAppNotifs(prev => [...prev, { id, title, body }])
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200])
    setTimeout(() => {
      setInAppNotifs(prev => prev.filter(n => n.id !== id))
    }, 5000)
  }, [])

  useEffect(() => {
    let raw = sessionStorage.getItem('pin_session')
    if (!raw) {
      const lsRaw = localStorage.getItem('pin_session')
      if (lsRaw) {
        try {
          const parsed = JSON.parse(lsRaw)
          if (parsed._savedAt && Date.now() - parsed._savedAt < 12 * 60 * 60 * 1000) {
            raw = lsRaw
            sessionStorage.setItem('pin_session', lsRaw)
          } else {
            localStorage.removeItem('pin_session')
          }
        } catch {
          localStorage.removeItem('pin_session')
        }
      }
    }
    if (!raw) { router.replace('/pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadData(s)
    if ('Notification' in window) {
      const perm = Notification.permission
      setNotifAllowed(perm === 'granted')
      setNotifRequested(perm !== 'default')
    }
    autoResubscribe()
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'PUSH_NOTIFICATION') {
        showInAppNotif(event.data.title, event.data.body)
      }
    }
    navigator.serviceWorker.addEventListener('message', handler)
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  }, [showInAppNotif])

  useEffect(() => {
    if (!session) return
    const iv = setInterval(() => loadData(session), 15000)
    return () => clearInterval(iv)
  }, [session])

  const loadData = useCallback(async (s: any) => {
    try {
      const { data, error } = await supabase.rpc('rpc_pin_list_matches', { p_token: s.token })

      if (error) {
        const isAuthError =
          error.code === 'PGRST301' ||
          error.code === '42501' ||
          error.message?.includes('JWT') ||
          error.message?.includes('invalid token')

        if (isAuthError) {
          sessionStorage.removeItem('pin_session')
          router.replace('/pin')
          return
        }

        errorCountRef.current += 1
        console.warn(`[PIN] loadData error (${errorCountRef.current}/${MAX_ERRORS}):`, error.message)

        if (errorCountRef.current >= MAX_ERRORS) {
          sessionStorage.removeItem('pin_session')
          router.replace('/pin')
        }
        return
      }

      errorCountRef.current = 0

      const myMatches: PinMatch[] = data.matches || []
      setMatches(myMatches)

      const courts = [...new Set(myMatches.map(m => m.court).filter(Boolean))] as string[]
      const queueMap = new Map<string, CourtQueueMatch[]>()

      if (courts.length > 0) {
        // 내 경기 ID로 match_date 조회 (RPC가 match_date를 반환 안 하므로)
        const myMatchIds = myMatches.map(m => m.id).filter(Boolean)
        const { data: myMatchDates } = myMatchIds.length > 0
          ? await supabase
              .from('v_matches_with_teams')
              .select('id, court, match_date')
              .in('id', myMatchIds)
          : { data: [] }

        // 코트별로 내 경기의 match_date 매핑
        const courtDateMap: Record<string, string> = {}
        for (const m of (myMatchDates || [])) {
          if (m.court && m.match_date) courtDateMap[m.court] = m.match_date
        }

        // 코트별로 해당 날짜 경기만 조회
        const queueResults = await Promise.all(
          courts.map(async (court) => {
            const myCourtDate = courtDateMap[court]
            let q = supabase
              .from('v_matches_with_teams')
              .select('id, court, court_order, status, score, team_a_name, team_b_name, division_name, division_id, match_date')
              .eq('event_id', s.event_id)
              .eq('court', court)
              .order('court_order')
            if (myCourtDate) q = q.eq('match_date', myCourtDate)
            const { data } = await q
            return { court, matches: (data || []).filter((m: any) => m.score !== 'BYE') }
          })
        )

        const allMatches: any[] = []
        for (const { court, matches } of queueResults) {
          const sorted = [...matches].sort((a: any, b: any) => (a.court_order || 0) - (b.court_order || 0))
          queueMap.set(court, sorted as CourtQueueMatch[])
          allMatches.push(...matches)
        }

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
            if (prev > 1) {
              showInAppNotif('🎾 준비하세요!', `${m.court}에서 다음 경기로 이동해주세요.`)
              sendBrowserNotif(m.court)
            }
          }
          if (m.court) prevWaitRef.current.set(m.court, remaining)
        }
      }

      setCourtQueues(queueMap)

      const eventId = s.event_id
      if (eventId) {
        const [{ data: rawFinals }, { data: viewData }] = await Promise.all([
          supabase.from('matches')
            .select('id, round, slot, division_id, team_a_id, team_b_id, winner_team_id, status')
            .eq('event_id', eventId).eq('stage', 'FINALS')
            .order('slot', { ascending: true, nullsFirst: true }),
          supabase.from('v_matches_with_teams')
            .select('team_a_id, team_b_id, team_a_name, team_b_name')
            .eq('event_id', eventId).eq('stage', 'FINALS')
            .not('team_a_name', 'is', null),
        ])
        const tMap: Record<string, string> = {}
        ;(viewData || []).forEach((m: any) => {
          if (m.team_a_id && m.team_a_name) tMap[m.team_a_id] = m.team_a_name
          if (m.team_b_id && m.team_b_name) tMap[m.team_b_id] = m.team_b_name
        })
        setFinalsMatches((rawFinals || []).map((m: any) => ({
          ...m,
          team_a_name: m.team_a_id ? (tMap[m.team_a_id] || null) : null,
          team_b_name: m.team_b_id ? (tMap[m.team_b_id] || null) : null,
        })) as FinalsMatch[])
      }
    } catch (err) {
      // 예외 발생 시에도 로딩 해제 (네트워크 오류 등)
      console.warn('[PIN] loadData 예외:', err)
    } finally {
      // ✅ 에러/예외/정상 모든 경우에 반드시 로딩 해제
      setLoading(false)
    }
  }, [notifAllowed, showInAppNotif])

  function sendBrowserNotif(court: string) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    new Notification('🎾 준비하세요!', {
      body: `${court}에서 다음 경기로 이동해주세요.`,
      icon: '/icon-192x192.png',
      tag: `court-${court}`,
    })
  }

  async function requestNotification() {
    setNotifRequested(true)
    if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않습니다.'); return }
    try {
      const perm = await Notification.requestPermission()
      setNotifAllowed(perm === 'granted')
      if (perm === 'granted') {
        showInAppNotif('🎾 알림 활성화', '경기 알림이 설정되었습니다.')
        const pin = session?.pin || sessionStorage.getItem('venue_pin') || session?.token
        if (pin) await subscribeWithPin(pin)
        else autoResubscribe()
      } else if (perm === 'denied') {
        alert('알림이 차단되어 있습니다.\n브라우저 설정에서 알림 허용으로 변경해주세요.')
      }
    } catch { setNotifAllowed(false) }
  }

  // ============================================================
  // ✅ 점수 제출 후 조별 완료 체크 → rpc_fill_tournament_slots 호출
  // ============================================================
  async function tryFillTournamentSlots(match: PinMatch) {
    // GROUP 경기가 아니면 skip (대소문자 모두 대응)
    const stageUp = (match.stage || '').toUpperCase()
    const roundUp = (match.round || '').toUpperCase()
    if (stageUp !== 'GROUP' && roundUp !== 'GROUP') return

    const eventId = session?.event_id
    if (!eventId) return

    // 해당 경기의 group_id 조회
    const { data: matchData } = await supabase
      .from('matches')
      .select('group_id, division_id')
      .eq('id', match.id)
      .single()

    if (!matchData?.group_id) return

    // 해당 그룹의 남은 경기 수 확인 (score 컬럼도 조회 → BYE 제외용)
    const { data: groupMatches } = await supabase
      .from('matches')
      .select('id, status, score, stage')
      .eq('event_id', eventId)
      .eq('group_id', matchData.group_id)

    // stage 대소문자 무관 필터 (DB에 'group'/'GROUP' 혼재 가능)
    const groupOnly = (groupMatches || []).filter(m => (m.stage || '').toUpperCase() === 'GROUP')

    // 방금 제출한 경기 포함해서 미완료 경기 수 계산
    // BYE 경기는 status가 FINISHED가 아닐 수 있으므로 제외
    const unfinished = groupOnly.filter(m => m.status !== 'FINISHED' && m.score !== 'BYE')
    if (unfinished.length > 0) return // 아직 남은 경기 있음

    // 본선 브래킷에 TBD 슬롯이 있는지 확인
    // [4] .or() 문법 수정 → 전체 조회 후 클라이언트 필터
    const { data: finalsMatches } = await supabase
      .from('matches')
      .select('id, qualifier_label_a, qualifier_label_b')
      .eq('event_id', eventId)
      .eq('division_id', matchData.division_id)
      .eq('stage', 'FINALS')

    const hasTbd = (finalsMatches || []).some(
      m => m.qualifier_label_a != null || m.qualifier_label_b != null
    )
    if (!hasTbd) return // TBD 슬롯 없음 (브래킷 미생성 or 이미 완료)

    // rpc_fill_tournament_slots 호출
    console.log('[PIN] 조 완료 감지 → rpc_fill_tournament_slots 호출:', matchData.group_id)
    const { data: fillResult, error: fillError } = await supabase.rpc('rpc_fill_tournament_slots', {
      p_event_id: eventId,
      p_group_id: matchData.group_id,
    })

    if (fillError) {
      console.warn('[PIN] fill_tournament_slots 오류:', fillError.message)
      return
    }

    if (fillResult?.success && fillResult.filled > 0) {
      console.log('[PIN] 슬롯 채우기 완료:', fillResult)
    }
  }

  async function submitScore(matchId: string, match: PinMatch) {
    // ✅ 본인 팀이 항상 승자 — my_side 직접 사용
    const winner = match.my_side
    const loser  = loserScores[matchId]?.trim()
    if (!loser)  { setMsg('상대팀 점수를 입력해주세요. (예: 4)'); return }
    if (!/^\d+$/.test(loser)) { setMsg('숫자만 입력해주세요.'); return }
    const score = winner === 'A' ? `6:${loser}` : `${loser}:6`
    setSubmitting(matchId); setMsg('')

    const { error } = await supabase.rpc('rpc_pin_submit_score', {
      p_token: session.token, p_match_id: matchId, p_score: score,
    })
    setSubmitting(null)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 점수가 제출되었습니다!')

    // ✅ 본선 TBD 슬롯 자동 채우기 시도 (조별 경기인 경우)
    await tryFillTournamentSlots(match)

    // ✅ 점수 제출 후 다음 대기팀에게 Web Push 발송
    if (match.court) {
      fetch('/api/notify/court', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: session.event_id,
          court: match.court,
          finished_match_id: matchId,        // 방금 끝난 경기 ID (다음 순서 찾기용)
          match_date: match.match_date || null, // 날짜 필터용
          trigger: 'finished',
        }),
      }).catch(() => {})
    }

    loadData(session)
  }

  function handleLogout() {
    sessionStorage.removeItem('pin_session')
    sessionStorage.removeItem('venue_pin')
    sessionStorage.removeItem('pin_event_id')
    localStorage.removeItem('pin_session')
    router.replace('/pin')
  }

  function NotifButton() {
    if (notifAllowed) {
      return (
        <button
          onClick={() => { autoResubscribe(); showInAppNotif('🎾 알림 테스트', '알림이 정상적으로 동작하고 있습니다.') }}
          className="text-xs text-white/60 hover:text-white/90 flex items-center gap-1"
          title="알림 확인"
        >
          🔔 알림 확인
        </button>
      )
    }
    if (notifRequested && !notifAllowed) {
      return (
        <button
          onClick={() => alert('알림이 차단되어 있습니다.\n브라우저 설정 → 알림 허용으로 변경해주세요.')}
          className="text-xs bg-red-500/80 text-white px-2.5 py-1 rounded-full"
        >
          🔕 알림 차단됨
        </button>
      )
    }
    return (
      <button
        onClick={requestNotification}
        className="text-xs bg-amber-500 text-white px-2.5 py-1 rounded-full animate-pulse"
      >
        🔔 알림 허용
      </button>
    )
  }

  const byRound = matches.reduce<Record<string, PinMatch[]>>((acc, m) => {
    const key = m.round || 'group'
    if (!acc[key]) acc[key] = []
    acc[key].push(m)
    return acc
  }, {})
  const sortedRounds = Object.keys(byRound).sort((a, b) => (ROUND_ORDER[a] ?? 9) - (ROUND_ORDER[b] ?? 9))

  // 상단 헤더: 본인 이름 + 부서별 파트너 추출
  // team_name 형식: "신승배/홍길동" — '/' 앞이 본인(player1), 뒤가 파트너
  const divPartners: { division: string; partner: string }[] = []
  const seenDivs = new Set<string>()
  let myName = session?.team_name || ''
  for (const m of matches) {
    const teamName = m.my_side === 'A' ? m.team_a_name : m.team_b_name
    if (!teamName || seenDivs.has(m.division_id)) continue
    seenDivs.add(m.division_id)
    const parts = teamName.split('/')
    if (parts.length >= 2) {
      myName = parts[0].trim()           // 첫 번째 경기 기준 본인 이름 확정
      const partner = parts.slice(1).join('/').trim()
      divPartners.push({ division: m.division_name, partner })
    } else {
      divPartners.push({ division: m.division_name, partner: '' })
    }
  }

  return (
    <div className="min-h-screen bg-stone-50">
      {/* 인앱 알림 배너 */}
      <div className="fixed top-0 left-0 right-0 z-50 pointer-events-none">
        <div className="max-w-2xl mx-auto px-4 pt-2 space-y-2">
          {inAppNotifs.map(n => (
            <div key={n.id}
              className="pointer-events-auto bg-[#2d5016] text-white rounded-2xl shadow-2xl px-4 py-3 flex items-start gap-3 animate-slideDown">
              <span className="text-2xl flex-shrink-0">🎾</span>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm">{n.title}</div>
                <div className="text-xs text-white/80 mt-0.5">{n.body}</div>
              </div>
              <button
                onClick={() => setInAppNotifs(prev => prev.filter(x => x.id !== n.id))}
                className="text-white/60 hover:text-white text-lg leading-none flex-shrink-0">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <header className="bg-[#2d5016] text-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <div className="font-bold text-base">{myName || session?.team_name}</div>
            {divPartners.length > 0 ? (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                {divPartners.map(({ division, partner }) => (
                  <span key={division} className="text-xs text-white/70">
                    <span className="text-white/50">{division}</span>
                    {partner ? <span className="text-white/90"> · /{partner}</span> : null}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-white/60">{session?.division} · 내 경기</div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <NotifButton />
            <button onClick={handleLogout} className="text-xs text-white/50 hover:text-white/80">로그아웃</button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5">
        {msg && (
          <div className={`mb-4 px-4 py-2.5 rounded-xl text-sm font-medium ${
            msg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {msg}
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-stone-400">불러오는 중...</div>
        ) : matches.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🎾</div>
            <p className="text-stone-500">예정된 경기가 없습니다</p>
            <p className="text-stone-400 text-sm mt-1">모든 경기가 완료됐거나 아직 배정 전입니다</p>
          </div>
        ) : (
          <div className="space-y-6">
            {sortedRounds.map(round => (
              <section key={round}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1 h-5 bg-[#2d5016] rounded-full" />
                  <h2 className="text-sm font-bold text-stone-700">{ROUND_LABEL[round] || round}</h2>
                </div>
                <div className="space-y-3">
                  {byRound[round].map(m => {
                    const isLive   = m.status === 'IN_PROGRESS'
                    const isDone   = m.status === 'FINISHED'
                    const canInput = isLive && !m.locked_by_participant
                    const queue    = m.court ? courtQueues.get(m.court) || [] : []
                    const showQueue = m.court && queue.length > 0 && !isDone
                    const loser    = loserScores[m.id] || ''

                    return (
                      <div key={m.id} className={`bg-white rounded-2xl border overflow-hidden shadow-sm ${isLive ? 'border-red-200' : 'border-stone-200'}`}>
                        {showQueue && (
                          <CourtQueue queue={queue} myMatchId={m.id} court={m.court!} />
                        )}

                        <div className="p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs text-stone-400">{m.match_num}</span>
                              <span className="text-xs px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">{m.division_name}</span>
                              {m.group_label && <span className="text-xs text-stone-400">{m.group_label}</span>}
                            </div>
                            {m.court ? (
                              <span className="text-xs px-2.5 py-0.5 rounded-full bg-[#2d5016]/10 text-[#2d5016] font-bold">
                                🎾 {m.court}
                              </span>
                            ) : (
                              <span className="text-xs text-stone-400">코트 미배정</span>
                            )}
                          </div>

                          <div className="flex items-center justify-center gap-3 mb-4">
                            <div className={`text-center flex-1 ${m.my_side === 'A' ? 'font-bold' : ''}`}>
                              <PinTeamName name={m.team_a_name} isMy={m.my_side === 'A'}
                                finalsMatches={finalsMatches} matchId={m.id} abSlot="A" />
                            </div>
                            <div className="px-2 text-center">
                              {isDone && m.score ? (
                                <span className="text-lg font-black text-stone-700">{m.score}</span>
                              ) : isLive ? (
                                <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-0.5 rounded-full">진행中</span>
                              ) : (
                                <span className="text-stone-300 font-bold text-sm">VS</span>
                              )}
                            </div>
                            <div className={`text-center flex-1 ${m.my_side === 'B' ? 'font-bold' : ''}`}>
                              <PinTeamName name={m.team_b_name} isMy={m.my_side === 'B'}
                                finalsMatches={finalsMatches} matchId={m.id} abSlot="B" />
                            </div>
                          </div>

                          {isDone && m.locked_by_participant && (
                            <div className="flex items-center justify-center gap-2 py-2.5 bg-stone-50 rounded-xl">
                              <span className="text-stone-400 text-sm">✅ 점수 제출 완료</span>
                              <span className="text-stone-700 font-bold text-sm">{m.score}</span>
                            </div>
                          )}
                          {isDone && !m.locked_by_participant && (
                            <div className="text-center py-2 text-xs text-stone-400">경기 완료 · 결과: {m.score || '-'}</div>
                          )}

                          {canInput && (() => {
                            // ✅ 본인 팀이 항상 승자 — 승자 선택 버튼 없음
                            const myTeamName = m.my_side === 'A' ? m.team_a_name : m.team_b_name
                            const oppTeamName = m.my_side === 'A' ? m.team_b_name : m.team_a_name
                            return (
                              <div className="space-y-3 pt-1">
                                {/* 승자 고정 표시 */}
                                <div className="flex items-center justify-center gap-2 py-2.5 bg-[#2d5016]/10 rounded-xl border border-[#2d5016]/20">
                                  <span className="text-lg">🏆</span>
                                  <span className="text-sm font-bold text-[#2d5016]">{myTeamName}</span>
                                  <span className="text-xs text-stone-400">승리로 제출됩니다</span>
                                </div>
                                {/* 패자 점수 입력 */}
                                <div className="bg-stone-50 rounded-xl p-3">
                                  <div className="flex items-center justify-center gap-3 mb-3">
                                    <span className="text-sm font-bold text-[#2d5016]">{myTeamName}</span>
                                    <span className="text-xl font-black text-stone-700">6 : {loser || '?'}</span>
                                    <span className="text-sm font-bold text-stone-400">{oppTeamName}</span>
                                  </div>
                                  <p className="text-xs text-stone-400 text-center mb-2">상대팀 점수 입력 (내 팀은 항상 6)</p>
                                  <div className="flex gap-2">
                                    <input
                                      type="number" inputMode="numeric" min="0" max="5" placeholder="0~5"
                                      value={loser}
                                      onChange={e => setLoserScores(prev => ({ ...prev, [m.id]: e.target.value }))}
                                      onKeyDown={e => e.key === 'Enter' && submitScore(m.id, m)}
                                      className="flex-1 border-2 border-amber-300 rounded-xl px-4 py-3 text-center text-2xl font-bold focus:outline-none focus:border-amber-500"
                                    />
                                    <button
                                      onClick={() => submitScore(m.id, m)}
                                      disabled={submitting === m.id || !loser.trim()}
                                      className="bg-amber-500 text-white font-bold px-6 py-3 rounded-xl hover:bg-amber-600 disabled:opacity-50 transition-all whitespace-nowrap text-sm"
                                    >
                                      {submitting === m.id ? '...' : '제출'}
                                    </button>
                                  </div>
                                  {loser && (
                                    <div className="mt-2 text-center text-xs text-stone-500">
                                      최종 점수: <span className="font-bold text-stone-700">6:{loser}</span>
                                      &nbsp;· <span className="text-[#2d5016] font-medium">{myTeamName}</span> 승리
                                    </div>
                                  )}
                                </div>
                                <p className="text-xs text-stone-400 text-center">
                                  <span className="text-amber-600 font-medium">점수 제출 후 수정 불가</span>
                                </p>
                              </div>
                            )
                          })()}

                          {!isDone && !isLive && (
                            <div className="text-center py-2 text-xs text-stone-400">
                              ⏳ 경기 대기 중 · 진행中이 되면 점수 입력 가능
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

// TBD 후보 계산 (본선 브래킷용)
function getTbdCandidates(finalsMatches: FinalsMatch[], matchId: string, abSlot: 'A' | 'B'): string[] {
  const PREV: Record<string, string> = {
    '결승': '4강', '4강': '8강', '8강': '16강', '16강': '32강', '32강': '64강', '64강': '128강',
    'F': 'SF', 'SF': 'QF', 'QF': 'R16', 'R16': 'R32', 'R32': 'R64', 'R64': 'R128',
  }
  const cur = finalsMatches.find(m => m.id === matchId)
  if (!cur) return []
  const prevRound = PREV[cur.round]
  if (!prevRound) return []
  const curList = finalsMatches
    .filter(m => m.division_id === cur.division_id && m.round === cur.round)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const myLocalIdx = curList.findIndex(m => m.id === matchId)
  if (myLocalIdx < 0) return []
  const prevList = finalsMatches
    .filter(m => m.division_id === cur.division_id && m.round === prevRound)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const pm = abSlot === 'A' ? prevList[myLocalIdx * 2] : prevList[myLocalIdx * 2 + 1]
  if (!pm) return []
  const strip = (raw: string) => raw.split('/').map(p => p.replace(/\(.*?\)/g, '').trim()).join('/')
  if (pm.status === 'FINISHED' && pm.winner_team_id) {
    const w = pm.winner_team_id === pm.team_a_id ? pm.team_a_name : pm.team_b_name
    return w && w !== 'TBD' ? [strip(w)] : []
  }
  const names: string[] = []
  if (pm.team_a_name && pm.team_a_name !== 'TBD') names.push(strip(pm.team_a_name))
  if (pm.team_b_name && pm.team_b_name !== 'TBD') names.push(strip(pm.team_b_name))
  return names
}

function PinTeamName({ name, isMy, finalsMatches, matchId, abSlot }: {
  name: string; isMy: boolean
  finalsMatches: FinalsMatch[]; matchId: string; abSlot: 'A' | 'B'
}) {
  const isTbd = !name || name === 'TBD'
  if (isTbd) {
    const candidates = getTbdCandidates(finalsMatches, matchId, abSlot)
    return (
      <div>
        {candidates.length > 0 ? (
          <div className="text-xs text-stone-400 leading-tight">
            {candidates.map((c, i) => (
              <span key={i}>{i > 0 && <span className="text-stone-200"> / </span>}{c}</span>
            ))}
          </div>
        ) : (
          <div className="text-sm text-stone-300 italic">TBD</div>
        )}
      </div>
    )
  }
  return (
    <div>
      <div className={`text-sm ${isMy ? 'text-[#2d5016]' : 'text-stone-700'}`}>{name}</div>
      {isMy && <span className="text-xs text-[#2d5016]/70 font-medium">← 내 팀</span>}
    </div>
  )
}

function FinishedQueue({ items }: { items: CourtQueueMatch[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-stone-100 pt-1.5 mt-0.5">
      <button onClick={() => setOpen(!open)}
        className="text-xs text-stone-400 hover:text-stone-600 flex items-center gap-1 w-full">
        <span>{open ? '▲' : '▼'}</span>
        <span>완료 {items.length}경기</span>
      </button>
      {open && (
        <div className="space-y-1 mt-1.5">
          {items.map(q => (
            <div key={q.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-stone-300">
              <span className="w-4">✓</span>
              <span className="flex-1 truncate line-through">{q.team_a_name} vs {q.team_b_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CourtQueue({ queue, myMatchId, court }: {
  queue: CourtQueueMatch[]; myMatchId: string; court: string
}) {
  const [expanded, setExpanded] = useState(false)

  const liveIdx = queue.findIndex(m => m.status === 'IN_PROGRESS')
  const pendIdx = queue.findIndex(m => m.status === 'PENDING')
  const curIdx  = liveIdx >= 0 ? liveIdx : pendIdx
  const myIdx   = queue.findIndex(m => m.id === myMatchId)
  const remaining = curIdx >= 0 && myIdx >= 0 ? Math.max(0, myIdx - curIdx) : 0

  const iAmLive = liveIdx >= 0 && myIdx === liveIdx
  const cfg =
    iAmLive         ? { bg: 'bg-red-50',   text: 'text-red-700',   emoji: '🟥', label: '지금 경기 中!' } :
    remaining === 0 && liveIdx < 0
                    ? { bg: 'bg-red-50',   text: 'text-red-700',   emoji: '🟥', label: '지금 바로 이동!' } :
    remaining === 0 && liveIdx >= 0
                    ? { bg: 'bg-amber-50', text: 'text-amber-700', emoji: '🟨', label: '다음 경기 준비해주세요!' } :
    remaining === 1 ? { bg: 'bg-amber-50', text: 'text-amber-700', emoji: '🟨', label: '다음 경기 준비해주세요!' } :
    remaining === 2 ? { bg: 'bg-green-50', text: 'text-green-700', emoji: '🟩', label: `앞에 ${remaining}경기 남음` } :
                     { bg: 'bg-stone-50', text: 'text-stone-500',  emoji: '⬜', label: `앞에 ${remaining}경기 남음` }

  const currentMatch = curIdx >= 0 && !iAmLive ? queue[curIdx] : null

  return (
    <div className={`${cfg.bg} border-b border-stone-100`}>
      <div className="px-4 py-2.5">
        <div className="flex items-center justify-between">
          <span className={`text-sm font-bold ${cfg.text}`}>{cfg.emoji} {cfg.label}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">🎾 {court}</span>
            <button onClick={() => setExpanded(!expanded)} className="text-xs text-stone-400 hover:text-stone-600">
              {expanded ? '접기 ▲' : '펼치기 ▼'}
            </button>
          </div>
        </div>
        {currentMatch && remaining > 0 && (
          <p className="text-xs text-stone-400 mt-0.5">
            현재: {currentMatch.team_a_name} vs {currentMatch.team_b_name} ({currentMatch.division_name})
          </p>
        )}
      </div>

      {expanded && (
        <div className="px-4 pb-3 space-y-1.5">
          {queue.filter(q => q.status !== 'FINISHED').map((q, i) => {
            const isLive = q.status === 'IN_PROGRESS'
            const isMe   = q.id === myMatchId
            const origIdx = queue.indexOf(q)
            const badge  = isLive ? '🟥' : origIdx === curIdx ? '🟥' : origIdx === curIdx + 1 ? '🟨' : origIdx === curIdx + 2 ? '🟩' : ''
            return (
              <div key={q.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs ${
                isMe   ? 'bg-blue-50 text-blue-700 font-bold border border-blue-200' :
                isLive ? 'bg-red-50 text-red-700' :
                         'text-stone-500'
              }`}>
                <span className="w-4">{badge}</span>
                <span className="flex-1 truncate">{q.team_a_name} vs {q.team_b_name}</span>
                {isMe && <span className="text-blue-500 flex-shrink-0 font-bold">← 내 경기</span>}
              </div>
            )
          })}
          {queue.filter(q => q.status === 'FINISHED').length > 0 && (
            <FinishedQueue items={queue.filter(q => q.status === 'FINISHED')} />
          )}
        </div>
      )}
    </div>
  )
}
