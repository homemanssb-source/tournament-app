// ============================================================
// 대회 결과 리포트 (PDF + CSV 내보내기)
// src/app/dashboard/report/page.tsx
// ============================================================
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
  team_a_name: string
  team_b_name: string
  winner_name: string | null
  score: string | null
  court: string | null
  status: string
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

  const loadData = useCallback(async () => {
    if (!eventId) return
    setLoading(true)
    try {
      const [eventRes, divsRes, grpsRes, matchRes, tieData] = await Promise.all([
        supabase.from('events').select('name,date,location,event_type,status').eq('id', eventId).single(),
        supabase.from('divisions').select('id,name,sort_order').eq('event_id', eventId).order('sort_order'),
        supabase.from('groups').select('*').eq('event_id', eventId).order('group_num'),
        supabase.from('v_matches_with_teams').select('*').eq('event_id', eventId).neq('score', 'BYE').order('division_name').order('stage').order('round'),
        fetchTies(eventId),
      ])

      setEvent(eventRes.data)
      const divList = divsRes.data || []
      setDivisions(divList)
      setGroups(grpsRes.data || [])

      const matchList = (matchRes.data || []).map((m: any) => ({
        id: m.id, match_num: m.match_num, stage: m.stage, round: m.round,
        division_name: m.division_name, team_a_name: m.team_a_name, team_b_name: m.team_b_name,
        winner_name: m.winner_name, score: m.score, court: m.court, status: m.status,
      }))
      setMatches(matchList)
      setTies(tieData)

      // 모든 그룹 순위 로드
      const map: Record<string, StandingWithClub[]> = {}
      for (const g of grpsRes.data || []) {
        map[g.id] = await fetchStandings(eventId, g.id)
      }
      // 풀리그 순위 (그룹 없는 경우)
      if (!grpsRes.data?.length) {
        map['full'] = await fetchStandings(eventId, null)
      }
      setStandingsMap(map)
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { loadData() }, [loadData])

  // CSV 생성
  function generateCSV(type: 'standings' | 'matches' | 'ties'): string {
    if (!event) return ''
    const BOM = '\uFEFF' // 한글 깨짐 방지

    if (type === 'standings') {
      const rows = [['그룹', '순위', '클럽명', '경기수', '승', '패', '러버승', '러버패', '득실차', '상태']]
      Object.entries(standingsMap).forEach(([key, standings]) => {
        const group = groups.find(g => g.id === key)
        const groupName = key === 'full' ? '풀리그' : group?.group_label || group?.group_name || key
        standings.forEach(s => {
          rows.push([
            groupName,
            String(s.rank ?? '동점'),
            s.club?.name || '',
            String(s.played),
            String(s.won),
            String(s.lost),
            String(s.rubbers_won ?? 0),
            String(s.rubbers_lost ?? 0),
            String(s.rubber_diff),
            s.rank_locked ? '확정' : s.is_tied ? '동점' : '자동',
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
          m.score || '',
          m.winner_name || '',
          m.court || '',
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
          t.club_a?.name || 'TBD',
          t.club_b?.name || 'TBD',
          String(t.club_a_rubbers_won),
          String(t.club_b_rubbers_won),
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

  // PDF 생성 (jsPDF 동적 로드)
  async function downloadPDF() {
    if (!event) return
    setExporting(true)
    try {
      // jsPDF 동적 import
      const jsPDFModule = await import('jspdf')
      const autoTableModule = await import('jspdf-autotable')
      const jsPDF = jsPDFModule.default
      const autoTable = autoTableModule.default

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

      // 제목
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(18)
      doc.text(event.name, 105, 20, { align: 'center' })
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.text(`${event.date} | ${event.location}`, 105, 28, { align: 'center' })

      let yPos = 38

      // 순위표
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
            body: standings.map(s => [
              s.rank ?? '=',
              s.club?.name || '',
              s.played,
              s.won,
              s.lost,
              s.rubbers_won ?? 0,
              s.rubbers_lost ?? 0,
              s.rubber_diff,
            ]),
            didDrawPage: (data: any) => {},
            theme: 'striped',
            styles: { fontSize: 9, cellPadding: 2 },
            headStyles: { fillColor: [45, 80, 22] },
            margin: { left: 14, right: 14 },
            tableWidth: 'auto',
          })
          yPos = (doc as any).lastAutoTable?.finalY + 8 || yPos + 30
        }
      }

      // 단체전 결과
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
          body: completedTies.map(t => [
            t.tie_order,
            t.club_a?.name || 'TBD',
            t.club_a_rubbers_won,
            t.club_b_rubbers_won,
            t.club_b?.name || 'TBD',
            t.winning_club_id === t.club_a_id ? (t.club_a?.name || '') : (t.club_b?.name || ''),
          ]),
          theme: 'striped',
          styles: { fontSize: 9, cellPadding: 2 },
          headStyles: { fillColor: [37, 99, 235] },
          margin: { left: 14, right: 14 },
        })
        yPos = (doc as any).lastAutoTable?.finalY + 8 || yPos + 30
      }

      // 개인전 결과
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
          body: finishedMatches.map(m => [
            m.division_name || '',
            m.round || '',
            m.team_a_name || '',
            m.score || '',
            m.team_b_name || '',
          ]),
          theme: 'striped',
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [120, 53, 15] },
          margin: { left: 14, right: 14 },
        })
      }

      // 페이지 번호
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

      {/* 요약 통계 */}
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

      {/* 내보내기 버튼 */}
      <div className="bg-white rounded-xl border p-5">
        <h3 className="font-bold mb-4">내보내기</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* PDF */}
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

          {/* CSV */}
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

      {/* 미리보기 */}
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