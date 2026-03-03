// ============================================================
// 개인전 본선 결과 전송 컴포넌트 (App B → App A)
// src/components/SyncResults.tsx
//
// 대시보드에서 사용: <SyncResults eventId={eventId} />
// 32강~결승 완료된 경기를 App A DB로 전송
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase, getAppAClient } from '@/lib/supabase';
import { fetchFinalsMatches, sendResultsToAppA } from '@/lib/team-api';

interface Props {
  eventId: string;
}

interface MatchPreview {
  id: string;
  match_num: string;
  division_name: string;
  round: string;
  team_a_name: string;
  team_b_name: string;
  score: string;
  winner_name: string;
  ended_at: string;
}

const ROUND_LABELS: Record<string, string> = {
  'R32': '32강', 'R16': '16강', 'QF': '8강', 'SF': '4강', 'F': '결승',
};

const ROUND_ORDER: Record<string, number> = {
  'R32': 1, 'R16': 2, 'QF': 3, 'SF': 4, 'F': 5,
};

export default function SyncResults({ eventId }: Props) {
  const [matches, setMatches] = useState<MatchPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ synced: number; skipped: number; errors: string[] } | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // 이전 전송 기록 확인
  const checkLastSync = useCallback(async () => {
    try {
      const appA = getAppAClient();
      const { data } = await appA
        .from('app_b_match_results')
        .select('synced_at')
        .eq('event_id', eventId)
        .order('synced_at', { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        setLastSyncedAt(data[0].synced_at);
      }
    } catch {
      // App A 접근 실패해도 무시
    }
  }, [eventId]);

  // 본선 경기 로드
  const loadMatches = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchFinalsMatches(eventId);
      // 라운드순 정렬
      const sorted = data.sort((a: any, b: any) => {
        const ra = ROUND_ORDER[a.round] || 0;
        const rb = ROUND_ORDER[b.round] || 0;
        if (ra !== rb) return ra - rb;
        return (a.match_num || '').localeCompare(b.match_num || '');
      });
      setMatches(sorted);
    } catch (e: any) {
      console.error('본선 경기 로드 실패:', e);
    }
    setLoading(false);
  }, [eventId]);

  useEffect(() => {
    loadMatches();
    checkLastSync();
  }, [loadMatches, checkLastSync]);

  // 결과 전송
  async function handleSync() {
    if (matches.length === 0) {
      alert('전송할 본선 경기가 없습니다.');
      return;
    }
    if (!confirm(`${matches.length}경기의 본선 결과를 App A로 전송합니다.\n계속하시겠습니까?`)) return;

    setSyncing(true);
    setResult(null);
    try {
      const appA = getAppAClient();
      const res = await sendResultsToAppA(appA, eventId, matches);
      setResult(res);
      if (res.synced > 0) {
        setLastSyncedAt(new Date().toISOString());
      }
      if (res.errors.length > 0) {
        console.error('전송 오류:', res.errors);
      }
    } catch (e: any) {
      alert('전송 실패: ' + e.message);
    }
    setSyncing(false);
  }

  // 라운드별 그룹핑
  const byRound = new Map<string, MatchPreview[]>();
  for (const m of matches) {
    const key = m.round;
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key)!.push(m);
  }
  const roundKeys = Array.from(byRound.keys()).sort((a, b) => (ROUND_ORDER[a] || 0) - (ROUND_ORDER[b] || 0));

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <div className="px-4 py-3 bg-blue-50 border-b flex items-center justify-between">
        <div>
          <h3 className="font-bold text-sm text-blue-800">📤 개인전 본선 결과 전송</h3>
          <p className="text-xs text-blue-600 mt-0.5">
            32강~결승 완료 경기를 App A로 전송합니다
          </p>
        </div>
        <div className="text-right">
          {lastSyncedAt && (
            <p className="text-xs text-blue-500">
              마지막 전송: {new Date(lastSyncedAt).toLocaleString('ko-KR')}
            </p>
          )}
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <p className="text-center text-gray-400 py-6">본선 경기 조회중...</p>
        ) : matches.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-gray-400">전송 가능한 본선 경기가 없습니다.</p>
            <p className="text-xs text-gray-400 mt-1">32강~결승 중 완료(FINISHED) 상태인 경기만 전송됩니다.</p>
          </div>
        ) : (
          <>
            {/* 요약 */}
            <div className="flex gap-3 mb-4">
              {roundKeys.map(round => (
                <div key={round} className="bg-gray-50 rounded-lg px-3 py-2 text-center flex-1">
                  <p className="text-xs text-gray-500">{ROUND_LABELS[round] || round}</p>
                  <p className="text-lg font-bold">{byRound.get(round)?.length || 0}</p>
                </div>
              ))}
              <div className="bg-blue-50 rounded-lg px-3 py-2 text-center flex-1">
                <p className="text-xs text-blue-600">전체</p>
                <p className="text-lg font-bold text-blue-700">{matches.length}</p>
              </div>
            </div>

            {/* 경기 목록 (접이식) */}
            <details className="mb-4">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700 mb-2">
                전송 대상 경기 상세보기 ({matches.length}경기)
              </summary>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {roundKeys.map(round => (
                  <div key={round}>
                    <p className="text-xs font-semibold text-gray-600 py-1 sticky top-0 bg-white">
                      {ROUND_LABELS[round] || round}
                    </p>
                    {(byRound.get(round) || []).map(m => (
                      <div key={m.id} className="flex items-center justify-between py-1.5 px-2 text-xs bg-gray-50 rounded mb-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-400">{m.match_num}</span>
                          <span className="text-gray-500">{m.division_name}</span>
                          <span className="font-medium">{m.team_a_name}</span>
                          <span className="text-gray-300">vs</span>
                          <span className="font-medium">{m.team_b_name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-green-600">{m.score}</span>
                          <span className="text-blue-600">🏆 {m.winner_name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>

            {/* 전송 버튼 */}
            <button
              onClick={handleSync}
              disabled={syncing}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {syncing ? '전송 중...' : `📤 ${matches.length}경기 App A로 전송`}
            </button>
          </>
        )}

        {/* 전송 결과 */}
        {result && (
          <div className={`mt-4 rounded-lg p-4 ${result.errors.length > 0 ? 'bg-yellow-50 border border-yellow-200' : 'bg-green-50 border border-green-200'}`}>
            <h4 className={`text-sm font-bold mb-2 ${result.errors.length > 0 ? 'text-yellow-800' : 'text-green-800'}`}>
              {result.errors.length > 0 ? '⚠️ 일부 오류 발생' : '✅ 전송 완료'}
            </h4>
            <div className="flex gap-3 text-sm">
              <div>
                <span className="text-green-600 font-bold">{result.synced}</span>
                <span className="text-gray-500 ml-1">전송 성공</span>
              </div>
              <div>
                <span className="text-gray-500 font-bold">{result.skipped}</span>
                <span className="text-gray-500 ml-1">중복 스킵</span>
              </div>
              {result.errors.length > 0 && (
                <div>
                  <span className="text-red-600 font-bold">{result.errors.length}</span>
                  <span className="text-gray-500 ml-1">오류</span>
                </div>
              )}
            </div>
            {result.errors.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-red-600 cursor-pointer">오류 상세</summary>
                <div className="mt-1 space-y-0.5">
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-xs text-red-500">{err}</p>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* 새로고침 */}
        <button
          onClick={loadMatches}
          className="w-full mt-3 text-sm text-gray-500 hover:text-gray-700 py-2"
        >
          🔄 경기 목록 새로고침
        </button>
      </div>
    </div>
  );
}
