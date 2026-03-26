'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Venue {
  id: string
  event_id: string
  name: string
  short_name: string
  court_count: number
  courts: string[]
  pin_plain: string
  manager_name: string
  phone: string | null
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

  useEffect(() => {
    const stored = sessionStorage.getItem('dashboard_event_id')
    if (stored) { setEventId(stored); loadEvent(stored); loadVenues(stored) }
  }, [])

  async function loadEvent(eid: string) {
    const { data } = await supabase.from('events').select('name, master_pin_hash, status').eq('id', eid).single()
    if (data) { setEventName(data.name); setHasMasterPin(!!data.master_pin_hash); setEventStatus(data.status || 'preparing') }
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

  async function loadVenues(eid: string) {
    setVenueLoading(true)
    const { data } = await supabase.from('venues').select('*').eq('event_id', eid).order('created_at')
    setVenues(data || [])
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
      event_id: eventId,
      name: newVenueName.trim(),
      short_name: newVenueShortName.trim(),
      courts,
      court_count: newCourtCount,
      pin_plain: newVenuePin.trim(),
      pin_hash: newVenuePin.trim(),
      manager_name: newVenueManager.trim() || newVenueName.trim() + ' 관리자',
    })
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg(`OK 경기장 추가됨 (${newVenueShortName}-1 ~ ${newVenueShortName}-${newCourtCount})`)
    setNewVenueName(''); setNewVenueShortName(''); setNewVenuePin(''); setNewVenueManager(''); setNewCourtCount(8)
    loadVenues(eventId)
  }

  async function saveEditVenue(venueId: string) {
    if (!editShortName.trim()) { setVenueMsg('! 약칭을 입력하세요.'); return }
    if (editCourtCount < 1) { setVenueMsg('! 코트 수는 1개 이상이어야 합니다.'); return }
    const courts = makeCourtNames(editShortName, editCourtCount)
    const { error } = await supabase.from('venues').update({
      short_name: editShortName.trim(), courts, court_count: editCourtCount,
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

        {/* 추가 폼 */}
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

          {/* 코트 수 + 미리보기 */}
          <div className="flex items-center gap-3">
            <label className="text-xs text-stone-600 whitespace-nowrap">코트 수:</label>
            <input type="number" min={1} max={30} value={newCourtCount}
              onChange={e => setNewCourtCount(Math.max(1, Math.min(30, Number(e.target.value))))}
              className="w-20 border border-stone-300 rounded-lg px-3 py-2 text-sm text-center bg-white" />
            {newVenueShortName.trim()
              ? <span className="text-xs text-blue-600">→ {newVenueShortName}-1 ~ {newVenueShortName}-{newCourtCount}</span>
              : <span className="text-xs text-stone-400">약칭 입력 시 미리보기</span>
            }
          </div>

          <button onClick={addVenue}
            disabled={!newVenueName.trim() || !newVenueShortName.trim() || !newVenuePin.trim() || newCourtCount < 1}
            className="w-full bg-green-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
            + 경기장 추가
          </button>
        </div>

        {venueMsg && <p className={`text-sm ${venueMsg.startsWith('OK') ? 'text-green-600' : 'text-red-500'}`}>{venueMsg}</p>}

        {/* 경기장 목록 */}
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
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {makeCourtNames(shortName, courtCount).map(c => (
                          <span key={c} className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">{c}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <button onClick={() => {
                        if (isEditing) { setEditVenueId(null) }
                        else { setEditVenueId(v.id); setEditCourtCount(courtCount); setEditShortName(shortName) }
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
                        {editShortName.trim() && (
                          <span className="text-xs text-blue-600 pb-1">→ {editShortName}-1 ~ {editShortName}-{editCourtCount}</span>
                        )}
                      </div>
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
              const count = v.court_count || 0
              const sn = v.short_name || v.name
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
