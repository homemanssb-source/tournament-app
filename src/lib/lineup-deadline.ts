// ============================================================
// 오더 마감 계산 (039) — LineupPendingBoard 가 씀
// src/lib/lineup-deadline.ts
//
// 마감 = 차례가 된 시각 + 10분 (여러 날 대회는 오늘 경기일 부서만 — pickBoardDate)
//   차례가 된 시각 = 같은 코트 앞 순서(개인전·단체전 섞임, court_order) 경기가 모두 끝난 시각,
//                    이 대전의 코트 배정 시각(ties.court_assigned_at),
//                    두 팀이 직전 대전을 끝낸 시각(ties.ended_at, 040) 중 가장 늦은 쪽
//   (상대가 정해지기 전에 코트를 미리 잡으면 배정 시각이 한참 앞이라, 상대를 정한 다른 코트 대전 종료가 기준)
// ============================================================
import type { TieWithClubs } from '@/types/team';

export const LINEUP_DEADLINE_MIN = 10;

type QueueItem = { key: string; court: string; order: number; finished: boolean; endedAt: string | null };

export type PendingInfo =
  | { kind: 'waiting'; tie: TieWithClubs; court: string; ahead: number }         // 앞 경기 남음
  | { kind: 'turn'; tie: TieWithClubs; court: string; deadline: number | null }  // 차례 — 마감 시각(ms), 모르면 null
  | { kind: 'started'; tie: TieWithClubs; court: string };                       // 오더 없이 경기 시작됨

const tieOrder = (t: TieWithClubs) => (t as any).court_order ?? (100 + (t.tie_order || 0));   // CourtBoard 와 같은 기준

// 한국 시간 오늘 (YYYY-MM-DD)
export const kstToday = (now = Date.now()) => new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

// 현황판이 볼 날짜 — 오늘 경기일이 있으면 오늘, 없으면 가장 가까운 경기일 (CourtBoard 와 같은 규칙), 경기일이 없으면 null(전부)
export function pickBoardDate(dates: (string | null | undefined)[], today: string): string | null {
  const ds = [...new Set(dates.filter((d): d is string => !!d))].sort();
  if (ds.length === 0) return null;
  if (ds.includes(today)) return today;
  const t = Date.parse(today);
  return ds.reduce((best, cur) => Math.abs(Date.parse(cur) - t) < Math.abs(Date.parse(best) - t) ? cur : best, ds[0]);
}

// 그 날짜 경기만 — 날짜 없는 부서·경기는 항상 포함
//   여러 날 대회는 같은 코트에 다른 날 대전이 앞 순서로 들어 있어, 섞으면 차례·대기가 틀어짐
export function filterBoardDate<T extends { division_id?: string | null }, M extends { match_date?: string | null }>(
  ties: T[], matches: M[], divDates: Record<string, string | null | undefined>, date: string | null,
): { ties: T[]; matches: M[] } {
  if (!date) return { ties, matches };
  return {
    ties: ties.filter(t => { const d = t.division_id ? divDates[t.division_id] : null; return !d || d === date; }),
    matches: matches.filter(m => !m.match_date || m.match_date === date),
  };
}

// 공개 전인데 한 팀이라도 오더를 안 낸 대전
function isPending(t: TieWithClubs) {
  return !t.is_bye && !!t.club_a_id && !!t.club_b_id && !t.lineup_revealed && t.status !== 'completed'
    && (!t.club_a_lineup_submitted || !t.club_b_lineup_submitted);
}

export function classifyPending(
  ties: TieWithClubs[], matches: { id: string; court: string; court_order: number | null; status: string; ended_at: string | null }[],
  courtName: (n: number | null | undefined) => string | null,
): { items: PendingInfo[]; unassigned: number } {
  const queue: QueueItem[] = [
    ...matches.map(m => ({ key: 'm' + m.id, court: m.court, order: m.court_order ?? 0, finished: m.status === 'FINISHED', endedAt: m.ended_at })),
    ...ties.filter(t => !t.is_bye && t.court_number != null).map(t => ({
      key: 't' + t.id, court: courtName(t.court_number) || '', order: tieOrder(t),
      finished: t.status === 'completed', endedAt: (t as any).ended_at ?? null,
    })),
  ];
  const items: PendingInfo[] = [];
  let unassigned = 0;
  for (const t of ties.filter(isPending)) {
    const court = t.court_number != null ? courtName(t.court_number) : null;
    if (!court) { unassigned++; continue; }
    if (t.status === 'in_progress') { items.push({ kind: 'started', tie: t, court }); continue; }
    const ahead = queue.filter(q => q.court === court && q.key !== 't' + t.id && q.order < tieOrder(t));
    const left = ahead.filter(q => !q.finished).length;
    if (left > 0) { items.push({ kind: 'waiting', tie: t, court, ahead: left }); continue; }
    const teamsDone = ties.filter(o => o.id !== t.id && o.status === 'completed'
      && [o.club_a_id, o.club_b_id].some(c => !!c && (c === t.club_a_id || c === t.club_b_id)))
      .map(o => (o as any).ended_at as string | null);
    const times = [...ahead.map(q => q.endedAt), (t as any).court_assigned_at as string | null, ...teamsDone]
      .filter((x): x is string => !!x).map(x => new Date(x).getTime());
    items.push({ kind: 'turn', tie: t, court, deadline: times.length ? Math.max(...times) + LINEUP_DEADLINE_MIN * 60000 : null });
  }
  // 시작됨 → 마감 지난 순 → 마감 가까운 순 → 시각 모름 → 대기(앞 경기 적은 순)
  const rank = (p: PendingInfo) => p.kind === 'started' ? [0, 0] : p.kind === 'turn' ? (p.deadline != null ? [1, p.deadline] : [2, 0]) : [3, p.ahead];
  items.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1]; });
  return { items, unassigned };
}
