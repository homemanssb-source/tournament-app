'use client'
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { withVenuePins } from '@/lib/pins'
import { authHeaders } from '@/lib/auth-headers';
import { useEventId, useDivisions } from '@/components/useDashboard'
import { fillSlotsIfGroupComplete, groupPlaceholders, fetchPendingByeIds } from '@/lib/tournament'
import { requestSlotCheck } from '@/lib/slot-check'
import { findCourtConflicts, busyElsewhere, describeConflicts, type PlayerConflict } from '@/lib/player-conflicts'
import type { TieWithClubs } from '@/types/team'

interface MatchSlim {
  id: string; match_num: string; stage: string; round: string
  team_a_name: string; team_b_name: string; team_a_id: string; team_b_id: string
  court: string | null; court_order: number | null
  status: string; score: string | null; winner_team_id: string | null
  division_name: string; division_id: string; locked_by_participant: boolean
  group_label: string | null; is_team_tie?: boolean; slot?: number | null
  ended_at?: string | null   // 경기 종료 시각 (KST로 표시)
  group_id?: string | null   // 조 (자리표시 계산용)
}

// 종료 시각을 KST HH:mm 으로 (기기 시간대와 무관)
function fmtEndTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('ko-KR', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return '' }
}
interface Venue {
  id: string; name: string; short_name: string
  court_count: number; courts: string[]; pin_plain: string
}
type CourtZones = Record<string, { group: string[]; finals: string[] }>
// 자동 배정 미리보기: 묶음(조 하나 또는 경기 하나) 단위로 코트를 정하고, 확정할 때 저장
interface PlanBundle {
  key: string; kind: 'match' | 'tie'; title: string; court: string
  note?: string                              // '홈 코트' 등
  items: { id: string; text: string }[]      // 코트 안에서 이 순서대로 붙음
}
interface AutoPlan { title: string; bundles: PlanBundle[]; note?: string }
type StageKey = 'GROUP' | 'R32' | 'R16' | 'QF' | 'SF' | 'F' | 'ALL_FINALS' | '128강' | '64강' | '32강' | '16강' | '8강' | '4강' | '결승'

const STAGE_TABS: { key: StageKey; label: string }[] = [
  { key: 'GROUP',      label: '예선' },
  { key: '128강',      label: '128강' },
  { key: '64강',       label: '64강' },
  { key: '32강',       label: '32강' },
  { key: '16강',       label: '16강' },
  { key: '8강',        label: '8강' },
  { key: '4강',        label: '4강' },
  { key: '결승',       label: '결승' },
  { key: 'ALL_FINALS', label: '전체본선' },
]
const ROUND_TO_STAGE: Record<string, string> = { R32:'FINALS', R16:'FINALS', QF:'FINALS', SF:'FINALS', F:'FINALS', '128강':'FINALS', '64강':'FINALS', '32강':'FINALS', '16강':'FINALS', '8강':'FINALS', '4강':'FINALS', '결승':'FINALS' }
// 코트 구역: 예선이 아니면 전부 '본선용' (128강·64강·32강… 어떤 라운드든)
const zoneKeyOf = (round: string): 'group' | 'finals' => (round === 'group' || round === 'GROUP' || round === '조별') ? 'group' : 'finals'
const FINALS_ROUND_ORDER = ['128강','R128','64강','R64','32강','R32','16강','R16','8강','QF','4강','SF','결승','F']
const STAGE_LABEL: Record<string, string> = { GROUP:'예선', R32:'32강', R16:'16강', QF:'8강', SF:'4강', F:'결승', ALL_FINALS:'전체본선', '128강':'128강', '64강':'64강', '32강':'32강', '16강':'16강', '8강':'8강', '4강':'4강', '결승':'결승' }
const TEAM_STAGE_TABS = [
  { key:'group',       round:'group',       label:'예선' },
  { key:'round_of_32', round:'round_of_32', label:'32강' },
  { key:'round_of_16', round:'round_of_16', label:'16강' },
  { key:'quarter',     round:'quarter',     label:'8강'  },
  { key:'semi',        round:'semi',        label:'4강'  },
  { key:'final',       round:'final',       label:'결승' },
]
const TEAM_STAGE_LABEL: Record<string,string> = { group:'예선', round_of_32:'32강', round_of_16:'16강', quarter:'8강', semi:'4강', final:'결승' }

// round 값 → 짧은 표시 라벨
function getRoundBadge(round: string, groupLabel: string | null, divisionName: string): { round: string; div: string } {
  const roundMap: Record<string, string> = {
    'GROUP': '예선', 'R32': '32강', 'R16': '16강', 'QF': '8강', 'SF': '4강', 'F': '결승',
    '128강': '128강', '64강': '64강', '32강': '32강', '16강': '16강', '8강': '8강', '4강': '4강', '결승': '결승',
    'group': '예선', 'full_league': '리그',
    'round_of_32': '32강', 'round_of_16': '16강', 'quarter': '8강', 'semi': '4강', 'final': '결승',
  }
  const roundLabel = roundMap[round] || round
  const label = groupLabel ? `${roundLabel} ${groupLabel}` : roundLabel
  // 부서명 짧게: '베테랑부' → '베테', '챌린저부' → '챌린', '루키부' → '루키'
  const divShort = divisionName.length <= 3 ? divisionName : divisionName.slice(0, 3)
  return { round: label, div: divShort }
}

// "전태홍(제주하나)/강기호(행복배틀)" → [{ name, club }]
function parsePlayers(raw: string): { name: string; club: string }[] {
  if (!raw || raw === 'TBD' || raw === 'BYE') return []
  return raw.split('/').map(p => {
    const m = p.trim().match(/^(.+?)\((.+)\)$/)
    return m ? { name: m[1].trim(), club: m[2].trim() } : { name: p.trim(), club: '' }
  })
}

function makeCourtNames(shortName: string, count: number): string[] {
  const prefix = shortName?.trim() || '코트'
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`)
}
// ✅ 저장된 코트 목록(courts[])이 있으면 그대로 사용 — 같은 경기장을 대회별로
//    코트 범위를 나눠 쓸 수 있게 (예: 대회A 1~4, 대회B 5~8). 없으면 1부터 생성(기존 동작).
function venueCourts(v: { short_name?: string; name?: string; court_count?: number; courts?: string[] | null }): string[] {
  if (v.courts && v.courts.length > 0) return v.courts
  return makeCourtNames(v.short_name || v.name || '', v.court_count || 0)
}
function sortGroupMatches(list: MatchSlim[]): MatchSlim[] {
  // ✅ slot 순으로 먼저 정렬 — 생성 순서(1v2→1v3→2v3)와, 3팀 조에서 DB 트리거가 1경기 결과 후
  //    바꿔놓은 순서(승자 경기 먼저)를 그대로 따른다. (기존엔 조회 순서가 불확정이라 임의 순서였음)
  const rem = [...list].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)), sorted: MatchSlim[] = []
  while (rem.length > 0) {
    const prev = sorted[sorted.length - 1]
    const idx = prev ? rem.findIndex(m =>
      m.team_a_id !== prev.team_a_id && m.team_a_id !== prev.team_b_id &&
      m.team_b_id !== prev.team_a_id && m.team_b_id !== prev.team_b_id) : 0
    sorted.push(rem.splice(idx >= 0 ? idx : 0, 1)[0])
  }
  return sorted
}

// ✅ [FIX-②] 전체 코트 목록(courtNames 배열)에서 글로벌 인덱스로 court_number 계산
// 베뉴A(한라-1,한라-2,한라-3) + 베뉴B(제주-1,제주-2,제주-3) →
// 글로벌: 한라-1=1, 한라-2=2, 한라-3=3, 제주-1=4, 제주-2=5, 제주-3=6
function getGlobalCourtNumber(court: string, allCourtNames: string[]): number {
  const idx = allCourtNames.indexOf(court)
  if (idx >= 0) return idx + 1
  // fallback: 마지막 '-' 뒤 숫자
  const last = court.split('-').pop() || '0'
  return /^\d+$/.test(last) ? parseInt(last, 10) : 0
}

// ✅ [FIX-②] 글로벌 court_number → courtName 역변환
function globalCourtNumToName(courtNumber: number, allCourtNames: string[], venueList: Venue[]): string {
  // allCourtNames 배열이 있으면 인덱스로 직접 역변환
  if (allCourtNames.length > 0 && courtNumber >= 1 && courtNumber <= allCourtNames.length) {
    return allCourtNames[courtNumber - 1]
  }
  // fallback: 베뉴 없거나 범위 초과
  if (venueList.length === 0) return `코트-${courtNumber}`
  const last = venueList[venueList.length - 1]
  return `${last.short_name || last.name}-${courtNumber}`
}

export default function CourtsPage() {
  const eventId = useEventId()
  const { divisions } = useDivisions(eventId)
  const [matches, setMatches]             = useState<MatchSlim[]>([])
  const [allFinalsMatches, setAllFinalsMatches] = useState<MatchSlim[]>([])
  const [ties, setTies]       = useState<TieWithClubs[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg]         = useState('')
  const [venues, setVenues]   = useState<Venue[]>([])
  const [selectedVenue, setSelectedVenue] = useState<string>('ALL')
  const [seqMap, setSeqMap] = useState<Record<string, number>>({})   // team_id → 조 내 순번

  const venuesRef  = useRef<Venue[]>([])
  const matchesRef = useRef<MatchSlim[]>([])
  const tiesRef    = useRef<TieWithClubs[]>([])

  const courtNames = React.useMemo(() => {
    if (selectedVenue === 'ALL') {
      if (venues.length === 0) return Array.from({ length: 10 }, (_, i) => `코트-${i + 1}`)
      return venues.flatMap(v => venueCourts(v))
    }
    const venue = venues.find(v => v.id === selectedVenue)
    if (!venue) return []
    return venueCourts(venue)
  }, [selectedVenue, venues])

  // ✅ [FIX-②] 전체 베뉴 기준 글로벌 코트 목록 (베뉴 선택과 무관하게 항상 전체)
  const allCourtNames = React.useMemo(() => {
    if (venuesRef.current.length === 0) return courtNames
    return venuesRef.current.flatMap(v => venueCourts(v))
  }, [venues]) // venues state 변경 시 재계산

  // ✅ 3팀 조 자리표시 + 순번 접두 — 코트판에 그릴 때만 팀명을 바꿔 보여준다 (데이터 불변)
  //    첫 경기가 끝나기 전엔 남은 두 경기를 (앞 경기 승자)/(앞 경기 패자) vs 3번 으로 표시
  const placeholders = React.useMemo(() => groupPlaceholders(matches as any), [matches])
  function decorate(m: MatchSlim): MatchSlim {
    if (m.is_team_tie || m.stage !== 'GROUP') return m
    const ph = placeholders[m.id]
    const pre = (id: string, name: string) => (seqMap[id] != null ? String(seqMap[id]) + "번 " + name : name)
    return {
      ...m,
      team_a_name: ph?.a ? ph.a : pre(m.team_a_id, m.team_a_name),
      team_b_name: ph?.b ? ph.b : pre(m.team_b_id, m.team_b_name),
    }
  }

  const [autoDiv, setAutoDiv]       = useState('')
  const [autoStage, setAutoStage]   = useState<StageKey | string>('GROUP')
  const [autoCourts, setAutoCourts] = useState<string[]>([])
  const [assigning, setAssigning]   = useState(false)
  const [plan, setPlan]             = useState<AutoPlan | null>(null)
  const [preferHome, setPreferHome] = useState(true)   // 본선: 그 부서 예선 코트 우선
  // ④ 빈 코트 자동 이어 배정 (DB 트리거 trg_z_auto_fill_idle_court, 026) — null = 아직 DB에 컬럼 없음
  const [autoFill, setAutoFill]     = useState<{ fill: boolean; steal: boolean } | null>(null)
  const [autoFillSaving, setAutoFillSaving] = useState(false)
  useEffect(() => { setAutoCourts([]) }, [selectedVenue])
  // 조건이 바뀌면 이전 미리보기는 버림 (다시 만들어야 함)
  useEffect(() => { setPlan(null) }, [autoDiv, autoStage, autoCourts, preferHome, eventId])

  const [courtZones, setCourtZones] = useState<CourtZones>({})
  const [zoneTab, setZoneTab]       = useState<'group' | 'finals'>('group')
  const [zoneOpen, setZoneOpen]     = useState(false)
  const [zoneSaving, setZoneSaving] = useState(false)

  const [dragMatch, setDragMatch]     = useState<string | null>(null)
  const [touchDragId, setTouchDragId] = useState<string | null>(null)
  const touchDragIdRef = useRef<string | null>(null)
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
  // 대회를 바꾸면 이전 대회의 필터·선택은 비움 (날짜는 새 대회 일정이 오면 다시 자동 선택됨)
  useEffect(() => { setDateFilter('ALL'); setSelectedVenue('ALL'); setAutoDiv(''); setViewFilter('ALL') }, [eventId])

  const filteredCourtNames = courtNames

  useEffect(() => {
    if (Object.keys(divMatchDates).length === 0) return
    const dates = [...new Set(Object.values(divMatchDates))].sort()
    if (dates.length > 0 && dateFilter === 'ALL') {
      // ✅ 오늘 날짜가 있으면 오늘, 없으면 가장 가까운 날짜(과거 포함)
      const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0]
      const picked = dates.includes(today)
        ? today
        : dates.reduce((best, cur) => {
            const bd = Math.abs(new Date(best).getTime() - new Date(today).getTime())
            const cd = Math.abs(new Date(cur).getTime() - new Date(today).getTime())
            return cd < bd ? cur : best
          }, dates[0])
      setDateFilter(picked)
    }
  }, [divMatchDates])

  useEffect(() => { venuesRef.current  = venues  }, [venues])
  useEffect(() => { matchesRef.current = matches }, [matches])
  useEffect(() => { tiesRef.current    = ties    }, [ties])
  useEffect(() => { startTimeRef.current       = startTime       }, [startTime])
  useEffect(() => { venueStartTimesRef.current = venueStartTimes }, [venueStartTimes])

  // ✅ [FIX-②] syncCourtOrderRef: 글로벌 court_number → courtName 역변환
  function syncCourtOrderRef(matchList: MatchSlim[], tieList: TieWithClubs[]) {
    const counter: Record<string, number> = {}
    for (const m of matchList) {
      if (m.court && m.court_order) counter[m.court] = Math.max(counter[m.court] || 0, m.court_order)
    }
    // 전체 베뉴 기준 글로벌 코트 목록
    const allCN = venuesRef.current.flatMap(v => venueCourts(v))
    for (const t of tieList) {
      const cn = (t as any).court_number; if (!cn) continue
      const court = globalCourtNumToName(cn, allCN, venuesRef.current)
      const order = (t as any).court_order
      if (order) counter[court] = Math.max(counter[court] || 0, order)
    }
    courtOrderRef.current = counter
  }

  async function sendCourtNotify(court: string, trigger: 'manual' | 'finished' | 'court_changed', matchId?: string) {
    setNotifying(court)
    try {
      const res  = await fetch('/api/notify/court', { method:'POST', headers: await authHeaders(), body: JSON.stringify({ event_id:eventId, court, match_id:matchId, trigger }) })
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
    const list = (await withVenuePins((data || []) as any[])) as (Venue & { start_time?: string })[]   // PIN 은 venue_pins (025)
    setVenues(list as Venue[])
    const vtMap: Record<string, string> = {}
    list.forEach(v => { if (v.start_time) vtMap[v.id] = v.start_time.slice(0,5) })
    setVenueStartTimes(vtMap)
  }
  async function loadCourtZones() {
    if (!eventId) return
    try {
      const { data, error } = await supabase.from('events').select('court_zones').eq('id', eventId).single()
      if (!error && data?.court_zones) setCourtZones(data.court_zones as CourtZones)
    } catch {}
  }

  async function loadAutoFill() {
    const { data, error } = await supabase.from('events').select('auto_fill_courts, auto_steal_courts').eq('id', eventId).single()
    setAutoFill(error || !data ? null : { fill: !!(data as any).auto_fill_courts, steal: !!(data as any).auto_steal_courts })
  }
  async function saveAutoFill(next: { fill: boolean; steal: boolean }) {
    setAutoFillSaving(true)
    const { error } = await supabase.from('events')
      .update({ auto_fill_courts: next.fill, auto_steal_courts: next.fill && next.steal }).eq('id', eventId)
    setAutoFillSaving(false)
    if (error) { setMsg('❌ 자동 이어 배정 설정 저장 실패: ' + error.message); return }
    setAutoFill({ fill: next.fill, steal: next.fill && next.steal })
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

  const loadAll = useCallback(async (showLoading = false) => {
    if (!eventId) return
    if (showLoading) setLoading(true)
    try {
      const [matchRes, tieRes, grpRes, byeIds] = await Promise.all([
        supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId)
          .order('court', { ascending:true, nullsFirst:false }).order('court_order', { ascending:true, nullsFirst:true }).order('id'),
        supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)')
          .eq('event_id', eventId).order('tie_order', { ascending:true, nullsFirst:false }).order('id'),
        supabase.from('groups').select('id, group_label').eq('event_id', eventId),
        fetchPendingByeIds(eventId),   // 본선 TBD 부전승 자리 — 코트 필요 없음
      ])
      const _grpMap: Record<string,string> = {}
      for (const g of grpRes.data || []) { if (g.group_label) _grpMap[g.id] = g.group_label }
      const matchList = (matchRes.data || [])
        .filter((m: any) => m.score !== 'BYE' && !byeIds.has(m.id))
        .sort((a: any, b: any) => {
          if ((a.court ?? '') !== (b.court ?? '')) return (a.court ?? '').localeCompare(b.court ?? '', undefined, { numeric: true })
          const od = (a.court_order ?? 9999) - (b.court_order ?? 9999)
          if (od !== 0) return od
          const nm = (a.match_num || '').localeCompare(b.match_num || '', undefined, { numeric: true })
          if (nm !== 0) return nm
          return (a.id || '').localeCompare(b.id || '')
        }) as MatchSlim[]
      const tieList = ((tieRes.data||[]) as any[]).map(t=>({...t,_group_label:t.group_id?(_grpMap[t.group_id]||null):null})) as TieWithClubs[]
      setMatches(matchList); matchesRef.current = matchList
      // ✅ 조 내 순번(1번·2번…) — 코트판 팀명 앞에 표시 (없으면 생략)
      try {
        const { data: gmRows } = await supabase.from('group_members').select('team_id, seq').eq('event_id', eventId)
        const sm: Record<string, number> = {}
        for (const r of (gmRows || []) as any[]) if (r.seq != null) sm[r.team_id] = r.seq
        setSeqMap(sm)
      } catch {}
      setTies(tieList);      tiesRef.current    = tieList
      syncCourtOrderRef(matchList, tieList)

      // TBD 후보용: matches 테이블 직접 조회 (뷰 NULL팀 누락 방지)
      const { data: rawFinals } = await supabase
        .from('matches')
        .select('id, match_num, round, slot, stage, division_id, team_a_id, team_b_id, winner_team_id, status')
        .eq('event_id', eventId)
        .eq('stage', 'FINALS')
        .order('slot', { ascending: true, nullsFirst: true })
      // team_id → name 매핑 (이미 로드한 matchList에서 추출)
      const tNameMap: Record<string, string> = {}
      matchList.forEach(m => {
        if (m.team_a_id && m.team_a_name) tNameMap[m.team_a_id] = m.team_a_name
        if (m.team_b_id && m.team_b_name) tNameMap[m.team_b_id] = m.team_b_name
      })
      const finalsWithNames = (rawFinals || []).map((m: any) => ({
        ...m,
        team_a_name: m.team_a_id ? (tNameMap[m.team_a_id] || '') : '',
        team_b_name: m.team_b_id ? (tNameMap[m.team_b_id] || '') : '',
        court: null, court_order: null, score: null,
        division_name: '', group_label: null, locked_by_participant: false,
      })) as MatchSlim[]
      setAllFinalsMatches(finalsWithNames)
    } catch {}
    finally { if (showLoading) setLoading(false) }
  }, [eventId])

  // ✅ 자동배정 완료 후 코트별 푸시 일괄 발송
  async function sendBulkNotify(courts: string[]) {
    const unique = [...new Set(courts)]
    const headers = await authHeaders()
    await Promise.all(unique.map(court =>
      fetch('/api/notify/court', {
        method: 'POST',
        headers,
        body: JSON.stringify({ event_id: eventId, court, trigger: 'court_changed' }),
      }).catch(() => {})
    ))
  }

  async function loadMatches() {
    if (!eventId) return
    const [{ data }, byeIds] = await Promise.all([
      supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId)
        .order('court', { ascending:true, nullsFirst:false }).order('court_order', { ascending:true, nullsFirst:true }).order('id'),
      fetchPendingByeIds(eventId),
    ])
    const list = (data || [])
      .filter((m: any) => m.score !== 'BYE' && !byeIds.has(m.id))
      .sort((a: any, b: any) => {
        if ((a.court ?? '') !== (b.court ?? '')) return (a.court ?? '').localeCompare(b.court ?? '', undefined, { numeric: true })
        const od = (a.court_order ?? 9999) - (b.court_order ?? 9999)
        if (od !== 0) return od
        const nm = (a.match_num || '').localeCompare(b.match_num || '', undefined, { numeric: true })
        if (nm !== 0) return nm
        return (a.id || '').localeCompare(b.id || '')
      }) as MatchSlim[]
    setMatches(list); matchesRef.current = list
    syncCourtOrderRef(list, tiesRef.current)
  }
  async function loadTies() {
    if (!eventId) return
    const [tieRes, grpRes] = await Promise.all([
      supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)').eq('event_id', eventId).order('tie_order', { ascending:true, nullsFirst:false }).order('id'),
      supabase.from('groups').select('id, group_label').eq('event_id', eventId),
    ])
    const grpMap: Record<string,string> = {}
    for (const g of grpRes.data || []) { if (g.group_label) grpMap[g.id] = g.group_label }
    const list = ((tieRes.data||[]) as any[]).map(t=>({...t,_group_label:t.group_id?(grpMap[t.group_id]||null):null})) as TieWithClubs[]
    setTies(list); tiesRef.current = list
    syncCourtOrderRef(matchesRef.current, list)
  }

  useEffect(() => { if (!eventId) return; loadAll(true); loadVenues(); loadCourtZones(); loadEventSchedule(); loadAutoFill() }, [eventId, loadAll])
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
    const zoneKey    = zoneKeyOf(round)
    const zoneCourts = courtZones[divId]?.[zoneKey] || []
    const pool = zoneCourts.length > 0 ? autoCourts.filter(c => zoneCourts.includes(c)) : autoCourts
    return sortByCourtList(pool.length > 0 ? pool : autoCourts)
  }
  // 코트 버튼 누른 순서가 아니라 코트 목록 순서(1번→N번)로 — 부하가 같으면 앞 코트부터 채움
  function sortByCourtList(pool: string[]): string[] {
    const idx = (c: string) => { const i = filteredCourtNames.indexOf(c); return i < 0 ? 9999 : i }
    return [...pool].sort((a, b) => idx(a) - idx(b))
  }
  // 같은 경기일인 부서인지 (날짜 미지정 부서는 항상 같은 날로 봄)
  function isSameDate(divId: string | null | undefined, refDivId: string): boolean {
    const ref = divMatchDates[refDivId], d = divId ? divMatchDates[divId] : undefined
    return !ref || !d || d === ref
  }
  // ✅ 코트 부하 = 같은 경기일에 그 코트에 남은(안 끝난) 경기 수.
  //    예전엔 그 코트에 붙었던 court_order 최댓값을 썼는데, 끝난 경기·다른 날짜·다른 부서까지 포함돼서
  //    많이 쓴 1번 코트는 늘 '바쁨', 안 쓴 끝 번호 코트가 늘 뽑히는 문제가 있었음.
  function getPendingLoad(pool: string[], refDivId: string): Record<string, number> {
    const load: Record<string, number> = {}
    for (const c of pool) load[c] = 0
    for (const m of matchesRef.current) {
      if (m.court && m.court in load && m.status !== 'FINISHED' && isSameDate(m.division_id, refDivId)) load[m.court]++
    }
    const allCN = venuesRef.current.flatMap(v => venueCourts(v))
    for (const t of tiesRef.current) {
      const cn = (t as any).court_number; if (!cn || t.is_bye || t.status === 'completed' || t.status === 'bye') continue
      const court = globalCourtNumToName(cn, allCN, venuesRef.current)
      if (court in load && isSameDate(t.division_id, refDivId)) load[court]++
    }
    return load
  }
  function getLeastLoaded(pool: string[], load: Record<string, number>): string {
    return pool.reduce((best, c) => (load[c] || 0) < (load[best] || 0) ? c : best, pool[0])
  }
  // 조 이름 순 (1조→2조→…10조, 숫자 인식). 조 없음은 맨 뒤
  function compareGroupKey(a: string, b: string): number {
    if (a === b) return 0
    if (a === 'none') return 1
    if (b === 'none') return -1
    return a.localeCompare(b, 'ko', { numeric: true })
  }

  // ✅ 스마트 코트 선택: 1순위 빈코트, 2순위 대기 적은 코트
  function getSmartCourt(pool: string[], matchList: MatchSlim[]): string {
    const pendingCount: Record<string, number> = {}
    for (const c of pool) pendingCount[c] = 0
    for (const m of matchList) {
      if (m.court && pool.includes(m.court) && m.status === 'PENDING' && m.score !== 'BYE' && isSameDate(m.division_id, autoDiv)) {
        pendingCount[m.court] = (pendingCount[m.court] || 0) + 1
      }
    }
    const hasLive: Record<string, boolean> = {}
    for (const m of matchList) {
      if (m.court && pool.includes(m.court) && m.status === 'IN_PROGRESS') {
        hasLive[m.court] = true
      }
    }
    // 1순위: 완전 빈 코트 (live 없고 pending 0)
    const empty = pool.filter(c => !hasLive[c] && pendingCount[c] === 0)
    if (empty.length > 0) return empty[0]
    // 2순위: pending 가장 적은 코트
    return pool.reduce((best, c) =>
      (pendingCount[c] ?? 999) < (pendingCount[best] ?? 999) ? c : best
    , pool[0])
  }

  // ── 자동 배정: ① 계획(미리보기)만 만들고 → ② 확인 후 [이대로 저장] ─────────────
  //    계획 단계에서는 DB를 건드리지 않음. 조/경기 묶음별로 코트를 바꿔 본 뒤 저장.

  // 가장 많이 나온 코트 (홈 코트 판정용)
  function mostCommonCourt(courts: string[]): string | null {
    const cnt: Record<string, number> = {}
    for (const c of courts) cnt[c] = (cnt[c] || 0) + 1
    let best: string | null = null
    for (const c of Object.keys(cnt)) if (!best || cnt[c] > cnt[best]) best = c
    return best
  }
  // ② 홈 코트: 따로 저장하지 않고 배정 데이터에서 계산 — 그 부서 예선이 놓인 코트들
  function divisionHomeCourts(divId: string): Set<string> {
    const s = new Set<string>()
    for (const m of matchesRef.current) if (m.division_id === divId && m.stage === 'GROUP' && m.court) s.add(m.court)
    const allCN = venuesRef.current.flatMap(v => venueCourts(v))
    for (const t of tiesRef.current) {
      const cn = (t as any).court_number
      if (t.division_id === divId && t.round === 'group' && cn) s.add(globalCourtNumToName(cn, allCN, venuesRef.current))
    }
    return s
  }
  // 본선 코트 풀: 구역이 지정돼 있으면 구역 그대로, 아니면 (선택 코트 중) 그 부서 예선 코트 우선
  function finalsPool(divId: string, round: string, pool: string[]): { pool: string[]; home: boolean } {
    const zoneKey = zoneKeyOf(round)
    if (!preferHome || (courtZones[divId]?.[zoneKey] || []).length > 0) return { pool, home: false }
    const home = divisionHomeCourts(divId)
    const homePool = pool.filter(c => home.has(c))
    return homePool.length > 0 ? { pool: homePool, home: true } : { pool, home: false }
  }
  function matchText(m: MatchSlim): string {
    return `${m.team_a_name || 'TBD'} vs ${m.team_b_name || 'TBD'}`
  }

  function buildGroupPlan(divName: string): AutoPlan | string {
    const targets = matches.filter(m => m.division_id === autoDiv && m.stage === 'GROUP' && !m.court && m.status !== 'FINISHED')
    if (targets.length === 0) return '배정할 예선 경기가 없습니다.'
    const pool = getCourtPool(autoDiv, 'group')
    const byGroup = new Map<string, MatchSlim[]>()
    for (const m of targets) { const k = m.group_label || 'none'; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k)!.push(m) }
    // 조 이름 순(1조→2조…)으로, 같은 날 남은 경기가 가장 적은 코트에 조째로
    const load = getPendingLoad(pool, autoDiv)
    const bundles: PlanBundle[] = []
    for (const [label, list] of [...byGroup.entries()].sort((a, b) => compareGroupKey(a[0], b[0]))) {
      // ② 이 조 경기 중 이미 코트에 놓인 게 있으면 그 코트로 (남은 경기만 다시 배정해도 조가 안 쪼개짐)
      const home = label === 'none' ? null : mostCommonCourt(matchesRef.current
        .filter(m => m.division_id === autoDiv && m.stage === 'GROUP' && m.group_label === label && m.court).map(m => m.court!))
      const court = home || getLeastLoaded(pool, load)
      load[court] = (load[court] || 0) + list.length
      bundles.push({ key:`g:${label}`, kind:'match', title: label === 'none' ? '조 없음' : label, court,
        note: home ? '홈 코트' : undefined, items: sortGroupMatches(list).map(m => ({ id:m.id, text:matchText(m) })) })
    }
    return { title:`[${divName}] 예선`, bundles }
  }

  function buildFinalsPlan(divName: string, rounds: string[]): AutoPlan | string {
    const currentMatches = [...matchesRef.current]
    const bundles: PlanBundle[] = []
    let usedHome = false
    const byNum = (a: MatchSlim, b: MatchSlim) => (a.match_num || '').localeCompare(b.match_num || '', undefined, { numeric: true })
    for (const round of rounds) {
      const raw = matches.filter(m => m.division_id === autoDiv && m.stage === (ROUND_TO_STAGE[round] || 'FINALS') && m.round === round && !m.court && m.status !== 'FINISHED')
      if (raw.length === 0) continue
      // 양쪽 확정 경기 먼저, TBD 나중에 (각각 경기번호 순)
      const targets = [
        ...raw.filter(m => m.team_a_id && m.team_b_id).sort(byNum),
        ...raw.filter(m => !m.team_a_id || !m.team_b_id).sort(byNum),
      ]
      const { pool, home } = finalsPool(autoDiv, round, getCourtPool(autoDiv, round))
      usedHome = usedHome || home
      for (const m of targets) {
        const court = getSmartCourt(pool, currentMatches)
        // 스냅샷에 반영해서 다음 경기 배정 시 코트 상태 반영
        currentMatches.push({ ...m, court, status:'PENDING' })
        bundles.push({ key:`m:${m.id}`, kind:'match', title:`${STAGE_LABEL[round] || round} ${m.match_num}`, court, items:[{ id:m.id, text:matchText(m) }] })
      }
    }
    if (bundles.length === 0) return rounds.length > 1 ? '배정할 본선 경기가 없습니다.' : `배정할 ${STAGE_LABEL[rounds[0]] || rounds[0]} 경기가 없습니다.`
    const label = rounds.length > 1 ? '전체 본선' : (STAGE_LABEL[rounds[0]] || rounds[0])
    return { title:`[${divName}] ${label}`, bundles, note: usedHome ? '예선 치른 코트 우선' : undefined }
  }

  function buildTiePlan(divName: string): AutoPlan | string {
    const selectedRound = TEAM_STAGE_TABS.find(t => t.key === autoStage)?.round || 'group'
    const divTies = ties.filter(t =>
      !t.is_bye && !(t as any).court_number && t.status !== 'completed' &&
      (autoDiv === 'TEAM' ? true : t.division_id === autoDiv) &&
      t.round === selectedRound
    ).sort((a, b) => ((a as any).tie_order ?? 0) - ((b as any).tie_order ?? 0))
    if (divTies.length === 0) return '배정할 경기가 없습니다.'
    const allCN = venuesRef.current.flatMap(v => venueCourts(v))
    const tieText = (t: TieWithClubs) => `${t.club_a?.name || 'TBD'} vs ${t.club_b?.name || 'TBD'}`
    const groupKey = (t: TieWithClubs): string => (t as any)._group_label || (t as any).group_id || 'none'
    // 본선은 그 부서 예선 코트 우선 (단체전은 구역 설정 미적용 — 기존과 동일)
    const { pool, home: usedHome } = selectedRound === 'group'
      ? { pool: sortByCourtList(autoCourts), home: false }
      : finalsPool(autoDiv, 'finals', sortByCourtList(autoCourts))
    const load = getPendingLoad(pool, autoDiv)
    const byGroup = new Map<string, TieWithClubs[]>()
    for (const t of divTies) {
      // 조 없는 경기(본선)는 한 경기씩 따로 — 예전처럼 전부 한 코트에 몰리지 않게
      const k = groupKey(t) === 'none' ? `tie:${t.id}` : groupKey(t)
      if (!byGroup.has(k)) byGroup.set(k, [])
      byGroup.get(k)!.push(t)
    }
    const entries = [...byGroup.entries()]
    if (selectedRound === 'group') entries.sort((a, b) => compareGroupKey(a[0], b[0]))
    const bundles: PlanBundle[] = []
    for (const [k, list] of entries) {
      const single = k.startsWith('tie:')
      // ② 같은 조 경기 중 이미 코트가 있는 게 있으면 그 코트로
      const home = single ? null : mostCommonCourt(tiesRef.current
        .filter(t => groupKey(t) === k && (t as any).court_number && (autoDiv === 'TEAM' || t.division_id === autoDiv))
        .map(t => globalCourtNumToName((t as any).court_number, allCN, venuesRef.current)))
      const court = home || getLeastLoaded(pool, load)
      load[court] = (load[court] || 0) + list.length
      bundles.push({ key:`t:${k}`, kind:'tie', court, note: home ? '홈 코트' : undefined,
        title: single ? `${TEAM_STAGE_LABEL[selectedRound] || selectedRound} ${(list[0] as any).tie_order ?? ''}`.trim() : k,
        items: list.map(t => ({ id:t.id, text:tieText(t) })) })
    }
    return { title:`[${divName}] ${TEAM_STAGE_LABEL[selectedRound] || selectedRound}`, bundles, note: usedHome ? '예선 치른 코트 우선' : undefined }
  }

  function autoAssignByDivision() {
    if (!autoDiv) { setMsg('부문을 선택해주세요.'); return }
    if (autoCourts.length === 0) { setMsg('배정할 코트를 선택해주세요.'); return }
    const isTeam = autoDiv === 'TEAM' || ties.some(t => t.division_id === autoDiv && !t.is_bye)
    const divName = divisions.find(d => d.id === autoDiv)?.name || (isTeam ? '단체전' : '')
    const r = isTeam                ? buildTiePlan(divName)
      : autoStage === 'GROUP'       ? buildGroupPlan(divName)
      : autoStage === 'ALL_FINALS'  ? buildFinalsPlan(divName, ['128강','64강','32강','16강','8강','4강','결승'])
      :                               buildFinalsPlan(divName, [autoStage])
    if (typeof r === 'string') { setMsg(r); setPlan(null); return }
    setMsg(''); setPlan(r)
  }

  function movePlanBundle(key: string, court: string) {
    setPlan(p => p ? { ...p, bundles: p.bundles.map(b => b.key === key ? { ...b, court, note: undefined } : b) } : p)
  }

  // ③ 미리보기 확정: 묶음 순서대로 각 코트 대기열 맨 뒤에 붙임
  async function applyPlan() {
    if (!plan) return
    setAssigning(true)
    try {
      const curM = new Map(matchesRef.current.map(m => [m.id, m]))
      const curT = new Map(tiesRef.current.map(t => [t.id, t]))
      const perCourt: Record<string, number> = {}
      let saved = 0, skipped = 0, failed = 0
      for (const b of plan.bundles) {
        for (const it of b.items) {
          // 미리보기 보는 사이에 다른 곳에서 이미 배정됐으면 건너뜀
          const already = b.kind === 'tie' ? (curT.get(it.id) as any)?.court_number : curM.get(it.id)?.court
          if (already) { skipped++; continue }
          const nextOrder = (courtOrderRef.current[b.court] || 0) + 1
          const { error } = b.kind === 'tie'
            ? await supabase.from('ties').update({ court_number:getGlobalCourtNumber(b.court, allCourtNames), court_order:nextOrder }).eq('id', it.id)
            : await supabase.from('matches').update({ court:b.court, court_order:nextOrder }).eq('id', it.id)
          if (error) { failed++; continue }
          courtOrderRef.current[b.court] = nextOrder
          perCourt[b.court] = (perCourt[b.court] || 0) + 1
          saved++
        }
      }
      const summary = sortByCourtList(Object.keys(perCourt)).map(c => `${c}:${perCourt[c]}경기`).join(' | ')
      const extra = [skipped ? `이미 배정돼 건너뜀 ${skipped}` : '', failed ? `실패 ${failed}` : ''].filter(Boolean).join(', ')
      setMsg(`${failed ? '⚠️' : '✅'} ${plan.title} ${saved}경기 배정 완료${summary ? ' — ' + summary : ''}${extra ? ` (${extra})` : ''}`)
      sendBulkNotify(Object.keys(perCourt))
      setPlan(null)
      loadMatches(); loadTies()
    } finally { setAssigning(false) }
  }

  async function assignItemToCourt(itemId: string, court: string) {
    if (itemId.startsWith('tie_')) {
      // ✅ [FIX-②] 드래그 배정도 글로벌 court_number 사용
      const courtNum = getGlobalCourtNumber(court, allCourtNames)
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
  async function moveMatchOrder(itemId: string, direction: 'up' | 'down') {
    // 개인전(matches) + 단체전(ties) 모두 지원
    const allList = [...matches, ...tiesToMatchSlim(ties)]
    const m = allList.find(mm => mm.id === itemId)
    if (!m || !m.court || !m.court_order) return
    const cms = allList.filter(mm => mm.court === m.court).sort((a,b) => (a.court_order||0)-(b.court_order||0))
    const idx = cms.findIndex(mm => mm.id === itemId)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= cms.length) return
    const other = cms[swapIdx]
    const aOrder = m.court_order
    const bOrder = other.court_order

    const updateOne = async (item: any, newOrder: number | null) => {
      if (item.id.startsWith('tie_')) {
        await supabase.from('ties').update({ court_order: newOrder }).eq('id', item.id.replace('tie_',''))
      } else {
        await supabase.from('matches').update({ court_order: newOrder }).eq('id', item.id)
      }
    }
    await updateOne(m, bOrder)
    await updateOne(other, aOrder)

    if (m.is_team_tie || other.is_team_tie) loadTies()
    if (!m.is_team_tie || !other.is_team_tie) loadMatches()
  }

  async function clearDivisionAssignments(divId: string) {
    const _divName = divId === 'TEAM' ? '단체전' : (divisions.find(d=>d.id===divId)?.name||'')
    if (divId === 'TEAM' || teamDivIds.has(divId)) {
      if (!confirm(`[${_divName}] 코트 배정을 모두 초기화하시겠습니까?`)) return
      for (const t of ties.filter(t => (divId==='TEAM'||t.division_id===divId) && t.court_number))
        await supabase.from('ties').update({ court_number:null, court_order:null }).eq('id', t.id)
      courtOrderRef.current = {}; setMsg(`✅ [${_divName}] 초기화 완료`); loadTies(); return
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
    // 처음 끝난 경기 → 다음 대기팀 '경기 준비' 알림 / 이미 끝난 경기 수정 → 본선 빈자리 알림만 확인
    const wasFinished = editMatch.status === 'FINISHED'
    try {
      const { error: rpcError } = await supabase.rpc('rpc_submit_match_result', { p_match_id:editMatch.id, p_score:editScore, p_winner_team_id:winnerId })
      if (rpcError) {
        if (editMatch.status === 'FINISHED') {
          const { error: ue } = await supabase.from('matches').update({ score:editScore, winner_team_id:winnerId, status:'FINISHED', ended_at:new Date().toISOString() }).eq('id', editMatch.id)
          if (ue) { setMsg('❌ ' + ue.message); return }
          // ✅ [2-2] 강제 수정 시에도 본선 승자 진출 처리 (raw update가 대진표 갱신을 건너뛰던 버그)
          //    advance_winner는 FINALS가 아니면 내부에서 즉시 return → 안전. 빈 슬롯만 채움(재실행 안전).
          //    주의: 이미 다음 라운드가 채워진 상태에서 '승자 자체'를 바꾸려면 admin-pin 강제수정 도구 사용.
          await supabase.rpc('advance_winner', { p_match_id: editMatch.id })
          setMsg('✅ 결과 강제 수정됨 (운영자 모드)')
        } else { setMsg('❌ ' + rpcError.message); return }
      } else {
        setMsg('✅ 결과 저장됨')
      }
      // ✅ [2-3] 조별 경기였다면 본선 슬롯 자동 채우기 (선수 브라우저가 못 채운 경우 대비 안전망)
      await fillSlotsIfGroupComplete(eventId, editMatch)
      // 알림은 슬롯 채우기 뒤에 — 새로 채워진 본선 팀도 같은 호출에서 확인되도록
      if (!wasFinished && editMatch.court) sendCourtNotify(editMatch.court, 'finished')
      else requestSlotCheck(eventId)
      setEditMatch(null)
      await loadMatches()
    } finally { setSubmitting(false) }
  }

  async function startMatch(matchId: string) {
    if (matchId.startsWith('tie_')) return
    // 같은 선수가 다른 코트에서 경기 중이면 확인 (여러 부서 출전 — 예: 학생 단식+복식)
    const target = matchesRef.current.find(m => m.id === matchId)
    const busy = target ? busyElsewhere(target, matchesRef.current) : []
    if (busy.length > 0 && !confirm(`⚠️ 다른 코트에서 경기 중인 선수가 있습니다.\n\n${describeConflicts(busy)}\n\n그래도 이 경기를 시작할까요?`)) return
    await supabase.from('matches').update({ status:'IN_PROGRESS' }).eq('id', matchId); loadMatches()
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  function handleDropOnCourt(court: string) { if (!dragMatch) return; assignItemToCourt(dragMatch, court); setDragMatch(null) }
  function handleDropOnUnassigned() { if (!dragMatch) return; unassignItem(dragMatch); setDragMatch(null) }

  // ── 터치 드래그: 롱프레스(300ms) 후에만 드래그 시작 (스크롤 실수 방지) ──
  const touchStartInfo = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> | null }>({ id: '', x: 0, y: 0, timer: null })
  const touchOverRef = useRef<string | null>(null)

  function handleTouchStart(id: string) {
    // 이전 타이머 취소
    if (touchStartInfo.current.timer) clearTimeout(touchStartInfo.current.timer)
    touchStartInfo.current = { id, x: 0, y: 0, timer: null }
    // 300ms 후 드래그 시작 (롱프레스)
    touchStartInfo.current.timer = setTimeout(() => {
      touchStartInfo.current.timer = null
      touchDragIdRef.current = id
      setTouchDragId(id)
      if ('vibrate' in navigator) navigator.vibrate(50)
    }, 300)
  }

  function handleTouchMove(e: React.TouchEvent) {
    const touch = e.touches[0]
    // 롱프레스 타이머 살아있으면: 10px 이상 이동 = 스크롤 의도 → 타이머 취소
    if (touchStartInfo.current.timer) {
      if (!touchStartInfo.current.x) {
        touchStartInfo.current.x = touch.clientX
        touchStartInfo.current.y = touch.clientY
      }
      const dx = Math.abs(touch.clientX - touchStartInfo.current.x)
      const dy = Math.abs(touch.clientY - touchStartInfo.current.y)
      if (dx > 10 || dy > 10) {
        clearTimeout(touchStartInfo.current.timer)
        touchStartInfo.current.timer = null
        return // 일반 스크롤 계속
      }
    }
    // 드래그 중이 아니면 즉시 리턴
    if (!touchDragIdRef.current) return
    e.preventDefault()
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    const courtEl      = el?.closest('[data-court]') as HTMLElement | null
    const unassignedEl = el?.closest('[data-unassigned]') as HTMLElement | null
    const next = courtEl ? 'court:' + courtEl.dataset.court : unassignedEl ? 'unassigned' : null
    if (next !== touchOverRef.current) {
      touchOverRef.current = next
      setTouchOver(next)
    }
  }

  function handleTouchEnd() {
    // 롱프레스 타이머 취소 (짧은 탭)
    if (touchStartInfo.current.timer) {
      clearTimeout(touchStartInfo.current.timer)
      touchStartInfo.current.timer = null
    }
    const dragId = touchDragIdRef.current
    const over   = touchOverRef.current
    touchDragIdRef.current = null; touchOverRef.current = null
    setTouchDragId(null); setTouchOver(null)
    if (!dragId || !over) return
    if (over === 'unassigned') unassignItem(dragId)
    else if (over.startsWith('court:')) assignItemToCourt(dragId, over.slice(6))
  }

  // ✅ [FIX-①②⑤] tiesToMatchSlim: 글로벌 court_number → courtName, DB 실제 court_order 사용
  function tiesToMatchSlim(tieList: TieWithClubs[]): MatchSlim[] {
    return tieList.filter(t => !t.is_bye).map(t => {
      const cn = (t as any).court_number
      let courtName: string | null = null
      if (cn != null) {
        // ✅ [FIX-①②] 글로벌 court_number → courtName 역변환 (short_name-N 포맷 통일)
        courtName = globalCourtNumToName(cn, allCourtNames, venuesRef.current)
      }
      const statusMap: Record<string,string> = { pending:'PENDING', lineup_phase:'PENDING', lineup_ready:'PENDING', in_progress:'IN_PROGRESS', completed:'FINISHED' }
      return {
        id:`tie_${t.id}`, match_num:`T#${t.tie_order}`, stage:'TEAM', round:t.round||'group',
        team_a_name:t.club_a?.name||'TBD', team_b_name:t.club_b?.name||'TBD',
        team_a_id:t.club_a_id||'', team_b_id:t.club_b_id||'',
        court:courtName,
        // ✅ [FIX-⑤] DB 실제 court_order 사용 (100+tie_order 하드코딩 제거)
        court_order:cn ? ((t as any).court_order ?? t.tie_order ?? 999) : null,
        status:statusMap[t.status]||'PENDING',
        score:(t.status==='completed'||t.status==='in_progress') ? `${t.club_a_rubbers_won ?? 0}-${t.club_b_rubbers_won ?? 0}` : null,
        winner_team_id:t.winning_club_id||null,
        division_name:(divisions.find(d=>d.id===t.division_id)?.name||'단체전'), division_id:t.division_id||'',
        locked_by_participant:false, group_label:(t as any)._group_label||null, is_team_tie:true,
      }
    })
  }

  const tieMatches  = tiesToMatchSlim(ties)
  const allItems    = [...matches, ...tieMatches]

  const divColors: Record<string,string> = {}
  const colors = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#ef4444']
  divisions.forEach((d, i) => { divColors[d.id] = colors[i % colors.length] })

  const teamDivIds = new Set(ties.filter(t=>!t.is_bye).map(t=>t.division_id).filter(Boolean) as string[])
  const hasTeamTies = teamDivIds.size > 0
  const selectedVenueInfo = venues.find(v => v.id === selectedVenue)

  if (!eventId) return <p className="text-stone-400">설정에서 대회를 선택해주세요.</p>
  if (loading)  return <p className="text-stone-400">불러오는 중..</p>

  const uniqueDates = [...new Set(Object.values(divMatchDates))].sort()
  const dateDivIds = dateFilter === 'ALL'
    ? null
    : Object.entries(divMatchDates).filter(([, d]) => d === dateFilter).map(([id]) => id)

  // ✅ match_date가 설정된 부서만 날짜로 거름. 미지정 부서는 항상 표시.
  const filteredDivisions = dateDivIds
    ? divisions.filter(d => dateDivIds.includes(d.id) || !divMatchDates[d.id])
    : divisions
  const dateFilteredItems = dateDivIds
    ? allItems.filter(m => {
        if (!m.division_id) return true
        if (!divMatchDates[m.division_id]) return true   // 날짜 미지정 부서 → 항상 표시
        return dateDivIds.includes(m.division_id)
      })
    : allItems

  const byCourt = new Map<string, MatchSlim[]>()
  for (const name of filteredCourtNames) byCourt.set(name, [])
  for (const m of dateFilteredItems) { if (m.court && byCourt.has(m.court)) byCourt.get(m.court)!.push(m) }

  // 코트별 "지금 경기"에 같은 선수가 두 코트 이상 걸린 경우 (전체 코트 기준)
  const courtConflicts = findCourtConflicts(dateFilteredItems)
  const conflictLines = [...new Set(
    dateFilteredItems.filter(m => courtConflicts.has(m.id))
      .flatMap(m => courtConflicts.get(m.id)!.map(c => c.player))
  )].map(player => {
    const courts = dateFilteredItems
      .filter(m => courtConflicts.get(m.id)?.some(c => c.player === player))
      .map(m => `${m.court} ${m.status === 'IN_PROGRESS' ? '진행중' : '대기'}(${m.division_name})`)
    return `${player}: ${courts.join(' · ')}`
  })

  const filteredAll = viewFilter==='ALL' ? dateFilteredItems : dateFilteredItems.filter(m=>m.division_id===viewFilter)
  const unassigned  = filteredAll
    .filter(m => !m.court && m.status !== 'FINISHED')
    .sort((a,b) => {
      const nm = (a.match_num || '').localeCompare(b.match_num || '', undefined, { numeric: true })
      if (nm !== 0) return nm
      return a.id.localeCompare(b.id)
    })

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-bold">코트 배정</h1>
        {startTime && <span className="text-xs text-stone-500">⏰ {startTime} 자동시작</span>}
      </div>

      {msg && <div className={`mb-4 p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-tennis-50 text-tennis-700' : 'bg-red-50 text-red-600'}`}>{msg}</div>}

      {/* 날짜 필터 */}
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

      {/* 경기장 선택 */}
      {venues.length > 0 && (
        <div className="bg-white rounded-xl border p-3 mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-stone-500 font-medium whitespace-nowrap">📍 경기장:</span>
            <button onClick={() => setSelectedVenue('ALL')} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${selectedVenue==='ALL' ? 'bg-[#2d5016] text-white border-[#2d5016]' : 'bg-white text-stone-600 border-stone-300 hover:border-stone-400'}`}>🏟 전체 보기</button>
            {venues.map(v => {
              const cs = venueCourts(v); const first = cs[0] || '-', last = cs[cs.length - 1] || '-'
              return <button key={v.id} onClick={() => setSelectedVenue(v.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${selectedVenue===v.id ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-stone-600 border-stone-300 hover:border-orange-400'}`}>{v.name} <span className="opacity-70">({first}~{last})</span></button>
            })}
          </div>
          {selectedVenueInfo && (() => { const cs = venueCourts(selectedVenueInfo); return <p className="text-xs text-stone-400 mt-2">{cs[0] || '-'} ~ {cs[cs.length - 1] || '-'} · PIN: {selectedVenueInfo.pin_plain}</p> })()}
        </div>
      )}

      {/* ④ 빈 코트 자동 이어 배정 (개인전) */}
      {autoFill && (
        <div className={`rounded-xl border p-4 mb-4 ${autoFill.fill ? 'bg-sky-50 border-sky-300' : 'bg-white'}`}>
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-[220px]">
              <h3 className="font-bold text-sm">⚡ 빈 코트 자동 이어 배정 <span className="text-xs font-normal text-stone-400">(개인전 · 이 대회에만 적용)</span></h3>
              <p className="text-xs text-stone-500 mt-1">
                경기가 끝났는데 그 코트에 대기 경기가 없으면, 아직 코트가 없는 경기 중 다음 경기를 데려와 <b>바로 시작</b>합니다.
                같은 조 → 같은 부서 → 다른 부서 순, 같은 날·두 팀 확정·다른 코트에서 경기 중이 아닌 경기만. 코트 구역이 있으면 지킵니다.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" className="w-4 h-4" checked={autoFill.fill} disabled={autoFillSaving}
                onChange={e => saveAutoFill({ fill: e.target.checked, steal: autoFill.steal })} />
              {autoFill.fill ? '켜짐' : '꺼짐'}
            </label>
          </div>
          {autoFill.fill && (
            <label className="mt-3 flex items-start gap-2 text-xs text-stone-600 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 mt-0.5" checked={autoFill.steal} disabled={autoFillSaving}
                onChange={e => saveAutoFill({ fill: true, steal: e.target.checked })} />
              <span>
                <b>밀린 코트 경기 가져오기</b> — 데려올 경기가 없으면 같은 경기장에서 가장 밀린 코트(대기 2경기 이상)의 맨 마지막 경기를 가져와 시작
                <span className="text-amber-600"> (조가 다른 코트로 나뉠 수 있음)</span>
              </span>
            </label>
          )}
        </div>
      )}

      {/* 자동 배정 패널 */}
      <div className="bg-white rounded-xl border p-4 mb-4 space-y-4">
        <h3 className="font-bold text-sm">🎯 자동 코트 배정</h3>
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="text-xs text-stone-500 block mb-1">부문</label>
            <select value={autoDiv} onChange={e => {
              const divId = e.target.value
              setAutoDiv(divId)
              const _isTeam = ties.some(t => t.division_id === divId && !t.is_bye)
              setAutoStage(_isTeam ? 'group' : 'GROUP')
            }} className="border rounded-lg px-3 py-2 text-sm min-w-[140px]">
              <option value="">부문 선택</option>
              {filteredDivisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          {autoDiv && (
            <div>
              <label className="text-xs text-stone-500 block mb-1">스테이지</label>
              <div className="flex flex-wrap gap-1">
                {teamDivIds.has(autoDiv) ? (
                  TEAM_STAGE_TABS.filter(tab =>
                    ties.some(t => t.division_id === autoDiv && t.round === tab.round && !t.is_bye)
                  ).map(tab => (
                    <button key={tab.key} onClick={() => setAutoStage(tab.key)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${autoStage===tab.key?'bg-tennis-600 text-white border-tennis-600':'border-stone-300 hover:border-tennis-400'}`}>
                      {tab.label}
                    </button>
                  ))
                ) : (() => {
                  const existingRounds = new Set(
                    matches.filter(m => m.division_id === autoDiv && m.stage === 'FINALS').map(m => m.round)
                  )
                  return STAGE_TABS.filter(tab => {
                    if (tab.key === 'GROUP') return true
                    if (tab.key === 'ALL_FINALS') return existingRounds.size >= 2
                    return existingRounds.has(tab.key)
                  }).map(tab => (
                    <button key={tab.key} onClick={() => setAutoStage(tab.key)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${autoStage===tab.key?(tab.key==='ALL_FINALS'?'bg-purple-600 text-white border-purple-600':'bg-tennis-600 text-white border-tennis-600'):'border-stone-300 hover:border-tennis-400'}`}>
                      {tab.label}
                    </button>
                  ))
                })()}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-stone-500">배정 코트</label>
            <button onClick={() => setAutoCourts(autoCourts.length===filteredCourtNames.length ? [] : [...filteredCourtNames])}
              className="text-xs px-2 py-0.5 rounded border border-dashed border-stone-400 text-stone-500 hover:border-tennis-500 hover:text-tennis-600 transition-all">
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
            {`🎯 ${autoDiv ? (teamDivIds.has(autoDiv) ? TEAM_STAGE_LABEL[autoStage]||'' : STAGE_LABEL[autoStage]||'') : ''} 자동 배정 미리보기`}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer">
            <input type="checkbox" checked={preferHome} onChange={e => setPreferHome(e.target.checked)} />
            본선은 그 부서 예선 코트 우선 <span className="text-stone-400">(본선 구역 미지정 시)</span>
          </label>
        </div>

        {/* ③ 미리보기 — 저장 전 코트별 배정 확인, 조/경기 단위로 코트 변경 가능 */}
        {plan && (() => {
          const planCourts = sortByCourtList([...new Set([...autoCourts, ...plan.bundles.map(b => b.court)])])
          const before = getPendingLoad(planCourts, autoDiv)
          const total = plan.bundles.reduce((n, b) => n + b.items.length, 0)
          return (
            <div className="border-2 border-amber-300 bg-amber-50 rounded-xl p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold">👀 미리보기 — {plan.title} {total}경기</span>
                {plan.note && <span className="text-xs px-2 py-0.5 rounded bg-white border text-stone-600">{plan.note}</span>}
                <span className="text-xs text-amber-700">아직 저장 안 됨 · 코트를 바꾸려면 각 조/경기 옆 선택칸에서 변경</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {planCourts.map(c => {
                  const bs = plan.bundles.filter(b => b.court === c)
                  const added = bs.reduce((n, b) => n + b.items.length, 0)
                  return (
                    <div key={c} className={`bg-white rounded-lg border p-2 ${added === 0 ? 'opacity-60' : ''}`}>
                      <div className="flex justify-between items-baseline text-xs font-bold mb-1">
                        <span>{c}</span>
                        <span className="text-stone-400 font-normal">기존 {before[c] || 0} + 새 {added}</span>
                      </div>
                      {bs.length === 0 ? <p className="text-xs text-stone-300">—</p> : bs.map(b => (
                        <div key={b.key} className="border-t first:border-t-0 py-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold">{b.title}</span>
                            {b.note && <span className="text-[10px] px-1 rounded bg-green-50 text-green-700 border border-green-200">{b.note}</span>}
                            <select value={b.court} onChange={e => movePlanBundle(b.key, e.target.value)}
                              className="ml-auto border rounded px-1 py-0.5 text-xs bg-white">
                              {[...new Set([...filteredCourtNames, b.court])].map(x => <option key={x} value={x}>{x}</option>)}
                            </select>
                          </div>
                          <ul className="text-[11px] text-stone-500 mt-0.5 space-y-0.5">
                            {b.items.map(it => <li key={it.id} className="truncate">· {it.text}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={applyPlan} disabled={assigning}
                  className="bg-tennis-600 text-white px-5 py-2 rounded-lg text-sm font-bold hover:bg-tennis-700 disabled:opacity-50 flex items-center gap-2">
                  {assigning ? <><span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />저장 중...</> : '✅ 이대로 저장'}
                </button>
                <button onClick={() => setPlan(null)} disabled={assigning}
                  className="px-4 py-2 rounded-lg text-sm border border-stone-300 text-stone-600 hover:bg-stone-50">취소</button>
              </div>
            </div>
          )
        })()}

        {/* 코트 구역 설정 (접기) */}
        <div className="border-t pt-3">
          <button onClick={() => setZoneOpen(!zoneOpen)} className="flex items-center gap-2 text-xs font-medium text-stone-600 hover:text-stone-800 transition-all">
            <span>{zoneOpen ? '▾' : '▸'}</span><span>부서별 코트 구역 설정</span><span className="text-stone-400 font-normal">(예선용 / 본선용)</span>
          </button>
          {zoneOpen && (
            <div className="mt-3 space-y-3">
              <div className="flex gap-1">
                {(['group','finals'] as const).map(t => (
                  <button key={t} onClick={() => setZoneTab(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${zoneTab===t ? 'bg-stone-700 text-white border-stone-700' : 'border-stone-300 text-stone-500 hover:border-stone-500'}`}>
                    {t==='group' ? '예선용 구역' : '본선용 구역 (본선 전체)'}
                  </button>
                ))}
              </div>
              {zoneTab === 'finals' && (
                <p className="text-xs text-stone-400">본선 첫 라운드(128강·64강·32강·16강 …)부터 결승까지 모두 이 구역에 배정됩니다.</p>
              )}
              {filteredDivisions.map(div => {
                const selected = courtZones[div.id]?.[zoneTab] || []
                // 본선 탭: 이 부서 본선이 실제로 몇 강부터인지 표시 (대진표 만들기 전이면 생략)
                const divRounds = new Set(matches.filter(m => m.division_id === div.id && m.stage === 'FINALS').map(m => m.round))
                const firstRound = FINALS_ROUND_ORDER.find(r => divRounds.has(r))
                return (
                  <div key={div.id} className="flex items-start gap-3">
                    <div className="w-24 flex-shrink-0 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span style={{ width:8, height:8, borderRadius:'50%', background:divColors[div.id], display:'inline-block', flexShrink:0 }} />
                        <span className="text-xs font-medium text-stone-700 truncate">{div.name}</span>
                      </div>
                      {zoneTab === 'finals' && firstRound && (
                        <span className="text-[10px] text-stone-400 ml-3.5">{STAGE_LABEL[firstRound] || firstRound}~결승</span>
                      )}
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
                    </div>
                  </div>
                )
              })}
              <button onClick={saveCourtZones} disabled={zoneSaving} className="bg-stone-700 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-stone-800 disabled:opacity-50">{zoneSaving ? '저장 중...' : '💾 구역 설정 저장'}</button>
            </div>
          )}
        </div>
      </div>

      {/* 뷰 필터 / 초기화 */}
      <div className="bg-white rounded-xl border p-3 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
            <button onClick={() => setViewFilter('ALL')} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter==='ALL'?'bg-white shadow-sm':''}`}>전체</button>
            {filteredDivisions.map(d => <button key={d.id} onClick={() => setViewFilter(d.id)} className={`px-3 py-1 rounded-md text-xs font-medium ${viewFilter===d.id?'bg-white shadow-sm':''}`}>{d.name}</button>)}
          </div>
          <div className="ml-auto flex gap-2">
            {autoDiv && <button onClick={() => clearDivisionAssignments(autoDiv)} className="text-xs text-stone-400 hover:text-red-500 border border-stone-200 px-2 py-1 rounded-lg">{divisions.find(d=>d.id===autoDiv)?.name} 초기화</button>}
            <button onClick={clearAllAssignments} className="text-xs text-stone-400 hover:text-red-500 border border-stone-200 px-2 py-1 rounded-lg">전체 초기화</button>
          </div>
        </div>
      </div>

      {/* 선수 중복 경고 — 한 선수가 동시에 두 코트에 걸림 */}
      {conflictLines.length > 0 && (
        <div className="mb-4 p-3 rounded-xl border border-red-300 bg-red-50 text-sm text-red-700">
          <p className="font-bold mb-1">⚠️ 같은 선수가 동시에 두 코트에 배정돼 있습니다</p>
          <ul className="space-y-0.5 text-xs">
            {conflictLines.map(line => <li key={line}>· {line}</li>)}
          </ul>
          <p className="text-[11px] text-red-500 mt-1">코트 순서를 바꾸거나 한 경기를 뒤로 미뤄주세요.</p>
        </div>
      )}

      {/* ═══ 메인 그리드: 미배정 + 코트 ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">

        {/* 미배정 컬럼 */}
        <UnassignedColumn
          unassigned={(unassigned).map(decorate)}
          divColors={divColors}
          touchOver={touchOver}
          onDragOver={handleDragOver}
          onDrop={handleDropOnUnassigned}
          onDragStart={setDragMatch}
          onClickScore={openScoreEdit}
          onClickUnassign={unassignItem}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        />

        {/* 코트 그리드 */}
        <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
          {filteredCourtNames.map(court => {
            const courtItems = (byCourt.get(court)||[]).sort((a,b)=> {
              const od = (a.court_order ?? 9999) - (b.court_order ?? 9999)
              if (od !== 0) return od
              const nm = (a.match_num || '').localeCompare(b.match_num || '', undefined, { numeric: true })
              if (nm !== 0) return nm
              return a.id.localeCompare(b.id)
            })
            const finished   = courtItems.filter(m=>m.status==='FINISHED').length
            const activeIdx  = courtItems.findIndex(m=>m.status==='IN_PROGRESS')
            const pendingIdx = courtItems.findIndex(m=>m.status==='PENDING')
            const currentIdx = activeIdx>=0?activeIdx:pendingIdx
            const isLive     = activeIdx>=0
            const hasPending = courtItems.some(m=>m.status==='PENDING')
            const zoneDiv = autoDiv && !teamDivIds.has(autoDiv) ? (() => {
              const z = courtZones[autoDiv]; if (!z) return null
              if (z.finals?.includes(court)) return { label:'본선', color:divColors[autoDiv] }
              if (z.group?.includes(court))  return { label:'예선', color:divColors[autoDiv]+'99' }
              return null
            })() : null

            return (
              <div key={court} data-court={court}
                onDragOver={handleDragOver} onDrop={() => handleDropOnCourt(court)}
                className={`bg-white rounded-xl border overflow-hidden min-h-[100px] transition-all ${touchOver==='court:'+court?'ring-2 ring-tennis-400 bg-tennis-50':''}`}>

                <div className={`px-3 py-2 font-bold text-sm flex items-center justify-between ${isLive?'bg-red-700':'bg-[#2d5016]'} text-white`}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`font-bold ${court.length > 6 ? 'text-xs' : 'text-sm'}`}>{court}</span>
                    {isLive && <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded-full animate-pulse flex-shrink-0">LIVE</span>}
                    {zoneDiv && <span style={{ background:zoneDiv.color }} className="text-[9px] px-1 py-0.5 rounded text-white/90 flex-shrink-0">{zoneDiv.label}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-white/60 text-xs">{finished}/{courtItems.length}</span>
                    <button onClick={() => sendCourtNotify(court,'manual')} disabled={notifying===court||!hasPending}
                      className="text-white/80 hover:text-white disabled:opacity-30 text-sm leading-none">
                      {notifying===court?'⏳':'🔔'}
                    </button>
                  </div>
                </div>

                {notifyMsg[court] && <div className="px-3 py-1 text-xs bg-amber-50 text-amber-800 border-b">{notifyMsg[court]}</div>}

                <div className="p-1.5 space-y-1 max-h-[600px] overflow-y-auto">
                  {courtItems.filter(m=>m.status!=='FINISHED').map((m) => {
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
                    return (
                      <MatchChip key={m.id} m={decorate(m)} badge={badge}
                        isCurrentSlot={m.status==='PENDING'&&allIdx===currentIdx}
                        conflicts={courtConflicts.get(m.id)}
                        divColor={divColors[m.division_id]}
                        allMatches={allFinalsMatches.length > 0 ? allFinalsMatches : matches}
                        onDragStart={setDragMatch} onClickScore={() => openScoreEdit(m)}
                        onClickStart={canStart?()=>startMatch(m.id):undefined}
                        onClickUnassign={() => unassignItem(m.id)}
                        onMoveUp={allIdx>0?()=>moveMatchOrder(m.id,'up'):undefined}
                        onMoveDown={allIdx<courtItems.length-1?()=>moveMatchOrder(m.id,'down'):undefined} />
                    )
                  })}

                  {finished > 0 && (
                    <FinishedCourtItems
                      items={courtItems.filter(m=>m.status==='FINISHED')}
                      onClickScore={openScoreEdit}
                      onClickUnassign={unassignItem}
                      divColors={divColors} />
                  )}

                  {courtItems.length===0 && (
                    <div className="text-xs text-stone-300 text-center py-6 border-2 border-dashed rounded-lg">
                      드래그 또는 자동배정
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 점수 입력 모달 */}
      {editMatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditMatch(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            {editMatch.status==='FINISHED' && (
              <div className="mb-4 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
                <span className="text-lg">⚠️</span>
                <div>
                  <p className="text-xs font-semibold text-amber-800">완료된 경기 수정 (운영자 모드)</p>
                  <p className="text-xs text-amber-600 mt-0.5">기존 결과: {editMatch.score||'-'}</p>
                </div>
              </div>
            )}
            <h3 className="font-bold text-lg mb-1">경기 결과 입력/수정</h3>
            <p className="text-xs text-stone-400 mb-4">
              {editMatch.match_num} · {editMatch.division_name} · {editMatch.round}
              {editMatch.court && <span className="ml-1 font-medium text-[#2d5016]">({editMatch.court} #{editMatch.court_order})</span>}
            </p>
            <div className="flex items-center justify-center gap-4 my-4">
              <div className="text-center flex-1 font-medium">{editMatch.team_a_name||'TBD'}</div>
              <span className="text-xl text-stone-300">VS</span>
              <div className="text-center flex-1 font-medium">{editMatch.team_b_name||'TBD'}</div>
            </div>
            <div className="mb-4">
              <label className="text-xs text-stone-500 mb-1 block">점수</label>
              <input type="text" placeholder="6:4" value={editScore} onChange={e=>setEditScore(e.target.value)}
                className="w-full border rounded-xl px-4 py-3 text-center text-lg font-bold" autoFocus />
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
              <button onClick={submitResult} disabled={submitting||!editScore||!editWinner}
                className={`flex-1 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 text-white ${editMatch.status==='FINISHED'?'bg-amber-500 hover:bg-amber-600':'bg-tennis-600 hover:bg-tennis-700'}`}>
                {submitting?'저장 중..':editMatch.status==='FINISHED'?'강제 수정':'결과 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 완료 경기 접기 컴포넌트
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
          {items.map(m => (
            <div key={m.id} className="rounded-lg border border-stone-100 bg-stone-50 p-2 opacity-60">
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="text-xs text-stone-500"><MatchTeamRow raw={m.team_a_name} done /><span className="text-stone-300 mx-0.5">vs</span><MatchTeamRow raw={m.team_b_name} done /></span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {m.score && <span className="text-xs font-bold text-stone-500">{m.score}</span>}
                  {m.ended_at && <span className="text-[10px] text-stone-400">🕒{fmtEndTime(m.ended_at)}</span>}
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

// ── MatchChip 컴포넌트
function MatchChip({ m, badge, divColor, isCurrentSlot, conflicts, allMatches, onDragStart, onClickScore, onClickStart, onClickUnassign, onMoveUp, onMoveDown, onTouchStart, onTouchMove, onTouchEnd }: {
  m: MatchSlim; badge?: string; divColor?: string; isCurrentSlot?: boolean
  conflicts?: PlayerConflict[]
  allMatches?: MatchSlim[]
  onDragStart: (id: string) => void; onClickScore: () => void
  onClickStart?: () => void; onClickUnassign?: () => void
  onMoveUp?: () => void; onMoveDown?: () => void
  onTouchStart?: () => void; onTouchMove?: (e: React.TouchEvent) => void; onTouchEnd?: () => void
}) {
  const done = m.status==='FINISHED'; const live = m.status==='IN_PROGRESS'; const isTeam = m.is_team_tie

  // TBD 예상 후보: A슬롯/B슬롯 각각 직전 라운드 1경기씩 표시
  function getTbdCandidates(teamName: string | null, abSlot: 'A' | 'B'): string[] {
    if (teamName && teamName !== 'TBD') return []
    if (!allMatches || isTeam) return []
    const PREV: Record<string,string> = {
      '결승':'4강','4강':'8강','8강':'16강','16강':'32강','32강':'64강','64강':'128강',
      'F':'SF','SF':'QF','QF':'R16','R16':'R32','R32':'R64','R64':'R128'
    }
    const prevRound = PREV[m.round]
    if (!prevRound) return []

    // 직전 라운드 경기 slot 순 정렬
    const prevList = allMatches
      .filter(pm => pm.division_id === m.division_id && pm.round === prevRound)
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    if (prevList.length === 0) return []

    // 현재 라운드 내 로컬 인덱스
    const curList = allMatches
      .filter(pm => pm.division_id === m.division_id && pm.round === m.round)
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    const myLocalIdx = curList.findIndex(pm => pm.id === m.id)
    if (myLocalIdx < 0) return []

    // A슬롯 → prevList[myLocalIdx*2], B슬롯 → prevList[myLocalIdx*2+1]
    const pm = abSlot === 'A' ? prevList[myLocalIdx * 2] : prevList[myLocalIdx * 2 + 1]
    if (!pm) return []

    const strip = (raw: string) => raw.split('/').map((p: string) => p.replace(/\(.*?\)/g, '').trim()).join('/')
    if (pm.status === 'FINISHED' && pm.winner_team_id) {
      const winner = pm.winner_team_id === pm.team_a_id ? pm.team_a_name : pm.team_b_name
      return winner && winner !== 'TBD' ? [strip(winner)] : []
    }
    const names: string[] = []
    if (pm.team_a_name && pm.team_a_name !== 'TBD') names.push(strip(pm.team_a_name))
    if (pm.team_b_name && pm.team_b_name !== 'TBD') names.push(strip(pm.team_b_name))
    return names
  }
  return (
    <div draggable onDragStart={() => onDragStart(m.id)}
      className={`rounded-lg border p-2 text-xs lg:cursor-grab lg:active:cursor-grabbing transition-all ${
        isTeam
          ? (live?'bg-blue-50 border-blue-300':done?'bg-blue-50 border-blue-200':'bg-white border-blue-200 hover:border-blue-400')
          : live?'bg-red-50 border-red-200':done?'bg-tennis-50 border-tennis-200':isCurrentSlot?'bg-amber-50 border-amber-300':'bg-white border-stone-200 hover:border-stone-300'
      }`}>
      {/* 1줄: order + badge + 색점/단체 + 버튼들 */}
      <div className="flex items-center gap-1 min-w-0">
        {badge && <span className="text-[10px] flex-shrink-0">{badge}</span>}
        {isTeam
          ? <span className="text-[10px] bg-blue-600 text-white px-1 rounded flex-shrink-0">단체</span>
          : <span style={{ display:'inline-block',width:6,height:6,borderRadius:'50%',background:divColor||'#999',flexShrink:0 }} />
        }
        {isTeam && <span className="text-stone-400 text-[10px] flex-1 min-w-0 truncate">{m.match_num}</span>}
        {!isTeam && <span className="flex-1" />}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onMoveUp    && <button onClick={e=>{e.stopPropagation();onMoveUp()}}    className="text-stone-300 hover:text-stone-600 px-0.5">▲</button>}
          {onMoveDown  && <button onClick={e=>{e.stopPropagation();onMoveDown()}}  className="text-stone-300 hover:text-stone-600 px-0.5">▼</button>}
          {onClickStart && <button onClick={e=>{e.stopPropagation();onClickStart()}} className="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded hover:bg-red-600">▶</button>}
          {!isTeam && (
            <button onClick={e=>{e.stopPropagation();onClickScore()}}
              className={`px-1 py-0.5 rounded text-[10px] transition-colors ${done?'text-amber-500 hover:text-amber-700':'text-stone-300 hover:text-blue-500'}`}>
              {done?'재수정':'수정'}
            </button>
          )}
          {onClickUnassign && <button onClick={e=>{e.stopPropagation();onClickUnassign()}} className="text-stone-300 hover:text-red-400">✕</button>}
        </div>
      </div>
      {/* 2줄: 부서명(truncate) + 라운드뱃지(항상 보임) */}
      {(() => {
        const { round: rLabel } = getRoundBadge(m.round, m.group_label, m.division_name)
        return (
          <div className="flex items-center gap-1 mt-0.5 mb-1 min-w-0">
            <span className="text-[10px] text-stone-400 truncate flex-1 min-w-0">{m.division_name}</span>
            <span className={`text-[10px] font-bold flex-shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded ${
              rLabel === '예선' || rLabel.includes('조')
                ? 'bg-stone-100 text-stone-600'
                : 'bg-amber-100 text-amber-800'
            }`}>{rLabel}</span>
          </div>
        )
      })()}
      <div className={done ? 'opacity-50' : ''}>
        <MatchTeamRow raw={m.team_a_name} done={done} candidates={getTbdCandidates(m.team_a_name, 'A')} />
        <div className="text-stone-300 text-[10px] leading-none my-0.5">vs</div>
        <MatchTeamRow raw={m.team_b_name} done={done} candidates={getTbdCandidates(m.team_b_name, 'B')} />
      </div>
      {m.score && (
        <div className={`mt-0.5 font-bold ${isTeam?'text-blue-600':done?'text-stone-400':'text-tennis-600'}`}>{m.score}</div>
      )}
      {conflicts && conflicts.length > 0 && (
        <div className="mt-1 px-1.5 py-1 rounded bg-red-100 text-red-700 text-[10px] leading-snug">
          ⚠️ 선수 중복: {describeConflicts(conflicts)}
        </div>
      )}
    </div>
  )
}

// ── 선수명 표시: 이름 굵게(안잘림) + 클럽명 작게(ellipsis)
// candidates: TBD일 때 예상 후보 이름 목록
function MatchTeamRow({ raw, done, candidates }: { raw: string; done?: boolean; candidates?: string[] }) {
  const isTbd = !raw || raw === 'TBD'
  const players = parsePlayers(raw)

  // TBD — 후보 있으면 이름만 작게, 없으면 TBD 표시
  if (isTbd) {
    if (candidates && candidates.length > 0) {
      return (
        <div className="flex items-start gap-1 min-w-0 flex-wrap">
          {candidates.map((name, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-stone-200 text-[9px] self-center">/</span>}
              <span className="text-[10px] text-stone-400 leading-tight whitespace-nowrap">{name}</span>
            </React.Fragment>
          ))}
        </div>
      )
    }
    return <span className="text-[10px] text-stone-300 italic">TBD</span>
  }

  if (players.length === 0) {
    return <span className={`text-xs font-bold ${done ? 'text-stone-400' : 'text-stone-800'}`}>{raw || 'TBD'}</span>
  }
  return (
    <div className="flex items-start gap-1 min-w-0">
      {players.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-stone-300 text-[9px] flex-shrink-0 pt-px">/</span>}
          <div className="min-w-0 flex-1">
            <div className={`text-xs font-bold leading-tight whitespace-nowrap ${done ? 'text-stone-400' : 'text-stone-800'}`}>
              {p.name}
            </div>
            {p.club && (
              <div className="text-[9px] leading-tight truncate text-stone-400">{p.club}</div>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

// ── 미배정 컬럼: 모바일 접기 가능
function UnassignedColumn({ unassigned, divColors, touchOver, onDragOver, onDrop, onDragStart, onClickScore, onClickUnassign, onTouchStart, onTouchMove, onTouchEnd }: {
  unassigned: MatchSlim[]
  divColors: Record<string, string>
  touchOver: string | null
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  onDragStart: (id: string) => void
  onClickScore: (m: MatchSlim) => void
  onClickUnassign: (id: string) => void
  onTouchStart: (id: string) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: () => void
}) {
  const [open, setOpen] = React.useState(true)
  return (
    <div className="lg:col-span-1" data-unassigned onDragOver={onDragOver} onDrop={onDrop}>
      <div className={`bg-white rounded-xl border overflow-hidden transition-all ${touchOver === 'unassigned' ? 'ring-2 ring-stone-400' : ''}`}>
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full bg-stone-500 text-white px-4 py-2 font-bold text-sm flex items-center justify-between"
        >
          <span>미배정 ({unassigned.length})</span>
          <span className="text-white/60 text-xs lg:hidden">{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div className="p-1.5 space-y-1 max-h-[400px] lg:max-h-[700px] overflow-y-auto">
            {unassigned.map(m => (
              <MatchChip key={m.id} m={m} divColor={divColors[m.division_id]}
                onDragStart={onDragStart} onClickScore={() => onClickScore(m)}
                onClickUnassign={() => onClickUnassign(m.id)} />
            ))}
            {unassigned.length === 0 && <div className="text-xs text-stone-300 text-center py-6">없음</div>}
          </div>
        )}
      </div>
    </div>
  )
}

