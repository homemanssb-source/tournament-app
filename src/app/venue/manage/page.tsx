'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

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
  const [session, setSession]   = useState<any>(null)
  const [matches, setMatches]   = useState<VenueMatch[]>([])
  const [loading, setLoading]   = useState(true)
  const [msg, setMsg]           = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [filterDiv, setFilterDiv] = useState('ALL')
  const [rawData, setRawData]   = useState<any>(null)   // ← 진단용

  const [editMatch, setEditMatch]   = useState<VenueMatch | null>(null)
  const [editScore, setEditScore]   = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [dragMatch, setDragMatch]   = useState<string | null>(null)

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
    // ── 진단: 원본 응답 저장
    setRawData(data)

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

  const divisionNames = Array.from(new Set(matches.map(m => m.division_name).filter(Boolean)))

  // ── 코트 목록: session.courts + 실제 배정된 court union
  const sessionCourts: string[] = session?.courts || []
  const assignedCourtSet = new Set(matches.map(m => m.court).filter(Boolean) as string[])
  const allCourtKeys = [
    ...sessionCourts,
    ...[...assignedCourtSet].filter(c => !sessionCourts.includes(c)),
  ]

  const byCourt = new Map<string, VenueMatch[]>()
  for (const c of allCourtKeys) byCourt.set(c, [])
  for (const m of matches) {
    if (m.court) {
      if (!byCourt.has(m.court)) byCourt.set(m.court, [])
      byCourt.get(m.court)!.push(m)
    }
  }

  const allUnassigned = matches.filter(m => !m.court && m.status !== 'FINISHED')
  const unassigned = filterDiv === 'ALL' ? allUnassigned : allUnassigned.filter(m => m.division_name === filterDiv)

  // 진단: court 있는 경기 샘플
  const assignedMatches = matches.filter(m => m.court)

  function openScoreEdit(m: VenueMatch) {
    setEditMatch(m); setEditScore(m.score || '')
    setEditWinner(m.winner_team_id === m.team_a_id ? 'A' : m.winner_team_id === m.team_b_id ? 'B' : '')
    setMsg('')
  }

  async function submitScore() {
    if (!editMatch || !editScore || !editWinner) { setMsg('점수와 승자를 모두 입력해주세요.'); return }
    setSubmitting(true); setMsg('')
    const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
    const { error } = await supabase.rpc('rpc_venue_submit_score', {
      p_token: session.token, p_match_id: editMatch.id,
      p_score: editScore, p_winner_team_id: winnerId,
    })
    setSubmitting(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 결과 저장됨'); setEditMatch(null); loadData()
  }

  async function startMatch(matchId: string) {
    const { error } = await supabase.rpc('rpc_venue_start_match', { p_token: session.token, p_match_id: matchId })
    if (error) { setMsg('❌ ' + error.message); return }
    loadData()
  }

  async function assignToCourt(matchId: string, court: string, isTie: boolean) {
    if (isTie) {
      const courtNum = parseInt(court.replace(/\D/g, ''))
      const { error } = await supabase.from('ties').update({ court_number: courtNum }).eq('id', matchId)
      if (error) { setMsg('❌ ' + error.message); return }
    } else {
      const courtMatches = byCourt.get(court) || []
      const nextOrder = courtMatches.length + 1
      const { error } = await supabase.rpc('rpc_venue_assign_court', {
        p_token: session.token, p_match_id: matchId, p_court: court, p_court_order: nextOrder,
      })
      if (error) { setMsg('❌ ' + error.message); return }
    }
    loadData()
  }

  async function unassignFromCourt(matchId: string, isTie: boolean) {
    if (isTie) {
      const { error } = await supabase.from('ties').update({ court_number: null }).eq('id', matchId)
      if (error) { setMsg('❌ ' + error.message); return }
    } else {
      const { error } = await supabase.rpc('rpc_venue_unassign_court', { p_token: session.token, p_match_id: matchId })
      if (error) { setMsg('❌ ' + error.message); return }
    }
    loadData()
  }

  function handleLogout() { sessionStorage.removeItem('venue_session'); router.push('/venue') }
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
            <p className="text-xs text-white/70">{lastUpdate.toLocaleTimeString('ko-KR')}</p>
          </div>
          <button onClick={handleLogout} className="text-xs text-white/70 hover:text-white">로그아웃</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4">

        {/* ══════════════════════════════════════════════
            🔍 진단 패널 — 문제 확인 후 이 블록 제거
        ══════════════════════════════════════════════ */}
        <div className="mb-4 p-4 bg-yellow-50 border-2 border-yellow-400 rounded-xl text-xs space-y-2">
          <p className="font-bold text-yellow-800 text-sm">🔍 진단 정보 (확인 후 제거)</p>

          <div className="bg-white rounded p-3 space-y-1">
            <p className="font-semibold text-stone-700">📌 session 원본:</p>
            <pre className="text-[11px] text-stone-600 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(session, null, 2)}
            </pre>
          </div>

          <div className="bg-white rounded p-3 space-y-1">
            <p className="font-semibold text-stone-700">📌 session.courts 값:</p>
            <pre className="text-[11px] text-stone-600">{JSON.stringify(sessionCourts)}</pre>
            <p className="text-stone-500">→ 타입: {Array.isArray(sessionCourts) ? `배열 (${sessionCourts.length}개)` : typeof sessionCourts}</p>
          </div>

          <div className="bg-white rounded p-3 space-y-1">
            <p className="font-semibold text-stone-700">📌 RPC 반환 데이터:</p>
            <p>matches 수: <strong>{rawData?.matches?.length ?? '?'}</strong></p>
            <p>ties 수: <strong>{rawData?.ties?.length ?? '?'}</strong></p>
            {rawData?.matches?.[0] && (
              <>
                <p className="font-semibold mt-1">첫번째 match 샘플:</p>
                <pre className="text-[11px] text-stone-600 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(rawData.matches[0], null, 2)}
                </pre>
              </>
            )}
          </div>

          <div className="bg-white rounded p-3 space-y-1">
            <p className="font-semibold text-stone-700">📌 court 배정된 경기 목록:</p>
            {assignedMatches.length === 0
              ? <p className="text-red-600 font-bold">⚠️ court 값이 있는 경기가 0개 — RPC가 배정된 경기를 안 줌</p>
              : assignedMatches.map(m => (
                  <div key={m.id} className="text-[11px] border-b py-0.5">
                    <span className="font-mono text-blue-700">{JSON.stringify(m.court)}</span>
                    <span className="text-stone-400 ml-2">← court 값 | session.courts에 포함?: </span>
                    <span className={sessionCourts.includes(m.court!) ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                      {sessionCourts.includes(m.court!) ? '✅ 포함' : '❌ 불일치!'}
                    </span>
                    <span className="text-stone-400 ml-2">{m.team_a_name} vs {m.team_b_name}</span>
                  </div>
                ))
            }
          </div>

          <div className="bg-white rounded p-3 space-y-1">
            <p className="font-semibold text-stone-700">📌 최종 표시될 코트 목록 (allCourtKeys):</p>
            <pre className="text-[11px] text-stone-600">{JSON.stringify(allCourtKeys)}</pre>
          </div>
        </div>
        {/* ══ 진단 패널 끝 ══ */}

        {msg && (
          <div className={`mb-3 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {loading ? (
          <p className="text-center py-10 text-stone-400">불러오는 중...</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* 미배정 */}
            <div className="lg:col-span-1" data-unassigned onDragOver={handleDragOver} onDrop={handleDropOnUnassigned}>
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="bg-stone-500 text-white px-4 py-2 font-bold text-sm">미배정 ({unassigned.length})</div>
                <div className="p-1.5 space-y-1 max-h-[70vh] overflow-y-auto">
                  {unassigned.map(m => (
                    <MatchChip key={m.id} m={m} onDragStart={setDragMatch} onClickScore={() => openScoreEdit(m)} />
                  ))}
                  {unassigned.length === 0 && <div className="text-xs text-stone-300 text-center py-6">없음</div>}
                </div>
              </div>
            </div>

            {/* 코트 */}
            <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {allCourtKeys.length === 0 && (
                <div className="col-span-2 p-6 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                  ⚠️ 표시할 코트가 없습니다. 위 진단 정보를 확인해주세요.
                </div>
              )}
              {allCourtKeys.map(court => {
                const courtMatches = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
                const finished   = courtMatches.filter(m => m.status === 'FINISHED').length
                const currentIdx = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
                const pendingIdx = courtMatches.findIndex(m => m.status === 'PENDING')
                const activeIdx  = currentIdx >= 0 ? currentIdx : pendingIdx
                const isLive     = currentIdx >= 0

                return (
                  <div key={court} onDragOver={handleDragOver} onDrop={() => handleDropOnCourt(court)}
                    className="bg-white rounded-xl border overflow-hidden">
                    <div className={`px-4 py-3 flex items-center justify-between ${isLive ? 'bg-red-700' : 'bg-[#2d5016]'} text-white`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-bold truncate">{court}</span>
                        {isLive && <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse flex-shrink-0">LIVE</span>}
                      </div>
                      <span className="text-white/60 text-sm flex-shrink-0">{finished}/{courtMatches.length}</span>
                    </div>
                    <div className="p-2 space-y-1">
                      {courtMatches.map((m, i) => {
                        let badge = ''
                        let badgeColor = ''
                        if (m.status === 'IN_PROGRESS') { badge = '진행중'; badgeColor = 'bg-red-50 border-red-200' }
                        else if (m.status === 'FINISHED') { badgeColor = 'bg-green-50 border-green-200' }
                        else if (activeIdx >= 0 && i === activeIdx)     { badge = '현재'; badgeColor = 'bg-red-50 border-red-200' }
                        else if (activeIdx >= 0 && i === activeIdx + 1) { badge = '다음'; badgeColor = 'bg-amber-50 border-amber-200' }
                        else if (activeIdx >= 0 && i === activeIdx + 2) { badge = '대기'; badgeColor = 'bg-stone-50' }

                        const firstPendingIdx = courtMatches.findIndex(mm => mm.status === 'PENDING')
                        const canStart = !m.is_team_tie && m.status === 'PENDING' && i === firstPendingIdx

                        return (
                          <div key={m.id} draggable onDragStart={() => setDragMatch(m.id)}
                            className={`rounded-lg border p-2.5 cursor-grab transition-all ${badgeColor || 'border-stone-200'}`}>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                <span className="text-xs text-stone-400 font-bold flex-shrink-0">#{m.court_order}</span>
                                {badge && <span className="text-xs font-bold flex-shrink-0">{badge}</span>}
                                <span className="text-xs text-stone-400 truncate">{m.division_name} {m.round}</span>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {canStart && (
                                  <button onClick={() => startMatch(m.id)}
                                    className="text-xs bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600">시작</button>
                                )}
                                {!m.is_team_tie && (
                                  <button onClick={() => openScoreEdit(m)} className="text-xs text-stone-400 hover:text-blue-500">✏</button>
                                )}
                                <button onClick={() => unassignFromCourt(m.id, !!m.is_team_tie)}
                                  className="text-xs text-stone-400 hover:text-red-500">✕</button>
                              </div>
                            </div>
                            <div className="space-y-0.5">
                              <div className={`text-sm font-medium leading-tight ${m.winner_team_id === m.team_a_id ? 'font-bold text-green-700' : ''}`}>
                                {m.team_a_name || 'TBD'}
                              </div>
                              <div className="text-xs text-stone-300">vs</div>
                              <div className={`text-sm font-medium leading-tight ${m.winner_team_id === m.team_b_id ? 'font-bold text-green-700' : ''}`}>
                                {m.team_b_name || 'TBD'}
                              </div>
                            </div>
                            {m.status === 'FINISHED' && m.score && (
                              <div className="mt-1 text-base font-bold text-green-600">{m.score}</div>
                            )}
                          </div>
                        )
                      })}
                      {courtMatches.length === 0 && (
                        <div className="text-center py-8 text-stone-300 border-2 border-dashed rounded-lg">
                          <div className="text-2xl mb-1">🎾</div>
                          <div className="text-xs">경기 없음</div>
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
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${editWinner === 'A' ? 'bg-orange-500 text-white border-orange-500' : 'border-stone-200 hover:border-orange-400'}`}>
                  {editMatch.team_a_name || 'A'}
                </button>
                <button onClick={() => setEditWinner('B')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${editWinner === 'B' ? 'bg-orange-500 text-white border-orange-500' : 'border-stone-200 hover:border-orange-400'}`}>
                  {editMatch.team_b_name || 'B'}
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditMatch(null)}
                className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">취소</button>
              <button onClick={submitScore} disabled={submitting || !editScore || !editWinner}
                className="flex-1 py-2.5 rounded-xl bg-orange-500 text-white font-bold text-sm hover:bg-orange-600 disabled:opacity-50">
                {submitting ? '저장 중..' : '결과 저장'}
              </button>
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
  return (
    <div draggable onDragStart={() => onDragStart(m.id)}
      className="rounded-lg border p-2 text-xs cursor-grab bg-white border-stone-200 hover:border-stone-300 transition-all">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-stone-400 truncate flex-1">{m.division_name} · {m.round}</span>
        {!m.is_team_tie && (
          <button onClick={e => { e.stopPropagation(); onClickScore() }} className="text-stone-300 hover:text-blue-500 flex-shrink-0">✏</button>
        )}
      </div>
      <div className="font-medium leading-tight">{m.team_a_name} <span className="text-stone-300">vs</span> {m.team_b_name}</div>
    </div>
  )
}