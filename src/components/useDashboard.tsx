'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase, Division } from '@/lib/supabase'

function readStoredEventId(): string {
  try { return localStorage.getItem('dashboard_event_id') || '' } catch { return '' }
}

// ✅ 사이드바에서 대회를 바꾸면(같은 탭: 'dashboard_event_changed', 다른 탭: storage) 바로 따라감.
//    예전엔 화면이 처음 열릴 때만 읽어서, 새로고침 전까지 이전 대회 화면이 남고
//    그 상태로 누른 버튼이 이전 대회에 적용될 수 있었다.
function useEventChangeListener(onChange: (id: string) => void) {
  useEffect(() => {
    const handle = () => onChange(readStoredEventId())
    const onStorage = (e: StorageEvent) => { if (e.key === 'dashboard_event_id') handle() }
    window.addEventListener('dashboard_event_changed', handle)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('dashboard_event_changed', handle)
      window.removeEventListener('storage', onStorage)
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
}

export function useEventId(): string {
  const [id, setId] = useState('')
  useEffect(() => { setId(readStoredEventId()) }, [])
  useEventChangeListener(setId)
  return id
}

// URL 쿼리(?event_id=) 우선, 없으면 localStorage 폴백.
// teams/* · sync 페이지가 쿼리만 읽어 직접 진입 시 무한 로딩되던 버그(B6) 방지.
export function useEventIdWithParam(): string {
  const searchParams = useSearchParams()
  const [id, setId] = useState('')
  useEffect(() => {
    const fromParam = searchParams.get('event_id') || ''
    setId(fromParam || readStoredEventId())
  }, [searchParams])
  // 대회를 바꾸면 새 대회로 — 주소의 ?event_id= 도 같이 바꿔 둠 (예전 값으로 되돌아가지 않게)
  useEventChangeListener(newId => {
    setId(newId)
    try {
      const url = new URL(window.location.href)
      if (url.searchParams.has('event_id') && newId) {
        url.searchParams.set('event_id', newId)
        window.history.replaceState(window.history.state, '', url.toString())
      }
    } catch {}
  })
  return id
}

export function useDivisions(eventId: string) {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!eventId) return
    supabase.from('divisions').select('*').eq('event_id', eventId).order('sort_order')
      .then(({ data }) => {
        setDivisions(data || [])
        if (data?.length) setSelected(data[0].id)
        setLoading(false)
      })
  }, [eventId])

  return { divisions, selected, setSelected, loading }
}

export function DivisionTabs({ divisions, selected, onSelect }: {
  divisions: Division[]; selected: string; onSelect: (id: string) => void
}) {
  if (divisions.length <= 1) return null
  return (
    <div className="flex gap-1 mb-4 overflow-x-auto">
      {divisions.map(d => (
        <button key={d.id} onClick={() => onSelect(d.id)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
            selected === d.id ? 'bg-tennis-600 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
          }`}>
          {d.name}
        </button>
      ))}
    </div>
  )
}