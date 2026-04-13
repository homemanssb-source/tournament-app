// ============================================================
// src/app/dashboard/teams/bracket/page.tsx
// ✅ 개인전과 동일한 방식 — 조 순위 기반 진출, TBD 슬롯 지원
// ✅ 시드/클럽 직접 배정 제거
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { getRoundLabel, getTieStatusColor, getTieStatusLabel } from '@/lib/team-utils';
import type { TieWithClubs } from '@/types/team';

interface Division { id: string; name: string; sort_order: number; }
interface GroupProgress {
  id: string; name: string; total: number; finished: number;
}

const ROUND_ORDER = ['round_of_16', 'quarter', 'semi', 'final'];

export default function BracketPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [divisions, setDivisions]       = useState<Division[]>([]);
  const [selectedDiv, setSelectedDiv]   = useState<string>('');
  const [ties, setTies]                 = useState<TieWithClubs[]>([]);
  const [groupProgress, setGroupProgress] = useState<{
    total: number; finished: number; groups: GroupProgress[];
  }>({ total: 0, finished: 0, groups: [] });
  const [tbdSlots, setTbdSlots]         = useState<{ label: string }[]>([]);
  const [advancePerGroup, setAdvancePerGroup] = useState(2);
  const [loading, setLoading]           = useState(true);
  const [generating, setGenerating]     = useState(false);
  const [filling, setFilling]           = useState<string | null>(null);
  const [msg, setMsg]                   = useState('');

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      // 부서 목록
      const { data: divs } = await supabase
        .from('divisions').select('id, name, sort_order')
        .eq('event_id', eventId).order('sort_order');
      const divList = divs || [];
      setDivisions(divList);
      if (divList.length > 0) setSelectedDiv(prev => prev || divList[0].id);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  const loadDivData = useCallback(async (divId: string) => {
    if (!eventId || !divId) return;
    setLoading(true);
    try {
      // 토너먼트 ties 조회
      const { data: tieData } = await supabase
        .from('ties')
        .select('*, club_a:clubs!ties_club_a_id_fkey(*), club_b:clubs!ties_club_b_id_fkey(*)')
        .eq('event_id', eventId)
        .eq('division_id', divId)
        .in('round', ROUND_ORDER)
        .order('bracket_position');
      setTies((tieData || []) as TieWithClubs[]);

      // TBD 슬롯 확인 (qualifier_label 있는 ties)
      const { data: tbdData } = await supabase
        .from('ties')
        .select('id, qualifier_label_a, qualifier_label_b')
        .eq('event_id', eventId)
        .eq('division_id', divId)
        .in('round', ROUND_ORDER);

      const slots: { label: string }[] = [];
      for (const t of tbdData || []) {
        if (t.qualifier_label_a) slots.push({ label: t.qualifier_label_a });
        if (t.qualifier_label_b) slots.push({ label: t.qualifier_label_b });
      }
      setTbdSlots(slots);

      // 조별 진행 현황
      const { data: groups } = await supabase
        .from('groups')
        .select('id, group_label, group_num')
        .eq('event_id', eventId)
        .eq('division_id', divId)
        .order('group_num');

      const { data: groupTies } = await supabase
        .from('ties')
        .select('id, status, group_id')
        .eq('event_id', eventId)
        .eq('division_id', divId)
        .eq('round', 'group');

      const allGroupTies = groupTies || [];
      const grpList = (groups || []).map(g => {
        const gts = allGroupTies.filter(t => t.group_id === g.id);
        return {
          id: g.id,
          name: g.group_label || `${g.group_num}조`,
          total: gts.length,
          finished: gts.filter(t => t.status === 'completed').length,
        };
      });
      setGroupProgress({
        total:    allGroupTies.length,
        finished: allGroupTies.filter(t => t.status === 'completed').length,
        groups:   grpList,
      });
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { if (selectedDiv) loadDivData(selectedDiv); }, [selectedDiv, loadDivData]);

  const tournamentTies = ties.filter(t => ROUND_ORDER.includes(t.round || ''));
  const hasTournament  = tournamentTies.length > 0;
  const tiesByRound: Record<string, TieWithClubs[]> = {};
  tournamentTies.forEach(t => {
    const r = t.round || '';
    if (!tiesByRound[r]) tiesByRound[r] = [];
    tiesByRound[r].push(t);
  });
  const sortedRounds = ROUND_ORDER.filter(r => tiesByRound[r]);

  const allGroupsDone = groupProgress.total > 0 && groupProgress.finished === groupProgress.total;
  const hasTbd = tbdSlots.length > 0;

  // 진출 팀 수 계산 (조 수 × advancePerGroup)
  const totalAdvancing = groupProgress.groups.length * advancePerGroup;

  async function generateTournament(allowTbd: boolean) {
    setGenerating(true); setMsg('');
    const { data, error } = await supabase.rpc('rpc_generate_team_tournament_v2', {
      p_event_id:          eventId,
      p_division_id:       selectedDiv || null,
      p_advance_per_group: advancePerGroup,
      p_allow_tbd:         allowTbd,
    });
    setGenerating(false);
    if (error) { setMsg('❌ ' + error.message); return; }
    const tbd = data?.tbd_slots || 0;
    setMsg(
      `✅ 토너먼트 생성 완료! ${data?.ties_created || ''}경기` +
      ` (BYE ${data?.byes || 0}개)` +
      (tbd > 0 ? ` • TBD ${tbd}슬롯 — 조 경기 완료 시 자동으로 채워집니다` : '')
    );
    loadDivData(selectedDiv);
  }

  async function deleteTournament() {
    if (!confirm('현재 부서의 본선 토너먼트를 삭제하시겠습니까?')) return;
    setMsg('');
    const { error } = await supabase
      .from('ties')
      .delete()
      .eq('event_id', eventId)
      .eq('division_id', selectedDiv)
      .in('round', ROUND_ORDER);
    if (error) { setMsg('❌ ' + error.message); return; }
    setMsg('🗑️ 본선 토너먼트 삭제 완료');
    setTies([]);
    setTbdSlots([]);
  }

  async function fillGroupSlots(groupId: string, groupName: string) {
    setFilling(groupId);
    const { data, error } = await supabase.rpc('rpc_fill_team_tournament_slots', {
      p_event_id: eventId,
      p_group_id: groupId,
    });
    setFilling(null);
    if (error) { setMsg('❌ ' + error.message); return; }
    if (!data?.success) { setMsg('❌ ' + (data?.error || '실패')); return; }
    setMsg(`✅ ${groupName} 슬롯 채우기 완료!`);
    loadDivData(selectedDiv);
  }

  function getWinnerName(tie: TieWithClubs) {
    if (!tie.winning_club_id) return '';
    return tie.winning_club_id === tie.club_a_id
      ? tie.club_a?.name || '' : tie.club_b?.name || '';
  }

  if (!eventId) return <p className="text-gray-400">대시보드 홈에서 대회를 선택해주세요.</p>;
  if (loading)  return <div className="p-8 text-center text-gray-500">불러오는 중...</div>;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">🏆 단체전 토너먼트 브래킷</h1>

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

      {msg && (
        <div className={`p-3 rounded-xl text-sm ${msg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
          {msg}
        </div>
      )}

      {/* 조별 진행 현황 */}
      <div className={`p-4 rounded-xl border text-sm ${
        allGroupsDone ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold">
            {allGroupsDone ? '✅ 조별 예선 완료!' : '⏳ 조별 예선 진행 중'}
          </span>
          <span className="text-xs font-mono font-bold">
            {groupProgress.finished}/{groupProgress.total}경기
          </span>
        </div>
        {groupProgress.groups.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {groupProgress.groups.map(g => {
              const done = g.total > 0 && g.finished === g.total;
              return (
                <div key={g.id} className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  done ? 'bg-green-100 text-green-700' :
                  g.finished > 0 ? 'bg-amber-100 text-amber-700' : 'bg-stone-100 text-stone-500'
                }`}>
                  <span>{done ? '✓' : `${g.finished}/${g.total}`}</span>
                  <span>{g.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 브래킷 생성 패널 */}
      {!hasTournament && (
        <div className="bg-white rounded-xl border p-4 space-y-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <label className="text-sm text-stone-600">조별 진출:</label>
              <select value={advancePerGroup} onChange={e => setAdvancePerGroup(Number(e.target.value))}
                className="border rounded-lg px-3 py-1.5 text-sm">
                {[1, 2, 3].map(n => <option key={n} value={n}>각 조 {n}위</option>)}
              </select>
            </div>
            {groupProgress.groups.length > 0 && (
              <span className="text-xs text-stone-500">
                → 총 {totalAdvancing}팀 진출 예정
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {allGroupsDone ? (
              <button onClick={() => generateTournament(false)} disabled={generating}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {generating ? '생성 중...' : '🏆 본선 토너먼트 생성'}
              </button>
            ) : (
              <>
                <button onClick={() => generateTournament(true)} disabled={generating}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                  {generating ? '생성 중...' : '🚀 본선 브래킷 미리 생성 (TBD)'}
                </button>
                <button onClick={() => generateTournament(false)} disabled={generating}
                  className="bg-stone-400 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-stone-500 disabled:opacity-50">
                  {generating ? '생성 중...' : '🏆 예선 완료 후 생성'}
                </button>
              </>
            )}
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-stone-400">* 시드 없이 랜덤 배치 · BYE 자동 배정</p>
            {!allGroupsDone && (
              <p className="text-xs text-blue-500">
                * 미리 생성 시: 완료된 조는 실제 팀명, 미완료 조는 "A조 1위" 형태로 표시됩니다.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 브래킷 존재 시: 삭제 + TBD 현황 */}
      {hasTournament && (
        <div className="bg-white rounded-xl border p-4">
          <div className="flex flex-wrap gap-2 items-center">
            <button onClick={deleteTournament}
              className="bg-red-100 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200">
              🗑️ 삭제
            </button>
            {/* TBD 슬롯 수동 채우기 */}
            {hasTbd && groupProgress.groups.length > 0 && (
              <div className="flex flex-wrap gap-1.5 ml-2">
                {groupProgress.groups
                  .filter(g => g.total > 0 && g.finished === g.total)
                  .filter(g => tbdSlots.some(t => t.label.startsWith(g.name)))
                  .map(g => (
                    <button key={g.id} onClick={() => fillGroupSlots(g.id, g.name)}
                      disabled={filling === g.id}
                      className="bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-200 disabled:opacity-50">
                      {filling === g.id ? '처리 중...' : `✅ ${g.name} 슬롯 채우기`}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {hasTbd && (
            <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
              <p className="text-xs font-semibold text-blue-800 mb-1.5">
                ⏳ TBD 슬롯 {tbdSlots.length}개 — 조 경기 완료 시 자동으로 팀명이 채워집니다
              </p>
              <div className="flex flex-wrap gap-1">
                {tbdSlots.map((t, i) => (
                  <span key={i} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          {!hasTbd && !allGroupsDone && (
            <p className="text-xs text-stone-400 mt-2">모든 TBD 슬롯이 채워졌습니다 ✓</p>
          )}
        </div>
      )}

      {/* 브래킷 표시 */}
      {loading ? (
        <p className="text-stone-400 text-center py-10">불러오는 중...</p>
      ) : !hasTournament ? (
        <p className="text-stone-400 text-center py-10">아직 본선 토너먼트가 없습니다.</p>
      ) : (
        <div className="bg-white rounded-xl border p-4 overflow-x-auto">
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
                      const nameA = tie.club_a?.name || (tie as any).qualifier_label_a || (tie.is_bye && !tie.club_a_id ? 'BYE' : 'TBD');
                      const nameB = tie.club_b?.name || (tie as any).qualifier_label_b || (tie.is_bye && !tie.club_b_id ? 'BYE' : 'TBD');
                      const isTbdA = !tie.club_a_id && !tie.is_bye;
                      const isTbdB = !tie.club_b_id && !tie.is_bye;
                      return (
                        <div key={tie.id}
                          className={`border rounded-lg overflow-hidden ${
                            tie.status === 'completed' ? 'border-green-300' :
                            tie.is_bye ? 'border-gray-200 bg-gray-50' : 'border-gray-200'
                          }`} style={{ minHeight: 72 }}>
                          <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                            tie.winning_club_id === tie.club_a_id ? 'bg-green-50 font-bold' : ''
                          }`}>
                            <span className={isTbdA ? 'text-stone-400 italic' : ''}>{nameA}</span>
                            {tie.status === 'completed' && <span className="font-medium">{tie.club_a_rubbers_won}</span>}
                          </div>
                          <div className="border-t" />
                          <div className={`flex items-center justify-between px-3 py-2 text-sm ${
                            tie.winning_club_id === tie.club_b_id ? 'bg-green-50 font-bold' : ''
                          }`}>
                            <span className={isTbdB ? 'text-stone-400 italic' : ''}>{nameB}</span>
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
    </div>
  );
}
