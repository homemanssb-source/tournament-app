'use client'
// ============================================================
// src/components/AdminBracketView.tsx
// 관리자 도구(마스터 PIN) — 본선 대진표 + 코트 배정 보기 (모바일 우선, 보기 전용)
//  - 개인전 본선(matches.stage=FINALS) + 단체전 토너먼트(ties.round=16강~결승)
//  - 부서 칩 → 라운드 칩 → 경기 카드(코트·순서·상태·점수)
//  - 30초마다 자동 갱신. DB 쓰기 없음
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchPendingByeIds } from '@/lib/tournament'
import { fetchTies } from '@/lib/team-api'

type Status = 'PENDING' | 'IN_PROGRESS' | 'FINISHED'

interface Card {
  id: string
  num: string
  pos: number
  round: string
  status: Status
  bye: boolean
  score: string | null
  court: string | null
  courtOrder: number | null
  a: string; b: string            // 표시 이름 (TBD면 자리표시)
  aTbd: boolean; bTbd: boolean
  aWin: boolean; bWin: boolean
}

interface Entry { key: string; label: string; kind: 'indiv' | 'team'; cards: Card[] }

// 개인전 round 값은 '8강' / 'QF' 등 혼재 → 한국어로 통일
const ROUND_KO: Record<string, string> = {
  R128: '128강', R64: '64강', R32: '32강', R16: '16강', QF: '8강', SF: '4강', F: '결승',
  r128: '128강', r64: '64강', r32: '32강', r16: '16강', qf: '8강', sf: '4강', f: '결승',
  round_of_32: '32강', round_of_16: '16강', quarter: '8강', semi: '4강', final: '결승',
  본선32강: '32강',
}
const ROUND_ORDER = ['128강', '64강', '32강', '16강', '8강', '4강', '결승']
const TEAM_ROUNDS = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final']
const TIE_STATUS: Record<string, Status> = {
  pending: 'PENDING', lineup_phase: 'PENDING', lineup_ready: 'PENDING',
  in_progress: 'IN_PROGRESS', completed: 'FINISHED',
}

const ko = (r: string) => ROUND_KO[r] || r
const roundIdx = (r: string) => { const i = ROUND_ORDER.indexOf(r); return i < 0 ? 99 : i }

// court_number(글로벌 번호) → '약칭-N' (공개 화면과 동일 규칙)
function courtName(n: number | null | undefined, venues: any[]): string | null {
  if (!n) return null
  if (!venues.length) return `코트-${n}`
  let offset = 0
  for (const v of venues) {
    const c = v.court_count || 0
    if (n <= offset + c) return `${v.short_name || v.name}-${n - offset}`
    offset += c
  }
  const last = venues[venues.length - 1]
  return `${last.short_name || last.name}-${n}`
}

// '김OO(제주)/이OO(서귀)' → [{name, club}]
function players(raw: string): { name: string; club: string }[] {
  return raw.split('/').map(p => {
    const m = p.trim().match(/^(.+?)\((.+)\)$/)
    return m ? { name: m[1].trim(), club: m[2].trim() } : { name: p.trim(), club: '' }
  })
}

export default function AdminBracketView({ eventId }: { eventId: string }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [selKey, setSelKey]   = useState('')
  const [selRound, setSelRound] = useState('')

  const load = useCallback(async () => {
    try {
      const [mRes, ties, dRes, vRes, byeIds] = await Promise.all([
        supabase.from('v_matches_with_teams').select('*')
          .eq('event_id', eventId).eq('stage', 'FINALS').order('slot'),
        fetchTies(eventId).catch(() => []),
        supabase.from('divisions').select('id, name, sort_order').eq('event_id', eventId).order('sort_order'),
        supabase.from('venues').select('name, short_name, court_count').eq('event_id', eventId).order('created_at'),
        fetchPendingByeIds(eventId),   // 본선 TBD 부전승 자리 → BYE 로 표시, 코트 미배정에서 제외
      ])
      const divs = (dRes.data || []) as { id: string; name: string }[]
      const venues = vRes.data || []
      const out: Entry[] = []

      const indivBy: Record<string, Card[]> = {}
      for (const m of (mRes.data || []) as any[]) {
        const aTbd = !m.team_a_id, bTbd = !m.team_b_id
        const card: Card = {
          id: m.id, num: m.match_num ? `#${m.match_num}` : '', pos: m.slot ?? 0, round: ko(m.round || ''),
          status: (m.status as Status) || 'PENDING', bye: m.score === 'BYE' || byeIds.has(m.id),
          score: m.score && m.score !== 'BYE' ? m.score : null,
          court: m.court || null, courtOrder: m.court_order ?? null,
          a: aTbd ? (m.qualifier_label_a || byeIds.get(m.id) || 'TBD') : (m.team_a_name || 'TBD'),
          b: bTbd ? (m.qualifier_label_b || 'TBD') : (m.team_b_name || 'TBD'),
          aTbd, bTbd,
          aWin: !!m.winner_team_id && m.winner_team_id === m.team_a_id,
          bWin: !!m.winner_team_id && m.winner_team_id === m.team_b_id,
        }
        ;(indivBy[m.division_id] ||= []).push(card)
      }

      const teamBy: Record<string, Card[]> = {}
      for (const t of ties as any[]) {
        if (!TEAM_ROUNDS.includes(t.round || '')) continue
        const aTbd = !t.club_a_id, bTbd = !t.club_b_id
        const st = TIE_STATUS[t.status] || 'PENDING'
        teamBy[t.division_id || ''] ||= []
        teamBy[t.division_id || ''].push({
          id: t.id, num: t.tie_order ? `T#${t.tie_order}` : '', pos: t.bracket_position ?? 0,
          round: ko(t.round), status: st, bye: !!t.is_bye,
          score: st !== 'PENDING' ? `${t.club_a_rubbers_won ?? 0}-${t.club_b_rubbers_won ?? 0}` : null,
          court: courtName(t.court_number, venues), courtOrder: t.court_order ?? null,
          a: t.club_a?.name || 'TBD', b: t.club_b?.name || 'TBD', aTbd, bTbd,
          aWin: !!t.winning_club_id && t.winning_club_id === t.club_a_id,
          bWin: !!t.winning_club_id && t.winning_club_id === t.club_b_id,
        })
      }

      const divName = (id: string) => divs.find(d => d.id === id)?.name || (id ? '부서' : '단체전')
      const order = [...divs.map(d => d.id), '']
      const both = new Set(Object.keys(indivBy).filter(id => teamBy[id]))
      for (const id of order) {
        if (indivBy[id]) out.push({ key: `i:${id}`, kind: 'indiv', cards: indivBy[id],
          label: both.has(id) ? `${divName(id)} 개인` : divName(id) })
        if (teamBy[id]) out.push({ key: `t:${id}`, kind: 'team', cards: teamBy[id],
          label: `${divName(id)} 단체` })
      }
      // divisions에 없는 부서 id (예외) 도 빠뜨리지 않음
      for (const id of Object.keys(indivBy)) if (!order.includes(id))
        out.push({ key: `i:${id}`, kind: 'indiv', cards: indivBy[id], label: divName(id) })

      setEntries(out)
      setUpdated(new Date())
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    load()
    const iv = setInterval(load, 30000)
    return () => clearInterval(iv)
  }, [load])

  const entry = entries.find(e => e.key === selKey) || entries[0]

  const rounds = useMemo(() => {
    if (!entry) return [] as { r: string; total: number; done: number; live: number }[]
    const map: Record<string, { total: number; done: number; live: number }> = {}
    for (const c of entry.cards) {
      const s = (map[c.round] ||= { total: 0, done: 0, live: 0 })
      if (c.bye) continue
      s.total++
      if (c.status === 'FINISHED') s.done++
      if (c.status === 'IN_PROGRESS') s.live++
    }
    return Object.entries(map).map(([r, s]) => ({ r, ...s })).sort((x, y) => roundIdx(x.r) - roundIdx(y.r))
  }, [entry])

  // 기본 라운드 = 아직 안 끝난 경기가 있는 첫 라운드 (없으면 마지막 = 결승)
  const current = rounds.find(x => x.done < x.total)?.r || rounds[rounds.length - 1]?.r || ''
  const round = rounds.some(x => x.r === selRound) ? selRound : current

  const cards = useMemo(() => (entry?.cards || [])
    .filter(c => c.round === round)
    .sort((a, b) => a.pos - b.pos), [entry, round])

  if (loading) return <p className="text-center py-10 text-stone-400 text-sm">불러오는 중...</p>
  if (!entry) return (
    <div className="text-center py-10 text-stone-400 text-sm">
      아직 본선 대진표가 없습니다.
      <div><button onClick={load} className="mt-3 text-xs px-3 py-1.5 bg-stone-100 rounded-lg">🔄 새로고침</button></div>
    </div>
  )

  const real = cards.filter(c => !c.bye)
  const live = real.filter(c => c.status === 'IN_PROGRESS').length
  const wait = real.filter(c => c.status === 'PENDING').length
  const noCourt = real.filter(c => c.status !== 'FINISHED' && !c.court).length

  // 결승 승자 = 우승
  const final = entry.cards.find(c => c.round === '결승' && !c.bye)
  const champion = final && (final.aWin ? final.a : final.bWin ? final.b : null)

  return (
    <div className="space-y-3">
      {/* 부서 칩 */}
      {entries.length > 1 && (
        <div className="-mx-4 px-4 flex gap-1.5 overflow-x-auto pb-1">
          {entries.map(e => (
            <button key={e.key} onClick={() => { setSelKey(e.key); setSelRound('') }}
              className={`shrink-0 px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap border transition ${
                e.key === entry.key ? 'bg-stone-800 text-white border-stone-800' : 'bg-white text-stone-600 border-stone-200'
              }`}>
              {e.kind === 'team' ? '📋 ' : ''}{e.label}
            </button>
          ))}
        </div>
      )}

      {/* 라운드 칩 */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(rounds.length, 5)}, minmax(0, 1fr))` }}>
        {rounds.map(x => {
          const on = x.r === round
          const done = x.total > 0 && x.done === x.total
          return (
            <button key={x.r} onClick={() => setSelRound(x.r)}
              className={`py-2 rounded-xl border text-center transition ${
                on ? 'bg-red-600 border-red-600 text-white' : 'bg-white border-stone-200 text-stone-700'
              }`}>
              <div className="text-sm font-bold leading-tight">{x.r}</div>
              <div className={`text-[11px] leading-tight mt-0.5 ${on ? 'text-white/80' : done ? 'text-green-600' : 'text-stone-400'}`}>
                {done ? '✓ 완료' : `${x.done}/${x.total}${x.live ? ` · 🟢${x.live}` : ''}`}
              </div>
            </button>
          )
        })}
      </div>

      {champion && round === '결승' && (
        <div className="rounded-xl bg-yellow-50 border border-yellow-300 px-3 py-2 text-sm text-yellow-800 font-bold text-center">
          🏆 우승 · {champion}
        </div>
      )}

      {/* 요약 + 새로고침 */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex gap-1.5 flex-wrap">
          {live > 0 && <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">진행 {live}</span>}
          {wait > 0 && <span className="px-2 py-0.5 rounded-full bg-stone-100 text-stone-600 font-medium">대기 {wait}</span>}
          {noCourt > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">코트 미배정 {noCourt}</span>}
        </div>
        <button onClick={load} className="text-stone-400 whitespace-nowrap px-2 py-1 -mr-2">
          🔄 {updated?.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
        </button>
      </div>

      {/* 경기 카드 */}
      <div className="space-y-2">
        {cards.map(c => c.bye ? (
          <div key={c.id} className="rounded-xl border border-dashed border-stone-200 px-3 py-2 text-xs text-stone-400 flex justify-between gap-2">
            <span className="truncate">{c.num && `${c.num} · `}부전승 {c.aTbd ? (c.b !== 'TBD' ? c.b : c.a) : c.a}</span>
            <span>BYE</span>
          </div>
        ) : (
          <div key={c.id} className={`rounded-xl border bg-white overflow-hidden ${
            c.status === 'IN_PROGRESS' ? 'border-green-400 ring-1 ring-green-200'
            : c.status === 'FINISHED' ? 'border-stone-200 opacity-80' : 'border-stone-200'
          }`}>
            <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-bold text-stone-400">{c.round}{c.num && ` ${c.num}`}</span>
                {c.status === 'IN_PROGRESS' && <span className="text-[11px] font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded animate-pulse">진행중</span>}
                {c.status === 'FINISHED' && <span className="text-[11px] font-bold text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">종료</span>}
                {c.score && <span className="text-xs font-bold text-stone-700 tabular-nums truncate">{c.score}</span>}
              </div>
              {c.court ? (
                <span className="shrink-0 text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-lg">
                  📍 {c.court}{c.courtOrder != null && c.status === 'PENDING' ? <span className="font-medium opacity-80"> · {c.courtOrder}번째</span> : null}
                </span>
              ) : c.status !== 'FINISHED' ? (
                <span className="shrink-0 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-lg">코트 미배정</span>
              ) : null}
            </div>
            <Side name={c.a} tbd={c.aTbd} win={c.aWin} team={entry.kind === 'team'} />
            <div className="border-t border-stone-100 mx-3" />
            <Side name={c.b} tbd={c.bTbd} win={c.bWin} team={entry.kind === 'team'} last />
          </div>
        ))}
      </div>
    </div>
  )
}

function Side({ name, tbd, win, team, last }: {
  name: string; tbd: boolean; win: boolean; team: boolean; last?: boolean
}) {
  const ps = tbd || team ? null : players(name)
  return (
    <div className={`flex items-center gap-2 px-3 ${last ? 'pt-1.5 pb-2.5' : 'py-1.5'} ${win ? 'bg-green-50/60' : ''}`}>
      <div className="flex-1 min-w-0">
        {ps ? (
          <div className={`text-sm leading-snug truncate ${win ? 'font-bold text-stone-900' : 'text-stone-700'}`}>
            {ps.map((p, i) => (
              <span key={i}>
                {i > 0 && <span className="text-stone-300"> / </span>}
                {p.name}{p.club && <span className="text-[11px] text-stone-400 font-normal">({p.club})</span>}
              </span>
            ))}
          </div>
        ) : (
          <div className={`text-sm truncate ${tbd ? 'text-stone-400 italic' : win ? 'font-bold text-stone-900' : 'text-stone-700'}`}>{name}</div>
        )}
      </div>
      {win && <span className="text-green-600 text-xs font-bold">승</span>}
    </div>
  )
}
