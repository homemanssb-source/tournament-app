'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function AdminPinManagePage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [allMatches, setAllMatches] = useState<any[]>([])
  const [selectedMatch, setSelectedMatch] = useState<any>(null)
  const [newScore, setNewScore] = useState('')
  const [newWinner, setNewWinner] = useState<'A' | 'B' | ''>('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const raw = sessionStorage.getItem('admin_pin_session')
    if (!raw) { router.push('/admin-pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadAllMatches(s.event_id)
  }, [])

  async function loadAllMatches(eventId: string) {
    const { data } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId).order('slot')
    setAllMatches(data || [])
  }

  const filtered = allMatches.filter(m => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (m.match_num || '').toLowerCase().includes(q)
      || (m.team_a_name || '').toLowerCase().includes(q)
      || (m.team_b_name || '').toLowerCase().includes(q)
      || (m.division_name || '').toLowerCase().includes(q)
      || (m.round || '').toLowerCase().includes(q)
  })

  async function selectMatch(m: any) {
    setSelectedMatch(m)
    setNewScore(m.score || '')
    setNewWinner(m.winner_team_id === m.team_a_id ? 'A' : m.winner_team_id === m.team_b_id ? 'B' : '')
    setReason('')
    setMsg('')
  }

  async function handleUnlock() {
    if (!session || !selectedMatch) return
    setLoading(true); setMsg('')

    const { error } = await supabase.rpc('rpc_admin_pin_unlock_match', {
      p_token: session.token,
      p_match_id: selectedMatch.id,
      p_reason: reason || '관리자 해제',
    })
    setLoading(false)

    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 잠금이 해제되었습니다.')
    loadAllMatches(session.event_id)
    setSelectedMatch(null)
  }

  async function handleUpdateScore() {
    if (!session || !selectedMatch || !newScore || !newWinner) {
      setMsg('점수와 승자를 모두 입력해주세요.'); return
    }
    setLoading(true); setMsg('')

    const winnerId = newWinner === 'A' ? selectedMatch.team_a_id : selectedMatch.team_b_id

    const { error } = await supabase.rpc('rpc_admin_pin_update_score', {
      p_token: session.token,
      p_match_id: selectedMatch.id,
      p_score: newScore,
      p_winner_team_id: winnerId,
    })
    setLoading(false)

    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 결과가 수정되었습니다.')
    loadAllMatches(session.event_id)
    setSelectedMatch(null)
  }

  function handleLogout() {
    sessionStorage.removeItem('admin_pin_session')
    router.push('/admin-pin')
  }

  if (!session) return null

  return (
    <div className="min-h-screen">
      <header className="bg-red-700 text-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold">🛡️ 관리자 도구</h1>
            <p className="text-xs text-white/60">{session.event_name} · 30분 세션</p>
          </div>
          <button onClick={handleLogout} className="text-sm text-white/60 hover:text-white">로그아웃</button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {msg && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {/* 경기 선택 모드 */}
        {!selectedMatch && (
          <>
            <input type="text" placeholder="🔍 경기ID, 팀명, 부서, 라운드로 검색..."
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 mb-4 focus:outline-none focus:border-red-500" />

            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {filtered.slice(0, 50).map(m => (
                <button key={m.id} onClick={() => selectMatch(m)}
                  className="w-full text-left bg-white rounded-xl border p-3 hover:border-red-300 transition-all">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-stone-400">{m.match_num} · {m.division_name} · {m.round}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      m.status === 'FINISHED' ? 'bg-tennis-100 text-tennis-700' : 'bg-stone-100 text-stone-500'
                    }`}>
                      {m.status === 'FINISHED' ? '완료' : '대기'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-sm">
                    <span className="font-medium">{m.team_a_name || 'TBD'}</span>
                    <span className="text-stone-300">vs</span>
                    <span className="font-medium">{m.team_b_name || 'TBD'}</span>
                  </div>
                  {m.score && <div className="text-xs text-stone-500 mt-1">점수: {m.score} {m.locked_by_participant && '🔒'}</div>}
                </button>
              ))}
              {filtered.length === 0 && <p className="text-center py-6 text-stone-400">검색 결과 없음</p>}
            </div>
          </>
        )}

        {/* 경기 상세 + 수정 모드 */}
        {selectedMatch && (
          <div className="bg-white rounded-xl border p-5">
            <button onClick={() => setSelectedMatch(null)} className="text-sm text-stone-400 hover:text-stone-600 mb-4">← 목록으로</button>

            <div className="text-xs text-stone-400 mb-1">{selectedMatch.match_num} · {selectedMatch.division_name} · {selectedMatch.round}</div>

            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1">
                <div className="font-bold">{selectedMatch.team_a_name || 'TBD'}</div>
                <span className="text-xs text-stone-400">팀 A</span>
              </div>
              <span className="text-2xl text-stone-300 font-bold">VS</span>
              <div className="text-center flex-1">
                <div className="font-bold">{selectedMatch.team_b_name || 'TBD'}</div>
                <span className="text-xs text-stone-400">팀 B</span>
              </div>
            </div>

            {selectedMatch.score && (
              <div className="text-center mb-4 text-sm">
                현재: <strong>{selectedMatch.score}</strong>
                {selectedMatch.winner_name && <span> → 승: {selectedMatch.winner_name}</span>}
                {selectedMatch.locked_by_participant && <span className="ml-2 text-red-500">🔒 참가자잠금</span>}
              </div>
            )}

            <hr className="my-4" />

            {/* 잠금 해제 */}
            {selectedMatch.locked_by_participant && (
              <div className="mb-4 p-3 bg-amber-50 rounded-lg">
                <p className="text-sm font-bold text-amber-700 mb-2">🔓 잠금 해제</p>
                <input type="text" placeholder="해제 사유 (선택)" value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm mb-2" />
                <button onClick={handleUnlock} disabled={loading}
                  className="w-full bg-amber-500 text-white py-2 rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50">
                  {loading ? '처리 중...' : '잠금 해제 + 결과 초기화'}
                </button>
              </div>
            )}

            {/* 결과 수정 */}
            <div className="p-3 bg-stone-50 rounded-lg">
              <p className="text-sm font-bold mb-3">✏️ 결과 수정</p>

              <div className="mb-3">
                <label className="text-xs text-stone-500">점수</label>
                <input type="text" placeholder="6:4" value={newScore}
                  onChange={e => setNewScore(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-center text-lg font-bold mt-1" />
              </div>

              <div className="mb-3">
                <label className="text-xs text-stone-500">승자</label>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => setNewWinner('A')}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${
                      newWinner === 'A' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-300 hover:border-tennis-400'
                    }`}>
                    A: {selectedMatch.team_a_name || 'TBD'}
                  </button>
                  <button onClick={() => setNewWinner('B')}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${
                      newWinner === 'B' ? 'bg-tennis-600 text-white border-tennis-600' : 'border-stone-300 hover:border-tennis-400'
                    }`}>
                    B: {selectedMatch.team_b_name || 'TBD'}
                  </button>
                </div>
              </div>

              <button onClick={handleUpdateScore} disabled={loading || !newScore || !newWinner}
                className="w-full bg-red-600 text-white py-2.5 rounded-lg font-bold hover:bg-red-700 disabled:opacity-50">
                {loading ? '처리 중...' : '결과 저장'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
