'use client'
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useEventId, useDivisions } from '@/components/useDashboard'
import type { TieWithClubs } from '@/types/team'

interface MatchSlim {
  id: string; match_num: string; stage: string; round: string
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  court: string | null; court_order: number | null
  status: string; score: string | null; winner_team_id: string | null
  division_name: string; division_id: string; locked_by_participant: boolean
  group_label: string | null; is_team_tie?: boolean
}
interface Venue {
  id: string; name: string; short_name: string
  court_count: number; courts: string[]; pin_plain: string
}
type CourtZones = Record<string, { group: string[]; finals: string[] }>
type StageKey = 'GROUP' | 'R32' | 'R16' | 'QF' | 'SF' | 'F' | 'ALL_FINALS' | '본선32강' | '본선16강' | '본선64강' | '16강' | '8강' | '4강' | '결승'

const STAGE_TABS: { key: StageKey; label: string }[] = [
  { key: 'GROUP',     label: '예선' },
  { key: '본선32강',  label: '32강' },
  { key: '본선16강',  label: '본선16강' },
  { key: '16강',      label: '16강' },
  { key: '8강',       label: '8강' },
  { key: '4강',       label: '4강' },
  { key: '결승',      label: '결승' },
  { key: 'ALL_FINALS', label: '전체본선' },
]
const ROUND_TO_STAGE: Record<string, string> = { R32:'FINALS', R16:'FINALS', QF:'FINALS', SF:'FINALS', F:'FINALS', '본선32강':'FINALS', '본선16강':'FINALS', '본선64강':'FINALS', '16강':'FINALS', '8강':'FINALS', '4강':'FINALS', '결승':'FINALS' }
const ZONE_FINALS = new Set(['R16','QF','SF','F','16강','8강','4강','결승','본선32강','본선16강','본선64강'])
const STAGE_LABEL: Record<string, string> = { GROUP:'예선', R32:'32강', R16:'16강', QF:'8강', SF:'4강', F:'결승', ALL_FINALS:'전체본선', '본선32강':'32강', '본선16강':'16강', '본선64강':'64강', '16강':'16강', '8강':'8강', '4강':'4강', '결승':'결승' }

function makeCourtNames(shortName: string, count: number): string[] {
  const prefix = shortName?.trim() || '코트'
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`)
}
function sortGroupMatches(list: MatchSlim[]): MatchSlim[] {
  const rem = [...list], sorted: MatchSlim[] = []
  while (rem.length > 0) {
    const prev = sorted[sorted.length - 1]
    const idx = prev ? rem.findIndex(m =>
      m.team_a_id !== prev.team_a_id && m.team_a_id !== prev.team_b_id &&
      m.team_b_id !== prev.team_a_id && m.team_b_id !== prev.team_b_id) : 0
    sorted.push(rem.splice(idx >= 0 ? idx : 0, 1)[0])
  }
  return sorted
}

export default function CourtsPage() {
  const eventId = useEventId()
  const { divisions } = useDivisions(eventId)
  const [matches, setMatches] = useState<MatchSlim[]>([])
  const [ties, setTies]       = useState<TieWithClubs[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg]         = useState('')
  const [venues, setVenues]   = useState<Venue[]>([])
  const [selectedVenue, setSelectedVenue] = useState<string>('ALL')

  // refs for stale closure prevention
  const venuesRef  = useRef<Venue[]>([])
  const matchesRef = useRef<MatchSlim[]>([])
  const tiesRef    = useRef<TieWithClubs[]>([])

  const courtNames = React.useMemo(() => {
    if (selectedVenue === 'ALL') {
      if (venues.length === 0) return Array.from({ length: 10 }, (_, i) => `코트-${i + 1}`)
      return venues.flatMap(v => makeCourtNames(v.short_name || v.name, v.court_count || v.courts?.length || 0))
    }
    const venue = venues.find(v => v.id === selectedVenue)
    if (!venue) return []
    return makeCourtNames(venue.short_name || venue.name, venue.court_count || venue.courts?.length || 0)
  }, [selectedVenue, venues])

  const [autoDiv, setAutoDiv]       = useState('')
  const [autoStage, setAutoStage]   = useState<StageKey>('GROUP')
  const [autoCourts, setAutoCourts] = useState<string[]>([])
  const [assigning, setAssigning]   = useState(false)
  useEffect(() => { setAutoCourts([]) }, [selectedVenue])

  const [courtZones, setCourtZones] = useState<CourtZones>({})
  const [zoneTab, setZoneTab]       = useState<'group' | 'finals'>('group')
  const [zoneOpen, setZoneOpen]     = useState(false)
  const [zoneSaving, setZoneSaving] = useState(false)

  const [dragMatch, setDragMatch]     = useState<string | null>(null)
  const [touchDragId, setTouchDragId] = useState<string | null>(null)
  const [touchOver, setTouchOver]     = useState<string | null>(null)
  const courtOrderRef = useRef<Record<string, number>>({})

  const [viewFilter, setViewFilter] = useState('ALL')
  const [editMatch, setEditMatch]   = useState<MatchSlim | null>(null)
  const [editScore, setEditScore]   = useState('')
  const [editWinner, setEditWinner] = useState<'A' | 'B' | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [notifying, setNotifying]   = useState<string | null>(null)
  const [notifyMsg, setNotifyMsg]   = useState<Record<string, string>>({})

  const [startTime, setStartTime]             = useState<string>('')
  const startTimeRef                          = useRef<string>('')
  const venueStartTimesRef                    = useRef<Record<string, string>>({})
  const [venueStartTimes, setVenueStartTimes] = useState<Record<string, string>>({})
  const [divMatchDates, setDivMatchDates]     = useState<Record<string, string>>({})
  const [dateFilter, setDateFilter]           = useState<string>('ALL')

  // 코트 목록은 날짜 무관하게 전체 사용
  const filteredCourtNames = courtNames

  // ✅ 날짜 탭: 2일 대회면 첫 번째 날짜 자동 선택
  useEffect(() => {
    if (Object.keys(divMatchDates).length === 0) return
    const dates = [...new Set(Object.values(divMatchDates))].sort()
    if (dates.length > 0 && dateFilter === 'ALL') {
      setDateFilter(dates[0])
    }
  }, [divMatchDates])

  // ref sync (모든 state 선언 후)
  useEffect(() => { venuesRef.current  = venues  }, [venues])
  useEffect(() => { matchesRef.current = matches }, [matches])
  useEffect(() => { tiesRef.current    = ties    }, [ties])
  useEffect(() => { startTimeRef.current       = startTime       }, [startTime])
  useEffect(() => { venueStartTimesRef.current = venueStartTimes }, [venueStartTimes])


  function syncCourtOrderRef(matchList: MatchSlim[], tieList: TieWithClubs[]) {
    const counter: Record<string, number> = {}
    for (const m of matchList) {
      if (m.court && m.court_order) counter[m.court] = Math.max(counter[m.court] || 0, m.court_order)
    }
    for (const t of tieList) {
      const cn = (t as any).court_number; if (!cn) continue
      const venue = venuesRef.current.find(v => cn >= 1 && cn <= (v.court_count || v.courts?.length || 0))
      const court = venue ? `${venue.short_name || venue.name}-${cn}` : `코트-${cn}`
      const order = (t as any).court_order
      if (order) counter[court] = Math.max(counter[court] || 0, order)
    }
    courtOrderRef.current = counter
  }

  async function sendCourtNotify(court: string, trigger: 'manual' | 'finished' | 'court_changed', matchId?: string) {
    setNotifying(court)
    try {
      const res  = await fetch('/api/notify/court', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ event_id:eventId, court, match_id:matchId, trigger }) })
      const json = await res.json()
      const m = json.sent > 0 ? `✅ ${json.sent}명 알림 전송` : `ℹ️ ${json.message || '구독자 없음'}`
      setNotifyMsg(prev => ({ ...prev, [court]: m }))
      setTimeout(() => setNotifyMsg(prev => { const n = { ...prev }; delete n[court]; return n }), 3000)
    } catch { setNotifyMsg(prev => ({ ...prev, [court]: '❌ 전송 실패' })) }
    finally { setNotifying(null) }
  }

  async function loadVenues() {
    if (!eventId) return
    const { data } = await supabase.from('venues').select('id, name, short_name, court_count, courts, pin_plain, start_time').eq('event_id', eventId).order('created_at')
    const list = (data || []) as (Venue & { start_time?: string })[]
    setVenues(list as Venue[])
    const vtMap: Record<string, string> = {}
    list.forEach(v => { if (v.start_time) vtMap[v.id] = v.start_time.slice(0,5) })
    setVenueStartTimes(vtMap)
  }
  async function loadCourtZones() {
    if (!eventId) return
    try {
      // court_zones 컬럼이 없는 경우 400 에러 → 조용히 무시
      const { data, error } = await supabase.from('events').select('court_zones').eq('id', eventId).single()
      if (!error && data?.court_zones) setCourtZones(data.court_zones as CourtZones)
      // error 있어도 무시 (컬럼 미존재 시 court_zones 기능만 비활성화)
    } catch {}
  }

  async function loadEventSchedule() {
    if (!eventId) return
    try {
      const { data: ev } = await supabase.from('events').select('start_time').eq('id', eventId).single()
      if (ev?.start_time) setStartTime(ev.start_time.slice(0, 5))
    } catch {}
    try {
      const { data: divs } = await supabase.from('divisions').select('id, match_date').eq('event_id', eventId)
      if (divs) {
        const map: Record<string, string> = {}
        divs.forEach(d => { if (d.match_date) map[d.id] = d.match_date })
        setDivMatchDates(map)
      }
    } catch {}
  }

  function getCourtStartTime(court: string): string {
    const venue = venuesRef.current.find(v => {
      const sn = (v as any).short_name || v.name
      return court.startsWith(sn + '-') || court === sn
    })
    if (venue) {
      const vt = venueStartTimesRef.current[(venue as any).id]
      if (vt) return vt
    }
    return startTimeRef.current
  }

  // ✅ 자동시작: DB 트리거(fn_auto_start_next_match)에서 처리
  // matches.status → FINISHED 시 DB가 자동으로 다음 PENDING 경기를 IN_PROGRESS로 변경
  // 클라이언트는 폴링으로 화면만 갱신

  const loadAll = useCallback(async (showLoading = false) => {
    if (!eventId) return
    if (showLoading) setLoading(true)
    try {
      const [matchRes, tieRes] = await Promise.all([
        supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId)
          .order('court', { ascending:true, nullsFirst:false }).order('court_order', { ascending:true, nullsFirst:true }),
        supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)')
          .eq('event_id', eventId).order('court_order', { ascending:true, nullsFirst:false }),
      ])
      const matchList = (matchRes.data || []).filter((m: any) => m.score !== 'BYE') as MatchSlim[]
      const tieList   = (tieRes.data  || []) as TieWithClubs[]

      setMatches(matchList); matchesRef.current = matchList
      setTies(tieList);      tiesRef.current    = tieList
      syncCourtOrderRef(matchList, tieList)
    } catch {}
    finally { if (showLoading) setLoading(false) }
  }, [eventId])

  async function loadMatches() {
    if (!eventId) return
    const { data } = await supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId)
      .order('court', { ascending:true, nullsFirst:false }).order('court_order', { ascending:true, nullsFirst:true })
    const list = (data || []).filter((m: any) => m.score !== 'BYE') as MatchSlim[]
    setMatches(list); matchesRef.current = list
    syncCourtOrderRef(list, tiesRef.current)
  }
  async function loadTies() {
    if (!eventId) return
    const { data } = await supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)').eq('event_id', eventId).order('court_order', { ascending:true, nullsFirst:false })
    const list = (data || []) as TieWithClubs[]
    setTies(list); tiesRef.current = list
    syncCourtOrderRef(matchesRef.current, list)
  }

  useEffect(() => { if (!eventId) return; loadAll(true); loadVenues(); loadCourtZones(); loadEventSchedule() }, [eventId, loadAll])
  useEffect(() => { if (!eventId) return; const iv = setInterval(() => loadAll(false), 15000); return () => clearInterval(iv) }, [eventId, loadAll])

  async function saveCourtZones() {
    setZoneSaving(true)
    const { error } = await supabase.from('events').update({ court_zones: courtZones }).eq('id', eventId)
    setZoneSaving(false)
    if (error) { setMsg('❌ 구역 저장 실패: ' + error.message); return }
    setMsg('✅ 코트 구역 저장됨')
  }
  function toggleZoneCourt(divId: string, court: string) {
    setCourtZones(prev => {
      const existing = prev[divId] || { group:[], finals:[] }
      const cur = existing[zoneTab] || []
      const updated = cur.includes(court) ? cur.filter(c => c !== court) : [...cur, court]
      return { ...prev, [divId]: { ...existing, [zoneTab]: updated } }
    })
  }

  function getCourtPool(divId: string, round: string): string[] {
    const zoneKey    = ZONE_FINALS.has(round) ? 'finals' : 'group'
    const zoneCourts = courtZones[divId]?.[zoneKey] || []
    const pool = zoneCourts.length > 0 ? autoCourts.filter(c => zoneCourts.includes(c)) : autoCourts
    return pool.length > 0 ? pool : autoCourts
  }
  function getLeastLoaded(pool: string[]): string {
    return pool.reduce((best, c) => (courtOrderRef.current[c] || 0) < (courtOrderRef.current[best] || 0) ? c : best, pool[0])
  }

  async function autoAssignByDivision() {
    if (!autoDiv) { setMsg('부문을 선택해주세요.'); return }
    if (autoCourts.length === 0) { setMsg('배정할 코트를 선택해주세요.'); return }
    if (autoDiv === 'TEAM') {
      const divTies = ties.filter(t => !t.is_bye && !(t as any).court_number && t.status !== 'completed')
      if (divTies.length === 0) { setMsg('배정할 단체전 경기가 없습니다.'); return }
      setAssigning(true)
      try {
        for (let i = 0; i < divTies.length; i++) {
          const court = autoCourts[i % autoCourts.length]
          const courtNum = parseInt(court.split('-').pop() || '0')
          const nextOrder = (courtOrderRef.current[court] || 0) + 1; courtOrderRef.current[court] = nextOrder
          await supabase.from('ties').update({ court_number:courtNum, court_order:nextOrder }).eq('id', divTies[i].id)
        }
        setMsg(`✅ [단체전] ${divTies.length}경기 배정 완료`); loadTies()
      } finally { setAssigning(false) }
      return
    }
    setAssigning(true); setMsg('')
    try {
      if      (autoStage === 'GROUP')       await assignGroup()
      else if (autoStage === 'ALL_FINALS')  await assignAllFinals()
      else                                  await assignFinals(autoStage)
    } finally { setAssigning(false) }
  }

  async function assignGroup() {
    const targets = matches.filter(m => m.division_id === autoDiv && m.stage === 'GROUP' && !m.court && m.status !== 'FINISHED')
    if (targets.length === 0) { setMsg('배정할 예선 경기가 없습니다.'); return }
    const pool = getCourtPool(autoDiv, 'group')
    const byGroup = new Map<string, MatchSlim[]>()
    for (const m of targets) { const k = m.group_label || 'none'; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k)!.push(m) }
    const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)
    const updates: { id: string; court: string; court_order: number }[] = []
    for (const [, groupMatches] of groups) {
      const court = getLeastLoaded(pool)
      for (const m of sortGroupMatches(groupMatches)) {
        const nextOrder = (courtOrderRef.current[court] || 0) + 1; courtOrderRef.current[court] = nextOrder
        updates.push({ id:m.id, court, court_order:nextOrder })
      }
    }
    for (const u of updates) await supabase.from('matches').update({ court:u.court, court_order:u.court_order }).eq('id', u.id)
    const divName = divisions.find(d => d.id === autoDiv)?.name || ''
    const summary = pool.map(c => { const cnt = updates.filter(u => u.court === c).length; return cnt > 0 ? `${c}:${cnt}경기` : '' }).filter(Boolean).join(' | ')
    setMsg(`✅ [${divName}] 예선 ${updates.length}경기 배정 완료 — ${summary}`); loadMatches()
  }

  async function assignFinals(round: string) {
    const stageVal = ROUND_TO_STAGE[round] || 'FINALS'
    const targets  = matches.filter(m => m.division_id === autoDiv && m.stage === stageVal && m.round === round && !m.court && m.status !== 'FINISHED')
    if (targets.length === 0) { setMsg(`배정할 ${STAGE_LABEL[round] || round} 경기가 없습니다.`); return }
    const pool = getCourtPool(autoDiv, round)
    const updates: { id: string; court: string; court_order: number }[] = []
    for (const m of targets) {
      const court = getLeastLoaded(pool)
      const nextOrder = (courtOrderRef.current[court] || 0) + 1; courtOrderRef.current[court] = nextOrder
      updates.push({ id:m.id, court, court_order:nextOrder })
    }
    for (const u of updates) await supabase.from('matches').update({ court:u.court, court_order:u.court_order }).eq('id', u.id)
    const divName = divisions.find(d => d.id === autoDiv)?.name || ''
    setMsg(`✅ [${divName}] ${STAGE_LABEL[round] || round} ${updates.length}경기 배정 완료`); loadMatches()
  }

  async function assignAllFinals() {
    const divName = divisions.find(d => d.id === autoDiv)?.name || ''; let total = 0
    for (const round of ['본선32강','본선64강','16강','8강','4강','결승']) {
      const pool    = getCourtPool(autoDiv, round)
      const targets = matches.filter(m => m.division_id === autoDiv && m.stage === (ROUND_TO_STAGE[round]||'FINALS') && m.round === round && !m.court && m.status !== 'FINISHED')
      if (targets.length === 0) continue
      for (const m of targets) {
        const court = getLeastLoaded(pool)
        const nextOrder = (courtOrderRef.current[court] || 0) + 1; courtOrderRef.current[court] = nextOrder
        await supabase.from('matches').update({ court, court_order:nextOrder }).eq('id', m.id); total++
      }
    }
    if (total === 0) { setMsg(`[${divName}] 배정할 본선 경기가 없습니다.`); return }
    setMsg(`✅ [${divName}] 전체 본선 ${total}경기 미리배정 완료 (기배정 스킵)`); loadMatches()
  }

  async function assignItemToCourt(itemId: string, court: string) {
    if (itemId.startsWith('tie_')) {
      const courtNum = parseInt(court.split('-').pop() || '0')
      const nextOrder = (courtOrderRef.current[court] || 0) + 1; courtOrderRef.current[court] = nextOrder
      await supabase.from('ties').update({ court_number:courtNum, court_order:nextOrder }).eq('id', itemId.replace('tie_',''))
      sendCourtNotify(court, 'court_changed'); loadTies()
    } else {
      const nextOrder = (courtOrderRef.current[court] || 0) + 1; courtOrderRef.current[court] = nextOrder
      await supabase.from('matches').update({ court, court_order:nextOrder }).eq('id', itemId)
      sendCourtNotify(court, 'court_changed', itemId); loadMatches()
    }
  }
  async function unassignItem(itemId: string) {
    if (itemId.startsWith('tie_')) { await supabase.from('ties').update({ court_number:null, court_order:null }).eq('id', itemId.replace('tie_','')); loadTies() }
    else { await supabase.from('matches').update({ court:null, court_order:null }).eq('id', itemId); loadMatches() }
  }
  async function moveMatchOrder(matchId: string, direction: 'up' | 'down') {
    if (matchId.startsWith('tie_')) return
    const m = matches.find(mm => mm.id === matchId); if (!m || !m.court || !m.court_order) return
    const cms = matches.filter(mm => mm.court === m.court).sort((a,b) => (a.court_order||0)-(b.court_order||0))
    const idx = cms.findIndex(mm => mm.id === matchId)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= cms.length) return
    const other = cms[swapIdx]
    await supabase.from('matches').update({ court_order:other.court_order }).eq('id', m.id)
    await supabase.from('matches').update({ court_order:m.court_order   }).eq('id', other.id)
    loadMatches()
  }

  async function clearDivisionAssignments(divId: string) {
    if (divId === 'TEAM') {
      if (!confirm('[단체전] 코트 배정을 모두 초기화하시겠습니까?')) return
      for (const t of ties.filter(t => t.court_number))
        await supabase.from('ties').update({ court_number:null, court_order:null }).eq('id', t.id)
      const updated = { ...courtOrderRef.current }
      for (const t of ties) {
        const cn = (t as any).court_number; if (!cn) continue
        const venue = venuesRef.current.find(v => cn >= 1 && cn <= (v.court_count || v.courts?.length || 0))
        const court = venue ? `${venue.short_name||venue.name}-${cn}` : `코트-${cn}`
        delete updated[court]
      }
      courtOrderRef.current = updated; setMsg('✅ [단체전] 초기화 완료'); loadTies(); return
    }
    const divName = divisions.find(d => d.id === divId)?.name || ''
    if (!confirm(`[${divName}] 코트 배정을 모두 초기화하시겠습니까?`)) return
    const divMatches = matches.filter(m => m.division_id === divId && m.court)
    for (const m of divMatches) await supabase.from('matches').update({ court:null, court_order:null }).eq('id', m.id)
    const affectedCourts = new Set(divMatches.map(m => m.court!))
    const remaining = matches.filter(m => m.division_id !== divId && m.court && m.court_order)
    const newCounter: Record<string,number> = {}
    for (const m of remaining) if (m.court && m.court_order) newCounter[m.court] = Math.max(newCounter[m.court]||0, m.court_order)
    const updated = { ...courtOrderRef.current }
    for (const court of affectedCourts) updated[court] = newCounter[court] || 0
    courtOrderRef.current = updated; setMsg(`✅ [${divName}] 초기화 완료`); loadMatches()
  }
  async function clearAllAssignments() {
    if (!confirm('전체 코트 배정을 초기화하시겠습니까?')) return
    await supabase.from('matches').update({ court:null, court_order:null }).eq('event_id', eventId)
    for (const t of ties.filter(t => t.court_number))
      await supabase.from('ties').update({ court_number:null, court_order:null }).eq('id', t.id)
    courtOrderRef.current = {}; setMsg('✅ 전체 초기화'); loadMatches(); loadTies()
  }

  function openScoreEdit(m: MatchSlim) {
    if (m.is_team_tie) return
    setEditMatch(m); setEditScore(m.score || '')
    setEditWinner(m.winner_team_id === m.team_a_id ? 'A' : m.winner_team_id === m.team_b_id ? 'B' : '')
    setMsg('')
  }

  async function submitResult() {
    if (!editMatch || !editScore || !editWinner) { setMsg('점수와 승자를 모두 입력해주세요.'); return }
    setSubmitting(true); setMsg('')
    const winnerId = editWinner === 'A' ? editMatch.team_a_id : editMatch.team_b_id
    try {
      const { error: rpcError } = await supabase.rpc('rpc_submit_match_result', { p_match_id:editMatch.id, p_score:editScore, p_winner_team_id:winnerId })
      if (rpcError) {
        if (editMatch.status === 'FINISHED') {
          const { error: ue } = await supabase.from('matches').update({ score:editScore, winner_team_id:winnerId, status:'FINISHED', ended_at:new Date().toISOString() }).eq('id', editMatch.id)
          if (ue) { setMsg('❌ ' + ue.message); return }
          setMsg('✅ 결과 강제 수정됨 (운영자 모드)')
        } else { setMsg('❌ ' + rpcError.message); return }
      } else {
        setMsg('✅ 결과 저장됨')
        if (editMatch.court) sendCourtNotify(editMatch.court, 'finished')
      }
      setEditMatch(null)
      await loadMatches()
    } finally { setSubmitting(false) }
  }

  async function startMatch(matchId: string) {
    if (matchId.startsWith('tie_')) return
    await supabase.from('matches').update({ status:'IN_PROGRESS' }).eq('id', matchId); loadMatches()
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  function handleDropOnCourt(court: string) { if (!dragMatch) return; assignItemToCourt(dragMatch, court); setDragMatch(null) }
  function handleDropOnUnassigned() { if (!dragMatch) return; unassignItem(dragMatch); setDragMatch(null) }
  function handleTouchStart(id: string) { setTouchDragId(id) }
  function handleTouchMove(e: React.TouchEvent) {
    e.preventDefault()
    const touch = e.touches[0]
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    const courtEl      = el?.closest('[data-court]') as HTMLElement | null
    const unassignedEl = el?.closest('[data-unassigned]') as HTMLElement | null
    if (courtEl) setTouchOver('court:' + courtEl.dataset.court)
    else if (unassignedEl) setTouchOver('unassigned')
    else setTouchOver(null)
  }
  function handleTouchEnd() {
    if (!touchDragId || !touchOver) { setTouchDragId(null); setTouchOver(null); return }
    if (touchOver === 'unassigned') unassignItem(touchDragId)
    else if (touchOver.startsWith('court:')) assignItemToCourt(touchDragId, touchOver.slice(6))
    setTouchDragId(null); setTouchOver(null)
  }

  function tiesToMatchSlim(tieList: TieWithClubs[]): MatchSlim[] {
    return tieList.filter(t => !t.is_bye).map(t => {
      const cn = (t as any).court_number
      let courtName: string | null = null
      if (cn != null) {
        const venue = venuesRef.current.find(v => cn >= 1 && cn <= (v.court_count || v.courts?.length || 0))
        courtName = venue ? `${venue.short_name||venue.name}-${cn}` : `코트-${cn}`
      }
      const statusMap: Record<string,string> = { pending:'PENDING', lineup_phase:'PENDING', lineup_ready:'PENDING', in_progress:'IN_PROGRESS', completed:'FINISHED' }
      return {
        id:`tie_${t.id}`, match_num:`T#${t.tie_order}`, stage:'TEAM', round:t.round||'group',
        team_a_name:t.club_a?.name||'TBD', team_b_name:t.club_b?.name||'TBD',
        team_a_id:t.club_a_id||'', team_b_id:t.club_b_id||'',
        court:courtName, court_order:cn ? ((t as any).court_order ?? (100+(t.tie_order||0))) : null,
        status:statusMap[t.status]||'PENDING',
        score:(t.status==='completed'||t.status==='in_progress') ? `${t.club_a_rubbers_won}-${t.club_b_rubbers_won}` : null,
        winner_team_id:t.winning_club_id||null,
        division_name:'단체전', division_id:t.division_id||'TEAM',
        locked_by_participant:false, group_label:null, is_team_tie:true,
      }
    })
  }

  const tieMatches  = tiesToMatchSlim(ties)
  const allItems    = [...matches, ...tieMatches]

  const divColors: Record<string,string> = { TEAM:'#2563eb' }
  const colors = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#ef4444']
  divisions.forEach((d, i) => { divColors[d.id] = colors[i % colors.length] })

  const hasTeamTies       = ties.filter(t => !t.is_bye).length > 0
  const selectedVenueInfo = venues.find(v => v.id === selectedVenue)

  if (!eventId) return <p className="text-stone-400">설정에서 대회를 선택해주세요.</p>
  if (loading)  return <p className="text-stone-400">불러오는 중..</p>

  const uniqueDates = [...new Set(Object.values(divMatchDates))].sort()
  const dateDivIds = dateFilter === 'ALL'
    ? null
    : Object.entries(divMatchDates).filter(([, d]) => d === dateFilter).map(([id]) => id)

  // ✅ 날짜 필터에 맞는 부서만 표시 (날짜 선택 시 해당 날짜 부서만)
  const filteredDivisions = dateDivIds
    ? divisions.filter(d => dateDivIds.includes(d.id))
    : divisions
  const dateFilteredItems = dateDivIds
    ? allItems.filter(m => dateDivIds.includes(m.division_id) || m.is_team_tie)
    : allItems

  // ✅ byCourt: dateFilteredItems 기반
  // 날짜별 court_order가 독립적이므로 다른 날짜 경기 섞이면 순서 계산 오류
  const byCourt = new Map<string, MatchSlim[]>()
  for (const name of filteredCourtNames) byCourt.set(name, [])
  for (const m of dateFilteredItems) { if (m.court && byCourt.has(m.court)) byCourt.get(m.court)!.push(m) }

  const filteredAll = viewFilter==='ALL' ? dateFilteredItems : viewFilter==='TEAM' ? dateFilteredItems.filter(m=>m.is_team_tie) : dateFilteredItems.filter(m=>m.division_id===viewFilter)
  const unassigned  = filteredAll.filter(m => !m.court && m.status !== 'FINISHED')

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-bold">🎾 코트 배정</h1>
        <div className="flex items-center gap-3">
          {startTime && (
            <span className="text-xs text-stone-500">⏰ {startTime} 자동시작</span>
          )}
        </div>
      </div>

      {msg && <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>{msg}</div>}

      {uniqueDates.length > 0 && (
        <div className="bg-white rounded-xl border p-3 mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-stone-500 font-medium whitespace-nowrap">📅 날짜:</span>
            {uniqueDates.map(date => {
              const label = new Date(date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })
              const divsOnDate = Object.entries(divMatchDates).filter(([, d]) => d === date).map(([id]) => divisions.find(div => div.id === id)?.name).filter(Boolean)
              return (
                <button key={date} onClick={() => { setDateFilter(date); setAutoDiv(''); setViewFilter('ALL') }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${dateFilter === date ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-600 border-stone-300 hover:border-blue-400'}`}>
                  {label} <span className="opacity-70">({divsOnDate.join('·')})</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {venues.length > 0 && (
        <div className="bg-white rounded-xl border p-3 mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-stone-500 font-medium whitespace-nowrap">📍 경기장:</span>
            <button onClick={() => setSelectedVenue('ALL')} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${selectedVenue==='ALL' ? 'bg-[#2d5016] text-white border-[#2d5016]' : 'bg-white text-stone-600 border-stone-300 hover:border-stone-400'}`}>🏟 전체 보기</button>
            {venues.map(v => {
              const count = v.court_count || v.courts?.length || 0; const sn = v.short_name || v.name
              return <button key={v.id} onClick={() => setSelectedVenue(v.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${selectedVenue===v.id ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-stone-600 border-stone-300 hover:border-orange-400'}`}>{v.name} <span className="opacity-70">({sn}-1~{sn}-{count})</span></button>
            })}
          </div>
          {selectedVenueInfo && <p className="text-xs text-stone-400 mt-2">{selectedVenueInfo.short_name}-1 ~ {selectedVenueInfo.short_name}-{selectedVenueInfo.court_count || selectedVenueInfo.courts?.length || 0} · PIN: {selectedVenueInfo.pin_plain}</p>}
        </div>
      )}

      <div className="bg-white rounded-xl border p-4 mb-4 space-y-4">
        <h3 className="font-bold text-sm">🎯 자동 코트 배정</h3>
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="text-xs text-stone-500 block mb-1">부문</label>
            <select value={autoDiv} onChange={e => setAutoDiv(e.target.value)} className="border rounded-lg px-3 py-2 text-sm min-w-[140px]">
              <option value="">부문 선택</option>
              {filteredDivisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              {hasTeamTies && <option value="TEAM">🏆 단체전</option>}
            </select>
          </div>
          {autoDiv && autoDiv !== 'TEAM' && (
            <div>
              <label className="text-xs text-stone-500 block mb-1">스테이지</label>
              <div className="flex flex-wrap gap-1">
                {STAGE_TABS.map(tab => (
                  <button key={tab.key} onClick={() => setAutoStage(tab.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${autoStage===tab.key ? (tab.key==='ALL_FINALS'?'bg-purple-600 text-white border-purple-600':'bg-tennis-600 text-white border-tennis-600') : 'border-stone-300 hover:border-tennis-400'}`}>
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-stone-500">배정 코트</label>
            <button onClick={() => setAutoCourts(autoCourts.length===filteredCourtNames.length ? [] : [...filteredCourtNames])} className="text-xs px-2 py-0.5 rounded border border-dashed border-stone-400 text-stone-500 hover:border-tennis-500 hover:text-tennis-600 transition-all">
              {autoCourts.length===filteredCourtNames.length ? '전체 해제' : '전체 선택'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {filteredCourtNames.map(c => (
              <button key={c} onClick={() => setAutoCourts(prev => prev.includes(c) ? prev.filter(x=>x!==c) : [...prev,c])}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${autoCourts.includes(c) ? 'bg-tennis-600 text-white border-tennis-600' : 'bg-white text-stone-600 border-stone-300 hover:border-tennis-400'}`}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={autoAssignByDivision} disabled={!autoDiv || autoCourts.length===0 || assigning}
            className="bg-tennis-600 text-white px-5 py-2 rounded-lg text-sm font-bold hover:bg-tennis-700 disabled:opacity-50 flex items-center gap-2">
            {assigning ? <><span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />배정 중...</> : `🎯 ${autoDiv && autoDiv!=='TEAM' ? STAGE_LABEL[autoStage] : ''} 자동 배정`}
          </button>
          {autoDiv && autoDiv !== 'TEAM' && (
            <p className="text-xs text-stone-400">
              {autoStage==='GROUP' && '같은 그룹 → 같은 코트 | 부하균등 | 연속방지'}
              {autoStage==='ALL_FINALS' && '결승까지 전체 미리배정 (기배정 스킵)'}
              {ZONE_FINALS.has(autoStage) && `${STAGE_LABEL[autoStage]} 배정 — 본선 구역 적용`}
              {autoStage==='본선32강' && '32강 배정 — 전체 코트 균등'}
            </p>
          )}
        </div>

        <div className="border-t pt-3">
          <button onClick={() => setZoneOpen(!zoneOpen)} className="flex items-center gap-2 text-xs font-medium text-stone-600 hover:text-stone-800 transition-all">
            <span>{zoneOpen ? '▾' : '▸'}</span><span>부서별 코트 구역 설정</span><span className="text-stone-400 font-normal">(예선용 / 본선 16강~)</span>
          </button>
          {zoneOpen && (
            <div className="mt-3 space-y-3">
              <div className="flex gap-1">
                {(['group','finals'] as const).map(t => (
                  <button key={t} onClick={() => setZoneTab(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${zoneTab===t ? 'bg-stone-700 text-white border-stone-700' : 'border-stone-300 text-stone-500 hover:border-stone-500'}`}>
                    {t==='group' ? '예선용 구역' : '본선용 구역 (16강~)'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-stone-400">{zoneTab==='group' ? '예선 자동배정 시 해당 부서가 사용할 코트를 지정하세요.' : '16강 이상 본선 자동배정 시 해당 부서 코트를 지정하세요.'}</p>
              {filteredDivisions.map(div => {
                const selected = courtZones[div.id]?.[zoneTab] || []
                return (
                  <div key={div.id} className="flex items-start gap-3">
                    <div className="flex items-center gap-1.5 w-24 flex-shrink-0 pt-1">
                      <span style={{ width:8, height:8, borderRadius:'50%', background:divColors[div.id], display:'inline-block', flexShrink:0 }} />
                      <span className="text-xs font-medium text-stone-700 truncate">{div.name}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {filteredCourtNames.map(c => {
                        const inZone = selected.includes(c)
                        return (
                          <button key={c} onClick={() => toggleZoneCourt(div.id, c)}
                            style={{ borderColor:inZone?divColors[div.id]:undefined, background:inZone?divColors[div.id]+'20':undefined }}
                            className={`px-2 py-1 rounded text-xs font-medium border transition-all ${inZone?'text-stone-700':'border-stone-200 text-stone-400 hover:border-stone-400'}`}>{c}</button>
                        )
                      })}
                      {selected.length > 0 && <span className="text-xs text-stone-400 self-center ml-1">{selected.length}개 선택</span>}
                    </div>
                  </div>
                )
              })}
              <button onClick={saveCourtZones} disabled={zoneSaving} className="bg-stone-700 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-stone-800 disabled:opacity-50">{zoneSaving ? '저장 중...' : '💾 구역 설정 저장'}</button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border p-3 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
            <button onClick={() => setViewFilter('ALL')} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter==='ALL'?'bg-white shadow-sm':''}`}>전체</button>
            {filteredDivisions.map(d => <button key={d.id} onClick={() => setViewFilter(d.id)} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter===d.id?'bg-white shadow-sm':''}`}>{d.name}</button>)}
            {hasTeamTies && <button onClick={() => setViewFilter('TEAM')} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter==='TEAM'?'bg-white shadow-sm':''}`}>단체전</button>}
          </div>
          <div className="ml-auto flex gap-2">
            {autoDiv && <button onClick={() => clearDivisionAssignments(autoDiv)} className="text-xs text-stone-400 hover:text-red-500 border border-stone-200 px-2 py-1 rounded-lg">{autoDiv==='TEAM'?'단체전':divisions.find(d=>d.id===autoDiv)?.name} 초기화</button>}
            <button onClick={clearAllAssignments} className="text-xs text-stone-400 hover:text-red-500 border border-stone-200 px-2 py-1 rounded-lg">전체 초기화</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-1" data-unassigned onDragOver={handleDragOver} onDrop={handleDropOnUnassigned}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="bg-stone-500 text-white px-4 py-2 font-bold text-sm">미배정 ({unassigned.length})</div>
            <div className="p-1.5 space-y-1 max-h-[70vh] overflow-y-auto">
              {unassigned.map(m => <MatchChip key={m.id} m={m} divColor={divColors[m.division_id]} onDragStart={setDragMatch} onClickScore={() => openScoreEdit(m)} onClickUnassign={() => unassignItem(m.id)} onTouchStart={() => handleTouchStart(m.id)} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} />)}
              {unassigned.length === 0 && <div className="text-xs text-stone-300 text-center py-6">없음</div>}
            </div>
          </div>
        </div>
        <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {filteredCourtNames.map(court => {
            const courtItems = (byCourt.get(court)||[]).sort((a,b)=>(a.court_order||0)-(b.court_order||0))
            const finished   = courtItems.filter(m=>m.status==='FINISHED').length
            const activeIdx  = courtItems.findIndex(m=>m.status==='IN_PROGRESS')
            const pendingIdx = courtItems.findIndex(m=>m.status==='PENDING')
            const currentIdx = activeIdx>=0?activeIdx:pendingIdx
            const isLive     = activeIdx>=0
            const hasPending = courtItems.some(m=>m.status==='PENDING')
            const zoneDiv = autoDiv && autoDiv!=='TEAM' ? (() => {
              const z = courtZones[autoDiv]; if (!z) return null
              if (z.finals?.includes(court)) return { label:'본선구역', color:divColors[autoDiv] }
              if (z.group?.includes(court))  return { label:'예선구역', color:divColors[autoDiv]+'99' }
              return null
            })() : null
            return (
              <div key={court} data-court={court} onDragOver={handleDragOver} onDrop={() => handleDropOnCourt(court)}
                className={`bg-white rounded-xl border overflow-hidden min-h-[100px] transition-all ${touchOver==='court:'+court?'ring-2 ring-tennis-400 bg-tennis-50':''}`}>
                <div className={`px-3 py-2 font-bold text-sm flex items-center justify-between ${isLive?'bg-red-700':'bg-[#2d5016]'} text-white`}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{court}</span>
                    {isLive && <span className="text-xs bg-white/20 px-1.5 py-0.5 rounded-full animate-pulse flex-shrink-0">LIVE</span>}
                    {zoneDiv && <span style={{ background:zoneDiv.color }} className="text-[9px] px-1.5 py-0.5 rounded-full text-white/90 flex-shrink-0">{zoneDiv.label}</span>}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-white/60 text-xs">{finished}/{courtItems.length}</span>
                    <button onClick={() => sendCourtNotify(court,'manual')} disabled={notifying===court||!hasPending} className="text-white/80 hover:text-white disabled:opacity-30 text-base leading-none">{notifying===court?'⏳':'🔔'}</button>
                  </div>
                </div>
                {notifyMsg[court] && <div className="px-3 py-1 text-xs bg-amber-50 text-amber-800 border-b">{notifyMsg[court]}</div>}
                <div className="p-1.5 space-y-1 max-h-[60vh] overflow-y-auto">
                  {/* ✅ PENDING/IN_PROGRESS 경기만 표시 — FINISHED는 하단 접기로 */}
                  {courtItems.filter(m=>m.status!=='FINISHED').map((m,i) => {
                    const allIdx = courtItems.indexOf(m)
                    let badge = ''
                    if (m.status==='IN_PROGRESS') badge='🔴'
                    else {
                      if (currentIdx>=0&&allIdx===currentIdx) badge='🔴'
                      else if (currentIdx>=0&&allIdx===currentIdx+1) badge='🟡'
                      else if (currentIdx>=0&&allIdx===currentIdx+2) badge='🟢'
                    }
                    const firstPendingIdx = courtItems.findIndex(mm => mm.status === 'PENDING')
                    const canStart = !m.is_team_tie && m.status === 'PENDING' && allIdx === firstPendingIdx
                    return <MatchChip key={m.id} m={m} order={m.court_order||allIdx+1} badge={badge} divColor={divColors[m.division_id]} onDragStart={setDragMatch} onClickScore={() => openScoreEdit(m)} onClickStart={canStart?()=>startMatch(m.id):undefined} onClickUnassign={() => unassignItem(m.id)} onMoveUp={!m.is_team_tie&&allIdx>0?()=>moveMatchOrder(m.id,'up'):undefined} onMoveDown={!m.is_team_tie&&allIdx<courtItems.length-1?()=>moveMatchOrder(m.id,'down'):undefined} onTouchStart={()=>handleTouchStart(m.id)} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} />
                  })}
                  {/* ✅ 완료 경기는 접기로 표시 */}
                  {finished > 0 && (
                    <FinishedCourtItems items={courtItems.filter(m=>m.status==='FINISHED')} onClickScore={openScoreEdit} onClickUnassign={unassignItem} divColors={divColors} />
                  )}
                  {courtItems.length===0&&<div className="text-xs text-stone-300 text-center py-6 border-2 border-dashed rounded-lg">드래그 또는 자동배정</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editMatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditMatch(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            {editMatch.status==='FINISHED' && (
              <div className="mb-4 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
                <span className="text-lg">⚠️</span>
                <div><p className="text-xs font-semibold text-amber-800">완료된 경기 수정 (운영자 모드)</p><p className="text-xs text-amber-600 mt-0.5">기존 결과: {editMatch.score||'-'}</p></div>
              </div>
            )}
            <h3 className="font-bold text-lg mb-1">경기 결과 입력/수정</h3>
            <p className="text-xs text-stone-400 mb-4">{editMatch.match_num} · {editMatch.division_name} · {editMatch.round}{editMatch.court&&<span className="ml-1 font-medium text-[#2d5016]">({editMatch.court} #{editMatch.court_order})</span>}</p>
            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1 font-medium">{editMatch.team_a_name||'TBD'}</div>
              <span className="text-xl text-stone-300">VS</span>
              <div className="text-center flex-1 font-medium">{editMatch.team_b_name||'TBD'}</div>
            </div>
            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">점수</label>
              <input type="text" placeholder="6:4" value={editScore} onChange={e=>setEditScore(e.target.value)} className="w-full border rounded-xl px-4 py-3 text-center text-lg font-bold" autoFocus />
            </div>
            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">승자</label>
              <div className="flex gap-2">
                <button onClick={()=>setEditWinner('A')} className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${editWinner==='A'?'bg-tennis-600 text-white border-tennis-600':'border-stone-200 hover:border-tennis-400'}`}>{editMatch.team_a_name||'A'}</button>
                <button onClick={()=>setEditWinner('B')} className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${editWinner==='B'?'bg-tennis-600 text-white border-tennis-600':'border-stone-200 hover:border-tennis-400'}`}>{editMatch.team_b_name||'B'}</button>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={()=>setEditMatch(null)} className="flex-1 py-2.5 rounded-xl border border-stone-300 text-sm text-stone-600">취소</button>
              <button onClick={submitResult} disabled={submitting||!editScore||!editWinner} className={`flex-1 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 text-white ${editMatch.status==='FINISHED'?'bg-amber-500 hover:bg-amber-600':'bg-tennis-600 hover:bg-tennis-700'}`}>{submitting?'저장 중..':editMatch.status==='FINISHED'?'강제 수정':'결과 저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 완료된 코트 경기 접기 컴포넌트
function FinishedCourtItems({ items, onClickScore, onClickUnassign, divColors }: {
  items: MatchSlim[]
  onClickScore: (m: MatchSlim) => void
  onClickUnassign: (id: string) => void
  divColors: Record<string, string>
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="border-t border-stone-100 mt-1 pt-1">
      <button onClick={() => setOpen(!open)}
        className="text-xs text-stone-400 hover:text-stone-600 w-full text-left px-1 py-0.5 flex items-center gap-1">
        <span>{open ? '▼' : '▶'}</span>
        <span>완료 {items.length}경기</span>
      </button>
      {open && (
        <div className="space-y-1 mt-1">
          {items.map((m, i) => (
            <div key={m.id} className="rounded-lg border border-stone-100 bg-stone-50 p-2 opacity-60">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[10px] text-stone-400 font-mono">#{m.court_order}</span>
                  <span className="text-xs text-stone-500 truncate">{m.team_a_name} vs {m.team_b_name}</span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {m.score && <span className="text-xs font-bold text-stone-500">{m.score}</span>}
                  <button onClick={() => onClickScore(m)} className="text-[10px] text-stone-300 hover:text-blue-500">✏</button>
                  <button onClick={() => onClickUnassign(m.id)} className="text-[10px] text-stone-300 hover:text-red-500">✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


function MatchChip({ m, order, badge, divColor, onDragStart, onClickScore, onClickStart, onClickUnassign, onMoveUp, onMoveDown, onTouchStart, onTouchMove, onTouchEnd }: {
  m: MatchSlim; order?: number; badge?: string; divColor?: string
  onDragStart: (id: string) => void; onClickScore: () => void
  onClickStart?: () => void; onClickUnassign?: () => void
  onMoveUp?: () => void; onMoveDown?: () => void
  onTouchStart?: () => void; onTouchMove?: (e: React.TouchEvent) => void; onTouchEnd?: () => void
}) {
  const done = m.status==='FINISHED'; const live = m.status==='IN_PROGRESS'; const isTeam = m.is_team_tie
  return (
    <div draggable onDragStart={() => onDragStart(m.id)} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      className={`rounded-lg border p-2 text-xs cursor-grab active:cursor-grabbing transition-all ${isTeam?(live?'bg-blue-50 border-blue-300':done?'bg-blue-50 border-blue-200':'bg-white border-blue-200 hover:border-blue-400'):live?'bg-red-50 border-red-200':done?'bg-tennis-50 border-tennis-200':'bg-white border-stone-200 hover:border-stone-300'}`}>
      <div className="flex items-center gap-1 mb-1">
        {order&&<span className="text-stone-400 font-bold">#{order}</span>}
        {badge&&<span className="text-[10px]">{badge}</span>}
        {isTeam?<span className="text-[10px] bg-blue-600 text-white px-1 rounded">단체</span>:<span style={{ display:'inline-block',width:6,height:6,borderRadius:'50%',background:divColor||'#999' }} />}
        <span className="text-stone-400 truncate flex-1">{isTeam?m.match_num:`${m.division_name} · ${m.round}${m.group_label?` · ${m.group_label}`:''}`}</span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onMoveUp   &&<button onClick={e=>{e.stopPropagation();onMoveUp()}}   className="text-stone-300 hover:text-stone-600 px-0.5">▲</button>}
          {onMoveDown &&<button onClick={e=>{e.stopPropagation();onMoveDown()}} className="text-stone-300 hover:text-stone-600 px-0.5">▼</button>}
          {onClickStart&&<button onClick={e=>{e.stopPropagation();onClickStart()}} className="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded hover:bg-red-600">▶</button>}
          {!isTeam&&<button onClick={e=>{e.stopPropagation();onClickScore()}} className={`px-1 py-0.5 rounded text-[10px] ${done?'text-amber-500 hover:text-amber-700':'text-stone-300 hover:text-blue-500'}`}>{done?'재수정':'수정'}</button>}
          {onClickUnassign&&<button onClick={e=>{e.stopPropagation();onClickUnassign()}} className="text-stone-300 hover:text-red-400">✕</button>}
        </div>
      </div>
      <div className={`font-medium truncate ${done?'text-stone-400 line-through':''}`}>{m.team_a_name} <span className="text-stone-300">vs</span> {m.team_b_name}</div>
      {m.score&&<div className={`mt-0.5 font-bold ${isTeam?'text-blue-600':done?'text-stone-400':'text-tennis-600'}`}>{m.score}</div>}
    </div>
  )
}