'use client'
import { useState, useEffect, useCallback } from 'react'
import { useEventId } from '@/components/useDashboard'
import { supabase } from '@/lib/supabase'
import { fetchStandings, fetchTies } from '@/lib/team-api'
import type { StandingWithClub, TieWithClubs } from '@/types/team'

interface EventInfo {
  name: string
  date: string
  location: string
  event_type: string
  status: string
}

interface Division {
  id: string
  name: string
  sort_order: number
}

interface MatchRow {
  id: string
  match_num: string
  stage: string
  round: string
  division_name: string
  division_id: string
  team_a_name: string
  team_b_name: string
  team_a_id: string
  team_b_id: string
  winner_team_id: string | null
  winner_name: string | null
  score: string | null
  court: string | null
  status: string
}

// 라운드 → 순위 레이블
const ROUND_PLACE: Record<string, string> = {
  'F': '우승', '결승': '우승',
  'SF': '3-4위', '4강': '3-4위',
  'QF': '5-8위', '8강': '5-8위',
  'R16': '9-16위', '16강': '9-16위',
  'R32': '17-32위', '32강': '17-32위',
  'R64': '33-64위', '64강': '33-64위',
  '128강': '65-128위',
}
const ROUND_ORDER: Record<string, number> = {
  'F': 1, '결승': 1,
  'SF': 2, '4강': 2,
  'QF': 3, '8강': 3,
  'R16': 4, '16강': 4,
  'R32': 5, '32강': 5,
  'R64': 6, '64강': 6,
  '128강': 7,
}
// ✅ 버그 1,2 수정: 순위명 → 표시 순서 맵 (ROUND_ORDER 키는 라운드명이라 순위명에 사용 불가)
const PLACE_ORDER: Record<string, number> = {
  '우승': 1, '준우승': 2, '3-4위': 3,
  '5-8위': 4, '9-16위': 5, '17-32위': 6,
  '33-64위': 7, '65-128위': 8,
}

interface PlayerRank {
  division_name: string
  division_id: string
  place: string
  player_name: string
  club_name: string
}

export default function ReportPage() {
  const eventId = useEventId()
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  const [standingsMap, setStandingsMap] = useState<Record<string, StandingWithClub[]>>({})
  const [matches, setMatches] = useState<MatchRow[]>([])
  const [ties, setTies] = useState<TieWithClubs[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [activeSection, setActiveSection] = useState<'standings' | 'matches' | 'ties'>('standings')

  // 부서별 순위표 state
  const [playerRanks, setPlayerRanks] = useState<PlayerRank[]>([])
  const [rankFilter, setRankFilter] = useState<string>('ALL')
  const [rankLoading, setRankLoading] = useState(false)

  const loadData = useCallback(async () => {
    if (!eventId) return
    setLoading(true)
    try {
      const [eventRes, divsRes, grpsRes, matchRes, tieData] = await Promise.all([
        supabase.from('events').select('name,date,location,event_type,status').eq('id', eventId).single(),
        supabase.from('divisions').select('id,name,sort_order').eq('event_id', eventId).order('sort_order'),
        supabase.from('groups').select('*').eq('event_id', eventId).order('group_num'),
        // ✅ team_a_id, team_b_id, winner_team_id, division_id 추가
        supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId).neq('score', 'BYE').order('division_name').order('stage').order('round'),
        fetchTies(eventId),
      ])

      setEvent(eventRes.data)
      const divList = divsRes.data || []
      setDivisions(divList)
      setGroups(grpsRes.data || [])

      const matchList = (matchRes.data || []).map((m: any) => ({
        id: m.id, match_num: m.match_num, stage: m.stage, round: m.round,
        division_name: m.division_name, division_id: m.division_id,
        team_a_name: m.team_a_name, team_b_name: m.team_b_name,
        team_a_id: m.team_a_id, team_b_id: m.team_b_id,
        winner_team_id: m.winner_team_id,
        winner_name: m.winner_name, score: m.score, court: m.court, status: m.status,
      }))
      setMatches(matchList)
      setTies(tieData)

      const map: Record<string, StandingWithClub[]> = {}
      for (const g of grpsRes.data || []) {
        map[g.id] = await fetchStandings(eventId, g.id)
      }
      if (!grpsRes.data?.length) {
        map['full'] = await fetchStandings(eventId, null)
      }
      setStandingsMap(map)
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { loadData() }, [loadData])

  // ✅ 부서별 순위 생성 — 본선 완료 경기에서 라운드별 팀 추출 후 선수 정보 조회
  const buildPlayerRanks = useCallback(async () => {
    if (!eventId || matches.length === 0) return
    setRankLoading(true)
    try {
      // 본선 완료 경기만
      const finalMatches = matches.filter(m => m.stage === 'FINALS' && m.status === 'FINISHED' && m.round in ROUND_PLACE)

      // 라운드별로 탈락 팀(패자) + 결승 승자 수집
      // 결승: 승자→우승, 패자→준우승
      // 나머지 라운드: 패자→해당 순위
      const teamPlaceList: { team_id: string; division_id: string; division_name: string; place: string }[] = []

      for (const m of finalMatches) {
        if (!m.team_a_id || !m.team_b_id) continue
        const place = ROUND_PLACE[m.round]
        const loserId = m.winner_team_id === m.team_a_id ? m.team_b_id : m.team_a_id

        if (m.round === 'F' || m.round === '결승') {
          // 결승: 승자=우승, 패자=준우승
          if (m.winner_team_id) {
            teamPlaceList.push({ team_id: m.winner_team_id, division_id: m.division_id, division_name: m.division_name, place: '우승' })
          }
          teamPlaceList.push({ team_id: loserId, division_id: m.division_id, division_name: m.division_name, place: '준우승' })
        } else {
          // 나머지: 패자만 해당 순위
          teamPlaceList.push({ team_id: loserId, division_id: m.division_id, division_name: m.division_name, place })
        }
      }

      if (teamPlaceList.length === 0) { setPlayerRanks([]); return }

      // 중복 제거 (같은 team_id가 여러 라운드에 나올 수 있음 — 가장 높은 순위만)
      const bestPlace: Record<string, typeof teamPlaceList[0]> = {}
      for (const item of teamPlaceList) {
        const key = `${item.division_id}|${item.team_id}`
        const cur = bestPlace[key]
        if (!cur || (PLACE_ORDER[item.place] || 99) < (PLACE_ORDER[cur.place] || 99)) {
          bestPlace[key] = item
        }
      }
      const uniqueList = Object.values(bestPlace)
      const allTeamIds = [...new Set(uniqueList.map(x => x.team_id))]

      // ✅ 운영 이슈 3 수정: 빈 배열 체크 (.in('id',[])는 PostgREST 오류 가능)
      if (allTeamIds.length === 0) { setPlayerRanks([]); return }

      // teams 테이블에서 선수 정보 조회
      const { data: teamsData } = await supabase
        .from('teams')
        .select('id, player1_name, player2_name, p1_club, p2_club, club_name')
        .in('id', allTeamIds)

      const teamMap: Record<string, any> = {}
      ;(teamsData || []).forEach((t: any) => { teamMap[t.id] = t })

      // 선수 1인 1행으로 펼치기
      const rows: PlayerRank[] = []
      for (const item of uniqueList) {
        const t = teamMap[item.team_id]
        if (!t) continue
        const divName = item.division_name || divisions.find(d => d.id === item.division_id)?.name || ''
        if (t.player1_name) rows.push({ division_name: divName, division_id: item.division_id, place: item.place, player_name: t.player1_name, club_name: t.p1_club || t.club_name || '' })
        if (t.player2_name) rows.push({ division_name: divName, division_id: item.division_id, place: item.place, player_name: t.player2_name, club_name: t.p2_club || t.club_name || '' })
      }

      // 정렬: 부서 → 순위
      rows.sort((a, b) => {
        const divA = divisions.findIndex(d => d.id === a.division_id)
        const divB = divisions.findIndex(d => d.id === b.division_id)
        if (divA !== divB) return divA - divB
        return (PLACE_ORDER[a.place] || 99) - (PLACE_ORDER[b.place] || 99)
      })

      setPlayerRanks(rows)
    } finally {
      setRankLoading(false)
    }
  }, [eventId, matches, divisions])

  useEffect(() => { buildPlayerRanks() }, [buildPlayerRanks])

  // ✅ 부서별 순위 CSV 다운로드
  function downloadRankCSV() {
    if (!event || playerRanks.length === 0) return
    const BOM = '\uFEFF'
    const filtered = rankFilter === 'ALL' ? playerRanks : playerRanks.filter(r => r.division_id === rankFilter)
    const rows = [['대회명', '부서', '순위', '선수명', '클럽명']]
    filtered.forEach(r => {
      rows.push([event.name, r.division_name, r.place, r.player_name, r.club_name])
    })
    const csv = BOM + rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const divLabel = rankFilter === 'ALL' ? '전체' : (divisions.find(d => d.id === rankFilter)?.name || '')
    a.download = `${event.name}_순위표_${divLabel}_${new Date().toLocaleDateString('ko-KR').replace(/\s/g, '')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 기존 CSV 생성
  function generateCSV(type: 'standings' | 'matches' | 'ties'): string {
    if (!event) return ''
    const BOM = '\uFEFF'

    if (type === 'standings') {
      const rows = [['그룹', '순위', '클럽명', '경기수', '승', '패', '러버승', '러버패', '득실차', '상태']]
      Object.entries(standingsMap).forEach(([key, standings]) => {
        const group = groups.find(g => g.id === key)
        const groupName = key === 'full' ? '풀리그' : group?.group_label || group?.group_name || key
        standings.forEach(s => {
          rows.push([
            groupName, String(s.rank ?? '동점'), s.club?.name || '',
            String(s.played), String(s.won), String(s.lost),
            String(s.rubbers_for ?? 0), String(s.rubbers_against ?? 0),
            String(s.rubber_diff), s.rank_locked ? '확정' : s.is_tied ? '동점' : '자동',
          ])
        })
      })
      return BOM + rows.map(r => r.join(',')).join('\n')
    }

    if (type === 'matches') {
      const rows = [['부서', '라운드', '경기번호', 'A팀', 'B팀', '점수', '승자', '코트', '상태']]
      matches.forEach(m => {
        rows.push([
          m.division_name, m.round, m.match_num,
          m.team_a_name, m.team_b_name,
          m.score || '', m.winner_name || '', m.court || '',
          m.status === 'FINISHED' ? '완료' : m.status === 'IN_PROGRESS' ? '진행중' : '대기',
        ])
      })
      return BOM + rows.map(r => r.join(',')).join('\n')
    }

    if (type === 'ties') {
      const rows = [['순서', 'A팀', 'B팀', 'A러버승', 'B러버승', '승자', '코트', '상태']]
      ties.filter(t => !t.is_bye).forEach(t => {
        rows.push([
          String(t.tie_order),
          t.club_a?.name || 'TBD', t.club_b?.name || 'TBD',
          String(t.club_a_rubbers_won), String(t.club_b_rubbers_won),
          t.winning_club_id === t.club_a_id ? (t.club_a?.name || '') : t.winning_club_id === t.club_b_id ? (t.club_b?.name || '') : '',
          t.court_number ? `코트 ${t.court_number}` : '',
          t.status === 'completed' ? '완료' : t.status === 'in_progress' ? '진행중' : '대기',
        ])
      })
      return BOM + rows.map(r => r.join(',')).join('\n')
    }
    return ''
  }

  function downloadCSV(type: 'standings' | 'matches' | 'ties') {
    const csv = generateCSV(type)
    if (!csv) return
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const fileName = event ? `${event.name}_${type}_${new Date().toLocaleDateString('ko-KR').replace(/\s/g, '')}.csv` : `${type}.csv`
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  async function downloadPDF() {
    if (!event) return
    setExporting(true)
    try {
      const jsPDFModule = await import('jspdf')
      const autoTableModule = await import('jspdf-autotable')
      const jsPDF = jsPDFModule.default
      const autoTable = autoTableModule.default

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(18)
      doc.text(event.name, 105, 20, { align: 'center' })
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.text(`${event.date} | ${event.location}`, 105, 28, { align: 'center' })

      let yPos = 38

      if (Object.keys(standingsMap).length > 0) {
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(13)
        doc.text('Standings', 14, yPos)
        yPos += 6

        for (const [key, standings] of Object.entries(standingsMap)) {
          if (standings.length === 0) continue
          const group = groups.find(g => g.id === key)
          const groupName = key === 'full' ? 'Full League' : group?.group_label || group?.group_name || key

          autoTable(doc, {
            startY: yPos,
            head: [['#', 'Club', 'P', 'W', 'L', 'RW', 'RL', 'Diff']],
            body: standings.map(s => [s.rank ?? '=', s.club?.name || '', s.played, s.won, s.lost, s.rubbers_for ?? 0, s.rubbers_against ?? 0, s.rubber_diff]),
            didDrawPage: (_data: any) => {},
            theme: 'striped',
            styles: { fontSize: 9, cellPadding: 2 },
            headStyles: { fillColor: [45, 80, 22] },
            margin: { left: 14, right: 14 },
            tableWidth: 'auto',
          })
          yPos = (doc as any).lastAutoTable?.finalY + 8 || yPos + 30
        }
      }

      const completedTies = ties.filter(t => t.status === 'completed' && !t.is_bye)
      if (completedTies.length > 0) {
        if (yPos > 240) { doc.addPage(); yPos = 20 }
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(13)
        doc.text('Team Ties Results', 14, yPos)
        yPos += 6
        autoTable(doc, {
          startY: yPos,
          head: [['#', 'Team A', 'A', 'B', 'Team B', 'Winner']],
          body: completedTies.map(t => [t.tie_order, t.club_a?.name || 'TBD', t.club_a_rubbers_won, t.club_b_rubbers_won, t.club_b?.name || 'TBD', t.winning_club_id === t.club_a_id ? (t.club_a?.name || '') : (t.club_b?.name || '')]),
          theme: 'striped',
          styles: { fontSize: 9, cellPadding: 2 },
          headStyles: { fillColor: [37, 99, 235] },
          margin: { left: 14, right: 14 },
        })
        yPos = (doc as any).lastAutoTable?.finalY + 8 || yPos + 30
      }

      const finishedMatches = matches.filter(m => m.status === 'FINISHED').slice(0, 60)
      if (finishedMatches.length > 0) {
        if (yPos > 230) { doc.addPage(); yPos = 20 }
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(13)
        doc.text('Match Results', 14, yPos)
        yPos += 6
        autoTable(doc, {
          startY: yPos,
          head: [['Div', 'Round', 'Team A', 'Score', 'Team B']],
          body: finishedMatches.map(m => [m.division_name || '', m.round || '', m.team_a_name || '', m.score || '', m.team_b_name || '']),
          theme: 'striped',
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [120, 53, 15] },
          margin: { left: 14, right: 14 },
        })
      }

      const pageCount = doc.getNumberOfPages()
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i)
        doc.setFontSize(8)
        doc.setTextColor(150)
        doc.text(`Page ${i} of ${pageCount} - Generated ${new Date().toLocaleDateString('ko-KR')}`, 105, 290, { align: 'center' })
      }
      const fileName = `${event.name}_report_${new Date().toLocaleDateString('ko-KR').replace(/\s/g, '')}.pdf`
      doc.save(fileName)
    } catch (err: any) {
      alert('PDF 생성 실패: jspdf 패키지가 설치되어 있는지 확인하세요.\n' + err.message)
    } finally {
      setExporting(false)
    }
  }

  if (!eventId) return <p className="text-stone-400">대시보드에서 이벤트를 선택하세요.</p>

  const completedMatchCount = matches.filter(m => m.status === 'FINISHED').length
  const completedTieCount = ties.filter(t => t.status === 'completed').length

  // 부서별 순위표 필터
  const filteredRanks = rankFilter === 'ALL' ? playerRanks : playerRanks.filter(r => r.division_id === rankFilter)
  const ranksByDiv = filteredRanks.reduce<Record<string, PlayerRank[]>>((acc, r) => {
    if (!acc[r.division_name]) acc[r.division_name] = []
    acc[r.division_name].push(r)
    return acc
  }, {})

  // 순위 배지 색상
  function placeColor(place: string) {
    if (place === '우승') return 'bg-yellow-100 text-yellow-800 border-yellow-300'
    if (place === '준우승') return 'bg-gray-100 text-gray-700 border-gray-300'
    if (place === '3-4위') return 'bg-orange-50 text-orange-700 border-orange-200'
    return 'bg-stone-50 text-stone-500 border-stone-200'
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">📊 대회 리포트</h1>
        {event && (
          <div className="text-right">
            <div className="font-semibold">{event.name}</div>
            <div className="text-xs text-gray-500">{event.date} · {event.location}</div>
          </div>
        )}
      </div>

      {/* ── ✅ 부서별 순위표 (NEW) ── */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b bg-stone-50">
          <div>
            <h3 className="font-bold text-sm">🏆 부서별 순위표</h3>
            <p className="text-xs text-stone-400 mt-0.5">본선 결과 기준 · 선수 1인 1행</p>
          </div>
          <button
            onClick={downloadRankCSV}
            disabled={playerRanks.length === 0 || rankLoading}
            className="flex items-center gap-1.5 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-green-700 disabled:opacity-40 transition-all"
          >
            📥 CSV 다운로드
          </button>
        </div>

        {/* 부서 필터 */}
        {divisions.length > 1 && (
          <div className="flex gap-2 px-4 py-3 overflow-x-auto border-b bg-white">
            <button
              onClick={() => setRankFilter('ALL')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${rankFilter === 'ALL' ? 'bg-[#2d5016] text-white border-[#2d5016]' : 'bg-white text-stone-600 border-stone-300'}`}
            >
              전체 부서
            </button>
            {divisions.map(d => (
              <button
                key={d.id}
                onClick={() => setRankFilter(d.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${rankFilter === d.id ? 'bg-[#2d5016] text-white border-[#2d5016]' : 'bg-white text-stone-600 border-stone-300'}`}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}

        <div className="p-4">
          {rankLoading ? (
            <p className="text-center py-6 text-stone-400 text-sm">순위 계산 중...</p>
          ) : playerRanks.length === 0 ? (
            <p className="text-center py-6 text-stone-400 text-sm">본선 완료 경기가 없습니다.</p>
          ) : (
            <div className="space-y-5">
              {Object.entries(ranksByDiv).map(([divName, rows]) => (
                <div key={divName}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-1 h-4 bg-[#2d5016] rounded-full" />
                    <h4 className="font-bold text-sm text-stone-700">{divName}</h4>
                  </div>
                  <div className="rounded-xl border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 border-b">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500">순위</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500">선수명</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500">클럽명</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-50">
                        {rows.map((r, i) => (
                          <tr key={i} className="hover:bg-stone-50">
                            <td className="px-4 py-2.5">
                              <span className={`inline-block text-xs font-bold px-2.5 py-0.5 rounded-full border ${placeColor(r.place)}`}>
                                {r.place}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 font-medium text-stone-800">{r.player_name}</td>
                            <td className="px-4 py-2.5 text-stone-500">{r.club_name || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 요약 통계 ── */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-blue-600">{divisions.length}</div>
            <div className="text-xs text-gray-500 mt-1">부서</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-green-600">{completedMatchCount}</div>
            <div className="text-xs text-gray-500 mt-1">완료 경기</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-purple-600">{completedTieCount}</div>
            <div className="text-xs text-gray-500 mt-1">완료 단체전</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-orange-600">
              {Object.values(standingsMap).reduce((a, s) => a + s.length, 0)}
            </div>
            <div className="text-xs text-gray-500 mt-1">참가 클럽</div>
          </div>
        </div>
      )}

      {/* ── 내보내기 버튼 ── */}
      <div className="bg-white rounded-xl border p-5">
        <h3 className="font-bold mb-4">내보내기</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-red-50 rounded-xl border border-red-200 p-4">
            <div className="text-2xl mb-2">📄</div>
            <div className="font-semibold text-red-800 mb-1">PDF 리포트</div>
            <div className="text-xs text-red-600 mb-3">순위표 + 경기결과 통합 문서</div>
            <button onClick={downloadPDF} disabled={loading || exporting}
              className="w-full bg-red-600 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-red-700 disabled:opacity-50">
              {exporting ? '생성 중...' : '📄 PDF 다운로드'}
            </button>
            <p className="text-xs text-red-400 mt-1.5">* jspdf, jspdf-autotable 필요</p>
          </div>

          <div className="bg-green-50 rounded-xl border border-green-200 p-4">
            <div className="text-2xl mb-2">📊</div>
            <div className="font-semibold text-green-800 mb-1">CSV 내보내기</div>
            <div className="text-xs text-green-600 mb-3">엑셀에서 바로 열 수 있는 CSV</div>
            <div className="space-y-2">
              <button onClick={() => downloadCSV('standings')} disabled={loading}
                className="w-full bg-green-600 text-white py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50">
                📋 순위표 CSV
              </button>
              <button onClick={() => downloadCSV('matches')} disabled={loading}
                className="w-full bg-green-500 text-white py-2 rounded-lg text-sm hover:bg-green-600 disabled:opacity-50">
                🎾 개인전 결과 CSV
              </button>
              <button onClick={() => downloadCSV('ties')} disabled={loading}
                className="w-full bg-green-400 text-white py-2 rounded-lg text-sm hover:bg-green-500 disabled:opacity-50">
                🏆 단체전 결과 CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── 미리보기 ── */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="flex border-b">
          {(['standings', 'matches', 'ties'] as const).map(s => (
            <button key={s} onClick={() => setActiveSection(s)}
              className={`flex-1 py-2.5 text-sm font-medium transition ${activeSection === s ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              {s === 'standings' ? '📊 순위' : s === 'matches' ? '🎾 개인전' : '🏆 단체전'}
            </button>
          ))}
        </div>

        <div className="p-4">
          {loading ? (
            <p className="text-center py-8 text-gray-400">불러오는 중...</p>
          ) : activeSection === 'standings' ? (
            <StandingsPreview standingsMap={standingsMap} groups={groups} />
          ) : activeSection === 'matches' ? (
            <MatchesPreview matches={matches} />
          ) : (
            <TiesPreview ties={ties} />
          )}
        </div>
      </div>
    </div>
  )
}

function StandingsPreview({ standingsMap, groups }: { standingsMap: Record<string, StandingWithClub[]>, groups: any[] }) {
  const entries = Object.entries(standingsMap)
  if (entries.length === 0) return <p className="text-center text-gray-400 py-4">순위 데이터 없음</p>
  return (
    <div className="space-y-4">
      {entries.map(([key, standings]) => {
        const group = groups.find(g => g.id === key)
        const groupName = key === 'full' ? '풀리그' : group?.group_label || group?.group_name || key
        return (
          <div key={key}>
            <h4 className="font-semibold text-sm text-gray-600 mb-2">{groupName}</h4>
            <table className="w-full text-xs border rounded overflow-hidden">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">클럽</th>
                  <th className="px-2 py-1.5 text-center">승</th>
                  <th className="px-2 py-1.5 text-center">패</th>
                  <th className="px-2 py-1.5 text-center">득실</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {standings.map(s => (
                  <tr key={s.id} className={s.is_tied ? 'bg-yellow-50' : ''}>
                    <td className="px-2 py-1.5 font-bold">{s.rank ?? '='}</td>
                    <td className="px-2 py-1.5">{s.club?.name}</td>
                    <td className="px-2 py-1.5 text-center">{s.won}</td>
                    <td className="px-2 py-1.5 text-center">{s.lost}</td>
                    <td className="px-2 py-1.5 text-center">{s.rubber_diff > 0 ? '+' : ''}{s.rubber_diff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

function MatchesPreview({ matches }: { matches: MatchRow[] }) {
  const finished = matches.filter(m => m.status === 'FINISHED').slice(0, 20)
  if (finished.length === 0) return <p className="text-center text-gray-400 py-4">완료 경기 없음</p>
  return (
    <div className="space-y-1">
      {finished.map(m => (
        <div key={m.id} className="flex items-center gap-2 text-sm py-1.5 border-b last:border-0">
          <span className="text-xs text-gray-400 w-24 flex-shrink-0">{m.division_name}</span>
          <span className="flex-1 font-medium">{m.team_a_name}</span>
          <span className="font-bold text-green-700 mx-2">{m.score}</span>
          <span className="flex-1 text-right font-medium">{m.team_b_name}</span>
        </div>
      ))}
      {matches.filter(m => m.status === 'FINISHED').length > 20 && (
        <p className="text-xs text-gray-400 text-center pt-2">+ 더 많은 경기가 있습니다. CSV로 전체 내보내기 하세요.</p>
      )}
    </div>
  )
}

function TiesPreview({ ties }: { ties: TieWithClubs[] }) {
  const completed = ties.filter(t => t.status === 'completed' && !t.is_bye)
  if (completed.length === 0) return <p className="text-center text-gray-400 py-4">완료 단체전 없음</p>
  return (
    <div className="space-y-1">
      {completed.map(t => (
        <div key={t.id} className="flex items-center gap-2 text-sm py-1.5 border-b last:border-0">
          <span className="flex-1 font-medium">{t.club_a?.name}</span>
          <span className="font-black text-blue-700 mx-2">{t.club_a_rubbers_won} - {t.club_b_rubbers_won}</span>
          <span className="flex-1 text-right font-medium">{t.club_b?.name}</span>
        </div>
      ))}
    </div>
  )
}
