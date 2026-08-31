'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase, Division } from '@/lib/supabase'

export function useEventId(): string {
  const [id, setId] = useState('')
  useEffect(() => {
    const stored = localStorage.getItem('dashboard_event_id') || ''
    setId(stored)
  }, [])
  return id
}

// URL 쿼리(?event_id=) 우선, 없으면 localStorage 폴백.
// teams/* · sync 페이지가 쿼리만 읽어 직접 진입 시 무한 로딩되던 버그(B6) 방지.
export function useEventIdWithParam(): string {
  const searchParams = useSearchParams()
  const [id, setId] = useState('')
  useEffect(() => {
    const fromParam = searchParams.get('event_id') || ''
    const fromStore = typeof window !== 'undefined' ? localStorage.getItem('dashboard_event_id') || '' : ''
    setId(fromParam || fromStore)
  }, [searchParams])
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