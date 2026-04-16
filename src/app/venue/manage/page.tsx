'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

// ──────────────────────────────────────────────────────────
// 현장관리: 조회 + 시작 + 점수입력 + 코트 배정/재배정/자동배정
// (자기 경기장 코트에 한해서만 배정 가능)
// ──────────────────────────────────────────────────────────

interface VenueMatch {
  id: string; match_num: string; stage: string; round: string
  court: string | null; court_order: number | null
  status: string; score: string | null; locked_by_participant: boolean
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  winner_team_id: string | null; division_name: string; division_id: string
  is_team_tie?: boolean
}

export default function VenueManagePage() {
  const router = useRouter()
  const [session, setSession]       = useState<any>(null)
  const [matches, setMatches]       = useState<VenueMatch[]>([])
  const [loading, setLoading]       = useState(true)
  const [msg, setMsg]               = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [filterDiv, setFilterDiv]   = useState('ALL')

  const [editMatch, setEditMatch]   = useState<VenueMatch | null>(null)
  const [editScore, setEditScore]   = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)

  // ── 코트 배정 ──
  const [allVenueCourtNames, setAllVenueCourtNames] = useState<string[]>([])
  const [assigning, setAssigning] = useState(false)
  const [assignMsg, setAssignMsg] = useState('')
  const [filterRound, setFilterRound] = useState<string>('ALL')

  // ── 세션 로드
  useEffect(() => {
    const raw = sessionStorage.getItem('venue_session')
    if (!raw) { router.push('/venue'); return }
    const s = JSON.parse(raw)
    setSession(s)
    // 전체 경기장의 코트 이름 배열 (단체전 court_number 글로벌 인덱스 계산용)
    // ✅ dashboard/courts와 동일한 fallback 순서: short_name || name (리터럴 '코트'는 최후)
    if (s?.event_id) {
      supabase.from('venues')
        .select('name, short_name, courts, court_count')
        .eq('event_id', s.event_id)
        .order('created_at')
        .then(({ data }) => {
          const names: string[] = (data || []).flatMap((v: any) => {
            const sn = (v.short_name?.trim() || v.name?.trim() || '코트')
            const count = v.court_count || v.courts?.length || 0
            return Array.from({ length: count }, (_, i) => `${sn}-${i + 1}`)
          })
          setAllVenueCourtNames(names)
        })
    }
  }, [router])

  // 단체전 상태 → 개인전 상태 규칙 (UI 필터가 UPPERCASE 기준이라 통일)
  //   pending, lineup_phase, lineup_ready → PENDING
  //   in_progress                         → IN_PROGRESS
  //   completed, bye                      → FINISHED
  function normalizeStatus(s: string | null | undefined): string {
    const v = (s || '').toLowerCase()
    if (v === 'in_progress') return 'IN_PROGRESS'
    if (v === 'completed' || v === 'bye') return 'FINISHED'
    if (v === 'pending' || v === 'lineup_phase' || v === 'lineup_ready') return 'PENDING'
    // 이미 대문자거나 정의되지 않은 값은 그대로 (FINISHED, IN_PROGRESS, PENDING 등)
    return s ? s.toUpperCase() : 'PENDING'
  }

  // ── 데이터 로드 (15초 폴링) ── [FIX V1] finally로 setLoading 보장
  const loadData = useCallback(async () => {
    if (!session) return
    try {
      const { data, error } = await supabase.rpc('rpc_venue_list_matches', { p_token: session.token })
      if (error) {
        sessionStorage.removeItem('venue_session')
        router.push('/venue')
        return
      }
      const individual: VenueMatch[] = (data.matches || []).map((m: any) => ({
        ...m, is_team_tie: false,
        status: normalizeStatus(m.status),
      }))
      const ties: VenueMatch[] = (data.ties || []).map((t: any) => ({
        ...t, is_team_tie: true,
        status: normalizeStatus(t.status),
      }))
      setMatches([...individual, ...ties])
      setLastUpdate(new Date())
    } finally {
      setLoading(false)
    }
  }, [session, router])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => {
    if (!session) return
    const interval = setInterval(loadData, 15000)
    return () => clearInterval(interval)
  }, [session, loadData])

  // ── 파생 데이터
  const divisionNames = Array.from(new Set(matches.map(m => m.division_name).filter(Boolean)))

  // 코트 목록: session.courts 기준, 실제 배정된 court로 보완
  const sessionCourts: string[] = session?.courts || []
  const assignedCourtSet = new Set(matches.map(m => m.court).filter(Boolean) as string[])
  const allCourtKeys = [
    ...sessionCourts,
    ...[...assignedCourtSet].filter(c => !sessionCourts.includes(c)),
  ]

  // 코트별 경기 맵 (필터 무관 — 코트 카드는 항상 전체 표시)
  const byCourt = new Map<string, VenueMatch[]>()
  for (const c of allCourtKeys) byCourt.set(c, [])
  for (const m of matches) {
    if (m.court) {
      if (!byCourt.has(m.court)) byCourt.set(m.court, [])
      byCourt.get(m.court)!.push(m)
    }
  }

  // [FIX V2] 미배정 배너: 부서 필터 적용 (배너 숫자 ↔ 코트 내용 일치)
  const allUnassigned = matches.filter(m => !m.court && m.status !== 'FINISHED')
  const filteredUnassignedByDiv = filterDiv === 'ALL'
    ? allUnassigned
    : allUnassigned.filter(m => m.division_name === filterDiv)

  // 라운드 정규화 (개인전·단체전 다양한 표기 통일)
  function roundCategory(round: string | null | undefined): string {
    if (!round) return '기타'
    const raw = String(round)
    const lower = raw.toLowerCase()
    if (lower === 'group' || lower === 'full_league' || raw === 'GROUP') return '예선'
    if (raw === '128강' || lower === 'r128') return '128강'
    if (raw === '64강'  || lower === 'r64')  return '64강'
    if (raw === '32강'  || lower === 'r32'   || lower === 'round_of_32') return '32강'
    if (raw === '16강'  || lower === 'r16'   || lower === 'round_of_16') return '16강'
    if (raw === '8강'   || lower === 'qf'    || lower === 'quarter')     return '8강'
    if (raw === '4강'   || lower === 'sf'    || lower === 'semi')        return '4강'
    if (raw === '결승'  || lower === 'f'     || lower === 'final')       return '결승'
    return raw
  }

  const ROUND_ORDER_LABEL = ['예선', '128강', '64강', '32강', '16강', '8강', '4강', '결승']
  const availableRounds = Array.from(new Set(filteredUnassignedByDiv.map(m => roundCategory(m.round))))
  const sortedRounds = [
    ...ROUND_ORDER_LABEL.filter(r => availableRounds.includes(r)),
    ...availableRounds.filter(r => !ROUND_ORDER_LABEL.includes(r)),  // 기타/알수없는 라운드 뒤로
  ]

  const filteredUnassigned = filterRound === 'ALL'
    ? filteredUnassignedByDiv
    : filteredUnassignedByDiv.filter(m => roundCategory(m.round) === filterRound)

  // ── 점수 입력 모달 열기 [FIX V3] 열 때 msg 초기화
  function openScoreEdit(m: VenueMatch) {
    setMsg('')           // 이전 잔류 메시지 초기화
    setEditMatch(m)
    setEditScore(m.score || '')
    setEditWinner(
      m.winner_team_id === m.team_a_id ? 'A' :
      m.winner_team_id === m.team_b_id ? 'B' : ''
    )
  }

  // ── 모달 닫기 (msg도 함께 초기화)
  function closeModal() {
    setEditMatch(null)
    setEditScore('')
    setEditWinner('')
    setMsg('')
  }

  // ── 점수 저장
  async function submitScore() {
    if (!editMatch || !editScore || !editWinner) { setMsg('점수와 승자를 모두 입력해주세요.'); return }
    if (editMatch.is_team_tie) { setMsg('단체전은 여기서 결과를 입력하지 마세요.'); return }
    setSubmitting(true); setMsg('')
    try {
      const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
      const { error } = await supabase.rpc('rpc_venue_submit_score', {
        p_token: session.token,
        p_match_id: editMatch.id,
        p_score: editScore,
        p_winner_team_id: winnerId,
      })
      if (error) { setMsg('❌ ' + error.message); return }
      closeModal()
      await loadData()
    } finally {
      setSubmitting(false)
    }
  }

  // ── 경기 시작
  async function startMatch(matchId: string) {
    if (matchId.startsWith('tie_')) return
    setMsg('')
    const { error } = await supabase.rpc('rpc_venue_start_match', {
      p_token: session.token,
      p_match_id: matchId,
    })
    if (error) { setMsg('❌ ' + error.message); return }
    await loadData()
  }

  // ── 코트 배정 헬퍼 ────────────────────────────────────────

  // 다음 court_order 계산 (해당 코트의 max + 1)
  async function nextCourtOrderForMatches(courtName: string): Promise<number> {
    const { data } = await supabase.from('matches')
      .select('court_order').eq('court', courtName)
      .order('court_order', { ascending: false }).limit(1)
    return (data?.[0]?.court_order || 0) + 1
  }
  async function nextCourtOrderForTies(courtNumber: number): Promise<number> {
    const { data } = await supabase.from('ties')
      .select('court_order').eq('court_number', courtNumber)
      .order('court_order', { ascending: false }).limit(1)
    return (data?.[0]?.court_order || 0) + 1
  }

  // 개별 배정/해제 (courtName=null → 해제)
  async function assignItem(item: VenueMatch, courtName: string | null): Promise<string | null> {
    // 자기 경기장 코트만 허용 (해제는 예외)
    if (courtName !== null && !sessionCourts.includes(courtName)) {
      return '자기 경기장 코트에만 배정할 수 있습니다.'
    }
    // 진행 중 경기 이동은 경고
    if (item.status === 'IN_PROGRESS' && courtName !== item.court) {
      if (!confirm(`진행 중인 경기입니다.\n${courtName ? `${courtName}으로 이동` : '배정 해제'}하시겠습니까?`)) {
        return 'cancelled'
      }
    }
    if (item.is_team_tie) {
      const tieId = item.id.replace(/^tie_/, '')
      if (courtName === null) {
        const { error } = await supabase.from('ties')
          .update({ court_number: null, court_order: null }).eq('id', tieId)
        return error?.message || null
      }
      const idx = allVenueCourtNames.indexOf(courtName)
      if (idx < 0) return `코트 "${courtName}" 글로벌 인덱스를 찾을 수 없음`
      const courtNum = idx + 1
      const nextOrd = await nextCourtOrderForTies(courtNum)
      const { error } = await supabase.from('ties')
        .update({ court_number: courtNum, court_order: nextOrd }).eq('id', tieId)
      return error?.message || null
    } else {
      if (courtName === null) {
        const { error } = await supabase.from('matches')
          .update({ court: null, court_order: null }).eq('id', item.id)
        return error?.message || null
      }
      const nextOrd = await nextCourtOrderForMatches(courtName)
      const { error } = await supabase.from('matches')
        .update({ court: courtName, court_order: nextOrd }).eq('id', item.id)
      return error?.message || null
    }
  }

  async function handleAssign(item: VenueMatch, courtName: string | null) {
    setAssignMsg('')
    const err = await assignItem(item, courtName)
    if (err === 'cancelled') return
    if (err) { setAssignMsg('❌ ' + err); return }
    setAssignMsg(courtName ? `✅ ${courtName}에 배정됨` : '✅ 배정 해제됨')
    setTimeout(() => setAssignMsg(''), 3000)
    await loadData()
  }

  // 자동 배정: 미배정 경기를 부하 적은 코트에 분배
  async function autoAssign() {
    if (sessionCourts.length === 0) { setAssignMsg('❌ 이 경기장에 코트가 없습니다.'); return }
    const targets = filteredUnassigned
    if (targets.length === 0) { setAssignMsg('배정할 미배정 경기가 없습니다.'); return }

    setAssigning(true)
    setAssignMsg('')
    try {
      // 각 코트의 현재 로드 (완료 제외)
      const loadMap: Record<string, number> = {}
      for (const c of sessionCourts) loadMap[c] = 0
      for (const m of matches) {
        if (m.court && sessionCourts.includes(m.court) && m.status !== 'FINISHED') {
          loadMap[m.court] = (loadMap[m.court] || 0) + 1
        }
      }

      // 경기 번호순 정렬 (안정적인 순서)
      const sorted = [...targets].sort((a, b) =>
        (a.match_num || '').localeCompare(b.match_num || '', undefined, { numeric: true })
      )

      let successCount = 0
      for (const item of sorted) {
        // 로드 최소 코트 선택
        const court = sessionCourts.reduce((min, c) =>
          loadMap[c] < loadMap[min] ? c : min, sessionCourts[0])
        const err = await assignItem(item, court)
        if (!err) {
          loadMap[court]++
          successCount++
        }
      }
      setAssignMsg(`✅ ${successCount}/${sorted.length}경기 자동 배정 완료`)
      setTimeout(() => setAssignMsg(''), 4000)
      await loadData()
    } finally {
      setAssigning(false)
    }
  }

  function handleLogout() {
    sessionStorage.removeItem('venue_session')
    router.push('/venue')
  }

  if (!session) return null

  return (
    <div className="min-h-screen bg-stone-50">

      {/* ── 헤더 [FIX V4] courts 없을 때 빈 문자열 대신 로딩 표시 */}
      <header className="bg-orange-500 text-white sticky top-0 z-10 shadow-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-lg leading-tight">{session.venue_name}</h1>
            <p className="text-xs text-white/70 mt-0.5">
              {allCourtKeys.length > 0 ? allCourtKeys.join(' · ') : '코트 배정 대기 중...'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/50">{lastUpdate.toLocaleTimeString('ko-KR')}</span>
            <button onClick={() => loadData()}
              className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-lg transition-all">
              🔄
            </button>
            <button onClick={handleLogout} className="text-xs text-white/70 hover:text-white px-2">
              로그아웃
            </button>
          </div>
        </div>

        {/* 부서 필터 탭 */}
        {divisionNames.length > 1 && (
          <div className="max-w-6xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto">
            <button onClick={() => setFilterDiv('ALL')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                filterDiv === 'ALL' ? 'bg-white text-orange-600 font-bold' : 'bg-white/20 text-white'
              }`}>
              전체
            </button>
            {divisionNames.map(n => (
              <button key={n} onClick={() => setFilterDiv(n)}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                  filterDiv === n ? 'bg-white text-orange-600 font-bold' : 'bg-white/20 text-white'
                }`}>
                {n}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4">

        {/* 전체 메시지 */}
        {msg && !editMatch && (
          <div className={`mb-3 p-3 rounded-xl text-sm font-medium ${
            msg.startsWith('✅') ? 'bg-green-50 text-green-700 border border-green-200'
                                 : 'bg-red-50 text-red-600 border border-red-200'
          }`}>
            {msg}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="inline-block w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-stone-400 text-sm">불러오는 중...</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">

            {/* 배정 메시지 */}
            {assignMsg && (
              <div className={`p-2.5 rounded-xl text-sm font-medium ${
                assignMsg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
              }`}>
                {assignMsg}
              </div>
            )}

            {/* 미배정 배너 — 라운드 필터 + 드롭다운 + 자동배정 */}
            {filteredUnassignedByDiv.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">⏳</span>
                    <p className="text-sm font-bold text-amber-800">
                      배정 대기 {filteredUnassigned.length}경기
                      {filterRound !== 'ALL' && <span className="text-amber-600 font-normal ml-1">({filterRound})</span>}
                      {filterDiv !== 'ALL' && <span className="text-amber-600 font-normal ml-1">· {filterDiv}</span>}
                    </p>
                  </div>
                  <button onClick={autoAssign} disabled={assigning || sessionCourts.length === 0}
                    className="text-xs bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white px-3 py-2 rounded-lg font-bold whitespace-nowrap">
                    {assigning ? '배정중...' : '🎯 자동 배정'}
                  </button>
                </div>

                {/* 라운드 탭 */}
                {sortedRounds.length > 1 && (
                  <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1">
                    <button onClick={() => setFilterRound('ALL')}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                        filterRound === 'ALL'
                          ? 'bg-amber-600 text-white shadow'
                          : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-100'
                      }`}>
                      전체 <span className="opacity-70">({filteredUnassignedByDiv.length})</span>
                    </button>
                    {sortedRounds.map(r => {
                      const count = filteredUnassignedByDiv.filter(m => roundCategory(m.round) === r).length
                      return (
                        <button key={r} onClick={() => setFilterRound(r)}
                          className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                            filterRound === r
                              ? 'bg-amber-600 text-white shadow'
                              : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-100'
                          }`}>
                          {r} <span className="opacity-70">({count})</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {filteredUnassigned.length === 0 ? (
                  <div className="text-center py-6 text-amber-500 text-sm">
                    이 라운드에 미배정 경기가 없습니다.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredUnassigned.map(m => (
                      <CourtAssignRow key={m.id} m={m} courts={sessionCourts}
                        onAssign={(c) => handleAssign(m, c)} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 코트 카드 그리드 */}
            {allCourtKeys.length === 0 ? (
              <div className="text-center py-16 text-stone-400">
                <div className="text-4xl mb-3">🎾</div>
                <p className="font-medium">배정된 코트가 없습니다</p>
                <p className="text-sm mt-1">운영자 대시보드에서 코트를 배정해주세요.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {allCourtKeys.map(court => {
                  const courtMatches = (byCourt.get(court) || [])
                    .sort((a, b) => (a.court_order || 0) - (b.court_order || 0))

                  const inProgressMatch = courtMatches.find(m => m.status === 'IN_PROGRESS')
                  const pendingMatches  = courtMatches.filter(m => m.status === 'PENDING')
                  const finishedMatches = courtMatches.filter(m => m.status === 'FINISHED')
                  const isLive          = !!inProgressMatch
                  const totalCount      = courtMatches.length
                  const finishedCount   = finishedMatches.length

                  // 대기 순서 계산
                  const activeIdx       = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
                  const firstPendingIdx = courtMatches.findIndex(m => m.status === 'PENDING')
                  const currentIdx      = activeIdx >= 0 ? activeIdx : firstPendingIdx

                  return (
                    <div key={court} className={`bg-white rounded-xl overflow-hidden shadow-sm transition-all border-2 ${
                      isLive ? 'border-red-400 shadow-red-100' : 'border-stone-200'
                    }`}>

                      {/* 코트 헤더 */}
                      <div className={`px-4 py-3 flex items-center justify-between ${
                        isLive ? 'bg-red-700' : 'bg-[#2d5016]'
                      } text-white`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`font-bold truncate ${court.length > 6 ? 'text-sm' : 'text-base'}`}>
                            {court}
                          </span>
                          {isLive && (
                            <span className="text-[10px] bg-white/25 px-2 py-0.5 rounded-full animate-pulse flex-shrink-0 font-semibold">
                              LIVE
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-white/60 text-xs tabular-nums">{finishedCount}/{totalCount}</span>
                          {totalCount > 0 && (
                            <div className="w-12 h-1.5 bg-white/20 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-white/70 rounded-full transition-all duration-500"
                                style={{ width: `${(finishedCount / totalCount) * 100}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 경기 목록 */}
                      <div className="p-2 space-y-1.5 max-h-[55vh] overflow-y-auto">

                        {/* 현재 진행 중 */}
                        {inProgressMatch && (
                          <CourtMatchCard
                            m={inProgressMatch}
                            badge="🔴 진행중"
                            badgeStyle="bg-red-50 border-red-300"
                            canStart={false}
                            onStart={() => {}}
                            onScore={() => openScoreEdit(inProgressMatch)}
                            courts={sessionCourts}
                            onAssign={(c) => handleAssign(inProgressMatch, c)}
                          />
                        )}

                        {/* 대기 경기들 */}
                        {pendingMatches.map(m => {
                          const allIdx = courtMatches.indexOf(m)
                          let badge = ''
                          let badgeStyle = 'border-stone-200 bg-white'
                          if (currentIdx >= 0 && allIdx === currentIdx) {
                            badge = '▶ 현재 대기'; badgeStyle = 'bg-orange-50 border-orange-200'
                          } else if (currentIdx >= 0 && allIdx === currentIdx + 1) {
                            badge = '다음'; badgeStyle = 'bg-amber-50 border-amber-200'
                          } else if (currentIdx >= 0 && allIdx === currentIdx + 2) {
                            badge = '대기'; badgeStyle = 'bg-stone-50 border-stone-200'
                          }
                          const isFirstPending = pendingMatches.indexOf(m) === 0
                          const canStart = !inProgressMatch && isFirstPending && !m.is_team_tie
                          return (
                            <CourtMatchCard
                              key={m.id}
                              m={m}
                              badge={badge}
                              badgeStyle={badgeStyle}
                              canStart={canStart}
                              onStart={() => startMatch(m.id)}
                              onScore={() => openScoreEdit(m)}
                              courts={sessionCourts}
                              onAssign={(c) => handleAssign(m, c)}
                            />
                          )
                        })}

                        {/* 완료 경기 접기 */}
                        {finishedMatches.length > 0 && (
                          <FinishedSection items={finishedMatches} onScore={openScoreEdit} />
                        )}

                        {totalCount === 0 && (
                          <div className="text-center py-8 text-stone-300">
                            <div className="text-3xl mb-1">🎾</div>
                            <div className="text-xs">배정된 경기 없음</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── 점수 입력 모달 */}
      {editMatch && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
          onClick={closeModal}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>

            {/* 경기 정보 바 */}
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-1.5 h-10 rounded-full flex-shrink-0 ${
                editMatch.status === 'IN_PROGRESS' ? 'bg-red-500' :
                editMatch.status === 'FINISHED'    ? 'bg-green-500' : 'bg-stone-300'
              }`} />
              <div>
                <p className="font-bold text-base leading-tight">
                  {editMatch.court}
                  <span className="text-stone-400 font-normal text-sm ml-1">#{editMatch.court_order}</span>
                </p>
                <p className="text-xs text-stone-400 mt-0.5">{editMatch.division_name} · {editMatch.round}</p>
              </div>
            </div>

            {/* 참가자 잠금 알림 */}
            {editMatch.locked_by_participant && (
              <div className="mb-3 p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700 flex items-center gap-2">
                🔒 참가자가 이미 입력한 결과입니다.
              </div>
            )}

            {/* 팀명 VS */}
            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 text-center">
                <p className="font-bold text-base leading-tight break-words">{editMatch.team_a_name || 'TBD'}</p>
              </div>
              <span className="text-stone-200 font-light text-2xl flex-shrink-0">VS</span>
              <div className="flex-1 text-center">
                <p className="font-bold text-base leading-tight break-words">{editMatch.team_b_name || 'TBD'}</p>
              </div>
            </div>

            {/* 점수 입력 */}
            <div className="mb-4">
              <label className="text-xs text-stone-500 font-medium mb-1.5 block">점수</label>
              <input
                type="text"
                inputMode="text"
                placeholder="예: 6:4"
                value={editScore}
                onChange={e => setEditScore(e.target.value)}
                className="w-full border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 text-center text-2xl font-bold outline-none transition-colors"
                autoFocus
              />
            </div>

            {/* 승자 선택 */}
            <div className="mb-4">
              <label className="text-xs text-stone-500 font-medium mb-1.5 block">승자</label>
              <div className="flex gap-2">
                <button onClick={() => setEditWinner('A')}
                  className={`flex-1 py-3 rounded-xl text-sm font-bold border-2 transition-all ${
                    editWinner === 'A'
                      ? 'bg-orange-500 text-white border-orange-500 shadow-md'
                      : 'border-stone-200 text-stone-600 hover:border-orange-300'
                  }`}>
                  {editMatch.team_a_name || 'A팀'}
                </button>
                <button onClick={() => setEditWinner('B')}
                  className={`flex-1 py-3 rounded-xl text-sm font-bold border-2 transition-all ${
                    editWinner === 'B'
                      ? 'bg-orange-500 text-white border-orange-500 shadow-md'
                      : 'border-stone-200 text-stone-600 hover:border-orange-300'
                  }`}>
                  {editMatch.team_b_name || 'B팀'}
                </button>
              </div>
            </div>

            {/* 인라인 에러 메시지 */}
            {msg && (
              <p className={`text-xs text-center mb-3 ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>
                {msg}
              </p>
            )}

            {/* 버튼 */}
            <div className="flex gap-2">
              <button onClick={closeModal}
                className="flex-1 py-3 rounded-xl border-2 border-stone-200 text-sm font-medium text-stone-600 hover:bg-stone-50 transition-all">
                취소
              </button>
              <button onClick={submitScore} disabled={submitting || !editScore || !editWinner}
                className="flex-[2] py-3 rounded-xl bg-orange-500 text-white font-bold text-sm hover:bg-orange-600 disabled:opacity-40 transition-all shadow-md">
                {submitting ? '저장 중...' : '✅ 결과 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 코트 경기 카드 (재배정 드롭다운 포함)
function CourtMatchCard({ m, badge, badgeStyle, canStart, onStart, onScore, courts, onAssign }: {
  m: VenueMatch
  badge: string
  badgeStyle: string
  canStart: boolean
  onStart: () => void
  onScore: () => void
  courts: string[]
  onAssign: (court: string | null) => void
}) {
  const isInProgress = m.status === 'IN_PROGRESS'
  const [showMove, setShowMove] = useState(false)
  return (
    <div className={`rounded-xl border-2 p-3 transition-all ${badgeStyle}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-xs font-mono text-stone-400 flex-shrink-0">#{m.court_order}</span>
          {m.is_team_tie && (
            <span className="text-[9px] bg-blue-600 text-white px-1.5 py-0.5 rounded-full flex-shrink-0">단체</span>
          )}
          {badge && (
            <span className={`text-[10px] font-bold flex-shrink-0 ${
              badge.includes('진행') ? 'text-red-600' :
              badge.includes('현재') ? 'text-orange-600' :
              badge.includes('다음') ? 'text-amber-600' : 'text-stone-400'
            }`}>
              {badge}
            </span>
          )}
          <span className="text-[11px] text-stone-400 truncate">{m.division_name} · {m.round}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-1">
          {canStart && (
            <button onClick={onStart}
              className="text-xs bg-red-500 text-white px-2.5 py-1 rounded-lg hover:bg-red-600 font-bold transition-all shadow-sm">
              ▶ 시작
            </button>
          )}
          {!m.is_team_tie && (
            <button onClick={onScore}
              className={`text-xs px-2 py-1 rounded-lg transition-all ${
                isInProgress
                  ? 'bg-orange-100 text-orange-600 hover:bg-orange-200 font-semibold'
                  : 'text-stone-400 hover:text-blue-500 hover:bg-blue-50'
              }`}>
              {isInProgress ? '점수입력' : '✏'}
            </button>
          )}
          <button onClick={() => setShowMove(!showMove)}
            className="text-xs text-stone-400 hover:text-blue-600 hover:bg-blue-50 px-2 py-1 rounded-lg transition-all"
            title="코트 이동/해제">
            📍
          </button>
        </div>
      </div>
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold leading-tight ${
          m.winner_team_id === m.team_a_id ? 'text-green-700' : 'text-stone-800'
        }`}>
          {m.team_a_name || 'TBD'}
        </div>
        <div className="text-[10px] text-stone-300">vs</div>
        <div className={`text-sm font-semibold leading-tight ${
          m.winner_team_id === m.team_b_id ? 'text-green-700' : 'text-stone-800'
        }`}>
          {m.team_b_name || 'TBD'}
        </div>
      </div>
      {isInProgress && m.score && (
        <div className="mt-2 text-right text-base font-bold text-red-600">{m.score}</div>
      )}

      {/* 코트 이동/해제 드롭다운 */}
      {showMove && (
        <div className="mt-2 pt-2 border-t border-stone-100 flex items-center gap-2">
          <select
            defaultValue={m.court || ''}
            onChange={e => {
              const val = e.target.value
              if (val !== m.court) { onAssign(val || null); setShowMove(false) }
            }}
            className="flex-1 border rounded-lg px-2 py-1.5 text-sm">
            <option value="">(해제)</option>
            {courts.map(c => (
              <option key={c} value={c}>{c}{c === m.court ? ' (현재)' : ''}</option>
            ))}
          </select>
          <button onClick={() => setShowMove(false)}
            className="text-xs text-stone-400 px-2 py-1.5">취소</button>
        </div>
      )}
    </div>
  )
}

// ── 미배정 경기용 코트 선택 Row
function CourtAssignRow({ m, courts, onAssign }: {
  m: VenueMatch
  courts: string[]
  onAssign: (court: string) => void
}) {
  const [selected, setSelected] = useState('')
  return (
    <div className="bg-white rounded-lg border border-amber-200 p-3">
      <div className="flex items-start gap-2 mb-2">
        <span className="text-xs font-mono text-stone-400 flex-shrink-0 mt-0.5">#{m.match_num}</span>
        {m.is_team_tie && (
          <span className="text-[9px] bg-blue-600 text-white px-1.5 py-0.5 rounded-full flex-shrink-0 mt-0.5">단체</span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">
            {m.team_a_name || 'TBD'}
            <span className="text-stone-300 font-normal mx-1">vs</span>
            {m.team_b_name || 'TBD'}
          </div>
          <div className="text-[11px] text-stone-400 mt-0.5">{m.division_name} · {m.round}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <select value={selected} onChange={e => setSelected(e.target.value)}
          className="flex-1 border rounded-lg px-2 py-1.5 text-sm">
          <option value="">코트 선택...</option>
          {courts.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button disabled={!selected}
          onClick={() => { onAssign(selected); setSelected('') }}
          className="bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-lg font-bold whitespace-nowrap">
          배정
        </button>
      </div>
    </div>
  )
}

// ── 완료 경기 접기
function FinishedSection({ items, onScore }: {
  items: VenueMatch[]
  onScore: (m: VenueMatch) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-stone-100 pt-1.5 mt-0.5">
      <button onClick={() => setOpen(!open)}
        className="w-full text-left text-xs text-stone-400 hover:text-stone-600 px-1 py-1 flex items-center gap-1.5 transition-all">
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
        <span>완료 {items.length}경기</span>
        <div className="flex-1 h-px bg-stone-100 ml-1" />
      </button>
      {open && (
        <div className="space-y-1 mt-1">
          {items.map(m => (
            <div key={m.id}
              className="rounded-lg border border-stone-100 bg-stone-50 px-3 py-2 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-stone-400 line-through leading-tight">
                  {m.team_a_name} vs {m.team_b_name}
                </div>
                {m.score && (
                  <div className="text-xs font-bold text-stone-500 mt-0.5">{m.score}</div>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[10px] font-mono text-stone-300">#{m.court_order}</span>
                {!m.is_team_tie && (
                  <button onClick={() => onScore(m)}
                    className="text-[10px] text-stone-300 hover:text-amber-500 px-1 transition-all">
                    수정
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}