'use client'

interface BracketMatch {
  match_id?: string; match_num?: string; round?: string; slot?: number
  team_a_id?: string; team_b_id?: string; team_a_name?: string; team_b_name?: string
  winner_team_id?: string; winner_name?: string; score?: string; status?: string
  next_match_id?: string; next_slot?: string
}

// ✅ 한국어 round 값 순서 (DB size_to_round() 반환값 기준)
const ROUND_ORDER = [
  '본선128강', '본선64강', '본선32강',
  '16강', '8강', '4강', '결승'
]

const CARD_H = 64
const MIN_GAP = 8

// 라운드 수에 따라 카드 너비 결정
function getCardWidth(roundCount: number): number {
  if (roundCount >= 6) return 160  // 64강 이상
  if (roundCount >= 5) return 175  // 32강
  if (roundCount >= 4) return 190  // 16강
  return 210                        // 8강 이하
}

export default function TournamentBracket({ matches }: { matches: BracketMatch[] }) {
  const byRound = new Map<string, BracketMatch[]>()
  for (const m of matches) {
    const r = m.round || ''
    if (!byRound.has(r)) byRound.set(r, [])
    byRound.get(r)!.push(m)
  }
  for (const arr of byRound.values()) arr.sort((a, b) => (a.slot || 0) - (b.slot || 0))

  const rounds = ROUND_ORDER.filter(r => byRound.has(r))
  if (!rounds.length) return <p className="text-center py-10 text-stone-400">토너먼트 데이터가 없습니다.</p>

  const firstRoundCount = (byRound.get(rounds[0]) || []).length
  const totalHeight = firstRoundCount * (CARD_H + MIN_GAP) + 60
  const CARD_W = getCardWidth(rounds.length)
  const totalWidth = rounds.length * (CARD_W + 10)

  return (
    <div className="w-full">
      {/* ✅ 라운드 헤더 — overflow-x-auto 와 동기화된 sticky 헤더 */}
      <div className="overflow-x-auto" id="bracket-header-scroll">
        <div className="flex" style={{ minWidth: totalWidth }}>
          {rounds.map(round => (
            <div key={round} style={{ width: CARD_W + 10, flexShrink: 0 }}
              className="text-center py-2 font-bold text-xs text-stone-600 bg-stone-100 border-b border-stone-200 sticky top-0 z-20">
              {round}
            </div>
          ))}
        </div>
      </div>

      {/* ✅ 브래킷 본체 */}
      <div className="overflow-x-auto pb-6" onScroll={e => {
        // 헤더와 본체 스크롤 동기화
        const header = document.getElementById('bracket-header-scroll')
        if (header) header.scrollLeft = (e.target as HTMLElement).scrollLeft
      }}>
        <div className="relative flex" style={{ minWidth: totalWidth, height: Math.max(totalHeight, 300) }}>
          {rounds.map((round, rIdx) => {
            const roundMatches = byRound.get(round) || []
            const count = roundMatches.length
            const positions = calcPositions(rIdx, count, firstRoundCount, totalHeight)

            return (
              <div key={round} className="flex-shrink-0 relative" style={{ width: CARD_W + 10 }}>
                {roundMatches.map((m, mIdx) => (
                  <div
                    key={m.match_id || mIdx}
                    className="absolute"
                    style={{ top: positions[mIdx], left: 5, right: 5 }}
                  >
                    <MatchCard m={m} />
                    {/* 오른쪽 수평선 */}
                    {rIdx < rounds.length - 1 && (
                      <div
                        className="absolute top-1/2 border-t-2 border-stone-300"
                        style={{ right: -10, width: 10, transform: 'translateY(-50%)' }}
                      />
                    )}
                    {/* 왼쪽 수평선 */}
                    {rIdx > 0 && (
                      <div
                        className="absolute top-1/2 border-t-2 border-stone-300"
                        style={{ left: -10, width: 10, transform: 'translateY(-50%)' }}
                      />
                    )}
                  </div>
                ))}

                {/* 수직 연결선 */}
                {rIdx > 0 && roundMatches.map((m, mIdx) => {
                  const prevCount = (byRound.get(rounds[rIdx - 1]) || []).length
                  const prevPositions = calcPositions(rIdx - 1, prevCount, firstRoundCount, totalHeight)
                  const prevTop    = prevPositions[mIdx * 2]
                  const prevBottom = prevPositions[mIdx * 2 + 1]
                  if (prevTop === undefined || prevBottom === undefined) return null
                  const lineTop    = prevTop    + CARD_H / 2
                  const lineBottom = prevBottom + CARD_H / 2
                  return (
                    <div
                      key={`vline-${mIdx}`}
                      className="absolute border-l-2 border-stone-300"
                      style={{ left: 4, top: lineTop, height: lineBottom - lineTop }}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function calcPositions(roundIdx: number, count: number, firstRoundCount: number, totalHeight: number): number[] {
  if (roundIdx === 0) {
    const spacing = (totalHeight - 60) / Math.max(count, 1)
    return Array.from({ length: count }, (_, i) => i * spacing + (spacing - CARD_H) / 2)
  }
  const prevCount = count * 2
  const prevPositions = calcPositions(roundIdx - 1, prevCount, firstRoundCount, totalHeight)
  const positions: number[] = []
  for (let i = 0; i < count; i++) {
    const top    = prevPositions[i * 2]     ?? 0
    const bottom = prevPositions[i * 2 + 1] ?? top
    positions.push((top + bottom) / 2)
  }
  return positions
}

function MatchCard({ m }: { m: BracketMatch }) {
  const isBye       = m.score === 'BYE'
  const done        = m.status === 'FINISHED'
  const inProgress  = m.status === 'IN_PROGRESS'
  const aWon        = !!(m.winner_team_id && m.winner_team_id === m.team_a_id)
  const bWon        = !!(m.winner_team_id && m.winner_team_id === m.team_b_id)

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden shadow-sm ${
        inProgress  ? 'border-red-400 ring-1 ring-red-200' :
        done && !isBye ? 'border-green-400 bg-white' :
        isBye       ? 'border-amber-200 bg-amber-50/30' :
                      'border-stone-200 bg-white'
      }`}
      style={{ height: CARD_H }}
    >
      {/* Team A */}
      <div className={`flex items-center justify-between px-2.5 h-[26px] border-b border-stone-100 ${
        aWon ? 'bg-blue-50 font-bold text-blue-800' :
        bWon && done ? 'text-stone-300' : ''
      }`}>
        <span className={`truncate flex-1 ${
          !m.team_a_name || m.team_a_name === 'TBD' ? 'text-stone-300 italic' : ''
        }`}>
          {aWon && '🏆 '}{m.team_a_name || 'TBD'}
        </span>
        {inProgress && m.team_a_id && <span className="text-red-400 ml-1 animate-pulse text-[10px]">●</span>}
      </div>

      {/* Team B */}
      <div className={`flex items-center justify-between px-2.5 h-[26px] ${
        bWon ? 'bg-blue-50 font-bold text-blue-800' :
        aWon && done ? 'text-stone-300' : ''
      }`}>
        <span className={`truncate flex-1 ${
          !m.team_b_name || m.team_b_name === 'TBD' || isBye ? 'text-stone-300 italic' : ''
        }`}>
          {bWon && '🏆 '}{isBye ? 'BYE' : (m.team_b_name || 'TBD')}
        </span>
      </div>

      {/* Score bar */}
      {done && !isBye && m.score && (
        <div className="text-center h-[12px] leading-[12px] bg-green-50 text-green-700 font-bold text-[10px] border-t border-stone-100">
          {m.score}
        </div>
      )}
      {isBye && (
        <div className="text-center h-[12px] leading-[12px] bg-amber-50 text-amber-500 font-medium text-[10px] border-t border-stone-100">
          BYE
        </div>
      )}
    </div>
  )
}