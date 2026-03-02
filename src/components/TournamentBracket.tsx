'use client'
import { useRef, useEffect, useState } from 'react'

interface BracketMatch {
  match_id?: string; match_num?: string; round?: string; slot?: number
  team_a_id?: string; team_b_id?: string; team_a_name?: string; team_b_name?: string
  winner_team_id?: string; winner_name?: string; score?: string; status?: string
  next_match_id?: string; next_slot?: string
}

const ROUND_ORDER = ['본선128강', '본선64강', '본선32강', '16강', '8강', '4강', '결승']

// 카드 높이 상수
const CARD_H = 64  // 매치 카드 높이 (px)
const MIN_GAP = 12 // 최소 간격

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

  // 1회전 경기 수로 전체 높이 계산
  const firstRoundCount = (byRound.get(rounds[0]) || []).length
  const totalHeight = firstRoundCount * CARD_H + (firstRoundCount - 1) * MIN_GAP + 60 // +60 여유

  return (
    <div className="overflow-x-auto pb-6">
      <div className="relative flex" style={{ minWidth: rounds.length * 210, height: Math.max(totalHeight, 300) }}>
        {rounds.map((round, rIdx) => {
          const roundMatches = byRound.get(round) || []
          const count = roundMatches.length

          // 이 라운드의 각 매치 Y 위치 계산
          // 1회전: 균등 분배
          // 2회전 이후: 이전 두 경기의 중앙
          const positions = calcPositions(rIdx, count, firstRoundCount, totalHeight)

          return (
            <div key={round} className="flex-shrink-0 relative" style={{ width: 200 }}>
              {/* 라운드 헤더 */}
              <div className="text-center font-bold text-xs text-stone-500 uppercase mb-0 py-1 bg-stone-100 rounded sticky top-0 z-10">
                {round}
              </div>
              {/* 경기 카드 (절대 위치) */}
              {roundMatches.map((m, mIdx) => (
                <div
                  key={m.match_id}
                  className="absolute left-1 right-1"
                  style={{ top: positions[mIdx] + 28 }} // +28 = 헤더 높이
                >
                  <MatchCard m={m} />
                  {/* 오른쪽 연결선 (다음 라운드로) */}
                  {rIdx < rounds.length - 1 && (
                    <div
                      className="absolute top-1/2 -right-[11px] w-[10px] border-t-2 border-stone-300"
                      style={{ transform: 'translateY(-50%)' }}
                    />
                  )}
                  {/* 왼쪽 연결선 (이전 라운드에서) */}
                  {rIdx > 0 && (
                    <div
                      className="absolute top-1/2 -left-[11px] w-[10px] border-t-2 border-stone-300"
                      style={{ transform: 'translateY(-50%)' }}
                    />
                  )}
                </div>
              ))}
              {/* 세로 연결선 (이전 라운드 두 경기를 잇는) */}
              {rIdx > 0 && roundMatches.map((m, mIdx) => {
                const prevPositions = calcPositions(rIdx - 1, (byRound.get(rounds[rIdx - 1]) || []).length, firstRoundCount, totalHeight)
                const prevTop = prevPositions[mIdx * 2]
                const prevBottom = prevPositions[mIdx * 2 + 1]
                if (prevTop === undefined || prevBottom === undefined) return null
                const lineTop = prevTop + CARD_H / 2 + 28
                const lineBottom = prevBottom + CARD_H / 2 + 28
                return (
                  <div
                    key={`vline-${mIdx}`}
                    className="absolute border-l-2 border-stone-300"
                    style={{
                      left: -1,
                      top: lineTop,
                      height: lineBottom - lineTop,
                    }}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 라운드별 Y 위치 계산
function calcPositions(roundIdx: number, count: number, firstRoundCount: number, totalHeight: number): number[] {
  if (roundIdx === 0) {
    // 1회전: 균등 분배
    const spacing = (totalHeight - 60) / Math.max(count, 1)
    return Array.from({ length: count }, (_, i) => i * spacing + (spacing - CARD_H) / 2)
  }

  // 2회전 이후: 이전 두 경기의 중앙
  const prevCount = count * 2
  const prevPositions = calcPositions(roundIdx - 1, prevCount, firstRoundCount, totalHeight)
  const positions: number[] = []
  for (let i = 0; i < count; i++) {
    const top = prevPositions[i * 2] || 0
    const bottom = prevPositions[i * 2 + 1] || top
    // 두 경기의 중앙
    positions.push((top + bottom) / 2)
  }
  return positions
}

function MatchCard({ m }: { m: BracketMatch }) {
  const isBye = m.score === 'BYE'
  const done = m.status === 'FINISHED'
  const inProgress = m.status === 'IN_PROGRESS'
  const aWon = m.winner_team_id && m.winner_team_id === m.team_a_id
  const bWon = m.winner_team_id && m.winner_team_id === m.team_b_id

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden shadow-sm ${
        inProgress ? 'border-red-400 ring-1 ring-red-200' :
        done && !isBye ? 'border-tennis-400 bg-white' :
        isBye ? 'border-amber-200 bg-amber-50/30' :
        'border-stone-200 bg-white'
      }`}
      style={{ height: CARD_H }}
    >
      {/* Team A */}
      <div className={`flex items-center justify-between px-2.5 h-[26px] border-b border-stone-100 ${
        aWon ? 'bg-tennis-50 font-bold text-tennis-800' : ''
      }`}>
        <span className={`truncate flex-1 ${
          !m.team_a_name || m.team_a_name === 'TBD' ? 'text-stone-300 italic' : ''
        }`}>
          {m.team_a_name || 'TBD'}
        </span>
        {aWon && <span className="text-tennis-600 ml-1 text-[10px]">●</span>}
        {inProgress && m.team_a_id && <span className="text-red-400 ml-1 animate-pulse text-[10px]">●</span>}
      </div>
      {/* Team B */}
      <div className={`flex items-center justify-between px-2.5 h-[26px] ${
        bWon ? 'bg-tennis-50 font-bold text-tennis-800' : ''
      }`}>
        <span className={`truncate flex-1 ${
          !m.team_b_name || m.team_b_name === 'TBD' || isBye ? 'text-stone-300 italic' : ''
        }`}>
          {isBye ? 'BYE' : (m.team_b_name || 'TBD')}
        </span>
        {bWon && <span className="text-tennis-600 ml-1 text-[10px]">●</span>}
      </div>
      {/* Score bar */}
      {done && !isBye && m.score && (
        <div className="text-center h-[12px] leading-[12px] bg-tennis-50 text-tennis-700 font-bold text-[10px] border-t border-stone-100">
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
