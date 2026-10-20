// ============================================================
// 단체전 조편성 페이지
// src/app/dashboard/teams/groups/page.tsx
// ✅ 부서별 division_id 필터 수정본
// ============================================================
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { tieGroupPlaceholders } from '@/lib/tournament';
import { useEventIdWithParam } from '@/components/useDashboard';
import {
  fetchClubs, fetchEventTeamConfig, fetchTies,
  generateFullLeague, createTeamGroups,
} from '@/lib/team-api';
import TeamStandingsPanel from '@/components/TeamStandingsPanel';
import { supabase } from '@/lib/supabase';
import { getFormatLabel, getFullLeagueTieCount } from '@/lib/team-utils';
import { divisionTeamFormat } from '@/lib/league';
import DivisionOverview from '@/components/DivisionOverview';
import { calcGroupDistribution, saveSeeds } from '@/lib/seed';
import SeedPanel from '@/components/SeedPanel';
import type { Club, EventTeamConfig, TieWithClubs } from '@/types/team';

interface Division { id: string; name: string; sort_order: number; }

export default function GroupsPage() {
  const eventId = useEventIdWithParam();

  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [standingsReload, setStandingsReload] = useState(0);   // 조/리그를 다시 만들면 순위표도 새로
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  // 3팀 조: 첫 대전 전엔 남은 두 대전을 (앞 경기 승자)/(앞 경기 패자) vs 3번 으로 표시 (036)
  const tiePh = useMemo(() => tieGroupPlaceholders(ties as any), [ties]);
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
      supabase.from('divisions').select('*').eq('event_id', eventId).order('sort_order'),   // * — format(034) 포함
      fetchEventTeamConfig(eventId),
      fetchClubs(eventId),
      supabase.from('groups').select('*').eq('event_id', eventId).order('group_num'),
      fetchTies(eventId),
    ]);

    const divList = divsRes.data || [];
    const grps = grpsRes.data || [];

    setDivisions(divList);
    if (divList.length > 0) {
      setSelectedDiv(prev => divList.some((d: any) => d.id === prev) ? prev : divList[0].id);   // 대회를 바꾸면 그 대회 첫 부서로
    }
    setConfig(cfg);
    setClubs(clubList);
    setGroups(grps);
    setTies(tieList);
    setStandingsReload(n => n + 1);

    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  // 부서별 진행방식을 저장해 둔다 — 풀리그/조 생성 함수가 대회 설정(team_format)을 바꿔도 다른 부서 방식이 그대로 유지되게
  async function pinDivisionFormats(selectedFormat: 'full_league' | 'group_knockout') {
    for (const d of divisions as any[]) {
      const want = d.id === selectedDiv
        ? selectedFormat
        : (d.format ?? (divisionTeamFormat(d, config?.team_format) === 'full_league' ? 'full_league' : 'group_knockout'));
      if (d.format !== want) {
        const { error } = await supabase.from('divisions').update({ format: want }).eq('id', d.id);
        if (error) throw new Error('부서 진행방식 저장 실패: ' + error.message);
      }
    }
  }

  async function handleFullLeague() {
    if (!confirm(`${filteredClubs.length}팀 풀리그를 생성합니다. (${getFullLeagueTieCount(filteredClubs.length)}경기)`)) return;
    setGenerating(true);
    try {
      if (divisions.length > 0) await pinDivisionFormats('full_league');
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
    const seedCount = filteredClubs.filter(c => c.seed_number != null).length;
    if (seedCount > groupCount) { alert(`시드(${seedCount}팀)가 조 수(${groupCount}개)보다 많습니다. 시드 수를 줄이거나 조당 팀 수를 줄여주세요.`); return; }
    if (!confirm(`${groupCount}개 조로 편성합니다.\n${desc}`)) return;
    setGenerating(true);
    try {
      if (divisions.length > 0) await pinDivisionFormats('group_knockout');
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
  // 이 부서 진행방식 (부서 설정 → 없으면 대회 설정)
  const fmt = divisionTeamFormat(divisions.find(d => d.id === selectedDiv) as any, config?.team_format);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏅 조편성 · 순위</h1>
        <span className="text-sm text-gray-500">
          {filteredClubs.length}팀 · {getFormatLabel(fmt)}
        </span>
      </div>

      <DivisionOverview eventId={eventId} kind="team" selected={selectedDiv} onSelect={setSelectedDiv}
        reloadKey={standingsReload} onChanged={loadData} />

      {divisions.length > 0 && (
        <div className="flex gap-1 overflow-x-auto">
          {divisions.map(d => (
            <button key={d.id} onClick={() => setSelectedDiv(d.id)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                selectedDiv === d.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{d.name}{(d as any).team_match_type ? ` (${(d as any).team_match_type === '5_doubles' ? 5 : 3}복식)` : ''}</button>
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
          {fmt === 'full_league' && (
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

          {(fmt === 'group_tournament' || fmt === 'prelim_tournament') && (
            <SeedPanel
              candidates={filteredClubs.map(c => ({ id: c.id, name: c.name, seed: c.seed_number ?? null }))}
              maxSeeds={groupCount}
              unit="팀"
              onSave={async ids => { await saveSeeds('clubs', eventId, selectedDiv || null, ids); await loadData(); }}
            />
          )}

          {(fmt === 'group_tournament' || fmt === 'prelim_tournament') && (
            <div className="bg-white rounded-lg border p-6 space-y-4">
              <h2 className="font-semibold">
                {fmt === 'group_tournament' ? '조별리그 편성' : '예선 조편성'}
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
                        size === 1 ? 'bg-red-100 text-red-800 font-bold' :
                        size < groupSize ? 'bg-yellow-100 text-yellow-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {String.fromCharCode(65 + i)}조: {size}팀
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-blue-600">
                    총 {distribution.reduce((a, b) => a + b, 0)}팀 배정 (등록: {filteredClubs.length}팀)
                  </p>
                  {distribution.includes(1) && (
                    <p className="text-xs text-red-600 font-medium bg-red-50 border border-red-200 rounded p-2">
                      ⚠️ 1팀 조가 발생합니다. 조당 팀 수를 조정해주세요.
                      (현재 팀 수 {filteredClubs.length}팀 ÷ 조당 {groupSize}팀)
                    </p>
                  )}
                </div>
              )}

              <button onClick={handleCreateGroups}
                disabled={generating || distribution.length === 0 || distribution.includes(1)}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {generating ? '생성 중...' : hasGroups ? '조편성 재생성' : '조편성 생성'}
              </button>
              {hasGroups && <p className="text-xs text-red-500">재생성하면 기존 조가 모두 초기화됩니다.</p>}
            </div>
          )}

          {/* 순위 (예전 '순위' 메뉴를 합침) — 재계산·동률 결정 포함 */}
          {(hasGroups || (fmt === 'full_league' && hasTies)) && (
            <TeamStandingsPanel eventId={eventId} selectedDiv={selectedDiv} reloadKey={standingsReload} />
          )}

          {hasTies && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3">경기 일정 ({filteredTies.length}경기)</h3>
              <div className="divide-y">
                {filteredTies.map(tie => (
                  <div key={tie.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">#{tie.tie_order}</span>
                      <span className="font-medium text-sm">{tiePh[tie.id]?.a || tie.club_a?.name || 'TBD'}</span>
                      <span className="text-gray-400 text-xs">vs</span>
                      <span className="font-medium text-sm">{tiePh[tie.id]?.b || tie.club_b?.name || 'TBD'}</span>
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
