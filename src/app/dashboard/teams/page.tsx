'use client'
import React from 'react'
import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard'

interface Team {
  id: string; team_num: string; team_name: string; player1_name: string; player2_name: string
  pin_plain: string; division_id: string; division_name: string; event_id: string
  p1_grade: string | null; p2_grade: string | null; club_name: string | null
}

export default function TeamsPage() {
  const eventId = useEventId()
  const { divisions, selected, setSelected, loading: divLoading } = useDivisions(eventId)
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')

  // ✅ 부서별 날짜
  const [divDates, setDivDates] = useState<Record<string, string>>({})

  const [p1Name, setP1Name] = useState('')
  const [p2Name, setP2Name] = useState('')
  const [addLoading, setAddLoading] = useState(false)

  const [editId, setEditId] = useState<string | null>(null)
  const [editP1, setEditP1] = useState('')
  const [editP2, setEditP2] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  const selectedDiv = divisions.find(d => d.id === selected)

  useEffect(() => {
    if (eventId) loadDivDates(eventId)
  }, [eventId])

  useEffect(() => { if (eventId && selected) loadTeams() }, [eventId, selected])

  // ✅ 부서별 날짜 로드
  async function loadDivDates(eid: string) {
    try {
      const { data } = await supabase.from('divisions').select('id, match_date').eq('event_id', eid)
      if (data) {
        const map: Record<string, string> = {}
        data.forEach((d: any) => { if (d.match_date) map[d.id] = d.match_date })
        setDivDates(map)
      }
    } catch {}
  }

  async function loadTeams() {
    setLoading(true)
    const { data } = await supabase.from('teams').select('*')
      .eq('event_id', eventId).eq('division_id', selected)
      .order('team_num')
    setTeams(data || [])
    setLoading(false)
  }

  function generatePin() {
    return String(100000 + Math.floor(Math.random() * 900000))
  }

  function makeTeamKey(divName: string, p1: string, p2: string) {
    return `${divName}|${p1}|${p2}`
  }

  async function addTeam() {
    if (!p1Name.trim() || !p2Name.trim()) { setMsg('선수1, 선수2 이름을 모두 입력하세요.'); return }
    setAddLoading(true); setMsg('')
    const divName = selectedDiv?.name || ''
    const teamName = `${p1Name.trim()}/${p2Name.trim()}`
    const pin = generatePin()
    const teamNum = `T-${String(teams.length + 1).padStart(4, '0')}`
    const { error } = await supabase.from('teams').insert({
      event_id: eventId, division_id: selected, division_name: divName,
      team_name: teamName, team_key: makeTeamKey(divName, p1Name.trim(), p2Name.trim()),
      team_num: teamNum, player1_name: p1Name.trim(), player2_name: p2Name.trim(), pin_plain: pin,
    })
    setAddLoading(false)
    if (error) { setMsg('❌ ' + error.message); return }
    setP1Name(''); setP2Name('')
    setMsg('✅ 팀 추가됨')
    loadTeams()
  }

  async function saveEdit(id: string) {
    if (!editP1.trim() || !editP2.trim()) return
    const divName = selectedDiv?.name || ''
    const teamName = `${editP1.trim()}/${editP2.trim()}`
    const { error } = await supabase.from('teams').update({
      team_name: teamName, player1_name: editP1.trim(), player2_name: editP2.trim(),
      team_key: makeTeamKey(divName, editP1.trim(), editP2.trim()),
    }).eq('id', id)
    if (error) { setMsg('❌ ' + error.message); return }
    setEditId(null); setMsg('✅ 수정됨'); loadTeams()
  }

  async function deleteTeam(id: string, name: string) {
    if (!confirm(`"${name}" 팀을 삭제하시겠습니까?`)) return
    const { error } = await supabase.from('teams').delete().eq('id', id)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg('✅ 삭제됨'); loadTeams()
  }

  async function handleCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setMsg('')
    const text = await file.text()
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) { setMsg('❌ CSV에 데이터가 없습니다.'); return }

    const header = lines[0].toLowerCase()
    const hasHeader = header.includes('부서') || header.includes('선수') || header.includes('name') || header.includes('division')
    const dataLines = hasHeader ? lines.slice(1) : lines

    const cols = lines[0].split(',').map(c => c.trim().toLowerCase())
    const divCol = cols.findIndex(c => c.includes('부서') || c.includes('division'))
    const p1Col  = cols.findIndex(c => c.includes('선수1') || c.includes('player1') || c.includes('이름'))
    const p2Col  = cols.findIndex(c => c.includes('선수2') || c.includes('player2'))

    let skipped = 0
    const rows: any[] = []

    for (const line of dataLines) {
      const parts = line.split(',').map(s => s.trim())
      if (parts.length < 2) continue

      let divId = selected, divName = selectedDiv?.name || ''
      let player1 = '', player2 = ''

      if (divCol >= 0 && p1Col >= 0 && p2Col >= 0) {
        const csvDiv = parts[divCol]
        const matchDiv = divisions.find(d => d.name === csvDiv)
        if (matchDiv) { divId = matchDiv.id; divName = matchDiv.name }
        else { divName = csvDiv }
        player1 = parts[p1Col]; player2 = parts[p2Col]
      } else if (parts.length >= 3 && !hasHeader) {
        const matchDiv = divisions.find(d => d.name === parts[0])
        if (matchDiv) { divId = matchDiv.id; divName = matchDiv.name }
        player1 = parts[1]; player2 = parts[2]
      } else if (parts.length >= 2) {
        player1 = parts[0]; player2 = parts[1]
      }

      if (!player1 || !player2) { skipped++; continue }

      const pin = generatePin()
      const teamNum = `T-${String(teams.length + rows.length + 1).padStart(4, '0')}`
      rows.push({
        event_id: eventId, division_id: divId, division_name: divName,
        team_name: `${player1}/${player2}`, team_key: makeTeamKey(divName, player1, player2),
        team_num: teamNum, player1_name: player1, player2_name: player2, pin_plain: pin,
      })
    }

    if (rows.length === 0) { setMsg('❌ 유효한 팀 데이터가 없습니다.'); return }
    const { error } = await supabase.from('teams').insert(rows)
    if (error) { setMsg('❌ ' + error.message); return }
    setMsg(`✅ ${rows.length}팀 일괄 추가됨${skipped > 0 ? ` (${skipped}건 스킵)` : ''}`)
    loadTeams()
    if (fileRef.current) fileRef.current.value = ''
  }

  function copyPinList() {
    const text = teams.map(t => `${t.team_num}. ${t.team_name} — PIN: ${t.pin_plain}`).join('\n')
    navigator.clipboard.writeText(text)
    setMsg('📋 PIN 목록이 클립보드에 복사되었습니다.')
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">👥 팀 관리</h1>

      {/* ✅ 부서 탭 — 날짜 뱃지 포함 */}
      <div className="flex flex-wrap gap-2 mb-4">
        {divisions.map(d => {
          const date = divDates[d.id]
          const isActive = selected === d.id
          return (
            <button key={d.id} onClick={() => setSelected(d.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium border transition-all ${
                isActive ? 'bg-[#2d5016] text-white border-[#2d5016]' : 'bg-white text-stone-600 border-stone-300 hover:border-[#2d5016]/50'
              }`}>
              {d.name}
              {date && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-700'}`}>
                  {new Date(date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ✅ 선택된 부서 날짜 표시 */}
      {selected && divDates[selected] && (
        <div className="mb-4 flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5">
          <span>📅</span>
          <span className="font-medium">{selectedDiv?.name}</span>
          <span>경기일:</span>
          <span className="font-bold">
            {new Date(divDates[selected]).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </span>
        </div>
      )}

      {msg && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') || msg.startsWith('📋') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* 추가 영역 */}
      <div className="bg-white rounded-xl border p-4 mb-4">
        <h3 className="text-sm font-bold mb-2">수동 추가</h3>
        <div className="flex gap-2 mb-3">
          <input type="text" placeholder="선수1 이름" value={p1Name}
            onChange={e => setP1Name(e.target.value)}
            className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm" />
          <input type="text" placeholder="선수2 이름" value={p2Name}
            onChange={e => setP2Name(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTeam()}
            className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm" />
          <button onClick={addTeam} disabled={addLoading || !p1Name.trim() || !p2Name.trim()}
            className="bg-tennis-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-tennis-700 disabled:opacity-50 whitespace-nowrap">
            + 추가
          </button>
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-xs text-stone-500">CSV 일괄등록:</label>
          <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleCSV}
            className="text-xs text-stone-500 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-stone-100 file:text-stone-700" />
        </div>
        <p className="text-xs text-stone-400 mt-1">CSV 형식: 부서,선수1,선수2 또는 선수1,선수2 (현재 부서에 추가)</p>
      </div>

      {/* 팀 목록 */}
      {loading ? (
        <p className="text-stone-400 py-6 text-center">불러오는 중...</p>
      ) : teams.length === 0 ? (
        <p className="text-stone-400 py-6 text-center">등록된 팀이 없습니다.</p>
      ) : (
        <>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-stone-500">총 {teams.length}팀</span>
            <button onClick={copyPinList} className="text-xs text-tennis-600 hover:underline">📋 PIN 목록 복사</button>
          </div>
          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-stone-500">
                <tr>
                  <th className="text-left px-4 py-2 w-20">#</th>
                  <th className="text-left px-4 py-2">선수1</th>
                  <th className="text-left px-4 py-2">선수2</th>
                  <th className="text-left px-4 py-2 w-20">클럽</th>
                  <th className="text-left px-4 py-2 w-28">PIN</th>
                  <th className="text-right px-4 py-2 w-24">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {teams.map(t => (
                  <tr key={t.id} className="hover:bg-stone-50">
                    <td className="px-4 py-2 text-stone-400 text-xs">{t.team_num}</td>
                    <td className="px-4 py-2">
                      {editId === t.id ? (
                        <input type="text" value={editP1} onChange={e => setEditP1(e.target.value)}
                          className="border rounded px-2 py-1 text-sm w-full" autoFocus />
                      ) : (
                        <span className="font-medium">{t.player1_name}{t.p1_grade && <span className="text-xs text-blue-500 ml-1">{t.p1_grade}</span>}</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {editId === t.id ? (
                        <div className="flex gap-1">
                          <input type="text" value={editP2} onChange={e => setEditP2(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && saveEdit(t.id)}
                            className="border rounded px-2 py-1 text-sm flex-1" />
                          <button onClick={() => saveEdit(t.id)} className="text-tennis-600 text-xs">저장</button>
                          <button onClick={() => setEditId(null)} className="text-stone-400 text-xs">취소</button>
                        </div>
                      ) : (
                        <span className="font-medium">{t.player2_name}{t.p2_grade && <span className="text-xs text-blue-500 ml-1">{t.p2_grade}</span>}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-stone-500">{t.club_name || '-'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-500">{t.pin_plain}</td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => { setEditId(t.id); setEditP1(t.player1_name); setEditP2(t.player2_name) }}
                        className="text-xs text-stone-400 hover:text-stone-600 mr-2">✏️</button>
                      <button onClick={() => deleteTeam(t.id, t.team_name)}
                        className="text-xs text-stone-400 hover:text-red-500">🗑️</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
