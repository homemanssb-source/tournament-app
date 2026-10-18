'use client'
// ============================================================
// 부서 현황 표 — 조편성 화면(개인전/단체전) 맨 위
// 팀·인원·참석, 진행방식(풀리그 / 조별+본선) 선택, 두 방식의 경기 수 비교, 진행 상태
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { calcGroupDistribution } from '@/lib/seed'
import {
  type DivisionFormat, recommendedFormat, fullLeagueMatchCount, groupKnockoutMatchCount, FULL_LEAGUE_RECOMMEND_MAX,
} from '@/lib/league'

interface Row {
  id: string; name: string; format: DivisionFormat
  explicit: boolean       // divisions.format 에 저장돼 있음
  teams: number; people: number; checked: number | null
  matches: number; started: boolean; done: boolean; grouped: boolean
}

const STATUS = (r: Row) =>
  r.done ? { t: '완료', c: 'bg-stone-200 text-stone-600' }
  : r.started ? { t: '진행 중', c: 'bg-red-100 text-red-700' }
  : r.matches > 0 ? { t: '경기 생성', c: 'bg-blue-100 text-blue-700' }
  : r.grouped ? { t: '편성됨', c: 'bg-amber-100 text-amber-700' }
  : { t: '미편성', c: 'bg-stone-100 text-stone-500' }

export default function DivisionOverview({ eventId, kind, selected, onSelect, reloadKey, onChanged }: {
  eventId: string
  kind: 'individual' | 'team'
  selected?: string
  onSelect?: (divisionId: string) => void
  reloadKey?: number
  onChanged?: () => void      // 진행방식이 바뀌면 부모 화면도 새로
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(true)
  const [saving, setSaving] = useState('')

  const load = useCallback(async () => {
    if (!eventId) return
    const { data: divs } = await supabase.from('divisions').select('*').eq('event_id', eventId).order('sort_order')
    const divList = (divs || []) as any[]
    let eventFormat: DivisionFormat = 'group_knockout'
    const out: Row[] = []

    if (kind === 'individual') {
      const [{ data: teams }, { data: groups }, { data: matches }] = await Promise.all([
        supabase.from('teams').select('id, division_id, player2_name, checked_in').eq('event_id', eventId),
        supabase.from('groups').select('id, division_id').eq('event_id', eventId),
        supabase.from('matches').select('division_id, status, score').eq('event_id', eventId),
      ])
      for (const d of divList) {
        const ts = (teams || []).filter((t: any) => t.division_id === d.id)
        const ms = (matches || []).filter((m: any) => m.division_id === d.id && m.score !== 'BYE')
        out.push({
          id: d.id, name: d.name, format: (d.format as DivisionFormat) || eventFormat, explicit: !!d.format,
          teams: ts.length,
          people: ts.reduce((s: number, t: any) => s + (t.player2_name ? 2 : 1), 0),
          checked: ts.filter((t: any) => t.checked_in).length,
          matches: ms.length,
          started: ms.some((m: any) => m.status !== 'PENDING'),
          done: ms.length > 0 && ms.every((m: any) => m.status === 'FINISHED'),
          grouped: (groups || []).some((g: any) => g.division_id === d.id),
        })
      }
    } else {
      const { data: ev } = await supabase.from('events').select('team_format').eq('id', eventId).single()
      eventFormat = ev?.team_format === 'full_league' ? 'full_league' : 'group_knockout'
      const [{ data: clubs }, { data: groups }, { data: ties }] = await Promise.all([
        supabase.from('clubs').select('id, division_id').eq('event_id', eventId),
        supabase.from('groups').select('id, division_id').eq('event_id', eventId),
        supabase.from('ties').select('division_id, status').eq('event_id', eventId),
      ])
      const clubIds = (clubs || []).map((c: any) => c.id)
      const { data: mems } = clubIds.length
        ? await supabase.from('club_members').select('club_id').in('club_id', clubIds)
        : { data: [] as any[] }
      for (const d of divList) {
        const cs = (clubs || []).filter((c: any) => c.division_id === d.id)
        const csIds = new Set(cs.map((c: any) => c.id))
        const ts = (ties || []).filter((t: any) => t.division_id === d.id)
        out.push({
          id: d.id, name: d.name, format: (d.format as DivisionFormat) || eventFormat, explicit: !!d.format,
          teams: cs.length,
          people: (mems || []).filter((m: any) => csIds.has(m.club_id)).length,
          checked: null,
          matches: ts.length,
          started: ts.some((t: any) => t.status && t.status !== 'pending'),
          done: ts.length > 0 && ts.every((t: any) => t.status === 'completed'),
          grouped: (groups || []).some((g: any) => g.division_id === d.id),
        })
      }
    }
    setRows(out)
  }, [eventId, kind])

  useEffect(() => { load() }, [load, reloadKey])

  async function changeFormat(r: Row, format: DivisionFormat) {
    if (r.matches > 0 || r.grouped) {
      alert('이미 조편성·경기가 있는 부서는 진행방식을 바꿀 수 없습니다. 먼저 조편성을 삭제하세요.')
      return
    }
    setSaving(r.id)
    try {
      // 진행방식이 비어 있는 다른 부서도 지금 보이는 값으로 저장 → 대회 설정이 바뀌어도 부서별 방식 유지
      const unset = rows.filter(x => !x.explicit && x.id !== r.id)
      for (const x of unset) await supabase.from('divisions').update({ format: x.format }).eq('id', x.id)
      const { error } = await supabase.from('divisions').update({ format }).eq('id', r.id)
      if (error) { alert('저장 실패: ' + error.message); return }
      await load()
      onChanged?.()
    } finally { setSaving('') }
  }

  if (!rows.length) return null
  const total = rows.reduce((s, r) => ({ teams: s.teams + r.teams, people: s.people + r.people }), { teams: 0, people: 0 })
  const groupSize = kind === 'individual' ? 4 : 3

  return (
    <div className="bg-white rounded-xl border border-stone-200 mb-4 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-stone-50">
        <span className="font-semibold text-sm">📋 부서 현황 <span className="text-stone-400 font-normal">· {rows.length}개 부서 · {total.teams}팀 · {total.people}명</span></span>
        <span className="text-stone-400 text-xs">{open ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-stone-100">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2">부서</th>
                <th className="px-2 py-2">팀</th>
                <th className="px-2 py-2">인원</th>
                {kind === 'individual' && <th className="px-2 py-2">참석</th>}
                <th className="px-2 py-2">진행방식</th>
                <th className="text-left px-2 py-2">경기 수 (풀리그 / 조별+본선)</th>
                <th className="px-2 py-2">상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map(r => {
                const rec = recommendedFormat(r.teams)
                const fl = fullLeagueMatchCount(r.teams)
                const gk = groupKnockoutMatchCount(calcGroupDistribution(r.teams, groupSize), 2)
                const st = STATUS(r)
                const locked = r.matches > 0 || r.grouped
                return (
                  <tr key={r.id} onClick={() => onSelect?.(r.id)}
                    className={`${onSelect ? 'cursor-pointer hover:bg-stone-50' : ''} ${selected === r.id ? 'bg-tennis-50' : ''}`}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}</td>
                    <td className="px-2 py-2 text-center font-bold">{r.teams}</td>
                    <td className="px-2 py-2 text-center">{r.people}</td>
                    {kind === 'individual' && <td className="px-2 py-2 text-center text-stone-500">{r.checked}</td>}
                    <td className="px-2 py-2 text-center" onClick={e => e.stopPropagation()}>
                      <select value={r.format} disabled={locked || saving === r.id}
                        onChange={e => changeFormat(r, e.target.value as DivisionFormat)}
                        title={locked ? '조편성·경기가 있으면 바꿀 수 없습니다' : ''}
                        className="border rounded px-2 py-1 text-xs disabled:bg-stone-50 disabled:text-stone-400">
                        <option value="full_league">풀리그</option>
                        <option value="group_knockout">조별+본선</option>
                      </select>
                      {r.teams >= 2 && r.format !== rec && !locked && (
                        <div className="text-[10px] text-amber-600 mt-0.5">{rec === 'full_league' ? '풀리그' : '조별'} 추천</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-stone-600 whitespace-nowrap">
                      {r.teams < 2 ? <span className="text-stone-300">–</span> : (
                        <>
                          <span className={r.format === 'full_league' ? 'font-bold text-stone-800' : ''}>
                            {fl}경기 · 팀당 {r.teams - 1}
                          </span>
                          <span className="text-stone-300 mx-1">/</span>
                          <span className={r.format === 'group_knockout' ? 'font-bold text-stone-800' : ''}>
                            예선 {gk.prelim} + 본선 {gk.finals} · 팀당 {gk.minPerTeam}~
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${st.c}`}>{st.t}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="text-[11px] text-stone-400 px-3 py-2">
            조별+본선 경기 수는 {groupSize}{kind === 'individual' ? '명' : '팀'}조 · 조당 2팀 진출 기준 예상치.
            {' '}{FULL_LEAGUE_RECOMMEND_MAX}팀 이하는 풀리그 추천. 조편성 전에만 진행방식을 바꿀 수 있습니다.
          </p>
        </div>
      )}
    </div>
  )
}
