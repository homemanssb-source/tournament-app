'use client'
import React from 'react'
import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard'

interface Team {
  id: string; team_num: string; team_name: string; player1_name: string; player2_name: string
  pin_plain: string; division_id: string; division_name: string; event_id: string
  p1_grade: string | null; p2_grade: string | null; club_name: string | null
  p1_club: string | null; p2_club: string | null
  group_id: string | null
}

interface GroupOption {
  id: string; label: string; num: number
}

// ── 팀 상세 편집 모달 ─────────────────────────────────────
interface EditModalProps {
  team: Team
  groups: GroupOption[]
  eventId: string
  divisionName: string
  onClose: () => void
  onSaved: () => void
}

function EditModal({ team, groups, eventId, divisionName, onClose, onSaved }: EditModalProps) {
  const [p1Name, setP1Name] = useState(team.player1_name)
  const [p2Name, setP2Name] = useState(team.player2_name)
  const [p1Club, setP1Club] = useState(team.p1_club || '')
  const [p2Club, setP2Club] = useState(team.p2_club || '')
  const [groupId, setGroupId] = useState(team.group_id || '')
  const [pinPlain, setPinPlain] = useState(team.pin_plain || '') // ← PIN 수정 추가
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // 팀명 미리보기
  function buildTeamName(p1: string, c1: string, p2: string, c2: string) {
    const a = c1.trim() ? `${p1.trim()}(${c1.trim()})` : p1.trim()
    const b = p2.trim() ? (c2.trim() ? `${p2.trim()}(${c2.trim()})` : p2.trim()) : ''
    return b ? `${a}/${b}` : a
  }

  async function handleSave() {
    if (!p1Name.trim() || !p2Name.trim()) { setMsg('❌ 이름을 모두 입력하세요.'); return }
    if (pinPlain.trim().length !== 6) { setMsg('❌ PIN은 6자리여야 합니다.'); return } // ← PIN 유효성
    setSaving(true); setMsg('')
    try {
      // 1. teams 테이블 업데이트
      const teamName = buildTeamName(p1Name, p1Club, p2Name, p2Club)
      const teamKey = `${divisionName}|${p1Name.trim()}|${p2Name.trim()}`
      const updatePayload: Record<string, unknown> = {
        player1_name: p1Name.trim(),
        player2_name: p2Name.trim(),
        p1_club: p1Club.trim() || null,
        p2_club: p2Club.trim() || null,
        team_name: teamName,
        team_key: teamKey,
      }
      // PIN이 변경된 경우만 포함
      if (pinPlain.trim() !== team.pin_plain) {
        updatePayload.pin_plain = pinPlain.trim()
        updatePayload.pin_hash = pinPlain.trim()
      }
      const { error: teamErr } = await supabase.from('teams').update(updatePayload).eq('id', team.id)
      if (teamErr) { setMsg('❌ ' + teamErr.message); return }

      // 2. 조 변경 처리
      const newGroupId = groupId || null
      if (newGroupId !== team.group_id) {
        // 기존 조에서 제거
        if (team.group_id) {
          const { error: delErr } = await supabase
            .from('group_members')
            .delete()
            .eq('team_id', team.id)
            .eq('group_id', team.group_id)
          if (delErr) { setMsg('❌ 기존 조 제거 실패: ' + delErr.message); return }

          // 기존 조의 조별 경기에서 이 팀이 포함된 미완료 경기 team 제거 (NULL 처리)
          // ※ score가 이미 있는 경기는 건드리지 않음
          // [수정] matchErr 선언 후 미체크 버그 수정 → 에러 시 경고 표시 후 계속 진행
          const { error: matchErrB } = await supabase
            .from('matches')
            .update({ team_b_id: null })
            .eq('group_id', team.group_id)
            .eq('team_b_id', team.id)
            .is('score', null)
          if (matchErrB) console.warn('matches team_b_id NULL 처리 실패:', matchErrB.message)

          const { error: matchErrA } = await supabase
            .from('matches')
            .update({ team_a_id: null })
            .eq('group_id', team.group_id)
            .eq('team_a_id', team.id)
            .is('score', null)
          if (matchErrA) console.warn('matches team_a_id NULL 처리 실패:', matchErrA.message)
        }

        // 새 조에 추가
        if (newGroupId) {
          // 현재 조 멤버 수 (seed 계산)
          const { data: members } = await supabase
            .from('group_members')
            .select('id')
            .eq('group_id', newGroupId)
          const nextSeed = (members?.length || 0) + 1

          const { error: insErr } = await supabase
            .from('group_members')
            .insert({ group_id: newGroupId, team_id: team.id, event_id: eventId, seed: nextSeed })
          if (insErr) { setMsg('❌ 새 조 배정 실패: ' + insErr.message); return }
        }

        // teams.group_id 동기화
        await supabase.from('teams').update({ group_id: newGroupId }).eq('id', team.id)
      }

      setMsg('✅ 저장됨')
      setTimeout(() => { onSaved(); onClose() }, 500)
    } finally {
      setSaving(false)
    }
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  const currentGroup = groups.find(g => g.id === team.group_id)
  const newGroup = groups.find(g => g.id === groupId)
  const groupChanged = (groupId || null) !== team.group_id
  const pinChanged = pinPlain.trim() !== team.pin_plain

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={handleBackdrop}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-stone-800">✏️ 팀 수정</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-2xl leading-none">×</button>
        </div>

        <div className="text-xs text-stone-400 font-mono">{team.team_num} · {divisionName}</div>

        {msg && (
          <div className={`text-sm px-3 py-2 rounded-lg ${msg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
            {msg}
          </div>
        )}

        {/* 선수 1 */}
        <div className="space-y-1">
          <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">선수 1</label>
          <div className="flex gap-2">
            <input
              type="text" value={p1Name} onChange={e => setP1Name(e.target.value)}
              placeholder="이름" autoFocus
              className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2d5016]/30"
            />
            <input
              type="text" value={p1Club} onChange={e => setP1Club(e.target.value)}
              placeholder="소속클럽"
              className="w-28 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2d5016]/30"
            />
          </div>
        </div>

        {/* 선수 2 */}
        <div className="space-y-1">
          <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">선수 2</label>
          <div className="flex gap-2">
            <input
              type="text" value={p2Name} onChange={e => setP2Name(e.target.value)}
              placeholder="이름"
              className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2d5016]/30"
            />
            <input
              type="text" value={p2Club} onChange={e => setP2Club(e.target.value)}
              placeholder="소속클럽"
              className="w-28 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2d5016]/30"
            />
          </div>
        </div>

        {/* PIN 수정 ← 추가 */}
        <div className="space-y-1">
          <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">PIN</label>
          <input
            type="tel" value={pinPlain} maxLength={6}
            onChange={e => setPinPlain(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6자리 숫자"
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-[#2d5016]/30"
          />
          {pinChanged && pinPlain.length === 6 && (
            <p className="text-xs text-orange-600 bg-orange-50 rounded-lg px-3 py-1.5">
              ⚠️ PIN 변경: {team.pin_plain} → {pinPlain}
            </p>
          )}
        </div>

        {/* 조 배정 */}
        {groups.length > 0 && (
          <div className="space-y-1">
            <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">조 배정</label>
            <select
              value={groupId}
              onChange={e => setGroupId(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2d5016]/30"
            >
              <option value="">— 조 없음 —</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.label}조</option>
              ))}
            </select>
            {groupChanged && (
              <p className="text-xs text-orange-600 bg-orange-50 rounded-lg px-3 py-2">
                ⚠️ {currentGroup ? `${currentGroup.label}조 → ` : '미배정 → '}{newGroup ? `${newGroup.label}조` : '미배정'}
                {' '}— 점수 없는 조별 경기에서 자동 제거됩니다.
              </p>
            )}
          </div>
        )}

        {/* 팀명 미리보기 */}
        <div className="bg-stone-50 rounded-lg px-3 py-2 text-sm text-stone-600">
          <span className="text-stone-400 text-xs mr-1">팀명 미리보기:</span>
          <span className="font-medium">{buildTeamName(p1Name, p1Club, p2Name, p2Club) || '—'}</span>
        </div>

        {/* 버튼 */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            className="flex-1 border border-stone-300 rounded-lg py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
          >취소</button>
          <button
            onClick={handleSave} disabled={saving}
            className="flex-1 bg-[#2d5016] text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-[#3a6b1e] disabled:opacity-50 transition-colors"
          >{saving ? '저장 중...' : '저장'}</button>
        </div>
      </div>
    </div>
  )
}

// ── 메인 페이지 ───────────────────────────────────────────
export default function TeamsPage() {
  const eventId = useEventId()
  const { divisions, selected, setSelected, loading: divLoading } = useDivisions(eventId)
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')

  const [divDates, setDivDates] = useState<Record<string, string>>({})

  const [p1Name, setP1Name] = useState('')
  const [p2Name, setP2Name] = useState('')
  const [addLoading, setAddLoading] = useState(false)

  // 인라인 편집 (기존 호환)
  const [editId, setEditId] = useState<string | null>(null)
  const [editP1, setEditP1] = useState('')
  const [editP2, setEditP2] = useState('')

  // 상세 편집 모달
  const [editModalTeam, setEditModalTeam] = useState<Team | null>(null)
  const [groups, setGroups] = useState<GroupOption[]>([])

  const [searchQuery, setSearchQuery] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  const selectedDiv = divisions.find(d => d.id === selected)

  const filteredTeams = searchQuery.trim()
    ? teams.filter(t => {
        const q = searchQuery.trim().toLowerCase()
        return (
          t.player1_name.toLowerCase().includes(q) ||
          t.player2_name.toLowerCase().includes(q) ||
          t.team_name.toLowerCase().includes(q) ||
          (t.club_name || '').toLowerCase().includes(q) ||
          (t.p1_club || '').toLowerCase().includes(q) ||
          (t.p2_club || '').toLowerCase().includes(q)
        )
      })
    : teams

  useEffect(() => {
    if (eventId) loadDivDates(eventId)
  }, [eventId])

  useEffect(() => {
    if (eventId && selected) { loadTeams(); loadGroups() }
  }, [eventId, selected])

  useEffect(() => { setSearchQuery('') }, [selected])

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
    // [수정] 에러 시 빈 목록으로 조용히 실패하지 않고 메시지 표시
    const { data, error } = await supabase.from('teams').select('*')
      .eq('event_id', eventId).eq('division_id', selected)
      .order('team_num')
    if (error) { setMsg('❌ 팀 목록 로드 실패: ' + error.message) }
    setTeams(data || [])
    setLoading(false)
  }

  async function loadGroups() {
    if (!eventId || !selected) return
    const { data } = await supabase
      .from('groups')
      .select('id, label, num')
      .eq('event_id', eventId)
      .eq('division_id', selected)
      .order('num')
    setGroups((data || []).map((g: any) => ({ id: g.id, label: g.label, num: g.num })))
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

  // [수정] clipboard API 실패 시 조용히 넘어가지 않고 fallback 처리
  async function copyPinList() {
    const text = teams.map(t => `${t.team_num}. ${t.team_name} — PIN: ${t.pin_plain}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setMsg('📋 PIN 목록이 클립보드에 복사되었습니다.')
    } catch {
      setMsg('❌ 클립보드 복사 실패 (HTTPS 환경이 아니거나 권한 없음)')
    }
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div>
      {/* 상세 편집 모달 */}
      {editModalTeam && (
        <EditModal
          team={editModalTeam}
          groups={groups}
          eventId={eventId}
          divisionName={selectedDiv?.name || ''}
          onClose={() => setEditModalTeam(null)}
          onSaved={() => { loadTeams(); loadGroups() }}
        />
      )}

      <h1 className="text-2xl font-bold mb-4">👥 팀 관리</h1>

      {/* 부서 탭 — 날짜 뱃지 포함 */}
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

      {/* 선택된 부서 날짜 표시 */}
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
          <div className="flex justify-between items-center mb-2 gap-2">
            {/* 검색 */}
            <div className="relative flex-1 max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">🔍</span>
              <input
                type="text"
                placeholder="선수 이름 검색..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full border border-stone-300 rounded-lg pl-8 pr-8 py-1.5 text-sm focus:outline-none focus:border-tennis-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-300 hover:text-stone-500 text-lg leading-none"
                >×</button>
              )}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-sm text-stone-500">
                {searchQuery.trim() ? `${filteredTeams.length} / ${teams.length}팀` : `총 ${teams.length}팀`}
              </span>
              <button onClick={copyPinList} className="text-xs text-tennis-600 hover:underline">📋 PIN 목록 복사</button>
            </div>
          </div>

          {filteredTeams.length === 0 ? (
            <div className="bg-white rounded-xl border py-10 text-center text-stone-400">
              <p className="text-2xl mb-2">🔍</p>
              <p className="text-sm">"{searchQuery}"에 해당하는 선수가 없습니다.</p>
              <button onClick={() => setSearchQuery('')} className="mt-2 text-xs text-tennis-600 hover:underline">
                검색 초기화
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-stone-500">
                  <tr>
                    <th className="text-left px-4 py-2 w-20">#</th>
                    <th className="text-left px-4 py-2">선수1</th>
                    <th className="text-left px-4 py-2">선수2</th>
                    <th className="text-left px-4 py-2 w-12">조</th>
                    <th className="text-left px-4 py-2 w-28">PIN</th>
                    <th className="text-right px-4 py-2 w-24">작업</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {filteredTeams.map(t => {
                    const groupLabel = groups.find(g => g.id === t.group_id)?.label
                    return (
                      <tr key={t.id} className="hover:bg-stone-50">
                        <td className="px-4 py-2 text-stone-400 text-xs">{t.team_num}</td>
                        <td className="px-4 py-2">
                          {editId === t.id ? (
                            <input type="text" value={editP1} onChange={e => setEditP1(e.target.value)}
                              className="border rounded px-2 py-1 text-sm w-full" autoFocus />
                          ) : (
                            <div>
                              <span className="font-medium">
                                {searchQuery.trim()
                                  ? highlightMatch(t.player1_name, searchQuery)
                                  : t.player1_name}
                                {t.p1_grade && <span className="text-xs text-blue-500 ml-1">{t.p1_grade}</span>}
                              </span>
                              {t.p1_club && <div className="text-xs text-stone-400">{t.p1_club}</div>}
                            </div>
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
                            <div>
                              <span className="font-medium">
                                {searchQuery.trim()
                                  ? highlightMatch(t.player2_name, searchQuery)
                                  : t.player2_name}
                                {t.p2_grade && <span className="text-xs text-blue-500 ml-1">{t.p2_grade}</span>}
                              </span>
                              {t.p2_club && <div className="text-xs text-stone-400">{t.p2_club}</div>}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {groupLabel
                            ? <span className="inline-block bg-[#2d5016]/10 text-[#2d5016] text-xs font-bold px-2 py-0.5 rounded-full">{groupLabel}</span>
                            : <span className="text-stone-300 text-xs">-</span>
                          }
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-stone-500">{t.pin_plain}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => { setEditModalTeam(t); setEditId(null) }}
                            className="text-xs text-stone-400 hover:text-[#2d5016] mr-2 transition-colors"
                            title="상세 편집 (이름·클럽·PIN·조)"
                          >✏️</button>
                          <button onClick={() => deleteTeam(t.id, t.team_name)}
                            className="text-xs text-stone-400 hover:text-red-500">🗑️</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// 검색어 하이라이트
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text
  const idx = text.toLowerCase().indexOf(query.trim().toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-stone-800 rounded-sm px-0.5">{text.slice(idx, idx + query.trim().length)}</mark>
      {text.slice(idx + query.trim().length)}
    </>
  )
}
