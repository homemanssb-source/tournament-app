// ============================================================
// 단체전 대전이 끝난 뒤 "다음 대전" 고르기 — /api/notify/court 가 씀
// src/lib/tie-next.ts
//
// 같은 코트 · 같은 경기일(부서 match_date, 없으면 날짜 무관)의 남은 대전 중
// 진행 중이 아닌 첫 대전 (court_order, 없으면 100+tie_order — CourtBoard 와 같은 기준)
// ============================================================

export type NextTieRow = {
  id: string; status: string; is_bye?: boolean | null; court_number: number | null;
  court_order: number | null; tie_order: number | null; division_id: string | null;
  club_a_id: string | null; club_b_id: string | null;
};

const order = (t: NextTieRow) => t.court_order ?? (100 + (t.tie_order || 0));

export function pickNextTie(
  ties: NextTieRow[], finished: NextTieRow, divDates: Record<string, string | null | undefined>,
): NextTieRow | null {
  if (finished.court_number == null) return null;
  const day = finished.division_id ? divDates[finished.division_id] ?? null : null;
  const left = ties.filter(t => t.id !== finished.id && !t.is_bye
    && t.court_number === finished.court_number
    && t.status !== 'completed' && t.status !== 'in_progress'
    && (!!t.club_a_id || !!t.club_b_id)   // 두 자리 모두 미정(TBD)이면 보낼 곳이 없음
    && (!day || !t.division_id || !divDates[t.division_id] || divDates[t.division_id] === day));
  left.sort((a, b) => order(a) - order(b) || (a.tie_order || 0) - (b.tie_order || 0));
  return left[0] ?? null;
}

// 코트 번호(court_number, 대회 전체 코트 목록의 1부터 순번) → 이름 — dashboard/courts 의 globalCourtNumToName 과 같은 규칙
export function courtNameOf(
  n: number, venues: { name?: string | null; short_name?: string | null; court_count?: number | null; courts?: string[] | null }[],
): string {
  const all = venues.flatMap(v => (v.courts && v.courts.length > 0)
    ? v.courts
    : Array.from({ length: v.court_count || 0 }, (_, i) => `${(v.short_name || v.name || '').trim() || '코트'}-${i + 1}`));
  if (n >= 1 && n <= all.length) return all[n - 1];
  if (venues.length === 0) return `코트-${n}`;
  const last = venues[venues.length - 1];
  return `${last.short_name || last.name}-${n}`;
}
