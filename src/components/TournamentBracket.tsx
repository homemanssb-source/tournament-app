'use client'
import { useRef, useEffect } from 'react'

// ============================================================
// src/components/TournamentBracket.tsx
// ============================================================

interface BracketMatch {
  match_id?: string; match_num?: string; round?: string; slot?: number
  team_a_id?: string; team_b_id?: string; team_a_name?: string; team_b_name?: string
  winner_team_id?: string; winner_name?: string; score?: string; status?: string
  next_match_id?: string; next_slot?: string
}

const ROUND_ORDER = ['128강', '64강', '32강', '16강', '8강', '4강', '결승', 'R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F']

const CARD_H = 82
const MIN_GAP = 8

// "전태홍(제주하나)/강기호(행복배틀)" → [{ name, club }]
function parsePlayers(raw: string): { name: string; club: string }[] {
  if (!raw || raw === 'TBD' || raw === 'BYE') return []
  return raw.split('/').map(p => {
    const m = p.trim().match(/^(.+?)\((.+)\)$/)
    return m ? { name: m[1].trim(), club: m[2].trim() } : { name: p.trim(), club: '' }
  })
}

function getCardWidth(roundCount: number): number {
  if (roundCount >= 6) return 155
  if (roundCount >= 5) return 170
  if (roundCount >= 4) return 185
  return 205
}

function calcPositions(roundIdx: number, count: number, firstRoundCount: number, totalHeight: number): number[] {
  if (roundIdx === 0) {
    const spacing = (totalHeight - 60) / Math.max(count, 1)
    return Array.from({ length: count }, (_, i) => i * spacing + (spacing - CARD_H) / 2)
  }
  const prevCount     = count * 2
  const prevPositions = calcPositions(roundIdx - 1, prevCount, firstRoundCount, totalHeight)
  const positions: number[] = []
  for (let i = 0; i < count; i++) {
    const top    = prevPositions[i * 2]     ?? 0
    const bottom = prevPositions[i * 2 + 1] ?? top
    positions.push((top + bottom) / 2)
  }
  return positions
}

export default function TournamentBracket({ matches }: { matches: BracketMatch[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const body   = scrollRef.current
    const header = headerRef.current
    if (!body || !header) return
    const onBodyScroll = () => { header.scrollLeft = body.scrollLeft }
    body.addEventListener('scroll', onBodyScroll)
    return () => body.removeEventListener('scroll', onBodyScroll)
  }, [])

  const byRound = new Map<string, BracketMatch[]>()
  for (const m of matches) {
    const r = m.round || ''
    if (!byRound.has(r)) byRound.set(r, [])
    byRound.get(r)!.push(m)
  }
  for (const arr of byRound.values()) arr.sort((a, b) => (a.slot || 0) - (b.slot || 0))

  const rounds = ROUND_ORDER.filter(r => byRound.has(r))
  if (!rounds.length) return (
    <p className="text-center py-10 text-stone-400 text-sm">토너먼트 데이터가 없습니다.</p>
  )

  const firstRoundCount = (byRound.get(rounds[0]) || []).length
  const totalHeight     = firstRoundCount * (CARD_H + MIN_GAP) + 60
  const CARD_W          = getCardWidth(rounds.length)
  const COL_W           = CARD_W + 10
  const totalWidth      = rounds.length * COL_W

  return (
    <div className="w-full rounded-xl border border-stone-200 overflow-hidden">

      {/* 헤더 — overflow hidden + JS 스크롤 동기화 */}
      <div ref={headerRef} style={{ overflowX: 'hidden' }} className="border-b border-stone-200 bg-stone-50">
        <div className="flex" style={{ minWidth: totalWidth }}>
          {rounds.map(round => (
            <div
              key={round}
              style={{ width: COL_W, flexShrink: 0 }}
              className="text-center py-2 text-xs font-bold text-stone-500 tracking-wide border-r border-stone-100 last:border-r-0"
            >
              {round}
            </div>
          ))}
        </div>
      </div>

      {/* 브래킷 본체 */}
      <div
        ref={scrollRef}
        className="overflow-x-auto pb-4 bg-white"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ WebkitOverflowScrolling: 'touch' } as any}
      >
        <div className="relative" style={{ minWidth: totalWidth, height: Math.max(totalHeight, 300) }}>

          {/* SVG 연결선 */}
          <svg
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
            width={totalWidth}
            height={Math.max(totalHeight, 300)}
          >
            {rounds.map((round, rIdx) => {
              if (rIdx === 0) return null
              const count   = (byRound.get(round) || []).length
              const curPos  = calcPositions(rIdx,     count,     firstRoundCount, totalHeight)
              const prevPos = calcPositions(rIdx - 1, count * 2, firstRoundCount, totalHeight)
              const xPrevR  = (rIdx - 1) * COL_W + CARD_W + 5
              const xCurL   = rIdx * COL_W + 5
              const midX    = (xPrevR + xCurL) / 2

              return curPos.map((cy, i) => {
                const topY = (prevPos[i * 2]     ?? 0) + CARD_H / 2
                const botY = (prevPos[i * 2 + 1] ?? prevPos[i * 2] ?? 0) + CARD_H / 2
                const curY = cy + CARD_H / 2
                return (
                  <g key={`conn-${rIdx}-${i}`}>
                    <line x1={xPrevR} y1={topY} x2={midX}  y2={topY} stroke="#d6d3d1" strokeWidth={1.5} />
                    <line x1={xPrevR} y1={botY} x2={midX}  y2={botY} stroke="#d6d3d1" strokeWidth={1.5} />
                    <line x1={midX}   y1={topY} x2={midX}  y2={botY} stroke="#d6d3d1" strokeWidth={1.5} />
                    <line x1={midX}   y1={curY} x2={xCurL} y2={curY} stroke="#d6d3d1" strokeWidth={1.5} />
                  </g>
                )
              })
            })}
          </svg>

          {/* 카드 */}
          {rounds.map((round, rIdx) => {
            const roundMatches = byRound.get(round) || []
            const positions    = calcPositions(rIdx, roundMatches.length, firstRoundCount, totalHeight)
            return roundMatches.map((m, mIdx) => (
              <div
                key={m.match_id || mIdx}
                style={{ position: 'absolute', top: positions[mIdx], left: rIdx * COL_W + 5, width: CARD_W }}
              >
                <MatchCard m={m} byRound={byRound} roundIdx={rIdx} rounds={rounds} />
              </div>
            ))
          })}

        </div>
      </div>
    </div>
  )
}

function MatchCard({ m, byRound, roundIdx, rounds }: {
  m: BracketMatch
  byRound?: Map<string, BracketMatch[]>
  roundIdx?: number
  rounds?: string[]
}) {
  const isBye      = m.score === 'BYE'
  const done       = m.status === 'FINISHED'
  const inProgress = m.status === 'IN_PROGRESS'
  const aWon       = !!(m.winner_team_id && m.winner_team_id === m.team_a_id)
  const bWon       = !!(m.winner_team_id && m.winner_team_id === m.team_b_id)

  // TBD 예상 후보: 정렬 인덱스 기반으로 직전 라운드 2경기에서 후보 추출
  function getTbdCandidates(teamName?: string): string[] {
    if (teamName && teamName !== 'TBD') return []
    if (!byRound || roundIdx === undefined || !rounds || roundIdx === 0) return []
    const prevRound = rounds[roundIdx - 1]
    if (!prevRound) return []

    // 현재 라운드 내 정렬 후 내 인덱스 파악
    const curMatches = (byRound.get(rounds[roundIdx]) || []).slice().sort((a, b) => (a.slot || 0) - (b.slot || 0))
    const myIdx = curMatches.findIndex(pm => pm.match_id === m.match_id)
    if (myIdx < 0) return []

    // 직전 라운드 slot 순 정렬
    const prevMatches = (byRound.get(prevRound) || []).slice().sort((a, b) => (a.slot || 0) - (b.slot || 0))
    const idxA = myIdx * 2
    const idxB = myIdx * 2 + 1
    const candidates = [prevMatches[idxA], prevMatches[idxB]].filter(Boolean)

    const names: string[] = []
    for (const pm of candidates) {
      if (pm.status === 'FINISHED' && pm.winner_team_id) {
        const w = pm.winner_team_id === pm.team_a_id ? pm.team_a_name : pm.team_b_name
        if (w && w !== 'TBD') names.push(w.split('/').map((p: string) => p.replace(/\(.*?\)/g, '').trim()).join('/'))
      } else {
        if (pm.team_a_name && pm.team_a_name !== 'TBD')
          names.push(pm.team_a_name.split('/').map((p: string) => p.replace(/\(.*?\)/g, '').trim()).join('/'))
        if (pm.team_b_name && pm.team_b_name !== 'TBD')
          names.push(pm.team_b_name.split('/').map((p: string) => p.replace(/\(.*?\)/g, '').trim()).join('/'))
      }
    }
    return names
  }

  return (
    <div
      style={{ height: CARD_H }}
      className={`rounded-lg border overflow-hidden shadow-sm flex flex-col ${
        inProgress       ? 'border-red-300'
        : done && !isBye ? 'border-green-300'
        : isBye          ? 'border-amber-200'
        :                  'border-stone-200'
      } ${isBye ? 'bg-amber-50/40' : 'bg-white'}`}
    >
      {/* LIVE 바 */}
      {inProgress && (
        <div className="flex items-center gap-1 px-2 bg-red-50 border-b border-red-100" style={{ height: 14, flexShrink: 0 }}>
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-red-700 font-bold" style={{ fontSize: 9, letterSpacing: 1 }}>LIVE</span>
        </div>
      )}

      {/* 팀 A */}
      <div
        className={`flex items-start px-2 py-1 border-b border-stone-100 ${
          aWon ? 'bg-green-50' : bWon && done ? 'bg-stone-50' : ''
        }`}
        style={{ flex: 1, minHeight: 0 }}
      >
        <div className="flex-1 min-w-0 overflow-hidden">
          <TeamRow
            raw={m.team_a_name}
            won={aWon}
            muted={bWon && done}
            tbd={!m.team_a_name || m.team_a_name === 'TBD'}
            candidates={getTbdCandidates(m.team_a_name)}
          />
        </div>
        <div className="flex-shrink-0 flex items-center gap-0.5 ml-1 pt-0.5">
          {aWon && <span className="text-green-600 text-xs">✓</span>}
          {inProgress && m.team_a_id && (
            <span className="text-red-400 animate-pulse" style={{ fontSize: 9 }}>●</span>
          )}
        </div>
      </div>

      {/* 팀 B */}
      <div
        className={`flex items-start px-2 py-1 ${
          bWon ? 'bg-green-50' : aWon && done ? 'bg-stone-50' : ''
        }`}
        style={{ flex: 1, minHeight: 0 }}
      >
        <div className="flex-1 min-w-0 overflow-hidden">
          {isBye
            ? <span className="text-stone-300 italic text-xs">BYE</span>
            : <TeamRow
                raw={m.team_b_name}
                won={bWon}
                muted={aWon && done}
                tbd={!m.team_b_name || m.team_b_name === 'TBD'}
                candidates={getTbdCandidates(m.team_b_name)}
              />
          }
        </div>
        {bWon && <span className="text-green-600 flex-shrink-0 ml-1 text-xs pt-0.5">✓</span>}
      </div>

      {/* 점수 바 */}
      {done && !isBye && m.score && (
        <div
          className="flex items-center justify-center bg-green-50 border-t border-green-100 text-green-700 font-bold"
          style={{ height: 13, flexShrink: 0, fontSize: 10 }}
        >
          {m.score}
        </div>
      )}
      {isBye && (
        <div
          className="flex items-center justify-center bg-amber-50 border-t border-amber-100 text-amber-600 font-bold tracking-widest"
          style={{ height: 13, flexShrink: 0, fontSize: 9 }}
        >
          BYE
        </div>
      )}
    </div>
  )
}

// 선수명 우선 — 이름은 절대 안잘림, 클럽명만 ellipsis
function TeamRow({ raw, won, muted, tbd, candidates }: { raw?: string; won?: boolean; muted?: boolean; tbd?: boolean; candidates?: string[] }) {
  if (tbd || !raw) {
    if (candidates && candidates.length > 0) {
      return (
        <div className="flex items-start gap-1 min-w-0 flex-wrap">
          {candidates.map((name: string, i: number) => (
            <span key={i} className="text-[10px] text-stone-400 leading-tight whitespace-nowrap">
              {i > 0 && <span className="text-stone-200 mx-0.5">/</span>}{name}
            </span>
          ))}
        </div>
      )
    }
    return <span className="text-stone-300 italic text-xs">TBD</span>
  }
  const players = parsePlayers(raw)
  if (players.length === 0) {
    return <span className={`text-xs font-bold ${won ? 'text-green-800' : muted ? 'text-stone-300' : 'text-stone-800'}`}>{raw}</span>
  }
  return (
    <div className="flex items-start gap-1 min-w-0">
      {players.map((p, i) => (
        <div key={i} className="flex items-start gap-0.5 min-w-0 flex-1">
          {i > 0 && <span className="text-stone-300 text-[10px] flex-shrink-0 pt-px">/</span>}
          <div className="min-w-0 flex-1">
            {/* 이름: overflow visible, 절대 안잘림 */}
            <div className={`text-xs font-bold leading-tight whitespace-nowrap ${
              won ? 'text-green-800' : muted ? 'text-stone-300' : 'text-stone-800'
            }`}>
              {p.name}
            </div>
            {/* 클럽명: 공간 부족하면 ellipsis */}
            {p.club && (
              <div className={`text-[10px] leading-tight truncate ${
                won ? 'text-green-600' : muted ? 'text-stone-200' : 'text-stone-400'
              }`}>
                {p.club}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
