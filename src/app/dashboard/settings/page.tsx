'use client'
import React from 'react'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Venue {
  id: string; event_id: string; name: string; short_name: string
  court_count: number; courts: string[]; pin_plain: string
  manager_name: string; phone: string | null; division_ids: string[] | null
  start_time: string | null
}
interface Division {
  id: string; name: string; match_date: string | null
}

function makeCourtNames(shortName: string, count: number): string[] {
  const prefix = shortName.trim() || '코트'
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`)
}

export default function SettingsPage() {
  const [eventId, setEventId] = useState('')
  const [eventName, setEventName] = useState('')
  const [eventStatus, setEventStatus] = useState<string>('')
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')

  // ✅ 대회 시작시간
  const [startTime, setStartTime] = useState<string>('')
  const [startTimeSaving, setStartTimeSaving] = useState(false)
  const [startTimeMsg, setStartTimeMsg] = useState('')

  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [hasMasterPin, setHasMasterPin] = useState(false)
  const [pinMsg, setPinMsg] = useState('')
  const [pinSaving, setPinSaving] = useState(false)

  const [venues, setVenues] = useState<Venue[]>([])
  const [newVenueName, setNewVenueName] = useState('')
  const [newVenueShortName, setNewVenueShortName] = useState('')
  const [newVenuePin, setNewVenuePin] = useState('')
  const [newVenueManager, setNewVenueManager] = useState('')
  const [newCourtCount, setNewCourtCount] = useState(8)
  const [venueMsg, setVenueMsg] = useState('')
  const [venueLoading, setVenueLoading] = useState(true)

  const [editVenueId, setEditVenueId] = useState<string | null>(null)
  const [editCourtCount, setEditCourtCount] = useState(8)
  const [editShortName, setEditShortName] = useState('')

  const [divisions, setDivisions] = useState<Division[]>([])
  const [newDivisionIds, setNewDivisionIds] = useState<string[]>([])
  const [editDivisionIds, setEditDivisionIds] = useState<string[]>([])

  // ✅ 경기장별 시작시간
  const [venueStartTimes, setVenueStartTimes]     = useState<Record<string, string>>({})
  const [venueStartTimeSaving, setVenueStartTimeSaving] = useState<string | null>(null)
  const [venueTimeMsg, setVenueTimeMsg]           = useState('')
  // ✅ 부서별 날짜
  const [divDateMsg, setDivDateMsg]     = useState('')
  const [divDateSaving, setDivDateSaving] = useState<string | null>(null)

  useEffect(() => {
    const stored = sessionStorage.getItem('dashboard_event_id')
    if (stored) { setEventId(stored); loadEvent(stored); loadVenues(stored); loadDivisions(stored) }
  }, [])

  async function loadDivisions(eid: string) {
    const { data } = await supabase.from('divisions').select('id, name, match_date').eq('event_id', eid).order('sort_order')
    setDivisions(data || [])
  }

  async function loadEvent(eid: string) {
    const { data } = await supabase.from('events').select('name, master_pin_hash, status, start_time').eq('id', eid).single()
    if (data) {
      setEventName(data.name)
      setHasMasterPin(!!data.master_pin_hash)
      setEventStatus(data.status || 'preparing')
      setStartTime(data.start_time || '')
    }
  }

  async function toggleEventStatus() {
    setStatusLoading(true); setStatusMsg('')
    const newStatus = eventStatus === 'active' ? 'preparing' : 'active'
    const { error } = await supabase.from('events').update({ status: newStatus }).eq('id', eventId)
    setStatusLoading(false)
    if (error) { setStatusMsg('❌ ' + error.message); return }
    setEventStatus(newStatus)
    setStatusMsg(newStatus === 'active' ? '✅ 대회가 공개되었습니다.' : '✅ 대회가 비공개로 변경되었습니다.')
  }

  // ✅ 대회 시작시간 저장
  async function saveStartTime() {
    setStartTimeSaving(true); setStartTimeMsg('')
    const { error } = await supabase.from('events').update({ start_time: startTime || null }).eq('id', eventId)
    setStartTimeSaving(false)
    if (error) {
      if (error.message.includes('column')) {
        setStartTimeMsg('⚠️ start_time 컬럼 없음. SQL 실행 필요:\nALTER TABLE events ADD COLUMN IF NOT EXISTS start_time time;')
      } else {
        setStartTimeMsg('❌ ' + error.message)
      }
      return
    }
    setStartTimeMsg('✅ 시작시간이 저장되었습니다.')
  }

  // ✅ 경기장별 시작시간 저장
  async function saveVenueStartTime(venueId: string, time: string) {
    setVenueStartTimeSaving(venueId); setVenueTimeMsg('')
    const { error } = await supabase.from('venues').update({ start_time: time || null }).eq('id', venueId)
    setVenueStartTimeSaving(null)
    if (error) {
      setVenueTimeMsg(error.message.includes('column')
        ? '⚠️ SQL 필요: ALTER TABLE venues ADD COLUMN IF NOT EXISTS start_time time;'
        : '❌ ' + error.message)
      return
    }
    setVenueStartTimes(prev => ({ ...prev, [venueId]: time }))
    setVenueTimeMsg('✅ 저장됨'); setTimeout(() => setVenueTimeMsg(''), 2000)
  }

  // ✅ 부서별 날짜 저장
  async function saveDivDate(divId: string, date: string) {
    setDivDateSaving(divId); setDivDateMsg('')
    const { error } = await supabase.from('divisions').update({ match_date: date || null }).eq('id', divId)
    setDivDateSaving(null)
    if (error) {
      if (error.message.includes('column')) {
        setDivDateMsg('⚠️ match_date 컬럼 없음. SQL 실행 필요:\nALTER TABLE divisions ADD COLUMN IF NOT EXISTS match_date date;')
      } else {
        setDivDateMsg('❌ ' + error.message)
      }
      return
    }
    setDivDateMsg('✅ 저장됨')
    setDivisions(prev => prev.map(d => d.id === divId ? { ...d, match_date: date || null } : d))
    setTimeout(() => setDivDateMsg(''), 2000)
  }

  async function loadVenues(eid: string) {
    setVenueLoading(true)
    const { data } = await supabase.from('venues').select('*').eq('event_id', eid).order('created_at')
    setVenues(data || [])
    // ✅ 경기장별 시작시간 맵
    const vtMap: Record<string, string> = {}
    ;(data || []).forEach((v: Venue) => { if (v.start_time) vtMap[v.id] = v.start_time.slice(0, 5) })
    setVenueStartTimes(vtMap)
    setVenueLoading(false)
  }

  async function saveMasterPin() {
    if (!newPin.trim()) { setPinMsg('! PIN을 입력하세요.'); return }
    if (newPin.length < 4) { setPinMsg('! PIN은 최소 4자리 이상이어야 합니다.'); return }
    if (newPin !== confirmPin) { setPinMsg('! PIN 확인이 일치하지 않습니다.'); return }
    setPinSaving(true); setPinMsg('')
    const { error } = await supabase.rpc('rpc_set_master_pin', { p_event_id: eventId, p_new_pin: newPin.trim() })
    setPinSaving(false)
    if (error) { setPinMsg('! ' + error.message); return }
    setPinMsg('OK 마스터 PIN이 설정되었습니다.')
    setHasMasterPin(true); setNewPin(''); setConfirmPin('')
  }

  async function addVenue() {
    if (!newVenueName.trim()) { setVenueMsg('! 경기장 이름을 입력하세요.'); return }
    if (!newVenueShortName.trim()) { setVenueMsg('! 약칭을 입력하세요. (예: 제주)'); return }
    if (!newVenuePin.trim() || newVenuePin.length < 4) { setVenueMsg('! PIN 4자리 이상 입력하세요.'); return }
    if (newCourtCount < 1) { setVenueMsg('! 코트 수는 1개 이상이어야 합니다.'); return }
    const courts = makeCourtNames(newVenueShortName, newCourtCount)
    const { error } = await supabase.from('venues').insert({
      event_id: eventId, name: newVenueName.trim(), short_name: newVenueShortName.trim(),
      courts, court_count: newCourtCount, pin_plain: newVenuePin.trim(), pin_hash: newVenuePin.trim(),
      manager_name: newVenueManager.trim() || newVenueName.trim() + ' 관리자',
      division_ids: newDivisionIds.length > 0 ? newDivisionIds : null,
    })
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg(`OK 경기장 추가됨 (${newVenueShortName}-1 ~ ${newVenueShortName}-${newCourtCount})`)
    setNewVenueName(''); setNewVenueShortName(''); setNewVenuePin(''); setNewVenueManager(''); setNewCourtCount(8); setNewDivisionIds([])
    loadVenues(eventId)
  }

  async function saveEditVenue(venueId: string) {
    if (!editShortName.trim()) { setVenueMsg('! 약칭을 입력하세요.'); return }
    if (editCourtCount < 1) { setVenueMsg('! 코트 수는 1개 이상이어야 합니다.'); return }
    const courts = makeCourtNames(editShortName, editCourtCount)
    const { error } = await supabase.from('venues').update({
      short_name: editShortName.trim(), courts, court_count: editCourtCount,
      division_ids: editDivisionIds.length > 0 ? editDivisionIds : null,
    }).eq('id', venueId)
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg('OK 변경됨'); setEditVenueId(null); loadVenues(eventId)
  }

  async function deleteVenue(v: Venue) {
    if (!confirm(v.name + ' 삭제하시겠습니까?')) return
    const { error } = await supabase.from('venues').delete().eq('id', v.id)
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg('OK 삭제됨'); loadVenues(eventId)
  }

  function generateRandomPin() { return String(100000 + Math.floor(Math.random() * 900000)) }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">설정</h1>
      <p className="text-sm text-stone-500">{eventName}</p>

      {/* 대회 공개 설정 */}
      <div className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-lg">대회 공개 설정</h2>
          {eventStatus === 'active'
            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">공개중</span>
            : <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">비공개</span>}
        </div>
        <p className="text-xs text-stone-400">공개 상태일 때만 선수들이 대회 목록에서 이 대회를 볼 수 있습니다.</p>
        <div className={`rounded-xl p-4 flex items-center justify-between ${eventStatus === 'active' ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
          <div>
            <p className="font-medium text-sm">{eventStatus === 'active' ? '🔓 현재 공개 상태' : '🔒 현재 비공개 상태'}</p>
            <p className="text-xs text-stone-500 mt-0.5">{eventStatus === 'active' ? '선수들이 대회 목록에서 이 대회를 볼 수 있어요.' : '선수들에게 대회가 보이지 않아요.'}</p>
          </div>
          <button onClick={toggleEventStatus} disabled={statusLoading}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50 ${eventStatus === 'active' ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-green-500 text-white hover:bg-green-600'}`}>
            {statusLoading ? '변경 중...' : eventStatus === 'active' ? '🔒 비공개로 변경' : '🔓 대회 오픈하기'}
          </button>
        </div>
        {statusMsg && <p className={`text-sm ${statusMsg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{statusMsg}</p>}
      </div>

      {/* ✅ 대회 시작시간 + 부서별 날짜 */}
      <div className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-lg">📅 대회 일정 설정</h2>
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">2일 대회 지원</span>
        </div>
        <p className="text-xs text-stone-400">
          시작시간을 설정하면 코트 배정 페이지에서 해당 시간에 첫 경기가 자동으로 시작됩니다.<br />
          부서별 날짜를 다르게 지정하면 회원 뷰, 코트 배정 등에서 날짜 구분이 표시됩니다.
        </p>

        {/* 대회 시작시간 */}
        <div className="bg-stone-50 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-stone-700">⏰ 경기 시작 시간 (매일 공통)</p>
          <div className="flex items-center gap-3">
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white" />
            <button onClick={saveStartTime} disabled={startTimeSaving}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {startTimeSaving ? '저장 중...' : '저장'}
            </button>
            {startTime && <span className="text-xs text-blue-600">→ 매일 {startTime} 자동 경기 시작</span>}
          </div>
          {startTimeMsg && (
            <p className={`text-xs whitespace-pre-wrap ${startTimeMsg.startsWith('✅') ? 'text-green-600' : 'text-amber-600'}`}>{startTimeMsg}</p>
          )}
        </div>

        {/* 부서별 날짜 */}
        {divisions.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-stone-700">📆 부서별 경기 날짜 (2일 대회)</p>
            <p className="text-xs text-stone-400">날짜를 지정하면 해당 부서의 경기가 그 날 열립니다. 비워두면 날짜 구분 없이 표시됩니다.</p>
            {divDateMsg && (
              <p className={`text-xs ${divDateMsg.startsWith('✅') ? 'text-green-600' : 'text-amber-600'}`}>{divDateMsg}</p>
            )}
            <div className="space-y-2">
              {divisions.map(d => (
                <div key={d.id} className="flex items-center gap-3 p-3 bg-stone-50 rounded-xl">
                  <span className="text-sm font-medium text-stone-700 w-28 flex-shrink-0">{d.name}</span>
                  <input type="date" defaultValue={d.match_date || ''}
                    onBlur={e => saveDivDate(d.id, e.target.value)}
                    className="border border-stone-300 rounded-lg px-3 py-1.5 text-sm bg-white" />
                  {divDateSaving === d.id && <span className="text-xs text-stone-400">저장 중...</span>}
                  {d.match_date && divDateSaving !== d.id && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                      {new Date(d.match_date).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}
                    </span>
                  )}
                  {!d.match_date && <span className="text-xs text-stone-300">날짜 미지정</span>}
                </div>
              ))}
            </div>
            <p className="text-xs text-stone-400 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠️ SQL 필요 (최초 1회):<br />
              <code className="text-xs">ALTER TABLE events ADD COLUMN IF NOT EXISTS start_time time;</code><br />
              <code className="text-xs">ALTER TABLE divisions ADD COLUMN IF NOT EXISTS match_date date;</code>
            </p>
          </div>
        )}
      </div>

      {/* 마스터 PIN */}
      <div className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-lg">마스터 PIN</h2>
          {hasMasterPin
            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">설정됨</span>
            : <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">미설정</span>}
        </div>
        <p className="text-xs text-stone-400">대시보드 접근에 사용하는 PIN입니다.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-stone-600 mb-1">새 PIN</label>
            <div className="flex gap-2">
              <input type="text" value={newPin} onChange={e => setNewPin(e.target.value)}
                placeholder="새 PIN 입력 (4자리 이상)"
                className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm" />
              <button onClick={() => setNewPin(generateRandomPin())}
                className="text-xs bg-stone-100 text-stone-600 px-3 py-2 rounded-lg hover:bg-stone-200 whitespace-nowrap">랜덤</button>
            </div>
          </div>
          <div>
            <label className="block text-sm text-stone-600 mb-1">PIN 확인</label>
            <input type="text" value={confirmPin} onChange={e => setConfirmPin(e.target.value)}
              placeholder="PIN 다시 입력" onKeyDown={e => e.key === 'Enter' && saveMasterPin()}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          {pinMsg && <p className={`text-sm ${pinMsg.startsWith('OK') ? 'text-green-600' : 'text-red-500'}`}>{pinMsg}</p>}
          <button onClick={saveMasterPin} disabled={pinSaving || !newPin.trim()}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {pinSaving ? '저장 중...' : '마스터 PIN 저장'}
          </button>
        </div>
      </div>

      {/* 경기장(부설) 관리 */}
      <div className="bg-white rounded-xl border p-5 space-y-4">
        <h2 className="font-bold text-lg">경기장(부설) 관리</h2>
        <p className="text-xs text-stone-400">
          약칭과 코트 수를 설정하면 코트 이름이 자동 생성됩니다.
          &nbsp;예) 약칭 <strong>제주</strong> + 코트 <strong>8</strong>개 → 제주-1 ~ 제주-8
        </p>

        <div className="space-y-3 bg-stone-50 rounded-lg p-4">
          <p className="text-sm font-medium text-stone-700">새 경기장 추가</p>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-stone-500 mb-1 block">경기장 이름</label>
              <input type="text" value={newVenueName} onChange={e => setNewVenueName(e.target.value)}
                placeholder="예: 제주시민체육관"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white" />
            </div>
            <div className="w-28">
              <label className="text-xs text-stone-500 mb-1 block">약칭 <span className="text-red-400">*</span></label>
              <input type="text" value={newVenueShortName} onChange={e => setNewVenueShortName(e.target.value)}
                placeholder="예: 제주"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white" />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="w-28">
              <label className="text-xs text-stone-500 mb-1 block">관리자명</label>
              <input type="text" value={newVenueManager} onChange={e => setNewVenueManager(e.target.value)}
                placeholder="관리자명"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white" />
            </div>
            <div className="flex gap-2 items-end">
              <div>
                <label className="text-xs text-stone-500 mb-1 block">PIN (6자리)</label>
                <input type="text" value={newVenuePin} onChange={e => setNewVenuePin(e.target.value)}
                  placeholder="000000"
                  className="w-28 border border-stone-300 rounded-lg px-3 py-2 text-sm text-center bg-white" />
              </div>
              <button onClick={() => setNewVenuePin(generateRandomPin())}
                className="text-xs bg-white text-stone-600 px-3 py-2 rounded-lg hover:bg-stone-100 border mb-0.5">랜덤</button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-stone-600 whitespace-nowrap">코트 수:</label>
            <input type="number" min={1} max={30} value={newCourtCount}
              onChange={e => setNewCourtCount(Math.max(1, Math.min(30, Number(e.target.value))))}
              className="w-20 border border-stone-300 rounded-lg px-3 py-2 text-sm text-center bg-white" />
            {newVenueShortName.trim()
              ? <span className="text-xs text-blue-600">→ {newVenueShortName}-1 ~ {newVenueShortName}-{newCourtCount}</span>
              : <span className="text-xs text-stone-400">약칭 입력 시 미리보기</span>}
          </div>
          {divisions.length > 0 && (
            <div>
              <label className="text-xs text-stone-600 block mb-1">담당 부서 <span className="text-stone-400">(미선택 시 전 부서 표시)</span></label>
              <div className="flex flex-wrap gap-1.5">
                {divisions.map(d => (
                  <button key={d.id} type="button"
                    onClick={() => setNewDivisionIds(prev => prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])}
                    className={`text-xs px-3 py-1 rounded-full border transition-all ${newDivisionIds.includes(d.id) ? 'bg-green-600 text-white border-green-600' : 'bg-white text-stone-600 border-stone-300 hover:border-green-400'}`}>
                    {d.name}{d.match_date ? ` (${new Date(d.match_date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })})` : ''}
                  </button>
                ))}
              </div>
              {newDivisionIds.length > 0 && <p className="text-xs text-green-600 mt-1">✅ {newDivisionIds.map(id => divisions.find(d => d.id === id)?.name).join(', ')} 담당</p>}
            </div>
          )}
          <button onClick={addVenue}
            disabled={!newVenueName.trim() || !newVenueShortName.trim() || !newVenuePin.trim() || newCourtCount < 1}
            className="w-full bg-green-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
            + 경기장 추가
          </button>
        </div>

        {venueMsg && <p className={`text-sm ${venueMsg.startsWith('OK') ? 'text-green-600' : 'text-red-500'}`}>{venueMsg}</p>}
        {venueTimeMsg && <p className={`text-xs whitespace-pre-wrap ${venueTimeMsg.startsWith('✅') ? 'text-green-600' : 'text-amber-600'}`}>{venueTimeMsg}</p>}

        {venueLoading ? (
          <p className="text-stone-400 text-sm text-center py-4">불러오는 중...</p>
        ) : venues.length === 0 ? (
          <p className="text-stone-400 text-sm text-center py-4">등록된 경기장이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {venues.map(v => {
              const isEditing = editVenueId === v.id
              const courtCount = v.court_count || v.courts?.length || 0
              const shortName = v.short_name || v.name
              return (
                <div key={v.id} className="rounded-lg border overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between bg-white">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-bold text-sm">{v.name}</span>
                        <span className="text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded">약칭: {shortName}</span>
                        <span className="font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">{v.pin_plain}</span>
                        {v.manager_name && <span className="text-xs text-stone-400">{v.manager_name}</span>}
                        {/* ✅ 경기장별 시작시간 */}
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-stone-400">⏰</span>
                          <input type="time"
                            defaultValue={venueStartTimes[v.id] || ''}
                            onBlur={e => saveVenueStartTime(v.id, e.target.value)}
                            className="border border-stone-200 rounded px-2 py-0.5 text-xs bg-white w-24" />
                          {venueStartTimeSaving === v.id && <span className="text-xs text-stone-400">저장중...</span>}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {makeCourtNames(shortName, courtCount).map(c => (
                          <span key={c} className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">{c}</span>
                        ))}
                        {v.division_ids && v.division_ids.length > 0
                          ? v.division_ids.map(did => {
                              const div = divisions.find(d => d.id === did)
                              return (
                                <span key={did} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                                  {div?.name || did}{div?.match_date ? ` (${new Date(div.match_date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })})` : ''}
                                </span>
                              )
                            })
                          : <span className="text-xs bg-stone-100 text-stone-500 px-2 py-0.5 rounded">전 부서</span>
                        }
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <button onClick={() => {
                        if (isEditing) { setEditVenueId(null) }
                        else { setEditVenueId(v.id); setEditCourtCount(courtCount); setEditShortName(shortName); setEditDivisionIds(v.division_ids || []) }
                      }} className="text-xs text-blue-600 hover:underline">
                        {isEditing ? '취소' : '수정'}
                      </button>
                      <button onClick={() => deleteVenue(v)} className="text-xs text-stone-400 hover:text-red-500">삭제</button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="bg-blue-50 px-4 py-3 space-y-3 border-t">
                      <p className="text-xs text-blue-700 font-medium">약칭 / 코트 수 변경</p>
                      <div className="flex gap-3 items-end flex-wrap">
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">약칭</label>
                          <input type="text" value={editShortName} onChange={e => setEditShortName(e.target.value)}
                            className="w-24 border border-stone-300 rounded-lg px-2 py-1.5 text-sm bg-white" />
                        </div>
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">코트 수</label>
                          <input type="number" min={1} max={30} value={editCourtCount}
                            onChange={e => setEditCourtCount(Math.max(1, Math.min(30, Number(e.target.value))))}
                            className="w-20 border border-stone-300 rounded-lg px-2 py-1.5 text-sm text-center bg-white" />
                        </div>
                        {editShortName.trim() && <span className="text-xs text-blue-600 pb-1">→ {editShortName}-1 ~ {editShortName}-{editCourtCount}</span>}
                      </div>
                      {divisions.length > 0 && (
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">담당 부서</label>
                          <div className="flex flex-wrap gap-1.5">
                            {divisions.map(d => (
                              <button key={d.id} type="button"
                                onClick={() => setEditDivisionIds(prev => prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])}
                                className={`text-xs px-3 py-1 rounded-full border transition-all ${editDivisionIds.includes(d.id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-600 border-stone-300 hover:border-blue-400'}`}>
                                {d.name}{d.match_date ? ` (${new Date(d.match_date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })})` : ''}
                              </button>
                            ))}
                          </div>
                          {editDivisionIds.length === 0 && <p className="text-xs text-stone-400 mt-1">미선택 시 전 부서 미배정 표시</p>}
                        </div>
                      )}
                      <button onClick={() => saveEditVenue(v.id)}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-blue-700">
                        저장
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {venues.length > 0 && (
          <button onClick={() => {
            const text = venues.map(v => {
              const count = v.court_count || 0; const sn = v.short_name || v.name
              return `${v.name} (PIN: ${v.pin_plain}) - ${sn}-1 ~ ${sn}-${count}`
            }).join('\n')
            navigator.clipboard.writeText(text)
            setVenueMsg('OK PIN 목록을 복사했습니다.')
          }} className="text-xs text-blue-600 hover:underline">PIN + 코트 목록 복사</button>
        )}
      </div>
    </div>
  )
}
