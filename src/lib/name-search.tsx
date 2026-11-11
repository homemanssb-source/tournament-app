'use client'
// 대회보기 이름 검색 — 조편성·토너먼트·경기결과에서 같은 검색어를 공유
import { createContext, useContext } from 'react'

// 비교용: 소문자 + 공백 제거 ("김 철수" = "김철수")
export function normSearch(s?: string | null): string {
  return (s || '').toLowerCase().replace(/\s+/g, '')
}

// q 는 normSearch 를 거친 값. 팀 이름("홍길동(한라)/김철수(탐라)")·선수 이름·클럽명 어디든 포함되면 true
export function hitSearch(text: string | null | undefined, q: string): boolean {
  if (!q || !text || text === 'TBD' || text === 'BYE') return false
  return normSearch(text).includes(q)
}

// 현재 검색어 (정규화된 값, 없으면 '')
export const NameSearchContext = createContext<string>('')
export const useNameSearch = () => useContext(NameSearchContext)

// 강조 표시 (노란 바탕)
export const HIT_CLASS = 'bg-yellow-200 !text-stone-900 rounded px-0.5'
