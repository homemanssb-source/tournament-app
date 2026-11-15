// ============================================================
// 랭킹 시드 — 부서 팀들의 앱A 포인트 합산 순위 (읽기 전용, 운영자 전용)
// POST { event_id, division_id }
//   팀(선수 1~2명) → 앱A 회원 매칭 → 유효 포인트(대회별 최신 회차만) 합산 → 높은 순
// 아무것도 저장하지 않는다. 저장은 조편성 화면의 "시드 저장"이 한다.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'
import { operatorFromRequest } from '@/lib/api-auth'
import { getAppAClient } from '@/lib/app-a-server'
import {
  listEditions, rollingPoints, rankTeams,
  type ResultRow, type RankedTeam, type RankedPlayer, type SeedRankingResult,
} from '@/lib/seed-ranking'

export const dynamic = 'force-dynamic'

type Member = { member_id: string; name: string | null; display_name: string | null; club: string | null }

// 가져오기(pull-individual)의 shortenClub 과 같은 규칙 + 공백 제거
function clubKey(club: string | null | undefined): string {
  if (!club) return ''
  return club.replace(/테니스클럽$/, '').replace(/클럽$/, '').replace(/테니스$/, '').replace(/\s+/g, '').trim()
}

// push-results 의 회원 매칭과 같은 순서: 이 대회 신청자 → 이름+클럽 → 이름 1명
function matchMember(list: Member[], club: string | null, entrantIds: Set<string>): Member | null {
  if (entrantIds.size > 0) {
    const inEvent = list.filter(m => entrantIds.has(m.member_id))
    if (inEvent.length === 1) return inEvent[0]
    if (inEvent.length > 1) {
      const same = inEvent.filter(m => clubKey(m.club) === clubKey(club))
      return same.length === 1 ? same[0] : null
    }
  }
  if (club) {
    const same = list.filter(m => clubKey(m.club) === clubKey(club))
    if (same.length === 1) return same[0]
    if (same.length > 1) return null
  }
  return list.length === 1 ? list[0] : null
}

function fail(error: string, status: number) {
  const body: SeedRankingResult = { ok: false, error, teams: [], tournaments: [], unmatched: [] }
  return NextResponse.json(body, { status })
}

export async function POST(req: NextRequest) {
  try {
    const svc = getServiceClient()
    if (!(await operatorFromRequest(req, svc))) return fail('로그인이 필요합니다.', 401)
    const { event_id, division_id } = await req.json()
    if (!event_id || !division_id) return fail('event_id, division_id 가 필요합니다.', 400)

    const [{ data: teams, error: tErr }, { data: ev }] = await Promise.all([
      svc.from('teams').select('id, team_name, player1_name, player2_name, p1_club, p2_club')
        .eq('event_id', event_id).eq('division_id', division_id),
      svc.from('events').select('app_a_event_id').eq('id', event_id).maybeSingle(),
    ])
    if (tErr) return fail('팀 조회 실패: ' + tErr.message, 500)
    if (!teams || teams.length === 0) return fail('이 부서에 팀이 없습니다.', 400)

    const appA = getAppAClient()

    // 1) 이 대회 앱A 신청자 (동명이인 가리기용 — 못 읽어도 계속)
    const entrantIds = new Set<string>()
    const appAEventId = (ev as any)?.app_a_event_id
    if (appAEventId) {
      const { data: entries } = await appA.from('event_entries')
        .select('entry_status, cancelled_at, team:teams(member1_id, member2_id)').eq('event_id', appAEventId)
      for (const e of (entries || []) as any[]) {
        if (e.entry_status !== '신청' || e.cancelled_at) continue
        if (e.team?.member1_id) entrantIds.add(e.team.member1_id)
        if (e.team?.member2_id) entrantIds.add(e.team.member2_id)
      }
    }

    // 2) 선수 이름으로 앱A 회원 후보 (공개 뷰 — PIN·전화번호 없음)
    const names = [...new Set((teams as any[]).flatMap(t => [t.player1_name, t.player2_name])
      .map(n => (n || '').trim()).filter(Boolean))]
    const members = new Map<string, Member>()
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100)
      for (const col of ['name', 'display_name'] as const) {
        const { data, error } = await appA.from('members_public')
          .select('member_id, name, display_name, club, status').in(col, chunk).neq('status', '삭제')
        if (error) return fail('앱A 회원 조회 실패: ' + error.message, 502)
        for (const m of (data || []) as any[]) members.set(m.member_id, m)
      }
    }
    const byName = new Map<string, Member[]>()
    for (const m of members.values()) {
      for (const n of new Set([m.name, m.display_name].map(x => (x || '').trim()).filter(Boolean))) {
        byName.set(n, [...(byName.get(n) || []), m])
      }
    }

    // 3) 앱A 대회 결과 전체 (대회별 최신 회차 판정에 전체 목록이 필요)
    const rows: ResultRow[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await appA.from('tournament_results')
        .select('member_id, tournament_name, date, points').order('id').range(from, from + 999)
      if (error) return fail('앱A 대회 결과 조회 실패: ' + error.message, 502)
      rows.push(...((data || []) as ResultRow[]))
      if (!data || data.length < 1000) break
    }
    const editions = listEditions(rows)
    const points = rollingPoints(rows, editions)

    // 4) 팀별 합산
    const unmatched: string[] = []
    const player = (name: string | null, club: string | null, teamName: string): RankedPlayer | null => {
      const n = (name || '').trim()
      if (!n) return null
      const m = matchMember(byName.get(n) || [], club, entrantIds)
      if (!m) unmatched.push(`${n} (${club || '클럽없음'}) — ${teamName}`)
      return { name: n, club: club || null, points: m ? (points.get(m.member_id) || 0) : 0, matched: !!m }
    }
    const ranked: RankedTeam[] = (teams as any[]).map(t => {
      const p1 = player(t.player1_name, t.p1_club, t.team_name) || { name: t.team_name || '', club: null, points: 0, matched: false }
      const p2 = player(t.player2_name, t.p2_club, t.team_name)
      return { id: t.id, name: t.team_name, p1, p2, total: p1.points + (p2?.points || 0) }
    })

    const body: SeedRankingResult = {
      ok: true,
      teams: rankTeams(ranked),
      tournaments: editions.filter(e => e.counted || e.replaced_by),
      unmatched,
    }
    return NextResponse.json(body)
  } catch (e: any) {
    return fail(e?.message || '서버 오류', 500)
  }
}
