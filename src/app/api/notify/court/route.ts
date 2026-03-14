// src/app/api/notify/court/route.ts
import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

webpush.setVapidDetails(
  'mailto:admin@jeju-tournament.com',
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
)

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { event_id, court, match_id, trigger } = await req.json()

    if (!event_id || !court) {
      return NextResponse.json({ error: 'event_id, court 필수' }, { status: 400 })
    }

    // 코트 번호 추출 (예: "코트 1" → 1)
    const courtNum = parseInt(court.replace(/[^0-9]/g, ''))

    let teamAId: string | null = null
    let teamBId: string | null = null
    let teamAName = ''
    let teamBName = ''
    let divisionName = ''
    let targetId = ''

    if (match_id) {
      // match_id가 있으면 개인전 경기
      const { data } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name')
        .eq('id', match_id)
        .single()
      if (data) {
        teamAId = data.team_a_id
        teamBId = data.team_b_id
        teamAName = data.team_a_name
        teamBName = data.team_b_name
        divisionName = data.division_name
        targetId = data.id
      }
    } else {
      // 1. 단체전 ties에서 해당 코트 다음 경기 조회
      const { data: tieList } = await supabaseAdmin
        .from('ties')
        .select('id, club_a_id, club_b_id, status, tie_order, clubs!ties_club_a_id_fkey(name), clubs!ties_club_b_id_fkey(name)')
        .eq('event_id', event_id)
        .eq('court_number', courtNum)
        .neq('status', 'completed')
        .order('tie_order')

      if (tieList && tieList.length > 0) {
        // 진행중이거나 첫 번째 대기 경기
        const activeTie = tieList.find(t => t.status === 'in_progress') || tieList[0]
        teamAId = activeTie.club_a_id
        teamBId = activeTie.club_b_id
        teamAName = (activeTie as any).clubs?.name || ''
        teamBName = (activeTie as any).clubs?.name || ''
        divisionName = '단체전'
        targetId = activeTie.id
      } else {
        // 2. 개인전 matches에서 해당 코트 다음 PENDING 경기 조회
        const { data: courtMatches } = await supabaseAdmin
          .from('v_matches_with_teams')
          .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status')
          .eq('event_id', event_id)
          .eq('court', court)
          .neq('score', 'BYE')
          .order('court_order')

        if (courtMatches && courtMatches.length > 0) {
          const activeIdx = courtMatches.findIndex(m => m.status === 'IN_PROGRESS')
          const searchFrom = activeIdx >= 0 ? activeIdx + 1 : 0
          const target = courtMatches.slice(searchFrom).find(m => m.status === 'PENDING')
            ?? courtMatches.find(m => m.status === 'PENDING')

          if (target) {
            teamAId = target.team_a_id
            teamBId = target.team_b_id
            teamAName = target.team_a_name
            teamBName = target.team_b_name
            divisionName = target.division_name
            targetId = target.id
          }
        }
      }
    }

    if (!teamAId && !teamBId) {
      return NextResponse.json({ sent: 0, message: '대기 중인 경기가 없습니다' })
    }

    // 단체전: club_a, club_b 이름 별도 조회
    if (divisionName === '단체전' && targetId) {
      const { data: tie } = await supabaseAdmin
        .from('ties')
        .select(`
          club_a:clubs!ties_club_a_id_fkey(name),
          club_b:clubs!ties_club_b_id_fkey(name)
        `)
        .eq('id', targetId)
        .single()
      if (tie) {
        teamAName = (tie.club_a as any)?.name || teamAName
        teamBName = (tie.club_b as any)?.name || teamBName
      }
    }

    // 구독자 조회
    const teamIds = [teamAId, teamBId].filter(Boolean) as string[]
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('team_id', teamIds)

    if (subError) return NextResponse.json({ error: subError.message }, { status: 500 })
    if (!subscriptions?.length) {
      return NextResponse.json({ sent: 0, message: '구독자가 없습니다 (알림 동의 안 함)' })
    }

    // 알림 메시지
    const triggerLabel = trigger === 'court_changed' ? '코트가 변경되었습니다!' : '경기 준비하세요!'
    const payload = JSON.stringify({
      title: `🎾 ${court} - ${triggerLabel}`,
      body: `${teamAName} vs ${teamBName} (${divisionName})`,
      icon: '/icon-192x192.png',
      tag: `court-${court}-${targetId}`,
      data: { court, match_id: targetId },
    })

    // 발송
    let sent = 0
    const failedEndpoints: string[] = []

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          )
          sent++
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            failedEndpoints.push(sub.endpoint)
          }
        }
      })
    )

    // 만료 구독 정리
    if (failedEndpoints.length > 0) {
      await supabaseAdmin.from('push_subscriptions').delete().in('endpoint', failedEndpoints)
    }

    return NextResponse.json({
      sent,
      match: { court, team_a: teamAName, team_b: teamBName },
    })
  } catch (err: any) {
    console.error('[notify/court]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}