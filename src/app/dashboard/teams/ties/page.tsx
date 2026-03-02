// ============================================================
// 대전 관리/스코어보드
// src/app/dashboard/team/ties/page.tsx
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  fetchTies, fetchRubbers, fetchClubMembers,
  recordRubberScore, advanceTournamentWinner, fetchEventTeamConfig,
} from '@/lib/team-api';
import { getTieStatusLabel, getTieStatusColor, getRoundLabel, formatSetScore, getMajority } from '@/lib/team-utils';
import type { TieWithClubs, TieRubber, ClubMember, EventTeamConfig } from '@/types/team';

export default function TiesPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // 선택된 대전
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null);
  const [rubbers, setRubbers] = useState<TieRubber[]>([]);
  const [membersA, setMembersA] = useState<ClubMember[]>([]);
  const [membersB, setMembersB] = useState<ClubMember[]>([]);

  // 점수입력 모달
  const [scoringRubber, setScoringRubber] = useState<TieRubber | null>(null);
  const [scoreForm, setScoreForm] = useState({ set1_a: '', set1_b: '', set2_a: '', set2_b: '', set3_a: '', set3_b: '' });
  const [submitting, setSubmitting] = useState(false);

  // 필터
  const [roundFilter, setRoundFilter] = useState<string>('all');

  const loadTies = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    const [tieList, cfg] = await Promise.all([
      fetchTies(eventId),
      fetchEventTeamConfig(eventId),
    ]);
    setTies(tieList);
    setConfig(cfg);
    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadTies(); }, [loadTies]);

  async function openTie(tie: TieWithClubs) {
    setSelectedTie(tie);
    const r = await fetchRubbers(tie.id);
    setRubbers(r);
    if (tie.club_a_id) {
      const ma = await fetchClubMembers(tie.club_a_id);
      setMembersA(ma);
    }
    if (tie.club_b_id) {
      const mb = await fetchClubMembers(tie.club_b_id);
      setMembersB(mb);
    }
  }

  function openScoring(rubber: TieRubber) {
    setScoringRubber(rubber);
    setScoreForm({
      set1_a: rubber.set1_a?.toString() || '',
      set1_b: rubber.set1_b?.toString() || '',
      set2_a: rubber.set2_a?.toString() || '',
      set2_b: rubber.set2_b?.toString() || '',
      set3_a: rubber.set3_a?.toString() || '',
      set3_b: rubber.set3_b?.toString() || '',
    });
  }

  async function handleScoreSubmit() {
    if (!scoringRubber) return;
    const s1a = parseInt(scoreForm.set1_a);
    const s1b = parseInt(scoreForm.set1_b);
    if (isNaN(s1a) || isNaN(s1b)) return alert('1세트 점수를 입력하세요.');

    setSubmitting(true);
    try {
      const result = await recordRubberScore(
        scoringRubber.id,
        s1a, s1b,
        scoreForm.set2_a ? parseInt(scoreForm.set2_a) : null,
        scoreForm.set2_b ? parseInt(scoreForm.set2_b) : null,
        scoreForm.set3_a ? parseInt(scoreForm.set3_a) : null,
        scoreForm.set3_b ? parseInt(scoreForm.set3_b) : null,
      );
      if (!result.success) { alert(result.error); return; }

      // 토너먼트 대전이면 승자 진출 처리
      if (selectedTie && ['quarter', 'semi', 'final', 'round_of_16'].includes(selectedTie.round || '')) {
        // 대전 결과 확인 후 진출
        const updatedRubbers = await fetchRubbers(selectedTie.id);
        const completedCount = updatedRubbers.filter(r => r.status === 'completed').length;
        const aWins = updatedRubbers.filter(r => r.winning_club_id === selectedTie.club_a_id).length;
        const bWins = updatedRubbers.filter(r => r.winning_club_id === selectedTie.club_b_id).length;
        const majority = getMajority(selectedTie.rubber_count);

        if (aWins >= majority || bWins >= majority) {
          await advanceTournamentWinner(selectedTie.id);
        }
      }

      setScoringRubber(null);
      if (selectedTie) await openTie(selectedTie);
      await loadTies();
    } catch (err: any) {
      alert(err.message || '점수 입력 실패');
    } finally {
      setSubmitting(false);
    }
  }

  // 라운드 목록 추출
  const rounds = [...new Set(ties.map(t => t.round).filter(Boolean))] as string[];
  const filteredTies = roundFilter === 'all' ? ties : ties.filter(t => t.round === roundFilter);

  // 선수 이름 찾기
  function getPlayerName(id: string | null, side: 'a' | 'b'): string {
    if (!id) return '-';
    const list = side === 'a' ? membersA : membersB;
    return list.find(m => m.id === id)?.name || '-';
  }

  if (loading) return <div className="p-8 text-center text-gray-500">로딩중...</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">⚔️ 대전 관리</h1>

      {/* 라운드 필터 */}
      {rounds.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setRoundFilter('all')}
            className={`px-3 py-1.5 rounded text-sm ${roundFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}
          >
            전체 ({ties.length})
          </button>
          {rounds.map(r => (
            <button
              key={r}
              onClick={() => setRoundFilter(r)}
              className={`px-3 py-1.5 rounded text-sm ${roundFilter === r ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}
            >
              {getRoundLabel(r)} ({ties.filter(t => t.round === r).length})
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* ── 왼쪽: 대전 목록 ── */}
        <div className="lg:col-span-2 space-y-2">
          {filteredTies.length === 0 ? (
            <div className="text-center text-gray-400 py-8">대전이 없습니다.</div>
          ) : (
            filteredTies.map(tie => (
              <div
                key={tie.id}
                onClick={() => !tie.is_bye && openTie(tie)}
                className={`bg-white rounded-lg border p-4 transition ${
                  tie.is_bye ? 'opacity-50' : 'cursor-pointer hover:border-blue-300'
                } ${selectedTie?.id === tie.id ? 'border-blue-500 ring-2 ring-blue-100' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">
                    {getRoundLabel(tie.round || '')} #{tie.tie_order}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded ${getTieStatusColor(tie.status)}`}>
                    {getTieStatusLabel(tie.status)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="font-medium">
                    {tie.club_a?.name || 'TBD'}
                    <span className="text-gray-400 mx-2 text-sm">vs</span>
                    {tie.club_b?.name || 'TBD'}
                  </div>
                  {tie.status === 'completed' && (
                    <span className="font-bold text-lg">
                      {tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}
                    </span>
                  )}
                  {tie.status === 'in_progress' && (
                    <span className="text-sm text-green-600">
                      {tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}
                    </span>
                  )}
                </div>
                {/* 라인업 상태 */}
                {tie.status === 'lineup_phase' && (
                  <div className="text-xs text-yellow-600 mt-1">
                    {tie.club_a_lineup_submitted ? '✅' : '⏳'} {tie.club_a?.name}
                    {' / '}
                    {tie.club_b_lineup_submitted ? '✅' : '⏳'} {tie.club_b?.name}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* ── 오른쪽: 대전 상세 ── */}
        <div className="lg:col-span-3">
          {selectedTie ? (
            <div className="bg-white rounded-lg border p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">
                  {selectedTie.club_a?.name} vs {selectedTie.club_b?.name}
                </h2>
                <span className={`text-sm px-3 py-1 rounded ${getTieStatusColor(selectedTie.status)}`}>
                  {getTieStatusLabel(selectedTie.status)}
                </span>
              </div>

              {selectedTie.status === 'completed' && (
                <div className="text-center py-2">
                  <span className="text-3xl font-bold">
                    {selectedTie.club_a_rubbers_won} - {selectedTie.club_b_rubbers_won}
                  </span>
                  <p className="text-sm text-gray-500 mt-1">
                    과반수 {getMajority(selectedTie.rubber_count)}승
                  </p>
                </div>
              )}

              {/* 러버 목록 */}
              <div className="space-y-3">
                {rubbers.map(rubber => (
                  <div
                    key={rubber.id}
                    className={`border rounded-lg p-3 ${rubber.status === 'completed' ? 'bg-gray-50' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-sm">복식 {rubber.rubber_number}</span>
                      <div className="flex items-center gap-2">
                        {rubber.status === 'completed' ? (
                          <span className="text-green-600 text-sm font-bold">
                            {formatSetScore(rubber.set1_a, rubber.set1_b)}
                            {rubber.set2_a !== null && ` / ${formatSetScore(rubber.set2_a, rubber.set2_b)}`}
                            {rubber.set3_a !== null && ` / ${formatSetScore(rubber.set3_a, rubber.set3_b)}`}
                          </span>
                        ) : (
                          <button
                            onClick={() => openScoring(rubber)}
                            className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded hover:bg-blue-700"
                          >
                            점수입력
                          </button>
                        )}
                        {rubber.pin_code && (
                          <span className="text-xs text-gray-400" title="PIN">
                            PIN: {rubber.pin_code}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* 선수 표시 (라인업 공개 후) */}
                    {(rubber.club_a_player1_id || rubber.club_b_player1_id) && (
                      <div className="text-xs text-gray-600 grid grid-cols-2 gap-2">
                        <div>
                          {getPlayerName(rubber.club_a_player1_id, 'a')} / {getPlayerName(rubber.club_a_player2_id, 'a')}
                        </div>
                        <div className="text-right">
                          {getPlayerName(rubber.club_b_player1_id, 'b')} / {getPlayerName(rubber.club_b_player2_id, 'b')}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 rounded-lg border border-dashed p-8 text-center text-gray-400">
              왼쪽에서 대전을 선택하세요.
            </div>
          )}
        </div>
      </div>

      {/* ── 점수입력 모달 ── */}
      {scoringRubber && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setScoringRubber(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">
              복식 {scoringRubber.rubber_number} 점수입력
            </h3>

            <div className="space-y-3">
              {/* 1세트 (필수) */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">1세트 *</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" max="7"
                    value={scoreForm.set1_a}
                    onChange={e => setScoreForm(p => ({ ...p, set1_a: e.target.value }))}
                    className="border rounded px-3 py-2 w-20 text-center text-lg"
                    placeholder={selectedTie?.club_a?.name?.slice(0, 4)}
                  />
                  <span className="text-gray-400">:</span>
                  <input
                    type="number" min="0" max="7"
                    value={scoreForm.set1_b}
                    onChange={e => setScoreForm(p => ({ ...p, set1_b: e.target.value }))}
                    className="border rounded px-3 py-2 w-20 text-center text-lg"
                    placeholder={selectedTie?.club_b?.name?.slice(0, 4)}
                  />
                </div>
              </div>

              {/* 2세트 (3세트 매치일 때) */}
              {config?.team_sets_per_rubber === 3 && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">2세트</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="0" max="7"
                        value={scoreForm.set2_a}
                        onChange={e => setScoreForm(p => ({ ...p, set2_a: e.target.value }))}
                        className="border rounded px-3 py-2 w-20 text-center text-lg"
                      />
                      <span className="text-gray-400">:</span>
                      <input
                        type="number" min="0" max="7"
                        value={scoreForm.set2_b}
                        onChange={e => setScoreForm(p => ({ ...p, set2_b: e.target.value }))}
                        className="border rounded px-3 py-2 w-20 text-center text-lg"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">3세트 (동률 시)</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="0" max="7"
                        value={scoreForm.set3_a}
                        onChange={e => setScoreForm(p => ({ ...p, set3_a: e.target.value }))}
                        className="border rounded px-3 py-2 w-20 text-center text-lg"
                      />
                      <span className="text-gray-400">:</span>
                      <input
                        type="number" min="0" max="7"
                        value={scoreForm.set3_b}
                        onChange={e => setScoreForm(p => ({ ...p, set3_b: e.target.value }))}
                        className="border rounded px-3 py-2 w-20 text-center text-lg"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleScoreSubmit}
                disabled={submitting}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? '저장중...' : '점수 저장'}
              </button>
              <button
                onClick={() => setScoringRubber(null)}
                className="flex-1 bg-gray-100 py-3 rounded-lg font-medium hover:bg-gray-200"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
