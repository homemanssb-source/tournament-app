'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchClubs } from '@/lib/team-api';
import type { Club, SyncLog } from '@/types/team';

function SyncDashboardInner() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';

  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState(eventId);
  const [event, setEvent] = useState<any>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [appAEventId, setAppAEventId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('events')
        .select('id, name, event_type, app_a_event_id, app_a_connected')
        .order('created_at', { ascending: false });
      setEvents(data || []);
      setLoading(false);
    })();
  }, []);

  const loadEventData = useCallback(async () => {
    if (!selectedEventId) return;
    const { data: ev } = await supabase.from('events').select('*').eq('id', selectedEventId).single();
    setEvent(ev);
    if (ev?.app_a_event_id) setAppAEventId(ev.app_a_event_id);
    const clubList = await fetchClubs(selectedEventId);
    setClubs(clubList);
    const { data: logs } = await supabase
      .from('sync_log').select('*').eq('event_id', selectedEventId)
      .order('synced_at', { ascending: false }).limit(20);
    setSyncLogs((logs || []) as SyncLog[]);
  }, [selectedEventId]);

  useEffect(() => { loadEventData(); }, [loadEventData]);

  async function handleConnect() {
    if (!appAEventId.trim()) return alert('ID를 입력하세요.');
    await supabase.from('events').update({
      app_a_event_id: appAEventId.trim(), app_a_connected: true,
    }).eq('id', selectedEventId);
    await loadEventData();
  }

  async function handlePullTeam() {
    if (!event?.app_a_event_id) return alert('먼저 대회를 연결하세요.');
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/sync/pull-team', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: selectedEventId, app_a_event_id: event.app_a_event_id }),
      });
      setSyncResult({ type: 'team', ...(await res.json()) });
      await loadEventData();
    } catch (err: any) { setSyncResult({ type: 'team', success: false, error: err.message }); }
    finally { setSyncing(false); }
  }

  async function handlePullIndividual() {
    if (!event?.app_a_event_id) return alert('먼저 대회를 연결하세요.');
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/sync/pull-individual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: selectedEventId, app_a_event_id: event.app_a_event_id }),
      });
      setSyncResult({ type: 'individual', ...(await res.json()) });
      await loadEventData();
    } catch (err: any) { setSyncResult({ type: 'individual', success: false, error: err.message }); }
    finally { setSyncing(false); }
  }

  async function handleUpdateClubs() {
    if (!event?.app_a_event_id) return alert('먼저 대회를 연결하세요.');
    if (!confirm('기존 팀들의 클럽명을 앱A에서 가져와 업데이트합니다.\n이미 클럽이 있는 팀은 스킵됩니다. 계속하시겠습니까?')) return;
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/sync/update-clubs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: selectedEventId, app_a_event_id: event.app_a_event_id }),
      });
      setSyncResult({ type: 'update-clubs', ...(await res.json()) });
    } catch (err: any) { setSyncResult({ type: 'update-clubs', success: false, error: err.message }); }
    finally { setSyncing(false); }
  }

  async function handlePushResults() {
    if (!event?.app_a_event_id) return alert('먼저 대회를 연결하세요.');
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/sync/push-results', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: selectedEventId, app_a_event_id: event.app_a_event_id }),
      });
      setSyncResult({ type: 'push-results', ...(await res.json()) });
      await loadEventData();
    } catch (err: any) { setSyncResult({ type: 'push-results', success: false, error: err.message }); }
    finally { setSyncing(false); }
  }

  async function handlePullEvents() {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/sync/pull-events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      setSyncResult({ type: 'pull-events', ...(await res.json()) });
      const { data } = await supabase.from('events')
        .select('id, name, event_type, app_a_event_id, app_a_connected')
        .order('created_at', { ascending: false });
      setEvents(data || []);
    } catch (err: any) { setSyncResult({ type: 'pull-events', success: false, error: err.message }); }
    finally { setSyncing(false); }
  }

  const teamLogs = syncLogs.filter(l => l.sync_type === 'team');
  const individualLogs = syncLogs.filter(l => l.sync_type === 'individual');
  const lastSync = syncLogs[0]?.synced_at ? new Date(syncLogs[0].synced_at).toLocaleString('ko-KR') : '-';

  if (loading) return <div className="p-8 text-center text-gray-500">로딩중...</div>;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">앱A 데이터 연동</h1>

      <div className="bg-white rounded-lg border p-6 space-y-3">
        <h2 className="font-semibold">앱A 대회 가져오기</h2>
        <p className="text-sm text-gray-500">앱A에 등록된 대회 목록을 앱B로 가져옵니다.</p>
        <button onClick={handlePullEvents} disabled={syncing}
          className="w-full bg-indigo-600 text-white py-3 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
          {syncing ? '가져오는 중...' : '앱A 대회 목록 가져오기'}
        </button>
      </div>

      <div className="bg-white rounded-lg border p-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">대회 선택</label>
        <select className="w-full border rounded-lg px-4 py-3" value={selectedEventId}
          onChange={(e) => setSelectedEventId(e.target.value)}>
          <option value="">-- 대회 선택 --</option>
          {events.map(ev => (
            <option key={ev.id} value={ev.id}>
              {ev.name} {ev.app_a_connected ? '(연결됨)' : ''}
            </option>
          ))}
        </select>
      </div>

      {selectedEventId && (
        <>
          <div className="bg-white rounded-lg border p-6 space-y-4">
            <h2 className="font-semibold">앱A 대회 연결</h2>
            {event?.app_a_connected ? (
              <div className="bg-green-50 rounded-lg p-4">
                <p className="text-green-800 text-sm">
                  연결됨 - 앱A ID: <code className="bg-green-100 px-2 py-0.5 rounded">{event.app_a_event_id}</code>
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">앱A의 대회 ID를 입력하여 연결하세요.</p>
                <div className="flex gap-2">
                  <input value={appAEventId} onChange={e => setAppAEventId(e.target.value)}
                    placeholder="앱A event_id (UUID)" className="flex-1 border rounded px-3 py-2 text-sm font-mono" />
                  <button onClick={handleConnect}
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">연결</button>
                </div>
              </div>
            )}
          </div>

          {event?.app_a_connected && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-lg border p-6 space-y-3">
                  <h3 className="font-semibold">개인전 참가자</h3>
                  <p className="text-sm text-gray-600">동기화: {individualLogs.length}팀</p>
                  <button onClick={handleUpdateClubs} disabled={syncing}
                    className="w-full bg-amber-500 text-white py-3 rounded-lg hover:bg-amber-600 disabled:opacity-50">
                    {syncing ? '업데이트 중...' : '🏷️ 기존 팀 클럽명 업데이트'}
                  </button>
                  <button onClick={handlePullIndividual} disabled={syncing}
                    className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {syncing ? '동기화중...' : '개인전 가져오기'}
                  </button>
                </div>
                <div className="bg-white rounded-lg border p-6 space-y-3">
                  <h3 className="font-semibold">단체전 참가팀</h3>
                  <p className="text-sm text-gray-600">클럽: {clubs.length} / 이력: {teamLogs.length}건</p>
                  <button onClick={handlePullTeam} disabled={syncing}
                    className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 disabled:opacity-50">
                    {syncing ? '동기화중...' : '단체전 가져오기'}
                  </button>
                </div>
              </div>

              <div className="bg-white rounded-lg border p-6 space-y-3">
                <h3 className="font-semibold">본선 결과 전송</h3>
                <p className="text-sm text-gray-500">개인전 본선 결과를 앱A에 전송합니다.</p>
                <button onClick={handlePushResults} disabled={syncing}
                  className="w-full bg-purple-600 text-white py-3 rounded-lg hover:bg-purple-700 disabled:opacity-50">
                  {syncing ? '전송중...' : '본선 결과 전송하기'}
                </button>
              </div>
            </div>
          )}

          {syncResult && (
            <div className={`rounded-lg border p-4 ${syncResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
              <h3 className={`font-semibold text-sm ${syncResult.success ? 'text-green-800' : 'text-red-800'}`}>
                {syncResult.type === 'team' ? '단체전' : syncResult.type === 'push-results' ? '본선 결과 전송' : syncResult.type === 'pull-events' ? '대회 가져오기' : '개인전'} 결과
              </h3>
              <div className="text-sm mt-2 space-y-1">
                {syncResult.success ? (
                  <>
                    <p className="text-green-700">성공: {syncResult.synced}건</p>
                    {syncResult.updated > 0 && <p className="text-blue-600">업데이트: {syncResult.updated}건</p>}
                    {syncResult.skipped > 0 && <p className="text-gray-600">스킵: {syncResult.skipped}건</p>}
                    <p className="text-gray-600">전체: {syncResult.total}건</p>
                  </>
                ) : (
                  <p className="text-red-700">실패: {syncResult.error}</p>
                )}
                {syncResult.unmatched?.map((u: string, i: number) => (
                  <p key={`u${i}`} className="text-orange-600 text-xs">매칭실패: {u}</p>
                ))}
                {syncResult.errors?.map((e: string, i: number) => (
                  <p key={i} className="text-red-600 text-xs">{e}</p>
                ))}
              </div>
            </div>
          )}

          {syncLogs.length > 0 && (
            <div className="bg-white rounded-lg border p-6">
              <h3 className="font-semibold mb-3">최근 동기화 이력</h3>
              <p className="text-xs text-gray-400 mb-3">마지막: {lastSync}</p>
              <div className="divide-y max-h-64 overflow-y-auto">
                {syncLogs.map(log => (
                  <div key={log.id} className="flex items-center justify-between py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        log.sync_type === 'team' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                      }`}>{log.sync_type === 'team' ? '단체전' : '개인전'}</span>
                      <span className="text-gray-600">{log.app_b_table}</span>
                    </div>
                    <span className="text-xs text-gray-400">
                      {new Date(log.synced_at).toLocaleString('ko-KR')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function SyncDashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-500">로딩중...</div>}>
      <SyncDashboardInner />
    </Suspense>
  );
}