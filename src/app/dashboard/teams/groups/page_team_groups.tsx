// ============================================================
// 조편성 페이지
// src/app/dashboard/team/groups/page.tsx
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  fetchClubs, fetchEventTeamConfig, fetchStandings, fetchTies,
  generateFullLeague, createTeamGroups,
} from '@/lib/team-api';
import { supabase } from '@/lib/supabase';
import { getFormatLabel, getFullLeagueTieCount, getSeedBadge } from '@/lib/team-utils';
import type { Club, EventTeamConfig, StandingWithClub, TieWithClubs } from '@/types/team';

export default function GroupsPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [groupStandings, setGroupStandings] = useState<Record<string, StandingWithClub[]>>({});
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  // 조편성 설정
  const [groupCount, setGroupCount] = useState(2);
  const [groupSize, setGroupSize] = useState(3);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const [cfg, clubList] = await Promise.all([
      fetchEventTeamConfig(eventId),
      fetchClubs(eventId),
    ]);
    setConfig(cfg);
    setClubs(clubList);

    // 기존 그룹 로드
    const { data: grps } = await supabase
      .from('groups')
      .select('*')
      .eq('event_id', eventId)
      .order('group_index');
    setGroups(grps || []);

    // 각 그룹별 순위 로드
    if (grps?.length) {
      const standings: Record<string, StandingWithClub[]> = {};
      for (const g of grps) {
        standings[g.id] = await fetchStandings(eventId, g.id);
      }
      setGroupStandings(standings);
    }

    // 풀리그 순위
    if (cfg?.team_format === 'full_league') {
      const fullStandings = await fetchStandings(eventId, null);
      setGroupStandings({ full: fullStandings });
    }

    // 대전 목록
    const tieList = await fetchTies(eventId);
    setTies(tieList);

    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── 풀리그 생성 ──
  async function handleFullLeague() {
    if (!confirm(`${clubs.length}팀 풀리그를 생성합니다. (${getFullLeagueTieCount(clubs.length)}대전)`)) return;
    setGenerating(true);
    try {
      const result = await generateFullLeague(eventId);
      if (!result.success) { alert(result.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '풀리그 생성 실패');
    } finally {
      setGenerating(false);
    }
  }

  // ── 조별리그 / 예선 조편성 ──
  async function handleCreateGroups() {
    const total = groupCount * groupSize;
    if (total < clubs.length) {
      alert(`${groupCount}개 조 × ${groupSize}팀 = ${total}팀. 현재 ${clubs.length}팀이 등록되어 있습니다. 조 수 또는 조 크기를 늘려주세요.`);
      return;
    }
    if (!confirm(`${groupCount}개 조 × ${groupSize}팀으로 조편성합니다.`)) return;

    setGenerating(true);
    try {
      const result = await createTeamGroups(eventId, groupCount, groupSize);
      if (!result.success) { alert(result.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '조편성 실패');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <div className="p-8 text-center text-gray-500">로딩중...</div>;

  const hasTies = ties.length > 0;
  const hasGroups = groups.length > 0;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏟️ 조편성</h1>
        <span className="text-sm text-gray-500">
          {clubs.length}팀 · {config ? getFormatLabel(config.team_format) : ''}
        </span>
      </div>

      {clubs.length < 2 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          최소 2팀 이상 등록해야 조편성이 가능합니다. 먼저 클럽을 등록해주세요.
        </div>
      )}

      {clubs.length >= 2 && (
        <>
          {/* ── 포맷별 생성 버튼 ── */}
          {config?.team_format === 'full_league' && (
            <div className="bg-white rounded-lg border p-6 space-y-4">
              <h2 className="font-semibold">풀리그 생성</h2>
              <p className="text-sm text-gray-500">
                {clubs.length}팀 전체 라운드로빈 → {getFullLeagueTieCount(clubs.length)}대전
              </p>
              <button
                onClick={handleFullLeague}
                disabled={generating}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {generating ? '생성중...' : hasTies ? '풀리그 재생성' : '풀리그 생성'}
              </button>
              {hasTies && (
                <p className="text-xs text-red-500">⚠️ 재생성 시 기존 대전/스코어가 초기화됩니다.</p>
              )}
            </div>
          )}

          {(config?.team_format === 'group_tournament' || config?.team_format === 'prelim_tournament') && (
            <div className="bg-white rounded-lg border p-6 space-y-4">
              <h2 className="font-semibold">
                {config.team_format === 'group_tournament' ? '조별리그 편성' : '예선 순위결정전 편성'}
              </h2>

              <div className="flex gap-4 items-end">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">조 수</label>
                  <select
                    value={groupCount}
                    onChange={(e) => setGroupCount(Number(e.target.value))}
                    className="border rounded px-3 py-2"
                  >
                    {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>{n}개 조</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">조당 팀 수</label>
                  <select
                    value={groupSize}
                    onChange={(e) => setGroupSize(Number(e.target.value))}
                    className="border rounded px-3 py-2"
                  >
                    {config.team_format === 'prelim_tournament'
                      ? [2, 3].map((n) => <option key={n} value={n}>{n}팀</option>)
                      : [3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}팀</option>)
                    }
                  </select>
                </div>
                <div className="text-sm text-gray-500">
                  = {groupCount * groupSize}팀 수용 (현재 {clubs.length}팀)
                </div>
              </div>

              <button
                onClick={handleCreateGroups}
                disabled={generating}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {generating ? '생성중...' : hasGroups ? '조편성 재생성' : '조편성 생성'}
              </button>
              {hasGroups && (
                <p className="text-xs text-red-500">⚠️ 재생성 시 기존 조/대전/스코어가 초기화됩니다.</p>
              )}
            </div>
          )}

          {/* ── 시드 클럽 표시 ── */}
          {clubs.some((c) => c.seed_number) && (
            <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-4">
              <h3 className="font-semibold text-sm text-yellow-800 mb-2">시드 클럽</h3>
              <div className="flex flex-wrap gap-2">
                {clubs
                  .filter((c) => c.seed_number)
                  .sort((a, b) => (a.seed_number || 0) - (b.seed_number || 0))
                  .map((c) => (
                    <span key={c.id} className="bg-yellow-100 text-yellow-900 px-3 py-1 rounded text-sm">
                      {c.seed_number}시드: {c.name}
                    </span>
                  ))
                }
              </div>
            </div>
          )}

          {/* ── 조별 결과 표시 ── */}
          {config?.team_format === 'full_league' && groupStandings.full && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3">풀리그 현황</h3>
              <StandingsTable standings={groupStandings.full} />
            </div>
          )}

          {hasGroups && (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.id} className="bg-white rounded-lg border p-4">
                  <h3 className="font-semibold mb-3">{g.group_name}</h3>
                  {groupStandings[g.id] ? (
                    <StandingsTable standings={groupStandings[g.id]} />
                  ) : (
                    <p className="text-gray-400 text-sm">데이터 없음</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── 대전 일정 ── */}
          {hasTies && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3">대전 일정 ({ties.length}대전)</h3>
              <div className="divide-y">
                {ties.map((tie) => (
                  <div key={tie.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">#{tie.tie_order}</span>
                      <span className="font-medium text-sm">{tie.club_a?.name || 'TBD'}</span>
                      <span className="text-gray-400 text-xs">vs</span>
                      <span className="font-medium text-sm">{tie.club_b?.name || 'TBD'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {tie.is_bye && <span className="text-xs bg-gray-200 text-gray-500 px-2 py-0.5 rounded">BYE</span>}
                      {tie.status === 'completed' && (
                        <span className="text-xs text-green-600">
                          {tie.club_a_rubbers_won}-{tie.club_b_rubbers_won}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 순위표 서브 컴포넌트 ──
function StandingsTable({ standings }: { standings: StandingWithClub[] }) {
  if (!standings.length) return <p className="text-gray-400 text-sm">순위 데이터 없음</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left">순위</th>
            <th className="px-3 py-2 text-left">클럽</th>
            <th className="px-3 py-2 text-center">승</th>
            <th className="px-3 py-2 text-center">패</th>
            <th className="px-3 py-2 text-center">러버득</th>
            <th className="px-3 py-2 text-center">러버실</th>
            <th className="px-3 py-2 text-center">득실차</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {standings.map((s) => (
            <tr key={s.id} className={s.is_tied ? 'bg-yellow-50' : ''}>
              <td className="px-3 py-2">
                {s.rank !== null ? s.rank : (
                  <span className="text-yellow-600 text-xs">⚠️ 동률</span>
                )}
                {s.rank_locked && <span className="ml-1 text-xs text-green-600">✓</span>}
              </td>
              <td className="px-3 py-2 font-medium">
                {s.club?.name || '-'}
                {s.club?.seed_number && (
                  <span className="ml-1 text-xs text-yellow-600">[{s.club.seed_number}시드]</span>
                )}
              </td>
              <td className="px-3 py-2 text-center">{s.won}</td>
              <td className="px-3 py-2 text-center">{s.lost}</td>
              <td className="px-3 py-2 text-center">{s.rubbers_for}</td>
              <td className="px-3 py-2 text-center">{s.rubbers_against}</td>
              <td className="px-3 py-2 text-center font-medium">
                {s.rubber_diff > 0 ? '+' : ''}{s.rubber_diff}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
