'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard'

interface GroupData {
  id: string; label: string; num: number
  members: { id: string; team_id: string; team_name: string; seed: number }[]
}

export default function GroupsPage() {
  const eventId = useEventId()
  const { divisions, selected, setSelected } = useDivisions(eventId)
  const [groups, setGroups] = useState<GroupData[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [generating, setGenerating] = useState(false)
  const [groupSize, setGroupSize] = useState(4)

  useEffect(() => { if (eventId && selected) loadGroups() }, [eventId, selected])

  async function loadGroups() {
    setLoading(true)
    const { data: rows } = await supabase.from('v_group_board').select('*')
      .eq('event_id', eventId).eq('division_id', selected)
      .order('group_num').order('team_num')

    const map = new Map<string, GroupData>()
    for (const r of (rows || [])) {
      if (!map.has(r.group_id)) map.set(r.group_id, { id: r.group_id, label: r.group_label, num: r.group_num, members: [] })
      map.get(r.group_id)!.members.push({
        id: r.member_id, team_id: r.team_id, team_name: r.team_name, seed: r.seed || 0,
      })
    }
    setGroups(Array.from(map.values()).sort((a, b) => a.num - b.num))
    setLoading(false)
  }

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
    // group_members → groups 순서로 삭제 (또는 CASCADE)
    const groupIds = groups.map(g => g.id)
    if (groupIds.length === 0) return

    await supabase.from('group_members').delete().in('group_id', groupIds)
    await supabase.from('matches').delete().eq('event_id', eventId).eq('division_id', selected).eq('stage', 'GROUP')
    await supabase.from('groups').delete().in('id', groupIds)
    setMsg('✅ 조편성 삭제됨')
    loadGroups()
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">🎯 조편성</h1>
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

      {/* 조 편성 결과 */}
      {loading ? (
        <p className="text-stone-400 text-center py-10">불러오는 중...</p>
      ) : groups.length === 0 ? (
        <p className="text-stone-400 text-center py-10">아직 조편성이 없습니다. 자동 조편성 버튼을 눌러주세요.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map(g => (
            <div key={g.id} className="bg-white rounded-xl border overflow-hidden">
              <div className="bg-tennis-600 text-white px-4 py-2 font-bold text-sm flex justify-between">
                <span>{g.label}</span>
                <span className="text-white/60">{g.members.length}팀</span>
              </div>
              <div className="p-3">
                {g.members.map((m, i) => (
                  <div key={m.id} className="flex items-center gap-2 py-1.5 border-b border-stone-50 last:border-0">
                    <span className="w-5 h-5 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-400">
                      {i + 1}
                    </span>
                    <span className="text-sm font-medium flex-1">{m.team_name}</span>
                    {m.seed > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">시드 {m.seed}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
