'use client'
// ============================================================
// src/app/dashboard/courts/page.tsx
// ✅ 완료된 경기(FINISHED) 운영자 강제 수정 가능
//    - 모달에 "완료된 경기" 경고 배너 표시
//    - submitResult: RPC 실패 시 matches 직접 update로 폴백
//    - MatchChip: FINISHED 경기도 수정 버튼 표시
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions } from '@/components/useDashboard'
// fetchTies는 court_order 미포함으로 직접 쿼리로 대체
import { getTieStatusLabel } from '@/lib/team-utils'
import type { TieWithClubs } from '@/types/team'

interface MatchSlim {
  id: string; match_num: string; stage: string; round: string
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  court: string | null; court_order: number | null
  status: string; score: string | null; winner_team_id: string | null
  division_name: string; division_id: string; locked_by_participant: boolean
  group_label: string | null
  is_team_tie?: boolean
}

export default function CourtsPage() {
  const eventId = useEventId()
  const { divisions } = useDivisions(eventId)
  const [matches, setMatches] = useState<MatchSlim[]>([])
  const [ties, setTies] = useState<TieWithClubs[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')

  const [courtCount, setCourtCount] = useState(10)
  const courtNames = Array.from({ length: courtCount }, (_, i) => `코트 ${i + 1}`)

  const [autoDiv, setAutoDiv] = useState('')
  const [autoCourts, setAutoCourts] = useState<string[]>([])
  const [autoStage, setAutoStage] = useState<'GROUP' | 'FINALS'>('GROUP')

  const [dragMatch, setDragMatch] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)  // ✅ 드래그 처리 중 중복 방지
  // ✅ 모바일 터치 드래그용
  const [touchDragId, setTouchDragId] = useState<string | null>(null)
  const [touchOver, setTouchOver] = useState<string | null>(null)  // 'court:코트 1' or 'unassigned'

  const [editMatch, setEditMatch] = useState<MatchSlim | null>(null)
  const [editScore, setEditScore] = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)

  const [viewFilter, setViewFilter] = useState('ALL')

  const [notifying, setNotifying] = useState<string | null>(null)
  const [notifyMsg, setNotifyMsg] = useState<Record<string, string>>({})

  async function sendCourtNotify(
    court: string,
    trigger: 'manual' | 'finished' | 'court_changed',
    matchId?: string
  ) {
    setNotifying(court)
    try {
      const res = await fetch('/api/notify/court', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, court, match_id: matchId, trigger }),
      })
      const json = await res.json()
      const m = json.sent > 0 ? `✅ ${json.sent}명 알림 전송` : `ℹ️ ${json.message || '구독자 없음'}`
      setNotifyMsg(prev => ({ ...prev, [court]: m }))
      setTimeout(() => setNotifyMsg(prev => { const n = { ...prev }; delete n[court]; return n }), 3000)
    } catch {
      setNotifyMsg(prev => ({ ...prev, [court]: '❌ 전송 실패' }))
    } finally {
      setNotifying(null)
    }
  }

  async function loadAll(showLoading = false) {
    if (showLoading) setLoading(true)
    try {
      const [matchRes, tieData] = await Promise.all([
        supabase.from('v_matches_with_teams').select('*')
          .eq('event_id', eventId)
          .order('court', { ascending: true, nullsFirst: false })
          .order('court_order', { ascending: true, nullsFirst: true }),
        supabase.from('ties')
          .select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)')
          .eq('event_id', eventId)
          .order('court_order', { ascending: true, nullsFirst: false }),
      ])
      setMatches((matchRes.data || []).filter((m: any) => m.score !== 'BYE'))
      setTies((tieData.data || []) as any)
    } catch {}
    if (showLoading) setLoading(false)
  }

  async function loadMatches() {
    const { data } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId)
      .order('court', { ascending: true, nullsFirst: false })
      .order('court_order', { ascending: true, nullsFirst: true })
    setMatches((data || []).filter(m => m.score !== 'BYE'))
  }

  async function loadTies() {
    try {
      const { data } = await supabase.from('ties')
        .select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)')
        .eq('event_id', eventId)
        .order('court_order', { ascending: true, nullsFirst: false })
      setTies((data || []) as any)
    } catch {}
  }

  useEffect(() => { if (!eventId) return; loadAll(true) }, [eventId])
  useEffect(() => {
    if (!eventId) return
    const interval = setInterval(() => loadAll(false), 15000)
    return () => clearInterval(interval)
  }, [eventId])

  function tiesToMatchSlim(tieList: TieWithClubs[]): MatchSlim[] {
    return tieList.filter(t => !t.is_bye).map(t => {
      const statusMap: Record<string, string> = {
        pending: 'PENDING', lineup_phase: 'PENDING', in_progress: 'IN_PROGRESS', completed: 'FINISHED'
      }
      return {
        id: `tie_${t.id}`,
        match_num: `T#${t.tie_order}`,
        stage: 'TEAM', round: t.round || 'group',
        team_a_name: t.club_a?.name || 'TBD',
        team_b_name: t.club_b?.name || 'TBD',
        team_a_id: t.club_a_id || '',
        team_b_id: t.club_b_id || '',
        court: t.court_number ? `코트 ${t.court_number}` : null,
        court_order: t.court_number ? ((t as any).court_order ?? (100 + (t.tie_order || 0))) : null,
        status: statusMap[t.status] || 'PENDING',
        score: (t.status === 'completed' || t.status === 'in_progress') ? `${t.club_a_rubbers_won}-${t.club_b_rubbers_won}` : null,
        winner_team_id: t.winning_club_id || null,
        division_name: '단체전', division_id: t.division_id || 'TEAM',
        locked_by_participant: false, group_label: null, is_team_tie: true,
      }
    })
  }

  const tieMatches = tiesToMatchSlim(ties)
  const allItems = [...matches, ...tieMatches]
  const filteredAll = viewFilter === 'ALL' ? allItems
    : viewFilter === 'TEAM' ? allItems.filter(m => m.is_team_tie)
    : allItems.filter(m => m.division_id === viewFilter)

  const unassigned = filteredAll.filter(m => !m.court && m.status !== 'FINISHED')
  const byCourt = new Map<string, MatchSlim[]>()
  for (const name of courtNames) byCourt.set(name, [])
  for (const m of filteredAll) { if (m.court && byCourt.has(m.court)) byCourt.get(m.court)!.push(m) }

  const divColors: Record<string, string> = { TEAM: '#2563eb' }
  const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444']
  divisions.forEach((d, i) => { divColors[d.id] = colors[i % colors.length] })

  function toggleAutoCourt(court: string) {
    setAutoCourts(prev => prev.includes(court) ? prev.filter(c => c !== court) : [...prev, court])
  }

  async function autoAssignByDivision() {
    if (!autoDiv) { setMsg('부문을 선택해주세요.'); return }
    if (autoCourts.length === 0) { setMsg('배정할 코트를 선택해주세요.'); return }
    if (autoDiv === 'TEAM') {
      const unTies = ties.filter(t => !t.is_bye && !t.court_number && t.status !== 'completed')
      if (unTies.length === 0) { setMsg('배정할 단체전 경기가 없습니다.'); return }
      const courtNums = autoCourts.map(c => parseInt(c.replace('코트 ', '')))
      for (let i = 0; i < unTies.length; i++) {
        await supabase.from('ties').update({ court_number: courtNums[i % courtNums.length] }).eq('id', unTies[i].id)
      }
      setMsg(`✅ [단체전] ${unTies.length}경기 자동 배정 완료`); loadTies(); return
    }
    const targetMatches = matches.filter(m => m.division_id === autoDiv && m.stage === autoStage && !m.court && m.status !== 'FINISHED')
    if (targetMatches.length === 0) { setMsg('배정할 경기가 없습니다.'); return }
    const existingCounts: Record<string, number> = {}
    for (const c of autoCourts) { existingCounts[c] = allItems.filter(m => m.court === c).length }
    const sortedCourts = [...autoCourts].sort((a, b) => (existingCounts[a] || 0) - (existingCounts[b] || 0))
    const byGroup = new Map<string, MatchSlim[]>()
    for (const m of targetMatches) { const key = m.group_label || 'none'; if (!byGroup.has(key)) byGroup.set(key, []); byGroup.get(key)!.push(m) }
    const updates: { id: string; court: string; court_order: number }[] = []
    const courtOrders: Record<string, number> = {}
    for (const c of autoCourts) { courtOrders[c] = (existingCounts[c] || 0) + 1 }
    let courtIdx = 0
    for (const [, groupMatches] of byGroup) {
      const court = sortedCourts[courtIdx % sortedCourts.length]
      for (const m of groupMatches) { updates.push({ id: m.id, court, court_order: courtOrders[court] }); courtOrders[court]++ }
      courtIdx++
    }
    for (const u of updates) { await supabase.from('matches').update({ court: u.court, court_order: u.court_order }).eq('id', u.id) }
    const divName = divisions.find(d => d.id === autoDiv)?.name || ''
    setMsg(`✅ [${divName}] ${updates.length}경기 → ${autoCourts.join(', ')} 자동 배정 완료`)
    loadMatches()
  }

  async function assignItemToCourt(itemId: string, court: string) {
    if (itemId.startsWith('tie_')) {
      const tieId = itemId.replace('tie_', '')
      const courtNum = parseInt(court.replace('코트 ', ''))
      // ✅ court_order: DB에서 해당 코트 최대값 조회 후 +1
      const { data: existingTies } = await supabase
        .from('ties')
        .select('court_order')
        .eq('event_id', eventId)
        .eq('court_number', courtNum)
        .not('court_order', 'is', null)
        .order('court_order', { ascending: false })
        .limit(1)
      const nextTieOrder = (existingTies?.[0]?.court_order ?? 0) + 1
      await supabase.from('ties').update({ court_number: courtNum, court_order: nextTieOrder }).eq('id', tieId)
      sendCourtNotify(court, 'court_changed'); loadTies()
    } else {
      // ✅ DB에서 직접 최대 court_order 조회 후 +1 (event_id 조건 추가)
      const { data: existing } = await supabase
        .from('matches')
        .select('court_order')
        .eq('event_id', eventId)
        .eq('court', court)
        .not('court_order', 'is', null)
        .order('court_order', { ascending: false })
        .limit(1)
      const nextOrder = (existing?.[0]?.court_order ?? 0) + 1
      await supabase.from('matches').update({ court, court_order: nextOrder }).eq('id', itemId)
      sendCourtNotify(court, 'court_changed', itemId); loadMatches()
    }
  }

  async function unassignItem(itemId: string) {
    if (itemId.startsWith('tie_')) {
      await supabase.from('ties').update({ court_number: null, court_order: null }).eq('id', itemId.replace('tie_', '')); loadTies()
    } else {
      await supabase.from('matches').update({ court: null, court_order: null }).eq('id', itemId); loadMatches()
    }
  }

  async function moveMatchOrder(matchId: string, direction: 'up' | 'down') {
    if (matchId.startsWith('tie_')) return
    const m = matches.find(mm => mm.id === matchId)
    if (!m || !m.court || !m.court_order) return
    const courtMatches = matches.filter(mm => mm.court === m.court).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
    const idx = courtMatches.findIndex(mm => mm.id === matchId)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= courtMatches.length) return
    const other = courtMatches[swapIdx]
    await supabase.from('matches').update({ court_order: other.court_order }).eq('id', m.id)
    await supabase.from('matches').update({ court_order: m.court_order }).eq('id', other.id)
    loadMatches()
  }

  async function clearDivisionAssignments(divId: string) {
    if (divId === 'TEAM') {
      if (!confirm('[단체전] 코트 배정을 모두 초기화하시겠습니까?')) return
      for (const t of ties.filter(t => t.court_number)) {
        await supabase.from('ties').update({ court_number: null }).eq('id', t.id)
      }
      setMsg('✅ [단체전] 코트 배정 초기화 완료'); loadTies(); return
    }
    const divName = divisions.find(d => d.id === divId)?.name || ''
    if (!confirm(`[${divName}] 코트 배정을 모두 초기화하시겠습니까?`)) return
    for (const m of matches.filter(m => m.division_id === divId && m.court)) {
      await supabase.from('matches').update({ court: null, court_order: null }).eq('id', m.id)
    }
    setMsg(`✅ [${divName}] 코트 배정 초기화 완료`); loadMatches()
  }

  async function clearAllAssignments() {
    if (!confirm('전체 코트 배정을 초기화하시겠습니까? (개인전+단체전)')) return
    await supabase.from('matches').update({ court: null, court_order: null }).eq('event_id', eventId)
    for (const t of ties.filter(t => t.court_number)) {
      await supabase.from('ties').update({ court_number: null }).eq('id', t.id)
    }
    setMsg('✅ 전체 코트 배정 초기화'); loadMatches(); loadTies()
  }

  function openScoreEdit(m: MatchSlim) {
    if (m.is_team_tie) return
    setEditMatch(m)
    setEditScore(m.score || '')
    setEditWinner(m.winner_team_id === m.team_a_id ? 'A' : m.winner_team_id === m.team_b_id ? 'B' : '')
    setMsg('')
  }

  // ✅ 완료 경기 강제 수정: RPC 시도 → 실패 시 matches 직접 update
  async function submitResult() {
    if (!editMatch || !editScore || !editWinner) {
      setMsg('점수와 승자를 모두 입력해주세요.')
      return
    }
    setSubmitting(true)
    setMsg('')
    const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
    const isFinished = editMatch.status === 'FINISHED'

    try {
      // 1차: RPC 시도
      const { error: rpcError } = await supabase.rpc('rpc_submit_match_result', {
        p_match_id: editMatch.id,
        p_score: editScore,
        p_winner_team_id: winnerId,
      })

      if (rpcError) {
        // 2차: 완료 경기면 직접 update (운영자 강제 수정)
        if (isFinished) {
          const { error: updateError } = await supabase
            .from('matches')
            .update({
              score: editScore,
              winner_team_id: winnerId,
              status: 'FINISHED',
              ended_at: new Date().toISOString(),
            })
            .eq('id', editMatch.id)

          if (updateError) {
            setMsg('❌ ' + updateError.message)
            return
          }
          setMsg('✅ 결과 강제 수정됨 (운영자 모드)')
        } else {
          setMsg('❌ ' + rpcError.message)
          return
        }
      } else {
        setMsg('✅ 결과 저장됨')
        if (editMatch.court) sendCourtNotify(editMatch.court, 'finished')
      }

      setEditMatch(null)
      loadMatches()
    } finally {
      setSubmitting(false)
    }
  }

  async function startMatch(matchId: string) {
    if (matchId.startsWith('tie_')) return
    await supabase.from('matches').update({ status: 'IN_PROGRESS' }).eq('id', matchId)
    loadMatches()
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  async function handleDropOnCourt(court: string) {
    if (!dragMatch || assigning) { setDragMatch(null); return }
    setAssigning(true)
    await assignItemToCourt(dragMatch, court)
    setDragMatch(null)
    setAssigning(false)
  }
  async function handleDropOnUnassigned() {
    if (!dragMatch || assigning) { setDragMatch(null); return }
    setAssigning(true)
    await unassignItem(dragMatch)
    setDragMatch(null)
    setAssigning(false)
  }

  // ✅ 모바일 터치 드래그 핸들러
  function handleTouchStart(id: string) { setTouchDragId(id) }

  function handleTouchMove(e: React.TouchEvent) {
    e.preventDefault()
    const touch = e.touches[0]
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    const courtEl = el?.closest('[data-court]') as HTMLElement | null
    const unassignedEl = el?.closest('[data-unassigned]') as HTMLElement | null
    if (courtEl) setTouchOver('court:' + courtEl.dataset.court)
    else if (unassignedEl) setTouchOver('unassigned')
    else setTouchOver(null)
  }

  async function handleTouchEnd() {
    if (!touchDragId || !touchOver || assigning) { setTouchDragId(null); setTouchOver(null); return }
    setAssigning(true)
    if (touchOver === 'unassigned') await unassignItem(touchDragId)
    else if (touchOver.startsWith('court:')) await assignItemToCourt(touchDragId, touchOver.slice(6))
    setTouchDragId(null); setTouchOver(null)
    setAssigning(false)
  }

  if (!eventId) return <p className="text-stone-400">설정에서 대회를 선택해주세요.</p>
  if (loading) return <p className="text-stone-400">불러오는 중..</p>

  const hasTeamTies = ties.filter(t => !t.is_bye).length > 0

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">🎾 코트 배정</h1>

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* 부문별 자동 배정 패널 */}
      <div className="bg-white rounded-xl border p-4 mb-4">
        <h3 className="font-bold text-sm mb-3">🎯 부문별 자동 배정</h3>
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="text-xs text-stone-500 block mb-1">부문</label>
            <select value={autoDiv} onChange={e => setAutoDiv(e.target.value)} className="border rounded-lg px-3 py-2 text-sm min-w-[140px]">
              <option value="">부문 선택</option>
              {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              {hasTeamTies && <option value="TEAM">🏆 단체전</option>}
            </select>
          </div>
          {autoDiv && autoDiv !== 'TEAM' && (
            <div>
              <label className="text-xs text-stone-500 block mb-1">단계</label>
              <div className="flex gap-1">
                {(['GROUP', 'FINALS'] as const).map(s => (
                  <button key={s} onClick={() => setAutoStage(s)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border ${autoStage === s ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-300'}`}>
                    {s === 'GROUP' ? '조별' : '결선'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="text-xs text-stone-500 block mb-1">배정 코트</label>
            <div className="flex flex-wrap gap-1">
              {courtNames.map(c => (
                <button key={c} onClick={() => toggleAutoCourt(c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${autoCourts.includes(c) ? 'bg-tennis-600 text-white border-tennis-600' : 'bg-white text-stone-600 border-stone-300 hover:border-tennis-400'}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="self-end">
            <button onClick={autoAssignByDivision} disabled={!autoDiv || autoCourts.length === 0}
              className="bg-tennis-600 text-white px-5 py-2 rounded-lg text-sm font-bold hover:bg-tennis-700 disabled:opacity-50 whitespace-nowrap">
              🎯 자동 배정
            </button>
          </div>
        </div>
        <p className="text-xs text-stone-400 mt-2">* 같은 조 경기는 같은 코트에 순서대로 배정됩니다.</p>
      </div>

      {/* 필터 바 */}
      <div className="bg-white rounded-xl border p-3 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500">코트 수</label>
            <select value={courtCount} onChange={e => setCourtCount(Number(e.target.value))} className="border rounded-lg px-2 py-1 text-sm">
              {Array.from({ length: 20 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}면</option>)}
            </select>
          </div>
          <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
            <button onClick={() => setViewFilter('ALL')} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter === 'ALL' ? 'bg-white shadow-sm' : ''}`}>전체</button>
            {divisions.map(d => (
              <button key={d.id} onClick={() => setViewFilter(d.id)} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter === d.id ? 'bg-white shadow-sm' : ''}`}>
                <span style={{ color: divColors[d.id] }}>●</span> {d.name}
              </button>
            ))}
            {hasTeamTies && (
              <button onClick={() => setViewFilter('TEAM')} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter === 'TEAM' ? 'bg-white shadow-sm' : ''}`}>
                <span style={{ color: '#2563eb' }}>●</span> 단체전
              </button>
            )}
          </div>
          <div className="flex-1" />
          {divisions.map(d => (
            <button key={d.id} onClick={() => clearDivisionAssignments(d.id)} className="text-xs text-stone-400 hover:text-red-500 px-2 py-1">
              초기화 {d.name}
            </button>
          ))}
          {hasTeamTies && (
            <button onClick={() => clearDivisionAssignments('TEAM')} className="text-xs text-stone-400 hover:text-red-500 px-2 py-1">
              초기화 단체전
            </button>
          )}
          <button onClick={clearAllAssignments} className="bg-red-100 text-red-600 px-3 py-1 rounded-lg text-xs font-medium hover:bg-red-200">
            초기화 전체
          </button>
          <span className="text-xs text-stone-400">♻ 15초 자동갱신</span>
        </div>
      </div>

      {/* 코트 배정 그리드 */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        {/* 미배정 */}
        <div className="lg:col-span-1" data-unassigned="true" onDragOver={handleDragOver} onDrop={handleDropOnUnassigned}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="bg-stone-500 text-white px-3 py-2 font-bold text-sm">미배정 ({unassigned.length})</div>
            <div className="p-1.5 max-h-[65vh] overflow-y-auto space-y-1">
              {unassigned.length === 0
                ? <p className="text-xs text-stone-400 text-center py-4">모두 배정됨</p>
                : unassigned.map(m => (
                  <MatchChip key={m.id} m={m} divColor={divColors[m.division_id]}
                    onDragStart={setDragMatch} onClickScore={() => openScoreEdit(m)}
                    onTouchStart={() => handleTouchStart(m.id)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd} />
                ))}
            </div>
          </div>
        </div>

        {/* 코트별 */}
        <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {courtNames.map(court => {
            const courtItems = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
            const finished = courtItems.filter(m => m.status === 'FINISHED').length
            const activeIdx = courtItems.findIndex(m => m.status === 'IN_PROGRESS')
            const pendingIdx = courtItems.findIndex(m => m.status === 'PENDING')
            const currentIdx = activeIdx >= 0 ? activeIdx : pendingIdx
            const isLive = activeIdx >= 0
            const hasPending = courtItems.some(m => m.status === 'PENDING')
            return (
              <div key={court}
                data-court={court}
                onDragOver={handleDragOver}
                onDrop={() => handleDropOnCourt(court)}
                className={`bg-white rounded-xl border overflow-hidden min-h-[100px] transition-all ${touchOver === 'court:' + court ? 'ring-2 ring-tennis-400 bg-tennis-50' : ''}`}>
                <div className={`px-3 py-2 font-bold text-sm flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                  <span>
                    {court}
                    {isLive && <span className="ml-2 text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 text-xs">{finished}/{courtItems.length}</span>
                    <button
                      onClick={() => sendCourtNotify(court, 'manual')}
                      disabled={notifying === court || !hasPending}
                      title={hasPending ? '다음 대기 선수에게 알림 전송' : '대기 경기 없음'}
                      className="text-white/80 hover:text-white disabled:opacity-30 transition-all text-base leading-none"
                    >
                      {notifying === court ? '⏳' : '🔔'}
                    </button>
                  </div>
                </div>
                {notifyMsg[court] && (
                  <div className="px-3 py-1 text-xs bg-amber-50 text-amber-800 border-b border-amber-100">
                    {notifyMsg[court]}
                  </div>
                )}
                <div className="p-1.5 space-y-1 max-h-[60vh] overflow-y-auto">
                  {courtItems.map((m, i) => {
                    let badge = ''
                    if (m.status === 'IN_PROGRESS') badge = '🔴'
                    else if (m.status !== 'FINISHED') {
                      if (currentIdx >= 0 && i === currentIdx) badge = '🔴'
                      else if (currentIdx >= 0 && i === currentIdx + 1) badge = '🟡'
                      else if (currentIdx >= 0 && i === currentIdx + 2) badge = '🟢'
                    }
                    const canStart = !m.is_team_tie && m.status === 'PENDING' && (currentIdx < 0 || i === currentIdx)
                    return (
                      <MatchChip key={m.id} m={m} order={m.court_order || i + 1} badge={badge}
                        divColor={divColors[m.division_id]}
                        onDragStart={setDragMatch}
                        onClickScore={() => openScoreEdit(m)}
                        onClickStart={canStart ? () => startMatch(m.id) : undefined}
                        onClickUnassign={() => unassignItem(m.id)}
                        onMoveUp={!m.is_team_tie && i > 0 ? () => moveMatchOrder(m.id, 'up') : undefined}
                        onMoveDown={!m.is_team_tie && i < courtItems.length - 1 ? () => moveMatchOrder(m.id, 'down') : undefined}
                        onTouchStart={() => handleTouchStart(m.id)}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                      />
                    )
                  })}
                  {courtItems.length === 0 && (
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

      {/* ✅ 점수 입력/수정 모달 — 완료 경기 강제 수정 지원 */}
      {editMatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setEditMatch(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>

            {/* 완료 경기 경고 배너 */}
            {editMatch.status === 'FINISHED' && (
              <div className="mb-4 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
                <span className="text-lg">⚠️</span>
                <div>
                  <p className="text-xs font-semibold text-amber-800">완료된 경기 수정 (운영자 모드)</p>
                  <p className="text-xs text-amber-600 mt-0.5">기존 결과: {editMatch.score || '-'} · 점수를 수정하면 즉시 반영됩니다.</p>
                </div>
              </div>
            )}

            <h3 className="font-bold text-lg mb-1">경기 결과 입력/수정</h3>
            <p className="text-xs text-stone-400 mb-4">
              {editMatch.match_num} · {editMatch.division_name} · {editMatch.round}
              {editMatch.court && (
                <span className="ml-1 font-medium text-[#2d5016]">
                  ({editMatch.court} #{editMatch.court_order})
                </span>
              )}
            </p>

            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1 font-medium">{editMatch.team_a_name || 'TBD'}</div>
              <span className="text-xl text-stone-300">VS</span>
              <div className="text-center flex-1 font-medium">{editMatch.team_b_name || 'TBD'}</div>
            </div>

            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">점수</label>
              <input
                type="text"
                placeholder="6:4"
                value={editScore}
                onChange={e => setEditScore(e.target.value)}
                className="w-full border rounded-xl px-4 py-3 text-center text-lg font-bold"
                autoFocus
              />
            </div>

            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">승자</label>
              <div className="flex gap-2">
                <button onClick={() => setEditWinner('A')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${editWinner === 'A' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-200 hover:border-tennis-400'}`}>
                  {editMatch.team_a_name || 'A'}
                </button>
                <button onClick={() => setEditWinner('B')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${editWinner === 'B' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-200 hover:border-tennis-400'}`}>
                  {editMatch.team_b_name || 'B'}
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setEditMatch(null)}
                className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">
                취소
              </button>
              <button
                onClick={submitResult}
                disabled={submitting || !editScore || !editWinner}
                className={`flex-1 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 text-white ${
                  editMatch.status === 'FINISHED'
                    ? 'bg-amber-500 hover:bg-amber-600'
                    : 'bg-tennis-600 hover:bg-tennis-700'
                }`}>
                {submitting ? '저장 중..' : editMatch.status === 'FINISHED' ? '강제 수정' : '결과 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== MatchChip 컴포넌트 =====
// ✅ FINISHED 경기도 수정 버튼 항상 표시
function MatchChip({ m, order, badge, divColor, onDragStart, onClickScore, onClickStart, onClickUnassign, onMoveUp, onMoveDown, onTouchStart, onTouchMove, onTouchEnd }: {
  m: MatchSlim; order?: number; badge?: string; divColor?: string
  onDragStart: (id: string) => void; onClickScore: () => void
  onClickStart?: () => void; onClickUnassign?: () => void
  onMoveUp?: () => void; onMoveDown?: () => void
  onTouchStart?: () => void; onTouchMove?: (e: React.TouchEvent) => void; onTouchEnd?: () => void
}) {
  const done = m.status === 'FINISHED'
  const live = m.status === 'IN_PROGRESS'
  const isTeam = m.is_team_tie
  return (
    <div draggable onDragStart={() => onDragStart(m.id)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className={`rounded-lg border p-2 text-xs cursor-grab active:cursor-grabbing transition-all ${
        isTeam
          ? (live ? 'bg-blue-50 border-blue-300' : done ? 'bg-blue-50 border-blue-200' : 'bg-white border-blue-200 hover:border-blue-400')
          : live ? 'bg-red-50 border-red-200' : done ? 'bg-tennis-50 border-tennis-200' : 'bg-white border-stone-200 hover:border-stone-300'
      }`}>
      <div className="flex items-center gap-1 mb-1">
        {order && <span className="text-stone-400 font-bold">#{order}</span>}
        {badge && <span className="text-[10px]">{badge}</span>}
        {isTeam
          ? <span className="text-[10px] bg-blue-600 text-white px-1 rounded">단체</span>
          : <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: divColor || '#999' }} />
        }
        <span className="text-stone-400 truncate flex-1">
          {isTeam ? m.match_num : `${m.division_name} · ${m.round}${m.group_label ? ` · ${m.group_label}` : ''}`}
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onMoveUp && (
            <button onClick={e => { e.stopPropagation(); onMoveUp() }}
              className="text-stone-300 hover:text-stone-600 px-0.5" title="위로">▲</button>
          )}
          {onMoveDown && (
            <button onClick={e => { e.stopPropagation(); onMoveDown() }}
              className="text-stone-300 hover:text-stone-600 px-0.5" title="아래로">▼</button>
          )}
          {onClickStart && (
            <button onClick={e => { e.stopPropagation(); onClickStart() }}
              className="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded hover:bg-red-600">▶</button>
          )}
          {/* ✅ 단체전 아닌 경우 완료 여부 관계없이 수정 버튼 표시 */}
          {!isTeam && (
            <button
              onClick={e => { e.stopPropagation(); onClickScore() }}
              className={`px-1 py-0.5 rounded text-[10px] transition-colors ${
                done
                  ? 'text-amber-500 hover:text-amber-700 hover:bg-amber-50'
                  : 'text-stone-300 hover:text-blue-500'
              }`}
              title={done ? '완료된 경기 수정 (운영자)' : '점수 입력'}
            >
              {done ? '재수정' : '수정'}
            </button>
          )}
          {onClickUnassign && (
            <button onClick={e => { e.stopPropagation(); onClickUnassign() }}
              className="text-stone-300 hover:text-red-400">✕</button>
          )}
        </div>
      </div>
      <div className={`font-medium truncate ${done ? 'text-stone-400 line-through' : ''}`}>
        {m.team_a_name} <span className="text-stone-300">vs</span> {m.team_b_name}
      </div>
      {m.score && (
        <div className={`mt-0.5 font-bold ${isTeam ? 'text-blue-600' : done ? 'text-stone-400' : 'text-tennis-600'}`}>
          {m.score}
        </div>
      )}
    </div>
  )
}