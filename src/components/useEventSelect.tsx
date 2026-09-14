'use client'
// ============================================================
// src/components/useEventSelect.tsx
// 대회 자동 선택 공용 훅 + 선택 화면
//
// 같은 날 대회가 2개 이상일 수 있어(주최가 다른 대회 동시 개최),
// "오늘과 가장 가까운 대회 하나"로 몰래 점프하던 기존 로직을 대체한다.
//
// 우선순위:
//   1. URL ?event=<id>           — 대회별 전용 링크/QR (가장 확실)
//   2. localStorage 저장값       — 이 기기에서 이미 고른 대회 (단, 오늘 대회가 2개+인데
//                                  저장값이 그 중 하나가 아니면 무시하고 고르게 함)
//   3. 오늘 대회 1개            — 자동 선택
//   4. 오늘 대회 2개 이상       — 선택 화면 (needChoose)
//   5. 오늘 대회 없음           — 오늘과 가장 가까운 대회 (기존 동작 유지)
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export interface EventLite { id: string; name: string; date: string }

export const STORAGE_KEY = 'dashboard_event_id'

export function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function nearest(list: EventLite[], today: string): EventLite | null {
  if (!list.length) return null
  const t = new Date(today).getTime()
  return list.reduce((p, c) =>
    Math.abs(new Date(c.date).getTime() - t) < Math.abs(new Date(p.date).getTime() - t) ? c : p)
}

export function useEventSelect() {
  const [selectedEvent, setSelectedState] = useState('')
  const [events, setEvents] = useState<EventLite[]>([])
  const [todayEvents, setTodayEvents] = useState<EventLite[]>([])
  const [needChoose, setNeedChoose] = useState(false)
  const [ready, setReady] = useState(false)

  // 사용자가 고른 대회: 기기에 저장 + 다른 탭에도 알림
  function setSelectedEvent(id: string) {
    setSelectedState(id)
    setNeedChoose(false)
    try {
      localStorage.setItem(STORAGE_KEY, id)
      window.dispatchEvent(new Event('dashboard_event_changed'))
    } catch {}
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      const { data } = await supabase
        .from('events').select('id, name, date')
        .order('date', { ascending: true })
      if (cancelled) return
      const list = (data || []) as EventLite[]
      const today = kstToday()
      const todays = list.filter(e => e.date === today)
      setEvents(list)
      setTodayEvents(todays)

      // 1. URL ?event=
      const fromUrl = new URLSearchParams(window.location.search).get('event') || ''
      if (fromUrl && list.some(e => e.id === fromUrl)) {
        setSelectedEvent(fromUrl); setReady(true); return
      }

      // 2. 저장값 (오늘 대회 2개+면 그 중 하나일 때만 인정)
      let stored = ''
      try { stored = localStorage.getItem(STORAGE_KEY) || '' } catch {}
      const storedValid = stored && list.some(e => e.id === stored)
      const storedIsToday = todays.some(e => e.id === stored)
      if (storedValid && (todays.length < 2 || storedIsToday)) {
        setSelectedState(stored); setReady(true); return
      }

      // 3~4. 오늘 대회
      if (todays.length === 1) { setSelectedEvent(todays[0].id); setReady(true); return }
      if (todays.length >= 2) { setNeedChoose(true); setReady(true); return }

      // 5. 가장 가까운 대회 (기존 동작)
      const best = nearest(list, today)
      if (best) setSelectedState(best.id)
      setReady(true)
    }
    run()
    return () => { cancelled = true }
  }, [])

  // 같은 기기 다른 탭에서 대회를 바꾸면 반영
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue) { setSelectedState(e.newValue); setNeedChoose(false) }
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
