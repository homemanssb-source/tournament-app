'use client'
import { useEffect, useState } from 'react'
import { supabase, Division } from '@/lib/supabase'

export function useEventId(): string {
  const [id, setId] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('dashboard_event_id') || ''
  })

  useEffect(() => {
    function onStorageChange() {
      const next = localStorage.getItem('dashboard_event_id') || ''
      setId(prev => prev !== next ? next : prev)
    }
    // localStorage는 다른 탭에서 변경 시 storage 이벤트 발생
    // 같은 탭 변경은 layout이 dispatchEvent로 알려줌
    window.addEventListener('dashboard_event_changed', onStorageChange)
    window.addEventListener('storage', onStorageChange)
    return () => {
      window.removeEventListener('dashboard_event_changed', onStorageChange)
      window.removeEventListener('storage', onStorageChange)
    }
  }, [])

  return id
}

export function useDivisions(eventId: string) {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!eventId) return
    setLoading(true)
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