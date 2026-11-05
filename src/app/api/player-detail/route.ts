// ============================================================
// src/app/api/player-detail/route.ts
// 대회보기에서 선수 이름을 누르면 앱A '회원 상세'와 같은 정보를 돌려준다 (공개, 읽기 전용).
//
// 대회 앱 팀에는 앱A 회원번호가 없고 "이름(클럽)" 만 있으므로 앱A members_public 에서 찾는다:
//   1) 이름 + 클럽이 맞는 회원이 1명 → 그 회원
//   2) 클럽이 맞는 회원이 없고 그 이름이 앱A 전체에 1명 → 그 회원 (클럽 옮긴 경우 등, club_mismatch 표시)
//   3) 그 외(동명이인) → 후보 목록만 돌려주고 화면에서 고르게 함
// 앱A 공개(anon) 키만 쓴다 → 앱A 가 공개로 열어 둔 정보만 나온다 (전화번호·PIN 없음).
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { getAppAPublicClient } from '@/lib/app-a-server'

// 앱A 외부대회 신고 공개 열 (앱A PlayerDetail 과 동일, 전화번호 제외)
const REPORT_COLS = 'id, member_id, tournament_name, tournament_date, tournament_type, tournament_division, result, before_grade, expected_grade, admin_applied'
const MEMBER_COLS = 'member_id, name, display_name, club, division, grade, status'

// pull-individual 의 shortenClub 과 같은 규칙: "제주하나클럽" → "제주하나"
function shortenClub(club: string | null | undefined): string {
  if (!club) return ''
  return club.replace(/테니스클럽$/, '').replace(/클럽$/, '').replace(/테니스$/, '').trim()
}
const squash = (s: string) => s.replace(/\s+/g, '')

function clubMatches(memberClub: string | null, teamClub: string): boolean {
  if (!teamClub || !memberClub) return false
  const a = squash(shortenClub(memberClub)), full = squash(memberClub), b = squash(teamClub)
  return a === b || full === b
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': status === 200 ? 'public, s-maxage=60, stale-while-revalidate=300' : 'no-store' },
  })
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const name = (sp.get('name') || '').trim().slice(0, 40)
  const club = (sp.get('club') || '').trim().slice(0, 60)
  const memberIdParam = (sp.get('member_id') || '').trim()
  const nowYear = new Date().getFullYear()
  const yearNum = Number(sp.get('year'))
  const year = Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= nowYear + 1 ? yearNum : nowYear

  if (!name && !memberIdParam) return json({ ok: false, error: '선수 이름이 없습니다.' }, 400)
  if (memberIdParam && !/^[A-Za-z0-9_-]{1,40}$/.test(memberIdParam)) return json({ ok: false, error: '잘못된 회원번호' }, 400)

  let appA
  try { appA = getAppAPublicClient() } catch (e: any) {
    return json({ ok: false, error: '앱A 연결 설정이 없습니다.' }, 500)
  }

  // ── 1. 회원 찾기 ──
  let memberId = memberIdParam
  let clubMismatch = false
  if (!memberId) {
    const { data: found, error } = await appA.from('members_public')
      .select(MEMBER_COLS)
      .or(`name.eq.${JSON.stringify(name)},display_name.eq.${JSON.stringify(name)}`)
      .neq('status', '삭제')
      .limit(20)
    if (error) return json({ ok: false, error: '앱A 회원 조회 실패' }, 502)
    const list = (found || []) as any[]
    const byClub = list.filter(m => clubMatches(m.club, club))
    if (byClub.length === 1) memberId = byClub[0].member_id
    else if (byClub.length === 0 && list.length === 1) { memberId = list[0].member_id; clubMismatch = !!club }
    else if (list.length === 0) return json({ ok: true, found: false, candidates: [] })
    else {
      const pool = byClub.length > 1 ? byClub : list
      return json({
        ok: true, found: false,
        candidates: pool.map(m => ({ member_id: m.member_id, name: m.display_name || m.name, club: m.club, grade: m.grade, division: m.division })),
      })
    }
  }

  // ── 2. 상세 (앱A PlayerDetail 과 같은 조회) ──
  const [hist, ext] = await Promise.all([
    appA.rpc('get_member_history', { p_member_id: memberId, p_season_year: year }),
    appA.from('external_report_log').select(REPORT_COLS).eq('member_id', memberId)
      .order('tournament_date', { ascending: false }),
  ])
  const h: any = hist.data
  if (hist.error || !h?.ok || !h.member) return json({ ok: true, found: false, candidates: [] })

  let rank: number | null = null
  if (h.member.division) {
    const { data: rankings } = await appA.rpc('get_rankings', {
      p_division: h.member.division, p_season_year: year, p_limit: 100, p_offset: 0,
    })
    if (Array.isArray(rankings)) {
      const idx = rankings.filter((p: any) => p.total_points > 0).findIndex((p: any) => p.member_id === memberId)
      if (idx >= 0) rank = idx + 1
    }
  }

  const m = h.member
  return json({
    ok: true, found: true, club_mismatch: clubMismatch,
    season_year: h.season_year ?? year,
    member: {
      member_id: m.member_id, name: m.display_name || m.name, club: m.club,
      division: m.division, grade: m.grade, status: m.status,
    },
    total_points: h.total_points ?? 0,
    rank,
    history: (h.history || []).map((x: any) => ({
      tournament_name: x.tournament_name, date: x.date, division: x.division,
      rank: x.rank, points: x.points, grade: x.grade,
    })),
    external: ext.data || [],
  })
}
