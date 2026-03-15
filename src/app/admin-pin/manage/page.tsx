'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchTies, fetchRevealedLineups, fetchClubMembers } from '@/lib/team-api'
import { getTieStatusLabel, getTieStatusColor, formatSetScore, getMajority } from '@/lib/team-utils'
import type { TieWithClubs, TeamLineup, ClubMember } from '@/types/team'

type Tab = 'individual' | 'team';

export default function AdminPinManagePage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [tab, setTab] = useState<Tab>('individual')

  // ── 개인전 ──
  const [searchQuery, setSearchQuery] = useState('')
  const [allMatches, setAllMatches] = useState<any[]>([])
  const [selectedMatch, setSelectedMatch] = useState<any>(null)
  const [newScore, setNewScore] = useState('')
  const [newWinner, setNewWinner] = useState<'A' | 'B' | ''>('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  // ── 단체전 ──
  const [ties, setTies] = useState<TieWithClubs[]>([])
  const [tiesLoading, setTiesLoading] = useState(false)
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null)
  const [tieLineups, setTieLineups] = useState<TeamLineup[]>([])
  const [memberMap, setMemberMap] = useState<Record<string, ClubMember>>({})
  const [tieRubbers, setTieRubbers] = useState<any[]>([])
  // ✅ 단체전 검색
  const [tieSearchQuery, setTieSearchQuery] = useState('')

  useEffect(() => {
    const raw = sessionStorage.getItem('admin_pin_session')
    if (!raw) { router.push('/admin-pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadAllMatches(s.event_id)
    loadTies(s.event_id)
  }, [])

  async function loadAllMatches(eventId: string) {
    const { data } = await supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId).order('slot')
    setAllMatches(data || [])
  }

  async function loadTies(eventId: string) {
    setTiesLoading(true)
    try { const data = await fetchTies(eventId); setTies(data) } catch {}
    setTiesLoading(false)
  }

  // 개인전 필터
  const filtered = allMatches.filter(m => {
    if (!searchQuery) return false  // 검색어 없으면 빈 결과
    const q = searchQuery.toLowerCase()
    return (m.match_num||'').toLowerCase().includes(q)
      || (m.team_a_name||'').toLowerCase().includes(q)
      || (m.team_b_name||'').toLowerCase().includes(q)
      || (m.division_name||'').toLowerCase().includes(q)
      || (m.round||'').toLowerCase().includes(q)
  })

  // ✅ 단체전 필터 - 검색어 없으면 빈 결과
  const filteredTies = ties.filter(tie => {
    if (!tieSearchQuery) return false
    const q = tieSearchQuery.toLowerCase()
    return (tie.club_a?.name || '').toLowerCase().includes(q)
      || (tie.club_b?.name || '').toLowerCase().includes(q)
      || (tie.tie_order?.toString() || '').includes(q)
      || (tie.round || '').toLowerCase().includes(q)
  })

  async function selectMatch(m: any) {
    setSelectedMatch(m); setNewScore(m.score||'');
    setNewWinner(m.winner_team_id===m.team_a_id?'A':m.winner_team_id===m.team_b_id?'B':'');
    setReason(''); setMsg('')
  }

  async function handleUnlock() {
    if (!session||!selectedMatch) return
    setLoading(true); setMsg('')
    const { error } = await supabase.rpc('rpc_admin_pin_unlock_match', { p_token:session.token, p_match_id:selectedMatch.id, p_reason:reason||'관리자 해제' })
    setLoading(false)
    if (error) { setMsg('❌ '+error.message); return }
    setMsg('✅ 잠금이 해제되었습니다.'); loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  async function handleUpdateScore() {
    if (!session||!selectedMatch||!newScore||!newWinner) { setMsg('점수와 승자를 모두 입력해주세요.'); return }
    setLoading(true); setMsg('')
    const winnerId = newWinner==='A'?selectedMatch.team_a_id:selectedMatch.team_b_id
    const { error } = await supabase.rpc('rpc_admin_pin_update_score', { p_token:session.token, p_match_id:selectedMatch.id, p_score:newScore, p_winner_team_id:winnerId })
    setLoading(false)
    if (error) { setMsg('❌ '+error.message); return }
    setMsg('✅ 결과가 수정되었습니다.'); loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  async function handleSelectTie(tie: TieWithClubs) {
    if (selectedTie?.id===tie.id) { setSelectedTie(null); return }
    setSelectedTie(tie)
    const [lineups, rubbers] = await Promise.all([
      fetchRevealedLineups(tie.id),
      supabase.from('tie_rubbers').select('*').eq('tie_id', tie.id).order('rubber_number').then(r => r.data||[]),
    ])
    setTieLineups(lineups)
    setTieRubbers(rubbers)
    const mm: Record<string, ClubMember> = {}
    if (tie.club_a_id) { (await fetchClubMembers(tie.club_a_id)).forEach(m => { mm[m.id]=m }) }
    if (tie.club_b_id) { (await fetchClubMembers(tie.club_b_id)).forEach(m => { mm[m.id]=m }) }
    setMemberMap(mm)
  }

  function getMemberName(id: string|null|undefined): string {
    return id && memberMap[id] ? memberMap[id].name : '-'
  }

  function handleLogout() { sessionStorage.removeItem('admin_pin_session'); router.push('/admin-pin') }

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

      {/* 탭 */}
      <div className="max-w-2xl mx-auto px-4 pt-4">
        <div className="flex gap-2 mb-4">
          <button onClick={() => { setTab('individual'); setSelectedMatch(null) }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${tab==='individual'?'bg-red-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🎾 개인전
          </button>
          <button onClick={() => { setTab('team'); setSelectedTie(null) }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${tab==='team'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            📋 단체전
          </button>
        </div>
      </div>

      <main className="max-w-2xl mx-auto px-4 pb-8 space-y-3">
        {msg && (
          <div className={`p-3 rounded-lg text-sm ${msg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {/* ══════ 개인전 탭 ══════ */}
        {tab === 'individual' && (
          <>
            <div className="relative">
              <input
                type="text"
                placeholder="팀명, 경기번호, 부서명 검색..."
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSelectedMatch(null) }}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-red-500 outline-none"
                autoFocus
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setSelectedMatch(null) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
              )}
            </div>

            {!searchQuery && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">🔍</div>
                <p>팀명 또는 경기번호를 검색하세요</p>
              </div>
            )}

            {searchQuery && filtered.length === 0 && (
              <div className="text-center py-8 text-gray-400">검색 결과가 없습니다.</div>
            )}

            {filtered.map(m => (
              <div key={m.id} onClick={() => selectMatch(m)}
                className={`bg-white rounded-xl border p-4 cursor-pointer transition ${selectedMatch?.id===m.id?'border-red-400 bg-red-50':'hover:border-gray-300'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">{m.match_num} · {m.division_name} · {m.round}</span>
                  <div className="flex items-center gap-2">
                    {m.locked_by_participant && <span className="text-xs text-red-500">🔒</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${m.status==='FINISHED'?'bg-green-100 text-green-700':m.status==='IN_PROGRESS'?'bg-red-100 text-red-700':'bg-gray-100 text-gray-500'}`}>
                      {m.status==='FINISHED'?'완료':m.status==='IN_PROGRESS'?'진행중':'대기'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.team_a_name}</span>
                  <span className="text-gray-400 font-bold mx-2">{m.score || 'vs'}</span>
                  <span className="font-medium">{m.team_b_name}</span>
                </div>
              </div>
            ))}

            {selectedMatch && (
              <div className="bg-white rounded-xl border-2 border-red-300 p-5">
                <h3 className="font-bold text-lg mb-1">경기 수정</h3>
                <div className="text-xs text-stone-400 mb-4">{selectedMatch.match_num} · {selectedMatch.division_name} · {selectedMatch.round}</div>
                <div className="flex items-center justify-center gap-4 my-4">
                  <div className="text-center flex-1"><div className="font-bold">{selectedMatch.team_a_name||'TBD'}</div><span className="text-xs text-stone-400">팀 A</span></div>
                  <span className="text-2xl text-stone-300 font-bold">VS</span>
                  <div className="text-center flex-1"><div className="font-bold">{selectedMatch.team_b_name||'TBD'}</div><span className="text-xs text-stone-400">팀 B</span></div>
                </div>
                {selectedMatch.score && (
                  <div className="text-center mb-4 text-sm">현재: <strong>{selectedMatch.score}</strong>
                    {selectedMatch.winner_name && <span> → 승: {selectedMatch.winner_name}</span>}
                    {selectedMatch.locked_by_participant && <span className="ml-2 text-red-500">🔒 참가자잠금</span>}
                  </div>
                )}
                <hr className="my-4" />
                {selectedMatch.locked_by_participant && (
                  <div className="mb-4 p-3 bg-amber-50 rounded-lg">
                    <p className="text-sm font-bold text-amber-700 mb-2">🔓 잠금 해제</p>
                    <input type="text" placeholder="해제 사유 (선택)" value={reason} onChange={e => setReason(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mb-2" />
                    <button onClick={handleUnlock} disabled={loading} className="w-full bg-amber-500 text-white py-2 rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50">
                      {loading?'처리 중...':'잠금 해제 + 결과 초기화'}
                    </button>
                  </div>
                )}
                <div className="p-3 bg-stone-50 rounded-lg">
                  <p className="text-sm font-bold mb-3">✏️ 결과 수정</p>
                  <div className="mb-3">
                    <label className="text-xs text-stone-500">점수</label>
                    <input type="text" placeholder="6:4" value={newScore} onChange={e => setNewScore(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-center text-lg font-bold mt-1" />
                  </div>
                  <div className="mb-3">
                    <label className="text-xs text-stone-500">승자</label>
                    <div className="flex gap-2 mt-1">
                      <button onClick={() => setNewWinner('A')} className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${newWinner==='A'?'bg-red-600 text-white border-red-600':'border-stone-300 hover:border-red-400'}`}>A: {selectedMatch.team_a_name||'TBD'}</button>
                      <button onClick={() => setNewWinner('B')} className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${newWinner==='B'?'bg-red-600 text-white border-red-600':'border-stone-300 hover:border-red-400'}`}>B: {selectedMatch.team_b_name||'TBD'}</button>
                    </div>
                  </div>
                  <button onClick={handleUpdateScore} disabled={loading||!newScore||!newWinner} className="w-full bg-red-600 text-white py-2.5 rounded-lg font-bold hover:bg-red-700 disabled:opacity-50">
                    {loading?'처리 중...':'결과 저장'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ══════ 단체전 탭 ══════ */}
        {tab === 'team' && (
          <>
            {/* ✅ 단체전 검색 */}
            <div className="relative">
              <input
                type="text"
                placeholder="클럽명, 라운드, 번호 검색..."
                value={tieSearchQuery}
                onChange={e => { setTieSearchQuery(e.target.value); setSelectedTie(null) }}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-blue-500 outline-none"
                autoFocus
              />
              {tieSearchQuery && (
                <button onClick={() => { setTieSearchQuery(''); setSelectedTie(null) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
              )}
            </div>

            {!tieSearchQuery && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">🔍</div>
                <p>클럽명 또는 라운드를 검색하세요</p>
                <p className="text-xs mt-1 text-gray-300">예: "우도", "16강", "1"</p>
              </div>
            )}

            {tiesLoading && <div className="text-center py-8 text-gray-400">로딩중...</div>}

            {tieSearchQuery && !tiesLoading && filteredTies.length === 0 && (
              <div className="text-center py-8 text-gray-400">검색 결과가 없습니다.</div>
            )}

            <div className="space-y-3">
              {filteredTies.map(tie => {
                const isSelected = selectedTie?.id === tie.id
                const maj = getMajority(tie.rubber_count)
                const aWin = tie.club_a_rubbers_won >= maj
                const bWin = tie.club_b_rubbers_won >= maj
                return (
                  <div key={tie.id} className="bg-white rounded-xl border overflow-hidden">
                    <div onClick={() => handleSelectTie(tie)} className="p-4 cursor-pointer hover:bg-gray-50 transition">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-400">#{tie.tie_order}</span>
                          <span className={`font-semibold ${aWin?'text-blue-600':''}`}>{tie.club_a?.name||'TBD'}</span>
                          <span className="text-gray-400 text-sm">vs</span>
                          <span className={`font-semibold ${bWin?'text-blue-600':''}`}>{tie.club_b?.name||'TBD'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {(tie.status==='completed'||tie.status==='in_progress') && (
                            <span className="text-lg font-bold">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span>
                          )}
                          <span className={`text-xs px-2 py-1 rounded-full ${getTieStatusColor(tie.status)}`}>
                            {getTieStatusLabel(tie.status)}
                          </span>
                          <span className="text-gray-400 text-xs">{isSelected?'▲':'▼'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span>{tie.club_a?.name?.slice(0,6)}: {tie.club_a_lineup_submitted?<span className="text-green-600">✅제출</span>:<span className="text-orange-500">⏳대기</span>}</span>
                        <span>{tie.club_b?.name?.slice(0,6)}: {tie.club_b_lineup_submitted?<span className="text-green-600">✅제출</span>:<span className="text-orange-500">⏳대기</span>}</span>
                        {tie.lineup_revealed && <span className="text-blue-600">🔓공개</span>}
                        {tie.round && <span className="text-gray-400">{tie.round}</span>}
                      </div>
                    </div>

                    {isSelected && (
                      <div className="border-t bg-gray-50 p-4 space-y-3">
                        {!tie.lineup_revealed && (
                          <div className="text-center text-sm text-gray-400 py-2">라인업 미공개 (양팀 제출 후 공개)</div>
                        )}
                        {tie.lineup_revealed && tieLineups.length === 0 && (
                          <div className="text-center text-sm text-gray-400 py-2">라인업 데이터 없음</div>
                        )}
                        {Array.from({length: tie.rubber_count}, (_, i) => i+1).map(num => {
                          const laA = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_a_id)
                          const laB = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_b_id)
                          const rubber = tieRubbers.find((r: any) => r.rubber_number === num)
                          const hasScore = rubber?.set1_a !== null && rubber?.set1_a !== undefined
                          return (
                            <div key={num} className={`bg-white rounded-lg border p-3 ${rubber?.status==='completed'?'border-green-200':''}`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium text-sm">러버 {num}</span>
                                {rubber?.status==='completed' && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">완료</span>}
                              </div>
                              {(laA || laB) ? (
                                <div className="grid grid-cols-5 items-center gap-1 text-xs mb-2">
                                  <div className="col-span-2 text-right">
                                    <div className="font-medium">{getMemberName(laA?.player1_id)} / {getMemberName(laA?.player2_id)}</div>
                                    <div className="text-gray-400">{tie.club_a?.name}</div>
                                  </div>
                                  <div className="text-center text-gray-400 font-bold">vs</div>
                                  <div className="col-span-2 text-left">
                                    <div className="font-medium">{getMemberName(laB?.player1_id)} / {getMemberName(laB?.player2_id)}</div>
                                    <div className="text-gray-400">{tie.club_b?.name}</div>
                                  </div>
                                </div>
                              ) : (
                                <div className="text-xs text-gray-400 mb-2">{tie.lineup_revealed?'선수 정보 없음':'라인업 미공개'}</div>
                              )}
                              {hasScore ? (
                                <div className="text-center py-1 bg-gray-50 rounded text-sm font-bold">
                                  {formatSetScore(rubber.set1_a, rubber.set1_b)}
                                  {rubber.set2_a !== null && ' / ' + formatSetScore(rubber.set2_a, rubber.set2_b)}
                                  {rubber.set3_a !== null && ' / ' + formatSetScore(rubber.set3_a, rubber.set3_b)}
                                  {rubber.winning_club_id && (
                                    <span className="text-xs text-blue-600 ml-2">
                                      승: {rubber.winning_club_id===tie.club_a_id?tie.club_a?.name:tie.club_b?.name}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs text-gray-400 text-center">점수 미입력</div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>
    </div>
  )
}