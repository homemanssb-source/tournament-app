// ============================================================
// 단체전 클럽 등록/관리 페이지 - 부서 탭 필터 수정본
// src/app/dashboard/teams/clubs/page.tsx
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useEventId, useDivisions, DivisionTabs } from '@/components/useDashboard';
import {
  fetchClubs, fetchClubMembers, createClub, updateClub, deleteClub,
  addClubMember, addClubMembersBatch, deleteClubMember, fetchEventTeamConfig,
} from '@/lib/team-api';
import { generatePin, getGenderLabel, getSeedBadge } from '@/lib/team-utils';
import type { Club, ClubMember, EventTeamConfig } from '@/types/team';

export default function ClubsPage() {
  const eventId = useEventId();

  // ✅ useDivisions 훅으로 부서 탭 관리
  const { divisions, selected, setSelected, loading: divLoading } = useDivisions(eventId);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [selectedClub, setSelectedClub] = useState<Club | null>(null);
  const [members, setMembers] = useState<ClubMember[]>([]);
  const [loading, setLoading] = useState(true);

  // 클럽 추가 폼
  const [newName, setNewName] = useState('');
  const [newCaptain, setNewCaptain] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newSeed, setNewSeed] = useState<string>('');

  // 선수 추가 폼
  const [memberName, setMemberName] = useState('');
  const [memberGender, setMemberGender] = useState<'M' | 'F'>('M');
  const [memberGrade, setMemberGrade] = useState('');

  // CSV 입력
  const [csvMode, setCsvMode] = useState(false);
  const [csvText, setCsvText] = useState('');

  // 시드 편집
  const [editingSeed, setEditingSeed] = useState<string | null>(null);
  const [seedInput, setSeedInput] = useState('');

  // ✅ loadClubs: selected(부서ID) 바뀔 때마다 해당 부서 클럽만 로드
  const loadClubs = useCallback(async () => {
    if (!eventId || !selected) return;
    setLoading(true);
    const data = await fetchClubs(eventId, selected); // ← division_id 필터 추가
    setClubs(data);
    const cfg = await fetchEventTeamConfig(eventId);
    setConfig(cfg);
    setLoading(false);
  }, [eventId, selected]); // ← selected 의존성 추가

  useEffect(() => { loadClubs(); }, [loadClubs]);

  // 클럽 선택 시 선수 목록 로드
  async function loadMembers(club: Club) {
    setSelectedClub(club);
    const data = await fetchClubMembers(club.id);
    setMembers(data);
  }

  // 새 클럽 추가
  async function handleAddClub() {
    if (!newName.trim()) return alert('클럽명을 입력해주세요');
    if (!selected) return alert('부서를 먼저 선택해주세요');
    try {
      // ✅ division_id 포함하여 클럽 생성
      const { data, error } = await supabase.from('clubs').insert({
        event_id: eventId,
        division_id: selected,
        name: newName.trim(),
        captain_name: newCaptain.trim() || null,
        captain_pin: newPin.trim() || generatePin(),
        seed_number: newSeed ? Number(newSeed) : null,
      }).select().single();
      if (error) throw error;
      setNewName(''); setNewCaptain(''); setNewPin(''); setNewSeed('');
      await loadClubs();
    } catch (err: any) {
      alert(err.message || '클럽 추가 실패');
    }
  }

  // 클럽 삭제
  async function handleDeleteClub(clubId: string) {
    if (!confirm('이 클럽과 소속 선수를 모두 삭제합니다. 계속하시겠습니까?')) return;
    await deleteClub(clubId);
    if (selectedClub?.id === clubId) { setSelectedClub(null); setMembers([]); }
    await loadClubs();
  }

  // 시드 저장
  async function handleSeedSave(clubId: string) {
    const val = seedInput.trim() === '' ? null : Number(seedInput);
    await updateClub(clubId, { seed_number: val });
    setEditingSeed(null);
    await loadClubs();
  }

  // 선수 개별 추가
  async function handleAddMember() {
    if (!selectedClub) return;
    if (!memberName.trim()) return alert('선수 이름을 입력해주세요');
    if (config?.team_member_limit && members.length >= config.team_member_limit) {
      return alert(`선수 제한(${config.team_member_limit}명)을 초과했습니다.`);
    }
    await addClubMember(selectedClub.id, memberName.trim(), memberGender, memberGrade.trim() || undefined);
    setMemberName(''); setMemberGrade('');
    await loadMembers(selectedClub);
  }

  // CSV 일괄 추가 (형식: 이름,성별(M/F),등급)
  async function handleCsvImport() {
    if (!selectedClub) return;
    const lines = csvText.trim().split('\n').filter(Boolean);
    const parsed = lines.map((line, idx) => {
      const parts = line.split(',').map((s) => s.trim());
      return {
        name: parts[0] || '',
        gender: (parts[1]?.toUpperCase() === 'F' ? 'F' : 'M') as 'M' | 'F',
        grade: parts[2] || undefined,
        member_order: idx + 1 + members.length,
      };
    }).filter((m) => m.name);

    if (!parsed.length) return alert('유효한 데이터가 없습니다.');
    if (config?.team_member_limit && members.length + parsed.length > config.team_member_limit) {
      return alert(`선수 제한(${config.team_member_limit}명) 초과. 현재 ${members.length}명 + ${parsed.length}명 = ${members.length + parsed.length}명`);
    }
    await addClubMembersBatch(selectedClub.id, parsed);
    setCsvText(''); setCsvMode(false);
    await loadMembers(selectedClub);
  }

  // 선수 삭제
  async function handleDeleteMember(memberId: string) {
    if (!selectedClub) return;
    await deleteClubMember(memberId);
    await loadMembers(selectedClub);
  }

  // 주장 설정
  async function handleSetCaptain(member: ClubMember) {
    if (!selectedClub) return;
    await supabase.from('club_members').update({ is_captain: false }).eq('club_id', selectedClub.id);
    await supabase.from('club_members').update({ is_captain: true }).eq('id', member.id);
    await supabase.from('clubs').update({ captain_name: member.name }).eq('id', selectedClub.id);
    await loadMembers(selectedClub);
    await loadClubs();
  }

  if (!eventId) return <div className="p-8 text-center text-gray-500">대시보드 홈에서 대회를 선택해주세요.</div>;
  if (divLoading) return <div className="p-8 text-center text-gray-500">불러오는 중...</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏅 단체팀 등록/관리</h1>
        <span className="text-sm text-gray-500">
          {clubs.length}팀 등록
          {config?.team_member_limit ? ` · 선수 제한: ${config.team_member_limit}명` : ''}
        </span>
      </div>

      {/* ✅ 부서 탭 */}
      <DivisionTabs divisions={divisions} selected={selected} onSelect={(id) => {
        setSelected(id);
        setSelectedClub(null); // 부서 바뀌면 선택 클럽 초기화
        setMembers([]);
      }} />

      {loading ? (
        <div className="p-8 text-center text-gray-500">불러오는 중...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 왼쪽: 클럽 목록 */}
          <div className="space-y-4">
            {/* 클럽 추가 폼 */}
            <div className="bg-white rounded-lg border p-4 space-y-3">
              <h3 className="font-semibold text-sm text-gray-600">➕ 새 클럽 추가</h3>
              <div className="grid grid-cols-2 gap-2">
                <input
                  placeholder="클럽명 *"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="border rounded px-3 py-2 text-sm col-span-2"
                />
                <input
                  placeholder="주장 이름"
                  value={newCaptain}
                  onChange={(e) => setNewCaptain(e.target.value)}
                  className="border rounded px-3 py-2 text-sm"
                />
                <input
                  placeholder="PIN 6자리 (없으면 자동)"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  maxLength={6}
                  className="border rounded px-3 py-2 text-sm"
                />
                <input
                  placeholder="시드 번호 (선택)"
                  value={newSeed}
                  onChange={(e) => setNewSeed(e.target.value)}
                  type="number"
                  min={1}
                  className="border rounded px-3 py-2 text-sm"
                />
                <button
                  onClick={handleAddClub}
                  className="bg-blue-600 text-white rounded px-4 py-2 text-sm hover:bg-blue-700"
                >
                  추가
                </button>
              </div>
            </div>

            {/* 클럽 목록 */}
            {clubs.length === 0 ? (
              <div className="text-center text-gray-400 py-8">
                {selected ? '이 부서에 등록된 클럽이 없습니다.' : '부서를 선택해주세요.'}
              </div>
            ) : (
              <div className="space-y-2">
                {clubs.map((club) => (
                  <div
                    key={club.id}
                    onClick={() => loadMembers(club)}
                    className={`bg-white rounded-lg border p-4 cursor-pointer transition hover:border-blue-300 ${
                      selectedClub?.id === club.id ? 'border-blue-500 ring-2 ring-blue-100' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-semibold">{club.name}</span>
                        {club.seed_number && (
                          <span className="ml-2 text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                            {club.seed_number}시드
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {editingSeed === club.id ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="number" min={1} value={seedInput}
                              onChange={(e) => setSeedInput(e.target.value)}
                              placeholder="시드" className="border rounded px-2 py-1 w-16 text-xs"
                            />
                            <button onClick={() => handleSeedSave(club.id)} className="text-blue-600 text-xs">✓</button>
                            <button onClick={() => setEditingSeed(null)} className="text-gray-400 text-xs">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingSeed(club.id); setSeedInput(String(club.seed_number || '')); }}
                            className="text-xs text-gray-400 hover:text-blue-600"
                          >
                            시드
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteClub(club.id); }}
                          className="text-xs text-red-400 hover:text-red-600"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      주장: {club.captain_name || '-'}
                      {club.captain_pin && <span className="ml-2">PIN: {club.captain_pin}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 오른쪽: 선수 명단 */}
          <div className="space-y-4">
            {selectedClub ? (
              <div className="bg-white rounded-lg border p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold">
                    {selectedClub.name} 선수 명단
                    <span className="text-sm text-gray-500 ml-2">
                      ({members.length}명{config?.team_member_limit ? ` / ${config.team_member_limit}명` : ''})
                    </span>
                  </h3>
                  <button
                    onClick={() => setCsvMode(!csvMode)}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    {csvMode ? '개별 입력' : 'CSV 일괄입력'}
                  </button>
                </div>

                {!csvMode && (
                  <div className="flex gap-2 mb-3">
                    <input
                      placeholder="이름 *" value={memberName}
                      onChange={(e) => setMemberName(e.target.value)}
                      className="border rounded px-3 py-2 text-sm flex-1"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
                    />
                    <select
                      value={memberGender}
                      onChange={(e) => setMemberGender(e.target.value as 'M' | 'F')}
                      className="border rounded px-2 py-2 text-sm w-16"
                    >
                      <option value="M">남</option>
                      <option value="F">여</option>
                    </select>
                    <input
                      placeholder="등급" value={memberGrade}
                      onChange={(e) => setMemberGrade(e.target.value)}
                      className="border rounded px-3 py-2 text-sm w-20"
                    />
                    <button onClick={handleAddMember} className="bg-blue-600 text-white rounded px-4 py-2 text-sm hover:bg-blue-700">추가</button>
                  </div>
                )}

                {csvMode && (
                  <div className="space-y-2 mb-3">
                    <p className="text-xs text-gray-500">형식: 이름,성별(M/F),등급 (한 줄에 한 명)</p>
                    <textarea
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder={`김민준,M,A급\n이서연,F,B급\n박지훈,M,A급`}
                      className="w-full border rounded px-3 py-2 text-sm h-32 font-mono"
                    />
                    <button onClick={handleCsvImport} className="bg-green-600 text-white rounded px-4 py-2 text-sm hover:bg-green-700">
                      일괄 추가
                    </button>
                  </div>
                )}

                {members.length === 0 ? (
                  <div className="text-center text-gray-400 py-6 text-sm">선수가 없습니다.</div>
                ) : (
                  <div className="divide-y">
                    {members.map((m, idx) => (
                      <div key={m.id} className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-400 w-6 text-right">{idx + 1}</span>
                          <span className="font-medium text-sm">{m.name}</span>
                          <span className="text-xs text-gray-500">{getGenderLabel(m.gender)}</span>
                          {m.grade && (
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{m.grade}</span>
                          )}
                          {m.is_captain && (
                            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">주장</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {!m.is_captain && (
                            <button onClick={() => handleSetCaptain(m)} className="text-xs text-blue-400 hover:text-blue-600">
                              주장 지정
                            </button>
                          )}
                          <button onClick={() => handleDeleteMember(m.id)} className="text-xs text-red-400 hover:text-red-600">삭제</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-50 rounded-lg border border-dashed p-8 text-center text-gray-400">
                왼쪽에서 클럽을 선택하면 선수 명단을 관리할 수 있습니다.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}