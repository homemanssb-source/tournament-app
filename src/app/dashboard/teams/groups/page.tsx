// ============================================================
// 단체전 조편성 페이지
// src/app/dashboard/teams/groups/page.tsx
// ✅ 부서별 division_id 필터 수정본
// ============================================================
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  fetchClubs, fetchEventTeamConfig, fetchStandings, fetchTies,
  generateFullLeague, createTeamGroups,
} from '@/lib/team-api';
import { supabase } from '@/lib/supabase';
import { getFormatLabel, getFullLeagueTieCount } from '@/lib/team-utils';
import type { Club, EventTeamConfig, StandingWithClub, TieWithClubs } from '@/types/team';

interface Division { id: string; name: string; sort_order: number; }

// 개인전과 동일한 로직 — 1팀 조만 방지 (2팀 조는 허용)
function calcGroupDistribution(totalTeams: number, groupSize: number): number[] {
  if (totalTeams < 2) return [];
  if (groupSize < 2) groupSize = 2;
  const groupCount = Math.ceil(totalTeams / groupSize);
  const distribution: number[] = [];
  let remaining = totalTeams;
  for (let i = 0; i < groupCount; i++) {
    distribution.push(Math.min(groupSize, remaining));
    remaining -= distribution[i];
  }
  // 1팀 조 방지: 마지막 조가 1팀이면 앞 조에서 1팀 당겨옴
  if (distribution.length >= 2 && distribution[distribution.length - 1] === 1) {
    distribution[distribution.length - 2] -= 1;
    distribution[distribution.length - 1] += 1;
  }
  return distribution;
}

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
  const [groupSize, setGroupSize] = useState(3);

  const [divisions, setDivisions] = useState<Division[]>([]);
  const [selectedDiv, setSelectedDiv] = useState<string>('');

  const filteredClubs = useMemo(() => {
    if (!selectedDiv) return clubs;
    return clubs.filter(c => (c as any).division_id === selectedDiv);
  }, [clubs, selectedDiv]);

  const filteredGroups = useMemo(() => {
    if (!selectedDiv) return groups;
    return groups.filter(g => g.division_id === selectedDiv);
  }, [groups, selectedDiv]);

  const filteredTies = useMemo(() => {
    if (!selectedDiv) return ties;
    return ties.filter(t => (t as any).division_id === selectedDiv);
  }, [ties, selectedDiv]);

  const distribution = useMemo(
    () => calcGroupDistribution(filteredClubs.length, groupSize),
    [filteredClubs.length, groupSize]
  );
  const groupCount = distribution.length;

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    // ✅ 부서, config, clubs, groups, ties를 한 번에 병렬 fetch
    const [divsRes, cfg, clubList, grpsRes, tieList] = await Promise.all([
      supabase.from('divisions').select('id, name, sort_order').eq('event_id', eventId).order('sort_order'),
      fetchEventTeamConfig(eventId),
      fetchClubs(eventId),
      supabase.from('groups').select('*').eq('event_id', eventId).order('group_num'),
      fetchTies(eventId),
    ]);

    const divList = divsRes.data || [];
    const grps = grpsRes.data || [];

    setDivisions(divList);
    if (divList.length > 0) {
      setSelectedDiv(prev => prev || divList[0].id);
    }
    setConfig(cfg);
    setClubs(clubList);
    setGroups(grps);
    setTies(tieList);

    // ✅ standings도 병렬 fetch
    if (cfg?.team_format === 'full_league') {
      setGroupStandings({ full: await fetchStandings(eventId, null) });
    } else if (grps.length > 0) {
      const standingsResults = await Promise.all(grps.map(g => fetchStandings(eventId, g.id)));
      const standings: Record<string, StandingWithClub[]> = {};
      grps.forEach((g, i) => { standings[g.id] = standingsResults[i]; });
      setGroupStandings(standings);
    }

    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleFullLeague() {
    if (!confirm(`${filteredClubs.length}팀 풀리그를 생성합니다. (${getFullLeagueTieCount(filteredClubs.length)}경기)`)) return;
    setGenerating(true);
    try {
      const r = await generateFullLeague(eventId, selectedDiv || undefined);
      if (!r.success) { alert(r.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '풀리그 생성 실패');
    } finally {
      setGenerating(false);
    }
  }

  async function handleCreateGroups() {
    if (distribution.length === 0) { alert('조편성할 팀이 없습니다.'); return; }
    const desc = distribution.map((size, i) => `${String.fromCharCode(65 + i)}조: ${size}팀`).join(', ');
    if (!confirm(`${groupCount}개 조로 편성합니다.\n${desc}`)) return;
    setGenerating(true);
    try {
      const r = await createTeamGroups(eventId, groupCount, groupSize, selectedDiv || undefined);
      if (!r.success) { alert(r.error); return; }
      await loadData();
    } catch (err: any) {
      alert(err.message || '조편성 실패');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <div className="p-8 text-center text-gray-500">불러오는 중...</div>;

  const hasTies = filteredTies.length > 0;
  const hasGroups = filteredGroups.length > 0;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏅 조편성</h1>
        <span className="text-sm text-gray-500">
          {filteredClubs.length}팀 · {config ? getFormatLabel(config.team_format) : ''}
        </span>
      </div>

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

      {filteredClubs.length < 2 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          최소 2팀 이상 등록해야 조편성이 가능합니다.
        </div>
      )}

      {filteredClubs.length >= 2 && (
        <>
          {config?.team_format === 'full_league' && (
            <div className="bg-white rounded-lg border p-6 space-y-4">
              <h2 className="font-semibold">풀리그 생성</h2>
              <p className="text-sm text-gray-500">
                {filteredClubs.length}팀 전체 리그 → {getFullLeagueTieCount(filteredClubs.length)}경기
              </p>
              <button onClick={handleFullLeague} disabled={generating}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {generating ? '생성 중...' : hasTies ? '풀리그 재생성' : '풀리그 생성'}
              </button>
              {hasTies && <p className="text-xs text-red-500">재생성하면 기존 경기가 모두 초기화됩니다.</p>}
            </div>
          )}

          {(config?.team_format === 'group_tournament' || config?.team_format === 'prelim_tournament') && (
            <div className="bg-white rounded-lg border p-6 space-y-4">
              <h2 className="font-semibold">
                {config.team_format === 'group_tournament' ? '조별리그 편성' : '예선 조편성'}
              </h2>
              <div className="flex gap-4 items-end">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">조당 팀 수</label>
                  <select value={groupSize} onChange={e => setGroupSize(Number(e.target.value))}
                    className="border rounded px-3 py-2">
                    {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}팀</option>)}
                  </select>
                </div>
              </div>

              {distribution.length > 0 && (
                <div className="bg-blue-50 rounded-lg p-4 space-y-2">
                  <span className="text-sm font-semibold text-blue-800">
                    자동 편성 결과: {groupCount}개 조
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {distribution.map((size, i) => (
                      <span key={i} className={`px-3 py-1 rounded text-sm ${
                        size < groupSize ? 'bg-yellow-100 text-yellow-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {String.fromCharCode(65 + i)}조: {size}팀
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-blue-600">
                    총 {distribution.reduce((a, b) => a + b, 0)}팀 배정 (등록: {filteredClubs.length}팀)
                  </p>
                </div>
              )}

              <button onClick={handleCreateGroups}
                disabled={generating || distribution.length === 0}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {generating ? '생성 중...' : hasGroups ? '조편성 재생성' : '조편성 생성'}
              </button>
              {hasGroups && <p className="text-xs text-red-500">재생성하면 기존 조가 모두 초기화됩니다.</p>}
            </div>
          )}

          {config?.team_format === 'full_league' && groupStandings.full && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3">풀리그 순위</h3>
              <StandingsTable standings={groupStandings.full} />
            </div>
          )}

          {hasGroups && (
            <div className="space-y-4">
              {filteredGroups.map(g => (
                <div key={g.id} className="bg-white rounded-lg border p-4">
                  <h3 className="font-semibold mb-3">{g.group_label || (g.group_num + '조')}</h3>
                  {groupStandings[g.id]
                    ? <StandingsTable standings={groupStandings[g.id]} />
                    : <p className="text-gray-400 text-sm">데이터 없음</p>}
                </div>
              ))}
            </div>
          )}

          {hasTies && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3">경기 일정 ({filteredTies.length}경기)</h3>
              <div className="divide-y">
                {filteredTies.map(tie => (
                  <div key={tie.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">#{tie.tie_order}</span>
                      <span className="font-medium text-sm">{tie.club_a?.name || 'TBD'}</span>
                      <span className="text-gray-400 text-xs">vs</span>
                      <span className="font-medium text-sm">{tie.club_b?.name || 'TBD'}</span>
                      {(tie as any).court_number && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded ml-2">
                          코트 {(tie as any).court_number}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {tie.is_bye && (
                        <span className="text-xs bg-gray-200 text-gray-500 px-2 py-0.5 rounded">BYE</span>
                      )}
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
            <th className="px-3 py-2 text-center">득점</th>
            <th className="px-3 py-2 text-center">실점</th>
            <th className="px-3 py-2 text-center">득실차</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {standings.map(s => (
            <tr key={s.id} className={s.is_tied ? 'bg-yellow-50' : ''}>
              <td className="px-3 py-2">
                {s.rank !== null ? s.rank : <span className="text-yellow-600 text-xs">동률 처리</span>}
                {s.rank_locked && <span className="ml-1 text-xs text-green-600">✓</span>}
              </td>
              <td className="px-3 py-2 font-medium">
                {s.club?.name || '-'}
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