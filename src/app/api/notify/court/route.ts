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

    // 1. 다음 PENDING 경기 조회
    let targetMatch: any = null

    if (match_id) {
      const { data } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('id, team_a_id, team_b_id, team_a_name, team_b_name, court, court_order, division_name')
        .eq('id', match_id)
        .single()
      targetMatch = data
    } else {
      const { data: courtMatches } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('id, team_a_id, team_b_id, team_a_name, team_b_name, court, court_order, division_name, status')
        .eq('event_id', event_id)
        .eq('court', court)
        .neq('score', 'BYE')
        .order('court_order')

      if (!courtMatches?.length) {
        return NextResponse.json({ sent: 0, message: '해당 코트에 경기가 없습니다' })
      }

      const activeIdx = courtMatches.findIndex((m: any) => m.status === 'IN_PROGRESS')
      const searchFrom = activeIdx >= 0 ? activeIdx + 1 : 0
      targetMatch = courtMatches.slice(searchFrom).find((m: any) => m.status === 'PENDING')
        ?? courtMatches.find((m: any) => m.status === 'PENDING')
    }

    if (!targetMatch) {
      return NextResponse.json({ sent: 0, message: '대기 중인 경기가 없습니다' })
    }

    // 2. 양팀 구독 조회
    const teamIds = [targetMatch.team_a_id, targetMatch.team_b_id].filter(Boolean)
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('team_id', teamIds)

    if (subError) return NextResponse.json({ error: subError.message }, { status: 500 })
    if (!subscriptions?.length) {
      return NextResponse.json({ sent: 0, message: '구독자가 없습니다 (알림 동의 안 함)' })
    }

    // 3. 알림 메시지
    const triggerLabel = trigger === 'court_changed' ? '코트가 변경되었습니다!' : '경기 준비하세요!'
    const payload = JSON.stringify({
      title: `🎾 ${targetMatch.court} - ${triggerLabel}`,
      body: `${targetMatch.team_a_name} vs ${targetMatch.team_b_name} (${targetMatch.division_name})`,
      icon: '/icon-192x192.png',
      tag: `court-${court}-${targetMatch.id}`,
      data: { court, match_id: targetMatch.id },
    })

    // 4. 발송
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
      match: { court: targetMatch.court, team_a: targetMatch.team_a_name, team_b: targetMatch.team_b_name },
    })
  } catch (err: any) {
    console.error('[notify/court]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
