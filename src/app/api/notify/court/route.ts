// src/app/api/notify/court/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    // ✅ VAPID 키 없으면 조용히 skip (빌드 안전)
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ sent: 0, message: 'VAPID not configured' })
    }

    // ✅ web-push를 dynamic import로 런타임에만 로드 (빌드 시 VAPID 검증 우회)
    const webpush = (await import('web-push')).default
    webpush.setVapidDetails(
      'mailto:admin@jeju-tournament.com',
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )

    const supabaseAdmin = getServiceClient()
    const { event_id, court, match_id, trigger } = await req.json()

    if (!event_id || !court) {
      return NextResponse.json({ error: 'event_id, court 필수' }, { status: 400 })
    }

    const courtNum = parseInt(court.replace(/[^0-9]/g, ''))

    let teamAId: string | null = null
    let teamBId: string | null = null
    let teamAName = ''
    let teamBName = ''
    let divisionName = ''
    let targetId = ''

    if (match_id) {
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
      // 단체전 ties 먼저 확인
      const { data: tieList } = await supabaseAdmin
        .from('ties')
        .select('id, club_a_id, club_b_id, status, tie_order')
        .eq('event_id', event_id)
        .eq('court_number', courtNum)
        .neq('status', 'completed')
        .order('tie_order')

      if (tieList && tieList.length > 0) {
        const activeTie = tieList.find(t => t.status === 'in_progress') || tieList[0]
        teamAId = activeTie.club_a_id
        teamBId = activeTie.club_b_id
        targetId = activeTie.id
        divisionName = '단체전'

        const [{ data: clubA }, { data: clubB }] = await Promise.all([
          supabaseAdmin.from('clubs').select('name').eq('id', activeTie.club_a_id).single(),
          supabaseAdmin.from('clubs').select('name').eq('id', activeTie.club_b_id).single(),
        ])
        teamAName = clubA?.name || ''
        teamBName = clubB?.name || ''
      } else {
        // 개인전 matches
        const { data: courtMatches } = await supabaseAdmin
          .from('v_matches_with_teams')
          .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status, score')
          .eq('event_id', event_id)
          .eq('court', court)
          .order('court_order')

        // ✅ BYE 제외 클라이언트 필터 (NULL score 포함)
        const filteredMatches = (courtMatches || []).filter((m: any) => m.score !== 'BYE')

        if (filteredMatches && filteredMatches.length > 0) {
          const activeIdx = filteredMatches.findIndex(m => m.status === 'IN_PROGRESS')
          const searchFrom = activeIdx >= 0 ? activeIdx + 1 : 0
          const target = filteredMatches.slice(searchFrom).find(m => m.status === 'PENDING')
            ?? filteredMatches.find(m => m.status === 'PENDING')

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

    const teamIds = [teamAId, teamBId].filter(Boolean) as string[]
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('team_id', teamIds)

    if (subError) return NextResponse.json({ error: subError.message }, { status: 500 })
    if (!subscriptions?.length) {
      return NextResponse.json({ sent: 0, message: '구독자가 없습니다' })
    }

    const triggerLabel = trigger === 'court_changed' ? '코트가 변경되었습니다!' : '경기 준비하세요!'
    const payload = JSON.stringify({
      title: `🎾 ${court} - ${triggerLabel}`,
      body: `${teamAName} vs ${teamBName} (${divisionName})`,
      icon: '/icon-192x192.png',
      tag: `court-${court}-${targetId}`,
      data: { court, match_id: targetId },
    })

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