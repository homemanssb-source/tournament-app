'use client'
// ============================================================
// src/components/PlayerDetailSheet.tsx
// 대회보기: 선수 이름을 누르면 앱A '회원 상세'와 같은 내용을 아래에서 올라오는 창으로 보여준다.
// - PlayerDetailProvider 로 감싼 화면에서만 이름이 눌린다 (운영자 대진표 등은 그대로).
// - 데이터는 /api/player-detail (앱A 공개 정보만) 에서 가져온다.
// ============================================================
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { useNameSearch, hitSearch, HIT_CLASS } from '@/lib/name-search'

type Target = { name: string; club: string; memberId?: string }
const Ctx = createContext<((t: Target) => void) | null>(null)

function formatGrade(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v).replace(/\s+/g, '').replace(/점$/, '').replace(/(\d+)\.0$/, '$1')
  return s ? `${s}점` : ''
}

// 선수 이름: Provider 안이면 누를 수 있는 버튼, 밖이면 그냥 글자
export function PlayerName({ name, club, className, children }: {
  name: string; club?: string; className?: string; children?: React.ReactNode
}) {
  const open = useContext(Ctx)
  // 대회보기 이름 검색: 이름이나 클럽이 검색어와 맞으면 노란 바탕으로 강조
  const q = useNameSearch()
  if (q && (hitSearch(name, q) || hitSearch(club, q))) className = `${className || ''} ${HIT_CLASS}`
  if (!open || !name || name === 'TBD' || name === 'BYE') return <span className={className}>{children ?? name}</span>
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); e.preventDefault(); open({ name, club: club || '' }) }}
      className={`${className || ''} text-left underline decoration-dotted decoration-stone-300 underline-offset-2 hover:decoration-current cursor-pointer max-w-full`}
      title={`${name} 선수 기록 보기`}
    >
      {children ?? name}
    </button>
  )
}

export function PlayerDetailProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null)
  const open = useCallback((t: Target) => setTarget(t), [])
  return (
    <Ctx.Provider value={open}>
      {children}
      {target && <PlayerDetailSheet target={target} onClose={() => setTarget(null)} onPick={setTarget} />}
    </Ctx.Provider>
  )
}

function PlayerDetailSheet({ target, onClose, onPick }: {
  target: Target; onClose: () => void; onPick: (t: Target) => void
}) {
  const nowYear = new Date().getFullYear()
  const [year, setYear] = useState(nowYear)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<'jta' | 'external'>('jta')

  useEffect(() => {
    let alive = true
    setLoading(true); setFailed(false); setTab('jta')
    const q = new URLSearchParams({ year: String(year) })
    if (target.memberId) q.set('member_id', target.memberId)
    else { q.set('name', target.name); if (target.club) q.set('club', target.club) }
    fetch(`/api/player-detail?${q}`)
      .then(r => r.json())
      .then(j => { if (alive) { setData(j); setFailed(!j?.ok) } })
      .catch(() => { if (alive) setFailed(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [target, year])

  // ESC 로 닫기 + 뒤 화면 스크롤 잠금
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  const seasonOptions = Array.from({ length: 5 }, (_, i) => nowYear + 1 - i)
  const member = data?.found ? data.member : null
  const history: any[] = data?.history || []
  const external: any[] = data?.external || []
  const pendingExt = external.filter(h => !h.admin_applied).length

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="선수 상세">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-stone-100">
          <h2 className="text-base font-bold text-stone-800">선수 상세</h2>
          <button onClick={onClose} className="w-8 h-8 -mr-2 flex items-center justify-center rounded-full text-stone-400 hover:bg-stone-100" aria-label="닫기">✕</button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-6 w-1/3 bg-stone-100 rounded" />
              <div className="h-4 w-2/3 bg-stone-100 rounded" />
              <div className="h-16 w-full bg-stone-100 rounded" />
              {[1, 2, 3].map(i => <div key={i} className="h-10 w-full bg-stone-100 rounded" />)}
            </div>
          ) : failed ? (
            <p className="text-sm text-stone-500 text-center py-8">선수 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
          ) : !member ? (
            data?.candidates?.length > 0 ? (
              <div>
                <p className="text-sm text-stone-600 mb-3">
                  <b>{target.name}</b> 선수가 여러 명이에요. 찾는 선수를 골라 주세요.
                </p>
                <div className="space-y-2">
                  {data.candidates.map((c: any) => (
                    <button key={c.member_id} onClick={() => onPick({ name: target.name, club: target.club, memberId: c.member_id })}
                      className="w-full text-left px-3 py-2.5 bg-stone-50 hover:bg-stone-100 rounded-lg">
                      <span className="text-sm font-bold text-stone-800">{c.name}</span>
                      <span className="text-xs text-stone-500 ml-2">{c.club || '소속 없음'}{c.grade ? ` · ${formatGrade(c.grade)}` : ''}{c.division ? ` · ${c.division}` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-stone-500 text-center py-8">
                <b>{target.name}</b>{target.club ? `(${target.club})` : ''} 선수의 협회 회원 기록을 찾을 수 없어요.
              </p>
            )
          ) : (
            <div>
              {/* 프로필 */}
              <div className="space-y-2 mb-5">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-stone-900">{member.name}</span>
                  {member.grade && (
                    <span className="px-2 py-0.5 bg-[#2d5016]/10 text-[#2d5016] text-xs font-semibold rounded-full">등급 {formatGrade(member.grade)}</span>
                  )}
                </div>
                <div className="text-sm text-stone-500 space-y-0.5">
                  {member.club && <p>소속: {member.club}</p>}
                  {member.division && <p>랭킹부서: {member.division}</p>}
                  {member.status && <p>상태: {member.status}</p>}
                </div>
                {data.club_mismatch && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1">
                    대회 신청 소속({target.club})과 협회 등록 소속이 달라 이름으로 찾았어요.
                  </p>
                )}
                <div className="mt-3 flex gap-3">
                  <div className="flex-1 bg-stone-50 rounded-lg px-4 py-3">
                    <span className="text-xs text-stone-500">{data.season_year}시즌 총 포인트</span>
                    <p className="text-2xl font-bold text-[#2d5016]">{Number(data.total_points || 0).toLocaleString()}</p>
                  </div>
                  <div className="bg-stone-50 rounded-lg px-4 py-3 text-center min-w-[90px]">
                    <span className="text-xs text-stone-500">현재 랭킹</span>
                    {data.rank ? (
                      <p className="text-2xl font-bold text-stone-900">{data.rank}<span className="text-sm font-medium text-stone-500">위</span></p>
                    ) : (
                      <p className="text-lg font-bold text-stone-400">-</p>
                    )}
                  </div>
                </div>
              </div>

              {/* 시즌 */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-medium text-stone-700">시즌:</span>
                <select value={year} onChange={e => setYear(Number(e.target.value))}
                  className="text-sm border border-stone-200 rounded-lg px-3 py-1.5 bg-white">
                  {seasonOptions.map(y => <option key={y} value={y}>{y}년</option>)}
                </select>
              </div>

              {/* 탭 */}
              <div className="flex border-b border-stone-200 mb-3">
                {(['jta', 'external'] as const).map(k => (
                  <button key={k} onClick={() => setTab(k)}
                    className={`flex-1 py-2 text-sm font-medium relative ${tab === k ? 'text-[#2d5016]' : 'text-stone-500'}`}>
                    {k === 'jta' ? 'JTA 대회' : '외부대회'}
                    {k === 'external' && pendingExt > 0 && (
                      <span className="ml-1 inline-flex items-center justify-center w-4 h-4 text-[11px] font-bold bg-amber-400 text-white rounded-full">{pendingExt}</span>
                    )}
                    {tab === k && <span className="absolute bottom-0 left-[15%] right-[15%] h-0.5 bg-[#2d5016] rounded-full" />}
                  </button>
                ))}
              </div>

              {tab === 'jta' ? (
                history.length === 0 ? (
                  <p className="text-sm text-stone-500 py-4 text-center">해당 시즌 대회 기록이 없습니다.</p>
                ) : (
                  <div className="space-y-2">
                    {history.map((h, i) => (
                      <div key={i} className="flex items-start justify-between py-2.5 px-3 bg-stone-50 rounded-lg">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-stone-900">{h.tournament_name}</p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                            <p className="text-xs text-stone-500">{h.date} · {h.division}</p>
                            {h.grade && <span className="text-[11px] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">출전등급 {formatGrade(h.grade)}</span>}
                          </div>
                        </div>
                        <div className="text-right ml-2 shrink-0">
                          <p className="text-sm font-semibold text-stone-900">{h.rank}</p>
                          <p className="text-xs text-[#2d5016] font-medium">+{h.points}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : external.length === 0 ? (
                <p className="text-sm text-stone-500 py-4 text-center">외부대회 신고 내역이 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {external.map(h => (
                    <div key={h.id} className="py-2.5 px-3 bg-stone-50 rounded-lg flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${h.tournament_type === '전국대회' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>{h.tournament_type}</span>
                          <span className="text-[11px] text-stone-500">{h.tournament_date}</span>
                        </div>
                        <p className="text-sm font-medium text-stone-900">{h.tournament_name}</p>
                        {h.tournament_division && <p className="text-xs text-stone-500 mt-0.5">{h.tournament_division}</p>}
                        {h.admin_applied && h.expected_grade && Number(h.expected_grade) !== Number(h.before_grade) && (
                          <span className="inline-block mt-1 text-[11px] font-semibold text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                            {formatGrade(h.before_grade)} → {formatGrade(h.expected_grade)}
                          </span>
                        )}
                        <p className={`text-[11px] mt-1 ${h.admin_applied ? 'text-green-600' : 'text-amber-600'}`}>
                          {h.admin_applied ? '✅ 등급 반영 완료' : '🟡 관리자 검토중'}
                        </p>
                      </div>
                      <span className={`ml-2 shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${h.result === '우승' ? 'bg-yellow-100 text-yellow-700' : h.result === '준우승' ? 'bg-stone-100 text-stone-600' : 'bg-stone-100 text-stone-500'}`}>{h.result}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
