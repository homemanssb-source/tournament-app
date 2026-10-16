'use client'
// ============================================================
// src/components/useEventSelect.tsx
// 공개 화면(선수 PIN · 경기장 · 관리자 도구 로그인)의 대회 자동 선택 + 선택 화면
//
// ✅ 운영 대시보드의 대회 선택(dashboard_event_id)과는 완전히 분리 — 대시보드에서 다른 대회를 보거나
//    공개 화면에서 PIN 으로 들어가도 서로 바뀌지 않는다. (예전엔 같은 저장값을 써서 서로 따라갔음)
//
// 우선순위:
//   1. URL ?event=<id>      — 대회별 전용 링크/QR (가장 확실)
//   2. 오늘 대회 1개        — 자동 선택
//   3. 오늘 대회 2개 이상   — 이 기기에서 오늘 고른 대회가 있으면 그것, 없으면 선택 화면 (needChoose)
//   4. 오늘 대회 없음       — 가장 가까운 앞으로의 대회 (없으면 가장 최근 대회)
// 테스트 대회('__TEST_SIM_…')는 공개 화면에 나오지 않음.
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export interface EventLite { id: string; name: string; date: string; event_type?: string | null; status?: string | null }   // event_type: 'individual' | 'team'

// 공개 화면 전용 저장값 (같은 날 대회가 여러 개일 때 고른 것을 그날만 기억)
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

export function useEventSelect() {
  const [selectedEvent, setSelectedState] = useState('')
  const [events, setEvents] = useState<EventLite[]>([])
  const [todayEvents, setTodayEvents] = useState<EventLite[]>([])
  const [needChoose, setNeedChoose] = useState(false)
  const [ready, setReady] = useState(false)

  // 사용자가 고른 대회: 이 기기(공개 화면)에만 저장 — 대시보드 선택은 건드리지 않음
  function setSelectedEvent(id: string) {
    setSelectedState(id)
    setNeedChoose(false)
    try { localStorage.setItem(PUBLIC_EVENT_KEY, id) } catch {}
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      const { data } = await supabase
        .from('events').select('id, name, date, event_type, status')
        .order('date', { ascending: true })
      if (cancelled) return
      const list = ((data || []) as EventLite[]).filter(e => !e.name?.startsWith(TEST_EVENT_PREFIX))
      const today = kstToday()
      const todays = list.filter(e => e.date === today)
      setEvents(list)
      setTodayEvents(todays)

      // 1. URL ?event= (테스트 대회도 링크로는 열 수 있게 전체에서 찾음)
      const fromUrl = new URLSearchParams(window.location.search).get('event') || ''
      if (fromUrl && ((data || []) as EventLite[]).some(e => e.id === fromUrl)) {
        setSelectedState(fromUrl); setReady(true); return
      }

      // 2. 오늘 대회 1개
      if (todays.length === 1) { setSelectedState(todays[0].id); setReady(true); return }

      // 3. 오늘 대회 2개+ — 오늘 이 기기에서 고른 게 있으면 그것
      if (todays.length >= 2) {
        let stored = ''
        try { stored = localStorage.getItem(PUBLIC_EVENT_KEY) || '' } catch {}
        if (todays.some(e => e.id === stored)) setSelectedState(stored)
        else setNeedChoose(true)
        setReady(true); return
      }

      // 4. 가장 가까운 앞으로의 대회
      const best = pickNearestEvent(list, today)
      if (best) setSelectedState(best.id)
      setReady(true)
    }
    run()
    return () => { cancelled = true }
  }, [])

  // 같은 기기 다른 탭(공개 화면)에서 고르면 반영
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === PUBLIC_EVENT_KEY && e.newValue) { setSelectedState(e.newValue); setNeedChoose(false) }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return { selectedEvent, setSelectedEvent, events, todayEvents, needChoose, ready }
}

// ── 같은 날 대회 2개 이상일 때 고르는 화면 ──
export function EventChooser({ events, onPick, title = '오늘 진행 대회를 선택하세요', subtitle }: {
  events: EventLite[]
  onPick: (id: string) => void
  title?: string
  subtitle?: string
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
              className="w-full text-left border border-stone-200 rounded-xl px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-all">
              <div className="font-semibold text-sm text-stone-800">{e.name}</div>
              <div className="text-xs text-stone-400 mt-0.5">{e.date}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
