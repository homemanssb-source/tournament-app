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
}

export default function VenueManagePage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [matches, setMatches] = useState<VenueMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  // 점수 모달
  const [editMatch, setEditMatch] = useState<VenueMatch | null>(null)
  const [editScore, setEditScore] = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)

  // 드래그
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
    setMatches(data.matches || [])
    setLoading(false)
    setLastUpdate(new Date())
  }, [session, router])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => {
    if (!session) return
    const interval = setInterval(loadData, 15000)
    return () => clearInterval(interval)
  }, [session, loadData])

  // 코트별 그룹핑
  const myCourts: string[] = session?.courts || []
  const byCourt = new Map<string, VenueMatch[]>()
  for (const c of myCourts) byCourt.set(c, [])
  for (const m of matches) {
    if (m.court && byCourt.has(m.court)) byCourt.get(m.court)!.push(m)
  }
  const unassigned = matches.filter(m => !m.court)

  // 점수 입력
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
    setSubmitting(true); setMsg('')
    const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
    const { error } = await supabase.rpc('rpc_venue_submit_score', {
      p_token: session.token,
      p_match_id: editMatch.id,
      p_score: editScore,
      p_winner_team_id: winnerId,
    })
    setSubmitting(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 결과 저장됨')
    setEditMatch(null)
    loadData()
  }

  // 경기 시작
  async function startMatch(matchId: string) {
    const { error } = await supabase.rpc('rpc_venue_start_match', {
      p_token: session.token,
      p_match_id: matchId,
    })
    if (error) { setMsg('❌ ' + error.message); return }
    loadData()
  }

  // 코트 배정
  async function assignToCourt(matchId: string, court: string) {
    const courtMatches = byCourt.get(court) || []
    const nextOrder = courtMatches.length + 1
    const { error } = await supabase.rpc('rpc_venue_assign_court', {
      p_token: session.token,
      p_match_id: matchId,
      p_court: court,
      p_court_order: nextOrder,
    })
    if (error) { setMsg('❌ ' + error.message); return }
    loadData()
  }

  async function unassignFromCourt(matchId: string) {
    const { error } = await supabase.rpc('rpc_venue_unassign_court', {
      p_token: session.token,
      p_match_id: matchId,
    })
    if (error) { setMsg('❌ ' + error.message); return }
    loadData()
  }

  function handleLogout() {
    sessionStorage.removeItem('venue_session')
    router.push('/venue')
  }

  // 드래그
  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  function handleDropOnCourt(court: string) {
    if (dragMatch) assignToCourt(dragMatch, court)
    setDragMatch(null)
  }
  function handleDropOnUnassigned() {
    if (dragMatch) unassignFromCourt(dragMatch)
    setDragMatch(null)
  }

  if (!session) return null

  return (
    <div className="min-h-screen bg-stone-50">
      {/* 헤더 */}
      <header className="bg-orange-500 text-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-lg">🏟️ {session.venue_name}</h1>
            <p className="text-xs text-white/70">
              {session.manager_name} · 담당: {myCourts.join(', ')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/60">🔄 {lastUpdate.toLocaleTimeString('ko-KR')}</span>
            <button onClick={handleLogout} className="text-sm text-white/70 hover:text-white">로그아웃</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4">
        {msg && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {loading ? (
          <p className="text-center py-10 text-stone-400">불러오는 중...</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* 미배정 경기 (내 코트에서 빠진 것들) */}
            {unassigned.length > 0 && (
              <div className="lg:col-span-1" onDragOver={handleDragOver} onDrop={handleDropOnUnassigned}>
                <div className="bg-white rounded-xl border overflow-hidden">
                  <div className="bg-stone-500 text-white px-4 py-2 font-bold text-sm">
                    미배정 ({unassigned.length})
                  </div>
                  <div className="p-2 max-h-[50vh] overflow-y-auto space-y-1">
                    {unassigned.map(m => (
                      <MatchChip key={m.id} m={m}
                        onDragStart={setDragMatch}
                        onClickScore={() => openScoreEdit(m)} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 내 코트들 */}
            <div className={`${unassigned.length > 0 ? 'lg:col-span-3' : 'lg:col-span-4'} grid grid-cols-1 sm:grid-cols-2 gap-4`}>
              {myCourts.map(court => {
                const courtMatches = byCourt.get(court) || []
                const finished = courtMatches.filter(m => m.status === 'FINISHED').length
                const currentIdx = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
                const pendingIdx = courtMatches.findIndex(m => m.status === 'PENDING')
                const activeIdx = currentIdx >= 0 ? currentIdx : pendingIdx

                return (
                  <div key={court}
                    onDragOver={handleDragOver}
                    onDrop={() => handleDropOnCourt(court)}
                    className="bg-white rounded-xl border overflow-hidden">
                    {/* 코트 헤더 */}
                    <div className="bg-[#2d5016] text-white px-4 py-3 flex items-center justify-between">
                      <div>
                        <span className="font-bold">{court}</span>
                        {currentIdx >= 0 && (
                          <span className="ml-2 text-xs bg-red-500 px-2 py-0.5 rounded-full animate-pulse">LIVE</span>
                        )}
                      </div>
                      <span className="text-white/60 text-sm">{finished}/{courtMatches.length} 완료</span>
                    </div>

                    {/* 경기 목록 */}
                    <div className="p-2 space-y-1">
                      {courtMatches.map((m, i) => {
                        let badge = ''
                        let badgeColor = ''
                        if (m.status === 'IN_PROGRESS') { badge = '🔴 진행중'; badgeColor = 'bg-red-50 border-red-200' }
                        else if (m.status === 'FINISHED') { badge = ''; badgeColor = 'bg-tennis-50 border-tennis-200' }
                        else if (activeIdx >= 0 && i === activeIdx) { badge = '🔴 현재'; badgeColor = 'bg-red-50 border-red-200' }
                        else if (activeIdx >= 0 && i === activeIdx + 1) { badge = '🟡 대기1'; badgeColor = 'bg-amber-50 border-amber-200' }
                        else if (activeIdx >= 0 && i === activeIdx + 2) { badge = '🟢 대기2'; badgeColor = 'bg-green-50 border-green-200' }

                        const canStart = m.status === 'PENDING' && (activeIdx < 0 || i === activeIdx)

                        return (
                          <div key={m.id}
                            draggable
                            onDragStart={() => setDragMatch(m.id)}
                            className={`rounded-lg border p-2.5 cursor-grab active:cursor-grabbing transition-all ${badgeColor || 'border-stone-200'}`}>
                            {/* 상단: 번호 + 뱃지 + 버튼 */}
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-stone-400 font-bold">#{m.court_order}</span>
                                {badge && <span className="text-xs font-bold">{badge}</span>}
                                <span className="text-xs text-stone-400">{m.division_name} · {m.round}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {canStart && (
                                  <button onClick={() => startMatch(m.id)}
                                    className="text-xs bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600">
                                    ▶ 시작
                                  </button>
                                )}
                                <button onClick={() => openScoreEdit(m)}
                                  className="text-xs text-stone-400 hover:text-blue-500">✏️</button>
                                <button onClick={() => unassignFromCourt(m.id)}
                                  className="text-xs text-stone-400 hover:text-red-500">×</button>
                              </div>
                            </div>
                            {/* 팀명 */}
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <div className={`text-sm truncate ${m.winner_team_id === m.team_a_id ? 'font-bold text-tennis-700' : 'font-medium'}`}>
                                  {m.team_a_name || 'TBD'}
                                </div>
                                <div className="text-xs text-stone-300">vs</div>
                                <div className={`text-sm truncate ${m.winner_team_id === m.team_b_id ? 'font-bold text-tennis-700' : 'font-medium'}`}>
                                  {m.team_b_name || 'TBD'}
                                </div>
                              </div>
                              {m.status === 'FINISHED' && m.score && (
                                <div className="text-lg font-bold text-tennis-600">{m.score}</div>
                              )}
                            </div>
                          </div>
                        )
                      })}

                      {courtMatches.length === 0 && (
                        <div className="text-center py-8 text-stone-300 border-2 border-dashed rounded-lg">
                          <div className="text-2xl mb-1">🎾</div>
                          <div className="text-xs">경기를 여기로 드래그하세요</div>
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

      {/* 점수 입력 모달 */}
      {editMatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditMatch(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">경기 결과 입력</h3>
            <p className="text-xs text-stone-400 mb-4">
              {editMatch.match_num} · {editMatch.division_name} · {editMatch.round}
              {editMatch.court && <span className="ml-1 text-[#2d5016] font-medium">({editMatch.court} #{editMatch.court_order})</span>}
            </p>

            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1 font-medium">{editMatch.team_a_name || 'TBD'}</div>
              <span className="text-xl text-stone-300">VS</span>
              <div className="text-center flex-1 font-medium">{editMatch.team_b_name || 'TBD'}</div>
            </div>

            {editMatch.locked_by_participant && (
              <div className="mb-3 p-2 bg-amber-50 rounded-lg text-xs text-amber-700">
                🔒 참가자가 입력한 결과입니다.
              </div>
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
                    editWinner === 'A' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-200 hover:border-tennis-400'
                  }`}>
                  {editMatch.team_a_name || 'A'}
                </button>
                <button onClick={() => setEditWinner('B')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                    editWinner === 'B' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-200 hover:border-tennis-400'
                  }`}>
                  {editMatch.team_b_name || 'B'}
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setEditMatch(null)}
                className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">취소</button>
              <button onClick={submitScore}
                disabled={submitting || !editScore || !editWinner}
                className="flex-1 py-2.5 rounded-xl bg-orange-500 text-white font-bold text-sm hover:bg-orange-600 disabled:opacity-50">
                {submitting ? '저장 중...' : '결과 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 미배정 경기 칩
function MatchChip({ m, onDragStart, onClickScore }: {
  m: VenueMatch; onDragStart: (id: string) => void; onClickScore: () => void
}) {
  return (
    <div draggable onDragStart={() => onDragStart(m.id)}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs cursor-grab border border-stone-200 bg-white hover:border-stone-300">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 truncate">
          <span className="font-medium">{m.team_a_name || 'TBD'}</span>
          <span className="text-stone-300">v</span>
          <span className="font-medium">{m.team_b_name || 'TBD'}</span>
        </div>
        <span className="text-stone-400">{m.division_name} · {m.round}</span>
      </div>
      <button onClick={e => { e.stopPropagation(); onClickScore() }}
        className="text-stone-300 hover:text-blue-500">✏️</button>
    </div>
  )
}
