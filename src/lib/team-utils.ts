// ============================================================
// 단체전 유틸리티 함수
// src/lib/team-utils.ts
// ============================================================

import type { TieStatus, TeamFormat, TeamMatchType } from '@/types/team';

// ── 대전 상태 한글 표시 ──
export function getTieStatusLabel(status: TieStatus): string {
  const labels: Record<TieStatus, string> = {
    pending: '대기',
    lineup_phase: '라인업 제출중',
    lineup_ready: '라인업 확정',
    in_progress: '경기중',
    completed: '완료',
    bye: '부전승',
  };
  return labels[status] || status;
}

export function getTieStatusColor(status: TieStatus): string {
  const colors: Record<TieStatus, string> = {
    pending: 'bg-gray-100 text-gray-700',
    lineup_phase: 'bg-yellow-100 text-yellow-800',
    lineup_ready: 'bg-blue-100 text-blue-800',
    in_progress: 'bg-green-100 text-green-800',
    completed: 'bg-purple-100 text-purple-800',
    bye: 'bg-gray-200 text-gray-500',
  };
  return colors[status] || 'bg-gray-100 text-gray-700';
}

// ── 대회 포맷 한글 ──
export function getFormatLabel(format: TeamFormat): string {
  const labels: Record<TeamFormat, string> = {
    full_league: '풀리그',
    group_tournament: '조별리그 + 토너먼트',
    prelim_tournament: '예선 순위결정전 + 토너먼트',
  };
  return labels[format] || format;
}

export function getFormatDescription(format: TeamFormat): string {
  const desc: Record<TeamFormat, string> = {
    full_league: '모든 팀이 서로 한 번씩, 바로 순위 결정 (5팀 이하 추천)',
    group_tournament: '조 나눠서 리그 후 토너먼트 (6팀 이상 추천)',
    prelim_tournament: '2~3팀씩 묶어 예선, 시드 배정 후 토너먼트',
  };
  return desc[format] || '';
}

// ── 라운드 이름 한글 ──
export function getRoundLabel(round: string | null): string {
  if (!round) return '';
  const labels: Record<string, string> = {
    full_league: '풀리그',
    group: '조별리그',
    round_of_16: '16강',
    quarter: '8강',
    semi: '4강',
    final: '결승',
  };
  return labels[round] || round;
}

// ── 과반수 계산 ──
export function getMajority(rubberCount: number): number {
  return Math.floor(rubberCount / 2) + 1;
}

// ── 풀리그 대전 수 ──
export function getFullLeagueTieCount(clubCount: number): number {
  return (clubCount * (clubCount - 1)) / 2;
}

// ── 브래킷 사이즈 + 바이 수 계산 ──
export function calculateBracket(clubCount: number) {
  let bracketSize = 2;
  while (bracketSize < clubCount) bracketSize *= 2;
  return {
    bracketSize,
    byeCount: bracketSize - clubCount,
  };
}

// ── 스코어 포맷 ──
export function formatSetScore(a: number | null, b: number | null): string {
  if (a === null || b === null) return '-';
  return `${a}-${b}`;
}

export function formatTieScore(aWins: number, bWins: number, rubberCount: number): string {
  return `${aWins} - ${bWins} (${rubberCount}복식)`;
}

// ── 성별 표시 ──
export function getGenderLabel(gender: string | null): string {
  if (gender === 'M') return '남';
  if (gender === 'F') return '여';
  return '';
}

// ── PIN 생성 (6자리) ──
export function generatePin(): string {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

// ── 시드 번호 표시 ──
export function getSeedBadge(seedNumber: number | null): string {
  if (!seedNumber) return '';
  return `[${seedNumber}시드]`;
}

// ★ ── 경기방식(team_match_type) 관련 ──

export function getMatchTypeLabel(matchType: TeamMatchType | string | null): string {
  if (matchType === '5_doubles') return '5복식 (3승 선승)';
  if (matchType === '3_doubles') return '3복식 (2승 선승)';
  return '3복식 (기본)';
}

export function getMatchTypeShort(matchType: TeamMatchType | string | null): string {
  if (matchType === '5_doubles') return '5복식';
  return '3복식';
}

export function getRubberCountByMatchType(matchType: TeamMatchType | string | null): number {
  if (matchType === '5_doubles') return 5;
  return 3; // 기본값
}

export function getMajorityByMatchType(matchType: TeamMatchType | string | null): number {
  return getMajority(getRubberCountByMatchType(matchType));
}