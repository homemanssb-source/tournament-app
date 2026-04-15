'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchTies, fetchClubMembers } from '@/lib/team-api'
import { getTieStatusLabel, getTieStatusColor, formatSetScore, getMajority } from '@/lib/team-utils'
import type { TieWithClubs, TeamLineup, ClubMember } from '@/types/team'

type Tab = 'individual' | 'team' | 'locks'

interface PinLock {
  target_key: string
  fail_count: number
  locked_until: string | null
  updated_at: string
}

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
  const [tieSearchQuery, setTieSearchQuery] = useState('')
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null)
  const [tieLineups, setTieLineups] = useState<TeamLineup[]>([])
  const [memberMap, setMemberMap] = useState<Record<string, ClubMember>>({})
  const [tieRubbers, setTieRubbers] = useState<any[]>([])

  // 단체전 점수 입력 state
  const [scoringRubber, setScoringRubber] = useState<string | null>(null)
  const [set1a, setSet1a] = useState('')
  const [set1b, setSet1b] = useState('')
  const [set2a, setSet2a] = useState('')
  const [set2b, setSet2b] = useState('')
  const [set3a, setSet3a] = useState('')
  const [set3b, setSet3b] = useState('')
  const [setsPerRubber, setSetsPerRubber] = useState(1)
  const [scoreError, setScoreError] = useState('')
  const [scoreSaving, setScoreSaving] = useState(false)
  const [tieMsg, setTieMsg] = useState('')

  // ── PIN 잠금 해제 ──
  const [pinLocks, setPinLocks] = useState<PinLock[]>([])
  const [pinLockLoading, setPinLockLoading] = useState(false)
  const [pinLockMsg, setPinLockMsg] = useState('')
  const [clubNameMap, setClubNameMap] = useState<Record<string, string>>({})

  useEffect(() => {
    const raw = sessionStorage.getItem('admin_pin_session')
    if (!raw) { router.push('/admin-pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadAllMatches(s.event_id)
    loadTiesData(s.event_id)
    loadPinLocks(s.event_id)
  }, [])

  async function loadAllMatches(eventId: string) {
    const { data } = await supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId).order('slot')
    setAllMatches(data || [])
  }

  async function loadTiesData(eventId: string) {
    setTiesLoading(true)
    try {
      const { data: ev } = await supabase.from('events').select('team_sets_per_rubber').eq('id', eventId).single()
      setSetsPerRubber(ev?.team_sets_per_rubber || 1)
      const data = await fetchTies(eventId)
      setTies(data)
    } catch {}
    setTiesLoading(false)
  }

  // ── PIN 잠금 목록 로드 (현재 잠긴 것만) ──
  async function loadPinLocks(eventId: string) {
    setPinLockLoading(true)
    try {
      const { data } = await supabase
        .from('pin_attempts')
        .select('*')
        .not('locked_until', 'is', null)
        .gt('locked_until', new Date().toISOString())
        .order('updated_at', { ascending: false })
      setPinLocks((data || []) as PinLock[])

      // club: 패턴에서 club_id 추출 → clubs 테이블에서 이름 조회 (현 이벤트 클럽만)
      const clubIds = (data || [])
        .map(r => (r.target_key.startsWith('club:') ? r.target_key.slice(5) : null))
        .filter(Boolean) as string[]
      if (clubIds.length > 0) {
        const { data: clubs } = await supabase
          .from('clubs').select('id, name').in('id', clubIds).eq('event_id', eventId)
        const map: Record<string, string> = {}
        for (const c of clubs || []) map[c.id] = c.name
        setClubNameMap(map)
      } else {
        setClubNameMap({})
      }
    } catch {}
    setPinLockLoading(false)
  }

  async function handleUnlockPin(targetKey: string) {
    setPinLockMsg('')
    const { error } = await supabase.from('pin_attempts').delete().eq('target_key', targetKey)
    if (error) { setPinLockMsg('❌ ' + error.message); return }
    setPinLockMsg('✅ 잠금 해제됨')
    setTimeout(() => setPinLockMsg(''), 3000)
    if (session) loadPinLocks(session.event_id)
  }

  async function handleUnlockAll() {
    if (!confirm('현재 걸린 모든 PIN 잠금을 해제하시겠습니까?')) return
    setPinLockMsg('')
    const keys = pinLocks.map(l => l.target_key)
    if (keys.length === 0) return
    const { error } = await supabase.from('pin_attempts').delete().in('target_key', keys)
    if (error) { setPinLockMsg('❌ ' + error.message); return }
    setPinLockMsg(`✅ ${keys.length}건 일괄 해제`)
    setTimeout(() => setPinLockMsg(''), 3000)
    if (session) loadPinLocks(session.event_id)
  }

  function describePinLock(targetKey: string): string {
    if (targetKey.startsWith('club:')) {
      const clubId = targetKey.slice(5)
      return `🏅 클럽 캡틴 PIN · ${clubNameMap[clubId] || clubId.slice(0, 8)}`
    }
    if (targetKey.startsWith('rubber:')) {
      return `🎾 러버 PIN · ${targetKey.slice(7, 15)}…`
    }
    if (targetKey.startsWith('login:')) {
      return `🔑 팀 PIN 로그인 시도`
    }
    return targetKey
  }

  // 개인전 필터
  const filtered = allMatches.filter(m => {
    if (!searchQuery) return false
    const q = searchQuery.toLowerCase()
    return (m.match_num||'').toLowerCase().includes(q)
      || (m.team_a_name||'').toLowerCase().includes(q)
      || (m.team_b_name||'').toLowerCase().includes(q)
      || (m.division_name||'').toLowerCase().includes(q)
      || (m.round||'').toLowerCase().includes(q)
  })

  // 단체전 필터
  const filteredTies = ties.filter(tie => {
    if (!tieSearchQuery) return false
    const q = tieSearchQuery.toLowerCase()
    return (tie.club_a?.name||'').toLowerCase().includes(q)
      || (tie.club_b?.name||'').toLowerCase().includes(q)
      || (tie.tie_order?.toString()||'').includes(q)
      || (tie.round||'').toLowerCase().includes(q)
  })

  async function selectMatch(m: any) {
    setSelectedMatch(m)
    setNewScore(m.score || '')
    setNewWinner(m.winner_team_id===m.team_a_id?'A':m.winner_team_id===m.team_b_id?'B':'')
    setReason('')
    setMsg('')
  }

  async function handleUnlock() {
    if (!session || !selectedMatch) return
    setLoading(true); setMsg('')
    const { error } = await supabase.rpc('rpc_admin_pin_unlock_match', {
      p_token: session.token, p_match_id: selectedMatch.id, p_reason: reason||'관리자 해제'
    })
    setLoading(false)
    if (error) { setMsg('❌ '+error.message); return }
    setMsg('✅ 잠금이 해제되었습니다.')
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  // ✅ 조별 경기 수정 후 본선 TBD 슬롯 자동 채우기
  async function tryFillTournamentSlotsAdmin(matchId: string, eventId: string) {
    // 해당 경기 정보 조회
    const { data: matchData } = await supabase
      .from('matches')
      .select('group_id, division_id, stage')
      .eq('id', matchId)
      .single()

    if (!matchData) return
    // GROUP 경기가 아니면 skip (대소문자 무관)
    const stageUp = (matchData.stage || '').toUpperCase()
    if (stageUp !== 'GROUP') return
    if (!matchData.group_id) return

    // 해당 그룹의 미완료 경기 수 확인 (대소문자 무관 전체조회 후 클라이언트 필터)
    const { data: groupMatches } = await supabase
      .from('matches')
      .select('id, status, score, stage')
      .eq('event_id', eventId)
      .eq('group_id', matchData.group_id)

    const groupOnly = (groupMatches || []).filter(m => (m.stage||'').toUpperCase() === 'GROUP')
    // BYE 경기는 status가 FINISHED가 아닐 수 있으므로 제외
    const unfinished = groupOnly.filter(m => m.status !== 'FINISHED' && m.score !== 'BYE')
    if (unfinished.length > 0) return // 아직 남은 경기 있음

    // 본선 브래킷에 TBD 슬롯이 있는지 확인
    const { data: finalsData } = await supabase
      .from('matches')
      .select('id, qualifier_label_a, qualifier_label_b')
      .eq('event_id', eventId)
      .eq('division_id', matchData.division_id)
      .eq('stage', 'FINALS')

    const hasTbd = (finalsData || []).some(
      m => m.qualifier_label_a != null || m.qualifier_label_b != null
    )
    if (!hasTbd) return

    console.log('[AdminPIN] 조 완료 → rpc_fill_tournament_slots:', matchData.group_id)
    const { data: fillResult, error: fillError } = await supabase.rpc('rpc_fill_tournament_slots', {
      p_event_id: eventId,
      p_group_id: matchData.group_id,
    })
    if (fillError) {
      console.warn('[AdminPIN] fill_tournament_slots 오류:', fillError.message)
      return
    }
    if (fillResult?.success && fillResult.filled > 0) {
      console.log('[AdminPIN] 슬롯 채우기 완료:', fillResult)
    }
  }

  async function handleUpdateScore() {
    if (!session||!selectedMatch||!newScore||!newWinner) { setMsg('점수와 승자를 모두 입력해주세요.'); return }
    setLoading(true); setMsg('')
    const winnerId = newWinner==='A' ? selectedMatch.team_a_id : selectedMatch.team_b_id
    const { error } = await supabase.rpc('rpc_admin_pin_update_score', {
      p_token: session.token, p_match_id: selectedMatch.id, p_score: newScore, p_winner_team_id: winnerId
    })
    if (error) { setLoading(false); setMsg('❌ '+error.message); return }

    // ✅ 조별 경기인 경우 본선 TBD 슬롯 자동 채우기
    await tryFillTournamentSlotsAdmin(selectedMatch.id, session.event_id)

    setLoading(false)
    setMsg('✅ 결과가 수정되었습니다.')
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  async function handleSelectTie(tie: TieWithClubs) {
    if (selectedTie?.id === tie.id) { setSelectedTie(null); setScoringRubber(null); return }
    setSelectedTie(tie); setScoringRubber(null); setTieMsg('')
    const [lineupData, rubberData] = await Promise.all([
      supabase.from('team_lineups').select('*').eq('tie_id', tie.id).order('rubber_number'),
      supabase.from('tie_rubbers').select('*').eq('tie_id', tie.id).order('rubber_number'),
    ])
    setTieLineups((lineupData.data || []) as TeamLineup[])
    setTieRubbers(rubberData.data || [])
    const mm: Record<string, ClubMember> = {}
    if (tie.club_a_id) { (await fetchClubMembers(tie.club_a_id)).forEach(m => { mm[m.id]=m }) }
    if (tie.club_b_id) { (await fetchClubMembers(tie.club_b_id)).forEach(m => { mm[m.id]=m }) }
    setMemberMap(mm)
  }

  function startScoring(rubber: any) {
    setScoringRubber(rubber.id); setScoreError('')
    setSet1a(rubber.set1_a?.toString()||''); setSet1b(rubber.set1_b?.toString()||'')
    setSet2a(rubber.set2_a?.toString()||''); setSet2b(rubber.set2_b?.toString()||'')
    setSet3a(rubber.set3_a?.toString()||''); setSet3b(rubber.set3_b?.toString()||'')
  }

  async function handleTieScoreSave() {
    // ✅ 1세트 체크
    if (!set1a || !set1b) { setScoreError('1세트 점수를 입력하세요.'); return }
    const s1a = parseInt(set1a), s1b = parseInt(set1b)
    if (s1a === s1b) { setScoreError('1세트는 동점일 수 없습니다.'); return }

    // ✅ 3세트 방식 전체 검증
    if (setsPerRubber === 3) {
      if (!set2a || !set2b) { setScoreError('2세트 점수를 입력하세요.'); return }
      const s2a = parseInt(set2a), s2b = parseInt(set2b)
      if (s2a === s2b) { setScoreError('2세트는 동점일 수 없습니다.'); return }
      const s1WinA = s1a > s1b, s2WinA = s2a > s2b
      const needSet3 = s1WinA !== s2WinA
      if (needSet3 && (!set3a || !set3b)) {
        setScoreError('1-2세트 스플릿 — 3세트 점수를 입력하세요.'); return
      }
      if (set3a && set3b && parseInt(set3a) === parseInt(set3b)) {
        setScoreError('3세트는 동점일 수 없습니다.'); return
      }
    }

    // ✅ 완료된 tie 재수정 시 경고 (다음 라운드 데이터 손실 위험)
    const rubber = tieRubbers.find((r: any) => r.id === scoringRubber)
    const isCompletedTie = selectedTie?.status === 'completed'
    if (isCompletedTie && rubber?.status === 'completed') {
      const msg = '⚠️ 이미 완료된 대전입니다.\n' +
        '점수 수정 시 다음 라운드의 러버 데이터가 초기화될 수 있습니다.\n' +
        '계속하시겠습니까?'
      if (!confirm(msg)) return
    }

    setScoreSaving(true); setScoreError('')
    try {
      const { data, error: err } = await supabase.rpc('rpc_admin_record_score', {
        p_rubber_id: scoringRubber,
        p_set1_a: parseInt(set1a), p_set1_b: parseInt(set1b),
        p_set2_a: set2a ? parseInt(set2a) : null, p_set2_b: set2b ? parseInt(set2b) : null,
        p_set3_a: set3a ? parseInt(set3a) : null, p_set3_b: set3b ? parseInt(set3b) : null,
      })
      if (err) { setScoreError(err.message); return }
      if (data && !data.success) { setScoreError(data.error || '저장 실패'); return }

      const [rubberData, tieData] = await Promise.all([
        supabase.from('tie_rubbers').select('*').eq('tie_id', selectedTie!.id).order('rubber_number'),
        supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)').eq('id', selectedTie!.id).single(),
      ])
      setTieRubbers(rubberData.data || [])
      if (tieData.data) {
        setSelectedTie(tieData.data as any)
        setTies(prev => prev.map(t => t.id === selectedTie!.id ? tieData.data as any : t))
      }
      setScoringRubber(null)
      setTieMsg('✅ 점수 저장됨')
      setTimeout(() => setTieMsg(''), 3000)
    } catch (err: any) {
      setScoreError(err.message || '저장 실패')
    } finally {
      setScoreSaving(false)
    }
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

      <div className="max-w-2xl mx-auto px-4 pt-4">
        <div className="flex gap-2 mb-4">
          <button onClick={() => { setTab('individual'); setSelectedMatch(null); setMsg('') }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${tab==='individual'?'bg-red-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🎾 개인전
          </button>
          <button onClick={() => { setTab('team'); setSelectedTie(null); setScoringRubber(null); setTieMsg('') }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${tab==='team'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            📋 단체전
          </button>
          <button onClick={() => { setTab('locks'); if (session) loadPinLocks(session.event_id) }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition relative ${tab==='locks'?'bg-amber-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🔒 PIN 잠금
            {pinLocks.length > 0 && (
              <span className="ml-1 text-xs bg-red-500 text-white rounded-full px-1.5">{pinLocks.length}</span>
            )}
          </button>
        </div>
      </div>

      <main className="max-w-2xl mx-auto px-4 pb-8 space-y-3">

        {/* ══════ 개인전 ══════ */}
        {tab === 'individual' && (
          <>
            {msg && (
              <div className={`p-3 rounded-lg text-sm ${msg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {msg}
              </div>
            )}
            <div className="relative">
              <input type="text" placeholder="팀명, 경기번호, 부서명 검색..."
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSelectedMatch(null); setMsg('') }}
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

        {/* ══════ 단체전 ══════ */}
        {tab === 'team' && (
          <>
            {tieMsg && (
              <div className={`p-3 rounded-lg text-sm ${tieMsg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {tieMsg}
              </div>
            )}
            <div className="relative">
              <input type="text" placeholder="클럽명, 라운드, 번호 검색..."
                value={tieSearchQuery}
                onChange={e => { setTieSearchQuery(e.target.value); setSelectedTie(null); setScoringRubber(null) }}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-blue-500 outline-none"
                autoFocus
              />
              {tieSearchQuery && (
                <button onClick={() => { setTieSearchQuery(''); setSelectedTie(null); setScoringRubber(null) }}
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
                      {tie.round && (
                        <div className="text-xs text-gray-400 mt-1">{tie.round}</div>
                      )}
                    </div>

                    {isSelected && (
                      <div className="border-t bg-gray-50 p-4 space-y-3">
                        {Array.from({ length: tie.rubber_count }, (_, i) => i+1).map(num => {
                          const laA = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_a_id)
                          const laB = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_b_id)
                          const rubber = tieRubbers.find((r: any) => r.rubber_number===num)
                          const hasScore = rubber?.set1_a !== null && rubber?.set1_a !== undefined
                          const isScoring = scoringRubber === rubber?.id

                          return (
                            <div key={num} className={`bg-white rounded-lg border p-3 ${rubber?.status==='completed'?'border-green-200':''}`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium text-sm">러버 {num}</span>
                                {rubber?.status==='completed' && (
                                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">완료</span>
                                )}
                              </div>

                              {(laA || laB) && (
                                <div className="grid grid-cols-5 items-center gap-1 text-xs mb-2">
                                  <div className="col-span-2 text-right">
                                    <div className="font-medium">{getMemberName(laA?.player1_id)} / {getMemberName(laA?.player2_id)}</div>
                                    <div className="text-gray-400">{tie.club_a?.name}</div>
                                  </div>
                                  <div className="text-center text-gray-400 font-bold">vs</div>
                                  <div className="col-span-2">
                                    <div className="font-medium">{getMemberName(laB?.player1_id)} / {getMemberName(laB?.player2_id)}</div>
                                    <div className="text-gray-400">{tie.club_b?.name}</div>
                                  </div>
                                </div>
                              )}

                              {hasScore && !isScoring && (
                                <div className="flex items-center justify-between">
                                  <div className="text-center flex-1 py-1 bg-gray-50 rounded text-sm font-bold">
                                    {formatSetScore(rubber.set1_a, rubber.set1_b)}
                                    {rubber.set2_a !== null && ' / '+formatSetScore(rubber.set2_a, rubber.set2_b)}
                                    {rubber.set3_a !== null && ' / '+formatSetScore(rubber.set3_a, rubber.set3_b)}
                                    {rubber.winning_club_id && (
                                      <span className="text-xs text-blue-600 ml-2">
                                        승: {rubber.winning_club_id===tie.club_a_id?tie.club_a?.name:tie.club_b?.name}
                                      </span>
                                    )}
                                  </div>
                                  <button onClick={() => startScoring(rubber)}
                                    className="ml-2 text-xs text-amber-500 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50">
                                    수정
                                  </button>
                                </div>
                              )}

                              {!hasScore && !isScoring && rubber && (
                                <button onClick={() => startScoring(rubber)}
                                  className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium hover:bg-blue-100">
                                  + 점수 입력
                                </button>
                              )}

                              {isScoring && rubber && (
                                <div className="space-y-2 mt-2 border-t pt-3">
                                  <SetRow label="1세트" aVal={set1a} bVal={set1b} setA={setSet1a} setB={setSet1b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  {setsPerRubber === 3 && (<>
                                    <SetRow label="2세트" aVal={set2a} bVal={set2b} setA={setSet2a} setB={setSet2b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                    <SetRow label="3세트" aVal={set3a} bVal={set3b} setA={setSet3a} setB={setSet3b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  </>)}
                                  {scoreError && <p className="text-red-500 text-xs">{scoreError}</p>}
                                  <div className="flex gap-2">
                                    <button onClick={() => { setScoringRubber(null); setScoreError('') }}
                                      className="flex-1 bg-gray-100 py-2 rounded-lg text-sm">취소</button>
                                    <button onClick={handleTieScoreSave} disabled={scoreSaving}
                                      className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-green-700 disabled:opacity-50">
                                      {scoreSaving ? '저장중...' : '점수 확정'}
                                    </button>
                                  </div>
                                </div>
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

        {/* ══════ PIN 잠금 ══════ */}
        {tab === 'locks' && (
          <>
            {pinLockMsg && (
              <div className={`p-3 rounded-lg text-sm ${pinLockMsg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {pinLockMsg}
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              <p className="font-bold mb-1">🔒 PIN 5회 실패 시 10분 자동 잠금</p>
              <p className="text-xs">캡틴/선수가 PIN을 잘못 입력해 잠긴 경우 여기서 수동 해제</p>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">
                {pinLockLoading ? '불러오는 중...' : `현재 잠긴 PIN: ${pinLocks.length}건`}
              </span>
              <div className="flex gap-2">
                <button onClick={() => session && loadPinLocks(session.event_id)}
                  className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg">
                  🔄 새로고침
                </button>
                {pinLocks.length > 0 && (
                  <button onClick={handleUnlockAll}
                    className="text-xs bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg">
                    전체 해제
                  </button>
                )}
              </div>
            </div>

            {!pinLockLoading && pinLocks.length === 0 && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">✅</div>
                <p>현재 잠긴 PIN 없음</p>
              </div>
            )}

            <div className="space-y-2">
              {pinLocks.map(lock => {
                const lockedMin = lock.locked_until
                  ? Math.max(0, Math.ceil((new Date(lock.locked_until).getTime() - Date.now()) / 60000))
                  : 0
                return (
                  <div key={lock.target_key} className="bg-white rounded-xl border p-4 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{describePinLock(lock.target_key)}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        실패 {lock.fail_count}회 · 잠금 해제까지 ~{lockedMin}분
                      </div>
                    </div>
                    <button onClick={() => handleUnlockPin(lock.target_key)}
                      className="text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-lg font-medium flex-shrink-0 ml-3">
                      🔓 해제
                    </button>
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

function SetRow({ label, aVal, bVal, setA, setB, clubA, clubB }: {
  label: string; aVal: string; bVal: string
  setA: (v: string) => void; setB: (v: string) => void
  clubA?: string; clubB?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-12">{label}</span>
      <div className="flex items-center gap-1 flex-1">
        <div className="flex-1 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">{clubA?.slice(0,5)}</div>
          <input type="number" min="0" max="7" value={aVal} onChange={e => setA(e.target.value)}
            className="w-full border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-blue-500 outline-none" />
        </div>
        <span className="text-gray-400 font-bold">:</span>
        <div className="flex-1 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">{clubB?.slice(0,5)}</div>
          <input type="number" min="0" max="7" value={bVal} onChange={e => setB(e.target.value)}
            className="w-full border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-blue-500 outline-none" />
        </div>
      </div>
    </div>
  )
}
