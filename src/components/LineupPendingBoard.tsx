// ============================================================
// 오더 미제출 현황판 (039)
// src/components/LineupPendingBoard.tsx
//
// 마감 = 차례가 된 시각 + 10분 (계산: lib/lineup-deadline.ts)
//   앞 경기가 남아 있으면 "대기"(접어 둠), 코트 미배정이면 숫자만.
// 주장 알림: 🔔 버튼(수동) + 차례가 되면 1회 자동 (/api/notify/lineup — 여러 화면이 켜져 있어도 서버가 1번만 보냄)
// 15초마다 다시 읽음. 대시보드와 현장 마스터 PIN 화면이 같이 씀.
// ============================================================
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchTies } from '@/lib/team-api';
import type { TieWithClubs } from '@/types/team';
import { classifyPending, filterBoardDate, kstToday, pickBoardDate, type PendingInfo } from '@/lib/lineup-deadline';

const ROUND_LABEL: Record<string, string> = {
  group: '조별', full_league: '풀리그',
  round_of_32: '32강', round_of_16: '16강', quarter: '8강', semi: '4강', final: '결승',
};

export type LineupNotifyBody = { tie_id: string; side?: 'a' | 'b'; mode: 'manual' | 'turn'; court: string; deadline_at: string | null };
export type LineupNotifyResult = { sent?: number; failed?: number; no_sub?: string[]; skipped?: boolean; error?: string; message?: string };

export default function LineupPendingBoard({ eventId, divisionNames, courtName, onProxy, notify, reloadKey }: {
  eventId: string;
  divisionNames?: Record<string, string>;
  courtName: (n: number | null | undefined) => string | null;
  onProxy: (tie: TieWithClubs, side: 'a' | 'b') => void;
  notify: (body: LineupNotifyBody) => Promise<LineupNotifyResult>;   // 화면마다 인증 방식이 달라 호출은 화면이 함
  reloadKey?: number;   // 대리입력 후 바로 다시 읽기
}) {
  const [raw, setRaw] = useState<{ ties: TieWithClubs[]; matches: any[] }>({ ties: [], matches: [] });
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(true);
  const [showWaiting, setShowWaiting] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});   // `${tie}-${side}` → 수동 알림 결과
  const autoTried = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const [allTies, mRes, dRes] = await Promise.all([
        fetchTies(eventId),
        supabase.from('v_matches_with_teams').select('id, court, court_order, status, ended_at, score, match_date')
          .eq('event_id', eventId).not('court', 'is', null),
        supabase.from('divisions').select('id, match_date').eq('event_id', eventId),
      ]);
      // 여러 날 대회: 오늘 경기일 부서만 (다른 날 대전이 같은 코트 앞 순서에 있어도 대기로 잡히지 않게)
      const divDates: Record<string, string | null> = {};
      for (const d of (dRes.data || []) as { id: string; match_date: string | null }[]) divDates[d.id] = d.match_date;
      const date = pickBoardDate(Object.values(divDates), kstToday());
      const { ties, matches } = filterBoardDate(allTies, ((mRes.data || []) as any[]).filter(m => m.score !== 'BYE'), divDates, date);
      setRaw({ ties, matches });
      setNow(Date.now());
    } catch {}
  }, [eventId]);

  useEffect(() => {
    load();
    const r = setInterval(load, 15000);
    const c = setInterval(() => setNow(Date.now()), 30000);
    return () => { clearInterval(r); clearInterval(c); };
  }, [load, reloadKey]);

  // 코트 이름은 화면이 경기장 정보를 늦게 받아올 수 있어 매 렌더 다시 분류 (courtName 은 의존성에 넣지 않음)
  const data = classifyPending(raw.ties, raw.matches, courtName);
  const active = data.items.filter(p => p.kind !== 'waiting');
  const waiting = data.items.filter(p => p.kind === 'waiting');
  const overdue = active.filter(p => p.kind === 'started' || (p.kind === 'turn' && p.deadline != null && p.deadline <= now)).length;

  // 차례가 된 대전 → 마감 전이고 아직 안 보냈으면 자동 알림 1회 (039 이전 배정처럼 시각 모르면 보내지 않음)
  const autoTargets = data.items.filter(p => p.kind === 'turn' && p.deadline != null && p.deadline > now
    && !(p.tie as any).lineup_alerted_at && !autoTried.current.has(p.tie.id));
  useEffect(() => {
    for (const p of autoTargets) {
      if (p.kind !== 'turn') continue;
      autoTried.current.add(p.tie.id);
      notify({ tie_id: p.tie.id, mode: 'turn', court: p.court, deadline_at: new Date(p.deadline!).toISOString() })
        .then(() => load()).catch(() => {});
    }
  }, [autoTargets.map(p => p.tie.id).join()]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function sendManual(p: PendingInfo, side: 'a' | 'b') {
    const key = `${p.tie.id}-${side}`;
    setNotes(n => ({ ...n, [key]: '보내는 중...' }));
    try {
      const r = await notify({ tie_id: p.tie.id, side, mode: 'manual', court: p.court,
        deadline_at: p.kind === 'turn' && p.deadline != null ? new Date(p.deadline).toISOString() : null });
      const msg = r.error ? '❌ ' + r.error : r.sent ? `🔔 보냄 (${r.sent})` : r.no_sub?.length ? '구독 안 함 — 전화' : (r.message || '보내지 못함');
      setNotes(n => ({ ...n, [key]: msg }));
    } catch (e: any) {
      setNotes(n => ({ ...n, [key]: '❌ ' + (e.message || '실패') }));
    }
  }

  if (data.items.length === 0 && data.unassigned === 0) return null;

  return (
    <div className={`border rounded-xl overflow-hidden ${overdue ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-2.5">
        <span className="font-bold text-sm text-gray-800">
          ⏰ 오더 미제출 — 차례 {active.length}
          {overdue > 0 && <span className="text-red-600"> (마감 초과 {overdue})</span>}
          <span className="font-normal text-gray-500"> · 대기 {waiting.length} · 코트 미배정 {data.unassigned}</span>
        </span>
        <span className="text-gray-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="divide-y divide-gray-100 border-t">
          {active.length === 0 && <p className="bg-white px-4 py-3 text-xs text-gray-400">차례가 된 미제출 대전이 없습니다.</p>}
          {active.map(p => <Row key={p.tie.id} p={p} now={now} divisionNames={divisionNames} onProxy={onProxy} notes={notes} onNotify={sendManual} />)}
          {waiting.length > 0 && (
            <button onClick={() => setShowWaiting(s => !s)} className="w-full bg-white px-4 py-2 text-xs text-gray-500 text-left hover:bg-gray-50">
              {showWaiting ? '▲' : '▼'} 앞 경기 대기 중 {waiting.length}대전 {showWaiting ? '접기' : '보기'}
            </button>
          )}
          {showWaiting && waiting.map(p => <Row key={p.tie.id} p={p} now={now} divisionNames={divisionNames} onProxy={onProxy} notes={notes} onNotify={sendManual} />)}
        </div>
      )}
    </div>
  );
}

function Row({ p, now, divisionNames, onProxy, notes, onNotify }: {
  p: PendingInfo; now: number; divisionNames?: Record<string, string>; onProxy: (tie: TieWithClubs, side: 'a' | 'b') => void;
  notes: Record<string, string>; onNotify: (p: PendingInfo, side: 'a' | 'b') => void;
}) {
  const alertedAt = (p.tie as any).lineup_alerted_at as string | null;
  const t = p.tie;
  let badge: { text: string; cls: string };
  if (p.kind === 'started') badge = { text: '오더 없이 경기 시작됨', cls: 'bg-red-600 text-white' };
  else if (p.kind === 'waiting') badge = { text: `앞 경기 ${p.ahead}개 남음`, cls: 'bg-gray-100 text-gray-500' };
  else if (p.deadline == null) badge = { text: '차례 (시각 모름)', cls: 'bg-amber-100 text-amber-700' };
  else {
    const min = Math.ceil((p.deadline - now) / 60000);
    badge = min > 0
      ? { text: `${min}분 남음`, cls: 'bg-amber-100 text-amber-700' }
      : { text: `마감 초과 ${-min}분`, cls: 'bg-red-600 text-white' };
  }
  return (
    <div className="bg-white px-4 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
        <span className={`px-1.5 py-0.5 rounded font-bold ${badge.cls}`}>{badge.text}</span>
        <span className="bg-green-100 text-green-700 px-1.5 rounded">📍 {p.court}</span>
        <span>#{t.tie_order}</span>
        {t.division_id && divisionNames?.[t.division_id] && <span>{divisionNames[t.division_id]}</span>}
        {t.round && <span>{ROUND_LABEL[t.round] || t.round}</span>}
        {alertedAt && (
          <span className="text-blue-600">🔔 자동 알림 {new Date(alertedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}</span>
        )}
      </div>
      {(['a', 'b'] as const).map(side => {
        const club = side === 'a' ? t.club_a : t.club_b;
        const submitted = side === 'a' ? t.club_a_lineup_submitted : t.club_b_lineup_submitted;
        const note = notes[`${t.id}-${side}`];
        return (
          <div key={side}>
          <div className="flex items-center gap-2 text-sm">
            <span className={`w-12 text-xs ${submitted ? 'text-green-600' : 'text-orange-600 font-bold'}`}>
              {submitted ? '제출' : '미제출'}
            </span>
            <span className="flex-1 truncate font-medium">{club?.name}</span>
            {!submitted && (
              <>
                {club?.captain_phone ? (
                  <a href={`tel:${club.captain_phone}`} className="text-xs text-blue-600 whitespace-nowrap">
                    📞 {club.captain_name || '주장'}
                  </a>
                ) : club?.captain_name ? (
                  <span className="text-xs text-gray-400 whitespace-nowrap">{club.captain_name}</span>
                ) : null}
                <button onClick={() => onNotify(p, side)} disabled={note === '보내는 중...'} title="주장에게 오더 제출 알림"
                  className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-1 rounded-lg hover:bg-blue-100 disabled:opacity-50">
                  🔔
                </button>
                <button onClick={() => onProxy(t, side)}
                  className="text-xs bg-orange-500 text-white px-2.5 py-1 rounded-lg hover:bg-orange-600 whitespace-nowrap">
                  대리입력
                </button>
              </>
            )}
          </div>
          {note && !submitted && <p className="text-[11px] text-right text-gray-500 mt-0.5">{note}</p>}
          </div>
        );
      })}
    </div>
  );
}
