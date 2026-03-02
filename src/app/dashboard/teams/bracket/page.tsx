// ============================================================
// 토너먼트 브래킷
// src/app/dashboard/team/bracket/page.tsx
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  fetchClubs, fetchTies, fetchEventTeamConfig, generateTeamTournament,
} from '@/lib/team-api';
import { getRoundLabel, getTieStatusColor, getTieStatusLabel, calculateBracket } from '@/lib/team-utils';
import type { Club, TieWithClubs, EventTeamConfig } from '@/types/team';

const ROUND_ORDER = ['round_of_16', 'quarter', 'semi', 'final'];

export default function BracketPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const eventId = searchParams.get('event_id') || '';

  const [clubs, setClubs] = useState<Club[]>([]);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
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

  // 토너먼트 대전만 필터
  const tournamentTies = ties.filter(t =>
    ['round_of_16', 'quarter', 'semi', 'final'].includes(t.round || '')
  );
  const hasTournament = tournamentTies.length > 0;

  // 라운드별 그룹핑
  const tiesByRound: Record<string, TieWithClubs[]> = {};
  tournamentTies.forEach(t => {
    const r = t.round || '';
    if (!tiesByRound[r]) tiesByRound[r] = [];
    tiesByRound[r].push(t);
  });

  // 정렬된 라운드
  const sortedRounds = ROUND_ORDER.filter(r => tiesByRound[r]);

  // 시드 클럽 목록
  const seededClubs = clubs
    .filter(c => c.seed_number)
    .sort((a, b) => (a.seed_number || 0) - (b.seed_number || 0));

  // 브래킷 정보
  const { bracketSize, byeCount } = calculateBracket(clubs.length);

  async function handleGenerate() {
    const seeded = seededClubs.map(c => ({ club_id: c.id, seed_number: c.seed_number! }));

    if (!confirm(
      `${clubs.length}팀 토너먼트를 생성합니다.\n` +
      `브래킷: ${bracketSize}강\n` +
      `바이: ${byeCount}팀\n` +
      `시드: ${seeded.length}팀\n\n진행하시겠습니까?`
    )) return;

    setGenerating(true);
    try {
      const result = await generateTeamTournament(eventId, seeded);
      if (!result.success) { alert(result.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '토너먼트 생성 실패');
    } finally {
      setGenerating(false);
    }
  }

  // 승자 찾기
  function getWinnerName(tie: TieWithClubs): string {
    if (!tie.winning_club_id) return '';
    if (tie.winning_club_id === tie.club_a_id) return tie.club_a?.name || '';
    if (tie.winning_club_id === tie.club_b_id) return tie.club_b?.name || '';
    return '';
  }

  if (loading) return <div className="p-8 text-center text-gray-500">로딩중...</div>;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏅 토너먼트 브래킷</h1>
        <span className="text-sm text-gray-500">{clubs.length}팀</span>
      </div>

      {/* 생성 버튼 */}
      {clubs.length >= 2 && (
        <div className="bg-white rounded-lg border p-6 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">토너먼트 생성</h2>
              <p className="text-sm text-gray-500 mt-1">
                {clubs.length}팀 → {bracketSize}강 브래킷 · 바이 {byeCount}팀
              </p>
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {generating ? '생성중...' : hasTournament ? '토너먼트 재생성' : '토너먼트 생성'}
            </button>
          </div>

          {/* 시드/바이 안내 */}
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
            <p className="text-xs text-red-500">⚠️ 재생성 시 기존 토너먼트 대전/스코어가 초기화됩니다.</p>
          )}
        </div>
      )}

      {/* ── 브래킷 표시 ── */}
      {hasTournament && (
        <div className="bg-white rounded-lg border p-6 overflow-x-auto">
          <div className="flex gap-8 min-w-max">
            {sortedRounds.map((round, roundIdx) => {
              const roundTies = (tiesByRound[round] || []).sort(
                (a, b) => (a.bracket_position || 0) - (b.bracket_position || 0)
              );
              // 라운드가 진행될수록 간격 증가
              const gapMultiplier = Math.pow(2, roundIdx);

              return (
                <div key={round} className="flex flex-col" style={{ minWidth: 220 }}>
                  {/* 라운드 헤더 */}
                  <div className="text-center mb-4">
                    <span className="text-sm font-semibold text-gray-600 bg-gray-100 px-3 py-1 rounded">
                      {getRoundLabel(round)}
                    </span>
                  </div>

                  {/* 대전 카드들 */}
                  <div className="flex flex-col justify-around flex-1" style={{ gap: `${gapMultiplier * 16}px` }}>
                    {roundTies.map(tie => (
                      <div
                        key={tie.id}
                        className={`border rounded-lg overflow-hidden ${
                          tie.status === 'completed' ? 'border-green-300' :
                          tie.is_bye ? 'border-gray-200 bg-gray-50' : 'border-gray-200'
                        }`}
                        style={{ minHeight: 72 }}
                      >
                        {/* Club A */}
                        <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                          tie.winning_club_id === tie.club_a_id ? 'bg-green-50 font-bold' : ''
                        }`}>
                          <div className="flex items-center gap-1.5">
                            {tie.club_a?.seed_number && (
                              <span className="text-xs text-yellow-600">[{tie.club_a.seed_number}]</span>
                            )}
                            <span>{tie.club_a?.name || (tie.is_bye && !tie.club_a_id ? 'BYE' : 'TBD')}</span>
                          </div>
                          {tie.status === 'completed' && (
                            <span className="font-medium">{tie.club_a_rubbers_won}</span>
                          )}
                        </div>

                        {/* 구분선 */}
                        <div className="border-t" />

                        {/* Club B */}
                        <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                          tie.winning_club_id === tie.club_b_id ? 'bg-green-50 font-bold' : ''
                        }`}>
                          <div className="flex items-center gap-1.5">
                            {tie.club_b?.seed_number && (
                              <span className="text-xs text-yellow-600">[{tie.club_b.seed_number}]</span>
                            )}
                            <span>{tie.club_b?.name || (tie.is_bye && !tie.club_b_id ? 'BYE' : 'TBD')}</span>
                          </div>
                          {tie.status === 'completed' && (
                            <span className="font-medium">{tie.club_b_rubbers_won}</span>
                          )}
                        </div>

                        {/* 바이 표시 */}
                        {tie.is_bye && (
                          <div className="bg-gray-100 text-center py-0.5">
                            <span className="text-xs text-gray-500">부전승</span>
                          </div>
                        )}

                        {/* 상태 표시 */}
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

            {/* 우승 표시 */}
            <div className="flex flex-col justify-center" style={{ minWidth: 150 }}>
              <div className="text-center mb-4">
                <span className="text-sm font-semibold text-yellow-600 bg-yellow-50 px-3 py-1 rounded">
                  🏆 우승
                </span>
              </div>
              <div className="flex flex-col justify-center flex-1">
                {(() => {
                  const finalTie = tiesByRound['final']?.[0];
                  if (finalTie?.winning_club_id) {
                    const name = getWinnerName(finalTie);
                    return (
                      <div className="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4 text-center">
                        <div className="text-2xl mb-1">🏆</div>
                        <div className="font-bold text-lg">{name}</div>
                      </div>
                    );
                  }
                  return (
                    <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center text-gray-400">
                      ?
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {!hasTournament && clubs.length >= 2 && (
        <div className="text-center text-gray-400 py-8">
          토너먼트가 아직 생성되지 않았습니다. 위 버튼으로 생성하세요.
        </div>
      )}

      {clubs.length < 2 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          최소 2팀 이상 등록해야 토너먼트 생성이 가능합니다.
        </div>
      )}
    </div>
  );
}
