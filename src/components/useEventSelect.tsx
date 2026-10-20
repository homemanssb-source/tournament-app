'use client'
// ============================================================
// src/components/useEventSelect.tsx
// 공개 화면(선수 PIN · 경기장 · 관리자 도구 로그인)의 대회 자동 선택 + 선택 화면
//
// ✅ 운영 대시보드의 대회 선택(dashboard_event_id)과는 완전히 분리 — 대시보드에서 다른 대회를 보거나
//    공개 화면에서 PIN 으로 들어가도 서로 바뀌지 않는다. (예전엔 같은 저장값을 써서 서로 따라갔음)
//
// "경기일" = 대회 날짜 + 부서 경기일 (예: 재성철강 대회 10/24, 3부만 10/25 → 10/24·10/25 둘 다 경기일)
//
// 우선순위:
//   1. URL ?event=<id>      — 대회별 전용 링크/QR (가장 확실)
//   1-1. 오늘 이 기기에서 직접 고른 대회
//   2. 오늘이 경기일인 대회 1개   — 자동 선택
//   3. 오늘이 경기일인 대회 2개+ — 선택 화면 (needChoose)
//   4. 오늘 경기 없음       — 이 기기에서 고른 앞으로의 대회 → 없으면 가장 가까운 앞으로의 대회 (없으면 가장 최근)
// 어느 경우든 화면 위 [대회 변경] 으로 직접 바꿀 수 있음 (EventBar).
// 테스트 대회('__TEST_SIM_…')는 공개 화면에 나오지 않음.
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export interface EventLite { id: string; name: string; date: string; event_type?: string | null; status?: string | null; days?: string[] }   // event_type: 'individual' | 'team'

// 공개 화면 전용 저장값 — { id, day } (day = 고른 날, 같은 날 대회 여러 개일 때 그날만 자동 적용)
export const PUBLIC_EVENT_KEY = 'public_event_id'
export const TEST_EVENT_PREFIX = '__TEST_SIM_'

export function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// 공개 화면 기준 "가장 가까운 대회": 오늘 → 앞으로(끝나지 않은) 가장 빠른 → 없으면 가장 최근
export function pickNearestEvent<T extends EventLite>(list: T[], today = kstToday()): T | null {
  const real = list.filter(e => !e.name?.startsWith(TEST_EVENT_PREFIX))
  const todays = real.filter(e => e.date === today)
  if (todays.length) return todays[0]
  const upcoming = real.filter(e => e.date > today && e.status !== 'completed').sort((a, b) => a.date.localeCompare(b.date))
  if (upcoming.length) return upcoming[0]
  const past = real.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date))
  return past[0] ?? null
}

function readStored(): { id: string; day: string } {
  try {
    const raw = localStorage.getItem(PUBLIC_EVENT_KEY) || ''
    if (raw.startsWith('{')) { const j = JSON.parse(raw); return { id: j.id || '', day: j.day || '' } }
    return { id: raw, day: '' }   // 예전 형식(id 만)
  } catch { return { id: '', day: '' } }
}

const lastDay = (e: EventLite) => (e.days?.length ? e.days[e.days.length - 1] : e.date)

export function useEventSelect() {
  const [selectedEvent, setSelectedState] = useState('')
  const [events, setEvents] = useState<EventLite[]>([])
  const [todayEvents, setTodayEvents] = useState<EventLite[]>([])
  const [needChoose, setNeedChoose] = useState(false)
  const [choosing, setChoosing] = useState(false)   // [대회 변경] 으로 연 선택 화면 (취소 가능)
  const [ready, setReady] = useState(false)

  // 사용자가 고른 대회: 이 기기(공개 화면)에만 저장 — 대시보드 선택은 건드리지 않음
  function setSelectedEvent(id: string) {
    setSelectedState(id)
    setNeedChoose(false); setChoosing(false)
    try { localStorage.setItem(PUBLIC_EVENT_KEY, JSON.stringify({ id, day: kstToday() })) } catch {}
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      const [{ data }, { data: divs }] = await Promise.all([
        supabase.from('events').select('id, name, date, event_type, status').order('date', { ascending: true }),
        supabase.from('divisions').select('event_id, match_date'),
      ])
      if (cancelled) return
      const daysOf: Record<string, Set<string>> = {}
      for (const d of (divs || []) as { event_id: string; match_date: string | null }[]) if (d.match_date) (daysOf[d.event_id] ||= new Set()).add(d.match_date)
      const withDays = ((data || []) as EventLite[]).map(e => ({ ...e, days: [...new Set([e.date, ...(daysOf[e.id] || [])])].filter(Boolean).sort() }))
      const list = withDays.filter(e => !e.name?.startsWith(TEST_EVENT_PREFIX))
      const today = kstToday()
      const todays = list.filter(e => e.days!.includes(today))
      setEvents(list)
      setTodayEvents(todays)

      // 1. URL ?event= (테스트 대회도 링크로는 열 수 있게 전체에서 찾음)
      const fromUrl = new URLSearchParams(window.location.search).get('event') || ''
      if (fromUrl && withDays.some(e => e.id === fromUrl)) {
        setSelectedState(fromUrl); setReady(true); return
      }

      const stored = readStored()

      // 오늘 이 기기에서 [대회 변경]·선택 화면으로 직접 고른 대회가 있으면 그게 우선
      if (stored.day === today && list.some(e => e.id === stored.id)) { setSelectedState(stored.id); setReady(true); return }

      // 2. 오늘 경기일인 대회 1개
      if (todays.length === 1) { setSelectedState(todays[0].id); setReady(true); return }

      // 3. 오늘 경기일인 대회 2개+ — 오늘 이 기기에서 고른 게 있으면 그것
      if (todays.length >= 2) { setNeedChoose(true); setReady(true); return }

      // 4. 이 기기에서 고른 앞으로의 대회 → 없으면 가장 가까운 앞으로의 대회
      const keep = list.find(e => e.id === stored.id && e.status !== 'completed' && lastDay(e) >= today)
      const best = keep || pickNearestEvent(list, today)
      if (best) setSelectedState(best.id)
      setReady(true)
    }
    run()
    return () => { cancelled = true }
  }, [])

  // 같은 기기 다른 탭(공개 화면)에서 고르면 반영
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== PUBLIC_EVENT_KEY || !e.newValue) return
      const v = e.newValue.startsWith('{') ? (() => { try { return JSON.parse(e.newValue!).id } catch { return '' } })() : e.newValue
      if (v) { setSelectedState(v); setNeedChoose(false); setChoosing(false) }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // [대회 변경] 후보: 끝나지 않았고 경기일이 오늘 이후인 대회 (없으면 최근 대회 5개)
  const today = kstToday()
  const upcoming = events.filter(e => e.status !== 'completed' && lastDay(e) >= today)
    .sort((a, b) => (a.days?.[0] || a.date).localeCompare(b.days?.[0] || b.date))
  const changeList = upcoming.length ? upcoming : events.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)

  const currentEvent = events.find(e => e.id === selectedEvent) || null
  // 선택 화면: 같은 날 2개+ (반드시 골라야 함) 또는 [대회 변경] (취소 가능)
  const chooserEvents = needChoose ? todayEvents : changeList
  const showChooser = needChoose || choosing
  const openChooser = () => setChoosing(true)
  const cancelChooser = needChoose ? undefined : () => setChoosing(false)

  return {
    selectedEvent, setSelectedEvent, events, todayEvents, needChoose, ready,
    currentEvent, showChooser, chooserEvents, openChooser, cancelChooser,
    canChange: changeList.length > 1 || (changeList.length === 1 && changeList[0].id !== selectedEvent),
  }
}

// 경기일 표시: 10-24 / 10-24 · 10-25
export function eventDaysLabel(e: EventLite): string {
  const ds = e.days?.length ? e.days : [e.date]
  return ds.map(d => d.slice(5)).join(' · ')
}

// ── 같은 날 대회 2개 이상일 때 / [대회 변경] 때 고르는 화면 ──
export function EventChooser({ events, onPick, onCancel, title = '오늘 진행 대회를 선택하세요', subtitle, currentId }: {
  events: EventLite[]
  onPick: (id: string) => void
  onCancel?: () => void
  title?: string
  subtitle?: string
  currentId?: string
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6 w-full max-w-md">
        <h2 className="font-bold text-lg">📅 {title}</h2>
        <p className="text-xs text-stone-400 mt-1 mb-4">
          {subtitle ?? `같은 날 대회가 ${events.length}개 있습니다. 참가하는 대회를 눌러주세요.`}
        </p>
        <div className="space-y-2">
          {events.map(e => (
            <button key={e.id} onClick={() => onPick(e.id)}
              className={`w-full text-left border rounded-xl px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-all ${e.id === currentId ? 'border-blue-400 bg-blue-50' : 'border-stone-200'}`}>
              <div className="font-semibold text-sm text-stone-800">{e.name}</div>
              <div className="text-xs text-stone-400 mt-0.5">
                {eventDaysLabel(e)}{e.event_type === 'team' ? ' · 단체전' : e.event_type === 'individual' ? ' · 개인전' : ''}{e.id === currentId ? ' · 지금 선택됨' : ''}
              </div>
            </button>
          ))}
        </div>
        {onCancel && (
          <button onClick={onCancel} className="w-full mt-4 text-stone-400 text-sm py-2 hover:text-stone-600">← 취소</button>
        )}
      </div>
    </div>
  )
}

// ── PIN 로그인 화면 위: 지금 선택된 대회 + [대회 변경] ──
export function EventBar({ event, onChange, canChange = true }: { event: EventLite | null; onChange: () => void; canChange?: boolean }) {
  if (!event) return null
  return (
    <div className="w-full max-w-sm mb-6 flex items-center gap-2 bg-white border border-stone-200 rounded-xl px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-stone-400">대회 · {eventDaysLabel(event)}</div>
        <div className="text-sm font-semibold text-stone-700 truncate">{event.name}</div>
      </div>
      {canChange && (
        <button onClick={onChange}
          className="flex-shrink-0 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50">
          대회 변경
        </button>
      )}
    </div>
  )
}
