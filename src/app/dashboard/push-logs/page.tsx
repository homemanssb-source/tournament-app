// src/app/dashboard/push-logs/page.tsx
// 푸시 알림 발송 이력 뷰어
'use client'
import { useState, useEffect, useCallback } from 'react'
import { useEventId } from '@/components/useDashboard'

interface PushLog {
  id: string
  created_at: string
  court: string | null
  team_a_name: string | null
  team_b_name: string | null
  division_name: string | null
  trigger: string | null
  sent: number
  failed: number
  no_sub: boolean
  error_msg: string | null
}

const TRIGGER_LABEL: Record<string, string> = {
  finished:      '경기완료',
  court_changed: '코트변경',
  manual:        '수동',
}

function StatusBadge({ log }: { log: PushLog }) {
  if (log.error_msg) {
    return <span className="inline-flex items-center text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">❌ 오류</span>
  }
  if (log.no_sub) {
    return <span className="inline-flex items-center text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">📵 구독없음</span>
  }
  if (log.failed > 0 && log.sent === 0) {
    return <span className="inline-flex items-center text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">❌ 전체실패</span>
  }
  if (log.failed > 0) {
    return <span className="inline-flex items-center text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">⚠️ 일부실패</span>
  }
  if (log.sent > 0) {
    return <span className="inline-flex items-center text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">✅ 성공</span>
  }
  return <span className="inline-flex items-center text-xs bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full font-medium">—</span>
}

interface SubscriberRow {
  kind: 'individual' | 'team'
  id: string
  label: string
  sub_label: string
  pin: string | null
  checked_in: boolean
  subscribed: boolean
  sub_count: number
  last_subscribed_at: string | null
}

interface SubscriberStats {
  total: number
  subscribed: number
  unsubscribed: number
  individual_total: number
  individual_subscribed: number
  team_total: number
  team_subscribed: number
}

export default function PushLogsPage() {
  const eventId = useEventId()
  const [tab, setTab] = useState<'logs' | 'subscribers'>('logs')
  const [logs, setLogs] = useState<PushLog[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | 'fail' | 'no_sub' | 'ok'>('ALL')
  const [limit, setLimit] = useState(50)

  // 구독 현황
  const [subRows, setSubRows] = useState<SubscriberRow[]>([])
  const [subStats, setSubStats] = useState<SubscriberStats | null>(null)
  const [subFilter, setSubFilter] = useState<'ALL' | 'subscribed' | 'unsubscribed' | 'individual' | 'team'>('ALL')
  const [subQuery, setSubQuery] = useState('')
  const [subsLoading, setSubsLoading] = useState(false)

  const loadLogs = useCallback(async () => {
    if (!eventId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/push/logs?event_id=${eventId}&limit=200`)
      if (!res.ok) throw new Error('조회 실패')
      const data = await res.json()
      setLogs(data.logs || [])
    } catch (e) {
      console.error('[PushLogs]', e)
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { loadLogs() }, [loadLogs])

  // 30초 자동 새로고침
  useEffect(() => {
    const iv = setInterval(loadLogs, 30000)
    return () => clearInterval(iv)
  }, [loadLogs])

  // 구독 현황 로드
  const loadSubscribers = useCallback(async () => {
    if (!eventId) return
    setSubsLoading(true)
    try {
      const res = await fetch(`/api/push/subscribers?event_id=${eventId}`)
      if (!res.ok) throw new Error('조회 실패')
      const data = await res.json()
      setSubRows(data.rows || [])
      setSubStats(data.stats || null)
    } catch (e) {
      console.error('[Subscribers]', e)
    } finally {
      setSubsLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    if (tab === 'subscribers') loadSubscribers()
  }, [tab, loadSubscribers])

  const filtered = logs.filter(l => {
    if (filter === 'fail')   return (l.failed > 0 || !!l.error_msg) && !l.no_sub
    if (filter === 'no_sub') return l.no_sub
    if (filter === 'ok')     return l.sent > 0 && l.failed === 0 && !l.error_msg && !l.no_sub
    return true
  })

  // 통계 — ✅ [FIX] !l.failed → l.failed === 0 (number 타입 명시적 비교)
  const total       = logs.length
  const success     = logs.filter(l => l.sent > 0 && l.failed === 0 && !l.error_msg && !l.no_sub).length
  const partial     = logs.filter(l => l.failed > 0 && l.sent > 0).length
  const allFail     = logs.filter(l => (l.failed > 0 && l.sent === 0) || !!l.error_msg).length
  const noSub       = logs.filter(l => l.no_sub).length
  const totalSent   = logs.reduce((s, l) => s + (l.sent ?? 0), 0)
  const totalFailed = logs.reduce((s, l) => s + (l.failed ?? 0), 0)

  function fmt(iso: string) {
    return new Date(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }

  if (!eventId) return <p className="text-stone-400 p-6">대시보드에서 이벤트를 선택하세요.</p>

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">📡 푸시 알림</h1>
        <button onClick={tab === 'logs' ? loadLogs : loadSubscribers} disabled={tab === 'logs' ? loading : subsLoading}
          className="text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors">
          {(tab === 'logs' ? loading : subsLoading) ? '불러오는 중...' : '🔄 새로고침'}
        </button>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
        <button onClick={() => setTab('logs')}
          className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
            tab === 'logs' ? 'bg-white text-[#2d5016] shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}>
          📤 발송 이력
        </button>
        <button onClick={() => setTab('subscribers')}
          className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
            tab === 'subscribers' ? 'bg-white text-[#2d5016] shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}>
          🔔 구독 현황
        </button>
      </div>

      {tab === 'logs' && <>

      {/* 통계 카드 */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {([
          { label: '총 발송시도',  value: total,            color: 'text-gray-700',  bg: 'bg-gray-50' },
          { label: '✅ 성공',      value: success,          color: 'text-green-700', bg: 'bg-green-50' },
          { label: '⚠️ 일부실패', value: partial,          color: 'text-amber-700', bg: 'bg-amber-50' },
          { label: '❌ 전체실패',  value: allFail,          color: 'text-red-700',   bg: 'bg-red-50' },
          { label: '📵 구독없음',  value: noSub,            color: 'text-gray-500',  bg: 'bg-gray-50' },
          { label: '📨 발송건수',  value: `${totalSent}건`, color: 'text-blue-700',  bg: 'bg-blue-50' },
        ] as const).map(({ label, value, color, bg }) => (
          <div key={label} className={`${bg} rounded-xl border p-3 text-center`}>
            <div className={`text-2xl font-black ${color}`}>{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* 필터 탭 */}
      <div className="flex gap-2 flex-wrap">
        {([
          { key: 'ALL',    label: `전체 (${total})` },
          { key: 'ok',     label: `✅ 성공 (${success})` },
          { key: 'fail',   label: `❌ 실패 (${allFail + partial})` },
          { key: 'no_sub', label: `📵 구독없음 (${noSub})` },
        ] as const).map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`text-sm px-3 py-1.5 rounded-full border transition-all ${
              filter === key
                ? 'bg-[#2d5016] text-white border-[#2d5016]'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* 로그 테이블 */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">
            {filtered.length}건{filter !== 'ALL' ? ' (필터됨)' : ''}
          </span>
          <span className="text-xs text-gray-400">30초마다 자동 새로고침</span>
        </div>

        {loading ? (
          <div className="text-center py-16 text-gray-400">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">로그가 없습니다.</div>
        ) : (
          <>
            {/* 테이블 헤더 (데스크탑) */}
            <div className="hidden sm:grid grid-cols-[130px_1fr_80px_110px_80px] gap-3 px-4 py-2 bg-gray-50 border-b text-xs text-gray-400 font-medium">
              <span>시각</span>
              <span>대상 경기</span>
              <span>코트</span>
              <span>상태</span>
              <span className="text-right">성공/실패</span>
            </div>

            <div className="divide-y max-h-[60vh] overflow-y-auto">
              {filtered.slice(0, limit).map(log => (
                <div key={log.id} className="px-4 py-3 hover:bg-gray-50 transition-colors">

                  {/* 모바일 레이아웃 */}
                  <div className="sm:hidden space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-400">{fmt(log.created_at)}</span>
                      <StatusBadge log={log} />
                    </div>
                    <div className="text-sm font-medium text-gray-800">
                      {log.team_a_name && log.team_b_name
                        ? `${log.team_a_name} vs ${log.team_b_name}`
                        : <span className="text-gray-400 text-xs">팀 정보 없음</span>
                      }
                    </div>
                    <div className="flex items-center flex-wrap gap-2 text-xs text-gray-500">
                      {log.court && <span>📍 {log.court}</span>}
                      {log.division_name && <span>{log.division_name}</span>}
                      {log.trigger && (
                        <span className="bg-gray-100 px-1.5 py-0.5 rounded">
                          {TRIGGER_LABEL[log.trigger] ?? log.trigger}
                        </span>
                      )}
                      <span className="ml-auto font-mono">✅{log.sent} ❌{log.failed}</span>
                    </div>
                    {log.error_msg && (
                      <div className="text-xs text-red-500 bg-red-50 px-2 py-1 rounded break-all">
                        {log.error_msg}
                      </div>
                    )}
                  </div>

                  {/* 데스크탑 레이아웃 */}
                  <div className="hidden sm:grid grid-cols-[130px_1fr_80px_110px_80px] gap-3 items-center">
                    <span className="text-xs text-gray-400">{fmt(log.created_at)}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">
                        {log.team_a_name && log.team_b_name
                          ? `${log.team_a_name} vs ${log.team_b_name}`
                          : <span className="text-gray-400 text-xs">팀 정보 없음</span>
                        }
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {log.division_name && (
                          <span className="text-xs text-gray-400">{log.division_name}</span>
                        )}
                        {log.trigger && (
                          <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                            {TRIGGER_LABEL[log.trigger] ?? log.trigger}
                          </span>
                        )}
                        {log.error_msg && (
                          <span className="text-xs text-red-500 truncate max-w-[200px]" title={log.error_msg}>
                            ⚠️ {log.error_msg}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm text-gray-600">{log.court ?? '-'}</span>
                    <StatusBadge log={log} />
                    <span className="text-right text-xs font-mono">
                      <span className="text-green-600">✅{log.sent}</span>
                      {' '}
                      <span className={log.failed > 0 ? 'text-red-500' : 'text-gray-300'}>❌{log.failed}</span>
                    </span>
                  </div>

                </div>
              ))}
            </div>

            {filtered.length > limit && (
              <div className="text-center py-3 border-t">
                <button onClick={() => setLimit(l => l + 50)}
                  className="text-xs text-blue-500 hover:underline">
                  더 보기 ({filtered.length - limit}건 더)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 실패율 경고 — totalSent + totalFailed > 0 체크로 0나누기 방지 */}
      {(totalSent + totalFailed) > 0 && totalFailed > (totalSent + totalFailed) * 0.3 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <strong>
            ⚠️ 발송 실패율이 높습니다 ({((totalFailed / (totalSent + totalFailed)) * 100).toFixed(0)}%)
          </strong>
          <p className="mt-1 text-xs text-amber-700">
            선수들이 알림 구독을 새로 해야 할 수 있습니다. 만료된 구독은 자동 삭제됩니다.
          </p>
        </div>
      )}

      </>}

      {tab === 'subscribers' && (
        <SubscribersView
          rows={subRows}
          stats={subStats}
          loading={subsLoading}
          filter={subFilter}
          setFilter={setSubFilter}
          query={subQuery}
          setQuery={setSubQuery}
          fmt={fmt}
        />
      )}
    </div>
  )
}

function SubscribersView({ rows, stats, loading, filter, setFilter, query, setQuery, fmt }: {
  rows: SubscriberRow[]
  stats: SubscriberStats | null
  loading: boolean
  filter: 'ALL' | 'subscribed' | 'unsubscribed' | 'individual' | 'team'
  setFilter: (f: any) => void
  query: string
  setQuery: (q: string) => void
  fmt: (iso: string) => string
}) {
  const filtered = rows.filter(r => {
    if (filter === 'subscribed' && !r.subscribed) return false
    if (filter === 'unsubscribed' && r.subscribed) return false
    if (filter === 'individual' && r.kind !== 'individual') return false
    if (filter === 'team' && r.kind !== 'team') return false
    if (query.trim()) {
      const q = query.toLowerCase().trim()
      if (!r.label.toLowerCase().includes(q) && !r.sub_label.toLowerCase().includes(q) && !(r.pin || '').includes(q)) return false
    }
    return true
  })

  return (
    <>
      {/* 통계 카드 */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-green-50 rounded-xl border p-3 text-center">
            <div className="text-2xl font-black text-green-700">{stats.subscribed}<span className="text-sm text-green-400">/{stats.total}</span></div>
            <div className="text-xs text-gray-500 mt-0.5">🔔 구독 완료</div>
          </div>
          <div className="bg-gray-50 rounded-xl border p-3 text-center">
            <div className="text-2xl font-black text-gray-600">{stats.unsubscribed}</div>
            <div className="text-xs text-gray-500 mt-0.5">📵 미구독</div>
          </div>
          <div className="bg-amber-50 rounded-xl border p-3 text-center">
            <div className="text-2xl font-black text-amber-700">{stats.individual_subscribed}<span className="text-sm text-amber-400">/{stats.individual_total}</span></div>
            <div className="text-xs text-gray-500 mt-0.5">🎾 개인전</div>
          </div>
          <div className="bg-blue-50 rounded-xl border p-3 text-center">
            <div className="text-2xl font-black text-blue-700">{stats.team_subscribed}<span className="text-sm text-blue-400">/{stats.team_total}</span></div>
            <div className="text-xs text-gray-500 mt-0.5">🏆 단체전</div>
          </div>
        </div>
      )}

      {/* 필터 + 검색 */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2 flex-wrap">
          {([
            { key: 'ALL', label: `전체 ${rows.length ? `(${rows.length})` : ''}` },
            { key: 'subscribed', label: `🔔 구독 ${stats ? `(${stats.subscribed})` : ''}` },
            { key: 'unsubscribed', label: `📵 미구독 ${stats ? `(${stats.unsubscribed})` : ''}` },
            { key: 'individual', label: `🎾 개인전` },
            { key: 'team', label: `🏆 단체전` },
          ] as const).map(({ key, label }) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`text-sm px-3 py-1.5 rounded-full border transition-all ${
                filter === key
                  ? 'bg-[#2d5016] text-white border-[#2d5016]'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}>
              {label}
            </button>
          ))}
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="팀명, 클럽명, PIN 검색"
          className="sm:ml-auto border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#2d5016] w-full sm:w-64" />
      </div>

      {/* 리스트 */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50 text-sm font-semibold text-gray-700">
          {filtered.length}건 표시
        </div>
        {loading ? (
          <div className="text-center py-16 text-gray-400">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">결과가 없습니다.</div>
        ) : (
          <div className="divide-y max-h-[65vh] overflow-y-auto">
            {filtered.map(r => (
              <div key={r.kind + ':' + r.id} className="px-4 py-3 hover:bg-gray-50 transition-colors flex items-center gap-3">
                <div className="flex-shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                    r.kind === 'individual' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                  }`}>
                    {r.kind === 'individual' ? '개인' : '단체'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-800 truncate">{r.label}</div>
                  <div className="text-xs text-gray-400 truncate">{r.sub_label}</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {r.subscribed ? (
                    <>
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-semibold">
                        🔔 {r.sub_count}
                      </span>
                      {r.last_subscribed_at && (
                        <span className="text-xs text-gray-400 hidden sm:inline">
                          {fmt(r.last_subscribed_at)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full">미구독</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
