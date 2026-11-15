'use client'
// ============================================================
// 시드 배정 패널 (개인전 조편성 · 단체전 조편성 공용)
//  - 시드 사용 여부 / 시드 수 / 1번~N번 시드 팀을 운영자가 직접 지정
//  - 저장은 부모가 onSave(시드 순서대로 id 배열)로 처리. [] = 시드 안 함
// ============================================================
import { useEffect, useMemo, useState } from 'react'
import type { SeedRankingResult } from '@/lib/seed-ranking'

export interface SeedCandidate { id: string; name: string; seed: number | null }

export default function SeedPanel({
  candidates, maxSeeds, unit, onSave, loadRanking,
}: {
  candidates: SeedCandidate[]
  maxSeeds: number              // = 예상 조 수 (시드끼리 같은 조 금지)
  unit: string                  // '팀'
  onSave: (orderedIds: string[]) => Promise<void>
  // 개인전만: 앱A 포인트 합산 순위 불러오기. 있으면 "전체 랭킹제"(전 팀 시드)도 허용
  loadRanking?: () => Promise<SeedRankingResult>
}) {
  const [ranking, setRanking] = useState<SeedRankingResult | null>(null)
  const [rankLoading, setRankLoading] = useState(false)
  const current = useMemo(
    () => candidates.filter(c => c.seed != null).sort((a, b) => (a.seed! - b.seed!)).map(c => c.id),
    [candidates],
  )
  const [enabled, setEnabled] = useState(current.length > 0)
  const [picks, setPicks] = useState<string[]>(current)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  // 부서가 바뀌거나 다시 불러오면 저장된 값으로 초기화
  const currentKey = current.join(',')
  useEffect(() => {
    setEnabled(current.length > 0)
    setPicks(current)
    setNote('')
  }, [currentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 부서(후보 구성)가 바뀌면 불러온 순위표는 버린다
  const candidateKey = useMemo(() => candidates.map(c => c.id).sort().join(','), [candidates])
  useEffect(() => { setRanking(null) }, [candidateKey])

  const limit = Math.max(1, Math.min(maxSeeds, candidates.length))
  const count = picks.length
  // 전체 랭킹제 = 모든 팀에 시드 (1위~꼴찌 지그재그 배치)
  const isFull = !!loadRanking && count === candidates.length && count > limit
  const overLimit = count > limit && !isFull

  async function fetchRanking() {
    if (!loadRanking) return
    setRankLoading(true); setNote('')
    try {
      const r = await loadRanking()
      if (!r.ok) throw new Error(r.error || '랭킹 조회 실패')
      setRanking(r)
    } catch (e: any) {
      setRanking(null)
      setNote('❌ ' + (e?.message || '랭킹 조회 실패'))
    } finally {
      setRankLoading(false)
    }
  }

  // 순위표 순서대로 시드 칸 채우기 (n = 조 수 → 상위만, n = 전체 팀 수 → 전체 랭킹제). 저장은 "시드 저장"
  function applyRanking(n: number) {
    if (!ranking) return
    const ids = ranking.teams.map(t => t.id).filter(id => candidates.some(c => c.id === id))
    setEnabled(true)
    setPicks(ids.slice(0, n))
    setNote(`순위표 상위 ${Math.min(n, ids.length)}${unit}을 시드 칸에 넣었습니다. 확인 후 "시드 저장"을 누르세요.`)
  }
  const dirty = (enabled ? picks : []).join(',') !== currentKey
  const incomplete = enabled && picks.some(p => !p)

  function setCount(n: number) {
    setPicks(prev => Array.from({ length: n }, (_, i) => prev[i] || ''))
  }

  function toggle(on: boolean) {
    setEnabled(on)
    if (on && picks.length === 0) setPicks(Array(Math.min(2, limit)).fill(''))
  }

  async function save() {
    setSaving(true); setNote('')
    try {
      await onSave(enabled ? picks : [])
      setNote(enabled ? `✅ 시드 ${picks.length}${unit} 저장` : '✅ 시드 해제 (전부 랜덤)')
    } catch (e: any) {
      setNote('❌ ' + (e?.message || '저장 실패'))
    } finally {
      setSaving(false)
    }
  }

  const sorted = useMemo(() => [...candidates].sort((a, b) => a.name.localeCompare(b.name, 'ko')), [candidates])

  return (
    <div className="bg-white rounded-xl border p-4 mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold text-sm">🏅 시드 배정</h2>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={enabled} onChange={e => toggle(e.target.checked)} />
          시드 사용
        </label>
        {enabled && (
          <label className="flex items-center gap-1.5 text-sm text-stone-600">
            시드 수
            <select value={count} onChange={e => setCount(Number(e.target.value))}
              className="border rounded-lg px-2 py-1 text-sm">
              {Array.from({ length: Math.max(limit, count) }, (_, i) => i + 1).map(n => (
                <option key={n} value={n} disabled={n > limit && !(loadRanking && n === candidates.length)}>{n}{unit}</option>
              ))}
            </select>
            <span className="text-xs text-stone-400">
              {isFull ? '(전체 랭킹제 — 전 팀 시드)' : `(최대 ${limit} — 조 수만큼)`}
            </span>
          </label>
        )}
        {loadRanking && (
          <button onClick={fetchRanking} disabled={rankLoading}
            className="border border-amber-300 text-amber-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-50 disabled:opacity-40">
            {rankLoading ? '불러오는 중...' : '📊 랭킹 불러오기'}
          </button>
        )}
        <button onClick={save} disabled={saving || !dirty || incomplete}
          className="ml-auto bg-amber-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-40">
          {saving ? '저장 중...' : '시드 저장'}
        </button>
      </div>

      {ranking && (
        <div className="mt-3 border border-amber-200 rounded-lg p-3 bg-amber-50/40">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-sm font-semibold text-amber-800">포인트 합산 순위 ({ranking.teams.length}{unit})</span>
            <button onClick={() => applyRanking(limit)}
              className="ml-auto bg-white border border-amber-300 text-amber-700 px-3 py-1 rounded-lg text-xs font-medium hover:bg-amber-50">
              상위 {limit}{unit}만 시드 (나머지 추첨)
            </button>
            <button onClick={() => applyRanking(candidates.length)}
              className="bg-amber-500 text-white px-3 py-1 rounded-lg text-xs font-medium hover:bg-amber-600">
              전체 랭킹제 ({candidates.length}{unit} 모두)
            </button>
            <button onClick={() => setRanking(null)} className="text-xs text-stone-400 hover:text-stone-600">닫기</button>
          </div>
          <div className="max-h-72 overflow-auto bg-white rounded border">
            <table className="w-full text-xs">
              <thead className="bg-stone-50 text-stone-500 sticky top-0">
                <tr>
                  <th className="px-2 py-1 text-left w-10">순위</th>
                  <th className="px-2 py-1 text-left">선수 1</th>
                  <th className="px-2 py-1 text-left">선수 2</th>
                  <th className="px-2 py-1 text-right w-16">합계</th>
                </tr>
              </thead>
              <tbody>
                {ranking.teams.map((t, i) => (
                  <tr key={t.id} className={`border-t ${i === limit - 1 ? 'border-b-2 border-b-amber-300' : ''}`}>
                    <td className="px-2 py-1 font-bold text-amber-700">{i + 1}</td>
                    {[t.p1, t.p2].map((p, j) => (
                      <td key={j} className="px-2 py-1">
                        {p ? (
                          <>
                            {p.name} <span className="text-stone-400">{p.points.toLocaleString()}</span>
                            {!p.matched && <span className="ml-1 text-red-500" title="앱A 회원을 찾지 못해 0점 처리">⚠️</span>}
                          </>
                        ) : <span className="text-stone-300">—</span>}
                      </td>
                    ))}
                    <td className="px-2 py-1 text-right font-semibold">{t.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ranking.unmatched.length > 0 && (
            <p className="text-xs text-red-600 mt-2">
              ⚠️ 앱A 회원을 찾지 못한 선수 {ranking.unmatched.length}명 (0점 처리): {ranking.unmatched.join(' · ')}
            </p>
          )}
          <p className="text-xs text-stone-500 mt-2">
            반영 대회: {ranking.tournaments.filter(e => e.counted).map(e => e.tournament_name).join(' · ') || '없음'}
          </p>
          {ranking.tournaments.some(e => !e.counted) && (
            <p className="text-xs text-stone-400 mt-1">
              제외(다음 회차로 대체): {ranking.tournaments.filter(e => !e.counted).map(e => `${e.tournament_name} → ${e.replaced_by}`).join(' · ')}
            </p>
          )}
          <p className="text-xs text-stone-400 mt-1">
            * 대회마다 가장 최근 회차 포인트만 합산 (같은 대회가 다시 열려 결과가 들어오면 이전 회차 점수는 빠짐) · 동점은 추첨 · 순서는 아래 시드 칸에서 고칠 수 있습니다.
          </p>
        </div>
      )}

      {enabled && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
          {picks.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-1 text-center">
                {i + 1}번 시드
              </span>
              <select value={p}
                onChange={e => setPicks(prev => prev.map((x, j) => (j === i ? e.target.value : x)))}
                className={`flex-1 min-w-0 border rounded-lg px-2 py-1.5 text-sm ${p ? '' : 'border-amber-300 text-stone-400'}`}>
                <option value="">— 선택 —</option>
                {sorted.map(c => (
                  <option key={c.id} value={c.id} disabled={picks.includes(c.id) && c.id !== p}>{c.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {enabled && overLimit && (
        <p className="text-xs text-red-600 mt-2">
          ⚠️ 시드가 조 수({limit})보다 많습니다. 시드 수를 줄이거나 조당 인원을 줄여주세요.
          {loadRanking && ` (전체 랭킹제는 ${candidates.length}${unit} 모두 시드일 때만)`}
        </p>
      )}
      {note && <p className={`text-xs mt-2 ${note.startsWith('❌') ? 'text-red-600' : note.startsWith('✅') ? 'text-green-600' : 'text-amber-700'}`}>{note}</p>}
      <p className="text-xs text-stone-400 mt-2">
        * 예선: 시드끼리 서로 다른 조 (1번 시드 → 1번째 조 …) · 본선: 시드 조 1위가 시드 자리에 —
        1·2번은 대진 양 끝(결승에서만 만남), 3·4번은 서로 다른 4분의1. 시드를 바꾸면 조편성을 다시 해야 예선에 반영됩니다.
        {isFull && ' · 전체 랭킹제: 1위부터 1조·2조… 순으로 넣고 다음 줄은 거꾸로 (1조 = 1위·끝순위 …), 조 첫 경기는 1번 vs 2번.'}
      </p>
    </div>
  )
}
