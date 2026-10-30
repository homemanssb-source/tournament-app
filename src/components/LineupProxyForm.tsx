// ============================================================
// 운영자 오더 대리입력 (039)
// src/components/LineupProxyForm.tsx
//
// 주장이 오더를 안 낼 때 운영본부가 종이·구두로 받은 오더를 대신 넣는다.
// - 대시보드(로그인)와 현장 마스터 PIN 화면이 같이 씀 → 제출 함수는 props 로 받음
// - "직전 오더 불러오기": 같은 클럽이 이 대회에서 마지막으로 낸 오더로 채움
// - 검증 규칙은 주장 제출과 같음 (서버에서도 한 번 더 검사)
// ============================================================
'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchClubMembers, fetchPrevLineup } from '@/lib/team-api';
import { getGenderLabel } from '@/lib/team-utils';
import type { TieWithClubs, TeamLineup, ClubMember, LineupEntry, RpcResult } from '@/types/team';

type Row = { player1_id: string; player2_id: string; empty?: boolean };

export default function LineupProxyForm({ tie, side, existing, submit, onClose, onDone }: {
  tie: TieWithClubs;
  side: 'a' | 'b';
  existing: TeamLineup[];   // 이 대전의 라인업 (운영자 조회분) — 이미 냈으면 그 값으로 채움
  submit: (entries: LineupEntry[]) => Promise<RpcResult>;
  onClose: () => void;
  onDone: (result: RpcResult) => void;
}) {
  const club = side === 'a' ? tie.club_a : tie.club_b;
  const opponent = side === 'a' ? tie.club_b : tie.club_a;
  const clubId = (side === 'a' ? tie.club_a_id : tie.club_b_id) as string;
  const alreadySubmitted = side === 'a' ? tie.club_a_lineup_submitted : tie.club_b_lineup_submitted;

  const [members, setMembers] = useState<ClubMember[]>([]);
  const [allowEmptyOrder, setAllowEmptyOrder] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => toRows(existing.filter(l => l.club_id === clubId), tie.rubber_count));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    (async () => {
      const [ml, dv] = await Promise.all([
        fetchClubMembers(clubId),
        tie.division_id
          ? supabase.from('divisions').select('allow_empty_order').eq('id', tie.division_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      setMembers(ml);
      setAllowEmptyOrder(!!(dv as any).data?.allow_empty_order);
      setLoading(false);
    })();
  }, [clubId, tie.division_id]);

  async function loadPrev() {
    setError(''); setInfo('');
    try {
      const prev = await fetchPrevLineup(tie.id, clubId);
      if (prev.length === 0) { setInfo('이 대회에서 공개된 직전 오더가 없습니다.'); return; }
      // 직전 대전과 복식 수가 다르면 앞에서부터 채우고 남는 칸은 비워 둠
      setRows(toRows(prev, tie.rubber_count));
      setInfo('직전 오더를 불러왔습니다. 확인 후 제출하세요.');
    } catch (e: any) {
      setError(e.message || '직전 오더를 불러오지 못했습니다.');
    }
  }

  async function handleSubmit() {
    const empties = rows.filter(l => l.empty).length;
    if (empties > 0 && !allowEmptyOrder) { setError('이 부서는 공오더를 허용하지 않습니다.'); return; }
    if (empties > 1) { setError('공오더는 대전당 1개 복식까지만 가능합니다.'); return; }
    const used = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].empty) continue;
      if (!rows[i].player1_id || !rows[i].player2_id) { setError('복식 ' + (i + 1) + '의 선수를 모두 선택하세요.'); return; }
      if (rows[i].player1_id === rows[i].player2_id) { setError('복식 ' + (i + 1) + '에 같은 선수를 두 번 배정할 수 없습니다.'); return; }
      for (const pid of [rows[i].player1_id, rows[i].player2_id]) {
        if (used.has(pid)) { setError('선수 중복: 복식 ' + used.get(pid) + '과 복식 ' + (i + 1) + '에 같은 선수가 있습니다.'); return; }
        used.set(pid, i + 1);
      }
    }
    const opponentSubmitted = side === 'a' ? tie.club_b_lineup_submitted : tie.club_a_lineup_submitted;
    if (!confirm(`${club?.name} 오더를 운영자 대리입력으로 제출합니다.` +
      (opponentSubmitted ? '\n상대가 이미 제출해서 제출 즉시 양 팀 오더가 공개됩니다.' : '') + '\n계속할까요?')) return;

    setError(''); setSubmitting(true);
    try {
      const entries: LineupEntry[] = rows.map((l, i) => ({
        rubber_number: i + 1, player1_id: l.empty ? '' : l.player1_id, player2_id: l.empty ? '' : l.player2_id,
      }));
      const result = await submit(entries);
      if (!result.success) { setError(result.error || '제출 실패'); return; }
      onDone(result);
    } catch (e: any) {
      setError(e.message || '제출 실패');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-gray-50 w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-4 space-y-3"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-bold">📝 오더 대리입력 — {club?.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              #{tie.tie_order} 상대 {opponent?.name} · {tie.rubber_count}복식
              {alreadySubmitted && <span className="text-orange-600"> · 이미 제출됨 (덮어씀)</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 px-2">✕</button>
        </div>

        <button onClick={loadPrev} disabled={loading}
          className="w-full text-sm bg-white border border-blue-200 text-blue-700 py-2 rounded-lg hover:bg-blue-50 disabled:opacity-50">
          ↺ 직전 오더 불러오기
        </button>
        {info && <p className="text-xs text-blue-600 text-center">{info}</p>}

        {loading ? (
          <p className="text-center text-gray-400 text-sm py-6">선수 불러오는 중...</p>
        ) : rows.map((row, idx) => (
          <div key={idx} className="bg-white rounded-xl border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium text-sm text-gray-600">복식 {idx + 1}</div>
              {allowEmptyOrder && (
                <label className={`text-xs flex items-center gap-1 ${!row.empty && rows.some(l => l.empty) ? 'text-gray-300' : 'text-orange-600'}`}>
                  <input type="checkbox" checked={!!row.empty}
                    disabled={!row.empty && rows.some(l => l.empty)}
                    onChange={e => { const u = [...rows]; u[idx] = { player1_id: '', player2_id: '', empty: e.target.checked }; setRows(u); }} />
                  공오더
                </label>
              )}
            </div>
            {row.empty ? (
              <p className="text-sm text-orange-600 bg-orange-50 rounded-lg px-3 py-2">이 복식은 공오더로 제출됩니다.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {[0, 1].map(pIdx => {
                  const cur = pIdx === 0 ? row.player1_id : row.player2_id;
                  return (
                    <select key={pIdx} value={cur}
                      onChange={e => {
                        const u = [...rows];
                        u[idx] = pIdx === 0 ? { ...u[idx], player1_id: e.target.value } : { ...u[idx], player2_id: e.target.value };
                        setRows(u);
                      }}
                      className="w-full border rounded-lg px-2 py-2 text-sm">
                      <option value="">선수 {pIdx + 1}</option>
                      {members.map(m => {
                        const taken = m.id !== cur && rows.some(l => !l.empty && (l.player1_id === m.id || l.player2_id === m.id));
                        return <option key={m.id} value={m.id} disabled={taken}>{m.name} ({getGenderLabel(m.gender)}){taken ? ' · 배정됨' : ''}</option>;
                      })}
                    </select>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {error && <p className="text-red-500 text-sm text-center">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-gray-200 py-3 rounded-xl text-sm">취소</button>
          <button onClick={handleSubmit} disabled={submitting || loading}
            className="flex-[2] bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50">
            {submitting ? '제출중...' : '운영자 대리입력 제출'}
          </button>
        </div>
      </div>
    </div>
  );
}

function toRows(lineups: TeamLineup[], count: number): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const l = lineups.find(x => x.rubber_number === i + 1);
    if (!l) return { player1_id: '', player2_id: '' };
    return { player1_id: l.player1_id || '', player2_id: l.player2_id || '', empty: !l.player1_id && !l.player2_id };
  });
}
