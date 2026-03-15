// ============================================================
// src/app/dashboard/teams/bracket/page.tsx
// ✅ 조별 1위 랜덤 셔플 → 시드 배정
// ✅ 시드 슬롯 상하 교차
//    1시드→슬롯1(상단↑), 2시드→슬롯N(하단↓)
//    3시드→슬롯2(상단↑), 4시드→슬롯N-1(하단↓) ...
// ✅ 같은 조 2위 → 1위 반대 구역 (결승 전 재대결 없음)
// ✅ BYE 배치 우선순위: 1위 먼저 → 남으면 2위 → 나머지
// ✅ BYE 상단/하단 균등 (SQL에서 처리)
// ✅ 본선 1라운드 1위끼리 절대 안 만남
// ============================================================
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  fetchClubs, fetchTies, fetchEventTeamConfig,
  generateTeamTournament, fetchStandings,
} from '@/lib/team-api';
import { supabase } from '@/lib/supabase';
import {
  getRoundLabel, getTieStatusColor, getTieStatusLabel, calculateBracket,
} from '@/lib/team-utils';
import type { Club, TieWithClubs, EventTeamConfig, StandingWithClub } from '@/types/team';

interface Division { id: string; name: string; sort_order: number; }

const ROUND_ORDER = ['round_of_16', 'quarter', 'semi', 'final'];

// ── 시드 슬롯 맵 ──────────────────────────────────────────────
// 시드번호 → 슬롯번호 (1-indexed)
// 홀수시드 → 상단(1,2,3...), 짝수시드 → 하단(N,N-1,N-2...)
function buildSeedSlotMap(n: number): number[] {
  // index = 시드번호(1~n), value = 슬롯번호
  const map = new Array(n + 1).fill(0);
  let top = 1, bot = n;
  for (let s = 1; s <= n; s++) {
    if (s % 2 === 1) map[s] = top++;
    else             map[s] = bot--;
  }
  return map;
}

// ── 자동 시드 계산 ────────────────────────────────────────────
// BYE 우선순위: 1위 → 2위 → 나머지
// 배치 순서:
//   1위들 랜덤 셔플 → 시드1,2,3,4 배정 (시드 슬롯 맵으로 슬롯 결정)
//   각 1위의 같은 조 2위 → 1위 슬롯의 정반대 슬롯에 배치
//   남은 슬롯은 BYE (비시드 나머지는 SQL에서 채움)
function buildAutoSeeds(
  sortedGroups: { id: string; name: string }[],
  standingsMap: Record<string, StandingWithClub[]>,
  bracketSize: number,
  byeCount: number,
): { club_id: string; seed_number: number }[] {
  const seedSlotMap = buildSeedSlotMap(bracketSize);

  // slot → seed 역맵
  const slotToSeed: Record<number, number> = {};
  for (let s = 1; s <= bracketSize; s++) slotToSeed[seedSlotMap[s]] = s;

  const result: { club_id: string; seed_number: number }[] = [];
  const usedSeeds = new Set<number>();
  const usedClubs = new Set<string>();

  // ── 1위 추출 후 랜덤 셔플 ──
  const winners = sortedGroups
    .map(g => ({ group: g, entry: (standingsMap[g.id] || [])[0] }))
    .filter(w => w.entry?.club_id);

  // Fisher-Yates shuffle
  for (let i = winners.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [winners[i], winners[j]] = [winners[j], winners[i]];
  }

  // ── 1위 → 시드 1,2,3... 배정 ──
  winners.forEach((w, idx) => {
    const seed = idx + 1;
    if (seed > bracketSize) return;
    result.push({ club_id: w.entry.club_id!, seed_number: seed });
    usedSeeds.add(seed);
    usedClubs.add(w.entry.club_id!);
  });

  // ── 같은 조 2위 → 1위 반대 슬롯에 배치 ──
  // 1위 슬롯 S → 반대 슬롯 = bracketSize + 1 - S
  winners.forEach((w, idx) => {
    const winnerSeed = idx + 1;
    if (winnerSeed > bracketSize) return;
    const winnerSlot   = seedSlotMap[winnerSeed];
    const oppositeSlot = bracketSize + 1 - winnerSlot;
    const runnerSeed   = slotToSeed[oppositeSlot];
    if (!runnerSeed || usedSeeds.has(runnerSeed)) return;

    // 같은 조 2위 찾기
    const runner = (standingsMap[w.group.id] || [])[1];
    if (!runner?.club_id || usedClubs.has(runner.club_id)) return;

    result.push({ club_id: runner.club_id, seed_number: runnerSeed });
    usedSeeds.add(runnerSeed);
    usedClubs.add(runner.club_id);
  });

  // ── 나머지(3위 이하, 남은 2위) → 빈 시드 순서대로 ──
  // BYE 우선순위: 1위 슬롯에 가까운 곳은 팀으로 채우고
  //               나머지 슬롯이 BYE가 되도록 맨 뒤 시드부터 채움
  const remainingClubs: string[] = [];
  for (const g of sortedGroups) {
    const standings = standingsMap[g.id] || [];
    for (let rank = 1; rank < standings.length; rank++) {
      const entry = standings[rank];
      if (!entry?.club_id) continue;
      if (usedClubs.has(entry.club_id)) continue;
      remainingClubs.push(entry.club_id);
    }
  }

  // 빈 시드 번호 중 뒤쪽부터 채움 (BYE가 앞쪽 = 시드권 슬롯에 오지 않도록)
  const emptySeeds: number[] = [];
  for (let s = 1; s <= bracketSize; s++) {
    if (!usedSeeds.has(s)) emptySeeds.push(s);
  }

  remainingClubs.forEach((clubId, idx) => {
    if (idx >= emptySeeds.length) return;
    result.push({ club_id: clubId, seed_number: emptySeeds[idx] });
    usedClubs.add(clubId);
  });

  return result.sort((a, b) => a.seed_number - b.seed_number);
}

export default function BracketPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [clubs, setClubs]               = useState<Club[]>([]);
  const [config, setConfig]             = useState<EventTeamConfig | null>(null);
  const [ties, setTies]                 = useState<TieWithClubs[]>([]);
  const [groups, setGroups]             = useState<{ id: string; name: string; division_id: string; group_num: number }[]>([]);
  const [standingsMap, setStandingsMap] = useState<Record<string, StandingWithClub[]>>({});
  const [loading, setLoading]           = useState(true);
  const [generating, setGenerating]     = useState(false);

  const [divisions, setDivisions]     = useState<Division[]>([]);
  const [selectedDiv, setSelectedDiv] = useState<string>('');

  const filteredClubs = useMemo(() =>
    selectedDiv ? clubs.filter(c => (c as any).division_id === selectedDiv) : clubs,
    [clubs, selectedDiv],
  );

  const filteredTies = useMemo(() =>
    selectedDiv ? ties.filter(t => (t as any).division_id === selectedDiv) : ties,
    [ties, selectedDiv],
  );

  const filteredGroups = useMemo(() =>
    groups
      .filter(g => !selectedDiv || g.division_id === selectedDiv)
      .sort((a, b) => a.group_num - b.group_num),
    [groups, selectedDiv],
  );

  // 현재 부서 조별 순위
  const divStandings = useMemo(() => {
    const m: Record<string, StandingWithClub[]> = {};
    for (const g of filteredGroups) {
      if (standingsMap[g.id]) m[g.id] = standingsMap[g.id];
    }
    return m;
  }, [filteredGroups, standingsMap]);

  const { bracketSize, byeCount } = calculateBracket(filteredClubs.length);

  // 자동 시드 계산 (미리보기 및 생성에 사용)
  const autoSeeds = useMemo(() =>
    buildAutoSeeds(filteredGroups, divStandings, bracketSize, byeCount),
    [filteredGroups, divStandings, bracketSize, byeCount],
  );

  // 시드 표시용 (club 정보 붙임)
  const seededDisplay = useMemo(() =>
    autoSeeds.map(s => {
      const club = filteredClubs.find(c => c.id === s.club_id);
      const group = filteredGroups.find(g =>
        (divStandings[g.id] || []).some(st => st.club_id === s.club_id),
      );
      const rankInGroup = group
        ? (divStandings[group.id] || []).findIndex(st => st.club_id === s.club_id) + 1
        : null;
      return { ...s, club, group, rankInGroup };
    }).filter(s => s.club),
    [autoSeeds, filteredClubs, filteredGroups, divStandings],
  );

  const seedSlotMap = buildSeedSlotMap(bracketSize);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const { data: divs } = await supabase
      .from('divisions').select('id, name, sort_order')
      .eq('event_id', eventId).order('sort_order');
    const divList = divs || [];
    setDivisions(divList);
    if (divList.length > 0) setSelectedDiv(prev => prev || divList[0].id);

    const [clubList, cfg, tieList, grpsRes] = await Promise.all([
      fetchClubs(eventId),
      fetchEventTeamConfig(eventId),
      fetchTies(eventId),
      supabase.from('groups')
        .select('id, name, division_id, group_num')
        .eq('event_id', eventId).order('group_num'),
    ]);

    const grps = (grpsRes.data || []) as { id: string; name: string; division_id: string; group_num: number }[];
    setClubs(clubList);
    setConfig(cfg);
    setTies(tieList);
    setGroups(grps);

    // 조별 순위 로드
    if (grps.length > 0) {
      const results = await Promise.all(grps.map(g => fetchStandings(eventId, g.id)));
      const map: Record<string, StandingWithClub[]> = {};
      grps.forEach((g, i) => { map[g.id] = results[i]; });
      setStandingsMap(map);
    }

    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  const tournamentTies = filteredTies.filter(t =>
    ['round_of_16', 'quarter', 'semi', 'final'].includes(t.round || ''),
  );
  const hasTournament = tournamentTies.length > 0;

  const tiesByRound: Record<string, TieWithClubs[]> = {};
  tournamentTies.forEach(t => {
    const r = t.round || '';
    if (!tiesByRound[r]) tiesByRound[r] = [];
    tiesByRound[r].push(t);
  });
  const sortedRounds = ROUND_ORDER.filter(r => tiesByRound[r]);

  async function handleGenerate() {
    const byeSeeds = autoSeeds
      .filter(s => s.seed_number <= byeCount)
      .map(s => {
        const group = filteredGroups.find(g =>
          (divStandings[g.id] || []).some(st => st.club_id === s.club_id),
        );
        const rank = group
          ? (divStandings[group.id] || []).findIndex(st => st.club_id === s.club_id) + 1
          : '-';
        return `  시드${s.seed_number} (${group?.name ?? ''} ${rank}위) → BYE`;
      });

    const preview = seededDisplay.slice(0, 8).map(s => {
      const slot  = seedSlotMap[s.seed_number];
      const pos   = slot <= bracketSize / 2 ? '▲상단' : '▼하단';
      const isBye = s.seed_number <= byeCount ? ' → BYE' : '';
      return `  ${s.seed_number}시드 ${pos}: ${s.club?.name}${isBye}`;
    }).join('\n');

    if (!confirm(
      `${filteredClubs.length}팀 토너먼트를 생성합니다.\n` +
      `브래킷: ${bracketSize}강  바이: ${byeCount}개\n\n` +
      (preview
        ? `【시드 배치】\n${preview}\n\n` +
          `1위들은 랜덤 추첨 후 상하 교차 배치\n같은 조 팀 → 반대 구역 (결승 전 재대결 없음)\n` +
          `BYE는 1위 먼저 배정, 상하 균등 분산`
        : '조별 순위 없음 — 랜덤 배치') +
      '\n\n계속하시겠습니까?',
    )) return;

    setGenerating(true);
    try {
      const result = await generateTeamTournament(
        eventId,
        autoSeeds,
        selectedDiv || undefined,
      );
      if (!result.success) { alert(result.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '토너먼트 생성 실패');
    } finally {
      setGenerating(false);
    }
  }

  function getWinnerName(tie: TieWithClubs) {
    if (!tie.winning_club_id) return '';
    return tie.winning_club_id === tie.club_a_id
      ? tie.club_a?.name || '' : tie.club_b?.name || '';
  }

  if (loading) return <div className="p-8 text-center text-gray-500">불러오는 중...</div>;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏆 단체전 토너먼트 브래킷</h1>
        <span className="text-sm text-gray-500">{filteredClubs.length}팀</span>
      </div>

      {/* 부서 탭 */}
      {divisions.length > 0 && (
        <div className="flex gap-1 overflow-x-auto">
          {divisions.map(d => (
            <button key={d.id} onClick={() => setSelectedDiv(d.id)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                selectedDiv === d.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{d.name}</button>
          ))}
        </div>
      )}

      {/* 생성 패널 */}
      {filteredClubs.length >= 2 && (
        <div className="bg-white rounded-lg border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">토너먼트 생성</h2>
              <p className="text-sm text-gray-500 mt-1">
                {filteredClubs.length}팀 → {bracketSize}강 브래킷 · 바이 {byeCount}개
              </p>
            </div>
            <button onClick={handleGenerate} disabled={generating}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {generating ? '생성 중...' : hasTournament ? '토너먼트 재생성' : '토너먼트 생성'}
            </button>
          </div>

          {/* 시드 배치 미리보기 */}
          {seededDisplay.length > 0 ? (
            <div className="border rounded-lg overflow-hidden text-sm">
              <div className="bg-yellow-50 px-3 py-2 text-xs font-semibold text-yellow-800 border-b">
                🌱 자동 시드 배치 미리보기
                <span className="ml-2 font-normal text-yellow-600">
                  (생성 시 1위 순서 랜덤 재추첨)
                </span>
              </div>
              <div className="divide-y">
                {seededDisplay.map(s => {
                  const slot  = seedSlotMap[s.seed_number];
                  const isTop = slot <= bracketSize / 2;
                  const isBye = s.seed_number <= byeCount;
                  return (
                    <div key={s.club_id}
                      className={`flex items-center justify-between px-3 py-2 ${isBye ? 'bg-gray-50' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="bg-yellow-100 text-yellow-700 font-bold text-xs px-2 py-0.5 rounded w-14 text-center">
                          {s.seed_number}시드
                        </span>
                        <span className={`font-medium ${isBye ? 'text-gray-400' : ''}`}>
                          {s.club?.name}
                        </span>
                        <span className="text-xs text-gray-400">
                          ({s.group?.name ?? ''} {s.rankInGroup}위)
                        </span>
                        {isBye && (
                          <span className="text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">BYE</span>
                        )}
                      </div>
                      <span className={`text-xs font-medium ${isTop ? 'text-blue-600' : 'text-orange-500'}`}>
                        {isTop ? '▲ 상단' : '▼ 하단'}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="bg-gray-50 px-3 py-1.5 text-xs text-gray-500 border-t">
                BYE는 1위 먼저 배정 · 상하 균등 분산 · 같은 조 팀은 반대 구역
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
              ⚠️ 조별 순위 데이터가 없습니다. 조별 리그를 먼저 진행해주세요.
            </div>
          )}

          {hasTournament && (
            <p className="text-xs text-red-500">⚠️ 재생성하면 기존 토너먼트가 모두 초기화됩니다.</p>
          )}
        </div>
      )}

      {/* 브래킷 표시 */}
      {hasTournament && (
        <div className="bg-white rounded-lg border p-6 overflow-x-auto">
          <div className="flex gap-8 min-w-max">
            {sortedRounds.map((round, roundIdx) => {
              const roundTies = (tiesByRound[round] || []).sort(
                (a, b) => (a.bracket_position || 0) - (b.bracket_position || 0),
              );
              const gap = Math.pow(2, roundIdx) * 16;
              return (
                <div key={round} className="flex flex-col" style={{ minWidth: 220 }}>
                  <div className="text-center mb-4">
                    <span className="text-sm font-semibold text-gray-600 bg-gray-100 px-3 py-1 rounded">
                      {getRoundLabel(round)}
                    </span>
                  </div>
                  <div className="flex flex-col justify-around flex-1" style={{ gap }}>
                    {roundTies.map(tie => {
                      const seedA = autoSeeds.find(s => s.club_id === tie.club_a_id)?.seed_number;
                      const seedB = autoSeeds.find(s => s.club_id === tie.club_b_id)?.seed_number;
                      return (
                        <div key={tie.id}
                          className={`border rounded-lg overflow-hidden ${
                            tie.status === 'completed' ? 'border-green-300' :
                            tie.is_bye ? 'border-gray-200 bg-gray-50' : 'border-gray-200'
                          }`} style={{ minHeight: 72 }}>
                          <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                            tie.winning_club_id === tie.club_a_id ? 'bg-green-50 font-bold' : ''
                          }`}>
                            <div className="flex items-center gap-1.5">
                              {seedA && <span className="text-xs text-yellow-600 font-medium">[{seedA}]</span>}
                              <span>{tie.club_a?.name || (tie.is_bye && !tie.club_a_id ? 'BYE' : 'TBD')}</span>
                            </div>
                            {tie.status === 'completed' && <span className="font-medium">{tie.club_a_rubbers_won}</span>}
                          </div>
                          <div className="border-t" />
                          <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                            tie.winning_club_id === tie.club_b_id ? 'bg-green-50 font-bold' : ''
                          }`}>
                            <div className="flex items-center gap-1.5">
                              {seedB && <span className="text-xs text-yellow-600 font-medium">[{seedB}]</span>}
                              <span>{tie.club_b?.name || (tie.is_bye && !tie.club_b_id ? 'BYE' : 'TBD')}</span>
                            </div>
                            {tie.status === 'completed' && <span className="font-medium">{tie.club_b_rubbers_won}</span>}
                          </div>
                          {tie.is_bye && (
                            <div className="bg-gray-100 text-center py-0.5">
                              <span className="text-xs text-gray-500">부전승</span>
                            </div>
                          )}
                          {!tie.is_bye && tie.status !== 'pending' && (
                            <div className="text-center py-0.5 border-t">
                              <span className={`text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>
                                {getTieStatusLabel(tie.status)}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* 최종 우승 */}
            <div className="flex flex-col justify-center" style={{ minWidth: 150 }}>
              <div className="text-center mb-4">
                <span className="text-sm font-semibold text-yellow-600 bg-yellow-50 px-3 py-1 rounded">
                  🏆 최종 우승
                </span>
              </div>
              <div className="flex flex-col justify-center flex-1">
                {(() => {
                  const finalTie = tiesByRound['final']?.[0];
                  if (finalTie?.winning_club_id) {
                    return (
                      <div className="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4 text-center">
                        <div className="text-2xl mb-1">🏆</div>
                        <div className="font-bold text-lg">{getWinnerName(finalTie)}</div>
                      </div>
                    );
                  }
                  return (
                    <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center text-gray-400">?</div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {!hasTournament && filteredClubs.length >= 2 && (
        <div className="text-center text-gray-400 py-8">
          토너먼트가 아직 생성되지 않았습니다. 위 버튼으로 생성하세요.
        </div>
      )}
      {filteredClubs.length < 2 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          최소 2팀 이상 등록해야 토너먼트 생성이 가능합니다.
        </div>
      )}
    </div>
  );
}