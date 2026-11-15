'use client'
import { useState } from 'react'

// 경기를 '몇 번 코트, 몇 번째'에 넣는 창 (대시보드 코트 배정 · 마스터 PIN 코트 관리 공용, 개인전 경기)
//   - 코트를 고르면 그 코트의 남은 경기 순서가 보이고, 넣을 자리를 누름 (뒤 경기는 한 칸씩 밀림)
//   - 진행 중 경기는 '대기로 바꿔서' 옮길 수 있음 (옮길 코트에 진행 중 경기가 있으면 대기로만)
export interface PlaceQueueItem {
  id: string
  label: string            // "루키부 16강 · 홍길동/김철수 vs …"
  status: string
  court_order: number | null
}

export default function PlaceMatchSheet({
  title, status, currentCourt, courts, queueOf, busy, error, onPlace, onUnassign, onSetPending, onClose,
}: {
  title: string
  status: string
  currentCourt: string | null
  courts: string[]
  queueOf: (court: string) => PlaceQueueItem[]   // 그 코트의 끝나지 않은 경기 (옮기는 경기 제외, 순서대로)
  busy?: boolean
  error?: string
  onPlace: (court: string, beforeId: string | null, setPending: boolean) => void
  onUnassign?: () => void
  onSetPending?: () => void   // 진행 중 → 대기 (자리는 그대로)
  onClose: () => void
}) {
  const isLive = status === 'IN_PROGRESS'
  const [court, setCourt] = useState(currentCourt && courts.includes(currentCourt) ? currentCourt : '')
  const [before, setBefore] = useState<string>('END')   // 'END' = 맨 뒤, 아니면 그 경기 앞
  const [keepLive, setKeepLive] = useState(false)

  const queue = court ? queueOf(court) : []
  const targetLive = queue.some(q => q.status === 'IN_PROGRESS')
  const setPending = isLive && (targetLive || !keepLive)
  const beforeOk = before === 'END' || queue.some(q => q.id === before)
  const slotBtn = (key: string, text: string) => (
    <button key={'slot-' + key} type="button" onClick={() => setBefore(key)}
      className={`w-full text-left text-xs px-3 py-2 rounded-lg border-2 border-dashed transition-all ${
        before === key ? 'border-green-600 bg-green-50 text-green-800 font-bold' : 'border-stone-200 text-stone-400 hover:border-stone-400'
      }`}>
      {before === key ? '✅ ' : '＋ '}{text}
    </button>
  )

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <div className="text-xs text-stone-400">📍 코트 · 순서 지정</div>
            <div className="text-sm font-bold text-stone-800 leading-snug break-keep">{title}</div>
            <div className="text-[11px] text-stone-500 mt-0.5">
              지금: {currentCourt || '미배정'}{isLive ? ' · 🔴 진행 중' : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-stone-400 text-xl leading-none px-1">✕</button>
        </div>

        {isLive && onSetPending && (
          <button type="button" disabled={busy} onClick={onSetPending}
            className="w-full mb-3 text-sm py-2 rounded-lg border border-orange-300 bg-orange-50 text-orange-700 font-semibold disabled:opacity-40">
            ⏸ 자리는 그대로, 대기 상태로 되돌리기
          </button>
        )}

        <label className="block text-xs font-semibold text-stone-600 mb-1">① 코트</label>
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {courts.map(c => (
            <button key={c} type="button" onClick={() => { setCourt(c); setBefore('END') }}
              className={`text-xs py-2 px-1 rounded-lg border transition-all truncate ${
                court === c ? 'bg-[#2d5016] text-white border-[#2d5016] font-bold' : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
              }`}>
              {c}{c === currentCourt ? ' •' : ''}
            </button>
          ))}
        </div>

        {court && (
          <>
            <label className="block text-xs font-semibold text-stone-600 mb-1">② 넣을 자리 ({court})</label>
            <div className="space-y-1 mb-3">
              {queue.length === 0 && <div className="text-xs text-stone-400 px-1">남은 경기가 없는 코트입니다 — 첫 번째로 들어갑니다.</div>}
              {queue.map((q, i) => (
                <div key={q.id} className="space-y-1">
                  {q.status !== 'IN_PROGRESS' && slotBtn(q.id, `${i + 1}번째로 넣기`)}
                  <div className={`text-xs px-3 py-1.5 rounded-lg border ${q.status === 'IN_PROGRESS' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-stone-50 border-stone-200 text-stone-600'}`}>
                    <span className="font-mono text-stone-400 mr-1">{i + 1}.</span>
                    {q.status === 'IN_PROGRESS' && <span className="font-bold mr-1">🔴 진행 중</span>}
                    {q.label}
                  </div>
                </div>
              ))}
              {slotBtn('END', queue.length === 0 ? '첫 번째로 넣기' : `맨 뒤 (${queue.length + 1}번째)로 넣기`)}
            </div>

            {isLive && (
              <div className="mb-3 text-xs rounded-lg bg-orange-50 border border-orange-200 p-2.5 text-orange-800 space-y-1.5">
                {targetLive ? (
                  <div>이 경기는 지금 '진행 중'이고 {court}에도 진행 중인 경기가 있습니다. <b>대기 상태로 바꿔서</b> 옮깁니다.</div>
                ) : (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={keepLive} onChange={e => setKeepLive(e.target.checked)} />
                    <span>'진행 중' 그대로 옮기기 (체크 안 하면 대기 상태로 바꿔서 옮김)</span>
                  </label>
                )}
              </div>
            )}
          </>
        )}

        {error && <div className="mb-3 text-xs text-red-600 whitespace-pre-line">❌ {error}</div>}

        <div className="flex gap-2">
          {onUnassign && currentCourt && (
            <button type="button" disabled={busy} onClick={onUnassign}
              className="text-xs px-3 py-2.5 rounded-lg border border-stone-300 text-stone-600 disabled:opacity-40">
              배정 해제
            </button>
          )}
          <button type="button" disabled={busy || !court || !beforeOk}
            onClick={() => onPlace(court, before === 'END' ? null : before, setPending)}
            className="flex-1 bg-[#2d5016] text-white text-sm font-bold py-2.5 rounded-lg disabled:opacity-40">
            {busy ? '저장 중…' : '이 자리에 넣기'}
          </button>
        </div>
      </div>
    </div>
  )
}
