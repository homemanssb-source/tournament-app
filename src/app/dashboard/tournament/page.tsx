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

  // 진출 설정
  const [advancePerGroup, setAdvancePerGroup] = useState(1)

  useEffect(() => { if (eventId && selected) loadBracket() }, [eventId, selected])

  async function loadBracket() {
    setLoading(true)
    const { data } = await supabase.from('v_bracket_with_details').select('*')
      .eq('event_id', eventId).eq('division_id', selected)
      .order('slot')
    setBracket(data || [])
    setLoading(false)
  }

  async function generateTournament() {
    setGenerating(true); setMsg('')
    const { data, error } = await supabase.rpc('rpc_generate_tournament', {
      p_event_id: eventId,
      p_division_id: selected,
      p_advance_per_group: advancePerGroup,
    })
    setGenerating(false)

    if (error) { setMsg('❌ ' + error.message); return }
    setMsg(`✅ 본선 토너먼트 생성 완료! ${data?.matches_created || ''}경기 (BYE ${data?.byes || 0}개)`)
    loadBracket()
  }

  async function deleteTournament() {
    if (!confirm('현재 부서의 본선 토너먼트를 삭제하시겠습니까?')) return
    setMsg('')

    // bracket_nodes → matches(FINALS) 삭제
    const matchIds = bracket.map(b => b.match_id).filter(Boolean)
    if (matchIds.length > 0) {
      await supabase.from('bracket_nodes').delete().in('match_id', matchIds)
      await supabase.from('matches').delete().eq('event_id', eventId).eq('division_id', selected).eq('stage', 'FINALS')
    }
    setMsg('✅ 본선 토너먼트 삭제됨')
    loadBracket()
  }

  // 조별 리그 완료 상태 확인
  const [groupProgress, setGroupProgress] = useState({ total: 0, finished: 0 })
  useEffect(() => {
    if (!eventId || !selected) return
    supabase.from('matches').select('id, status')
      .eq('event_id', eventId).eq('division_id', selected).eq('stage', 'GROUP')
      .then(({ data }) => {
        const all = data || []
        setGroupProgress({ total: all.length, finished: all.filter(m => m.status === 'FINISHED').length })
      })
  }, [eventId, selected])

  const allGroupsDone = groupProgress.total > 0 && groupProgress.finished === groupProgress.total

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">🏆 본선 토너먼트</h1>
      <DivisionTabs divisions={divisions} selected={selected} onSelect={setSelected} />

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* 조별 진행률 */}
      <div className={`mb-4 p-3 rounded-xl text-sm ${allGroupsDone ? 'bg-tennis-50 text-tennis-700' : 'bg-amber-50 text-amber-700'}`}>
        📊 조별 리그 진행: {groupProgress.finished}/{groupProgress.total}경기
        {allGroupsDone ? ' ✅ 완료!' : ' (본선 생성을 위해 모든 조별 경기를 완료해주세요)'}
      </div>

      {/* 토너먼트 생성 도구 */}
      <div className="bg-white rounded-xl border p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm text-stone-600">조별 진출:</label>
            <select value={advancePerGroup} onChange={e => setAdvancePerGroup(Number(e.target.value))}
              className="border rounded-lg px-3 py-1.5 text-sm">
              {[1, 2, 3].map(n => <option key={n} value={n}>상위 {n}팀</option>)}
            </select>
          </div>
          <button onClick={generateTournament} disabled={generating}
            className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50">
            {generating ? '생성 중...' : '🏆 본선 토너먼트 생성'}
          </button>
          {bracket.length > 0 && (
            <button onClick={deleteTournament}
              className="bg-red-100 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200">
              🗑️ 삭제
            </button>
          )}
        </div>
        <p className="text-xs text-stone-400 mt-2">
          * 시드 배치 + BYE 자동 배정 + 같은 조 1R 회피
        </p>
      </div>

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
