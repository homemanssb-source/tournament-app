'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard'
import TournamentBracket from '@/components/TournamentBracket'

export default function TournamentPage() {
  const eventId = useEventId()
  const { divisions, selected, setSelected } = useDivisions(eventId)
  const [bracket, setBracket] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [generating, setGenerating] = useState(false)
  const [advancePerGroup, setAdvancePerGroup] = useState(2)

  // 조별 진행 현황
  const [groupProgress, setGroupProgress] = useState<{
    total: number
    finished: number
    groups: { id: string; name: string; total: number; finished: number }[]
  }>({ total: 0, finished: 0, groups: [] })

  // TBD 슬롯 현황 (브래킷 생성 후)
  const [tbdSlots, setTbdSlots] = useState<{
    label: string; matchId: string; slot: 'A' | 'B'
  }[]>([])

  // 수동 fill 진행 중
  const [filling, setFilling] = useState<string | null>(null)

  useEffect(() => {
    if (eventId && selected) {
      loadBracket()
      loadGroupProgress()
    }
  }, [eventId, selected])

  async function loadGroupProgress() {
    if (!eventId || !selected) return

    // 그룹 목록
    const { data: groups } = await supabase
      .from('groups')
      .select('id, name')
      .eq('event_id', eventId)
      .eq('division_id', selected)
      .order('group_num')

    if (!groups || groups.length === 0) {
      // 그룹 없는 경우 전체 GROUP 경기 집계
      const { data } = await supabase
        .from('matches')
        .select('id, status')
        .eq('event_id', eventId)
        .eq('division_id', selected)
        .eq('stage', 'GROUP')
      const all = data || []
      setGroupProgress({
        total: all.length,
        finished: all.filter(m => m.status === 'FINISHED').length,
        groups: [],
      })
      return
    }

    // 그룹별 경기 현황
    const { data: matches } = await supabase
      .from('matches')
      .select('id, status, group_id')
      .eq('event_id', eventId)
      .eq('division_id', selected)
      .eq('stage', 'GROUP')

    const all = matches || []
    const groupStats = groups.map(g => {
      const gm = all.filter(m => m.group_id === g.id)
      return {
        id: g.id,
        name: g.name,
        total: gm.length,
        finished: gm.filter(m => m.status === 'FINISHED').length,
      }
    })

    setGroupProgress({
      total: all.length,
      finished: all.filter(m => m.status === 'FINISHED').length,
      groups: groupStats,
    })
  }

  async function loadBracket() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('v_bracket_with_details')
        .select('*')
        .eq('event_id', eventId)
        .eq('division_id', selected)
        .order('slot')
      setBracket(data || [])

      // TBD 슬롯 파악
      // [4] .or('...not.is.null') PostgREST 미지원 → 전체 조회 후 클라이언트 필터
      const { data: tbdData } = await supabase
        .from('matches')
        .select('id, qualifier_label_a, qualifier_label_b, round')
        .eq('event_id', eventId)
        .eq('division_id', selected)
        .eq('stage', 'FINALS')

      const slots: { label: string; matchId: string; slot: 'A' | 'B' }[] = []
      for (const m of tbdData || []) {
        // 클라이언트에서 null 필터
        if (m.qualifier_label_a) slots.push({ label: m.qualifier_label_a, matchId: m.id, slot: 'A' })
        if (m.qualifier_label_b) slots.push({ label: m.qualifier_label_b, matchId: m.id, slot: 'B' })
      }
      setTbdSlots(slots)
    } finally {
      // [5] 에러 발생해도 반드시 로딩 해제
      setLoading(false)
    }
  }

  // 본선 생성 (allowTbd: true = 미리 생성, false = 기존)
  async function generateTournament(allowTbd: boolean) {
    setGenerating(true)
    setMsg('')
    const { data, error } = await supabase.rpc('rpc_generate_tournament', {
      p_event_id: eventId,
      p_division_id: selected,
      p_advance_per_group: advancePerGroup,
      p_allow_tbd: allowTbd,
    })
    setGenerating(false)

    if (error) { setMsg('❌ ' + error.message); return }

    const tbd = data?.tbd_slots || 0
    setMsg(
      `✅ 본선 토너먼트 생성 완료! ${data?.matches_created || ''}경기` +
      ` (BYE ${data?.byes || 0}개)` +
      (tbd > 0 ? ` • TBD ${tbd}슬롯 — 조별 경기 완료 시 자동으로 채워집니다` : '')
    )
    loadBracket()
    loadGroupProgress()
  }

  async function deleteTournament() {
    if (!confirm('현재 부서의 본선 토너먼트를 삭제하시겠습니까?')) return
    setMsg('')
    const matchIds = bracket.map(b => b.match_id).filter(Boolean)
    if (matchIds.length > 0) {
      await supabase.from('bracket_nodes').delete().in('match_id', matchIds)
      await supabase.from('matches').delete()
        .eq('event_id', eventId).eq('division_id', selected).eq('stage', 'FINALS')
    }
    setMsg('🗑️ 본선 토너먼트 삭제 완료')
    setBracket([])
    setTbdSlots([])
    loadBracket()
  }

  // 특정 그룹 슬롯 수동 채우기 (테스트/긴급용)
  async function fillGroupSlots(groupId: string, groupName: string) {
    setFilling(groupId)
    const { data, error } = await supabase.rpc('rpc_fill_tournament_slots', {
      p_event_id: eventId,
      p_group_id: groupId,
    })
    setFilling(null)

    if (error) { setMsg('❌ ' + error.message); return }
    if (!data?.success) { setMsg('❌ ' + (data?.error || '슬롯 채우기 실패')); return }

    setMsg(
      `✅ ${groupName} 슬롯 채우기 완료!` +
      ` (채움 ${data.filled}개, BYE처리 ${data.bye_processed}개)` +
      (data.remaining_tbd > 0 ? ` • 남은 TBD: ${data.remaining_tbd}` : ' • 모든 TBD 해소!')
    )
    loadBracket()
    loadGroupProgress()
  }

  const allGroupsDone = groupProgress.total > 0 && groupProgress.finished === groupProgress.total
  const hasBracket = bracket.length > 0
  const hasTbd = tbdSlots.length > 0

  if (!eventId) return <p className="text-stone-400">대회를 먼저 선택해주세요.</p>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">🏆 본선 토너먼트</h1>
      <DivisionTabs divisions={divisions} selected={selected} onSelect={setSelected} />

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${
          msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'
        }`}>
          {msg}
        </div>
      )}

      {/* 조별 진행 현황 카드 */}
      <div className={`mb-4 p-4 rounded-xl border text-sm ${
        allGroupsDone
          ? 'bg-green-50 border-green-200 text-green-800'
          : 'bg-amber-50 border-amber-200 text-amber-800'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold">
            {allGroupsDone ? '✅ 조별 예선 완료!' : '⏳ 조별 예선 진행 중'}
          </span>
          <span className="text-xs font-mono font-bold">
            {groupProgress.finished}/{groupProgress.total}경기
          </span>
        </div>

        {/* 조별 상세 진행 현황 */}
        {groupProgress.groups.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {groupProgress.groups.map(g => {
              const done = g.total > 0 && g.finished === g.total
              return (
                <div key={g.id} className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  done
                    ? 'bg-green-100 text-green-700'
                    : g.finished > 0
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-stone-100 text-stone-500'
                }`}>
                  <span>{done ? '✓' : `${g.finished}/${g.total}`}</span>
                  <span>{g.name}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 브래킷 생성 패널 */}
      {!hasBracket && (
        <div className="bg-white rounded-xl border p-4 mb-4">
          <div className="flex flex-wrap gap-3 items-center mb-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-stone-600">조별 진출:</label>
              <select
                value={advancePerGroup}
                onChange={e => setAdvancePerGroup(Number(e.target.value))}
                className="border rounded-lg px-3 py-1.5 text-sm"
              >
                {[1, 2, 3].map(n => <option key={n} value={n}>각 조 {n}위</option>)}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {/* 예선 완료된 경우만 기존 버튼 */}
            {allGroupsDone ? (
              <button
                onClick={() => generateTournament(false)}
                disabled={generating}
                className="bg-tennis-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-tennis-700 disabled:opacity-50"
              >
                {generating ? '생성 중...' : '🏆 본선 토너먼트 생성'}
              </button>
            ) : (
              <>
                {/* 예선 미완료: 미리 생성 버튼만 표시 */}
                <button
                  onClick={() => generateTournament(true)}
                  disabled={generating}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {generating ? '생성 중...' : '🚀 본선 브래킷 미리 생성 (TBD)'}
                </button>
                <button
                  onClick={() => generateTournament(false)}
                  disabled={generating}
                  className="bg-stone-400 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-stone-500 disabled:opacity-50"
                >
                  {generating ? '생성 중...' : '🏆 예선 완료 후 생성'}
                </button>
              </>
            )}
          </div>

          <div className="mt-2 space-y-0.5">
            <p className="text-xs text-stone-400">* 시드 배치 + BYE 자동 배정 + 같은 조 1R 회피</p>
            {!allGroupsDone && (
              <p className="text-xs text-blue-500">
                * 미리 생성 시: 완료된 조는 실제 팀명, 미완료 조는 "A조 1위" 형태로 표시됩니다.
                조 경기가 끝나면 자동으로 팀명이 채워집니다.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 브래킷 존재 시: 삭제 버튼 + TBD 현황 */}
      {hasBracket && (
        <div className="bg-white rounded-xl border p-4 mb-4">
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={deleteTournament}
              className="bg-red-100 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200"
            >
              🗑️ 삭제
            </button>

            {/* TBD 슬롯 있을 때 조별 수동 채우기 버튼 */}
            {hasTbd && groupProgress.groups.length > 0 && (
              <div className="flex flex-wrap gap-1.5 ml-2">
                {groupProgress.groups
                  .filter(g => g.total > 0 && g.finished === g.total)
                  .filter(g => tbdSlots.some(t => t.label.startsWith(g.name)))
                  .map(g => (
                    <button
                      key={g.id}
                      onClick={() => fillGroupSlots(g.id, g.name)}
                      disabled={filling === g.id}
                      className="bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-200 disabled:opacity-50"
                    >
                      {filling === g.id ? '처리 중...' : `✅ ${g.name} 슬롯 채우기`}
                    </button>
                  ))
                }
              </div>
            )}
          </div>

          {/* TBD 현황 요약 */}
          {hasTbd && (
            <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
              <p className="text-xs font-semibold text-blue-800 mb-1.5">
                ⏳ TBD 슬롯 {tbdSlots.length}개 — 조 경기 완료 시 자동으로 팀명이 채워집니다
              </p>
              <div className="flex flex-wrap gap-1">
                {tbdSlots.map((t, i) => (
                  <span key={i} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {!hasTbd && !allGroupsDone && (
            <p className="text-xs text-stone-400 mt-2">모든 TBD 슬롯이 채워졌습니다 ✓</p>
          )}
        </div>
      )}

      {/* 브래킷 표시 */}
      {loading ? (
        <p className="text-stone-400 text-center py-10">불러오는 중...</p>
      ) : bracket.length === 0 ? (
        <p className="text-stone-400 text-center py-10">아직 본선 토너먼트가 없습니다.</p>
      ) : (
        <div className="bg-white rounded-xl border p-4 overflow-hidden">
          <TournamentBracket matches={bracket} />
        </div>
      )}
    </div>
  )
}
