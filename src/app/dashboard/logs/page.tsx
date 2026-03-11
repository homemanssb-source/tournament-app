// ============================================================
// 접속 로그 뷰어
// src/app/dashboard/logs/page.tsx
// P9: access_logs 테이블 조회
// ============================================================
'use client'
import { useState, useEffect, useCallback } from 'react'
import { useEventId } from '@/components/useDashboard'
import { supabase } from '@/lib/supabase'

interface AccessLog {
  id: string
  event_id: string
  page: string
  tab: string | null
  device: string | null
  accessed_at: string
}

interface Stats {
  total: number
  mobile: number
  desktop: number
  byPage: Record<string, number>
  byTab: Record<string, number>
  byHour: Record<string, number>
}

export default function LogsPage() {
  const eventId = useEventId()
  const [logs, setLogs] = useState<AccessLog[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<Stats | null>(null)
  const [filterPage, setFilterPage] = useState('ALL')
  const [limit, setLimit] = useState(50)

  const loadLogs = useCallback(async () => {
    if (!eventId) return
    setLoading(true)
    try {
      const { data } = await supabase
        .from('access_logs')
        .select('*')
        .eq('event_id', eventId)
        .order('accessed_at', { ascending: false })
        .limit(200)

      const allLogs: AccessLog[] = data || []
      setLogs(allLogs)

      // 통계 계산
      const total = allLogs.length
      const mobile = allLogs.filter(l => l.device === 'mobile').length
      const desktop = allLogs.filter(l => l.device === 'desktop').length

      const byPage: Record<string, number> = {}
      const byTab: Record<string, number> = {}
      const byHour: Record<string, number> = {}

      allLogs.forEach(l => {
        byPage[l.page] = (byPage[l.page] || 0) + 1
        if (l.tab) byTab[l.tab] = (byTab[l.tab] || 0) + 1
        const hour = new Date(l.accessed_at).getHours()
        const hourKey = `${hour.toString().padStart(2, '0')}:00`
        byHour[hourKey] = (byHour[hourKey] || 0) + 1
      })

      setStats({ total, mobile, desktop, byPage, byTab, byHour })
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { loadLogs() }, [loadLogs])

  const filteredLogs = filterPage === 'ALL' ? logs : logs.filter(l => l.page === filterPage)
  const pages = [...new Set(logs.map(l => l.page))]

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  }

  function getDeviceIcon(device: string | null) {
    if (device === 'mobile') return '📱'
    if (device === 'desktop') return '💻'
    return '❓'
  }

  function getPageLabel(page: string): string {
    const map: Record<string, string> = {
      event_detail: '대회 상세',
      pin: 'PIN 로그인',
      venue: '현장 관리',
    }
    return map[page] || page
  }

  function getTabLabel(tab: string): string {
    const map: Record<string, string> = {
      groups: '조편성', tournament: '토너먼트', results: '경기결과', courts: '코트현황',
      team_standings: '단체전 순위', team_matches: '단체전 경기', team_bracket: '단체전 토너먼트',
    }
    return map[tab] || tab
  }

  if (!eventId) return <p className="text-stone-400">대시보드에서 이벤트를 선택하세요.</p>

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">👥 접속 로그</h1>
        <button onClick={loadLogs} disabled={loading}
          className="text-sm text-gray-500 hover:text-gray-700 bg-gray-100 px-3 py-1.5 rounded-lg disabled:opacity-50">
          {loading ? '불러오는 중...' : '🔄 새로고침'}
        </button>
      </div>

      {/* 통계 카드 */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-blue-600">{stats.total}</div>
            <div className="text-xs text-gray-500 mt-1">총 접속</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-green-600">{stats.mobile}</div>
            <div className="text-xs text-gray-500 mt-1">📱 모바일</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-purple-600">{stats.desktop}</div>
            <div className="text-xs text-gray-500 mt-1">💻 데스크탑</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center">
            <div className="text-3xl font-black text-orange-600">
              {(stats.mobile / (stats.total || 1) * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-gray-500 mt-1">모바일 비율</div>
          </div>
        </div>
      )}

      {/* 페이지별 통계 */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border p-4">
            <h3 className="font-semibold text-sm mb-3">페이지별 접속</h3>
            <div className="space-y-2">
              {Object.entries(stats.byPage)
                .sort((a, b) => b[1] - a[1])
                .map(([page, count]) => (
                  <div key={page} className="flex items-center gap-2">
                    <span className="text-sm flex-1">{getPageLabel(page)}</span>
                    <div className="flex items-center gap-2">
                      <div className="bg-blue-100 rounded-full h-2 flex-1 min-w-[80px]" style={{ position: 'relative' }}>
                        <div className="bg-blue-500 rounded-full h-2" style={{ width: `${count / stats.total * 100}%` }} />
                      </div>
                      <span className="text-xs font-bold text-gray-500 w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border p-4">
            <h3 className="font-semibold text-sm mb-3">탭별 접속 (TOP 5)</h3>
            <div className="space-y-2">
              {Object.entries(stats.byTab)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([tab, count]) => (
                  <div key={tab} className="flex items-center gap-2">
                    <span className="text-sm flex-1">{getTabLabel(tab)}</span>
                    <span className="text-xs font-bold text-gray-500">{count}회</span>
                  </div>
                ))}
              {Object.keys(stats.byTab).length === 0 && (
                <p className="text-xs text-gray-400">탭 데이터 없음</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 로그 목록 */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-sm">최근 접속 로그</h3>
          <div className="flex items-center gap-2">
            <select value={filterPage} onChange={e => setFilterPage(e.target.value)}
              className="text-xs border rounded px-2 py-1">
              <option value="ALL">전체 페이지</option>
              {pages.map(p => <option key={p} value={p}>{getPageLabel(p)}</option>)}
            </select>
          </div>
        </div>

        {loading ? (
          <p className="text-center py-10 text-gray-400">불러오는 중...</p>
        ) : filteredLogs.length === 0 ? (
          <p className="text-center py-10 text-gray-400">접속 로그가 없습니다.</p>
        ) : (
          <div className="divide-y max-h-[60vh] overflow-y-auto">
            {filteredLogs.slice(0, limit).map(log => (
              <div key={log.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
                <span className="text-lg">{getDeviceIcon(log.device)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{getPageLabel(log.page)}</span>
                    {log.tab && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {getTabLabel(log.tab)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400">{log.device || '알수없음'}</div>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">{formatTime(log.accessed_at)}</span>
              </div>
            ))}
            {filteredLogs.length > limit && (
              <div className="text-center py-3">
                <button onClick={() => setLimit(l => l + 50)}
                  className="text-xs text-blue-500 hover:underline">
                  더 보기 ({filteredLogs.length - limit}개 더)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}