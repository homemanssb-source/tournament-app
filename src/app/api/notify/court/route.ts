// src/app/api/notify/court/route.ts
// ✅ urgency: 'high' + TTL: 60
// ✅ tag에 timestamp → 연속 알림 덮어쓰기 방지
// ✅ push_logs 테이블에 발송 결과 저장
// ✅ [FIX] push_logs INSERT를 fire-and-forget → 응답 지연 방지
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

// push_logs에 fire-and-forget으로 저장 (await하지 않음 → 응답 속도 영향 없음)
function savePushLog(
  supabaseAdmin: ReturnType<typeof getServiceClient>,
  data: Record<string, any>
) {
  // ✅ Promise.resolve()로 감싸서 .catch() 타입 오류 방지
  Promise.resolve(supabaseAdmin.from('push_logs').insert(data)).catch(() => {})
}

export async function POST(req: NextRequest) {
  let logData: Record<string, any> = {}
  let supabaseAdmin: ReturnType<typeof getServiceClient> | null = null

  try {
    supabaseAdmin = getServiceClient()

    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ sent: 0, message: 'VAPID not configured' })
    }

    const webpush = (await import('web-push')).default
    webpush.setVapidDetails(
      'mailto:admin@jeju-tournament.com',
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )

    const { event_id, court, match_id, finished_match_id, match_date, trigger } = await req.json()

    if (!event_id || !court) {
      return NextResponse.json({ error: 'event_id, court 필수' }, { status: 400 })
    }

    logData = { event_id, court, trigger: trigger || 'manual' }

    const lastPart = court.split('-').pop() || ''
    const courtNum = /^\d+$/.test(lastPart)
      ? parseInt(lastPart, 10)
      : parseInt(court.replace(/[^0-9]/g, ''), 10) || 0

    let teamAId: string | null = null
    let teamBId: string | null = null
    let teamAName = ''
    let teamBName = ''
    let divisionName = ''
    let targetId = ''

    if (finished_match_id) {
      const { data: finishedMatch } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('court, court_order, match_date')
        .eq('id', finished_match_id)
        .single()

      if (finishedMatch) {
        let q = supabaseAdmin
          .from('v_matches_with_teams')
          .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status, score, court_order')
          .eq('event_id', event_id)
          .eq('court', finishedMatch.court || court)
          .order('court_order')

        if (finishedMatch.match_date) q = q.eq('match_date', finishedMatch.match_date)

        const { data: courtMatches } = await q
        const filtered = (courtMatches || []).filter((m: any) => m.score !== 'BYE')
        const finishedIdx = filtered.findIndex((m: any) => m.id === finished_match_id)
        const target = finishedIdx >= 0
          ? filtered.slice(finishedIdx + 1).find((m: any) => m.status === 'PENDING')
          : undefined

        if (target) {
          teamAId = target.team_a_id; teamBId = target.team_b_id
          teamAName = target.team_a_name; teamBName = target.team_b_name
          divisionName = target.division_name; targetId = target.id
        }
      }
    } else if (match_id) {
      const { data } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name')
        .eq('id', match_id).single()
      if (data) {
        teamAId = data.team_a_id; teamBId = data.team_b_id
        teamAName = data.team_a_name; teamBName = data.team_b_name
        divisionName = data.division_name; targetId = data.id
      }
    } else {
      const { data: tieList } = await supabaseAdmin
        .from('ties')
        .select('id, club_a_id, club_b_id, status, tie_order')
        .eq('event_id', event_id).eq('court_number', courtNum)
        .neq('status', 'completed').order('tie_order')

      if (tieList && tieList.length > 0) {
        const activeTie = tieList.find((t: any) => t.status === 'in_progress') || tieList[0]
        teamAId = activeTie.club_a_id; teamBId = activeTie.club_b_id
        targetId = activeTie.id; divisionName = '단체전'
        const [{ data: clubA }, { data: clubB }] = await Promise.all([
          supabaseAdmin.from('clubs').select('name').eq('id', activeTie.club_a_id).single(),
          supabaseAdmin.from('clubs').select('name').eq('id', activeTie.club_b_id).single(),
        ])
        teamAName = clubA?.name || ''; teamBName = clubB?.name || ''
      } else {
        const { data: allCourtMatches } = await supabaseAdmin
          .from('v_matches_with_teams')
          .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status, score, match_date')
          .eq('event_id', event_id).eq('court', court).order('court_order')

        const allFiltered = (allCourtMatches || []).filter((m: any) => m.score !== 'BYE')
        const liveMatch = allFiltered.find((m: any) => m.status === 'IN_PROGRESS')
        const todayDate = liveMatch?.match_date || match_date || null
        const courtMatches = todayDate
          ? allFiltered.filter((m: any) => m.match_date === todayDate)
          : allFiltered

        if (courtMatches.length > 0) {
          const activeIdx = courtMatches.findIndex((m: any) => m.status === 'IN_PROGRESS')
          const searchFrom = activeIdx >= 0 ? activeIdx + 1 : 0
          const target = courtMatches.slice(searchFrom).find((m: any) => m.status === 'PENDING')
            ?? courtMatches.find((m: any) => m.status === 'PENDING')
          if (target) {
            teamAId = target.team_a_id; teamBId = target.team_b_id
            teamAName = target.team_a_name; teamBName = target.team_b_name
            divisionName = target.division_name; targetId = target.id
          }
        }
      }
    }

    logData = { ...logData, team_a_name: teamAName, team_b_name: teamBName, division_name: divisionName }

    if (!teamAId && !teamBId) {
      // ✅ fire-and-forget: 응답 지연 없음
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: true })
      return NextResponse.json({ sent: 0, message: '대기 중인 경기가 없습니다' })
    }

    const teamIds = [teamAId, teamBId].filter(Boolean) as string[]
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth, team_id')
      .in('team_id', teamIds)

    if (subError) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: false, error_msg: subError.message })
      return NextResponse.json({ error: subError.message }, { status: 500 })
    }

    if (!subscriptions?.length) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: true })
      return NextResponse.json({ sent: 0, message: '구독자가 없습니다', teams: { a: teamAName, b: teamBName } })
    }

    const triggerLabel = trigger === 'court_changed' ? '코트가 변경되었습니다!' : '경기 준비하세요!'
    const payload = JSON.stringify({
      title: `🎾 ${court} - ${triggerLabel}`,
      body: `${teamAName} vs ${teamBName} (${divisionName})`,
      icon: '/icon-192x192.png',
      tag: `court-${court}-${Date.now()}`,
      url: '/pin/matches',
      data: { court, match_id: targetId },
    })

    const pushOptions = { urgency: 'high' as const, TTL: 60 }

    let sent = 0
    let failed = 0
    const failedEndpoints: string[] = []

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            pushOptions
          )
          sent++
        } catch (err: any) {
          failed++
          if (err.statusCode === 410 || err.statusCode === 404) {
            failedEndpoints.push(sub.endpoint)
          }
        }
      })
    )

    if (failedEndpoints.length > 0) {
      // 만료 구독 삭제도 fire-and-forget (응답 지연 방지)
      Promise.resolve(
        supabaseAdmin.from('push_subscriptions').delete().in('endpoint', failedEndpoints)
      ).catch(() => {})
    }

    // ✅ fire-and-forget: 로그 저장이 응답을 block하지 않음
    savePushLog(supabaseAdmin, { ...logData, sent, failed, no_sub: false })

    return NextResponse.json({ sent, failed, match: { court, team_a: teamAName, team_b: teamBName } })

  } catch (err: any) {
    console.error('[notify/court]', err)
    if (supabaseAdmin) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: false, error_msg: err.message })
    }
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
