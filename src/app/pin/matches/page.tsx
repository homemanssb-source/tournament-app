'use client'
// ============================================================
// src/app/pin/matches/page.tsx
// ✅ 알림 자동 재구독 (앱 재실행 시 구독 유효성 체크)
// ✅ 알림 상태 표시 개선 — 꺼짐/켜짐/재시도 버튼
// ✅ 30초 자동갱신 유지
// ============================================================
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { usePushSubscription } from '@/hooks/usePushSubscription'

interface PinMatch {
  id: string
  match_num: string
  stage: string
  round: string
  court: string | null
  status: string
  score: string | null
  team_a_name: string
  team_b_name: string
  winner_name: string | null
  division_name: string
  started_at: string | null
  ended_at: string | null
}

interface PinTie {
  id: string
  tie_order: number
  round: string | null
  status: string
  court_number: number | null
  club_a_rubbers_won: number
  club_b_rubbers_won: number
  club_a?: { name: string }
  club_b?: { name: string }
  started_at: string | null
  ended_at: string | null
}

export default function PinMatchesPage() {
  const router = useRouter()
  const [matches, setMatches]         = useState<PinMatch[]>([])
  const [ties, setTies]               = useState<PinTie[]>([])
  const [loading, setLoading]         = useState(true)
  const [tab, setTab]                 = useState<'individual' | 'team'>('individual')
  const [courtFilter, setCourtFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('IN_PROGRESS')
  const prevMatchIds = useRef<Set<string>>(new Set())

  // ── 브라우저 Notification 상태 ─────────────────────────────
  const [notifAllowed, setNotifAllowed]     = useState(false)
  const [notifRequested, setNotifRequested] = useState(false)

  // ── Web Push 자동 재구독 ────────────────────────────────────
  const { autoResubscribe } = usePushSubscription()

  // ── PIN 검증 + 초기화 ──────────────────────────────────────
  useEffect(() => {
    const pin     = sessionStorage.getItem('venue_pin')
    const eventId = sessionStorage.getItem('pin_event_id')
    if (!pin || !eventId) { router.replace('/pin'); return }
    loadData()

    // 브라우저 알림 권한 상태 초기화
    if ('Notification' in window) {
      const perm = Notification.permission
      setNotifAllowed(perm === 'granted')
      setNotifRequested(perm !== 'default')
    }

    // ✅ Web Push 자동 재구독 (백그라운드에서 조용히 처리)
    autoResubscribe()
  }, [])

  // ── 브라우저 알림 권한 요청 ────────────────────────────────
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
        new Notification('제주 테니스 토너먼트', {
          body: '경기 알림이 활성화되었습니다.',
          icon: '/icon.png',
        })
        // ✅ 권한 허용되면 Web Push 재구독도 같이 시도
        autoResubscribe()
      } else if (perm === 'denied') {
        alert('알림이 차단되어 있습니다.\n브라우저 설정 → 이 사이트 → 알림 허용으로 변경해주세요.')
      }
    } catch {
      setNotifAllowed(false)
    }
  }

  // ── 알림 발송 (경기 완료 감지 시) ─────────────────────────
  function sendNotification(title: string, body: string) {
    if (!('Notification' in window)) return
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/icon.png', silent: false })
    }
  }

  // ── 데이터 로드 ────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const eventId = sessionStorage.getItem('pin_event_id')
    if (!eventId) return
    setLoading(true)
    try {
      const [matchRes, tieRes] = await Promise.all([
        supabase.from('v_matches_with_teams').select('*')
          .eq('event_id', eventId)
          .not('court', 'is', null)
          .order('court').order('match_num'),
        supabase.from('ties')
          .select('*, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)')
          .eq('event_id', eventId)
          .not('court_number', 'is', null)
          .order('tie_order'),
      ])

      const newMatches: PinMatch[] = (matchRes.data || []).map((m: any) => ({
        id: m.id, match_num: m.match_num, stage: m.stage, round: m.round,
        court: m.court, status: m.status, score: m.score,
        team_a_name: m.team_a_name, team_b_name: m.team_b_name,
        winner_name: m.winner_name, division_name: m.division_name,
        started_at: m.started_at, ended_at: m.ended_at,
      }))

      // ✅ 새로 완료된 경기 감지 → 브라우저 알림 발송
      // (최초 로드 시에는 prevMatchIds가 비어있으므로 알림 안 보냄)
      if (prevMatchIds.current.size > 0) {
        newMatches.forEach(m => {
          if (m.status === 'FINISHED' && !prevMatchIds.current.has(m.id)) {
            sendNotification(
              `경기 완료 — ${m.court}`,
              `${m.team_a_name} vs ${m.team_b_name}  ${m.score || ''}`,
            )
          }
        })
      }
      prevMatchIds.current = new Set(
        newMatches.filter(m => m.status === 'FINISHED').map(m => m.id)
      )

      setMatches(newMatches)
      setTies(tieRes.data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  // ── 30초 자동 갱신 ─────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => loadData(), 30000)
    return () => clearInterval(interval)
  }, [loadData])

  useEffect(() => { loadData() }, [loadData])

  // ── 유틸 ───────────────────────────────────────────────────
  function formatDuration(start: string, end?: string | null): string {
    const from = new Date(start).getTime()
    const to   = end ? new Date(end).getTime() : Date.now()
    const mins = Math.round((to - from) / 60000)
    if (mins < 60) return `${mins}분`
    return `${Math.floor(mins / 60)}시간 ${mins % 60}분`
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }

  const courts = [...new Set(matches.map(m => m.court).filter(Boolean))]

  const filteredMatches = matches.filter(m => {
    if (courtFilter !== 'ALL' && m.court !== courtFilter) return false
    if (statusFilter !== 'ALL' && m.status !== statusFilter) return false
    return true
  })

  const filteredTies = ties.filter(t => {
    if (statusFilter === 'IN_PROGRESS' && t.status !== 'in_progress') return false
    if (statusFilter === 'FINISHED'    && t.status !== 'completed')    return false
    return true
  })

  // ── 알림 버튼 렌더링 ───────────────────────────────────────
  function NotifButton() {
    // 이미 허용된 경우
    if (notifAllowed) {
      return (
        <button
          onClick={() => {
            // 재시도: 한번 더 재구독 시도
            autoResubscribe()
            sendNotification('알림 테스트', '알림이 정상 작동 중입니다.')
          }}
          className="text-xs text-white/60 hover:text-white/90 flex items-center gap-1"
          title="알림 켜짐 — 탭하면 테스트 알림 발송"
        >
          🔔 알림 켜짐
        </button>
      )
    }

    // 거부된 경우
    if (notifRequested && !notifAllowed) {
      return (
        <button
          onClick={() => alert('알림이 차단되어 있습니다.\n브라우저 설정 → 이 사이트 → 알림 허용으로 변경해주세요.')}
          className="text-xs bg-red-500/80 text-white px-2.5 py-1 rounded-full"
        >
          🔕 알림 차단됨
        </button>
      )
    }

    // 아직 요청 안 한 경우
    return (
      <button
        onClick={requestNotification}
        className="text-xs bg-yellow-500 text-white px-2.5 py-1 rounded-full animate-pulse"
      >
        🔔 알림 켜기
      </button>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-[#2d5016] text-white sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-bold">경기 현황</h1>
              <p className="text-xs text-white/60">30초 자동 갱신</p>
            </div>
            <div className="flex items-center gap-2">
              <NotifButton />
              <button onClick={loadData} className="text-xs bg-white/20 px-2.5 py-1 rounded-full">
                🔄
              </button>
            </div>
          </div>

          {/* 탭 */}
          <div className="flex gap-2 mt-3 border-t border-white/10 pt-3">
            <button
              onClick={() => setTab('individual')}
              className={`px-4 py-1.5 rounded-full text-sm font-medium ${tab === 'individual' ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'}`}
            >
              🎾 개인전
            </button>
            <button
              onClick={() => setTab('team')}
              className={`px-4 py-1.5 rounded-full text-sm font-medium ${tab === 'team' ? 'bg-white text-[#2d5016]' : 'bg-white/20 text-white/80'}`}
            >
              🏆 단체전
            </button>
          </div>

          {/* 필터 */}
          <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="text-xs bg-white/10 text-white border-0 rounded px-2 py-1"
            >
              <option value="ALL">전체 상태</option>
              <option value="IN_PROGRESS">진행중</option>
              <option value="FINISHED">완료</option>
            </select>
            {tab === 'individual' && courts.length > 0 && (
              <select
                value={courtFilter}
                onChange={e => setCourtFilter(e.target.value)}
                className="text-xs bg-white/10 text-white border-0 rounded px-2 py-1"
              >
                <option value="ALL">전체 코트</option>
                {courts.map(c => <option key={c} value={c!}>{c}</option>)}
              </select>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-4 space-y-3">
        {loading ? (
          <p className="text-center py-10 text-gray-400">불러오는 중...</p>
        ) : tab === 'individual' ? (
          filteredMatches.length === 0 ? (
            <p className="text-center py-10 text-gray-400">경기가 없습니다.</p>
          ) : (
            filteredMatches.map(m => (
              <MatchCard key={m.id} match={m} formatTime={formatTime} formatDuration={formatDuration} />
            ))
          )
        ) : (
          filteredTies.length === 0 ? (
            <p className="text-center py-10 text-gray-400">단체전이 없습니다.</p>
          ) : (
            filteredTies.map(t => (
              <TieCard key={t.id} tie={t} formatTime={formatTime} formatDuration={formatDuration} />
            ))
          )
        )}
      </main>
    </div>
  )
}

// ── MatchCard ─────────────────────────────────────────────────
function MatchCard({ match: m, formatTime, formatDuration }: {
  match: PinMatch
  formatTime: (s: string) => string
  formatDuration: (s: string, e?: string | null) => string
}) {
  const isLive = m.status === 'IN_PROGRESS'
  const isDone = m.status === 'FINISHED'

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${isLive ? 'border-red-300 shadow-red-100' : isDone ? 'opacity-70' : ''}`}>
      {isLive && (
        <div className="bg-red-500 text-white px-4 py-1.5 flex items-center gap-2 text-xs font-bold">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          LIVE
          {m.started_at && <span className="ml-auto font-normal">{formatDuration(m.started_at)} 경과</span>}
        </div>
      )}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className={`px-2 py-0.5 rounded font-medium ${isLive ? 'bg-red-100 text-red-700' : isDone ? 'bg-green-100 text-green-700' : 'bg-gray-100'}`}>
              {m.court}
            </span>
            <span>{m.division_name}</span>
          </div>
          {isDone && m.ended_at && (
            <span className="text-xs text-gray-400">
              종료 {formatTime(m.ended_at)}
              {m.started_at && ` (${formatDuration(m.started_at, m.ended_at)})`}
            </span>
          )}
          {!isDone && m.started_at && (
            <span className="text-xs text-gray-400">시작 {formatTime(m.started_at)}</span>
          )}
        </div>
        <div className="flex items-center">
          <div className={`flex-1 font-medium ${m.winner_name === m.team_a_name ? 'text-green-700 font-bold' : ''}`}>
            {m.team_a_name}
          </div>
          <div className="px-4 text-center">
            {isDone && m.score ? (
              <span className="text-xl font-black">{m.score}</span>
            ) : isLive ? (
              <span className="text-sm font-bold text-red-500">진행중</span>
            ) : (
              <span className="text-sm text-gray-400">vs</span>
            )}
          </div>
          <div className={`flex-1 text-right font-medium ${m.winner_name === m.team_b_name ? 'text-green-700 font-bold' : ''}`}>
            {m.team_b_name}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── TieCard ───────────────────────────────────────────────────
function TieCard({ tie: t, formatTime, formatDuration }: {
  tie: PinTie
  formatTime: (s: string) => string
  formatDuration: (s: string, e?: string | null) => string
}) {
  const isLive = t.status === 'in_progress'
  const isDone = t.status === 'completed'

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${isLive ? 'border-red-300 shadow-red-100' : isDone ? 'opacity-70' : ''}`}>
      {isLive && (
        <div className="bg-red-500 text-white px-4 py-1.5 flex items-center gap-2 text-xs font-bold">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          LIVE
          {t.started_at && <span className="ml-auto font-normal">{formatDuration(t.started_at)} 경과</span>}
        </div>
      )}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            {t.court_number && (
              <span className={`px-2 py-0.5 rounded font-medium ${isLive ? 'bg-red-100 text-red-700' : isDone ? 'bg-green-100 text-green-700' : 'bg-gray-100'}`}>
                코트 {t.court_number}
              </span>
            )}
            <span>단체전 #{t.tie_order}</span>
          </div>
          {isDone && t.ended_at && (
            <span className="text-xs text-gray-400">
              종료 {formatTime(t.ended_at)}
              {t.started_at && ` (${formatDuration(t.started_at, t.ended_at)})`}
            </span>
          )}
        </div>
        <div className="flex items-center">
          <div className="flex-1 font-medium">{t.club_a?.name || 'TBD'}</div>
          <div className="px-4 text-center">
            {isDone || isLive ? (
              <span className={`text-xl font-black ${isLive ? 'text-red-600' : ''}`}>
                {t.club_a_rubbers_won} - {t.club_b_rubbers_won}
              </span>
            ) : (
              <span className="text-sm text-gray-400">vs</span>
            )}
          </div>
          <div className="flex-1 text-right font-medium">{t.club_b?.name || 'TBD'}</div>
        </div>
      </div>
    </div>
  )
}