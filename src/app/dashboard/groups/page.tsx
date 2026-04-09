'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard'

interface GroupMember {
  id: string
  team_id: string
  team_name: string
  seed: number
  checked_in: boolean
  checked_in_at: string | null
}

interface GroupData {
  id: string; label: string; num: number
  members: GroupMember[]
}

// 조별 경기 결과 기반 순위 정보
interface GroupStanding {
  team_id: string
  team_name: string
  wins: number
  losses: number
  game_diff: number  // 게임 득실
  rank: number | null  // null = 동률 미결정
}

export default function GroupsPage() {
  const eventId = useEventId()
  const { divisions, selected, setSelected } = useDivisions(eventId)
  const [groups, setGroups] = useState<GroupData[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [generating, setGenerating] = useState(false)
  const [groupSize, setGroupSize] = useState(4)

  // 조별 순위 데이터
  const [standings, setStandings] = useState<Record<string, GroupStanding[]>>({})
  // 조별 경기 완료 여부
  const [groupDone, setGroupDone] = useState<Record<string, boolean>>({})
  // 수동 순위 지정 모달
  const [rankModal, setRankModal] = useState<{ groupId: string; groupLabel: string; teams: GroupStanding[] } | null>(null)
  // 수동 순위 지정 상태 (team_id → rank)
  const [manualRanks, setManualRanks] = useState<Record<string, number>>({})
  const [savingRank, setSavingRank] = useState(false)
  // 슬롯 채우기
  const [fillingGroup, setFillingGroup] = useState<string | null>(null)

  const loadGroups = useCallback(async () => {
    if (!eventId || !selected) return
    setLoading(true)
    try {
      const { data: rows } = await supabase.from('v_group_board').select('*')
        .eq('event_id', eventId).eq('division_id', selected)
        .order('group_num').order('team_num')

      const teamIds = [...new Set((rows || []).map((r: any) => r.team_id))]
      const checkedInMap = new Map<string, { checked_in: boolean; checked_in_at: string | null }>()

      if (teamIds.length > 0) {
        const { data: teamRows } = await supabase
          .from('teams').select('id, checked_in, checked_in_at').in('id', teamIds)
        for (const t of (teamRows || [])) {
          checkedInMap.set(t.id, { checked_in: t.checked_in ?? false, checked_in_at: t.checked_in_at ?? null })
        }
      }

      const map = new Map<string, GroupData>()
      for (const r of (rows || [])) {
        if (!map.has(r.group_id)) {
          map.set(r.group_id, { id: r.group_id, label: r.group_label, num: r.group_num, members: [] })
        }
        const ci = checkedInMap.get(r.team_id)
        map.get(r.group_id)!.members.push({
          id: r.member_id, team_id: r.team_id, team_name: r.team_name,
          seed: r.seed || 0,
          checked_in: ci?.checked_in ?? false, checked_in_at: ci?.checked_in_at ?? null,
        })
      }
      const groupList = Array.from(map.values()).sort((a, b) => a.num - b.num)
      setGroups(groupList)

      // 조별 경기 결과 로드
      if (groupList.length > 0) {
        await loadStandings(groupList)
      }
    } finally {
      setLoading(false)
    }
  }, [eventId, selected])

  // 조별 순위 계산 (클라이언트에서 직접 계산)
  async function loadStandings(groupList: GroupData[]) {
    if (!eventId || !selected) return

    // 해당 부서 조별 경기 전체 조회
    const { data: matchData } = await supabase
      .from('matches')
      .select('id, group_id, status, score, team_a_id, team_b_id, winner_team_id')
      .eq('event_id', eventId)
      .eq('division_id', selected)
      .eq('stage', 'GROUP')

    const matches = matchData || []
    const newStandings: Record<string, GroupStanding[]> = {}
    const newGroupDone: Record<string, boolean> = {}

    for (const g of groupList) {
      const gMatches = matches.filter(m => m.group_id === g.id)
      const finished = gMatches.filter(m => m.status === 'FINISHED')
      const allDone = gMatches.length > 0 && gMatches.every(m => m.status === 'FINISHED')
      newGroupDone[g.id] = allDone

      // 팀별 통계 계산
      const stats: Record<string, { wins: number; losses: number; gf: number; ga: number }> = {}
      for (const mem of g.members) {
        stats[mem.team_id] = { wins: 0, losses: 0, gf: 0, ga: 0 }
      }

      for (const m of finished) {
        if (!m.score || m.score === 'BYE' || !m.score.includes(':')) continue
        const [aScore, bScore] = m.score.split(':').map(Number)
        if (isNaN(aScore) || isNaN(bScore)) continue

        // team_a
        if (m.team_a_id && stats[m.team_a_id] !== undefined) {
          stats[m.team_a_id].gf += aScore
          stats[m.team_a_id].ga += bScore
          if (m.winner_team_id === m.team_a_id) stats[m.team_a_id].wins++
          else stats[m.team_a_id].losses++
        }
        // team_b
        if (m.team_b_id && stats[m.team_b_id] !== undefined) {
          stats[m.team_b_id].gf += bScore
          stats[m.team_b_id].ga += aScore
          if (m.winner_team_id === m.team_b_id) stats[m.team_b_id].wins++
          else stats[m.team_b_id].losses++
        }
      }

      // 순위 계산 (wins → game_diff)
      const teamList = g.members.map(mem => ({
        team_id: mem.team_id,
        team_name: mem.team_name,
        wins: stats[mem.team_id]?.wins ?? 0,
        losses: stats[mem.team_id]?.losses ?? 0,
        game_diff: (stats[mem.team_id]?.gf ?? 0) - (stats[mem.team_id]?.ga ?? 0),
        rank: null as number | null,
      }))

      // 정렬: wins DESC, game_diff DESC
      const sorted = [...teamList].sort((a, b) =>
        b.wins !== a.wins ? b.wins - a.wins : b.game_diff - a.game_diff
      )

      // 동률 체크: 같은 wins + game_diff면 rank=null
      let rank = 1
      for (let i = 0; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        if (i > 0 && sorted[i].wins === prev.wins && sorted[i].game_diff === prev.game_diff) {
          sorted[i].rank = null  // 동률 — 수동 지정 필요
          sorted[i - 1].rank = null
        } else {
          sorted[i].rank = rank
        }
        rank++
      }

      newStandings[g.id] = sorted
    }

    setStandings(newStandings)
    setGroupDone(newGroupDone)
  }

  useEffect(() => { loadGroups() }, [loadGroups])

  useEffect(() => {
    if (!eventId || !selected) return
    const iv = setInterval(() => loadGroups(), 30000)
    return () => clearInterval(iv)
  }, [loadGroups])

  async function generateGroups() {
    setGenerating(true); setMsg('')
    const { data, error } = await supabase.rpc('rpc_generate_groups', {
      p_event_id: eventId, p_division_id: selected, p_group_size: groupSize,
    })
    setGenerating(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg(`✅ 조편성 완료! ${data?.groups_created || ''}개 조 생성`)
    loadGroups()
  }

  async function generateGroupMatches() {
    setGenerating(true); setMsg('')
    const { data, error } = await supabase.rpc('rpc_generate_group_matches', {
      p_event_id: eventId, p_division_id: selected,
    })
    setGenerating(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg(`✅ 조별 경기 생성 완료! ${data?.matches_created || ''}경기`)
  }

  async function deleteAllGroups() {
    if (!confirm('현재 부서의 모든 조편성을 삭제하시겠습니까? (조별 경기도 함께 삭제됩니다)')) return
    setMsg('')
    const groupIds = groups.map(g => g.id)
    if (groupIds.length === 0) return
    await supabase.from('group_members').delete().in('group_id', groupIds)
    await supabase.from('matches').delete().eq('event_id', eventId).eq('division_id', selected).eq('stage', 'GROUP')
    await supabase.from('groups').delete().in('id', groupIds)
    setMsg('✅ 조편성 삭제됨')
    loadGroups()
  }

  // 수동 순위 지정 모달 열기
  function openRankModal(g: GroupData) {
    const st = standings[g.id] || []
    const initRanks: Record<string, number> = {}
    // 이미 rank가 있는 팀은 그대로, null인 팀만 초기화
    st.forEach((s, i) => { initRanks[s.team_id] = s.rank ?? (i + 1) })
    setManualRanks(initRanks)
    setRankModal({ groupId: g.id, groupLabel: g.label, teams: st })
  }

  // 수동 순위 저장 → rpc_fill_tournament_slots 호출
  async function saveManualRanks() {
    if (!rankModal) return
    const { groupId, groupLabel } = rankModal

    // 순위 중복 체크
    const rankValues = Object.values(manualRanks)
    const unique = new Set(rankValues)
    if (unique.size !== rankValues.length) {
      setMsg('❌ 중복된 순위가 있습니다. 각 팀에 다른 순위를 지정해주세요.')
      return
    }

    setSavingRank(true)
    try {
      // group_members 테이블에 manual_rank 저장 (없으면 matches winner 기반으로 처리)
      // 실제로는 qualifier_label 매칭을 위해 순위대로 wins를 조작하는 대신
      // rpc_fill_tournament_slots를 직접 호출하되, 순위를 파라미터로 넘김
      // → 가장 간단한 방법: group_members에 rank 컬럼이 없으므로
      //   matches의 winner 데이터를 수동 순위로 override하는 RPC 호출
      const { data, error } = await supabase.rpc('rpc_fill_tournament_slots_manual', {
        p_event_id:   eventId,
        p_group_id:   groupId,
        p_rank_order: Object.entries(manualRanks)
          .sort((a, b) => a[1] - b[1])
          .map(([team_id]) => team_id),
      })

      if (error) {
        // rpc_fill_tournament_slots_manual이 없으면 일반 fill 호출
        if (error.message.includes('does not exist') || error.code === '42883') {
          const { data: fillData, error: fillError } = await supabase.rpc('rpc_fill_tournament_slots', {
            p_event_id: eventId,
            p_group_id: groupId,
          })
          if (fillError) { setMsg('❌ ' + fillError.message); return }
          setMsg(`✅ ${groupLabel} 본선 진출 확정! (자동 순위 적용)`)
        } else {
          setMsg('❌ ' + error.message); return
        }
      } else {
        setMsg(`✅ ${groupLabel} 수동 순위 확정 및 본선 슬롯 채우기 완료!`)
      }

      setRankModal(null)
      loadGroups()
    } finally {
      setSavingRank(false)
    }
  }

  // 본선 슬롯 자동 채우기 (자동 순위로)
  async function fillSlots(groupId: string, groupLabel: string) {
    setFillingGroup(groupId)
    setMsg('')
    const { data, error } = await supabase.rpc('rpc_fill_tournament_slots', {
      p_event_id: eventId,
      p_group_id: groupId,
    })
    setFillingGroup(null)
    if (error) { setMsg('❌ ' + error.message); return }
    if (!data?.success) { setMsg('❌ ' + (data?.error || '실패')); return }
    setMsg(
      `✅ ${groupLabel} 본선 슬롯 채우기 완료!` +
      ` (채움 ${data.filled}개${data.remaining_tbd > 0 ? ` · 남은 TBD ${data.remaining_tbd}` : ' · 모든 TBD 해소'})`
    )
    loadGroups()
  }

  const allMembers = groups.flatMap(g => g.members)
  const checkedCount = allMembers.filter(m => m.checked_in).length
  const totalCount = allMembers.length

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">🎯 조편성</h1>
        {totalCount > 0 && (
          <div className="flex items-center gap-2">
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-2 text-center">
              <span className="text-lg font-black text-green-600">{checkedCount}</span>
              <span className="text-stone-400 text-sm"> / {totalCount}</span>
              <span className="text-xs text-stone-400 ml-1">참석</span>
            </div>
            <button onClick={loadGroups}
              className="text-xs text-stone-400 hover:text-stone-600 bg-stone-100 px-3 py-2 rounded-lg">↺</button>
          </div>
        )}
      </div>

      <DivisionTabs divisions={divisions} selected={selected} onSelect={setSelected} />

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* 조편성 도구 */}
      <div className="bg-white rounded-xl border p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm text-stone-600">조당 인원:</label>
            <select value={groupSize} onChange={e => setGroupSize(Number(e.target.value))}
              className="border rounded-lg px-3 py-1.5 text-sm">
              {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}팀</option>)}
            </select>
          </div>
          <button onClick={generateGroups} disabled={generating}
            className="bg-tennis-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-tennis-700 disabled:opacity-50">
            {generating ? '생성 중...' : '🎲 자동 조편성'}
          </button>
          <button onClick={generateGroupMatches} disabled={generating || groups.length === 0}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            📋 조별 경기 생성
          </button>
          {groups.length > 0 && (
            <button onClick={deleteAllGroups}
              className="bg-red-100 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200">
              🗑️ 전체 삭제
            </button>
          )}
        </div>
        <p className="text-xs text-stone-400 mt-2">
          * 1팀 조 방지 보정 자동 적용 (2+1→3, 3+1→2+2, 4+1→3+2)
        </p>
      </div>

      {/* 범례 */}
      {totalCount > 0 && (
        <div className="flex items-center gap-4 mb-3 px-1">
          <div className="flex items-center gap-1.5 text-xs text-stone-500">
            <span className="w-3 h-3 rounded-sm bg-green-100 border border-green-300 inline-block" />참석 확인
          </div>
          <div className="flex items-center gap-1.5 text-xs text-stone-400">
            <span className="w-3 h-3 rounded-sm bg-white border border-stone-200 inline-block" />미확인
          </div>
        </div>
      )}

      {/* 조 편성 결과 */}
      {loading ? (
        <p className="text-stone-400 text-center py-10">불러오는 중...</p>
      ) : groups.length === 0 ? (
        <p className="text-stone-400 text-center py-10">아직 조편성이 없습니다. 자동 조편성 버튼을 눌러주세요.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map(g => {
            const gChecked = g.members.filter(m => m.checked_in).length
            const gStandings = standings[g.id] || []
            const isDone = groupDone[g.id] ?? false
            const hasTie = isDone && gStandings.some(s => s.rank === null)
            const allRanked = isDone && gStandings.length > 0 && gStandings.every(s => s.rank !== null)

            return (
              <div key={g.id} className="bg-white rounded-xl border overflow-hidden">
                {/* 조 헤더 */}
                <div className={`text-white px-4 py-2 font-bold text-sm flex justify-between items-center ${
                  hasTie ? 'bg-amber-500' : isDone ? 'bg-tennis-600' : 'bg-tennis-600'
                }`}>
                  <div className="flex items-center gap-2">
                    <span>{g.label}</span>
                    {hasTie && <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full animate-pulse">⚠️ 동률</span>}
                    {isDone && !hasTie && <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">✅ 완료</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">{gChecked}/{g.members.length}</span>
                    <span className="text-white/60">{g.members.length}팀</span>
                  </div>
                </div>

                {/* 순위표 (경기 완료 시) */}
                {isDone && gStandings.length > 0 && (
                  <div className="border-b border-stone-100 bg-stone-50 px-3 py-2">
                    <div className="text-xs text-stone-400 mb-1.5 font-medium">경기 결과</div>
                    {gStandings.map((s, i) => (
                      <div key={s.team_id} className={`flex items-center gap-2 py-1 text-xs ${
                        s.rank === 1 ? 'text-tennis-700 font-bold' :
                        s.rank === 2 ? 'text-blue-600 font-medium' :
                        'text-stone-400'
                      }`}>
                        {/* 순위 배지 */}
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                          s.rank === null ? 'bg-amber-100 text-amber-600' :
                          s.rank === 1 ? 'bg-tennis-600 text-white' :
                          s.rank === 2 ? 'bg-blue-500 text-white' :
                          'bg-stone-200 text-stone-500'
                        }`}>
                          {s.rank === null ? '?' : s.rank}
                        </span>
                        <span className="flex-1 truncate">{s.team_name}</span>
                        <span className="text-stone-400 font-mono">{s.wins}승 {s.losses}패</span>
                        <span className={`font-mono ${s.game_diff > 0 ? 'text-tennis-600' : s.game_diff < 0 ? 'text-red-400' : 'text-stone-400'}`}>
                          {s.game_diff > 0 ? '+' : ''}{s.game_diff}
                        </span>
                      </div>
                    ))}

                    {/* 액션 버튼 */}
                    <div className="flex gap-1.5 mt-2">
                      {hasTie && (
                        <button
                          onClick={() => openRankModal(g)}
                          className="flex-1 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-white hover:bg-amber-600"
                        >
                          ✏️ 순위 직접 지정
                        </button>
                      )}
                      {allRanked && (
                        <button
                          onClick={() => fillSlots(g.id, g.label)}
                          disabled={fillingGroup === g.id}
                          className="flex-1 py-1.5 rounded-lg text-xs font-bold bg-tennis-600 text-white hover:bg-tennis-700 disabled:opacity-50"
                        >
                          {fillingGroup === g.id ? '처리 중...' : '🏆 본선 슬롯 채우기'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* 팀 목록 */}
                <div className="p-3">
                  {g.members.map((m, i) => (
                    <div key={m.id} className={`flex items-center gap-2 py-1.5 px-2 rounded-lg mb-1 last:mb-0 ${
                      m.checked_in ? 'bg-green-50 border border-green-200' : 'border border-transparent'
                    }`}>
                      {m.checked_in ? (
                        <span className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-[10px] text-white font-bold flex-shrink-0">✓</span>
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-400 flex-shrink-0">{i + 1}</span>
                      )}
                      <span className={`text-sm font-medium flex-1 ${m.checked_in ? 'text-green-800' : 'text-stone-700'}`}>
                        {m.team_name}
                      </span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {m.seed > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">시드 {m.seed}</span>
                        )}
                        {m.checked_in && m.checked_in_at ? (
                          <span className="text-xs text-green-500 font-mono">{formatTime(m.checked_in_at)}</span>
                        ) : !m.checked_in ? (
                          <span className="text-xs text-stone-300">미확인</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 수동 순위 지정 모달 */}
      {rankModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setRankModal(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">✏️ 순위 직접 지정</h3>
            <p className="text-xs text-stone-400 mb-4">
              {rankModal.groupLabel} · 승수/게임득실 동률 — 직접 순위를 지정해주세요
            </p>

            <div className="space-y-2 mb-6">
              {rankModal.teams.map(s => (
                <div key={s.team_id} className="flex items-center gap-3 p-3 bg-stone-50 rounded-xl">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-stone-800 truncate">{s.team_name}</div>
                    <div className="text-xs text-stone-400 mt-0.5">
                      {s.wins}승 {s.losses}패 · 득실 {s.game_diff > 0 ? '+' : ''}{s.game_diff}
                    </div>
                  </div>
                  <select
                    value={manualRanks[s.team_id] ?? ''}
                    onChange={e => setManualRanks(prev => ({ ...prev, [s.team_id]: Number(e.target.value) }))}
                    className="border-2 border-amber-300 rounded-lg px-2 py-1.5 text-sm font-bold w-16 text-center focus:border-amber-500 focus:outline-none"
                  >
                    <option value="">-</option>
                    {rankModal.teams.map((_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1}위</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* 중복 경고 */}
            {(() => {
              const vals = Object.values(manualRanks).filter(Boolean)
              const hasDup = new Set(vals).size !== vals.length
              return hasDup ? (
                <p className="text-xs text-red-500 mb-3 text-center">⚠️ 중복된 순위가 있습니다</p>
              ) : null
            })()}

            <div className="flex gap-2">
              <button onClick={() => setRankModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">
                취소
              </button>
              <button
                onClick={saveManualRanks}
                disabled={savingRank || Object.values(manualRanks).some(v => !v) ||
                  new Set(Object.values(manualRanks)).size !== rankModal.teams.length}
                className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white font-bold text-sm hover:bg-amber-600 disabled:opacity-50"
              >
                {savingRank ? '처리 중...' : '순위 확정 + 본선 진출'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
