'use client'
// 현장관리(경기장 PIN) — 단체전 복식 점수 입력 시트
// · 라인업 공개 뒤, 아직 입력 안 된 복식만 (정정은 마스터 PIN)
// · 서버 rpc_venue_rubber_score 가 이 경기장 코트 대전인지 한 번 더 확인 (031)
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { notifyIfTieFinished } from '@/lib/tie-finished-notify'
import { fetchRevealedLineups, fetchClubMembers } from '@/lib/team-api'
import { formatSetScore } from '@/lib/team-utils'

interface Props {
  tieId: string
  token: string
  court: string | null
  onClose: () => void
  onSaved: () => void   // 저장 후 부모 목록 새로고침
}

export default function VenueTieScoreSheet({ tieId, token, court, onClose, onSaved }: Props) {
  const [tie, setTie] = useState<any>(null)
  const [rubbers, setRubbers] = useState<any[]>([])
  const [lineups, setLineups] = useState<any[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [setsPerRubber, setSetsPerRubber] = useState(1)
  const [loading, setLoading] = useState(true)

  const [scoring, setScoring] = useState<string | null>(null)
  const [s, setS] = useState({ a1: '', b1: '', a2: '', b2: '', a3: '', b3: '' })
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [tieRes, rubRes, lu] = await Promise.all([
      supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(id, name), club_b:clubs!ties_club_b_id_fkey(id, name)').eq('id', tieId).single(),
      supabase.from('tie_rubbers').select('*').eq('tie_id', tieId).order('rubber_number'),
      fetchRevealedLineups(tieId).catch(() => []),
    ])
    const t = tieRes.data
    setTie(t)
    setRubbers(rubRes.data || [])
    setLineups(lu)
    if (t?.event_id) {
      const { data: ev } = await supabase.from('events').select('team_sets_per_rubber').eq('id', t.event_id).single()
      setSetsPerRubber(ev?.team_sets_per_rubber || 1)
    }
    const map: Record<string, string> = {}
    for (const cid of [t?.club_a_id, t?.club_b_id].filter(Boolean)) {
      for (const m of await fetchClubMembers(cid).catch(() => [])) map[m.id] = m.name
    }
    setNames(map)
    setLoading(false)
  }, [tieId])

  useEffect(() => { load() }, [load])

  function startScoring(rubberId: string) {
    setScoring(rubberId); setErr('')
    setS({ a1: '', b1: '', a2: '', b2: '', a3: '', b3: '' })
  }

  async function save() {
    // 마스터 PIN 단체전 입력과 같은 검사
    if (!s.a1 || !s.b1) { setErr('1세트 점수를 입력하세요.'); return }
    const a1 = parseInt(s.a1), b1 = parseInt(s.b1)
    if (a1 === b1) { setErr('1세트는 동점일 수 없습니다.'); return }
    if (setsPerRubber === 3) {
      if (!s.a2 || !s.b2) { setErr('2세트 점수를 입력하세요.'); return }
      const a2 = parseInt(s.a2), b2 = parseInt(s.b2)
      if (a2 === b2) { setErr('2세트는 동점일 수 없습니다.'); return }
      if ((a1 > b1) !== (a2 > b2) && (!s.a3 || !s.b3)) { setErr('1-2세트 스플릿 — 3세트 점수를 입력하세요.'); return }
      if (s.a3 && s.b3 && parseInt(s.a3) === parseInt(s.b3)) { setErr('3세트는 동점일 수 없습니다.'); return }
    }
    const num = (v: string) => (v === '' ? null : parseInt(v))
    const rubber = rubbers.find(r => r.id === scoring)
    const summary = [`${s.a1}-${s.b1}`, s.a2 && `${s.a2}-${s.b2}`, s.a3 && `${s.a3}-${s.b3}`].filter(Boolean).join(' / ')
    if (!confirm(`${rubber?.rubber_number}복식\n${tie?.club_a?.name} ${summary} ${tie?.club_b?.name}\n\n저장하면 고칠 수 없습니다 (정정은 마스터 PIN).\n저장할까요?`)) return
    setSaving(true); setErr('')
    try {
      const { data, error } = await supabase.rpc('rpc_venue_rubber_score', {
        p_token: token, p_rubber_id: scoring,
        p_set1_a: a1, p_set1_b: b1,
        p_set2_a: num(s.a2), p_set2_b: num(s.b2),
        p_set3_a: num(s.a3), p_set3_b: num(s.b3),
      })
      if (error) { setErr(error.message); return }
      if ((data as any)?.success === false) { setErr((data as any).error || '저장 실패'); return }
      notifyIfTieFinished(tieId, tie?.status)   // 대전이 끝났으면 다음 대전 주장들에게 알림
      setScoring(null)
      await load()
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const playerNames = (rubberNo: number, clubId: string) => {
    const l = lineups.find(x => x.rubber_number === rubberNo && x.club_id === clubId)
    if (!l) return '-'
    if (!l.player1_id && !l.player2_id) return '공오더'
    return `${names[l.player1_id] || '-'} / ${names[l.player2_id] || '-'}`
  }
  const isKnockout = !!tie?.round && !['group', 'full_league'].includes(tie.round)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50" onClick={() => { if (!saving) onClose() }}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-3 border-b">
          <div className="mx-auto w-10 h-1 rounded-full bg-stone-300 mb-2 sm:hidden" />
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs text-stone-400">{court || '코트 미정'} · 단체전 복식 점수</p>
              <p className="font-bold text-base leading-tight truncate">
                {tie?.club_a?.name || 'TBD'} <span className="text-stone-300 font-normal">vs</span> {tie?.club_b?.name || 'TBD'}
              </p>
            </div>
            <button aria-label="닫기" onClick={onClose} disabled={saving}
              className="w-10 h-10 -mr-2 flex items-center justify-center text-stone-400 text-xl">✕</button>
          </div>
          {tie && (
            <p className="text-sm font-bold text-orange-600 mt-1">
              {tie.club_a_rubbers_won ?? 0} : {tie.club_b_rubbers_won ?? 0}
              {tie.status === 'completed' && <span className="ml-2 text-xs text-green-600">대전 종료</span>}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-2">
          {loading && <p className="text-center text-stone-400 py-8 text-sm">불러오는 중...</p>}
          {!loading && tie && !tie.lineup_revealed && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
              라인업이 아직 공개되지 않았습니다. 두 클럽이 오더를 내면 점수를 입력할 수 있습니다.
            </div>
          )}
          {!loading && rubbers.map(r => {
            const done = r.status === 'completed'
            const dead = !done && tie?.status === 'completed' && isKnockout
            return (
              <div key={r.id} className={`rounded-xl border p-3 ${done ? 'border-green-200 bg-green-50/40' : 'border-stone-200'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold">{r.rubber_number}복식</span>
                  {done && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">완료</span>}
                </div>
                {tie?.lineup_revealed && (
                  <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                    <div><span className="text-stone-400">{tie.club_a?.name}</span><br />{playerNames(r.rubber_number, tie.club_a_id)}</div>
                    <div className="text-right"><span className="text-stone-400">{tie.club_b?.name}</span><br />{playerNames(r.rubber_number, tie.club_b_id)}</div>
                  </div>
                )}
                {done && (
                  <p className="text-center text-base font-bold">
                    {r.is_walkover ? <span className="text-orange-600">w.o</span> : <>
                      {formatSetScore(r.set1_a, r.set1_b)}
                      {r.set2_a !== null && ' / ' + formatSetScore(r.set2_a, r.set2_b)}
                      {r.set3_a !== null && ' / ' + formatSetScore(r.set3_a, r.set3_b)}
                    </>}
                    {r.winning_club_id && <span className="text-xs text-blue-600 ml-2">승: {r.winning_club_id === tie?.club_a_id ? tie?.club_a?.name : tie?.club_b?.name}</span>}
                  </p>
                )}
                {dead && <p className="text-xs text-stone-400 text-center py-1">승부 결정 — 입력하지 않음</p>}
                {!done && !dead && tie?.lineup_revealed && scoring !== r.id && (
                  <button onClick={() => startScoring(r.id)}
                    className="w-full bg-orange-50 text-orange-700 py-2.5 rounded-lg text-sm font-bold">+ 점수 입력</button>
                )}
                {scoring === r.id && (
                  <div className="space-y-2 mt-2 border-t pt-3">
                    {[1, 2, 3].slice(0, setsPerRubber === 3 ? 3 : 1).map(n => (
                      <div key={n} className="flex items-center gap-2">
                        <span className="text-xs text-stone-500 w-10">{n}세트</span>
                        {/* 16px 이상 — iOS에서 누를 때 화면 확대 방지 */}
                        <input type="number" inputMode="numeric" min={0} max={7} value={(s as any)['a' + n]}
                          onChange={e => setS(p => ({ ...p, ['a' + n]: e.target.value }))}
                          className="flex-1 min-w-0 border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-orange-400 outline-none" />
                        <span className="text-stone-400 font-bold">:</span>
                        <input type="number" inputMode="numeric" min={0} max={7} value={(s as any)['b' + n]}
                          onChange={e => setS(p => ({ ...p, ['b' + n]: e.target.value }))}
                          className="flex-1 min-w-0 border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-orange-400 outline-none" />
                      </div>
                    ))}
                    <div className="flex justify-between text-[11px] text-stone-400 px-12">
                      <span>{tie?.club_a?.name}</span><span>{tie?.club_b?.name}</span>
                    </div>
                    {err && <p className="text-red-500 text-xs">{err}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => { setScoring(null); setErr('') }} disabled={saving}
                        className="flex-1 bg-stone-100 py-2.5 rounded-lg text-sm">취소</button>
                      <button onClick={save} disabled={saving}
                        className="flex-[2] bg-orange-500 text-white py-2.5 rounded-lg text-sm font-bold disabled:opacity-50">
                        {saving ? '저장 중...' : '✅ 점수 저장'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {!loading && rubbers.length === 0 && <p className="text-center text-stone-400 py-6 text-sm">복식 정보가 없습니다.</p>}
        </div>
      </div>
    </div>
  )
}
