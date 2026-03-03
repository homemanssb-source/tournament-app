// ============================================================
// 클럽 상세 컴포넌트 (주장 변경 포함)
// src/components/ClubDetail.tsx
//
// 사용법: <ClubDetail clubId={clubId} onClose={() => ...} />
// clubs 페이지에서 클럽 클릭 시 표시
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  fetchClubWithMembers, addClubMember, deleteClubMember, setCaptain,
  updateClub, fetchEventTeamConfig,
} from '@/lib/team-api';
import { getMatchTypeShort, getRubberCountByMatchType } from '@/lib/team-utils';
import type { ClubWithMembers, ClubMember, EventTeamConfig } from '@/types/team';

interface Props {
  clubId: string;
  eventId: string;
  onClose: () => void;
  onUpdated?: () => void;
}

export default function ClubDetail({ clubId, eventId, onClose, onUpdated }: Props) {
  const [club, setClub] = useState<ClubWithMembers | null>(null);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // 선수 추가 폼
  const [addForm, setAddForm] = useState({ name: '', gender: '' as '' | 'M' | 'F', grade: '' });
  const [adding, setAdding] = useState(false);

  // 주장 변경
  const [changingCaptain, setChangingCaptain] = useState(false);

  // 삭제
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [clubData, cfg] = await Promise.all([
      fetchClubWithMembers(clubId),
      fetchEventTeamConfig(eventId),
    ]);
    setClub(clubData);
    setConfig(cfg);
    setLoading(false);
  }, [clubId, eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  // 선수 추가
  async function handleAddMember() {
    if (!addForm.name.trim()) return;
    setAdding(true);
    try {
      await addClubMember(
        clubId,
        addForm.name.trim(),
        addForm.gender as 'M' | 'F' | undefined,
        addForm.grade || undefined,
        false,
      );
      setAddForm({ name: '', gender: '', grade: '' });
      await loadData();
      onUpdated?.();
    } catch (e: any) {
      alert('선수 추가 실패: ' + e.message);
    }
    setAdding(false);
  }

  // 선수 삭제
  async function handleDeleteMember(memberId: string, memberName: string) {
    if (!confirm(`${memberName} 선수를 삭제하시겠습니까?`)) return;
    setDeleting(memberId);
    try {
      await deleteClubMember(memberId);
      await loadData();
      onUpdated?.();
    } catch (e: any) {
      alert('삭제 실패: ' + e.message);
    }
    setDeleting(null);
  }

  // 주장 변경
  async function handleSetCaptain(memberId: string, memberName: string) {
    const currentCaptain = club?.members.find(m => m.is_captain);
    const msg = currentCaptain
      ? `주장을 ${currentCaptain.name} → ${memberName}(으)로 변경하시겠습니까?`
      : `${memberName}을(를) 주장으로 지정하시겠습니까?`;

    if (!confirm(msg)) return;
    setChangingCaptain(true);
    try {
      const result = await setCaptain(clubId, memberId);
      if (!result.success) {
        alert('주장 변경 실패: ' + result.error);
        return;
      }
      await loadData();
      onUpdated?.();
    } catch (e: any) {
      alert('주장 변경 실패: ' + e.message);
    }
    setChangingCaptain(false);
  }

  if (loading) return <div className="p-6 text-center text-gray-400">로딩중...</div>;
  if (!club) return <div className="p-6 text-center text-gray-400">클럽을 찾을 수 없습니다.</div>;

  const members = club.members || [];
  const captain = members.find(m => m.is_captain);
  const rubberCount = config ? getRubberCountByMatchType(config.team_match_type) : 3;
  const matchTypeLabel = config ? getMatchTypeShort(config.team_match_type) : '3복식';

  // 출전 인원 = 복식 수 × 2명
  const playingCount = rubberCount * 2;
  const isOverCapacity = members.length > playingCount;

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      {/* 헤더 */}
      <div className="bg-gray-50 px-4 py-3 flex items-center justify-between border-b">
        <div>
          <h3 className="font-bold text-lg">{club.name}</h3>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
            <span>{matchTypeLabel}</span>
            <span>출전 {playingCount}명</span>
            <span>등록 {members.length}명</span>
            {club.seed_number && (
              <span className="bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">
                {club.seed_number}시드
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
      </div>

      {/* 주장 정보 */}
      <div className="px-4 py-3 border-b bg-yellow-50">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-yellow-700 font-medium">👑 주장</span>
            <p className="font-bold text-sm mt-0.5">
              {captain ? captain.name : '미지정'}
              {captain?.gender && <span className="text-xs text-gray-500 ml-1">({captain.gender === 'M' ? '남' : '여'})</span>}
            </p>
          </div>
          {club.captain_pin && (
            <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded font-mono">
              PIN: {club.captain_pin}
            </span>
          )}
        </div>
      </div>

      {/* 선수 목록 */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">선수 명단</h4>
          {isOverCapacity && (
            <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
              후보 {members.length - playingCount}명 포함
            </span>
          )}
        </div>

        <div className="space-y-1">
          {members.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">등록된 선수가 없습니다.</p>
          ) : members.map((m, idx) => {
            const isPlaying = idx < playingCount;
            return (
              <div key={m.id}
                className={`flex items-center justify-between py-2 px-3 rounded-lg ${
                  m.is_captain ? 'bg-yellow-50 border border-yellow-200' :
                  isPlaying ? 'bg-gray-50' : 'bg-orange-50 border border-orange-100'
                }`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-5">{idx + 1}</span>
                  {m.is_captain && <span className="text-xs">👑</span>}
                  <span className={`text-sm font-medium ${!isPlaying ? 'text-orange-600' : ''}`}>{m.name}</span>
                  {m.gender && <span className="text-xs text-gray-400">{m.gender === 'M' ? '남' : '여'}</span>}
                  {m.grade && <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{m.grade}</span>}
                  {!isPlaying && <span className="text-xs text-orange-500">후보</span>}
                </div>
                <div className="flex items-center gap-1">
                  {/* 주장 변경 버튼 */}
                  {!m.is_captain && (
                    <button
                      onClick={() => handleSetCaptain(m.id, m.name)}
                      disabled={changingCaptain}
                      className="text-xs text-yellow-600 hover:text-yellow-800 px-2 py-1 hover:bg-yellow-50 rounded disabled:opacity-50"
                    >
                      주장지정
                    </button>
                  )}
                  {/* 삭제 버튼 */}
                  <button
                    onClick={() => handleDeleteMember(m.id, m.name)}
                    disabled={deleting === m.id}
                    className="text-xs text-red-400 hover:text-red-600 px-2 py-1 hover:bg-red-50 rounded disabled:opacity-50"
                  >
                    {deleting === m.id ? '...' : '삭제'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 선수 추가 */}
        <div className="mt-4 pt-3 border-t">
          <h4 className="text-xs font-semibold text-gray-500 mb-2">선수 추가</h4>
          <div className="flex gap-2">
            <input
              type="text"
              value={addForm.name}
              onChange={e => setAddForm({ ...addForm, name: e.target.value })}
              placeholder="이름"
              className="flex-1 text-sm border rounded-lg px-3 py-2"
              onKeyDown={e => e.key === 'Enter' && handleAddMember()}
            />
            <select
              value={addForm.gender}
              onChange={e => setAddForm({ ...addForm, gender: e.target.value as '' | 'M' | 'F' })}
              className="text-sm border rounded-lg px-2 py-2 w-16"
            >
              <option value="">-</option>
              <option value="M">남</option>
              <option value="F">여</option>
            </select>
            <input
              type="text"
              value={addForm.grade}
              onChange={e => setAddForm({ ...addForm, grade: e.target.value })}
              placeholder="등급"
              className="text-sm border rounded-lg px-2 py-2 w-16"
            />
            <button
              onClick={handleAddMember}
              disabled={adding || !addForm.name.trim()}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {adding ? '...' : '추가'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
