'use client'
import { useState, useEffect, useMemo } from 'react'
import { tieGroupPlaceholders } from '@/lib/tournament'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchTies, fetchClubMembers, adminPinSubmitLineup } from '@/lib/team-api'
import { getTieStatusLabel, getTieStatusColor, formatSetScore, getMajority } from '@/lib/team-utils'
import type { TieWithClubs, TeamLineup, ClubMember } from '@/types/team'
import AdminBracketView from '@/components/AdminBracketView'
import CourtBoard from '@/components/CourtBoard'
import TeamStandingsPanel from '@/components/TeamStandingsPanel'
import LineupPendingBoard, { type LineupNotifyBody } from '@/components/LineupPendingBoard'
import LineupProxyForm from '@/components/LineupProxyForm'
import { normalizeAdminScore, isWalkoverScore } from '@/lib/score'

type Tab = 'individual' | 'team' | 'standings' | 'bracket' | 'courts' | 'pins' | 'locks'
interface VenueLite { id: string; name: string; short_name: string | null; court_count: number | null; courts: string[] | null }

interface PinTeam { id: string; team_num: string; team_name: string; division_name: string; pin_plain: string }
interface PinClub { id: string; name: string; division_name: string; captain_name: string | null; captain_pin: string | null }

interface PinLock {
  target_key: string
  fail_count: number
  locked_until: string | null
  updated_at: string
}

export default function AdminPinManagePage() {
  const router = useRouter()
  const [session, setSession] = useState<any>(null)
  const [tab, setTab] = useState<Tab>('individual')

  // ── 개인전 ──
  const [searchQuery, setSearchQuery] = useState('')
  const [allMatches, setAllMatches] = useState<any[]>([])
  const [selectedMatch, setSelectedMatch] = useState<any>(null)
  const [newScore, setNewScore] = useState('')
  const [newWinner, setNewWinner] = useState<'A' | 'B' | ''>('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  // ── 단체전 ──
  const [ties, setTies] = useState<TieWithClubs[]>([])
  // 3팀 조: 첫 대전 전엔 남은 두 대전을 (앞 경기 승자)/(앞 경기 패자) vs 3번 으로 표시 (036)
  const tiePh = useMemo(() => tieGroupPlaceholders(ties as any), [ties])
  const [tiesLoading, setTiesLoading] = useState(false)
  const [tieSearchQuery, setTieSearchQuery] = useState('')
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null)
  const [tieLineups, setTieLineups] = useState<TeamLineup[]>([])
  const [memberMap, setMemberMap] = useState<Record<string, ClubMember>>({})
  const [tieRubbers, setTieRubbers] = useState<any[]>([])

  // ── 단체전 부서 필터 ──
  const [divisions, setDivisions] = useState<{id: string; name: string; sort_order: number}[]>([])
  const [selectedDivId, setSelectedDivId] = useState<string>('')

  // ── 코트 번호 → 이름 매핑 (글로벌 인덱스 기준) ──
  const [courtNames, setCourtNames] = useState<string[]>([])
  const [venues, setVenues] = useState<VenueLite[]>([])
  const [openingVenue, setOpeningVenue] = useState('')

  // 단체전 점수 입력 state
  const [scoringRubber, setScoringRubber] = useState<string | null>(null)
  const [set1a, setSet1a] = useState('')
  const [set1b, setSet1b] = useState('')
  const [set2a, setSet2a] = useState('')
  const [set2b, setSet2b] = useState('')
  const [set3a, setSet3a] = useState('')
  const [set3b, setSet3b] = useState('')
  const [setsPerRubber, setSetsPerRubber] = useState(1)
  const [scoreError, setScoreError] = useState('')
  const [scoreSaving, setScoreSaving] = useState(false)
  const [tieMsg, setTieMsg] = useState('')
  // 오더 대리입력 (039)
  const [proxy, setProxy] = useState<{ tie: TieWithClubs; side: 'a' | 'b'; lineups: TeamLineup[] } | null>(null)
  const [boardKey, setBoardKey] = useState(0)

  // ── PIN 잠금 해제 ──
  const [pinLocks, setPinLocks] = useState<PinLock[]>([])
  const [pinLockLoading, setPinLockLoading] = useState(false)
  const [pinLockMsg, setPinLockMsg] = useState('')
  const [clubNameMap, setClubNameMap] = useState<Record<string, string>>({})

  // ── PIN 확인 (대시보드 팀관리/클럽관리 데이터) ──
  const [pinSearchQuery, setPinSearchQuery] = useState('')
  const [pinTeams, setPinTeams] = useState<PinTeam[]>([])
  const [pinClubs, setPinClubs] = useState<PinClub[]>([])
  const [pinDataLoading, setPinDataLoading] = useState(false)
  const [revealedPins, setRevealedPins] = useState<Set<string>>(new Set())

  useEffect(() => {
    // ✅ localStorage 우선, 호환성 위해 sessionStorage 폴백 후 localStorage로 이전
    const raw = localStorage.getItem('admin_pin_session') || sessionStorage.getItem('admin_pin_session')
    if (!raw) { router.push('/admin-pin'); return }
    const s = JSON.parse(raw)
    localStorage.setItem('admin_pin_session', raw)
    sessionStorage.removeItem('admin_pin_session')
    setSession(s)
    loadAllMatches(s.event_id)
    loadTiesData(s.event_id)
    loadPinLocks(s.event_id, s.token)
    loadPinData(s.event_id, s.token)
    loadVenues(s.event_id)

    // ✅ 개인전 경기·단체전 ties 30초마다 자동 갱신 + 로그인 만료 확인
    const iv = setInterval(async () => {
      loadAllMatches(s.event_id)
      loadTiesData(s.event_id)
      const { data } = await supabase.rpc('rpc_admin_pin_locks', { p_token: s.token })
      if ((data as any)?.success === false) checkExpired((data as any).error)
    }, 30000)
    return () => clearInterval(iv)
  }, [])

  // 마스터 PIN 로그인 만료(12시간 또는 PIN 변경) → 로그인 화면으로
  function checkExpired(message?: string | null): boolean {
    if (!message || !/만료/.test(message)) return false
    localStorage.removeItem('admin_pin_session')
    alert('마스터 PIN 로그인이 만료되었습니다. 다시 로그인해 주세요.')
    router.push('/admin-pin')
    return true
  }

  // ── 베뉴 로드 → 글로벌 코트 이름 배열 생성 (dashboard/courts와 동일 로직) ──
  async function loadVenues(eventId: string) {
    const { data } = await supabase.from('venues')
      .select('id, name, short_name, court_count, courts')
      .eq('event_id', eventId).order('created_at')
    setVenues((data || []) as VenueLite[])
    const names: string[] = (data || []).flatMap((v: any) => {
      const sn = (v.short_name?.trim() || v.name?.trim() || '코트')
      const count = v.court_count || v.courts?.length || 0
      return Array.from({ length: count }, (_, i) => `${sn}-${i + 1}`)
    })
    setCourtNames(names)
  }

  // tie의 court_number → 실제 코트 이름 변환
  function courtNumToName(n: number | null | undefined): string | null {
    if (!n) return null
    if (courtNames.length > 0 && n >= 1 && n <= courtNames.length) return courtNames[n - 1]
    return `코트-${n}`   // fallback
  }

  // ── PIN 확인용 데이터 로드 (팀관리 + 클럽관리) ──
  // FK 조인이 PostgREST 스키마 캐시에 없어서 divisions를 별도로 가져와 클라이언트 매핑
  async function loadPinData(eventId: string, token: string) {
    setPinDataLoading(true)
    try {
      const [teamsRes, clubsRes, divsRes] = await Promise.all([
        // 팀 PIN 은 외부 조회 불가 — 관리자 세션 토큰으로 서버에서 받아온다
        supabase.rpc('rpc_admin_pin_teams', { p_token: token }),
        // 주장 PIN 은 외부 조회 불가 — 관리자 세션 토큰으로 서버에서 받아온다
        supabase.rpc('rpc_admin_pin_clubs', { p_token: token }),
        supabase.from('divisions').select('id, name').eq('event_id', eventId),
      ])
      const divMap: Record<string, string> = {}
      for (const d of (divsRes.data || []) as any[]) divMap[d.id] = d.name

      setPinTeams((((teamsRes.data as any)?.teams) || []) as PinTeam[])
      setPinClubs((((clubsRes.data as any)?.clubs) || []).map((c: any) => ({
        id: c.id, name: c.name,
        division_name: c.division_id ? (divMap[c.division_id] || '') : '',
        captain_name: c.captain_name,
        captain_pin: c.captain_pin,
      })))
    } catch (e) {
      console.error('loadPinData 실패:', e)
    } finally { setPinDataLoading(false) }
  }

  function togglePinReveal(key: string) {
    setRevealedPins(prev => {
      const s = new Set(prev)
      if (s.has(key)) s.delete(key); else s.add(key)
      return s
    })
  }

  async function loadAllMatches(eventId: string) {
    const { data } = await supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId).order('slot')
    setAllMatches(data || [])
  }

  async function loadTiesData(eventId: string) {
    setTiesLoading(true)
    try {
      const [evRes, tieData, divsRes] = await Promise.all([
        supabase.from('events').select('team_sets_per_rubber').eq('id', eventId).single(),
        fetchTies(eventId),
        supabase.from('divisions').select('id, name, sort_order').eq('event_id', eventId).order('sort_order'),
      ])
      setSetsPerRubber(evRes.data?.team_sets_per_rubber || 1)
      setTies(tieData)
      const divList = divsRes.data || []
      setDivisions(divList)
      // 기본: 첫 부서 자동 선택 (부서 있으면)
      if (divList.length > 0) {
        setSelectedDivId(prev => prev || divList[0].id)
      }
    } catch {}
    setTiesLoading(false)
  }

  // ── PIN 잠금 목록 로드 (현재 잠긴 것만) ──
  async function loadPinLocks(eventId: string, token?: string) {
    setPinLockLoading(true)
    try {
      // pin_attempts 는 외부 접근 불가(025b) — 관리자 세션 토큰으로 이 대회 잠금만 조회
      const { data: lockRes } = await supabase.rpc('rpc_admin_pin_locks', { p_token: token ?? session?.token })
      const data = ((lockRes as any)?.locks || []) as PinLock[]
      setPinLocks(data)

      // club: 패턴에서 club_id 추출 → clubs 테이블에서 이름 조회 (현 이벤트 클럽만)
      const clubIds = (data || [])
        .map(r => (r.target_key.startsWith('club:') ? r.target_key.slice(5) : null))
        .filter(Boolean) as string[]
      if (clubIds.length > 0) {
        const { data: clubs } = await supabase
          .from('clubs').select('id, name').in('id', clubIds).eq('event_id', eventId)
        const map: Record<string, string> = {}
        for (const c of clubs || []) map[c.id] = c.name
        setClubNameMap(map)
      } else {
        setClubNameMap({})
      }
    } catch {}
    setPinLockLoading(false)
  }

  async function handleUnlockPin(targetKey: string) {
    setPinLockMsg('')
    const { data: ur, error } = await supabase.rpc('rpc_admin_pin_unlock', { p_token: session?.token, p_keys: [targetKey] })
    if (error || (ur as any)?.success === false) { setPinLockMsg('❌ ' + (error?.message || (ur as any)?.error)); return }
    setPinLockMsg('✅ 잠금 해제됨')
    setTimeout(() => setPinLockMsg(''), 3000)
    if (session) loadPinLocks(session.event_id)
  }

  async function handleUnlockAll() {
    if (!confirm('현재 걸린 모든 PIN 잠금을 해제하시겠습니까?')) return
    setPinLockMsg('')
    const keys = pinLocks.map(l => l.target_key)
    if (keys.length === 0) return
    const { data: ur, error } = await supabase.rpc('rpc_admin_pin_unlock', { p_token: session?.token, p_keys: keys })
    if (error || (ur as any)?.success === false) { setPinLockMsg('❌ ' + (error?.message || (ur as any)?.error)); return }
    setPinLockMsg(`✅ ${keys.length}건 일괄 해제`)
    setTimeout(() => setPinLockMsg(''), 3000)
    if (session) loadPinLocks(session.event_id)
  }

  function describePinLock(targetKey: string): string {
    if (targetKey.startsWith('club:')) {
      const clubId = targetKey.slice(5)
      return `🏅 클럽 캡틴 PIN · ${clubNameMap[clubId] || clubId.slice(0, 8)}`
    }
    if (targetKey.startsWith('rubber:')) {
      return `🎾 러버 PIN · ${targetKey.slice(7, 15)}…`
    }
    if (targetKey.startsWith('login:')) {
      return `🔑 팀 PIN 로그인 시도`
    }
    return targetKey
  }

  // 개인전 필터
  const filtered = allMatches.filter(m => {
    if (!searchQuery) return false
    const q = searchQuery.toLowerCase()
    return (m.match_num||'').toLowerCase().includes(q)
      || (m.team_a_name||'').toLowerCase().includes(q)
      || (m.team_b_name||'').toLowerCase().includes(q)
      || (m.division_name||'').toLowerCase().includes(q)
      || (m.round||'').toLowerCase().includes(q)
  })

  // 단체전 필터 — 부서 먼저, 그 안에서 검색(선택)
  const filteredTies = ties.filter(tie => {
    // 1. 부서 필터 (선택된 부서가 있으면 해당 부서만, 없으면 전체)
    if (selectedDivId) {
      const tDiv = (tie as any).division_id as string | null | undefined
      if (tDiv !== selectedDivId) return false
    }
    // 2. 검색어가 있으면 추가 필터 (없으면 부서 전체 표시)
    if (!tieSearchQuery) return true
    const q = tieSearchQuery.toLowerCase()
    return (tie.club_a?.name||'').toLowerCase().includes(q)
      || (tie.club_b?.name||'').toLowerCase().includes(q)
      || (tie.tie_order?.toString()||'').includes(q)
      || (tie.round||'').toLowerCase().includes(q)
  })

  // 라운드별 그룹핑 — 조별/16강/8강/4강/결승 순
  const ROUND_ORDER: Record<string, number> = {
    'group': 0, 'full_league': 0,
    'round_of_32': 1, 'round_of_16': 2,
    'quarter': 3, 'semi': 4, 'final': 5,
  }
  const ROUND_LABEL: Record<string, string> = {
    'group': '조별리그', 'full_league': '풀리그',
    'round_of_32': '32강', 'round_of_16': '16강',
    'quarter': '8강', 'semi': '4강', 'final': '결승',
  }
  const groupedTies = (() => {
    const map: Record<string, TieWithClubs[]> = {}
    for (const t of filteredTies) {
      const r = t.round || 'etc'
      if (!map[r]) map[r] = []
      map[r].push(t)
    }
    // 라운드 순서대로 정렬
    return Object.entries(map).sort((a, b) =>
      (ROUND_ORDER[a[0]] ?? 99) - (ROUND_ORDER[b[0]] ?? 99)
    )
  })()

  async function selectMatch(m: any) {
    setSelectedMatch(m)
    setNewScore(m.score || '')
    setNewWinner(m.winner_team_id===m.team_a_id?'A':m.winner_team_id===m.team_b_id?'B':'')
    setReason('')
    setMsg('')
  }

  async function handleUnlock() {
    if (!session || !selectedMatch) return
    setLoading(true); setMsg('')
    const { error } = await supabase.rpc('rpc_admin_pin_unlock_match', {
      p_token: session.token, p_match_id: selectedMatch.id, p_reason: reason||'관리자 해제'
    })
    setLoading(false)
    if (error) { setMsg('❌ '+error.message); return }
    setMsg('✅ 잠금이 해제되었습니다.')
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  // ✅ 조별 경기 수정 후 본선 TBD 슬롯 자동 채우기
  async function tryFillTournamentSlotsAdmin(matchId: string, eventId: string) {
    // 해당 경기 정보 조회
    const { data: matchData } = await supabase
      .from('matches')
      .select('group_id, division_id, stage')
      .eq('id', matchId)
      .single()

    if (!matchData) return
    // GROUP 경기가 아니면 skip (대소문자 무관)
    const stageUp = (matchData.stage || '').toUpperCase()
    if (stageUp !== 'GROUP') return
    if (!matchData.group_id) return

    // 해당 그룹의 미완료 경기 수 확인 (대소문자 무관 전체조회 후 클라이언트 필터)
    const { data: groupMatches } = await supabase
      .from('matches')
      .select('id, status, score, stage')
      .eq('event_id', eventId)
      .eq('group_id', matchData.group_id)

    const groupOnly = (groupMatches || []).filter(m => (m.stage||'').toUpperCase() === 'GROUP')
    // BYE 경기는 status가 FINISHED가 아닐 수 있으므로 제외
    const unfinished = groupOnly.filter(m => m.status !== 'FINISHED' && m.score !== 'BYE')
    if (unfinished.length > 0) return // 아직 남은 경기 있음

    // 본선 브래킷에 TBD 슬롯이 있는지 확인
    const { data: finalsData } = await supabase
      .from('matches')
      .select('id, qualifier_label_a, qualifier_label_b')
      .eq('event_id', eventId)
      .eq('division_id', matchData.division_id)
      .eq('stage', 'FINALS')

    const hasTbd = (finalsData || []).some(
      m => m.qualifier_label_a != null || m.qualifier_label_b != null
    )
    if (!hasTbd) return

    console.log('[AdminPIN] 조 완료 → rpc_fill_tournament_slots:', matchData.group_id)
    const { data: fillResult, error: fillError } = await supabase.rpc('rpc_admin_pin_fill_slots', {
      p_token: session.token,
      p_group_id: matchData.group_id,
    })
    if (fillError) {
      console.warn('[AdminPIN] fill_tournament_slots 오류:', fillError.message)
      return
    }
    if (fillResult?.success && fillResult.filled > 0) {
      console.log('[AdminPIN] 슬롯 채우기 완료:', fillResult)
    }
  }

  // 결과 저장 뒤 알림: 처음 끝난 경기면 다음 대기팀 '경기 준비', 이미 끝난 경기 수정이면 본선 빈자리 알림만 확인
  function notifyAfterScore(m: { id: string; status: string; court: string | null }) {
    if (!session) return
    const first = m.status !== 'FINISHED' && !!m.court
    fetch('/api/notify/court', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(first
        ? { event_id: session.event_id, admin_pin_token: session.token, court: m.court, finished_match_id: m.id, trigger: 'finished' }
        : { event_id: session.event_id, admin_pin_token: session.token, trigger: 'slot_check' }),
    }).catch(() => {})
  }

  async function handleUpdateScore() {
    if (!session||!selectedMatch||!newScore||!newWinner) { setMsg('점수와 승자를 모두 입력해주세요.'); return }
    const norm = normalizeAdminScore(newScore)
    if ('error' in norm) { setMsg('❌ ' + norm.error); return }
    const score = norm.score
    const winnerName = newWinner==='A' ? selectedMatch.team_a_name : selectedMatch.team_b_name
    // 목록은 30초마다 갱신 → 그 사이 선수·현장관리가 입력했을 수 있음. 저장 직전에 다시 읽음
    const { data: fresh } = await supabase.from('v_matches_with_teams').select('*').eq('id', selectedMatch.id).single()
    const changed = !!fresh && (fresh.status !== selectedMatch.status || (fresh.score || '') !== (selectedMatch.score || '')
      || fresh.winner_team_id !== selectedMatch.winner_team_id)
    const warn = changed
      ? `⚠️ 화면을 연 뒤 이 경기 결과가 바뀌었습니다.\n지금: ${fresh.score || '점수 없음'}${fresh.winner_name ? ' (승: ' + fresh.winner_name + ')' : ''}\n\n그래도 아래로 바꿀까요?\n`
      : ''
    if (!confirm(`${warn}승자: ${winnerName}\n점수: ${score}\n\n이대로 저장할까요?`)) {
      if (changed) { setSelectedMatch(fresh); loadAllMatches(session.event_id) }
      return
    }
    const base = fresh || selectedMatch   // 알림 판단은 최신 상태 기준 (중복 '경기 준비' 알림 방지)
    setNewScore(score)
    setLoading(true); setMsg('')
    const winnerId = newWinner==='A' ? selectedMatch.team_a_id : selectedMatch.team_b_id
    const { error } = await supabase.rpc('rpc_admin_pin_update_score', {
      p_token: session.token, p_match_id: selectedMatch.id, p_score: score, p_winner_team_id: winnerId
    })
    if (error) {
      if (checkExpired(error.message)) return
      // ✅ 다음 라운드가 이미 완료돼 정상 수정이 막힌 경우 → 강제 수정 옵션 제공
      //    (대시보드 코트배정 강제수정과 동일 동작)
      const blocked = /다음 라운드|완료되어/.test(error.message || '')
      if (blocked && confirm(
        '⚠️ 다음 라운드 경기가 이미 완료되어 정상 수정이 막혔습니다.\n\n' +
        '강제로 수정하시겠습니까?\n' +
        '· 이 경기 결과가 덮어써지고 승자가 다음 라운드로 다시 진출합니다.\n' +
        '· 이미 진행된 다음 라운드 결과는 그대로 남으니, 필요하면 뒤 라운드부터 직접 확인·수정하세요.'
      )) {
        // matches 직접 수정 불가(025b) — 관리자 세션 토큰으로 서버에서 강제 수정 + 본선 승자 재진출
        const { data: fr, error: ue } = await supabase.rpc('rpc_admin_pin_force_score', {
          p_token: session.token, p_match_id: selectedMatch.id, p_score: score, p_winner_team_id: winnerId,
        })
        if (ue || (fr as any)?.success === false) { setLoading(false); setMsg('❌ ' + (ue?.message || (fr as any)?.error)); return }
        await tryFillTournamentSlotsAdmin(selectedMatch.id, session.event_id)
        notifyAfterScore(base)
        setLoading(false)
        setMsg('✅ 강제 수정됨 (운영자 모드)')
        loadAllMatches(session.event_id); setSelectedMatch(null)
        return
      }
      setLoading(false); setMsg('❌ '+error.message); return
    }

    // ✅ 조별 경기인 경우 본선 TBD 슬롯 자동 채우기
    await tryFillTournamentSlotsAdmin(selectedMatch.id, session.event_id)
    notifyAfterScore(base)

    setLoading(false)
    setMsg('✅ 결과가 수정되었습니다.')
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  // 팀 중도 기권: 이 팀의 남은 경기(상대가 정해진 것) 전부 w.o, 상대 승
  async function handleWithdrawTeam(side: 'A' | 'B') {
    if (!session || !selectedMatch) return
    const teamId = side === 'A' ? selectedMatch.team_a_id : selectedMatch.team_b_id
    const teamName = side === 'A' ? selectedMatch.team_a_name : selectedMatch.team_b_name
    if (!teamId) return
    // 저장 직전 최신 목록 (그 사이 끝난 경기를 w.o 로 덮어쓰지 않게)
    const { data: teamMatches } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', session.event_id).or(`team_a_id.eq.${teamId},team_b_id.eq.${teamId}`)
    const targets = (teamMatches || [])
      .filter(m => m.status !== 'FINISHED' && m.team_a_id && m.team_b_id && (m.team_a_id === teamId || m.team_b_id === teamId))
      .sort((a, b) => (a.stage === 'GROUP' ? 0 : 1) - (b.stage === 'GROUP' ? 0 : 1) || (a.slot ?? 0) - (b.slot ?? 0))
    if (targets.length === 0) { setMsg('❌ ' + teamName + ' 팀의 남은 경기가 없습니다.'); return }
    if (!confirm(
      `🚫 ${teamName} 대회 중도 기권\n\n남은 ${targets.length}경기를 모두 w.o (상대 승)로 처리합니다.\n` +
      '되돌리려면 경기마다 결과를 다시 고쳐야 합니다.\n\n계속할까요?'
    )) return
    setLoading(true); setMsg('')
    let done = 0
    const fails: string[] = []
    for (const m of targets) {
      const winnerId = m.team_a_id === teamId ? m.team_b_id : m.team_a_id
      const { error } = await supabase.rpc('rpc_admin_pin_update_score', {
        p_token: session.token, p_match_id: m.id, p_score: 'w.o', p_winner_team_id: winnerId,
      })
      if (error) {
        if (checkExpired(error.message)) return
        fails.push(`${m.match_num || ''} ${error.message}`); continue
      }
      done++
      await tryFillTournamentSlotsAdmin(m.id, session.event_id)
      notifyAfterScore(m)
    }
    setLoading(false)
    setMsg(fails.length
      ? `❌ ${done}경기 w.o 처리, ${fails.length}경기 실패: ${fails.join(' / ')}`
      : `✅ ${teamName} 기권 — ${done}경기 w.o 처리됨`)
    loadAllMatches(session.event_id); setSelectedMatch(null)
  }

  // 단체전 클럽 불참: 남은 복식 전부 w.o, 상대 클럽 승
  async function handleTieWalkover(absent: 'A' | 'B') {
    if (!session || !selectedTie) return
    const absentName = absent === 'A' ? selectedTie.club_a?.name : selectedTie.club_b?.name
    const winnerId = absent === 'A' ? selectedTie.club_b_id : selectedTie.club_a_id
    const winnerName = absent === 'A' ? selectedTie.club_b?.name : selectedTie.club_a?.name
    if (!confirm(`🚫 ${absentName} 불참\n\n남은 복식을 모두 w.o 로 처리하고 ${winnerName} 승으로 기록합니다.\n계속할까요?`)) return
    setScoreSaving(true); setTieMsg('')
    try {
      const { data, error } = await supabase.rpc('rpc_admin_pin_tie_walkover', {
        p_token: session.token, p_tie_id: selectedTie.id, p_winner_club_id: winnerId,
      })
      if (error) { if (!checkExpired(error.message)) setTieMsg('❌ ' + error.message); return }
      if ((data as any)?.success === false) { if (!checkExpired((data as any).error)) setTieMsg('❌ ' + (data as any).error); return }
      const [rubberData, tieData] = await Promise.all([
        supabase.from('tie_rubbers').select('*').eq('tie_id', selectedTie.id).order('rubber_number'),
        supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)').eq('id', selectedTie.id).single(),
      ])
      setTieRubbers(rubberData.data || [])
      if (tieData.data) {
        setSelectedTie(tieData.data as any)
        setTies(prev => prev.map(t => t.id === selectedTie.id ? tieData.data as any : t))
      }
      setTieMsg(`✅ ${absentName} 불참 — 복식 ${(data as any)?.rubbers ?? ''}개 w.o 처리`)
    } finally {
      setScoreSaving(false)
    }
  }

  // 마스터 PIN 으로 경기장 코트 관리 화면 열기 (코트 배정·이동·자동 배정)
  async function openVenueManage(v: VenueLite) {
    if (!session) return
    setOpeningVenue(v.id)
    try {
      const { data, error } = await supabase.rpc('rpc_admin_pin_open_venue', { p_token: session.token, p_venue_id: v.id })
      if (error) { if (!checkExpired(error.message)) alert('❌ ' + error.message); return }
      if ((data as any)?.success === false) { if (!checkExpired((data as any).error)) alert('❌ ' + (data as any).error); return }
      sessionStorage.setItem('venue_session', JSON.stringify({ ...(data as any), admin_token: session.token }))
      router.push('/venue/manage')
    } finally {
      setOpeningVenue('')
    }
  }

  async function handleSelectTie(tie: TieWithClubs) {
    if (selectedTie?.id === tie.id) { setSelectedTie(null); setScoringRubber(null); return }
    setSelectedTie(tie); setScoringRubber(null); setTieMsg('')
    const [lineupData, rubberData] = await Promise.all([
      // 공개 전 라인업은 외부 조회 불가 — 관리자 세션 토큰으로
      supabase.rpc('rpc_admin_pin_tie_lineups', { p_token: session.token, p_tie_id: tie.id }),
      supabase.from('tie_rubbers').select('*').eq('tie_id', tie.id).order('rubber_number'),
    ])
    setTieLineups((((lineupData.data as any)?.lineups) || []) as TeamLineup[])
    setTieRubbers(rubberData.data || [])
    const mm: Record<string, ClubMember> = {}
    if (tie.club_a_id) { (await fetchClubMembers(tie.club_a_id)).forEach(m => { mm[m.id]=m }) }
    if (tie.club_b_id) { (await fetchClubMembers(tie.club_b_id)).forEach(m => { mm[m.id]=m }) }
    setMemberMap(mm)
  }

  // 오더 대리입력 열기 — 공개 전 라인업은 관리자 세션 토큰으로 조회
  async function openProxy(tie: TieWithClubs, side: 'a' | 'b') {
    const { data, error } = await supabase.rpc('rpc_admin_pin_tie_lineups', { p_token: session.token, p_tie_id: tie.id })
    if (error) { if (!checkExpired(error.message)) setTieMsg('❌ ' + error.message); return }
    if ((data as any)?.success === false) { if (!checkExpired((data as any).error)) setTieMsg('❌ ' + (data as any).error); return }
    setProxy({ tie, side, lineups: ((data as any)?.lineups || []) as TeamLineup[] })
  }

  async function handleProxyDone(revealed: boolean) {
    if (!proxy) return
    const name = proxy.side === 'a' ? proxy.tie.club_a?.name : proxy.tie.club_b?.name
    setProxy(null); setSelectedTie(null); setScoringRubber(null)
    await loadTiesData(session.event_id)
    setBoardKey(k => k + 1)
    setTieMsg(`✅ ${name} 오더 대리입력 완료` + (revealed ? ' — 양 팀 오더 공개됨' : ''))
  }

  // 주장 오더 알림 — 관리자 PIN 세션 토큰으로 호출
  async function notifyLineup(body: LineupNotifyBody) {
    const res = await fetch('/api/notify/lineup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: session.event_id, admin_pin_token: session.token, ...body }),
    })
    return res.json()
  }

  function startScoring(rubber: any) {
    setScoringRubber(rubber.id); setScoreError('')
    setSet1a(rubber.set1_a?.toString()||''); setSet1b(rubber.set1_b?.toString()||'')
    setSet2a(rubber.set2_a?.toString()||''); setSet2b(rubber.set2_b?.toString()||'')
    setSet3a(rubber.set3_a?.toString()||''); setSet3b(rubber.set3_b?.toString()||'')
  }

  async function handleTieScoreSave() {
    // ✅ 1세트 체크
    if (!set1a || !set1b) { setScoreError('1세트 점수를 입력하세요.'); return }
    const s1a = parseInt(set1a), s1b = parseInt(set1b)
    if (s1a === s1b) { setScoreError('1세트는 동점일 수 없습니다.'); return }

    // ✅ 3세트 방식 전체 검증
    if (setsPerRubber === 3) {
      if (!set2a || !set2b) { setScoreError('2세트 점수를 입력하세요.'); return }
      const s2a = parseInt(set2a), s2b = parseInt(set2b)
      if (s2a === s2b) { setScoreError('2세트는 동점일 수 없습니다.'); return }
      const s1WinA = s1a > s1b, s2WinA = s2a > s2b
      const needSet3 = s1WinA !== s2WinA
      if (needSet3 && (!set3a || !set3b)) {
        setScoreError('1-2세트 스플릿 — 3세트 점수를 입력하세요.'); return
      }
      if (set3a && set3b && parseInt(set3a) === parseInt(set3b)) {
        setScoreError('3세트는 동점일 수 없습니다.'); return
      }
    }

    // 이미 입력된 러버면 정정 (조별: 순위·본선 재배정 / 토너먼트: 다음 라운드 시작 전까지만)
    const rubber = tieRubbers.find((r: any) => r.id === scoringRubber)
    // 주장·현장관리가 그 사이 입력했을 수 있음 → 저장 직전에 다시 읽음
    const { data: freshRubber } = await supabase.from('tie_rubbers').select('*').eq('id', scoringRubber).single()
    if (freshRubber && freshRubber.status === 'completed' && rubber?.status !== 'completed') {
      const now = freshRubber.is_walkover ? 'w.o' : [formatSetScore(freshRubber.set1_a, freshRubber.set1_b),
        freshRubber.set2_a !== null ? formatSetScore(freshRubber.set2_a, freshRubber.set2_b) : '',
        freshRubber.set3_a !== null ? formatSetScore(freshRubber.set3_a, freshRubber.set3_b) : ''].filter(Boolean).join(' / ')
      if (!confirm(`⚠️ 화면을 연 뒤 이 복식 점수가 입력되었습니다.\n지금: ${now}\n\n그래도 입력한 점수로 정정할까요?`)) {
        setTieRubbers(prev => prev.map((r: any) => r.id === freshRubber.id ? freshRubber : r))
        setScoringRubber(null)
        return
      }
    }
    const isCorrection = (freshRubber?.status ?? rubber?.status) === 'completed'
    if (isCorrection && rubber?.status === 'completed') {
      const msg = '이미 입력된 점수를 정정합니다.\n' +
        '대전 결과·순위·본선 자리가 다시 계산됩니다.\n' +
        '계속하시겠습니까?'
      if (!confirm(msg)) return
    }

    setScoreSaving(true); setScoreError('')
    try {
      // 관리자 세션 토큰으로 입력/정정 (완료된 러버면 서버에서 정정 처리)
      const { data, error: err } = await supabase.rpc('rpc_admin_pin_rubber_score', {
        p_token: session.token,
        p_rubber_id: scoringRubber,
        p_set1_a: parseInt(set1a), p_set1_b: parseInt(set1b),
        p_set2_a: set2a ? parseInt(set2a) : null, p_set2_b: set2b ? parseInt(set2b) : null,
        p_set3_a: set3a ? parseInt(set3a) : null, p_set3_b: set3b ? parseInt(set3b) : null,
      })
      if (err) { if (!checkExpired(err.message)) setScoreError(err.message); return }
      if (data && !data.success) { if (!checkExpired(data.error)) setScoreError(data.error || '저장 실패'); return }
      if (data?.reseat?.success === false && data.reseat.reseat_skipped) alert('⚠️ ' + data.reseat.error)

      const [rubberData, tieData] = await Promise.all([
        supabase.from('tie_rubbers').select('*').eq('tie_id', selectedTie!.id).order('rubber_number'),
        supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)').eq('id', selectedTie!.id).single(),
      ])
      setTieRubbers(rubberData.data || [])
      if (tieData.data) {
        setSelectedTie(tieData.data as any)
        setTies(prev => prev.map(t => t.id === selectedTie!.id ? tieData.data as any : t))
      }
      setScoringRubber(null)
      setTieMsg('✅ 점수 저장됨')
      setTimeout(() => setTieMsg(''), 3000)
    } catch (err: any) {
      setScoreError(err.message || '저장 실패')
    } finally {
      setScoreSaving(false)
    }
  }

  function getMemberName(id: string|null|undefined): string {
    return id && memberMap[id] ? memberMap[id].name : '-'
  }

  function handleLogout() {
    localStorage.removeItem('admin_pin_session')
    sessionStorage.removeItem('admin_pin_session')
    router.push('/admin-pin')
  }

  if (!session) return null

  return (
    <div className="min-h-screen">
      <header className="bg-red-700 text-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold">🛡️ 관리자 도구</h1>
            <p className="text-xs text-white/60">{session.event_name} · 12시간 로그인</p>
          </div>
          <button onClick={handleLogout} className="text-sm text-white/60 hover:text-white">로그아웃</button>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 pt-4">
        <div className="grid grid-cols-4 gap-1.5 mb-4 [&>button]:px-1 [&>button]:text-xs sm:[&>button]:text-sm">
          <button onClick={() => { setTab('individual'); setSelectedMatch(null); setMsg('') }}
            className={`py-2.5 rounded-lg text-sm font-medium transition ${tab==='individual'?'bg-red-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🎾 개인전
          </button>
          <button onClick={() => { setTab('team'); setSelectedTie(null); setScoringRubber(null); setTieMsg('') }}
            className={`py-2.5 rounded-lg text-sm font-medium transition ${tab==='team'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            📋 단체전
          </button>
          {ties.length > 0 && (
            <button onClick={() => setTab('standings')}
              className={`py-2.5 rounded-lg text-sm font-medium transition ${tab==='standings'?'bg-yellow-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              📊 순위
            </button>
          )}
          <button onClick={() => setTab('bracket')}
            className={`py-2.5 rounded-lg text-sm font-medium transition ${tab==='bracket'?'bg-emerald-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🏆 대진표
          </button>
          <button onClick={() => setTab('courts')}
            className={`py-2.5 rounded-lg text-sm font-medium transition ${tab==='courts'?'bg-teal-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🏟 코트
          </button>
          <button onClick={() => { setTab('pins'); setRevealedPins(new Set()); setPinSearchQuery('') }}
            className={`py-2.5 rounded-lg text-sm font-medium transition ${tab==='pins'?'bg-purple-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🔑 PIN 확인
          </button>
          <button onClick={() => { setTab('locks'); if (session) loadPinLocks(session.event_id) }}
            className={`py-2.5 rounded-lg text-sm font-medium transition relative ${tab==='locks'?'bg-amber-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🔒 PIN 잠금
            {pinLocks.length > 0 && (
              <span className="ml-1 text-xs bg-red-500 text-white rounded-full px-1.5">{pinLocks.length}</span>
            )}
          </button>
        </div>
      </div>

      <main className="max-w-2xl mx-auto px-4 pb-8 space-y-3">

        {/* ══════ 대진표 (보기 전용) ══════ */}
        {tab === 'bracket' && <AdminBracketView eventId={session.event_id} />}

        {/* ══════ 단체전 순위 + 동률 결정 ══════ */}
        {tab === 'standings' && (
          <>
            {divisions.length > 1 && (
              <div className="flex gap-1 overflow-x-auto pb-1">
                {divisions.map(d => (
                  <button key={d.id} onClick={() => setSelectedDivId(d.id)}
                    className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap ${selectedDivId === d.id ? 'bg-yellow-600 text-white shadow' : 'bg-gray-100 text-gray-600'}`}>
                    {d.name}
                  </button>
                ))}
              </div>
            )}
            <TeamStandingsPanel eventId={session.event_id} selectedDiv={divisions.length > 0 ? selectedDivId : ''} adminToken={session.token} />
          </>
        )}

        {/* ══════ 코트: 경기장별 코트 관리 열기 + 현황 ══════ */}
        {tab === 'courts' && (
          <>
            {venues.length > 0 && (
              <div className="bg-teal-50 border border-teal-200 rounded-xl p-3">
                <p className="text-sm font-bold text-teal-800 mb-2">🛠 코트 배정·변경</p>
                <div className="grid grid-cols-2 gap-2">
                  {venues.map(v => (
                    <button key={v.id} onClick={() => openVenueManage(v)} disabled={!!openingVenue}
                      className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg py-2.5 px-2 text-sm font-bold">
                      {openingVenue === v.id ? '여는 중...' : `${v.short_name?.trim() || v.name} 코트 관리`}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-teal-700 mt-2">경기장마다 그 경기장 코트끼리만 옮길 수 있습니다. 경기장 사이 이동은 운영자 대시보드에서 하세요.</p>
              </div>
            )}
            <CourtBoard eventId={session.event_id} />
          </>
        )}

        {/* ══════ 개인전 ══════ */}
        {tab === 'individual' && (
          <>
            {msg && (
              <div className={`p-3 rounded-lg text-sm ${msg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {msg}
              </div>
            )}
            <div className="relative">
              <input type="text" placeholder="팀명, 경기번호, 부서명 검색..."
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSelectedMatch(null); setMsg('') }}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-red-500 outline-none"
                autoFocus
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setSelectedMatch(null) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
              )}
            </div>

            {!searchQuery && !selectedMatch && (() => {
              const byCourtName = (a: any, b: any) => (a.court || '').localeCompare(b.court || '', undefined, { numeric: true })
              const live = allMatches.filter(m => m.status === 'IN_PROGRESS').sort(byCourtName)
              // 코트마다 다음 대기 경기 하나 (진행 중 경기가 없는 코트 포함)
              const next: any[] = []
              const seen = new Set<string>()
              for (const m of allMatches.filter(x => x.status === 'PENDING' && x.court && x.team_a_id && x.team_b_id)
                .sort((a, b) => byCourtName(a, b) || (a.court_order ?? 0) - (b.court_order ?? 0))) {
                if (seen.has(m.court)) continue
                seen.add(m.court); next.push(m)
              }
              const card = (m: any, tag: string, tagStyle: string) => (
                <div key={m.id} onClick={() => selectMatch(m)}
                  className="bg-white rounded-xl border p-3 cursor-pointer hover:border-gray-300">
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-xs font-bold text-teal-700">📍 {m.court || '코트 미정'}</span>
                    <span className="text-xs text-gray-400 truncate">{m.division_name} · {m.round}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${tagStyle}`}>{tag}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{m.team_a_name || 'TBD'}</span>
                    <span className="text-gray-400 font-bold mx-2">{m.score || 'vs'}</span>
                    <span className="font-medium text-right">{m.team_b_name || 'TBD'}</span>
                  </div>
                </div>
              )
              return (
                <div className="space-y-4">
                  <p className="text-xs text-gray-400 text-center">🔍 팀명·경기번호로 검색하거나 아래 경기를 누르세요 · 30초마다 새로고침</p>
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold text-gray-500 px-1">🔴 진행 중 ({live.length})</h3>
                    {live.length === 0 && <p className="text-sm text-gray-400 px-1">진행 중인 경기가 없습니다.</p>}
                    {live.map(m => card(m, '진행중', 'bg-red-100 text-red-700'))}
                  </div>
                  {next.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-bold text-gray-500 px-1">⏭ 코트별 다음 경기 ({next.length})</h3>
                      {next.map(m => card(m, '다음', 'bg-amber-100 text-amber-700'))}
                    </div>
                  )}
                </div>
              )
            })()}
            {searchQuery && filtered.length === 0 && (
              <div className="text-center py-8 text-gray-400">검색 결과가 없습니다.</div>
            )}

            {filtered.map(m => (
              <div key={m.id} onClick={() => selectMatch(m)}
                className={`bg-white rounded-xl border p-4 cursor-pointer transition ${selectedMatch?.id===m.id?'border-red-400 bg-red-50':'hover:border-gray-300'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">{m.match_num} · {m.division_name} · {m.round}</span>
                  <div className="flex items-center gap-2">
                    {m.locked_by_participant && <span className="text-xs text-red-500">🔒</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${m.status==='FINISHED'?'bg-green-100 text-green-700':m.status==='IN_PROGRESS'?'bg-red-100 text-red-700':'bg-gray-100 text-gray-500'}`}>
                      {m.status==='FINISHED'?'완료':m.status==='IN_PROGRESS'?'진행중':'대기'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.team_a_name}</span>
                  <span className="text-gray-400 font-bold mx-2">{m.score || 'vs'}</span>
                  <span className="font-medium">{m.team_b_name}</span>
                </div>
              </div>
            ))}

            {selectedMatch && (
              <div className="bg-white rounded-xl border-2 border-red-300 p-5">
                <h3 className="font-bold text-lg mb-1">경기 수정</h3>
                <div className="text-xs text-stone-400 mb-4">{selectedMatch.match_num} · {selectedMatch.division_name} · {selectedMatch.round}</div>
                <div className="flex items-center justify-center gap-4 my-4">
                  <div className="text-center flex-1"><div className="font-bold">{selectedMatch.team_a_name||'TBD'}</div><span className="text-xs text-stone-400">팀 A</span></div>
                  <span className="text-2xl text-stone-300 font-bold">VS</span>
                  <div className="text-center flex-1"><div className="font-bold">{selectedMatch.team_b_name||'TBD'}</div><span className="text-xs text-stone-400">팀 B</span></div>
                </div>
                {selectedMatch.score && (
                  <div className="text-center mb-4 text-sm">현재: <strong>{selectedMatch.score}</strong>
                    {selectedMatch.winner_name && <span> → 승: {selectedMatch.winner_name}</span>}
                    {selectedMatch.locked_by_participant && <span className="ml-2 text-red-500">🔒 참가자잠금</span>}
                  </div>
                )}
                <hr className="my-4" />
                {selectedMatch.locked_by_participant && (
                  <div className="mb-4 p-3 bg-amber-50 rounded-lg">
                    <p className="text-sm font-bold text-amber-700 mb-2">🔓 잠금 해제</p>
                    <input type="text" placeholder="해제 사유 (선택)" value={reason} onChange={e => setReason(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mb-2" />
                    <button onClick={handleUnlock} disabled={loading} className="w-full bg-amber-500 text-white py-2 rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50">
                      {loading?'처리 중...':'잠금 해제 + 결과 초기화'}
                    </button>
                  </div>
                )}
                <div className="p-3 bg-stone-50 rounded-lg">
                  <p className="text-sm font-bold mb-3">✏️ 결과 수정</p>
                  <div className="mb-3">
                    <label className="text-xs text-stone-500">점수</label>
                    <input type="text" placeholder="6:4" value={newScore} onChange={e => setNewScore(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-center text-lg font-bold mt-1" />
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => setNewScore('w.o')}
                        className="flex-1 py-2 rounded-lg text-xs font-bold border border-orange-300 text-orange-700 bg-orange-50">w.o (불참)</button>
                      <button onClick={() => setNewScore(s => isWalkoverScore(s) ? s : `${(s || '').trim()} w.o`.trim())}
                        className="flex-1 py-2 rounded-lg text-xs font-bold border border-orange-300 text-orange-700 bg-orange-50">도중 기권 (+ w.o)</button>
                    </div>
                    <p className="text-[11px] text-stone-400 mt-1">불참: w.o · 도중 기권: 그때까지 점수 뒤에 w.o (예: 3:2 w.o) · 승자는 이긴 팀</p>
                  </div>
                  <div className="mb-3">
                    <label className="text-xs text-stone-500">승자</label>
                    <div className="flex gap-2 mt-1">
                      <button onClick={() => setNewWinner('A')} className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${newWinner==='A'?'bg-red-600 text-white border-red-600':'border-stone-300 hover:border-red-400'}`}>A: {selectedMatch.team_a_name||'TBD'}</button>
                      <button onClick={() => setNewWinner('B')} className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${newWinner==='B'?'bg-red-600 text-white border-red-600':'border-stone-300 hover:border-red-400'}`}>B: {selectedMatch.team_b_name||'TBD'}</button>
                    </div>
                  </div>
                  <button onClick={handleUpdateScore} disabled={loading||!newScore||!newWinner} className="w-full bg-red-600 text-white py-2.5 rounded-lg font-bold hover:bg-red-700 disabled:opacity-50">
                    {loading?'처리 중...':'결과 저장'}
                  </button>
                </div>
                {selectedMatch.team_a_id && selectedMatch.team_b_id && (
                  <div className="mt-3 p-3 bg-stone-50 rounded-lg">
                    <p className="text-sm font-bold mb-1">🚫 대회 중도 기권</p>
                    <p className="text-xs text-stone-500 mb-2">그 팀의 남은 경기를 모두 w.o (상대 승)로 처리합니다.</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleWithdrawTeam('A')} disabled={loading}
                        className="flex-1 py-2 rounded-lg text-xs font-medium border border-stone-300 hover:border-red-400 disabled:opacity-50">{selectedMatch.team_a_name} 기권</button>
                      <button onClick={() => handleWithdrawTeam('B')} disabled={loading}
                        className="flex-1 py-2 rounded-lg text-xs font-medium border border-stone-300 hover:border-red-400 disabled:opacity-50">{selectedMatch.team_b_name} 기권</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ══════ 단체전 ══════ */}
        {tab === 'team' && (
          <>
            {tieMsg && (
              <div className={`p-3 rounded-lg text-sm ${tieMsg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {tieMsg}
              </div>
            )}
            <LineupPendingBoard
              eventId={session.event_id}
              reloadKey={boardKey}
              divisionNames={Object.fromEntries(divisions.map(d => [d.id, d.name]))}
              courtName={courtNumToName}
              onProxy={openProxy}
              notify={notifyLineup}
            />

            {/* 부서 탭 */}
            {divisions.length > 0 && (
              <div className="flex gap-1 overflow-x-auto pb-1">
                {divisions.map(d => {
                  const count = ties.filter(t => (t as any).division_id === d.id).length
                  return (
                    <button key={d.id}
                      onClick={() => { setSelectedDivId(d.id); setSelectedTie(null); setScoringRubber(null); setTieSearchQuery('') }}
                      className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                        selectedDivId === d.id
                          ? 'bg-blue-600 text-white shadow'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}>
                      {d.name}
                      {count > 0 && (
                        <span className={`ml-1 text-xs ${
                          selectedDivId === d.id ? 'text-white/70' : 'text-gray-400'
                        }`}>({count})</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {/* 선택 부서 내 검색 (선택) */}
            <div className="relative">
              <input type="text" placeholder={selectedDivId ? '부서 내에서 클럽·라운드 검색 (선택)' : '클럽·라운드 검색'}
                value={tieSearchQuery}
                onChange={e => { setTieSearchQuery(e.target.value); setSelectedTie(null); setScoringRubber(null) }}
                className="w-full border-2 rounded-xl px-4 py-2.5 pr-10 text-sm focus:border-blue-500 outline-none"
              />
              {tieSearchQuery && (
                <button onClick={() => { setTieSearchQuery(''); setSelectedTie(null); setScoringRubber(null) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
              )}
            </div>

            {tiesLoading && <div className="text-center py-8 text-gray-400">로딩중...</div>}
            {!tiesLoading && divisions.length === 0 && ties.length === 0 && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">📭</div>
                <p>이 대회에 단체전 대전이 없습니다.</p>
              </div>
            )}
            {!tiesLoading && filteredTies.length === 0 && ties.length > 0 && (
              <div className="text-center py-8 text-gray-400">
                {tieSearchQuery ? '검색 결과가 없습니다.' : '이 부서에 대전이 없습니다.'}
              </div>
            )}

            {/* 라운드별 그룹 */}
            {groupedTies.map(([round, tieList]) => (
              <div key={round} className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                    {ROUND_LABEL[round] || round} <span className="text-gray-400 font-normal">({tieList.length})</span>
                  </h3>
                </div>
                <div className="space-y-3">
                  {tieList.map(tie => {
                const isSelected = selectedTie?.id === tie.id
                const maj = getMajority(tie.rubber_count)
                const aWin = tie.club_a_rubbers_won >= maj
                const bWin = tie.club_b_rubbers_won >= maj
                return (
                  <div key={tie.id} className="bg-white rounded-xl border overflow-hidden">
                    <div onClick={() => handleSelectTie(tie)} className="p-4 cursor-pointer hover:bg-gray-50 transition">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-400">#{tie.tie_order}</span>
                          <span className={`font-semibold ${aWin?'text-blue-600':''}`}>{tiePh[tie.id]?.a||tie.club_a?.name||'TBD'}</span>
                          <span className="text-gray-400 text-sm">vs</span>
                          <span className={`font-semibold ${bWin?'text-blue-600':''}`}>{tiePh[tie.id]?.b||tie.club_b?.name||'TBD'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {(tie.status==='completed'||tie.status==='in_progress') && (
                            <span className="text-lg font-bold">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span>
                          )}
                          <span className={`text-xs px-2 py-1 rounded-full ${getTieStatusColor(tie.status)}`}>
                            {getTieStatusLabel(tie.status)}
                          </span>
                          <span className="text-gray-400 text-xs">{isSelected?'▲':'▼'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {tie.round && (
                          <span className="text-xs text-gray-400">{tie.round}</span>
                        )}
                        {courtNumToName((tie as any).court_number) && (
                          <span className="text-xs bg-[#2d5016] text-white px-2 py-0.5 rounded-full font-semibold">
                            📍 {courtNumToName((tie as any).court_number)}
                            {(tie as any).court_order != null && (
                              <span className="ml-1 opacity-80">({(tie as any).court_order}번째)</span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>

                    {isSelected && (
                      <div className="border-t bg-gray-50 p-4 space-y-3">
                        {!tie.lineup_revealed && !tie.is_bye && tie.status !== 'completed' && tie.club_a_id && tie.club_b_id && (
                          <div className="bg-white rounded-lg border border-blue-200 p-3">
                            <p className="text-sm font-bold mb-1">📝 오더 대리입력</p>
                            <p className="text-xs text-gray-500 mb-2">주장이 오더를 못 낼 때 종이·구두로 받은 오더를 대신 넣습니다.</p>
                            <div className="flex gap-2">
                              {(['a', 'b'] as const).map(side => {
                                const submitted = side === 'a' ? tie.club_a_lineup_submitted : tie.club_b_lineup_submitted
                                return (
                                  <button key={side} onClick={() => openProxy(tie, side)}
                                    className="flex-1 py-2 rounded-lg text-xs font-medium border border-gray-300 hover:border-blue-400">
                                    {side === 'a' ? tie.club_a?.name : tie.club_b?.name}
                                    <span className={submitted ? 'text-green-600' : 'text-orange-600'}>{submitted ? ' (제출됨)' : ' (미제출)'}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                        {tie.status !== 'completed' && tie.club_a_id && tie.club_b_id && (
                          <div className="bg-white rounded-lg border border-orange-200 p-3">
                            <p className="text-sm font-bold mb-1">🚫 클럽 불참</p>
                            <p className="text-xs text-gray-500 mb-2">남은 복식을 모두 w.o 로 처리하고 상대 클럽 승으로 기록합니다.</p>
                            <div className="flex gap-2">
                              <button onClick={() => handleTieWalkover('A')} disabled={scoreSaving}
                                className="flex-1 py-2 rounded-lg text-xs font-medium border border-gray-300 hover:border-orange-400 disabled:opacity-50">{tie.club_a?.name} 불참</button>
                              <button onClick={() => handleTieWalkover('B')} disabled={scoreSaving}
                                className="flex-1 py-2 rounded-lg text-xs font-medium border border-gray-300 hover:border-orange-400 disabled:opacity-50">{tie.club_b?.name} 불참</button>
                            </div>
                          </div>
                        )}
                        {Array.from({ length: tie.rubber_count }, (_, i) => i+1).map(num => {
                          const laA = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_a_id)
                          const laB = tieLineups.find(l => l.rubber_number===num && l.club_id===tie.club_b_id)
                          const rubber = tieRubbers.find((r: any) => r.rubber_number===num)
                          const hasScore = rubber?.set1_a !== null && rubber?.set1_a !== undefined
                          const isScoring = scoringRubber === rubber?.id
                          // 토너먼트는 과반에서 끝남 — 남은 복식은 입력하지 않음
                          const deadRubber = !hasScore && tie.status === 'completed' && !!tie.round && !['group', 'full_league'].includes(tie.round)

                          return (
                            <div key={num} className={`bg-white rounded-lg border p-3 ${rubber?.status==='completed'?'border-green-200':''}`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium text-sm">러버 {num}</span>
                                {rubber?.status==='completed' && (
                                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">완료</span>
                                )}
                              </div>

                              {(laA || laB) && (
                                <div className="grid grid-cols-5 items-center gap-1 text-xs mb-2">
                                  <div className="col-span-2 text-right">
                                    <div className="font-medium">{laA && !laA.player1_id && !laA.player2_id ? '공오더' : <>{getMemberName(laA?.player1_id)} / {getMemberName(laA?.player2_id)}</>}</div>
                                    <div className="text-gray-400">{tie.club_a?.name}{laA?.submitted_by === 'admin' && ' · 운영자입력'}</div>
                                  </div>
                                  <div className="text-center text-gray-400 font-bold">vs</div>
                                  <div className="col-span-2">
                                    <div className="font-medium">{laB && !laB.player1_id && !laB.player2_id ? '공오더' : <>{getMemberName(laB?.player1_id)} / {getMemberName(laB?.player2_id)}</>}</div>
                                    <div className="text-gray-400">{tie.club_b?.name}{laB?.submitted_by === 'admin' && ' · 운영자입력'}</div>
                                  </div>
                                </div>
                              )}

                              {hasScore && !isScoring && (
                                <div className="flex items-center justify-between">
                                  <div className="text-center flex-1 py-1 bg-gray-50 rounded text-sm font-bold">
                                    {rubber.is_walkover ? <span className="text-orange-600">w.o</span> : <>
                                    {formatSetScore(rubber.set1_a, rubber.set1_b)}
                                    {rubber.set2_a !== null && ' / '+formatSetScore(rubber.set2_a, rubber.set2_b)}
                                    {rubber.set3_a !== null && ' / '+formatSetScore(rubber.set3_a, rubber.set3_b)}
                                    </>}
                                    {rubber.winning_club_id && (
                                      <span className="text-xs text-blue-600 ml-2">
                                        승: {rubber.winning_club_id===tie.club_a_id?tie.club_a?.name:tie.club_b?.name}
                                      </span>
                                    )}
                                  </div>
                                  <button onClick={() => startScoring(rubber)}
                                    className="ml-2 text-xs text-amber-500 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50">
                                    수정
                                  </button>
                                </div>
                              )}

                              {deadRubber && (
                                <p className="text-xs text-gray-400 text-center py-1">승부 결정 — 입력하지 않음</p>
                              )}
                              {!hasScore && !isScoring && rubber && !deadRubber && (
                                <button onClick={() => startScoring(rubber)}
                                  className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium hover:bg-blue-100">
                                  + 점수 입력
                                </button>
                              )}

                              {isScoring && rubber && (
                                <div className="space-y-2 mt-2 border-t pt-3">
                                  <SetRow label="1세트" aVal={set1a} bVal={set1b} setA={setSet1a} setB={setSet1b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  {setsPerRubber === 3 && (<>
                                    <SetRow label="2세트" aVal={set2a} bVal={set2b} setA={setSet2a} setB={setSet2b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                    <SetRow label="3세트" aVal={set3a} bVal={set3b} setA={setSet3a} setB={setSet3b} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  </>)}
                                  {scoreError && <p className="text-red-500 text-xs">{scoreError}</p>}
                                  <div className="flex gap-2">
                                    <button onClick={() => { setScoringRubber(null); setScoreError('') }}
                                      className="flex-1 bg-gray-100 py-2 rounded-lg text-sm">취소</button>
                                    <button onClick={handleTieScoreSave} disabled={scoreSaving}
                                      className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-green-700 disabled:opacity-50">
                                      {scoreSaving ? '저장중...' : '점수 확정'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ══════ PIN 확인 ══════ */}
        {tab === 'pins' && (
          <>
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm text-purple-800">
              <p className="font-bold mb-1">🔑 PIN 확인 (현장 안내용)</p>
              <p className="text-xs">팀명·클럽명·대전번호로 검색 후 👁 버튼 눌러 PIN 확인</p>
            </div>

            <div className="relative">
              <input type="text" placeholder="팀명, 클럽명, 대전번호..."
                value={pinSearchQuery}
                onChange={e => setPinSearchQuery(e.target.value)}
                className="w-full border-2 rounded-xl px-4 py-3 pr-10 focus:border-purple-500 outline-none"
                autoFocus />
              {pinSearchQuery && (
                <button onClick={() => setPinSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
              )}
            </div>

            {pinDataLoading && <div className="text-center py-8 text-gray-400">불러오는 중...</div>}

            {!pinDataLoading && !pinSearchQuery && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">🔍</div>
                <p>검색어를 입력하세요</p>
                <p className="text-xs mt-1 text-gray-300">개인전 팀, 단체전 클럽, 또는 대전 번호</p>
              </div>
            )}

            {!pinDataLoading && pinSearchQuery && (() => {
              const q = pinSearchQuery.toLowerCase()
              const teams = pinTeams.filter(t =>
                t.team_name?.toLowerCase().includes(q) ||
                t.team_num?.toLowerCase().includes(q) ||
                t.division_name?.toLowerCase().includes(q))
              const clubs = pinClubs.filter(c =>
                c.name?.toLowerCase().includes(q) ||
                (c.captain_name||'').toLowerCase().includes(q) ||
                c.division_name?.toLowerCase().includes(q))
              if (teams.length === 0 && clubs.length === 0) {
                return <div className="text-center py-8 text-gray-400">검색 결과 없음</div>
              }

              const renderPin = (key: string, pin: string | null) => {
                const revealed = revealedPins.has(key)
                return (
                  <button onClick={() => togglePinReveal(key)}
                    className="text-xs font-mono bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded">
                    {revealed ? (pin || '없음') : '••••••'} {revealed ? '🙈' : '👁'}
                  </button>
                )
              }

              return (
                <div className="space-y-4">
                  {/* 개인전 팀 PIN */}
                  {teams.length > 0 && (
                    <div className="bg-white rounded-xl border overflow-hidden">
                      <div className="bg-red-50 px-4 py-2 font-bold text-sm text-red-700">🎾 개인전 팀 ({teams.length})</div>
                      <div className="divide-y">
                        {teams.slice(0, 30).map(t => (
                          <div key={t.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium truncate">{t.team_name}</div>
                              <div className="text-[10px] text-gray-400">{t.team_num} · {t.division_name}</div>
                            </div>
                            {renderPin('team:'+t.id, t.pin_plain)}
                          </div>
                        ))}
                        {teams.length > 30 && <div className="text-xs text-gray-400 text-center py-2">... 더 자세한 검색어 입력</div>}
                      </div>
                    </div>
                  )}

                  {/* 단체전 클럽 캡틴 PIN */}
                  {clubs.length > 0 && (
                    <div className="bg-white rounded-xl border overflow-hidden">
                      <div className="bg-blue-50 px-4 py-2 font-bold text-sm text-blue-700">📋 단체전 클럽 캡틴 ({clubs.length})</div>
                      <div className="divide-y">
                        {clubs.slice(0, 30).map(c => (
                          <div key={c.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium truncate">{c.name}</div>
                              <div className="text-[10px] text-gray-400">{c.division_name} · 주장: {c.captain_name || '-'}</div>
                            </div>
                            {renderPin('club:'+c.id, c.captain_pin)}
                          </div>
                        ))}
                        {clubs.length > 30 && <div className="text-xs text-gray-400 text-center py-2">... 더 자세한 검색어 입력</div>}
                      </div>
                    </div>
                  )}

                </div>
              )
            })()}
          </>
        )}

        {/* ══════ PIN 잠금 ══════ */}
        {tab === 'locks' && (
          <>
            {pinLockMsg && (
              <div className={`p-3 rounded-lg text-sm ${pinLockMsg.startsWith('✅')?'bg-green-50 text-green-700':'bg-red-50 text-red-600'}`}>
                {pinLockMsg}
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              <p className="font-bold mb-1">🔒 PIN 5회 실패 시 10분 자동 잠금</p>
              <p className="text-xs">캡틴/선수가 PIN을 잘못 입력해 잠긴 경우 여기서 수동 해제</p>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">
                {pinLockLoading ? '불러오는 중...' : `현재 잠긴 PIN: ${pinLocks.length}건`}
              </span>
              <div className="flex gap-2">
                <button onClick={() => session && loadPinLocks(session.event_id)}
                  className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg">
                  🔄 새로고침
                </button>
                {pinLocks.length > 0 && (
                  <button onClick={handleUnlockAll}
                    className="text-xs bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg">
                    전체 해제
                  </button>
                )}
              </div>
            </div>

            {!pinLockLoading && pinLocks.length === 0 && (
              <div className="text-center py-10 text-gray-400">
                <div className="text-3xl mb-2">✅</div>
                <p>현재 잠긴 PIN 없음</p>
              </div>
            )}

            <div className="space-y-2">
              {pinLocks.map(lock => {
                const lockedMin = lock.locked_until
                  ? Math.max(0, Math.ceil((new Date(lock.locked_until).getTime() - Date.now()) / 60000))
                  : 0
                return (
                  <div key={lock.target_key} className="bg-white rounded-xl border p-4 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{describePinLock(lock.target_key)}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        실패 {lock.fail_count}회 · 잠금 해제까지 ~{lockedMin}분
                      </div>
                    </div>
                    <button onClick={() => handleUnlockPin(lock.target_key)}
                      className="text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-lg font-medium flex-shrink-0 ml-3">
                      🔓 해제
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>

      {proxy && (
        <LineupProxyForm
          tie={proxy.tie}
          side={proxy.side}
          existing={proxy.lineups}
          submit={entries => adminPinSubmitLineup(session.token, proxy.tie.id, (proxy.side === 'a' ? proxy.tie.club_a_id : proxy.tie.club_b_id) as string, entries)}
          onClose={() => setProxy(null)}
          onDone={r => handleProxyDone(!!r.revealed)}
        />
      )}
    </div>
  )
}

function SetRow({ label, aVal, bVal, setA, setB, clubA, clubB }: {
  label: string; aVal: string; bVal: string
  setA: (v: string) => void; setB: (v: string) => void
  clubA?: string; clubB?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-12">{label}</span>
      <div className="flex items-center gap-1 flex-1">
        <div className="flex-1 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">{clubA?.slice(0,5)}</div>
          <input type="number" min="0" max="7" value={aVal} onChange={e => setA(e.target.value)}
            className="w-full border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-blue-500 outline-none" />
        </div>
        <span className="text-gray-400 font-bold">:</span>
        <div className="flex-1 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">{clubB?.slice(0,5)}</div>
          <input type="number" min="0" max="7" value={bVal} onChange={e => setB(e.target.value)}
            className="w-full border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-blue-500 outline-none" />
        </div>
      </div>
    </div>
  )
}
