'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard'

interface MatchSlim {
  id: string; match_num: string; stage: string; round: string
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  court: string | null; court_order: number | null
  status: string; score: string | null; winner_team_id: string | null
  division_name: string; division_id: string; locked_by_participant: boolean
  group_label: string | null
}

export default function CourtsPage() {
  const eventId = useEventId()
  const { divisions, selected: activeDivision, setSelected: setActiveDivision } = useDivisions(eventId)
  const [matches, setMatches] = useState<MatchSlim[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')

  // 코트 설정
  const [courtCount, setCourtCount] = useState(20)
  const courtNames = Array.from({ length: courtCount }, (_, i) => `코트 ${i + 1}`)

  // 부서별 자동배정 설정
  const [autoDiv, setAutoDiv] = useState('')
  const [autoCourts, setAutoCourts] = useState<string[]>([])
  const [autoStage, setAutoStage] = useState<'GROUP' | 'FINALS'>('GROUP')

  // 드래그
  const [dragMatch, setDragMatch] = useState<string | null>(null)

  // 점수 모달
  const [editMatch, setEditMatch] = useState<MatchSlim | null>(null)
  const [editScore, setEditScore] = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)

  // 필터: 전체 or 부서별
  const [viewFilter, setViewFilter] = useState('ALL')

  useEffect(() => { if (eventId) loadMatches() }, [eventId])
  useEffect(() => {
    if (!eventId) return
    const interval = setInterval(loadMatches, 15000)
    return () => clearInterval(interval)
  }, [eventId])

  async function loadMatches() {
    setLoading(true)
    const { data, error } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId)
      .order('court', { ascending: true, nullsFirst: false })
      .order('court_order', { ascending: true, nullsFirst: true })
    console.log('loadMatches:', { count: data?.length, error, eventId })
    // BYE 경기 제외 (프론트에서 필터)
    const filtered = (data || []).filter(m => m.score !== 'BYE')
    setMatches(filtered)
    setLoading(false)
  }

  // ===== 부서별 자동 배정 =====
  function toggleAutoCourt(court: string) {
    setAutoCourts(prev =>
      prev.includes(court) ? prev.filter(c => c !== court) : [...prev, court]
    )
  }

  async function autoAssignByDivision() {
    if (!autoDiv) { setMsg('부서를 선택해주세요.'); return }
    if (autoCourts.length === 0) { setMsg('배정할 코트를 선택해주세요.'); return }

    // 해당 부서의 미배정 경기만
    const targetMatches = matches.filter(m =>
      m.division_id === autoDiv &&
      m.stage === autoStage &&
      !m.court &&
      m.status !== 'FINISHED'
    )

    if (targetMatches.length === 0) {
      setMsg('배정할 경기가 없습니다. (이미 배정되었거나 해당 스테이지 경기가 없습니다)')
      return
    }

    // 선택한 코트들의 기존 경기 수 파악
    const existingCounts: Record<string, number> = {}
    for (const c of autoCourts) {
      existingCounts[c] = matches.filter(m => m.court === c).length
    }

    // 라운드로빈으로 코트에 분배 (같은 조 경기는 가능하면 같은 코트에)
    const sortedCourts = [...autoCourts].sort((a, b) =>
      (existingCounts[a] || 0) - (existingCounts[b] || 0)
    )

    // 조별로 그룹핑
    const byGroup = new Map<string, MatchSlim[]>()
    for (const m of targetMatches) {
      const key = m.group_label || 'none'
      if (!byGroup.has(key)) byGroup.set(key, [])
      byGroup.get(key)!.push(m)
    }

    const updates: { id: string; court: string; court_order: number }[] = []
    const courtOrders: Record<string, number> = {}
    for (const c of autoCourts) {
      courtOrders[c] = (existingCounts[c] || 0) + 1
    }

    let courtIdx = 0
    for (const [groupLabel, groupMatches] of byGroup) {
      // 이 조의 경기를 하나의 코트에 연속 배치
      const court = sortedCourts[courtIdx % sortedCourts.length]
      for (const m of groupMatches) {
        updates.push({
          id: m.id,
          court,
          court_order: courtOrders[court],
        })
        courtOrders[court]++
      }
      courtIdx++
    }

    setMsg('')
    for (const u of updates) {
      await supabase.from('matches')
        .update({ court: u.court, court_order: u.court_order })
        .eq('id', u.id)
    }

    const divName = divisions.find(d => d.id === autoDiv)?.name || ''
    setMsg(`✅ [${divName}] ${updates.length}경기 → ${autoCourts.join(', ')}에 자동 배정 완료`)
    loadMatches()
  }

  // ===== 개별 수동 조작 =====
  async function assignToCourt(matchId: string, court: string) {
    const courtMatches = matches.filter(m => m.court === court)
    const nextOrder = courtMatches.length + 1
    const { error } = await supabase.from('matches')
      .update({ court, court_order: nextOrder }).eq('id', matchId)
    if (error) { setMsg('❌ ' + error.message); return }
    loadMatches()
  }

  async function unassignFromCourt(matchId: string) {
    const { error } = await supabase.from('matches')
      .update({ court: null, court_order: null }).eq('id', matchId)
    if (error) { setMsg('❌ ' + error.message); return }
    loadMatches()
  }

  async function moveMatchOrder(matchId: string, direction: 'up' | 'down') {
    const m = matches.find(mm => mm.id === matchId)
    if (!m || !m.court || !m.court_order) return

    const courtMatches = matches
      .filter(mm => mm.court === m.court)
      .sort((a, b) => (a.court_order || 0) - (b.court_order || 0))

    const idx = courtMatches.findIndex(mm => mm.id === matchId)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= courtMatches.length) return

    const other = courtMatches[swapIdx]
    // 순서 교환
    await supabase.from('matches').update({ court_order: other.court_order }).eq('id', m.id)
    await supabase.from('matches').update({ court_order: m.court_order }).eq('id', other.id)
    loadMatches()
  }

  async function clearDivisionAssignments(divId: string) {
    const divName = divisions.find(d => d.id === divId)?.name || ''
    if (!confirm(`[${divName}] 코트 배정을 모두 초기화하시겠습니까?`)) return
    const divMatches = matches.filter(m => m.division_id === divId && m.court)
    for (const m of divMatches) {
      await supabase.from('matches').update({ court: null, court_order: null }).eq('id', m.id)
    }
    setMsg(`✅ [${divName}] 코트 배정 초기화 완료`)
    loadMatches()
  }

  async function clearAllAssignments() {
    if (!confirm('전체 코트 배정을 초기화하시겠습니까?')) return
    await supabase.from('matches')
      .update({ court: null, court_order: null }).eq('event_id', eventId)
    setMsg('✅ 전체 코트 배정 초기화')
    loadMatches()
  }

  // 점수 입력
  function openScoreEdit(m: MatchSlim) {
    setEditMatch(m)
    setEditScore(m.score || '')
    setEditWinner(
      m.winner_team_id === m.team_a_id ? 'A' :
      m.winner_team_id === m.team_b_id ? 'B' : ''
    )
    setMsg('')
  }

  async function submitResult() {
    if (!editMatch || !editScore || !editWinner) { setMsg('점수와 승자를 모두 입력하세요.'); return }
    setSubmitting(true); setMsg('')
    const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
    const { error } = await supabase.rpc('rpc_submit_match_result', {
      p_match_id: editMatch.id, p_score: editScore, p_winner_team_id: winnerId,
    })
    setSubmitting(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 결과 저장됨')
    setEditMatch(null)
    loadMatches()
  }

  async function startMatch(matchId: string) {
    await supabase.from('matches').update({ status: 'IN_PROGRESS' }).eq('id', matchId)
    loadMatches()
  }

  // 드래그
  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  function handleDropOnCourt(court: string) { if (dragMatch) assignToCourt(dragMatch, court); setDragMatch(null) }
  function handleDropOnUnassigned() { if (dragMatch) unassignFromCourt(dragMatch); setDragMatch(null) }

  // 필터된 데이터
  const filteredMatches = viewFilter === 'ALL' ? matches : matches.filter(m => m.division_id === viewFilter)
  const unassigned = filteredMatches.filter(m => !m.court && m.status !== 'FINISHED')
  const byCourt = new Map<string, MatchSlim[]>()
  for (const name of courtNames) byCourt.set(name, [])
  for (const m of filteredMatches) {
    if (m.court && byCourt.has(m.court)) byCourt.get(m.court)!.push(m)
  }

  // 부서별 색상
  const divColors: Record<string, string> = {}
  const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444']
  divisions.forEach((d, i) => { divColors[d.id] = colors[i % colors.length] })

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">🎾 코트 배정</h1>

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* ===== 부서별 자동 배정 도구 ===== */}
      <div className="bg-white rounded-xl border p-4 mb-4">
        <h3 className="font-bold text-sm mb-3">📋 부서별 자동 배정</h3>
        <div className="flex flex-wrap gap-3 items-start">
          {/* 부서 선택 */}
          <div>
            <label className="text-xs text-stone-500 block mb-1">부서</label>
            <select value={autoDiv} onChange={e => setAutoDiv(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm min-w-[140px]">
              <option value="">부서 선택</option>
              {divisions.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          {/* 스테이지 */}
          <div>
            <label className="text-xs text-stone-500 block mb-1">스테이지</label>
            <select value={autoStage} onChange={e => setAutoStage(e.target.value as any)}
              className="border rounded-lg px-3 py-2 text-sm">
              <option value="GROUP">예선 (조별)</option>
              <option value="FINALS">본선</option>
            </select>
          </div>

          {/* 코트 선택 */}
          <div>
            <label className="text-xs text-stone-500 block mb-1">배정할 코트 (복수 선택)</label>
            <div className="flex flex-wrap gap-1">
              {courtNames.map(c => (
                <button key={c} onClick={() => toggleAutoCourt(c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                    autoCourts.includes(c)
                      ? 'bg-tennis-600 text-white border-tennis-600'
                      : 'bg-white text-stone-600 border-stone-300 hover:border-tennis-400'
                  }`}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* 실행 버튼 */}
          <div className="self-end">
            <button onClick={autoAssignByDivision}
              disabled={!autoDiv || autoCourts.length === 0}
              className="bg-tennis-600 text-white px-5 py-2 rounded-lg text-sm font-bold hover:bg-tennis-700 disabled:opacity-50 whitespace-nowrap">
              🎲 자동 배정
            </button>
          </div>
        </div>
        <p className="text-xs text-stone-400 mt-2">
          * 같은 조 경기는 같은 코트에 연속 배치됩니다
        </p>
      </div>

      {/* ===== 도구 바 ===== */}
      <div className="bg-white rounded-xl border p-3 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          {/* 코트 수 */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500">코트 수:</label>
            <select value={courtCount} onChange={e => setCourtCount(Number(e.target.value))}
              className="border rounded-lg px-2 py-1 text-sm">
              {[2, 3, 4, 5, 6, 7, 8, 10, 12].map(n => <option key={n} value={n}>{n}면</option>)}
            </select>
          </div>

          {/* 뷰 필터 */}
          <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
            <button onClick={() => setViewFilter('ALL')}
              className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter === 'ALL' ? 'bg-white shadow-sm' : ''}`}>
              전체
            </button>
            {divisions.map(d => (
              <button key={d.id} onClick={() => setViewFilter(d.id)}
                className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter === d.id ? 'bg-white shadow-sm' : ''}`}>
                <span style={{ color: divColors[d.id] }}>●</span> {d.name}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* 부서별 초기화 */}
          {divisions.map(d => (
            <button key={d.id} onClick={() => clearDivisionAssignments(d.id)}
              className="text-xs text-stone-400 hover:text-red-500 px-2 py-1">
              🗑️{d.name}
            </button>
          ))}
          <button onClick={clearAllAssignments}
            className="bg-red-100 text-red-600 px-3 py-1 rounded-lg text-xs font-medium hover:bg-red-200">
            🗑️ 전체 초기화
          </button>
          <span className="text-xs text-stone-400">🔄 15초 자동갱신</span>
        </div>
      </div>

      {/* ===== 코트 배정 그리드 ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        {/* 미배정 */}
        <div className="lg:col-span-1" onDragOver={handleDragOver} onDrop={handleDropOnUnassigned}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="bg-stone-500 text-white px-3 py-2 font-bold text-sm">
              미배정 ({unassigned.length})
            </div>
            <div className="p-1.5 max-h-[65vh] overflow-y-auto space-y-1">
              {unassigned.length === 0 ? (
                <p className="text-xs text-stone-400 text-center py-4">모두 배정됨</p>
              ) : unassigned.map(m => (
                <MatchChip key={m.id} m={m} divColor={divColors[m.division_id]}
                  onDragStart={setDragMatch}
                  onClickScore={() => openScoreEdit(m)} />
              ))}
            </div>
          </div>
        </div>

        {/* 코트들 */}
        <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {courtNames.map(court => {
            const courtMatches = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
            const finished = courtMatches.filter(m => m.status === 'FINISHED').length
            const activeIdx = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
            const pendingIdx = courtMatches.findIndex(m => m.status === 'PENDING')
            const currentIdx = activeIdx >= 0 ? activeIdx : pendingIdx
            const isLive = activeIdx >= 0

            return (
              <div key={court}
                onDragOver={handleDragOver}
                onDrop={() => handleDropOnCourt(court)}
                className="bg-white rounded-xl border overflow-hidden min-h-[100px]">
                <div className={`px-3 py-2 font-bold text-sm flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                  <span>
                    {court}
                    {isLive && <span className="ml-2 text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}
                  </span>
                  <span className="text-white/60 text-xs">{finished}/{courtMatches.length}</span>
                </div>
                <div className="p-1.5 space-y-1 max-h-[60vh] overflow-y-auto">
                  {courtMatches.map((m, i) => {
                    let badge = ''
                    if (m.status === 'IN_PROGRESS') badge = '🔴'
                    else if (m.status === 'FINISHED') badge = ''
                    else if (currentIdx >= 0 && i === currentIdx) badge = '🔴'
                    else if (currentIdx >= 0 && i === currentIdx + 1) badge = '🟡'
                    else if (currentIdx >= 0 && i === currentIdx + 2) badge = '🟢'

                    const canStart = m.status === 'PENDING' && (currentIdx < 0 || i === currentIdx)

                    return (
                      <MatchChip key={m.id} m={m} order={m.court_order || i + 1} badge={badge}
                        divColor={divColors[m.division_id]}
                        onDragStart={setDragMatch}
                        onClickScore={() => openScoreEdit(m)}
                        onClickStart={canStart ? () => startMatch(m.id) : undefined}
                        onClickUnassign={() => unassignFromCourt(m.id)}
                        onMoveUp={i > 0 ? () => moveMatchOrder(m.id, 'up') : undefined}
                        onMoveDown={i < courtMatches.length - 1 ? () => moveMatchOrder(m.id, 'down') : undefined}
                      />
                    )
                  })}
                  {courtMatches.length === 0 && (
                    <div className="text-xs text-stone-300 text-center py-6 border-2 border-dashed rounded-lg">
                      드래그 또는 자동배정
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ===== 점수 입력 모달 ===== */}
      {editMatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditMatch(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">경기 결과 입력/수정</h3>
            <p className="text-xs text-stone-400 mb-4">
              {editMatch.match_num} · {editMatch.division_name} · {editMatch.round}
              {editMatch.court && <span className="ml-1 font-medium text-[#2d5016]">({editMatch.court} #{editMatch.court_order})</span>}
            </p>

            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1 font-medium">{editMatch.team_a_name || 'TBD'}</div>
              <span className="text-xl text-stone-300">VS</span>
              <div className="text-center flex-1 font-medium">{editMatch.team_b_name || 'TBD'}</div>
            </div>

            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">점수</label>
              <input type="text" placeholder="6:4" value={editScore}
                onChange={e => setEditScore(e.target.value)}
                className="w-full border rounded-xl px-4 py-3 text-center text-lg font-bold" autoFocus />
            </div>

            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">승자</label>
              <div className="flex gap-2">
                <button onClick={() => setEditWinner('A')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                    editWinner === 'A' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-200 hover:border-tennis-400'
                  }`}>{editMatch.team_a_name || 'A'}</button>
                <button onClick={() => setEditWinner('B')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                    editWinner === 'B' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-200 hover:border-tennis-400'
                  }`}>{editMatch.team_b_name || 'B'}</button>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setEditMatch(null)}
                className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">취소</button>
              <button onClick={submitResult}
                disabled={submitting || !editScore || !editWinner}
                className="flex-1 py-2.5 rounded-xl bg-tennis-600 text-white font-bold text-sm disabled:opacity-50">
                {submitting ? '저장 중...' : '결과 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== MatchChip 컴포넌트 =====
function MatchChip({ m, order, badge, divColor, onDragStart, onClickScore, onClickStart, onClickUnassign, onMoveUp, onMoveDown }: {
  m: MatchSlim; order?: number; badge?: string; divColor?: string
  onDragStart: (id: string) => void; onClickScore: () => void
  onClickStart?: () => void; onClickUnassign?: () => void
  onMoveUp?: () => void; onMoveDown?: () => void
}) {
  const done = m.status === 'FINISHED'
  const live = m.status === 'IN_PROGRESS'

  return (
    <div draggable onDragStart={() => onDragStart(m.id)}
      className={`rounded-lg border p-2 text-xs cursor-grab active:cursor-grabbing transition-all ${
        live ? 'bg-red-50 border-red-200' :
        done ? 'bg-tennis-50 border-tennis-200' :
        'bg-white border-stone-200 hover:border-stone-300'
      }`}>
      {/* 상단 행 */}
      <div className="flex items-center gap-1 mb-1">
        {order && <span className="text-stone-400 font-bold">#{order}</span>}
        {badge && <span className="text-[10px]">{badge}</span>}
        {/* 부서 색 점 */}
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: divColor || '#999' }} />
        <span className="text-stone-400 truncate flex-1">{m.division_name} · {m.round}{m.group_label ? ` · ${m.group_label}` : ''}</span>
        {/* 버튼들 */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onMoveUp && <button onClick={e => { e.stopPropagation(); onMoveUp() }} className="text-stone-300 hover:text-stone-600 px-0.5" title="위로">↑</button>}
          {onMoveDown && <button onClick={e => { e.stopPropagation(); onMoveDown() }} className="text-stone-300 hover:text-stone-600 px-0.5" title="아래로">↓</button>}
          {onClickStart && <button onClick={e => { e.stopPropagation(); onClickStart() }} className="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded hover:bg-red-600">▶</button>}
          <button onClick={e => { e.stopPropagation(); onClickScore() }} className="text-stone-300 hover:text-blue-500">✏️</button>
          {onClickUnassign && <button onClick={e => { e.stopPropagation(); onClickUnassign() }} className="text-stone-300 hover:text-red-400">×</button>}
        </div>
      </div>
      {/* 팀명 */}
      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0">
          <span className={`truncate ${m.winner_team_id === m.team_a_id ? 'font-bold text-tennis-700' : 'font-medium'}`}>
            {m.team_a_name || 'TBD'}
          </span>
          <span className="text-stone-300 mx-1">v</span>
          <span className={`truncate ${m.winner_team_id === m.team_b_id ? 'font-bold text-tennis-700' : 'font-medium'}`}>
            {m.team_b_name || 'TBD'}
          </span>
        </div>
        {done && m.score && <span className="font-bold text-tennis-600">{m.score}</span>}
      </div>
    </div>
  )
}