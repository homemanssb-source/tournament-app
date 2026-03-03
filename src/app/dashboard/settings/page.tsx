'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Venue {
  id: string
  event_id: string
  name: string
  courts: string[]
  pin_plain: string
  manager_name: string
  phone: string | null
}

export default function SettingsPage() {
  const [eventId, setEventId] = useState('')
  const [eventName, setEventName] = useState('')

  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [hasMasterPin, setHasMasterPin] = useState(false)
  const [pinMsg, setPinMsg] = useState('')
  const [pinSaving, setPinSaving] = useState(false)

  const [venues, setVenues] = useState<Venue[]>([])
  const [newVenueName, setNewVenueName] = useState('')
  const [newVenuePin, setNewVenuePin] = useState('')
  const [newVenueManager, setNewVenueManager] = useState('')
  const [selectedCourts, setSelectedCourts] = useState<string[]>([])
  const [venueMsg, setVenueMsg] = useState('')
  const [venueLoading, setVenueLoading] = useState(true)

  const [totalCourts, setTotalCourts] = useState(10)
  const allCourtNames = Array.from({ length: totalCourts }, (_, i) => '코트 ' + (i + 1))

  // 이미 다른 경기장에 배정된 코트
  const usedCourts = venues.flatMap(v => Array.isArray(v.courts) ? v.courts : [])

  // 편집 모드
  const [editVenueId, setEditVenueId] = useState<string | null>(null)
  const [editCourts, setEditCourts] = useState<string[]>([])

  useEffect(() => {
    const stored = sessionStorage.getItem('dashboard_event_id')
    if (stored) {
      setEventId(stored)
      loadEvent(stored)
      loadVenues(stored)
    }
  }, [])

  async function loadEvent(eid: string) {
    const { data } = await supabase.from('events').select('name, master_pin_hash').eq('id', eid).single()
    if (data) {
      setEventName(data.name)
      setHasMasterPin(!!data.master_pin_hash)
    }
  }

  async function loadVenues(eid: string) {
    setVenueLoading(true)
    const { data } = await supabase.from('venues').select('*')
      .eq('event_id', eid).order('created_at')
    setVenues(data || [])
    setVenueLoading(false)
  }

  async function saveMasterPin() {
    if (!newPin.trim()) { setPinMsg('! PIN을 입력하세요.'); return }
    if (newPin.length < 4) { setPinMsg('! PIN은 최소 4자리 이상이어야 합니다.'); return }
    if (newPin !== confirmPin) { setPinMsg('! PIN 확인이 일치하지 않습니다.'); return }
    setPinSaving(true); setPinMsg('')
    const { error } = await supabase.rpc('rpc_set_master_pin', {
      p_event_id: eventId, p_new_pin: newPin.trim()
    })
    setPinSaving(false)
    if (error) { setPinMsg('! ' + error.message); return }
    setPinMsg('OK 마스터 PIN이 변경되었습니다.')
    setHasMasterPin(true)
    setNewPin(''); setConfirmPin('')
  }

  function toggleCourt(court: string) {
    setSelectedCourts(prev =>
      prev.includes(court) ? prev.filter(c => c !== court) : [...prev, court]
    )
  }

  function toggleEditCourt(court: string) {
    setEditCourts(prev =>
      prev.includes(court) ? prev.filter(c => c !== court) : [...prev, court]
    )
  }

  async function addVenue() {
    if (!newVenueName.trim()) { setVenueMsg('! 경기장 이름을 입력하세요.'); return }
    if (!newVenuePin.trim() || newVenuePin.length < 4) { setVenueMsg('! PIN 4자리 이상 입력하세요.'); return }
    if (selectedCourts.length === 0) { setVenueMsg('! 코트를 최소 1개 선택하세요.'); return }

    setVenueMsg('')
    const sortedCourts = [...selectedCourts].sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''))
      const nb = parseInt(b.replace(/\D/g, ''))
      return na - nb
    })

    const { error } = await supabase.from('venues').insert({
      event_id: eventId,
      name: newVenueName.trim(),
      courts: sortedCourts,
      pin_plain: newVenuePin.trim(),
      pin_hash: newVenuePin.trim(),
      manager_name: newVenueManager.trim() || newVenueName.trim() + ' 관리자',
    })
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg('OK 경기장 추가됨 (' + sortedCourts.length + '코트)')
    setNewVenueName(''); setNewVenuePin(''); setNewVenueManager(''); setSelectedCourts([])
    loadVenues(eventId)
  }

  async function saveEditCourts(venueId: string) {
    if (editCourts.length === 0) { setVenueMsg('! 코트를 최소 1개 선택하세요.'); return }
    const sortedCourts = [...editCourts].sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''))
      const nb = parseInt(b.replace(/\D/g, ''))
      return na - nb
    })
    const { error } = await supabase.from('venues').update({ courts: sortedCourts }).eq('id', venueId)
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg('OK 코트 변경됨')
    setEditVenueId(null)
    loadVenues(eventId)
  }

  async function deleteVenue(v: Venue) {
    if (!confirm(v.name + ' 삭제하시겠습니까?')) return
    const { error } = await supabase.from('venues').delete().eq('id', v.id)
    if (error) { setVenueMsg('! ' + error.message); return }
    setVenueMsg('OK 삭제됨')
    loadVenues(eventId)
  }

  function generateRandomPin() {
    return String(100000 + Math.floor(Math.random() * 900000))
  }

  if (!eventId) return <p className="text-stone-400">대시보드 홈에서 대회를 선택해주세요.</p>

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">설정</h1>
      <p className="text-sm text-stone-500">{eventName}</p>

      {/* 마스터 PIN */}
      <div className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-lg">마스터 PIN</h2>
          {hasMasterPin
            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">설정됨</span>
            : <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">미설정</span>
          }
        </div>
        <p className="text-xs text-stone-400">운영자 인증에 사용되는 PIN입니다.</p>
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
            {pinSaving ? '저장중...' : '마스터 PIN 저장'}
          </button>
        </div>
      </div>

      {/* 부설경기장 관리 */}
      <div className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-lg">부설경기장 관리</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500">총 코트:</label>
            <select value={totalCourts} onChange={e => setTotalCourts(Number(e.target.value))}
              className="border rounded px-2 py-1 text-sm">
              {[6, 8, 10, 12, 14, 16, 18, 20].map(n => <option key={n} value={n}>{n}개</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-stone-400">경기장별 PIN과 담당 코트를 설정하면 해당 경기장 관리자가 스코어를 입력할 수 있습니다.</p>

        {/* 추가 폼 */}
        <div className="space-y-3 bg-stone-50 rounded-lg p-4">
          <p className="text-sm font-medium text-stone-700">새 경기장 추가</p>
          <div className="flex gap-2">
            <input type="text" value={newVenueName} onChange={e => setNewVenueName(e.target.value)}
              placeholder="경기장 이름 (예: C경기장)"
              className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white" />
            <input type="text" value={newVenueManager} onChange={e => setNewVenueManager(e.target.value)}
              placeholder="관리자명"
              className="w-28 border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white" />
          </div>
          <div className="flex gap-2 items-center">
            <input type="text" value={newVenuePin} onChange={e => setNewVenuePin(e.target.value)}
              placeholder="PIN (6자리)"
              className="w-28 border border-stone-300 rounded-lg px-3 py-2 text-sm text-center bg-white" />
            <button onClick={() => setNewVenuePin(generateRandomPin())}
              className="text-xs bg-white text-stone-600 px-3 py-2 rounded-lg hover:bg-stone-100 border">랜덤</button>
          </div>

          {/* 코트 선택 */}
          <div>
            <p className="text-xs text-stone-600 mb-2">담당 코트 선택:</p>
            <div className="flex flex-wrap gap-1.5">
              {allCourtNames.map(court => {
                const isUsed = usedCourts.includes(court)
                const isSelected = selectedCourts.includes(court)
                return (
                  <button key={court} onClick={() => !isUsed && toggleCourt(court)}
                    disabled={isUsed}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      isUsed ? 'bg-stone-200 text-stone-400 cursor-not-allowed line-through' :
                      isSelected ? 'bg-blue-600 text-white' : 'bg-white border border-stone-300 text-stone-600 hover:border-blue-400'
                    }`}>
                    {court.replace('코트 ', '#')}
                  </button>
                )
              })}
            </div>
            {selectedCourts.length > 0 && (
              <p className="text-xs text-blue-600 mt-1">{selectedCourts.length}개 선택됨</p>
            )}
          </div>

          <button onClick={addVenue}
            disabled={!newVenueName.trim() || !newVenuePin.trim() || selectedCourts.length === 0}
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
              const venueCourts = Array.isArray(v.courts) ? v.courts : []
              const otherUsedCourts = venues.filter(ov => ov.id !== v.id).flatMap(ov => Array.isArray(ov.courts) ? ov.courts : [])

              return (
                <div key={v.id} className="rounded-lg border overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between bg-white">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-sm">{v.name}</span>
                        <span className="font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">{v.pin_plain}</span>
                        {v.manager_name && <span className="text-xs text-stone-400">{v.manager_name}</span>}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {venueCourts.map(c => (
                          <span key={c} className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">{c}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <button onClick={() => {
                        if (isEditing) { setEditVenueId(null) }
                        else { setEditVenueId(v.id); setEditCourts([...venueCourts]) }
                      }} className="text-xs text-blue-600 hover:underline">
                        {isEditing ? '취소' : '코트변경'}
                      </button>
                      <button onClick={() => deleteVenue(v)}
                        className="text-xs text-stone-400 hover:text-red-500">삭제</button>
                    </div>
                  </div>

                  {/* 코트 편집 */}
                  {isEditing && (
                    <div className="bg-blue-50 px-4 py-3 space-y-2 border-t">
                      <p className="text-xs text-blue-700 font-medium">코트 재선택:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {allCourtNames.map(court => {
                          const isOtherUsed = otherUsedCourts.includes(court)
                          const isSelected = editCourts.includes(court)
                          return (
                            <button key={court} onClick={() => !isOtherUsed && toggleEditCourt(court)}
                              disabled={isOtherUsed}
                              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                isOtherUsed ? 'bg-stone-200 text-stone-400 cursor-not-allowed line-through' :
                                isSelected ? 'bg-blue-600 text-white' : 'bg-white border border-stone-300 text-stone-600 hover:border-blue-400'
                              }`}>
                              {court.replace('코트 ', '#')}
                            </button>
                          )
                        })}
                      </div>
                      <button onClick={() => saveEditCourts(v.id)}
                        disabled={editCourts.length === 0}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
                        코트 저장 ({editCourts.length}개)
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
              const courts = Array.isArray(v.courts) ? v.courts.join(', ') : ''
              return v.name + ' (PIN: ' + v.pin_plain + ') - ' + courts
            }).join('\n')
            navigator.clipboard.writeText(text)
            setVenueMsg('OK PIN 목록이 복사되었습니다.')
          }} className="text-xs text-blue-600 hover:underline">PIN + 코트 목록 복사</button>
        )}
      </div>
    </div>
  )
}