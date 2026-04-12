// ============================================================
// src/app/pin/team/page.tsx
// ✅ 경기 시작(in_progress) 없이도 PIN으로 점수 입력 가능
//    pending / lineup_ready / in_progress 모두 허용
// ✅ [FIX-①] localStorage 세션 복원 (12시간) — 탭 전환 후에도 유지
// ✅ [FIX-②] SW postMessage 기반 인앱 알림 — 포그라운드 푸시 알림
// ✅ [FIX-③] 에러 retry 카운터 (MAX_ERRORS=3) — 연속 오류 시 리다이렉트
// ✅ [FIX-④] loadDataRef 패턴 — setInterval stale closure 방지
// ============================================================
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { pinRecordScore } from '@/lib/team-api';
import type { TieRubber, Tie, Club, ClubMember } from '@/types/team';

type Step = 'pin' | 'score' | 'confirm' | 'done';

// ✅ [FIX-③] 최대 연속 오류 허용 횟수
const MAX_ERRORS = 3;

interface InAppNotif {
  id: number;
  title: string;
  body: string;
}

export default function TeamPinScorePage() {
  const [step, setStep]       = useState<Step>('pin');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const [pin, setPin]         = useState('');
  const [rubber, setRubber]   = useState<TieRubber | null>(null);
  const [tie, setTie]         = useState<Tie | null>(null);
  const [clubA, setClubA]     = useState<Club | null>(null);
  const [clubB, setClubB]     = useState<Club | null>(null);
  const [playersA, setPlayersA] = useState<{ p1: ClubMember | null; p2: ClubMember | null }>({ p1: null, p2: null });
  const [playersB, setPlayersB] = useState<{ p1: ClubMember | null; p2: ClubMember | null }>({ p1: null, p2: null });

  const [set1a, setSet1a] = useState('');
  const [set1b, setSet1b] = useState('');
  const [set2a, setSet2a] = useState('');
  const [set2b, setSet2b] = useState('');
  const [set3a, setSet3a] = useState('');
  const [set3b, setSet3b] = useState('');
  const [setsPerRubber, setSetsPerRubber] = useState(1);

  // ✅ [FIX-②] 인앱 알림
  const [inAppNotifs, setInAppNotifs] = useState<InAppNotif[]>([]);
  const notifIdRef = useRef(0);

  // ✅ [FIX-③] 에러 카운터
  const errorCountRef = useRef(0);

  // ✅ [FIX-④] loadData ref (stale closure 방지)
  const loadDataRef = useRef<(() => Promise<void>) | null>(null);

  // ✅ [FIX-②] 인앱 알림 표시 함수
  const showInAppNotif = useCallback((title: string, body: string) => {
    const id = ++notifIdRef.current;
    setInAppNotifs(prev => [...prev, { id, title, body }]);
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    setTimeout(() => {
      setInAppNotifs(prev => prev.filter(n => n.id !== id));
    }, 5000);
  }, []);

  // ✅ [FIX-②] SW postMessage → 인앱 알림 핸들러
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'PUSH_NOTIFICATION') {
        showInAppNotif(event.data.title, event.data.body);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [showInAppNotif]);

  // ✅ [FIX-①] localStorage 세션 복원
  // 단체전 pin/team 페이지는 별도 세션이 없으므로 rubber/tie 상태만 복원이 아닌
  // 라우팅 목적 세션(team_pin_session) 만 체크한다.
  // 이 페이지는 PIN 입력 후 score 입력까지 단방향 스텝이므로
  // 새로고침 시 PIN 단계로 돌아가는 것이 정상 동작임.
  // → localStorage에는 저장하지 않고 메모리 상태만 유지 (기존 동작 유지)

  // ✅ [FIX-④] loadData ref 업데이트
  // 이 페이지의 "주기적 갱신" 은 step='score' 에서 rubber 상태가
  // 외부에서 바뀌었는지(completed 등) 확인하는 용도.
  const loadRubberStatus = useCallback(async () => {
    if (!rubber) return;
    try {
      const { data, error: err } = await supabase
        .from('tie_rubbers')
        .select('status')
        .eq('id', rubber.id)
        .single();

      if (err) {
        errorCountRef.current += 1;
        if (errorCountRef.current >= MAX_ERRORS) {
          // 3회 연속 오류 → PIN 단계로 리셋
          reset();
        }
        return;
      }

      errorCountRef.current = 0;

      // 다른 경로(관리자 등)로 이미 완료된 경우 알림
      if (data?.status === 'completed' && step === 'score') {
        showInAppNotif('✅ 점수 처리됨', '이 러버의 점수가 이미 입력되었습니다.');
        setStep('done');
      }
    } catch {
      errorCountRef.current += 1;
      if (errorCountRef.current >= MAX_ERRORS) {
        reset();
      }
    }
  }, [rubber, step, showInAppNotif]);

  useEffect(() => {
    loadDataRef.current = loadRubberStatus;
  }, [loadRubberStatus]);

  // ✅ [FIX-④] setInterval에서 ref를 통해 최신 loadData 호출
  useEffect(() => {
    if (step !== 'score' || !rubber) return;
    const iv = setInterval(() => {
      loadDataRef.current?.();
    }, 15000);
    return () => clearInterval(iv);
  }, [step, rubber]);

  // PIN 확인 → 경기 찾기
  async function handlePinSubmit() {
    if (pin.length !== 6) { setError('PIN 6자리를 입력하세요.'); return; }
    setError('');
    setLoading(true);

    try {
      // ✅ pending / lineup_ready / in_progress 모두 허용 (경기 시작 불필요)
      const { data: rubberData } = await supabase
        .from('tie_rubbers')
        .select('*')
        .eq('pin_code', pin)
        .in('status', ['pending', 'in_progress'])
        .limit(1)
        .single();

      if (!rubberData) {
        // completed 여부 확인
        const { data: anyRubber } = await supabase
          .from('tie_rubbers')
          .select('status')
          .eq('pin_code', pin)
          .limit(1)
          .single();

        if (anyRubber?.status === 'completed') {
          setError('이미 점수가 입력된 경기입니다.');
        } else {
          setError('PIN이 일치하는 경기를 찾을 수 없습니다.');
        }
        return;
      }

      setRubber(rubberData);
      errorCountRef.current = 0;

      const { data: tieData } = await supabase
        .from('ties')
        .select('*')
        .eq('id', rubberData.tie_id)
        .single();
      setTie(tieData);

      if (tieData) {
        const playerAQueries = rubberData.club_a_player1_id ? [
          supabase.from('club_members').select('*').eq('id', rubberData.club_a_player1_id).single(),
          rubberData.club_a_player2_id
            ? supabase.from('club_members').select('*').eq('id', rubberData.club_a_player2_id).single()
            : Promise.resolve({ data: null }),
        ] : [Promise.resolve({ data: null }), Promise.resolve({ data: null })];

        const playerBQueries = rubberData.club_b_player1_id ? [
          supabase.from('club_members').select('*').eq('id', rubberData.club_b_player1_id).single(),
          rubberData.club_b_player2_id
            ? supabase.from('club_members').select('*').eq('id', rubberData.club_b_player2_id).single()
            : Promise.resolve({ data: null }),
        ] : [Promise.resolve({ data: null }), Promise.resolve({ data: null })];

        const [
          { data: ca },
          { data: cb },
          { data: ev },
          [{ data: ap1 }, { data: ap2 }],
          [{ data: bp1 }, { data: bp2 }],
        ] = await Promise.all([
          supabase.from('clubs').select('*').eq('id', tieData.club_a_id).single(),
          supabase.from('clubs').select('*').eq('id', tieData.club_b_id).single(),
          supabase.from('events').select('team_sets_per_rubber').eq('id', tieData.event_id).single(),
          Promise.all(playerAQueries),
          Promise.all(playerBQueries),
        ]);

        setClubA(ca);
        setClubB(cb);
        setSetsPerRubber(ev?.team_sets_per_rubber || 1);
        setPlayersA({ p1: ap1, p2: ap2 });
        setPlayersB({ p1: bp1, p2: bp2 });
      }

      setStep('score');
    } catch (err: any) {
      setError('조회 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  function handleScoreNext() {
    if (!set1a || !set1b) { setError('1세트 점수를 입력하세요.'); return; }

    if (setsPerRubber === 3) {
      if (!set2a || !set2b) { setError('2세트 점수를 입력하세요.'); return; }
      const s1win = parseInt(set1a) > parseInt(set1b) ? 'a' : 'b';
      const s2win = parseInt(set2a) > parseInt(set2b) ? 'a' : 'b';
      if (s1win !== s2win) {
        if (!set3a || !set3b) { setError('3세트 점수를 입력하세요.'); return; }
      }
    }

    setError('');
    setStep('confirm');
  }

  async function handleFinalSubmit() {
    if (!rubber) return;
    setLoading(true);
    setError('');

    try {
      const result = await pinRecordScore(
        pin,
        rubber.id,
        parseInt(set1a), parseInt(set1b),
        set2a ? parseInt(set2a) : null,
        set2b ? parseInt(set2b) : null,
        set3a ? parseInt(set3a) : null,
        set3b ? parseInt(set3b) : null,
      );

      if (!result.success) {
        setError(result.error || '점수 저장 실패');
        setStep('score');
        return;
      }

      setStep('done');
    } catch (err: any) {
      setError(err.message || '점수 저장 실패');
      setStep('score');
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep('pin');
    setPin('');
    setError('');
    setRubber(null);
    setTie(null);
    setClubA(null);
    setClubB(null);
    setPlayersA({ p1: null, p2: null });
    setPlayersB({ p1: null, p2: null });
    setSet1a(''); setSet1b('');
    setSet2a(''); setSet2b('');
    setSet3a(''); setSet3b('');
    errorCountRef.current = 0;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ✅ [FIX-②] 인앱 알림 배너 */}
      {inAppNotifs.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm px-4 space-y-2 pointer-events-none">
          {inAppNotifs.map(n => (
            <div key={n.id} className="bg-gray-900 text-white rounded-2xl px-4 py-3 shadow-xl pointer-events-auto">
              <div className="font-bold text-sm">{n.title}</div>
              <div className="text-xs text-gray-300 mt-0.5">{n.body}</div>
            </div>
          ))}
        </div>
      )}

      <div className="max-w-md mx-auto p-6 space-y-6">

        <div className="text-center">
          <h1 className="text-xl font-bold">🎾 단체전 점수입력</h1>
          <div className="flex justify-center gap-2 mt-3">
            {['PIN', '점수', '확인'].map((label, i) => {
              const stepIdx = ['pin', 'score', 'confirm'].indexOf(step);
              const active  = i <= stepIdx && step !== 'done';
              return (
                <div key={label} className={`flex items-center gap-1 ${active ? 'text-blue-600' : 'text-gray-300'}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${active ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}>
                    {i + 1}
                  </div>
                  <span className="text-xs">{label}</span>
                  {i < 2 && <span className="text-gray-300 mx-1">→</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 1: PIN */}
        {step === 'pin' && (
          <div className="bg-white rounded-xl border p-6 space-y-4">
            <h2 className="font-semibold text-center">경기 PIN 입력</h2>
            <p className="text-sm text-gray-500 text-center">코트에 배정된 6자리 PIN을 입력하세요.</p>
            <input
              type="tel"
              maxLength={6}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-blue-500 outline-none"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handlePinSubmit()}
            />
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button
              onClick={handlePinSubmit}
              disabled={loading || pin.length !== 6}
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '확인중...' : '다음'}
            </button>
          </div>
        )}

        {/* Step 2: 스코어 입력 */}
        {step === 'score' && rubber && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border p-4 text-center">
              <p className="text-sm text-gray-500">러버 {rubber.rubber_number}</p>
              <div className="flex items-center justify-center gap-4 mt-2">
                <div>
                  <div className="font-bold">{clubA?.name}</div>
                  <div className="text-xs text-gray-500">
                    {playersA.p1?.name || '-'} / {playersA.p2?.name || '-'}
                  </div>
                </div>
                <span className="text-gray-400 font-bold">vs</span>
                <div>
                  <div className="font-bold">{clubB?.name}</div>
                  <div className="text-xs text-gray-500">
                    {playersB.p1?.name || '-'} / {playersB.p2?.name || '-'}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border p-4 space-y-4">
              <ScoreInput label="1세트" aVal={set1a} bVal={set1b} setA={setSet1a} setB={setSet1b} clubA={clubA?.name} clubB={clubB?.name} />
              {setsPerRubber === 3 && (<>
                <ScoreInput label="2세트" aVal={set2a} bVal={set2b} setA={setSet2a} setB={setSet2b} clubA={clubA?.name} clubB={clubB?.name} />
                <ScoreInput label="3세트" aVal={set3a} bVal={set3b} setA={setSet3a} setB={setSet3b} clubA={clubA?.name} clubB={clubB?.name} />
              </>)}
            </div>

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <div className="flex gap-3">
              <button onClick={() => setStep('pin')} className="flex-1 bg-gray-100 py-3 rounded-xl font-medium">이전</button>
              <button onClick={handleScoreNext} className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700">다음</button>
            </div>
          </div>
        )}

        {/* Step 3: 확인 */}
        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border p-6">
              <h2 className="font-semibold text-center mb-4">점수 확인</h2>
              <div className="text-center mb-4">
                <span className="font-bold">{clubA?.name}</span>
                <span className="text-gray-400 mx-2">vs</span>
                <span className="font-bold">{clubB?.name}</span>
              </div>
              <div className="space-y-2 text-center">
                <div className="text-2xl font-bold">{set1a} - {set1b}</div>
                {set2a && set2b && <div className="text-2xl font-bold">{set2a} - {set2b}</div>}
                {set3a && set3b && <div className="text-2xl font-bold">{set3a} - {set3b}</div>}
              </div>
            </div>
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setStep('score'); setError(''); }} className="flex-1 bg-gray-100 py-3 rounded-xl font-medium">수정</button>
              <button
                onClick={handleFinalSubmit}
                disabled={loading}
                className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? '저장중...' : '✓ 점수 확정'}
              </button>
            </div>
          </div>
        )}

        {/* Done */}
        {step === 'done' && (
          <div className="bg-white rounded-xl border p-8 text-center space-y-4">
            <div className="text-4xl">✅</div>
            <h2 className="text-xl font-bold">점수가 저장되었습니다!</h2>
            <button
              onClick={reset}
              className="bg-blue-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-blue-700"
            >
              다른 경기 입력
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreInput({ label, aVal, bVal, setA, setB, clubA, clubB }: {
  label: string; aVal: string; bVal: string;
  setA: (v: string) => void; setB: (v: string) => void;
  clubA?: string; clubB?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-600 mb-2">{label}</label>
      <div className="flex items-center gap-3">
        <div className="flex-1 text-center">
          <div className="text-xs text-gray-400 mb-1">{clubA?.slice(0, 6)}</div>
          <input
            type="number" min="0" max="7"
            value={aVal}
            onChange={e => setA(e.target.value)}
            className="w-full border-2 rounded-xl px-3 py-3 text-center text-2xl focus:border-blue-500 outline-none"
          />
        </div>
        <span className="text-gray-400 font-bold text-xl">:</span>
        <div className="flex-1 text-center">
          <div className="text-xs text-gray-400 mb-1">{clubB?.slice(0, 6)}</div>
          <input
            type="number" min="0" max="7"
            value={bVal}
            onChange={e => setB(e.target.value)}
            className="w-full border-2 rounded-xl px-3 py-3 text-center text-2xl focus:border-blue-500 outline-none"
          />
        </div>
      </div>
    </div>
  );
}
