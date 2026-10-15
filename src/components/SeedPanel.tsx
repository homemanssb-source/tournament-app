'use client'
// ============================================================
// 시드 배정 패널 (개인전 조편성 · 단체전 조편성 공용)
//  - 시드 사용 여부 / 시드 수 / 1번~N번 시드 팀을 운영자가 직접 지정
//  - 저장은 부모가 onSave(시드 순서대로 id 배열)로 처리. [] = 시드 안 함
// ============================================================
import { useEffect, useMemo, useState } from 'react'

export interface SeedCandidate { id: string; name: string; seed: number | null }

export default function SeedPanel({
  candidates, maxSeeds, unit, onSave,
}: {
  candidates: SeedCandidate[]
  maxSeeds: number              // = 예상 조 수 (시드끼리 같은 조 금지)
  unit: string                  // '팀'
  onSave: (orderedIds: string[]) => Promise<void>
}) {
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

  const limit = Math.max(1, Math.min(maxSeeds, candidates.length))
  const count = picks.length
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
                <option key={n} value={n} disabled={n > limit}>{n}{unit}</option>
              ))}
            </select>
            <span className="text-xs text-stone-400">(최대 {limit} — 조 수만큼)</span>
          </label>
        )}
        <button onClick={save} disabled={saving || !dirty || incomplete}
          className="ml-auto bg-amber-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-40">
          {saving ? '저장 중...' : '시드 저장'}
        </button>
      </div>

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

      {enabled && count > limit && (
        <p className="text-xs text-red-600 mt-2">⚠️ 시드가 조 수({limit})보다 많습니다. 시드 수를 줄이거나 조당 인원을 줄여주세요.</p>
      )}
      {note && <p className={`text-xs mt-2 ${note.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>{note}</p>}
      <p className="text-xs text-stone-400 mt-2">
        * 예선: 시드끼리 서로 다른 조 (1번 시드 → 1번째 조 …) · 본선: 시드 조 1위가 시드 자리에 —
        1·2번은 대진 양 끝(결승에서만 만남), 3·4번은 서로 다른 4분의1. 시드를 바꾸면 조편성을 다시 해야 예선에 반영됩니다.
      </p>
    </div>
  )
}
