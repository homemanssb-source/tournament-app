// ============================================================
// 단체전 토너먼트 브래킷 페이지
// src/app/dashboard/teams/bracket/page.tsx
// ✅ 부서별 division_id 필터 수정본
// ============================================================
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  fetchClubs, fetchTies, fetchEventTeamConfig, generateTeamTournament,
} from '@/lib/team-api';
import { supabase } from '@/lib/supabase';
import { getRoundLabel, getTieStatusColor, getTieStatusLabel, calculateBracket } from '@/lib/team-utils';
import type { Club, TieWithClubs, EventTeamConfig } from '@/types/team';

interface Division { id: string; name: string; sort_order: number; }

const ROUND_ORDER = ['round_of_16', 'quarter', 'semi', 'final'];

export default function BracketPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [clubs, setClubs] = useState<Club[]>([]);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [divisions, setDivisions] = useState<Division[]>([]);
  const [selectedDiv, setSelectedDiv] = useState<string>('');

  // ✅ 선택된 부서의 클럽만 필터
  const filteredClubs = useMemo(() => {
    if (!selectedDiv) return clubs;
    return clubs.filter(c => (c as any).division_id === selectedDiv);
  }, [clubs, selectedDiv]);

  // ✅ 선택된 부서의 ties만 필터
  const filteredTies = useMemo(() => {
    if (!selectedDiv) return ties;
    return ties.filter(t => (t as any).division_id === selectedDiv);
  }, [ties, selectedDiv]);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    // 부서 먼저 로드
    const { data: divs } = await supabase
      .from('divisions').select('id, name, sort_order')
      .eq('event_id', eventId).order('sort_order');
    const divList = divs || [];
    setDivisions(divList);

    // 첫 부서 자동 선택
    if (divList.length > 0) {
      setSelectedDiv(prev => prev || divList[0].id);
    }

    const [clubList, cfg, tieList] = await Promise.all([
      fetchClubs(eventId),
      fetchEventTeamConfig(eventId),
      fetchTies(eventId),
    ]);
    setClubs(clubList);
    setConfig(cfg);
    setTies(tieList);
    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  // 토너먼트 ties만 (해당 부서)
  const tournamentTies = filteredTies.filter(t =>
    ['round_of_16', 'quarter', 'semi', 'final'].includes(t.round || '')
  );
  const hasTournament = tournamentTies.length > 0;

  const tiesByRound: Record<string, TieWithClubs[]> = {};
  tournamentTies.forEach(t => {
    const r = t.round || '';
    if (!tiesByRound[r]) tiesByRound[r] = [];
    tiesByRound[r].push(t);
  });

  const sortedRounds = ROUND_ORDER.filter(r => tiesByRound[r]);

  const seededClubs = filteredClubs
    .filter(c => c.seed_number)
    .sort((a, b) => (a.seed_number || 0) - (b.seed_number || 0));

  const { bracketSize, byeCount } = calculateBracket(filteredClubs.length);

  async function handleGenerate() {
    const seeded = seededClubs.map(c => ({ club_id: c.id, seed_number: c.seed_number! }));

    if (!confirm(
      `${filteredClubs.length}팀 토너먼트를 생성합니다.\n` +
      `브래킷: ${bracketSize}강\n` +
      `바이: ${byeCount}개\n` +
      `시드: ${seeded.length}개\n\n계속하시겠습니까?`
    )) return;

    setGenerating(true);
    try {
      // ✅ divisionId 전달
      const result = await generateTeamTournament(
        eventId,
        seeded,
        selectedDiv || undefined
      );
      if (!result.success) { alert(result.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '토너먼트 생성 실패');
    } finally {
      setGenerating(false);
    }
  }

  function getWinnerName(tie: TieWithClubs): string {
    if (!tie.winning_club_id) return '';
    if (tie.winning_club_id === tie.club_a_id) return tie.club_a?.name || '';
    if (tie.winning_club_id === tie.club_b_id) return tie.club_b?.name || '';
    return '';
  }

  if (loading) return <div className="p-8 text-center text-gray-500">불러오는 중...</div>;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏆 단체전 토너먼트 브래킷</h1>
        <span className="text-sm text-gray-500">{filteredClubs.length}팀</span>
      </div>

      {/* ✅ 부서 탭 */}
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

      {/* 생성 버튼 */}
      {filteredClubs.length >= 2 && (
        <div className="bg-white rounded-lg border p-6 space-y-3">
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

          {seededClubs.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {seededClubs.map(c => (
                <span key={c.id} className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                  {c.seed_number}시드: {c.name}
                  {byeCount > 0 && c.seed_number! <= byeCount ? ' (BYE)' : ''}
                </span>
              ))}
            </div>
          )}

          {hasTournament && (
            <p className="text-xs text-red-500">재생성하면 기존 토너먼트가 모두 초기화됩니다.</p>
          )}
        </div>
      )}

      {/* 브래킷 표시 */}
      {hasTournament && (
        <div className="bg-white rounded-lg border p-6 overflow-x-auto">
          <div className="flex gap-8 min-w-max">
            {sortedRounds.map((round, roundIdx) => {
              const roundTies = (tiesByRound[round] || []).sort(
                (a, b) => (a.bracket_position || 0) - (b.bracket_position || 0)
              );
              const gapMultiplier = Math.pow(2, roundIdx);

              return (
                <div key={round} className="flex flex-col" style={{ minWidth: 220 }}>
                  <div className="text-center mb-4">
                    <span className="text-sm font-semibold text-gray-600 bg-gray-100 px-3 py-1 rounded">
                      {getRoundLabel(round)}
                    </span>
                  </div>
                  <div className="flex flex-col justify-around flex-1" style={{ gap: `${gapMultiplier * 16}px` }}>
                    {roundTies.map(tie => (
                      <div key={tie.id}
                        className={`border rounded-lg overflow-hidden ${
                          tie.status === 'completed' ? 'border-green-300' :
                          tie.is_bye ? 'border-gray-200 bg-gray-50' : 'border-gray-200'
                        }`} style={{ minHeight: 72 }}>
                        <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                          tie.winning_club_id === tie.club_a_id ? 'bg-green-50 font-bold' : ''
                        }`}>
                          <div className="flex items-center gap-1.5">
                            {tie.club_a?.seed_number && (
                              <span className="text-xs text-yellow-600">[{tie.club_a.seed_number}]</span>
                            )}
                            <span>{tie.club_a?.name || (tie.is_bye && !tie.club_a_id ? 'BYE' : 'TBD')}</span>
                          </div>
                          {tie.status === 'completed' && <span className="font-medium">{tie.club_a_rubbers_won}</span>}
                        </div>
                        <div className="border-t" />
                        <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                          tie.winning_club_id === tie.club_b_id ? 'bg-green-50 font-bold' : ''
                        }`}>
                          <div className="flex items-center gap-1.5">
                            {tie.club_b?.seed_number && (
                              <span className="text-xs text-yellow-600">[{tie.club_b.seed_number}]</span>
                            )}
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
                    ))}
                  </div>
                </div>
              );
            })}

            {/* 최종 우승 */}
            <div className="flex flex-col justify-center" style={{ minWidth: 150 }}>
              <div className="text-center mb-4">
                <span className="text-sm font-semibold text-yellow-600 bg-yellow-50 px-3 py-1 rounded">🏆 최종 우승</span>
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
        <div className="text-center text-gray-400 py-8">토너먼트가 아직 생성되지 않았습니다. 위 버튼으로 생성하세요.</div>
      )}
      {filteredClubs.length < 2 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          최소 2팀 이상 등록해야 토너먼트 생성이 가능합니다.
        </div>
      )}
    </div>
  );
}
