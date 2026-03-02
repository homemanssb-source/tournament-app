// ============================================================
// 라인업 봉인 제출 (주장용)
// src/app/lineup/[tie_id]/page.tsx
// ============================================================
'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchClubMembers, fetchLineups, fetchRevealedLineups, submitLineup } from '@/lib/team-api';
import { getGenderLabel } from '@/lib/team-utils';
import type { Tie, Club, ClubMember, TeamLineup, LineupEntry } from '@/types/team';

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

  // PIN 인증
  const [pinInput, setPinInput] = useState('');
  const [myClub, setMyClub] = useState<Club | null>(null);
  const [opponentClub, setOpponentClub] = useState<Club | null>(null);

  // 선수 목록
  const [members, setMembers] = useState<ClubMember[]>([]);

  // 라인업 편집
  const [lineups, setLineups] = useState<{ player1_id: string; player2_id: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 공개된 라인업
  const [revealedLineups, setRevealedLineups] = useState<TeamLineup[]>([]);
  const [allMembers, setAllMembers] = useState<Record<string, ClubMember>>({});

  // 대전 데이터 로드
  useEffect(() => {
    (async () => {
      const { data: t } = await supabase
        .from('ties')
        .select('*')
        .eq('id', tieId)
        .single();
      if (!t) { setError('대전을 찾을 수 없습니다.'); setLoading(false); return; }
      setTie(t);

      const { data: ca } = await supabase.from('clubs').select('*').eq('id', t.club_a_id).single();
      const { data: cb } = await supabase.from('clubs').select('*').eq('id', t.club_b_id).single();
      setClubA(ca);
      setClubB(cb);

      // 이미 양쪽 공개 상태면 바로 revealed
      if (t.lineup_revealed) {
        setStep('revealed');
        await loadRevealedData(tieId, ca, cb);
      }

      setLoading(false);
    })();
  }, [tieId]);

  async function loadRevealedData(tid: string, ca: Club | null, cb: Club | null) {
    const revealed = await fetchRevealedLineups(tid);
    setRevealedLineups(revealed);

    // 전체 선수 맵
    const memberMap: Record<string, ClubMember> = {};
    if (ca) {
      const ma = await fetchClubMembers(ca.id);
      ma.forEach(m => { memberMap[m.id] = m; });
    }
    if (cb) {
      const mb = await fetchClubMembers(cb.id);
      mb.forEach(m => { memberMap[m.id] = m; });
    }
    setAllMembers(memberMap);
  }

  // PIN 검증
  async function handlePinSubmit() {
    if (pinInput.length !== 6) { setError('PIN 6자리를 입력하세요.'); return; }
    setError('');

    // A팀 PIN 확인
    if (clubA?.captain_pin === pinInput) {
      setMyClub(clubA);
      setOpponentClub(clubB);
    } else if (clubB?.captain_pin === pinInput) {
      setMyClub(clubB);
      setOpponentClub(clubA);
    } else {
      setError('PIN이 일치하지 않습니다.');
      return;
    }

    const club = clubA?.captain_pin === pinInput ? clubA : clubB!;

    // 선수 목록 로드
    const memberList = await fetchClubMembers(club.id);
    setMembers(memberList);

    // 기존 제출된 라인업 확인
    const existing = await fetchLineups(tieId, club.id);

    if (existing.length > 0 && tie) {
      // 이미 제출한 상태
      const isOpponentSubmitted = club.id === tie.club_a_id
        ? tie.club_b_lineup_submitted
        : tie.club_a_lineup_submitted;

      if (tie.lineup_revealed) {
        setStep('revealed');
        await loadRevealedData(tieId, clubA, clubB);
      } else {
        // 기존 라인업으로 복원
        const restored = Array.from({ length: tie.rubber_count }, (_, i) => {
          const l = existing.find(e => e.rubber_number === i + 1);
          return { player1_id: l?.player1_id || '', player2_id: l?.player2_id || '' };
        });
        setLineups(restored);
        setStep('submitted');
      }
    } else if (tie) {
      // 새로 작성
      setLineups(Array.from({ length: tie.rubber_count }, () => ({ player1_id: '', player2_id: '' })));
      setStep('edit');
    }
  }

  // 라인업 제출
  async function handleSubmit() {
    if (!tie || !myClub) return;

    // 모든 슬롯 채워졌는지 확인
    for (let i = 0; i < lineups.length; i++) {
      if (!lineups[i].player1_id || !lineups[i].player2_id) {
        setError(`복식 ${i + 1}의 선수를 모두 선택하세요.`);
        return;
      }
      if (lineups[i].player1_id === lineups[i].player2_id) {
        setError(`복식 ${i + 1}에 같은 선수를 두 번 배정할 수 없습니다.`);
        return;
      }
    }
    setError('');
    setSubmitting(true);

    try {
      const entries: LineupEntry[] = lineups.map((l, i) => ({
        rubber_number: i + 1,
        player1_id: l.player1_id,
        player2_id: l.player2_id,
      }));

      const result = await submitLineup(tieId, myClub.id, pinInput, entries);
      if (!result.success) { setError(result.error || '제출 실패'); return; }

      if (result.revealed) {
        setStep('revealed');
        await loadRevealedData(tieId, clubA, clubB);
      } else {
        setStep('submitted');
      }

      // tie 상태 갱신
      const { data: updatedTie } = await supabase.from('ties').select('*').eq('id', tieId).single();
      if (updatedTie) setTie(updatedTie);
    } catch (err: any) {
      setError(err.message || '제출 실패');
    } finally {
      setSubmitting(false);
    }
  }

  // 수정 모드로 전환
  function handleEdit() {
    setStep('edit');
  }

  function getMemberName(id: string): string {
    return allMembers[id]?.name || members.find(m => m.id === id)?.name || '-';
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-500">로딩중...</div>;
  if (error && step === 'pin' && !tie) return <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto p-6 space-y-6">

        {/* 헤더 */}
        <div className="text-center">
          <h1 className="text-xl font-bold">라인업 제출</h1>
          {clubA && clubB && (
            <p className="text-gray-600 mt-1">
              {clubA.name} vs {clubB.name} · {tie?.rubber_count}복식
            </p>
          )}
        </div>

        {/* ── Step 1: PIN 입력 ── */}
        {step === 'pin' && (
          <div className="bg-white rounded-xl border p-6 space-y-4">
            <h2 className="font-semibold text-center">주장 인증</h2>
            <p className="text-sm text-gray-500 text-center">주장 PIN 6자리를 입력하세요.</p>

            <input
              type="tel"
              maxLength={6}
              value={pinInput}
              onChange={e => setPinInput(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full text-center text-3xl tracking-[0.5em] border-2 rounded-xl py-4 focus:border-blue-500 outline-none"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handlePinSubmit()}
            />

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <button
              onClick={handlePinSubmit}
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700"
            >
              확인
            </button>
          </div>
        )}

        {/* ── Step 2: 라인업 편집 ── */}
        {step === 'edit' && myClub && tie && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
              <p className="font-medium text-blue-800">
                🏸 {myClub.name} 라인업 작성
              </p>
              <p className="text-sm text-blue-600 mt-1">
                상대: {opponentClub?.name} · 라인업은 제출 후 봉인됩니다.
              </p>
            </div>

            {lineups.map((lineup, idx) => (
              <div key={idx} className="bg-white rounded-xl border p-4">
                <div className="font-medium text-sm text-gray-600 mb-3">복식 {idx + 1}</div>
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-gray-400">선수 1</label>
                    <select
                      value={lineup.player1_id}
                      onChange={e => {
                        const updated = [...lineups];
                        updated[idx].player1_id = e.target.value;
                        setLineups(updated);
                      }}
                      className="w-full border rounded-lg px-3 py-2.5 mt-1"
                    >
                      <option value="">선수 선택</option>
                      {members.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({getGenderLabel(m.gender)}) {m.grade ? `- ${m.grade}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">선수 2</label>
                    <select
                      value={lineup.player2_id}
                      onChange={e => {
                        const updated = [...lineups];
                        updated[idx].player2_id = e.target.value;
                        setLineups(updated);
                      }}
                      className="w-full border rounded-lg px-3 py-2.5 mt-1"
                    >
                      <option value="">선수 선택</option>
                      {members.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({getGenderLabel(m.gender)}) {m.grade ? `- ${m.grade}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? '제출중...' : '🔒 라인업 봉인 제출'}
            </button>
          </div>
        )}

        {/* ── Step 3: 제출 완료, 상대 대기중 ── */}
        {step === 'submitted' && myClub && (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
              <div className="text-3xl mb-2">✅</div>
              <p className="font-bold text-green-800">라인업 제출 완료!</p>
              <p className="text-sm text-green-600 mt-2">
                상대팀이 제출하면 양쪽 라인업이 동시에 공개됩니다.
              </p>
            </div>

            {/* 내 라인업 확인 */}
            <div className="bg-white rounded-xl border p-4">
              <h3 className="font-semibold mb-3">내 라인업</h3>
              {lineups.map((l, idx) => (
                <div key={idx} className="flex items-center gap-2 py-2 border-b last:border-0">
                  <span className="text-sm text-gray-400 w-16">복식 {idx + 1}</span>
                  <span className="text-sm">
                    {members.find(m => m.id === l.player1_id)?.name || '-'}
                    {' / '}
                    {members.find(m => m.id === l.player2_id)?.name || '-'}
                  </span>
                </div>
              ))}
            </div>

            {/* 상대 상태 */}
            <div className="bg-gray-50 rounded-xl border p-4 text-center">
              <p className="text-gray-600">
                상대팀 ({opponentClub?.name}): ⏳ 대기중...
              </p>
            </div>

            <button
              onClick={handleEdit}
              className="w-full bg-gray-100 py-3 rounded-xl font-medium hover:bg-gray-200"
            >
              라인업 수정
            </button>
          </div>
        )}

        {/* ── Step 4: 양쪽 공개 ── */}
        {step === 'revealed' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
              <div className="text-3xl mb-2">🔓</div>
              <p className="font-bold text-blue-800">라인업 확정!</p>
              <p className="text-sm text-blue-600">양팀 라인업이 공개되었습니다.</p>
            </div>

            {/* 매치업 표시 */}
            {Array.from({ length: tie?.rubber_count || 0 }, (_, i) => i + 1).map(num => {
              const lineupA = revealedLineups.find(l => l.rubber_number === num && l.club_id === clubA?.id);
              const lineupB = revealedLineups.find(l => l.rubber_number === num && l.club_id === clubB?.id);

              return (
                <div key={num} className="bg-white rounded-xl border p-4">
                  <div className="text-sm font-medium text-gray-500 mb-2 text-center">복식 {num}</div>
                  <div className="grid grid-cols-5 items-center gap-2">
                    <div className="col-span-2 text-right text-sm">
                      <div className="font-medium">
                        {getMemberName(lineupA?.player1_id || '')}
                      </div>
                      <div className="font-medium">
                        {getMemberName(lineupA?.player2_id || '')}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">{clubA?.name}</div>
                    </div>
                    <div className="text-center font-bold text-gray-400">vs</div>
                    <div className="col-span-2 text-left text-sm">
                      <div className="font-medium">
                        {getMemberName(lineupB?.player1_id || '')}
                      </div>
                      <div className="font-medium">
                        {getMemberName(lineupB?.player2_id || '')}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">{clubB?.name}</div>
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="bg-gray-100 rounded-xl p-3 text-center text-sm text-gray-500">
              🔒 라인업 잠금됨 — 변경 불가
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
