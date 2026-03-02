// ============================================================
// 대전 관리 페이지
// src/app/dashboard/teams/ties/page.tsx
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  fetchTies, fetchRubbers, fetchEventTeamConfig,
  recordRubberScore, calculateStandings,
} from '@/lib/team-api';
import { supabase } from '@/lib/supabase';
import {
  getTieStatusLabel, getTieStatusColor, formatSetScore, getMajority,
} from '@/lib/team-utils';
import type { TieWithClubs, TieRubber, EventTeamConfig } from '@/types/team';

export default function TiesPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 선택된 대전
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null);
  const [rubbers, setRubbers] = useState<TieRubber[]>([]);
  const [rubbersLoading, setRubbersLoading] = useState(false);

  // 점수 입력
  const [editingRubber, setEditingRubber] = useState<string | null>(null);
  const [scoreInput, setScoreInput] = useState({
    set1a: '', set1b: '', set2a: '', set2b: '', set3a: '', set3b: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // 복사 피드백
  const [copiedTieId, setCopiedTieId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const [cfg, tieList] = await Promise.all([
      fetchEventTeamConfig(eventId),
      fetchTies(eventId),
    ]);
    setConfig(cfg);
    setTies(tieList);

    const { data: grps } = await supabase
      .from('groups')
      .select('*')
      .eq('event_id', eventId)
      .order('group_num');
    setGroups(grps || []);

    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  // 대전 선택 → 러버 로드
  async function handleSelectTie(tie: TieWithClubs) {
    if (selectedTie?.id === tie.id) {
      setSelectedTie(null);
      setRubbers([]);
      return;
    }
    setSelectedTie(tie);
    setRubbersLoading(true);
    setEditingRubber(null);
    const data = await fetchRubbers(tie.id);
    setRubbers(data);
    setRubbersLoading(false);
  }

  // 점수 입력 시작
  function startScoreEdit(rubber: TieRubber) {
    setEditingRubber(rubber.id);
    setSaveError('');
    setScoreInput({
      set1a: rubber.set1_a?.toString() || '',
      set1b: rubber.set1_b?.toString() || '',
      set2a: rubber.set2_a?.toString() || '',
      set2b: rubber.set2_b?.toString() || '',
      set3a: rubber.set3_a?.toString() || '',
      set3b: rubber.set3_b?.toString() || '',
    });
  }

  // 점수 저장
  async function handleSaveScore(rubberId: string) {
    const { set1a, set1b, set2a, set2b, set3a, set3b } = scoreInput;
    if (!set1a || !set1b) { setSaveError('1세트 점수를 입력하세요.'); return; }

    setSaving(true);
    setSaveError('');

    try {
      const result = await recordRubberScore(
        rubberId,
        parseInt(set1a), parseInt(set1b),
        set2a ? parseInt(set2a) : null,
        set2b ? parseInt(set2b) : null,
        set3a ? parseInt(set3a) : null,
        set3b ? parseInt(set3b) : null,
      );
      if (!result.success) { setSaveError(result.error || '저장 실패'); return; }

      // 러버 & 대전 목록 갱신
      const updated = await fetchRubbers(selectedTie!.id);
      setRubbers(updated);
      setEditingRubber(null);
      await loadData();

      // 순위 재계산
      try { await calculateStandings(eventId, selectedTie?.group_id || null); } catch {}
    } catch (err: any) {
      setSaveError(err.message || '저장 실패');
    } finally {
      setSaving(false);
    }
  }

  // 라인업 URL 복사
  function copyLineupUrl(tieId: string) {
    const url = `${window.location.origin}/lineup/${tieId}`;
    navigator.clipboard.writeText(url);
    setCopiedTieId(tieId);
    setTimeout(() => setCopiedTieId(null), 2000);
  }

  // 조별로 대전 그룹핑
  function getTiesByGroup() {
    if (groups.length === 0) {
      const roundGroups: Record<string, TieWithClubs[]> = {};
      ties.forEach(t => {
        const key = t.round || 'etc';
        if (!roundGroups[key]) roundGroups[key] = [];
        roundGroups[key].push(t);
      });
      return Object.entries(roundGroups).map(([round, tList]) => ({
        groupName: getRoundName(round),
        groupId: null,
        ties: tList,
      }));
    }

    const result: { groupName: string; groupId: string | null; ties: TieWithClubs[] }[] = [];
    for (const g of groups) {
      const groupTies = ties.filter(t => t.group_id === g.id);
      if (groupTies.length > 0) {
        result.push({
          groupName: g.group_label || `${g.group_num}조`,
          groupId: g.id,
          ties: groupTies,
        });
      }
    }
    const ungrouped = ties.filter(t => !t.group_id);
    if (ungrouped.length > 0) {
      result.push({ groupName: '토너먼트', groupId: null, ties: ungrouped });
    }
    return result;
  }

  function getRoundName(round: string): string {
    const names: Record<string, string> = {
      full_league: '풀리그', group: '조별리그',
      round_of_16: '16강', quarter: '8강', semi: '4강', final: '결승', etc: '기타',
    };
    return names[round] || round;
  }

  if (loading) return <div className="p-8 text-center text-gray-500">로딩중...</div>;

  if (ties.length === 0) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-4">🎾 대전 관리</h1>
        <div className="bg-gray-50 rounded-lg border border-dashed p-8 text-center text-gray-400">
          대전이 없습니다. 먼저 조편성에서 대전을 생성해주세요.
        </div>
      </div>
    );
  }

  const tieGroups = getTiesByGroup();
  const setsPerRubber = config?.team_sets_per_rubber || 1;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🎾 대전 관리</h1>
        <span className="text-sm text-gray-500">
          총 {ties.length}대전 · 완료 {ties.filter(t => t.status === 'completed').length}
        </span>
      </div>

      {/* 대전 목록 */}
      {tieGroups.map((group) => (
        <div key={group.groupName} className="space-y-3">
          <h2 className="font-semibold text-lg">{group.groupName}</h2>

          {group.ties.map((tie) => {
            const isSelected = selectedTie?.id === tie.id;
            const majority = getMajority(tie.rubber_count);
            const aWin = tie.club_a_rubbers_won >= majority;
            const bWin = tie.club_b_rubbers_won >= majority;

            return (
              <div key={tie.id} className="bg-white rounded-lg border overflow-hidden">
                {/* 대전 헤더 */}
                <div
                  onClick={() => handleSelectTie(tie)}
                  className="p-4 cursor-pointer hover:bg-gray-50 transition"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-xs text-gray-400 w-6">#{tie.tie_order}</span>
                      <span className={`font-semibold ${aWin ? 'text-blue-600' : ''}`}>
                        {tie.club_a?.name || 'TBD'}
                      </span>
                      <span className="text-gray-400 text-sm">vs</span>
                      <span className={`font-semibold ${bWin ? 'text-blue-600' : ''}`}>
                        {tie.club_b?.name || 'TBD'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {(tie.status === 'completed' || tie.status === 'in_progress') && (
                        <span className="text-lg font-bold">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span>
                      )}
                      <span className={`text-xs px-2 py-1 rounded-full ${getTieStatusColor(tie.status)}`}>
                        {getTieStatusLabel(tie.status)}
                      </span>
                      <span className="text-gray-400 text-sm">{isSelected ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  {/* 라인업 상태 */}
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span>
                      {tie.club_a?.name?.slice(0, 6)}:
                      {tie.club_a_lineup_submitted
                        ? <span className="text-green-600 ml-1">✅제출</span>
                        : <span className="text-orange-500 ml-1">⏳대기</span>}
                    </span>
                    <span>
                      {tie.club_b?.name?.slice(0, 6)}:
                      {tie.club_b_lineup_submitted
                        ? <span className="text-green-600 ml-1">✅제출</span>
                        : <span className="text-orange-500 ml-1">⏳대기</span>}
                    </span>
                    {tie.lineup_revealed && <span className="text-blue-600">🔓공개됨</span>}
                  </div>
                </div>

                {/* 펼침: 러버 + 점수 + 액션 */}
                {isSelected && (
                  <div className="border-t bg-gray-50 p-4 space-y-4">
                    {/* 액션 버튼 */}
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={(e) => { e.stopPropagation(); copyLineupUrl(tie.id); }}
                        className="text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200"
                      >
                        {copiedTieId === tie.id ? '✅ 복사됨!' : '📋 라인업 URL 복사'}
                      </button>
                    </div>

                    {/* 러버 목록 */}
                    {rubbersLoading ? (
                      <div className="text-center text-gray-400 py-4">로딩중...</div>
                    ) : rubbers.length === 0 ? (
                      <div className="text-center text-gray-400 py-4">러버가 없습니다.</div>
                    ) : (
                      <div className="space-y-3">
                        {rubbers.map((r) => {
                          const isEditing = editingRubber === r.id;
                          const hasScore = r.set1_a !== null;

                          return (
                            <div key={r.id} className="bg-white rounded-lg border p-4">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium text-sm">복식 {r.rubber_number}</span>
                                <div className="flex items-center gap-2">
                                  {r.status === 'completed' && (
                                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">완료</span>
                                  )}
                                  {r.pin_code && (
                                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">
                                      PIN: {r.pin_code}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* 기존 스코어 표시 */}
                              {hasScore && !isEditing && (
                                <div className="flex items-center justify-between">
                                  <div className="text-center flex-1">
                                    <div className="text-lg font-bold">
                                      {formatSetScore(r.set1_a, r.set1_b)}
                                      {r.set2_a !== null && ` / ${formatSetScore(r.set2_a, r.set2_b)}`}
                                      {r.set3_a !== null && ` / ${formatSetScore(r.set3_a, r.set3_b)}`}
                                    </div>
                                    {r.winning_club_id && (
                                      <div className="text-xs text-blue-600 mt-1">
                                        승: {r.winning_club_id === tie.club_a_id ? tie.club_a?.name : tie.club_b?.name}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => startScoreEdit(r)}
                                    className="text-xs text-gray-400 hover:text-blue-600 px-2"
                                  >
                                    수정
                                  </button>
                                </div>
                              )}

                              {/* 점수 미입력 + 편집 아닐 때 */}
                              {!hasScore && !isEditing && (
                                <button
                                  onClick={() => startScoreEdit(r)}
                                  className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm hover:bg-blue-100"
                                >
                                  점수 입력
                                </button>
                              )}

                              {/* 점수 편집 모드 */}
                              {isEditing && (
                                <div className="space-y-3 mt-2">
                                  <SetScoreRow
                                    label="1세트"
                                    aVal={scoreInput.set1a} bVal={scoreInput.set1b}
                                    setA={(v) => setScoreInput(p => ({ ...p, set1a: v }))}
                                    setB={(v) => setScoreInput(p => ({ ...p, set1b: v }))}
                                    clubA={tie.club_a?.name} clubB={tie.club_b?.name}
                                  />
                                  {setsPerRubber === 3 && (
                                    <>
                                      <SetScoreRow
                                        label="2세트"
                                        aVal={scoreInput.set2a} bVal={scoreInput.set2b}
                                        setA={(v) => setScoreInput(p => ({ ...p, set2a: v }))}
                                        setB={(v) => setScoreInput(p => ({ ...p, set2b: v }))}
                                        clubA={tie.club_a?.name} clubB={tie.club_b?.name}
                                      />
                                      <SetScoreRow
                                        label="3세트"
                                        aVal={scoreInput.set3a} bVal={scoreInput.set3b}
                                        setA={(v) => setScoreInput(p => ({ ...p, set3a: v }))}
                                        setB={(v) => setScoreInput(p => ({ ...p, set3b: v }))}
                                        clubA={tie.club_a?.name} clubB={tie.club_b?.name}
                                      />
                                    </>
                                  )}

                                  {saveError && <p className="text-red-500 text-xs">{saveError}</p>}

                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => { setEditingRubber(null); setSaveError(''); }}
                                      className="flex-1 bg-gray-100 py-2 rounded-lg text-sm"
                                    >
                                      취소
                                    </button>
                                    <button
                                      onClick={() => handleSaveScore(r.id)}
                                      disabled={saving}
                                      className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
                                    >
                                      {saving ? '저장중...' : '점수 저장'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── 세트 스코어 입력 행 ──
function SetScoreRow({
  label, aVal, bVal, setA, setB, clubA, clubB,
}: {
  label: string; aVal: string; bVal: string;
  setA: (v: string) => void; setB: (v: string) => void;
  clubA?: string; clubB?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-12">{label}</span>
      <div className="flex items-center gap-1 flex-1">
        <div className="flex-1">
          <input
            type="number" min="0" max="7" value={aVal}
            onChange={e => setA(e.target.value)}
            placeholder={clubA?.slice(0, 4)}
            className="w-full border rounded px-2 py-1.5 text-center text-sm"
          />
        </div>
        <span className="text-gray-400 text-xs">:</span>
        <div className="flex-1">
          <input
            type="number" min="0" max="7" value={bVal}
            onChange={e => setB(e.target.value)}
            placeholder={clubB?.slice(0, 4)}
            className="w-full border rounded px-2 py-1.5 text-center text-sm"
          />
        </div>
      </div>
    </div>
  );
}
