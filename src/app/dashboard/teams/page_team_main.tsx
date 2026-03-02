// ============================================================
// 단체전 운영 메인 대시보드
// src/app/dashboard/team/page.tsx
// ============================================================
'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { updateEventTeamConfig, fetchClubs, fetchEventTeamConfig } from '@/lib/team-api';
import { getFormatLabel, getFormatDescription } from '@/lib/team-utils';
import type { TeamFormat, EventTeamConfig } from '@/types/team';

export default function TeamDashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState(eventId);
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [clubCount, setClubCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 대회 목록 로드
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('events')
        .select('id, name, event_type, team_format')
        .in('event_type', ['team', 'both'])
        .order('created_at', { ascending: false });
      setEvents(data || []);

      // 모든 대회 (개인전 포함) 도 선택 가능하도록
      if (!data?.length) {
        const { data: all } = await supabase
          .from('events')
          .select('id, name, event_type')
          .order('created_at', { ascending: false });
        setEvents(all || []);
      }
      setLoading(false);
    })();
  }, []);

  // 선택된 대회 설정 로드
  useEffect(() => {
    if (!selectedEventId) return;
    (async () => {
      const cfg = await fetchEventTeamConfig(selectedEventId);
      setConfig(cfg);
      const clubs = await fetchClubs(selectedEventId);
      setClubCount(clubs.length);
    })();
  }, [selectedEventId]);

  // 대회를 단체전으로 전환
  async function enableTeamEvent() {
    if (!selectedEventId) return;
    setSaving(true);
    await updateEventTeamConfig(selectedEventId, { event_type: 'team' });
    const cfg = await fetchEventTeamConfig(selectedEventId);
    setConfig(cfg);
    setSaving(false);
  }

  // 설정 저장
  async function saveConfig(updates: Partial<EventTeamConfig>) {
    if (!selectedEventId) return;
    setSaving(true);
    await updateEventTeamConfig(selectedEventId, updates);
    const cfg = await fetchEventTeamConfig(selectedEventId);
    setConfig(cfg);
    setSaving(false);
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500">로딩중...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">🏆 단체전 운영</h1>

      {/* 대회 선택 */}
      <div className="bg-white rounded-lg border p-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">대회 선택</label>
        <select
          className="w-full border rounded-lg px-4 py-3 text-lg"
          value={selectedEventId}
          onChange={(e) => setSelectedEventId(e.target.value)}
        >
          <option value="">-- 대회를 선택하세요 --</option>
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.name} {ev.event_type === 'team' ? '(단체전)' : ev.event_type === 'both' ? '(개인+단체)' : ''}
            </option>
          ))}
        </select>
      </div>

      {selectedEventId && config && (
        <>
          {/* 단체전 미활성 시 */}
          {config.event_type === 'individual' && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
              <p className="text-yellow-800 mb-4">이 대회는 아직 단체전이 활성화되지 않았습니다.</p>
              <button
                onClick={enableTeamEvent}
                disabled={saving}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '처리중...' : '단체전 활성화'}
              </button>
            </div>
          )}

          {/* 단체전 설정 */}
          {(config.event_type === 'team' || config.event_type === 'both') && (
            <>
              {/* 포맷 선택 */}
              <div className="bg-white rounded-lg border p-6 space-y-4">
                <h2 className="text-lg font-semibold">대회 포맷</h2>
                <p className="text-sm text-gray-500">참가 클럽: {clubCount}팀</p>

                <div className="space-y-3">
                  {(['full_league', 'group_tournament', 'prelim_tournament'] as TeamFormat[]).map((fmt) => (
                    <label
                      key={fmt}
                      className={`flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition ${
                        config.team_format === fmt
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="format"
                        checked={config.team_format === fmt}
                        onChange={() => saveConfig({ team_format: fmt })}
                        className="mt-1"
                      />
                      <div>
                        <div className="font-medium">{getFormatLabel(fmt)}</div>
                        <div className="text-sm text-gray-500">{getFormatDescription(fmt)}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* 세부 설정 */}
              <div className="bg-white rounded-lg border p-6 space-y-4">
                <h2 className="text-lg font-semibold">세부 설정</h2>

                <div className="grid grid-cols-2 gap-4">
                  {/* 복식 수 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">복식 수</label>
                    <div className="flex gap-2">
                      {[3, 4, 5].map((n) => (
                        <button
                          key={n}
                          onClick={() => saveConfig({ team_rubber_count: n })}
                          className={`px-4 py-2 rounded-lg border-2 font-medium transition ${
                            config.team_rubber_count === n
                              ? 'border-blue-500 bg-blue-50 text-blue-700'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {n}복식
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 세트 수 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">세트 수</label>
                    <div className="flex gap-2">
                      {[1, 3].map((n) => (
                        <button
                          key={n}
                          onClick={() => saveConfig({ team_sets_per_rubber: n })}
                          className={`px-4 py-2 rounded-lg border-2 font-medium transition ${
                            config.team_sets_per_rubber === n
                              ? 'border-blue-500 bg-blue-50 text-blue-700'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {n}세트{n === 1 ? ' (기본)' : ''}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 라인업 모드 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">라인업 제출 방식</label>
                    <select
                      className="w-full border rounded px-3 py-2"
                      value={config.lineup_mode}
                      onChange={(e) => saveConfig({ lineup_mode: e.target.value as any })}
                    >
                      <option value="captain_pin">주장 PIN 제출 (권장)</option>
                      <option value="admin_only">운영자 대리 입력</option>
                    </select>
                  </div>

                  {/* 인원 제한 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">클럽 인원 제한</label>
                    <select
                      className="w-full border rounded px-3 py-2"
                      value={config.team_member_limit ?? ''}
                      onChange={(e) => {
                        const val = e.target.value === '' ? null : Number(e.target.value);
                        saveConfig({ team_member_limit: val });
                      }}
                    >
                      <option value="">무제한</option>
                      <option value="8">8명</option>
                      <option value="10">10명</option>
                      <option value="12">12명</option>
                      <option value="15">15명</option>
                      <option value="20">20명</option>
                    </select>
                  </div>
                </div>

                {/* 선수 중복출전 */}
                <label className="flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    checked={config.allow_player_reuse}
                    onChange={(e) => saveConfig({ allow_player_reuse: e.target.checked })}
                  />
                  <span className="text-sm">같은 선수 여러 러버 출전 허용</span>
                </label>
              </div>

              {/* 네비게이션 */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { label: '📋 클럽 등록/관리', path: `/dashboard/team/clubs?event_id=${selectedEventId}` },
                  { label: '🏟️ 조편성', path: `/dashboard/team/groups?event_id=${selectedEventId}` },
                  { label: '⚔️ 대전 관리', path: `/dashboard/team/ties?event_id=${selectedEventId}` },
                  { label: '📊 순위표', path: `/dashboard/team/standings?event_id=${selectedEventId}` },
                  { label: '🏅 토너먼트', path: `/dashboard/team/bracket?event_id=${selectedEventId}` },
                  { label: '🔄 앱A 연동', path: `/dashboard/sync?event_id=${selectedEventId}` },
                ].map((item) => (
                  <button
                    key={item.path}
                    onClick={() => router.push(item.path)}
                    className="bg-white border rounded-lg p-4 text-left hover:bg-gray-50 hover:border-gray-300 transition"
                  >
                    <span className="text-lg">{item.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
