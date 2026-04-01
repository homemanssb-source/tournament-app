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

export default function GroupsPage() {
  const eventId = useEventId()
  const { divisions, selected, setSelected } = useDivisions(eventId)
  const [groups, setGroups] = useState<GroupData[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [generating, setGenerating] = useState(false)
  const [groupSize, setGroupSize] = useState(4)

  // ★ FIX-4: useCallback으로 감싸서 stale closure 방지
  const loadGroups = useCallback(async () => {
    if (!eventId || !selected) return
    // ★ FIX-3: try/finally로 항상 setLoading(false) 보장
    setLoading(true)
    try {
      // v_group_board 조회 (기존 동일)
      const { data: rows } = await supabase.from('v_group_board').select('*')
        .eq('event_id', eventId).eq('division_id', selected)
        .order('group_num').order('team_num')

      // ★ team_id 목록으로 teams.checked_in 별도 조회
      const teamIds = [...new Set((rows || []).map((r: any) => r.team_id))]
      const checkedInMap = new Map<string, { checked_in: boolean; checked_in_at: string | null }>()

      if (teamIds.length > 0) {
        const { data: teamRows } = await supabase
          .from('teams')
          .select('id, checked_in, checked_in_at')
          .in('id', teamIds)
        for (const t of (teamRows || [])) {
          checkedInMap.set(t.id, {
            checked_in: t.checked_in ?? false,
            checked_in_at: t.checked_in_at ?? null,
          })
        }
      }

      const map = new Map<string, GroupData>()
      for (const r of (rows || [])) {
        if (!map.has(r.group_id)) {
          map.set(r.group_id, { id: r.group_id, label: r.group_label, num: r.group_num, members: [] })
        }
        const ci = checkedInMap.get(r.team_id)
        map.get(r.group_id)!.members.push({
          id: r.member_id,
          team_id: r.team_id,
          team_name: r.team_name,
          seed: r.seed || 0,
          checked_in: ci?.checked_in ?? false,
          checked_in_at: ci?.checked_in_at ?? null,
        })
      }
      setGroups(Array.from(map.values()).sort((a, b) => a.num - b.num))
    } finally {
      // ★ FIX-3: 조회 실패해도 반드시 로딩 해제
      setLoading(false)
    }
  }, [eventId, selected]) // ★ FIX-4: 의존성 배열에 eventId, selected 추가

  useEffect(() => { loadGroups() }, [loadGroups])

  // ★ 30초 자동 갱신 — loadGroups가 useCallback이므로 stale closure 없음
  useEffect(() => {
    if (!eventId || !selected) return
    const iv = setInterval(() => loadGroups(), 30000)
    return () => clearInterval(iv)
  }, [loadGroups])

  async function generateGroups() {
    setGenerating(true); setMsg('')
    const { data, error } = await supabase.rpc('rpc_generate_groups', {
      p_event_id: eventId,
      p_division_id: selected,
      p_group_size: groupSize,
    })
    setGenerating(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg(`✅ 조편성 완료! ${data?.groups_created || ''}개 조 생성`)
    loadGroups()
  }

  async function generateGroupMatches() {
    setGenerating(true); setMsg('')
    const { data, error } = await supabase.rpc('rpc_generate_group_matches', {
      p_event_id: eventId,
      p_division_id: selected,
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

  // 전체 참석 통계
  const allMembers = groups.flatMap(g => g.members)
  const checkedCount = allMembers.filter(m => m.checked_in).length
  const totalCount = allMembers.length

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      {/* 헤더: 제목 + 참석 카운터 */}
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
              className="text-xs text-stone-400 hover:text-stone-600 bg-stone-100 px-3 py-2 rounded-lg">
              ↺
            </button>
          </div>
        )}
      </div>

      <DivisionTabs divisions={divisions} selected={selected} onSelect={setSelected} />

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* 조편성 도구 (기존 그대로) */}
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
            <span className="w-3 h-3 rounded-sm bg-green-100 border border-green-300 inline-block" />
            참석 확인
          </div>
          <div className="flex items-center gap-1.5 text-xs text-stone-400">
            <span className="w-3 h-3 rounded-sm bg-white border border-stone-200 inline-block" />
            미확인
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
            return (
              <div key={g.id} className="bg-white rounded-xl border overflow-hidden">
                {/* 조 헤더 + 조별 참석 카운터 */}
                <div className="bg-tennis-600 text-white px-4 py-2 font-bold text-sm flex justify-between items-center">
                  <span>{g.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">
                      {gChecked}/{g.members.length}
                    </span>
                    <span className="text-white/60">{g.members.length}팀</span>
                  </div>
                </div>

                {/* 팀 목록 */}
                <div className="p-3">
                  {g.members.map((m, i) => (
                    <div key={m.id} className={`flex items-center gap-2 py-1.5 px-2 rounded-lg mb-1 last:mb-0 ${
                      m.checked_in
                        ? 'bg-green-50 border border-green-200'
                        : 'border border-transparent'
                    }`}>
                      {/* 순번 or 체크 */}
                      {m.checked_in ? (
                        <span className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-[10px] text-white font-bold flex-shrink-0">
                          ✓
                        </span>
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-400 flex-shrink-0">
                          {i + 1}
                        </span>
                      )}

                      {/* 팀명 */}
                      <span className={`text-sm font-medium flex-1 ${m.checked_in ? 'text-green-800' : 'text-stone-700'}`}>
                        {m.team_name}
                      </span>

                      {/* 시드 + 확인시간 or 미확인 */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {m.seed > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                            시드 {m.seed}
                          </span>
                        )}
                        {m.checked_in && m.checked_in_at ? (
                          <span className="text-xs text-green-500 font-mono">
                            {formatTime(m.checked_in_at)}
                          </span>
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
    </div>
  )
}
