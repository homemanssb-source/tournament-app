import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchTies, fetchClubMembers } from '@/lib/team-api'
import { getTieStatusLabel, getTieStatusColor, formatSetScore, getMajority } from '@/lib/team-utils'
import type { TieWithClubs, TeamLineup, ClubMember } from '@/types/team'

type Tab = 'individual' | 'team'

export default function AdminPinManagePage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [tab, setTab] = useState<Tab>('individual')

  // ?? 媛쒖씤????
  const [searchQuery, setSearchQuery] = useState('')
  const [allMatches, setAllMatches] = useState<any[]>([])
  const [selectedMatch, setSelectedMatch] = useState<any>(null)
  const [newScore, setNewScore] = useState('')
  const [newWinner, setNewWinner] = useState<'A' | 'B' | ''>('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  // ?? ?⑥껜????
  const [ties, setTies] = useState<TieWithClubs[]>([])
  const [tiesLoading, setTiesLoading] = useState(false)
  const [tieSearchQuery, setTieSearchQuery] = useState('')
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null)
  const [tieLineups, setTieLineups] = useState<TeamLineup[]>([])
  const [memberMap, setMemberMap] = useState<Record<string, ClubMember>>({})
  const [tieRubbers, setTieRubbers] = useState<any[]>([])

  // ?⑥껜???먯닔 ?낅젰 state
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

  useEffect(() => {
    const raw = sessionStorage.getItem('admin_pin_session')
    if (!raw) { router.push('/admin-pin'); return }
    const s = JSON.parse(raw)
    setSession(s)
    loadAllMatches(s.event_id)
    loadTiesData(s.event_id)
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

  // 媛쒖씤???꾪꽣
  const filtered = allMatches.filter(m => {
    if (!searchQuery) return false
    const q = searchQuery.toLowerCase()
    return (m.match_num||'').toLowerCase().includes(q)
      || (m.team_a_name||'').toLowerCase().includes(q)
      || (m.team_b_name||'').toLowerCase().includes(q)
      || (m.division_name||'').toLowerCase().includes(q)
      || (m.round||'').toLowerCase().includes(q)
  })

  // ?⑥껜???꾪꽣
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
      p_token: session.token, p_match_id: selectedMatch.id, p_reason: reason||'愿由ъ옄 ?댁젣'
    })
    setLoading(false)
    if (error) { setMsg('??'+error.message); return }
    setMsg('???좉툑???댁젣?섏뿀?듬땲??')
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  async function handleUpdateScore() {
    if (!session||!selectedMatch||!newScore||!newWinner) { setMsg('?먯닔? ?뱀옄瑜?紐⑤몢 ?낅젰?댁＜?몄슂.'); return }
    setLoading(true); setMsg('')
    const winnerId = newWinner==='A' ? selectedMatch.team_a_id : selectedMatch.team_b_id
    const { error } = await supabase.rpc('rpc_admin_pin_update_score', {
      p_token: session.token, p_match_id: selectedMatch.id, p_score: newScore, p_winner_team_id: winnerId
    })
    if (error) { setLoading(false); setMsg('??'+error.message); return }

    // ??GROUP 寃쎄린 ?섏젙 ????議??꾨즺 ?щ? ?뺤씤 ??蹂몄꽑 TBD ?щ’ ?먮룞 梨꾩슦湲?    const stageUp = (selectedMatch.stage || '').toUpperCase()
    if (stageUp === 'GROUP') {
      try {
        const { data: matchData } = await supabase
          .from('matches')
          .select('group_id, division_id')
          .eq('id', selectedMatch.id)
          .single()

        if (matchData?.group_id) {
          // ?대떦 洹몃９ 誘몄셿猷?寃쎄린 ?뺤씤 (?꾩껜 議고쉶 ???대씪?댁뼵???꾪꽣 ??NULL status ?ы븿)
          const { data: groupMatches } = await supabase
            .from('matches')
            .select('id, status')
            .eq('event_id', session.event_id)
            .eq('group_id', matchData.group_id)
            .eq('stage', 'GROUP')

          const unfinished = (groupMatches || []).filter(m => m.status !== 'FINISHED')
          if (unfinished.length === 0) {
            // 蹂몄꽑 TBD ?щ’ 議댁옱 ?щ? ?뺤씤
            const { data: finalsMatches } = await supabase
              .from('matches')
              .select('id, qualifier_label_a, qualifier_label_b')
              .eq('event_id', session.event_id)
              .eq('division_id', matchData.division_id)
              .eq('stage', 'FINALS')

            const hasTbd = (finalsMatches || []).some(
              m => m.qualifier_label_a != null || m.qualifier_label_b != null
            )
            if (hasTbd) {
              const { data: fillResult, error: fillError } = await supabase.rpc('rpc_fill_tournament_slots', {
                p_event_id: session.event_id,
                p_group_id: matchData.group_id,
              })
              if (!fillError && fillResult?.success && fillResult.filled > 0) {
                setLoading(false)
                setMsg(`??寃곌낵媛 ?섏젙?섏뿀?듬땲?? (蹂몄꽑 ?щ’ ${fillResult.filled}媛??먮룞 ?낅뜲?댄듃??`)
                loadAllMatches(session.event_id); setSelectedMatch(null)
                return
              }
            }
          }
        }
      } catch {}
    }

    setLoading(false)
    setMsg('??寃곌낵媛 ?섏젙?섏뿀?듬땲??')
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  async function handleSelectTie(tie: TieWithClubs) {
    if (selectedTie?.id === tie.id) { setSelectedTie(null); setScoringRubber(null); return }
    setSelectedTie(tie); setScoringRubber(null); setTieMsg('')
    const [lineupData, rubberData] = await Promise.all([
      // ?댁쁺?먮뒗 is_revealed 愿怨꾩뾾???꾩껜 議고쉶
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
    if (!set1a || !set1b) { setScoreError('1?명듃 ?먯닔瑜??낅젰?섏꽭??'); return }
    setScoreSaving(true); setScoreError('')
    try {
      const { data, error: err } = await supabase.rpc('rpc_admin_record_score', {
        p_rubber_id: scoringRubber,
        p_set1_a: parseInt(set1a), p_set1_b: parseInt(set1b),
        p_set2_a: set2a ? parseInt(set2a) : null, p_set2_b: set2b ? parseInt(set2b) : null,
        p_set3_a: set3a ? parseInt(set3a) : null, p_set3_b: set3b ? parseInt(set3b) : null,
      })
      if (err) { setScoreError(err.message); return }
      if (data && !data.success) { setScoreError(data.error || '????ㅽ뙣'); return }

      // ?곗씠???덈줈怨좎묠
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
      setTieMsg('???먯닔 ??λ맖')
      setTimeout(() => setTieMsg(''), 3000)
    } catch (err: any) {
      setScoreError(err.message || '????ㅽ뙣')
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
            <h1 className="font-bold">?썳截?愿由ъ옄 ?꾧뎄</h1>
            <p className="text-xs text-white/60">{session.event_name} 쨌 30遺??몄뀡</p>
          </div>
          <button onClick={handleLogout} className="text-sm text-white/60 hover:text-white">濡쒓렇?꾩썐</button>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 pt-4">
        <div className="flex gap-2 mb-4">
          <button onClick={() => { setTab('individual'); setSelectedMatch(null); setMsg('') }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${tab==='individual'?'bg-red-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            ?렱 媛쒖씤??          </button>
          <button onClick={() => { setTab('team'); setSelectedTie(null); setScoringRubber(null); setTieMsg('') }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${tab==='team'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            ?뱥 ?⑥껜??          </button>
        </div>
      </div>

      <main className="max-w-2xl mx-auto px-4 pb-8 space-y-3">

        {/* ?먥븧?먥븧?먥븧 媛쒖씤???먥븧?먥븧?먥븧 */}
        {tab === 'individual' && (
          <>
            {msg && (
              <div className={`p-3 rounded-lg text-sm ${msg.startsWith('??)?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {msg}
              </div>
            )}
            <div className="relative">
              <input type="text" placeholder="?紐? 寃쎄린踰덊샇, 遺?쒕챸 寃??.."
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSelectedMatch(null); setMsg('') }}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-red-500 outline-none"
                autoFocus
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setSelectedMatch(null) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">??/button>
              )}
            </div>

            {!searchQuery && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">?뵇</div>
                <p>?紐??먮뒗 寃쎄린踰덊샇瑜?寃?됲븯?몄슂</p>
              </div>
            )}
            {searchQuery && filtered.length === 0 && (
              <div className="text-center py-8 text-gray-400">寃??寃곌낵媛 ?놁뒿?덈떎.</div>
            )}

            {filtered.map(m => (
              <div key={m.id} onClick={() => selectMatch(m)}
                className={`bg-white rounded-xl border p-4 cursor-pointer transition ${selectedMatch?.id===m.id?'border-red-400 bg-red-50':'hover:border-gray-300'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">{m.match_num} 쨌 {m.division_name} 쨌 {m.round}</span>
                  <div className="flex items-center gap-2">
                    {m.locked_by_participant && <span className="text-xs text-red-500">?뵏</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${m.status==='FINISHED'?'bg-green-100 text-green-700':m.status==='IN_PROGRESS'?'bg-red-100 text-red-700':'bg-gray-100 text-gray-500'}`}>
                      {m.status==='FINISHED'?'?꾨즺':m.status==='IN_PROGRESS'?'吏꾪뻾以?:'?湲?}
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
                <h3 className="font-bold text-lg mb-1">寃쎄린 ?섏젙</h3>
                <div className="text-xs text-stone-400 mb-4">{selectedMatch.match_num} 쨌 {selectedMatch.division_name} 쨌 {selectedMatch.round}</div>
                <div className="flex items-center justify-center gap-4 my-4">
                  <div className="text-center flex-1"><div className="font-bold">{selectedMatch.team_a_name||'TBD'}</div><span className="text-xs text-stone-400">? A</span></div>
                  <span className="text-2xl text-stone-300 font-bold">VS</span>
                  <div className="text-center flex-1"><div className="font-bold">{selectedMatch.team_b_name||'TBD'}</div><span className="text-xs text-stone-400">? B</span></div>
                </div>
                {selectedMatch.score && (
                  <div className="text-center mb-4 text-sm">?꾩옱: <strong>{selectedMatch.score}</strong>
                    {selectedMatch.winner_name && <span> ???? {selectedMatch.winner_name}</span>}
                    {selectedMatch.locked_by_participant && <span className="ml-2 text-red-500">?뵏 李멸??먯옞湲?/span>}
                  </div>
                )}
                <hr className="my-4" />
                {selectedMatch.locked_by_participant && (
                  <div className="mb-4 p-3 bg-amber-50 rounded-lg">
                    <p className="text-sm font-bold text-amber-700 mb-2">?뵑 ?좉툑 ?댁젣</p>
                    <input type="text" placeholder="?댁젣 ?ъ쑀 (?좏깮)" value={reason} onChange={e => setReason(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mb-2" />
                    <button onClick={handleUnlock} disabled={loading} className="w-full bg-amber-500 text-white py-2 rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50">
                      {loading?'泥섎━ 以?..':'?좉툑 ?댁젣 + 寃곌낵 珥덇린??}
                    </button>
                  </div>
                )}
                <div className="p-3 bg-stone-50 rounded-lg">
                  <p className="text-sm font-bold mb-3">?륅툘 寃곌낵 ?섏젙</p>
                  <div className="mb-3">
                    <label className="text-xs text-stone-500">?먯닔</label>
                    <input type="text" placeholder="6:4" value={newScore} onChange={e => setNewScore(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-center text-lg font-bold mt-1" />
                  </div>
                  <div className="mb-3">
                    <label className="text-xs text-stone-500">?뱀옄</label>
                    <div className="flex gap-2 mt-1">
                      <button onClick={() => setNewWinner('A')} className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${newWinner==='A'?'bg-red-600 text-white border-red-600':'border-stone-300 hover:border-red-400'}`}>A: {selectedMatch.team_a_name||'TBD'}</button>
                      <button onClick={() => setNewWinner('B')} className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${newWinner==='B'?'bg-red-600 text-white border-red-600':'border-stone-300 hover:border-red-400'}`}>B: {selectedMatch.team_b_name||'TBD'}</button>
                    </div>
                  </div>
                  <button onClick={handleUpdateScore} disabled={loading||!newScore||!newWinner} className="w-full bg-red-600 text-white py-2.5 rounded-lg font-bold hover:bg-red-700 disabled:opacity-50">
                    {loading?'泥섎━ 以?..':'寃곌낵 ???}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ?먥븧?먥븧?먥븧 ?⑥껜???먥븧?먥븧?먥븧 */}
        {tab === 'team' && (
          <>
            {tieMsg && (
              <div className={`p-3 rounded-lg text-sm ${tieMsg.startsWith('??)?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {tieMsg}
              </div>
            )}
            <div className="relative">
              <input type="text" placeholder="?대읇紐? ?쇱슫?? 踰덊샇 寃??.."
                value={tieSearchQuery}
                onChange={e => { setTieSearchQuery(e.target.value); setSelectedTie(null); setScoringRubber(null) }}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-blue-500 outline-none"
                autoFocus
              />
              {tieSearchQuery && (
                <button onClick={() => { setTieSearchQuery(''); setSelectedTie(null); setScoringRubber(null) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">??/button>
              )}
            </div>

            {!tieSearchQuery && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">?뵇</div>
                <p>?대읇紐??먮뒗 ?쇱슫?쒕? 寃?됲븯?몄슂</p>
                <p className="text-xs mt-1 text-gray-300">?? "?곕룄", "16媛?, "1"</p>
              </div>
            )}
            {tiesLoading && <div className="text-center py-8 text-gray-400">濡쒕뵫以?..</div>}
            {tieSearchQuery && !tiesLoading && filteredTies.length === 0 && (
              <div className="text-center py-8 text-gray-400">寃??寃곌낵媛 ?놁뒿?덈떎.</div>
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
                          <span className="text-gray-400 text-xs">{isSelected?'??:'??}</span>
                        </div>
                      </div>
                      {tie.round && (
                        <div className="text-xs text-gray-400 mt-1">{tie.round}</div>
                      )}
                    </div>

                    {isSelected && (
                      <div className="border-t bg-gray-50 p-4 space-y-3">
                        {/* ?щ쾭蹂??먯닔 */}
                        {Array.from({ length: tie.rubber_count }, (_, i) => i+1).map(num => {
                          const laA = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_a_id)
                          const laB = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_b_id)
                          const rubber = tieRubbers.find((r: any) => r.rubber_number===num)
                          const hasScore = rubber?.set1_a !== null && rubber?.set1_a !== undefined
                          const isScoring = scoringRubber === rubber?.id

                          return (
                            <div key={num} className={`bg-white rounded-lg border p-3 ${rubber?.status==='completed'?'border-green-200':''}`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium text-sm">?щ쾭 {num}</span>
                                {rubber?.status==='completed' && (
                                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">?꾨즺</span>
                                )}
                              </div>

                              {/* ?쇱씤??*/}
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

                              {/* ?먯닔 ?쒖떆 */}
                              {hasScore && !isScoring && (
                                <div className="flex items-center justify-between">
                                  <div className="text-center flex-1 py-1 bg-gray-50 rounded text-sm font-bold">
                                    {formatSetScore(rubber.set1_a, rubber.set1_b)}
                                    {rubber.set2_a !== null && ' / '+formatSetScore(rubber.set2_a, rubber.set2_b)}
                                    {rubber.set3_a !== null && ' / '+formatSetScore(rubber.set3_a, rubber.set3_b)}
                                    {rubber.winning_club_id && (
                                      <span className="text-xs text-blue-600 ml-2">
                                        ?? {rubber.winning_club_id===tie.club_a_id?tie.club_a?.name:tie.club_b?.name}
                                      </span>
                                    )}
                                  </div>
                                  <button onClick={() => startScoring(rubber)}
                                    className="ml-2 text-xs text-amber-500 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50">
                                    ?섏젙
                                  </button>
                                </div>
                              )}

                              {/* ?먯닔 ?놁쑝硫??낅젰 踰꾪듉 */}
                              {!hasScore && !isScoring && rubber && (
                                <button onClick={() => startScoring(rubber)}
                                  className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium hover:bg-blue-100">
                                  + ?먯닔 ?낅젰
                                </button>
                              )}

                              {/* ?먯닔 ?낅젰 ??*/}
                              {isScoring && rubber && (
                                <div className="space-y-2 mt-2 border-t pt-3">
                                  <SetRow label="1?명듃" aVal={set1a} bVal={set1b} setA={setSet1a} setB={setSet1b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  {setsPerRubber === 3 && (<>
                                    <SetRow label="2?명듃" aVal={set2a} bVal={set2b} setA={setSet2a} setB={setSet2b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                    <SetRow label="3?명듃" aVal={set3a} bVal={set3b} setA={setSet3a} setB={setSet3b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  </>)}
                                  {scoreError && <p className="text-red-500 text-xs">{scoreError}</p>}
                                  <div className="flex gap-2">
                                    <button onClick={() => { setScoringRubber(null); setScoreError('') }}
                                      className="flex-1 bg-gray-100 py-2 rounded-lg text-sm">痍⑥냼</button>
                                    <button onClick={handleTieScoreSave} disabled={scoreSaving}
                                      className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-green-700 disabled:opacity-50">
                                      {scoreSaving ? '??μ쨷...' : '?먯닔 ?뺤젙'}
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
