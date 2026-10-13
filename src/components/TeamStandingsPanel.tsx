'use client';
// 단체전 순위표 + 순위 재계산 + 동률 수동 결정
// (예전 /dashboard/teams/standings 화면 — 조편성 화면 안으로 합침. 부서 선택은 부모가 함)

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchStandings, fetchEventTeamConfig, calculateStandings, setManualRank } from '@/lib/team-api';
import type { StandingWithClub, EventTeamConfig } from '@/types/team';

interface Division { id: string; name: string; sort_order: number; }

function getRankStyle(rank: number | null) {
  if (rank === 1) return { bg: 'bg-yellow-50', text: 'text-yellow-700', icon: '🥇' };
  if (rank === 2) return { bg: 'bg-gray-50', text: 'text-gray-600', icon: '🥈' };
  if (rank === 3) return { bg: 'bg-orange-50', text: 'text-orange-600', icon: '🥉' };
  return { bg: '', text: '', icon: '' };
}

export default function TeamStandingsPanel({ eventId, selectedDiv, reloadKey = 0 }: {
  eventId: string
  selectedDiv: string        // '' = 부서 구분 없음
  reloadKey?: number         // 부모가 조편성 등을 다시 만들면 올려서 다시 불러오게 함
}) {
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [groups, setGroups] = useState<any[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [standingsMap, setStandingsMap] = useState<Record<string, StandingWithClub[]>>({});
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [manualModal, setManualModal] = useState<{ club: StandingWithClub; tiedWith: StandingWithClub[] } | null>(null);
  const [manualRanks, setManualRanks] = useState<Record<string, string>>({});
  const [manualNotes, setManualNotes] = useState('');
  const [savingManual, setSavingManual] = useState(false);

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const [cfg, divsRes, grpsRes] = await Promise.all([
      fetchEventTeamConfig(eventId),
      supabase.from('divisions').select('id, name, sort_order').eq('event_id', eventId).order('sort_order'),
      supabase.from('groups').select('*').eq('event_id', eventId).order('division_id').order('group_num'),
    ]);

    setConfig(cfg);
    const divList = divsRes.data || [];
    setDivisions(divList);

    const map: Record<string, StandingWithClub[]> = {};
    if (cfg?.team_format === 'full_league') {
      // ✅ C3 우회: 부서별로 분리 조회
      if (divList.length > 0) {
        const results = await Promise.all(divList.map(d => fetchStandings(eventId, null, d.id)));
        divList.forEach((d, i) => { map[`full_${d.id}`] = results[i]; });
      } else {
        map['full'] = await fetchStandings(eventId, null);
      }
    } else {
      const grps = grpsRes.data || [];
      setGroups(grps);
      const standingsResults = await Promise.all(grps.map(g => fetchStandings(eventId, g.id)));
      grps.forEach((g, i) => { map[g.id] = standingsResults[i]; });
    }

    setStandingsMap(map);
    setLoading(false);
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData, reloadKey]);

  async function handleRecalculate() {
    setRecalculating(true);
    try {
      if (config?.team_format === 'full_league') {
        // ✅ C3 근본: 부서별로 따로 재계산 (순위가 division 내부에서만 부여됨)
        if (divisions.length > 0) {
          await Promise.all(divisions.map(d => calculateStandings(eventId, null, d.id)));
        } else {
          await calculateStandings(eventId, null);
        }
      } else {
        await Promise.all(groups.map(g => calculateStandings(eventId, g.id)));
      }
      await loadData();
    } catch (err: any) { alert(err.message || '순위 재계산 실패'); }
    finally { setRecalculating(false); }
  }

  function findTiedClubs(s: StandingWithClub, all: StandingWithClub[]): StandingWithClub[] {
    return all.filter(x => x.id !== s.id && x.won === s.won && x.rubber_diff === s.rubber_diff && !x.rank_locked && x.played > 0);
  }

  function openManualRank(s: StandingWithClub, all: StandingWithClub[]) {
    const tied = findTiedClubs(s, all);
    const clubs = [s, ...tied];
    const ranks: Record<string, string> = {};
    clubs.forEach(c => { ranks[c.club_id] = ''; });
    setManualRanks(ranks); setManualNotes('');
    setManualModal({ club: s, tiedWith: tied });
  }

  async function handleSaveManualRanks() {
    if (!manualModal) return;
    const all = [manualModal.club, ...manualModal.tiedWith];
    for (const s of all) {
      if (!manualRanks[s.club_id] || isNaN(parseInt(manualRanks[s.club_id]))) { alert('모든 팀의 순위를 입력해주세요.'); return; }
    }
    const rv = all.map(s => parseInt(manualRanks[s.club_id]));
    if (new Set(rv).size !== rv.length) { alert('동일한 순위가 있습니다.'); return; }
    // ✅ 연속성 검증: 입력한 순위가 min~max 범위 내에서 연속이어야 함
    const sorted = [...rv].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i-1] + 1) {
        alert(`순위가 연속되지 않습니다. (${sorted.join(', ')})\n동률 팀은 연속된 순위로 지정해주세요.`);
        return;
      }
    }
    if (sorted[0] < 1) { alert('순위는 1 이상이어야 합니다.'); return; }
    setSavingManual(true);
    try {
      // 마지막 팀까지 저장되면 동률이 풀리고, DB가 본선 자리를 자동으로 채운다
      let reseat: any = null;
      for (const s of all) {
        const r: any = await setManualRank(eventId, s.club_id, parseInt(manualRanks[s.club_id]), manualNotes || '수동 결정');
        if (r && r.success === false) throw new Error(r.error || '순위 저장 실패');
        reseat = r?.reseat ?? null;
      }
      if (reseat?.success === false && reseat.reseat_skipped) alert('⚠️ ' + reseat.error);
      setManualModal(null); await loadData();
    } catch (err: any) { alert(err.message || '순위 저장 실패'); }
    finally { setSavingManual(false); }
  }

  // 선택한 부서의 순위표만
  const visible = Object.entries(standingsMap).filter(([key]) => {
    const group = groups.find(g => g.id === key);
    const isFullKey = key === 'full' || key.startsWith('full_');
    const fullDivId = key.startsWith('full_') ? key.slice(5) : null;
    if (!selectedDiv) return true;
    if (isFullKey) {
      // full_{divId} 키는 해당 부서일 때만, 레거시 'full'은 부서 없을 때만 표시
      if (fullDivId && fullDivId !== selectedDiv) return false;
      if (!fullDivId && divisions.length > 0) return false;
      return true;
    }
    return !!group && group.division_id === selectedDiv;
  });
  const hasTied = visible.some(([, list]) => list.some(s => s.is_tied));

  return (
    <div id="standings" className="space-y-4 scroll-mt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">📊 순위</h2>
        <button onClick={handleRecalculate} disabled={recalculating || loading}
          className="bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded text-sm disabled:opacity-50">
          {recalculating ? '계산중..' : '🔄 순위 재계산'}
        </button>
      </div>

      {loading ? (
        <div className="p-6 text-center text-gray-400 text-sm">순위 불러오는 중..</div>
      ) : (
        <>
          {hasTied && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start gap-3">
              <span className="text-yellow-500 text-xl">⚠️</span>
              <div>
                <p className="font-medium text-yellow-800">동률 팀이 있습니다</p>
                <p className="text-sm text-yellow-700 mt-1">노란색 줄(동률 팀)을 눌러 순위를 직접 정해주세요.</p>
              </div>
            </div>
          )}

          {visible.map(([key, standings]) => {
            const group = groups.find(g => g.id === key);
            const isFullKey = key === 'full' || key.startsWith('full_');
            const fullDivId = key.startsWith('full_') ? key.slice(5) : null;
            const groupNumLabel = group?.group_num ? String.fromCharCode(64 + group.group_num) + '조' : '';
            const groupName = isFullKey
              ? (fullDivId ? `${divisions.find(d => d.id === fullDivId)?.name || ''} 리그 순위표` : '리그 순위표')
              : group?.group_label || groupNumLabel || group?.group_name || key;

            return (
              <div key={key} className="bg-white rounded-lg border overflow-hidden">
                <div className="bg-gray-50 px-4 py-3 font-semibold">{groupName}</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-t">
                      <tr>
                        <th className="px-4 py-3 text-left w-16">순위</th>
                        <th className="px-4 py-3 text-left">팀명</th>
                        <th className="px-4 py-3 text-center w-16">경기</th>
                        <th className="px-4 py-3 text-center w-16">승</th>
                        <th className="px-4 py-3 text-center w-16">패</th>
                        <th className="px-4 py-3 text-center w-20">러버승</th>
                        <th className="px-4 py-3 text-center w-20">러버패</th>
                        <th className="px-4 py-3 text-center w-20">득실차</th>
                        <th className="px-4 py-3 text-center w-24">상태</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {standings.length === 0 && (
                        <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-400">데이터 없음</td></tr>
                      )}
                      {standings.map(s => {
                        const isTied = s.is_tied;
                        const rs = getRankStyle(s.rank);
                        return (
                          <tr key={s.id}
                            className={`${isTied ? 'bg-yellow-50 cursor-pointer hover:bg-yellow-100' : rs.bg ? rs.bg + ' ' : ''}`}
                            onClick={isTied ? () => openManualRank(s, standings) : undefined}>
                            <td className="px-4 py-3">
                              {s.rank !== null ? (
                                <span className="flex items-center gap-1">
                                  {rs.icon && <span className="text-base">{rs.icon}</span>}
                                  <span className={`font-bold text-lg ${rs.text}`}>{s.rank}</span>
                                </span>
                              ) : <span className="text-yellow-600 font-medium">-</span>}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`font-medium ${rs.text}`}>{s.club?.name || '-'}</span>
                              {s.club?.seed_number && (
                                <span className="ml-2 text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">{s.club.seed_number}시드</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">{s.played}</td>
                            <td className="px-4 py-3 text-center font-bold">
                              <span className={s.won > 0 ? 'text-blue-600' : ''}>{s.won}</span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={s.lost > 0 ? 'text-red-500' : ''}>{s.lost}</span>
                            </td>
                            <td className="px-4 py-3 text-center">{s.rubbers_for}</td>
                            <td className="px-4 py-3 text-center">{s.rubbers_against}</td>
                            <td className="px-4 py-3 text-center font-bold">
                              <span className={s.rubber_diff > 0 ? 'text-green-600' : s.rubber_diff < 0 ? 'text-red-600' : ''}>
                                {s.rubber_diff > 0 ? '+' : ''}{s.rubber_diff}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {s.rank_locked
                                ? <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">확정 ✓</span>
                                : isTied
                                ? <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded">동률 ⚠️</span>
                                : s.played > 0
                                ? <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">자동</span>
                                : <span className="text-xs text-gray-400">대기</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {visible.length === 0 && (
            <div className="text-center text-gray-400 py-6 text-sm">순위 데이터가 없습니다. 조편성(또는 풀리그)을 먼저 만들어주세요.</div>
          )}
        </>
      )}

      {/* 동률 수동 순위 모달 */}
      {manualModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setManualModal(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">동률 순위 결정</h3>
            <div className="bg-yellow-50 rounded p-3 text-sm">
              <p className="text-yellow-800">승수: {manualModal.club.won}승 · 득실차: {manualModal.club.rubber_diff > 0 ? '+' : ''}{manualModal.club.rubber_diff}</p>
            </div>
            <div className="space-y-3">
              {[manualModal.club, ...manualModal.tiedWith].map(s => (
                <div key={s.club_id} className="flex items-center gap-3">
                  <span className="font-medium flex-1">{s.club?.name}</span>
                  <div className="flex items-center gap-1">
                    <input type="number" min={1} value={manualRanks[s.club_id] || ''}
                      onChange={e => setManualRanks(prev => ({ ...prev, [s.club_id]: e.target.value }))}
                      placeholder="순위" className="border rounded px-3 py-2 w-20 text-center" />
                    <span className="text-sm text-gray-400">위</span>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">사유 (선택)</label>
              <input value={manualNotes} onChange={e => setManualNotes(e.target.value)}
                placeholder="수동 결정 이유" className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={handleSaveManualRanks} disabled={savingManual}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
                {savingManual ? '저장중...' : '순위 확정'}
              </button>
              <button onClick={() => setManualModal(null)}
                className="flex-1 bg-gray-100 py-3 rounded-lg font-medium hover:bg-gray-200">취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
