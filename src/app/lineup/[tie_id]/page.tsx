// ============================================================
// 주장 통합 페이지: 라인업 봉인 제출 + 점수 입력
// src/app/lineup/[tie_id]/page.tsx
//
// - PIN 자동 인증 (sessionStorage)
// - submitted 상태에서 5초 폴링 → 상대 제출 시 자동 revealed
// - 점수: 이긴 팀 선택 → 점수 → 확정 (1회, 수정불가)
// ★ 수정: events.team_match_type 읽어서 경기방식 표시
// ============================================================
'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchClubMembers, fetchLineups, fetchRevealedLineups, submitLineup, fetchRubbers } from '@/lib/team-api';
import { getGenderLabel, formatSetScore, getMatchTypeShort } from '@/lib/team-utils';
import type { Tie, Club, ClubMember, TeamLineup, LineupEntry, TieRubber } from '@/types/team';
import PinSubscribeButton from '@/components/PinSubscribeButton'

type Step = 'pin' | 'edit' | 'submitted' | 'revealed';

export default function LineupPage() {
  const params = useParams();
  const tieId = params.tie_id as string;

  const [tie, setTie] = useState<Tie | null>(null);
  const [clubA, setClubA] = useState<Club | null>(null);
  const [clubB, setClubB] = useState<Club | null>(null);
  const [step, setStep] = useState<Step>('pin');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [myClub, setMyClub] = useState<Club | null>(null);
  const [opponentClub, setOpponentClub] = useState<Club | null>(null);
  const [members, setMembers] = useState<ClubMember[]>([]);
  const [lineups, setLineups] = useState<{ player1_id: string; player2_id: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [revealedLineups, setRevealedLineups] = useState<TeamLineup[]>([]);
  const [allMembers, setAllMembers] = useState<Record<string, ClubMember>>({});
  const [rubbers, setRubbers] = useState<TieRubber[]>([]);
  const [scoringRubber, setScoringRubber] = useState<string | null>(null);
  const [selectedWinner, setSelectedWinner] = useState<'a' | 'b' | null>(null);
  const [set1a, setSet1a] = useState('');
  const [set1b, setSet1b] = useState('');
  const [set2a, setSet2a] = useState('');
  const [set2b, setSet2b] = useState('');
  const [set3a, setSet3a] = useState('');
  const [set3b, setSet3b] = useState('');
  const [scoreSaving, setScoreSaving] = useState(false);
  const [scoreError, setScoreError] = useState('');
  const [setsPerRubber, setSetsPerRubber] = useState(1);
  // ★ 신규: 경기방식 표시용
  const [teamMatchType, setTeamMatchType] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clubARef = useRef<Club | null>(null);
  const clubBRef = useRef<Club | null>(null);

  useEffect(() => {
    (async () => {
      const { data: t } = await supabase.from('ties').select('*').eq('id', tieId).single();
      if (!t) { setError('대전을 찾을 수 없습니다.'); setLoading(false); return; }
      setTie(t);
      const { data: ca } = await supabase.from('clubs').select('*').eq('id', t.club_a_id).single();
      const { data: cb } = await supabase.from('clubs').select('*').eq('id', t.club_b_id).single();
      setClubA(ca); setClubB(cb);
      clubARef.current = ca; clubBRef.current = cb;
      // ★ 수정: team_match_type도 함께 조회
      const { data: ev } = await supabase.from('events')
        .select('team_sets_per_rubber, team_match_type')
        .eq('id', t.event_id).single();
      setSetsPerRubber(ev?.team_sets_per_rubber || 1);
      setTeamMatchType(ev?.team_match_type || null);
      // ✅ lineup_revealed OR 경기 진행중/완료 → 바로 revealed 단계
      if (t.lineup_revealed || t.status === 'in_progress' || t.status === 'completed') {
        setStep('revealed');
        await loadRevealedData(tieId, ca, cb);
        await loadRubbers(tieId);
        setLoading(false); return;
      }
      const savedPin = sessionStorage.getItem('captain_pin');
      if (savedPin && ca && cb) {
        const ok = await tryAutoLogin(savedPin, ca, cb, t);
        if (ok) { setLoading(false); return; }
      }
      setLoading(false);
    })();
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [tieId]);

  // 폴링: submitted 상태에서 5초마다 체크
  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    if (step === 'submitted') {
      pollingRef.current = setInterval(async () => {
        const { data: t } = await supabase.from('ties').select('*').eq('id', tieId).single();
        if (t && t.lineup_revealed) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          setTie(t);
          setStep('revealed');
          await loadRevealedData(tieId, clubARef.current, clubBRef.current);
          await loadRubbers(tieId);
        }
      }, 5000);
    }
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [step, tieId]);

  async function tryAutoLogin(savedPin: string, ca: Club, cb: Club, t: Tie): Promise<boolean> {
    let club: Club | null = null; let opponent: Club | null = null;
    if (ca.captain_pin === savedPin) { club = ca; opponent = cb; }
    else if (cb.captain_pin === savedPin) { club = cb; opponent = ca; }
    else return false;
    setPinInput(savedPin); setMyClub(club); setOpponentClub(opponent);
    const memberList = await fetchClubMembers(club.id); setMembers(memberList);
    const existing = await fetchLineups(tieId, club.id);
    if (existing.length > 0) {
      if (t.lineup_revealed || t.status === 'in_progress' || t.status === 'completed') {
        setStep('revealed'); await loadRevealedData(tieId, ca, cb); await loadRubbers(tieId);
      } else {
        setLineups(Array.from({ length: t.rubber_count }, (_, i) => {
          const l = existing.find(e => e.rubber_number === i + 1);
          return { player1_id: l?.player1_id || '', player2_id: l?.player2_id || '' };
        }));
        setStep('submitted');
      }
    } else {
      setLineups(Array.from({ length: t.rubber_count }, () => ({ player1_id: '', player2_id: '' })));
      setStep('edit');
    }
    return true;
  }

  async function loadRevealedData(tid: string, ca: Club | null, cb: Club | null) {
    const revealed = await fetchRevealedLineups(tid); setRevealedLineups(revealed);
    const mm: Record<string, ClubMember> = {};
    if (ca) { (await fetchClubMembers(ca.id)).forEach(m => { mm[m.id] = m; }); }
    if (cb) { (await fetchClubMembers(cb.id)).forEach(m => { mm[m.id] = m; }); }
    setAllMembers(mm);
  }
  async function loadRubbers(tid: string) { setRubbers(await fetchRubbers(tid)); }

  async function handlePinSubmit() {
    if (pinInput.length !== 6) { setError('PIN 6자리를 입력하세요.'); return; }
    setError('');
    if (clubA?.captain_pin === pinInput) { setMyClub(clubA); setOpponentClub(clubB); }
    else if (clubB?.captain_pin === pinInput) { setMyClub(clubB); setOpponentClub(clubA); }
    else { setError('PIN이 일치하지 않습니다.'); return; }
    sessionStorage.setItem('captain_pin', pinInput);
    const club = clubA?.captain_pin === pinInput ? clubA : clubB!;
    const ml = await fetchClubMembers(club.id); setMembers(ml);
    const existing = await fetchLineups(tieId, club.id);
    if (existing.length > 0 && tie) {
      if (tie.lineup_revealed || tie.status === 'in_progress' || tie.status === 'completed') { setStep('revealed'); await loadRevealedData(tieId, clubA, clubB); await loadRubbers(tieId); }
      else { setLineups(Array.from({ length: tie.rubber_count }, (_, i) => { const l = existing.find(e => e.rubber_number === i + 1); return { player1_id: l?.player1_id || '', player2_id: l?.player2_id || '' }; })); setStep('submitted'); }
    } else if (tie) { setLineups(Array.from({ length: tie.rubber_count }, () => ({ player1_id: '', player2_id: '' }))); setStep('edit'); }
  }

  async function handleSubmit() {
    if (!tie || !myClub) return;
    for (let i = 0; i < lineups.length; i++) {
      if (!lineups[i].player1_id || !lineups[i].player2_id) { setError('복식 '+(i+1)+'의 선수를 모두 선택하세요.'); return; }
      if (lineups[i].player1_id === lineups[i].player2_id) { setError('복식 '+(i+1)+'에 같은 선수를 두 번 배정할 수 없습니다.'); return; }
    }
    setError(''); setSubmitting(true);
    try {
      const entries: LineupEntry[] = lineups.map((l, i) => ({ rubber_number: i+1, player1_id: l.player1_id, player2_id: l.player2_id }));
      const result = await submitLineup(tieId, myClub.id, pinInput, entries);
      if (!result.success) { setError(result.error || '제출 실패'); return; }
      if (result.revealed) { setStep('revealed'); await loadRevealedData(tieId, clubA, clubB); await loadRubbers(tieId); }
      else { setStep('submitted'); }
      const { data: ut } = await supabase.from('ties').select('*').eq('id', tieId).single();
      if (ut) setTie(ut);
    } catch (err: any) { setError(err.message || '제출 실패'); }
    finally { setSubmitting(false); }
  }

  function getMemberName(id: string): string { return allMembers[id]?.name || members.find(m => m.id === id)?.name || '-'; }

  function startScoring(rubber: TieRubber) {
    setScoringRubber(rubber.id); setSelectedWinner(null); setScoreError('');
    setSet1a(''); setSet1b(''); setSet2a(''); setSet2b(''); setSet3a(''); setSet3b('');
  }

  async function handleScoreSave() {
    if (!scoringRubber || !selectedWinner) return;
    if (!set1a || !set1b) { setScoreError('1세트 점수를 입력하세요.'); return; }
    if (setsPerRubber === 1) {
      const a = parseInt(set1a), b = parseInt(set1b);
      if (selectedWinner === 'a' && a <= b) { setScoreError('이긴 팀의 점수가 더 높아야 합니다.'); return; }
      if (selectedWinner === 'b' && b <= a) { setScoreError('이긴 팀의 점수가 더 높아야 합니다.'); return; }
    }
    if (setsPerRubber === 3) {
      if (!set2a || !set2b) { setScoreError('2세트 점수를 입력하세요.'); return; }
      const s1a=parseInt(set1a),s1b=parseInt(set1b),s2a=parseInt(set2a),s2b=parseInt(set2b);
      if ((s1a>s1b?1:0)+(s2a>s2b?1:0)===1 && (s1b>s1a?1:0)+(s2b>s2a?1:0)===1 && (!set3a||!set3b))
        { setScoreError('세트 동률입니다. 3세트 점수를 입력하세요.'); return; }
    }
    setScoreSaving(true); setScoreError('');
    try {
      const { data, error: err } = await supabase.rpc('rpc_admin_record_score', {
        p_rubber_id: scoringRubber,
        p_set1_a: parseInt(set1a), p_set1_b: parseInt(set1b),
        p_set2_a: set2a ? parseInt(set2a) : null, p_set2_b: set2b ? parseInt(set2b) : null,
        p_set3_a: set3a ? parseInt(set3a) : null, p_set3_b: set3b ? parseInt(set3b) : null,
      });
      if (err) { setScoreError(err.message); return; }
      if (data && !data.success) { setScoreError(data.error || '저장 실패'); return; }
      await loadRubbers(tieId);
      const { data: ut } = await supabase.from('ties').select('*').eq('id', tieId).single();
      if (ut) setTie(ut);
      setScoringRubber(null);
    } catch (err: any) { setScoreError(err.message || '저장 실패'); }
    finally { setScoreSaving(false); }
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-500">로딩중...</div>;
  if (error && step === 'pin' && !tie) return <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>;
  const majority = tie ? Math.floor(tie.rubber_count / 2) + 1 : 0;
  const tieCompleted = tie?.status === 'completed';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto p-6 space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-bold">🎾 단체전</h1>
          {/* ★ 수정: 경기방식 라벨 표시 */}
          {clubA && clubB && (
            <p className="text-gray-600 mt-1">
              {clubA.name} vs {clubB.name} · {tie?.rubber_count}복식
              {teamMatchType && (
                <span className="ml-1 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                  {getMatchTypeShort(teamMatchType)}
                </span>
              )}
            </p>
          )}
        </div>

        {step === 'pin' && (
          <div className="bg-white rounded-xl border p-6 space-y-4">
            <h2 className="font-semibold text-center">주장 인증</h2>
            <p className="text-sm text-gray-500 text-center">주장 PIN 6자리를 입력하세요.</p>
            <input type="tel" maxLength={6} value={pinInput} onChange={e => setPinInput(e.target.value.replace(/\D/g, ''))} placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-blue-500 outline-none" autoFocus onKeyDown={e => e.key === 'Enter' && handlePinSubmit()} />
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={handlePinSubmit} className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700">확인</button>
          </div>
        )}

        {step === 'edit' && myClub && tie && (
         <div className="space-y-4">

          {/* 🔔 알림 구독 버튼 */}
           <PinSubscribeButton pin={pinInput} />

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
              <p className="font-medium text-blue-800">📋 {myClub.name} 라인업 작성</p>
              <p className="text-sm text-blue-600 mt-1">
                상대: {opponentClub?.name} · {tie.rubber_count}복식 · 제출 후 봉인됩니다.
              </p>
            </div>
            {lineups.map((lineup, idx) => (
              <div key={idx} className="bg-white rounded-xl border p-4">
                <div className="font-medium text-sm text-gray-600 mb-3">복식 {idx+1}</div>
                <div className="space-y-2">
                  {[0,1].map(pIdx => (
                    <div key={pIdx}>
                      <label className="text-xs text-gray-400">선수 {pIdx+1}</label>
                      <select value={pIdx===0?lineup.player1_id:lineup.player2_id}
                        onChange={e => { const u=[...lineups]; if(pIdx===0)u[idx].player1_id=e.target.value;else u[idx].player2_id=e.target.value; setLineups(u); }}
                        className="w-full border rounded-lg px-3 py-2.5 mt-1">
                        <option value="">선수 선택</option>
                        {members.map(m => <option key={m.id} value={m.id}>{m.name} ({getGenderLabel(m.gender)}) {m.grade?'- '+m.grade:''}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={handleSubmit} disabled={submitting} className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-blue-700 disabled:opacity-50">
              {submitting ? '제출중...' : '🔒 라인업 봉인 제출'}</button>
          </div>
        )}

        {step === 'submitted' && myClub && (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
              <div className="text-3xl mb-2">✅</div>
              <p className="font-bold text-green-800">라인업 제출 완료!</p>
              <p className="text-sm text-green-600 mt-2">상대팀이 제출하면 양쪽 라인업이 동시에 공개됩니다.</p>
              <p className="text-xs text-gray-400 mt-2">⏳ 자동 확인중... (5초마다)</p>
            </div>
            <div className="bg-white rounded-xl border p-4">
              <h3 className="font-semibold mb-3">내 라인업</h3>
              {lineups.map((l, idx) => (
                <div key={idx} className="flex items-center gap-2 py-2 border-b last:border-0">
                  <span className="text-sm text-gray-400 w-16">복식 {idx+1}</span>
                  <span className="text-sm">{members.find(m=>m.id===l.player1_id)?.name||'-'} / {members.find(m=>m.id===l.player2_id)?.name||'-'}</span>
                </div>
              ))}
            </div>
            <div className="bg-gray-50 rounded-xl border p-4 text-center">
              <p className="text-gray-600">상대팀 ({opponentClub?.name}): ⏳ 대기중...</p>
            </div>
            <button onClick={() => setStep('edit')} className="w-full bg-gray-100 py-3 rounded-xl font-medium hover:bg-gray-200">라인업 수정</button>
          </div>
        )}

        {step === 'revealed' && (
          <div className="space-y-4">
            {tie && (
              <div className={`rounded-xl p-4 text-center ${tieCompleted ? 'bg-purple-50 border border-purple-200' : 'bg-blue-50 border border-blue-200'}`}>
                {tieCompleted ? (
                  <><div className="text-3xl mb-2">🏆</div><p className="font-bold text-purple-800">대전 완료!</p>
                  <div className="text-2xl font-bold mt-2"><span className={tie.club_a_rubbers_won>tie.club_b_rubbers_won?'text-blue-600':''}>{clubA?.name}</span>
                  <span className="text-gray-400 mx-2">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span>
                  <span className={tie.club_b_rubbers_won>tie.club_a_rubbers_won?'text-blue-600':''}>{clubB?.name}</span></div></>
                ) : (
                  <><p className="font-bold text-blue-800">🔓 라인업 확정 · 경기 진행중</p>
                  <div className="text-2xl font-bold mt-2">{clubA?.name} <span className="text-gray-400">{tie.club_a_rubbers_won} - {tie.club_b_rubbers_won}</span> {clubB?.name}</div>
                  <p className="text-xs text-blue-600 mt-1">{majority}승 선승제 ({tie.rubber_count}복식)</p></>
                )}
              </div>
            )}

            {Array.from({ length: tie?.rubber_count||0 }, (_,i) => i+1).map(num => {
              const la = revealedLineups.find(l => l.rubber_number===num && l.club_id===clubA?.id);
              const lb = revealedLineups.find(l => l.rubber_number===num && l.club_id===clubB?.id);
              const rubber = rubbers.find(r => r.rubber_number===num);
              const isScoring = scoringRubber===rubber?.id;
              const hasScore = rubber?.set1_a!==null && rubber?.set1_a!==undefined;
              const isCompleted = rubber?.status==='completed';
              return (
                <div key={num} className={`bg-white rounded-xl border p-4 ${isCompleted?'border-green-200':''}`}>
                  <div className="text-sm font-medium text-gray-500 mb-3 text-center flex items-center justify-center gap-2">
                    복식 {num} {isCompleted && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">완료</span>}
                  </div>
                  <div className="grid grid-cols-5 items-center gap-2 mb-3">
                    <div className="col-span-2 text-right text-sm">
                      <div className="font-medium">{getMemberName(la?.player1_id||'')}</div>
                      <div className="font-medium">{getMemberName(la?.player2_id||'')}</div>
                      <div className="text-xs text-gray-400 mt-1">{clubA?.name}</div>
                    </div>
                    <div className="text-center font-bold text-gray-400">vs</div>
                    <div className="col-span-2 text-left text-sm">
                      <div className="font-medium">{getMemberName(lb?.player1_id||'')}</div>
                      <div className="font-medium">{getMemberName(lb?.player2_id||'')}</div>
                      <div className="text-xs text-gray-400 mt-1">{clubB?.name}</div>
                    </div>
                  </div>
                  {hasScore && !isScoring && (
                    <div className="text-center py-2 bg-gray-50 rounded-lg">
                      <div className="text-xl font-bold">{formatSetScore(rubber!.set1_a,rubber!.set1_b)}
                        {rubber!.set2_a!==null&&' / '+formatSetScore(rubber!.set2_a,rubber!.set2_b)}
                        {rubber!.set3_a!==null&&' / '+formatSetScore(rubber!.set3_a,rubber!.set3_b)}</div>
                      {rubber!.winning_club_id && <div className="text-xs text-blue-600 mt-1">승: {rubber!.winning_club_id===clubA?.id?clubA?.name:clubB?.name}</div>}
                    </div>
                  )}
                  {!hasScore && !isScoring && !tieCompleted && rubber && (
                    <button onClick={() => startScoring(rubber)} className="w-full bg-blue-50 text-blue-700 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-100">점수 입력</button>
                  )}
                  {isScoring && rubber && (
                    <div className="space-y-3 mt-2 border-t pt-3">
                      <div>
                        <p className="text-sm font-medium text-gray-600 mb-2">이긴 팀을 선택하세요</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button onClick={() => setSelectedWinner('a')} className={`py-3 rounded-lg text-sm font-bold transition ${selectedWinner==='a'?'bg-blue-600 text-white':'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{clubA?.name}</button>
                          <button onClick={() => setSelectedWinner('b')} className={`py-3 rounded-lg text-sm font-bold transition ${selectedWinner==='b'?'bg-blue-600 text-white':'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{clubB?.name}</button>
                        </div>
                      </div>
                      {selectedWinner && (<>
                        <ScoreRow label="1세트" aVal={set1a} bVal={set1b} setA={setSet1a} setB={setSet1b} clubA={clubA?.name} clubB={clubB?.name} />
                        {setsPerRubber===3 && (<>
                          <ScoreRow label="2세트" aVal={set2a} bVal={set2b} setA={setSet2a} setB={setSet2b} clubA={clubA?.name} clubB={clubB?.name} />
                          <ScoreRow label="3세트" aVal={set3a} bVal={set3b} setA={setSet3a} setB={setSet3b} clubA={clubA?.name} clubB={clubB?.name} />
                        </>)}
                        {scoreError && <p className="text-red-500 text-xs text-center">{scoreError}</p>}
                        <div className="flex gap-2">
                          <button onClick={() => {setScoringRubber(null);setScoreError('');}} className="flex-1 bg-gray-100 py-2.5 rounded-lg text-sm">취소</button>
                          <button onClick={handleScoreSave} disabled={scoreSaving} className="flex-1 bg-green-600 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-green-700 disabled:opacity-50">
                            {scoreSaving?'저장중...':'✓ 점수 확정'}</button>
                        </div>
                      </>)}
                    </div>
                  )}
                </div>
              );
            })}
            {tieCompleted && <div className="bg-gray-100 rounded-xl p-3 text-center text-sm text-gray-500">🔒 대전 완료 — 점수 수정은 운영본부에서만 가능합니다.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreRow({ label, aVal, bVal, setA, setB, clubA, clubB }: {
  label: string; aVal: string; bVal: string; setA: (v: string) => void; setB: (v: string) => void; clubA?: string; clubB?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-12">{label}</span>
      <div className="flex items-center gap-1 flex-1">
        <div className="flex-1 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">{clubA?.slice(0,5)}</div>
          <input type="number" min="0" max="7" value={aVal} onChange={e => setA(e.target.value)}
            className="w-full border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-blue-500 outline-none" />
        </div>
        <span className="text-gray-400 font-bold">:</span>
        <div className="flex-1 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">{clubB?.slice(0,5)}</div>
          <input type="number" min="0" max="7" value={bVal} onChange={e => setB(e.target.value)}
            className="w-full border-2 rounded-lg px-2 py-2 text-center text-lg focus:border-blue-500 outline-none" />
        </div>
      </div>
    </div>
  );
}