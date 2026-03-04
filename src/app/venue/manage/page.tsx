'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

interface VenueMatch {
  id: string; match_num: string; stage: string; round: string
  court: string | null; court_order: number | null
  status: string; score: string | null; locked_by_participant: boolean
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  winner_team_id: string | null; division_name: string
  is_team_tie?: boolean
}

export default function VenueManagePage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [matches, setMatches] = useState<VenueMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [filterDiv, setFilterDiv] = useState('ALL')

  const [editMatch, setEditMatch] = useState<VenueMatch | null>(null)
  const [editScore, setEditScore] = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [dragMatch, setDragMatch] = useState<string | null>(null)

  useEffect(() => {
    const raw = sessionStorage.getItem('venue_session')
    if (!raw) { router.push('/venue'); return }
    setSession(JSON.parse(raw))
  }, [router])

  const loadData = useCallback(async () => {
    if (!session) return
    const { data, error } = await supabase.rpc('rpc_venue_list_matches', { p_token: session.token })
    if (error) {
      sessionStorage.removeItem('venue_session')
      router.push('/venue')
      return
    }
    const individual: VenueMatch[] = (data.matches || []).map((m: any) => ({ ...m, is_team_tie: false }))
    const ties: VenueMatch[] = (data.ties || []).map((t: any) => ({ ...t, is_team_tie: true }))
    setMatches([...individual, ...ties])
    setLoading(false)
    setLastUpdate(new Date())
  }, [session, router])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => {
    if (!session) return
    const interval = setInterval(loadData, 15000)
    return () => clearInterval(interval)
  }, [session, loadData])

  // 부서 목록 추출
  const divisionNames = Array.from(new Set(matches.map(m => m.division_name).filter(Boolean)))

  const myCourts: string[] = session?.courts || []
  const byCourt = new Map<string, VenueMatch[]>()
  for (const c of myCourts) byCourt.set(c, [])
  for (const m of matches) {
    if (m.court && byCourt.has(m.court)) byCourt.get(m.court)!.push(m)
  }

  // 미배정: 부서 필터 적용
  const allUnassigned = matches.filter(m => !m.court && m.status !== 'FINISHED')
  const unassigned = filterDiv === 'ALL' ? allUnassigned : allUnassigned.filter(m => m.division_name === filterDiv)

  function openScoreEdit(m: VenueMatch) {
    setEditMatch(m)
    setEditScore(m.score || '')
    setEditWinner(
      m.winner_team_id === m.team_a_id ? 'A' :
      m.winner_team_id === m.team_b_id ? 'B' : ''
    )
    setMsg('')
  }

  async function submitScore() {
    if (!editMatch || !editScore || !editWinner) { setMsg('점수와 승자를 모두 입력하세요.'); return }
    if (editMatch.is_team_tie) { setMsg('단체전은 라인업 페이지에서 결과를 입력하세요.'); return }
    setSubmitting(true); setMsg('')
    const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
    const { error } = await supabase.rpc('rpc_venue_submit_score', {
      p_token: session.token, p_match_id: editMatch.id,
      p_score: editScore, p_winner_team_id: winnerId,
    })
    setSubmitting(false)
    if (error) { setMsg('! ' + error.message); return }
    setMsg('OK 결과 저장됨')
    setEditMatch(null)
    loadData()
  }

  async function startMatch(matchId: string) {
    const { error } = await supabase.rpc('rpc_venue_start_match', {
      p_token: session.token, p_match_id: matchId,
    })
    if (error) { setMsg('! ' + error.message); return }
    loadData()
  }

  async function assignToCourt(matchId: string, court: string, isTie: boolean) {
    if (isTie) {
      const courtNum = parseInt(court.replace(/\D/g, ''))
      const { error } = await supabase.from('ties').update({ court_number: courtNum }).eq('id', matchId)
      if (error) { setMsg('! ' + error.message); return }
      loadData()
      return
    }
    const courtMatches = byCourt.get(court) || []
    const nextOrder = courtMatches.length + 1
    const { error } = await supabase.rpc('rpc_venue_assign_court', {
      p_token: session.token, p_match_id: matchId, p_court: court, p_court_order: nextOrder,
    })
    if (error) { setMsg('! ' + error.message); return }
    loadData()
  }

  async function unassignFromCourt(matchId: string, isTie: boolean) {
    if (isTie) {
      const { error } = await supabase.from('ties').update({ court_number: null }).eq('id', matchId)
      if (error) { setMsg('! ' + error.message); return }
      loadData()
      return
    }
    const { error } = await supabase.rpc('rpc_venue_unassign_court', {
      p_token: session.token, p_match_id: matchId,
    })
    if (error) { setMsg('! ' + error.message); return }
    loadData()
  }

  function handleLogout() {
    sessionStorage.removeItem('venue_session')
    router.push('/venue')
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  function handleDropOnCourt(court: string) {
    if (!dragMatch) return
    const m = matches.find(x => x.id === dragMatch)
    if (m) assignToCourt(m.id, court, !!m.is_team_tie)
    setDragMatch(null)
  }
  function handleDropOnUnassigned() {
    if (!dragMatch) return
    const m = matches.find(x => x.id === dragMatch)
    if (m) unassignFromCourt(m.id, !!m.is_team_tie)
    setDragMatch(null)
  }

  if (!session) return null

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-orange-500 text-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-lg">{session.venue_name}</h1>
            <p className="text-xs text-white/70">{session.manager_name} / {myCourts.join(', ')}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/60">{lastUpdate.toLocaleTimeString('ko-KR')}</span>
            <button onClick={handleLogout} className="text-sm text-white/70 hover:text-white">로그아웃</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4">
        {msg && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('OK') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {loading ? (
          <p className="text-center py-10 text-stone-400">불러오는 중...</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* 미배정 */}
            <div className="lg:col-span-1" onDragOver={handleDragOver} onDrop={handleDropOnUnassigned}>
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="bg-stone-500 text-white px-4 py-2 font-bold text-sm flex items-center justify-between">
                  <span>미배정 ({unassigned.length}/{allUnassigned.length})</span>
                </div>

                {/* 부서 필터 탭 */}
                <div className="px-2 py-2 border-b flex flex-wrap gap-1">
                  <button onClick={() => setFilterDiv('ALL')}
                    className={`px-2 py-1 rounded text-xs font-medium transition-all ${filterDiv === 'ALL' ? 'bg-stone-700 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
                    전체 ({allUnassigned.length})
                  </button>
                  {divisionNames.map(dn => {
                    const cnt = allUnassigned.filter(m => m.division_name === dn).length
                    if (cnt === 0) return null
                    const isTie = dn === '단체전'
                    return (
                      <button key={dn} onClick={() => setFilterDiv(dn)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                          filterDiv === dn
                            ? (isTie ? 'bg-blue-600 text-white' : 'bg-amber-600 text-white')
                            : (isTie ? 'bg-blue-50 text-blue-600 hover:bg-blue-100' : 'bg-amber-50 text-amber-600 hover:bg-amber-100')
                        }`}>
                        {dn} ({cnt})
                      </button>
                    )
                  })}
                </div>

                <div className="p-2 max-h-[60vh] overflow-y-auto space-y-1">
                  {unassigned.length === 0 ? (
                    <p className="text-xs text-stone-400 text-center py-4">미배정 경기 없음</p>
                  ) : (
                    unassigned.map(m => (
                      <MatchChip key={m.id} m={m} onDragStart={setDragMatch} onClickScore={() => !m.is_team_tie && openScoreEdit(m)} />
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* 코트들 */}
            <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {myCourts.map(court => {
                const courtMatches = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
                const finished = courtMatches.filter(m => m.status === 'FINISHED').length
                const currentIdx = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
                const pendingIdx = courtMatches.findIndex(m => m.status === 'PENDING')
                const activeIdx = currentIdx >= 0 ? currentIdx : pendingIdx
                const isLive = currentIdx >= 0

                return (
                  <div key={court} onDragOver={handleDragOver} onDrop={() => handleDropOnCourt(court)}
                    className="bg-white rounded-xl border overflow-hidden">
                    <div className={`px-4 py-3 flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                      <div>
                        <span className="font-bold">{court}</span>
                        {isLive && <span className="ml-2 text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>}
                      </div>
                      <span className="text-white/60 text-sm">{finished}/{courtMatches.length}</span>
                    </div>
                    <div className="p-2 space-y-1">
                      {courtMatches.map((m, i) => {
                        let badge = ''
                        let badgeColor = ''
                        if (m.status === 'IN_PROGRESS') { badge = '진행중'; badgeColor = 'bg-red-50 border-red-200' }
                        else if (m.status === 'FINISHED') { badgeColor = m.is_team_tie ? 'bg-blue-50 border-blue-200' : 'bg-green-50 border-green-200' }
                        else if (activeIdx >= 0 && i === activeIdx) { badge = '현재'; badgeColor = 'bg-red-50 border-red-200' }
                        else if (activeIdx >= 0 && i === activeIdx + 1) { badge = '대기1'; badgeColor = 'bg-amber-50 border-amber-200' }
                        else if (activeIdx >= 0 && i === activeIdx + 2) { badge = '대기2'; badgeColor = 'bg-green-50 border-green-200' }

                        const canStart = !m.is_team_tie && m.status === 'PENDING' && (activeIdx < 0 || i === activeIdx)

                        return (
                          <div key={m.id} draggable onDragStart={() => setDragMatch(m.id)}
                            className={`rounded-lg border p-2.5 cursor-grab active:cursor-grabbing transition-all ${badgeColor || (m.is_team_tie ? 'border-blue-200' : 'border-stone-200')}`}>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-stone-400 font-bold">#{m.court_order}</span>
                                {m.is_team_tie && <span className="text-[10px] bg-blue-600 text-white px-1 rounded">단체</span>}
                                {badge && <span className="text-xs font-bold">{badge}</span>}
                                <span className="text-xs text-stone-400">{m.division_name} {m.round}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {canStart && (
                                  <button onClick={() => startMatch(m.id)}
                                    className="text-xs bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600">시작</button>
                                )}
                                {!m.is_team_tie && (
                                  <button onClick={() => openScoreEdit(m)}
                                    className="text-xs text-stone-400 hover:text-blue-500">✏️</button>
                                )}
                                <button onClick={() => unassignFromCourt(m.id, !!m.is_team_tie)}
                                  className="text-xs text-stone-400 hover:text-red-500">x</button>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <div className={`text-sm truncate ${m.winner_team_id === m.team_a_id ? (m.is_team_tie ? 'font-bold text-blue-700' : 'font-bold text-green-700') : 'font-medium'}`}>
                                  {m.team_a_name || 'TBD'}
                                </div>
                                <div className="text-xs text-stone-300">vs</div>
                                <div className={`text-sm truncate ${m.winner_team_id === m.team_b_id ? (m.is_team_tie ? 'font-bold text-blue-700' : 'font-bold text-green-700') : 'font-medium'}`}>
                                  {m.team_b_name || 'TBD'}
                                </div>
                              </div>
                              {m.status === 'FINISHED' && m.score && (
                                <div className={`text-lg font-bold ${m.is_team_tie ? 'text-blue-600' : 'text-green-600'}`}>{m.score}</div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {courtMatches.length === 0 && (
                        <div className="text-center py-8 text-stone-300 border-2 border-dashed rounded-lg">
                          <div className="text-2xl mb-1">🎾</div>
                          <div className="text-xs">경기를 드래그하세요</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </main>

      {editMatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditMatch(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">경기 결과 입력</h3>
            <p className="text-xs text-stone-400 mb-4">
              {editMatch.match_num} / {editMatch.division_name} / {editMatch.round}
              {editMatch.court && <span className="ml-1 text-green-700 font-medium">({editMatch.court} #{editMatch.court_order})</span>}
            </p>
            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1 font-medium">{editMatch.team_a_name || 'TBD'}</div>
              <span className="text-xl text-stone-300">VS</span>
              <div className="text-center flex-1 font-medium">{editMatch.team_b_name || 'TBD'}</div>
            </div>
            {editMatch.locked_by_participant && (
              <div className="mb-3 p-2 bg-amber-50 rounded-lg text-xs text-amber-700">참가자가 입력한 결과입니다.</div>
            )}
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
                    editWinner === 'A' ? 'bg-orange-500 text-white border-orange-500' : 'border-stone-200 hover:border-orange-400'
                  }`}>{editMatch.team_a_name || 'A'}</button>
                <button onClick={() => setEditWinner('B')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                    editWinner === 'B' ? 'bg-orange-500 text-white border-orange-500' : 'border-stone-200 hover:border-orange-400'
                  }`}>{editMatch.team_b_name || 'B'}</button>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditMatch(null)}
                className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">취소</button>
              <button onClick={submitScore} disabled={submitting || !editScore || !editWinner}
                className="flex-1 py-2.5 rounded-xl bg-orange-500 text-white font-bold text-sm hover:bg-orange-600 disabled:opacity-50">
                {submitting ? '저장 중...' : '결과 저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MatchChip({ m, onDragStart, onClickScore }: {
  m: VenueMatch; onDragStart: (id: string) => void; onClickScore: () => void
}) {
  const isTie = m.is_team_tie
  return (
    <div draggable onDragStart={() => onDragStart(m.id)}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs cursor-grab border bg-white hover:shadow-sm transition-all ${
        isTie ? 'border-blue-200 hover:border-blue-400' : 'border-stone-200 hover:border-stone-300'
      }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 truncate">
          {isTie && <span className="text-[10px] bg-blue-600 text-white px-1 rounded flex-shrink-0">단체</span>}
          <span className="font-medium">{m.team_a_name || 'TBD'}</span>
          <span className="text-stone-300">v</span>
          <span className="font-medium">{m.team_b_name || 'TBD'}</span>
        </div>
        <span className="text-stone-400">{m.division_name} {m.round}</span>
      </div>
      {!isTie && (
        <button onClick={e => { e.stopPropagation(); onClickScore() }}
          className="text-stone-300 hover:text-blue-500 flex-shrink-0">✏️</button>
      )}
    </div>
  )
}