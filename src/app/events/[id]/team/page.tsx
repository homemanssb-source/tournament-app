// ============================================================
// 단체전 공개뷰 (관람객/참가자용)
// src/app/events/[id]/team/page.tsx
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchClubs, fetchTies, fetchStandings, fetchEventTeamConfig } from '@/lib/team-api';
import {
  getFormatLabel, getRoundLabel, getTieStatusLabel, getTieStatusColor,
  formatSetScore, getMajority, calculateBracket,
} from '@/lib/team-utils';
import type { Club, TieWithClubs, StandingWithClub, EventTeamConfig } from '@/types/team';

type Tab = 'standings' | 'matches' | 'bracket';

export default function TeamPublicViewPage() {
  const params = useParams();
  const eventId = params.id as string;

  const [event, setEvent] = useState<any>(null);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [standingsMap, setStandingsMap] = useState<Record<string, StandingWithClub[]>>({});
  const [tab, setTab] = useState<Tab>('standings');
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const { data: ev } = await supabase.from('events').select('*').eq('id', eventId).single();
    setEvent(ev);

    const [cfg, clubList, tieList] = await Promise.all([
      fetchEventTeamConfig(eventId),
      fetchClubs(eventId),
      fetchTies(eventId),
    ]);
    setConfig(cfg);
    setClubs(clubList);
    setTies(tieList);

    // 순위
    const map: Record<string, StandingWithClub[]> = {};
    if (cfg?.team_format === 'full_league') {
      map['full'] = await fetchStandings(eventId, null);
    } else {
      const { data: grps } = await supabase
        .from('groups')
        .select('*')
        .eq('event_id', eventId)
        .order('group_index');
      setGroups(grps || []);
      for (const g of (grps || [])) {
        map[g.id] = await fetchStandings(eventId, g.id);
      }
    }
    setStandingsMap(map);
    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  // 자동 새로고침 (30초)
  useEffect(() => {
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  // 대전 분류
  const leagueTies = ties.filter(t => t.round === 'full_league' || t.round === 'group');
  const tournamentTies = ties.filter(t => ['round_of_16', 'quarter', 'semi', 'final'].includes(t.round || ''));
  const liveTies = ties.filter(t => t.status === 'in_progress');

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-500">로딩중...</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-4 space-y-4">

        {/* 헤더 */}
        <div className="bg-white rounded-xl border p-6 text-center">
          <h1 className="text-2xl font-bold">{event?.name || '단체전'}</h1>
          <p className="text-gray-500 mt-1">
            {config ? getFormatLabel(config.team_format) : ''} · {clubs.length}팀 · {config?.team_rubber_count}복식
          </p>
        </div>

        {/* 실시간 경기 */}
        {liveTies.length > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4">
            <h2 className="font-semibold text-green-800 mb-2">🔴 진행중인 경기</h2>
            <div className="space-y-2">
              {liveTies.map(tie => (
                <div key={tie.id} className="bg-white rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <span className="font-medium">{tie.club_a?.name}</span>
                    <span className="text-gray-400 mx-2">vs</span>
                    <span className="font-medium">{tie.club_b?.name}</span>
                  </div>
                  <span className="text-lg font-bold text-green-700">
                    {tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 탭 */}
        <div className="flex bg-white rounded-xl border overflow-hidden">
          {(['standings', 'matches', 'bracket'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-3 text-sm font-medium transition ${
                tab === t ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t === 'standings' ? '📊 순위' : t === 'matches' ? '⚔️ 대전' : '🏅 토너먼트'}
            </button>
          ))}
        </div>

        {/* ── 순위 탭 ── */}
        {tab === 'standings' && (
          <div className="space-y-4">
            {Object.entries(standingsMap).map(([key, standings]) => {
              const title = key === 'full'
                ? '풀리그 순위'
                : groups.find(g => g.id === key)?.group_name || '';

              return (
                <div key={key} className="bg-white rounded-xl border overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 font-semibold text-sm">{title}</div>
                  <table className="w-full text-sm">
                    <thead className="border-t bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left w-12">#</th>
                        <th className="px-3 py-2 text-left">클럽</th>
                        <th className="px-3 py-2 text-center w-10">승</th>
                        <th className="px-3 py-2 text-center w-10">패</th>
                        <th className="px-3 py-2 text-center w-14">득실</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {standings.map(s => (
                        <tr key={s.id} className={s.is_tied ? 'bg-yellow-50' : ''}>
                          <td className="px-3 py-2 font-bold">
                            {s.rank ?? <span className="text-yellow-500 text-xs">⚠️</span>}
                          </td>
                          <td className="px-3 py-2 font-medium">
                            {s.club?.name}
                            {s.club?.seed_number && (
                              <span className="ml-1 text-xs text-yellow-600">[{s.club.seed_number}]</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center font-medium">{s.won}</td>
                          <td className="px-3 py-2 text-center">{s.lost}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={s.rubber_diff > 0 ? 'text-green-600' : s.rubber_diff < 0 ? 'text-red-600' : ''}>
                              {s.rubber_diff > 0 ? '+' : ''}{s.rubber_diff}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}

            {Object.keys(standingsMap).length === 0 && (
              <div className="text-center text-gray-400 py-8">아직 순위 데이터가 없습니다.</div>
            )}
          </div>
        )}

        {/* ── 대전 탭 ── */}
        {tab === 'matches' && (
          <div className="space-y-2">
            {ties.length === 0 ? (
              <div className="text-center text-gray-400 py-8">대전이 없습니다.</div>
            ) : (
              ties.map(tie => (
                <div key={tie.id} className={`bg-white rounded-xl border p-4 ${tie.is_bye ? 'opacity-50' : ''}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-400">
                      {getRoundLabel(tie.round || '')} #{tie.tie_order}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>
                      {getTieStatusLabel(tie.status)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <span className={`font-medium ${tie.winning_club_id === tie.club_a_id ? 'text-green-700' : ''}`}>
                        {tie.club_a?.name || 'TBD'}
                      </span>
                    </div>
                    <div className="text-center px-4">
                      {tie.status === 'completed' || tie.status === 'in_progress' ? (
                        <span className="text-xl font-bold">
                          {tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}
                        </span>
                      ) : tie.is_bye ? (
                        <span className="text-sm text-gray-400">BYE</span>
                      ) : (
                        <span className="text-sm text-gray-400">vs</span>
                      )}
                    </div>
                    <div className="flex-1 text-right">
                      <span className={`font-medium ${tie.winning_club_id === tie.club_b_id ? 'text-green-700' : ''}`}>
                        {tie.club_b?.name || 'TBD'}
                      </span>
                    </div>
                  </div>

                  {/* 라인업 봉인 상태 */}
                  {tie.status === 'lineup_phase' && (
                    <div className="text-xs text-center text-yellow-600 mt-2">
                      라인업: {tie.club_a_lineup_submitted ? '✅' : '⏳'} {tie.club_a?.name}
                      {' · '}
                      {tie.club_b_lineup_submitted ? '✅' : '⏳'} {tie.club_b?.name}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* ── 토너먼트 탭 ── */}
        {tab === 'bracket' && (
          <div className="space-y-4">
            {tournamentTies.length === 0 ? (
              <div className="text-center text-gray-400 py-8">토너먼트가 아직 시작되지 않았습니다.</div>
            ) : (
              (() => {
                const rounds = [...new Set(tournamentTies.map(t => t.round))].sort(
                  (a, b) => {
                    const order = ['round_of_16', 'quarter', 'semi', 'final'];
                    return order.indexOf(a || '') - order.indexOf(b || '');
                  }
                );

                return rounds.map(round => (
                  <div key={round} className="bg-white rounded-xl border overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 font-semibold text-sm">
                      {getRoundLabel(round || '')}
                    </div>
                    <div className="divide-y">
                      {tournamentTies
                        .filter(t => t.round === round)
                        .sort((a, b) => (a.bracket_position || 0) - (b.bracket_position || 0))
                        .map(tie => (
                          <div key={tie.id} className="p-3">
                            <div className="flex items-center">
                              <div className={`flex-1 ${tie.winning_club_id === tie.club_a_id ? 'font-bold' : ''}`}>
                                {tie.club_a?.seed_number && (
                                  <span className="text-xs text-yellow-600 mr-1">[{tie.club_a.seed_number}]</span>
                                )}
                                {tie.club_a?.name || (tie.is_bye ? 'BYE' : 'TBD')}
                              </div>
                              <div className="px-4 font-bold">
                                {tie.status === 'completed' || tie.status === 'in_progress'
                                  ? `${tie.club_a_rubbers_won} - ${tie.club_b_rubbers_won}`
                                  : tie.is_bye ? 'BYE' : 'vs'
                                }
                              </div>
                              <div className={`flex-1 text-right ${tie.winning_club_id === tie.club_b_id ? 'font-bold' : ''}`}>
                                {tie.club_b?.name || (tie.is_bye ? 'BYE' : 'TBD')}
                                {tie.club_b?.seed_number && (
                                  <span className="text-xs text-yellow-600 ml-1">[{tie.club_b.seed_number}]</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      }
                    </div>
                  </div>
                ));
              })()
            )}

            {/* 우승 */}
            {(() => {
              const finalTie = tournamentTies.find(t => t.round === 'final');
              if (finalTie?.winning_club_id) {
                const winner = finalTie.winning_club_id === finalTie.club_a_id
                  ? finalTie.club_a?.name
                  : finalTie.club_b?.name;
                return (
                  <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-6 text-center">
                    <div className="text-4xl mb-2">🏆</div>
                    <div className="text-2xl font-bold">{winner}</div>
                    <div className="text-sm text-yellow-700 mt-1">우승!</div>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        )}

        {/* 새로고침 */}
        <div className="text-center">
          <button
            onClick={loadData}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            🔄 새로고침
          </button>
          <p className="text-xs text-gray-300 mt-1">30초마다 자동 갱신</p>
        </div>
      </div>
    </div>
  );
}
