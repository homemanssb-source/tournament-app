// src/app/api/notify/court/route.ts
// ✅ [FIX-⑥] courtNum 파싱: replace(/[^0-9]/g,'') → split('-').pop() 방식으로 개선
//    "한라-2" → 2, "제주A-10" → 10 (숫자가 여러 개 섞인 short_name 안전)
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
    const { event_id, court, match_id, finished_match_id, match_date, trigger } = await req.json()

    if (!event_id || !court) {
      return NextResponse.json({ error: 'event_id, court 필수' }, { status: 400 })
    }

    // ✅ [FIX-⑥] 코트명 마지막 숫자 파싱 (short_name-N 포맷 대응)
    // "한라-2" → split('-') → ['한라','2'] → pop() → '2' → parseInt → 2
    // "제주A-10" → pop() → '10' → 10
    // "코트-1" → pop() → '1' → 1
    // 단, short_name 자체에 숫자가 없는 경우 대비: fallback으로 전체에서 숫자 추출
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
      // ✅ 점수 제출 후 호출: 방금 끝난 경기의 코트+날짜 기준으로 다음 PENDING 경기 찾기
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

        // 날짜 필터: match_date 있으면 같은 날짜만
        if (finishedMatch.match_date) q = q.eq('match_date', finishedMatch.match_date)

        const { data: courtMatches } = await q
        const filtered = (courtMatches || []).filter((m: any) => m.score !== 'BYE')

        // ✅ court_order 값이 아닌 배열 인덱스 기준으로 다음 경기 찾기
        // (수동 수정으로 court_order가 뒤섞여도 정렬 순서상 다음이 정확함)
        const finishedIdx = filtered.findIndex((m: any) => m.id === finished_match_id)
        const target = finishedIdx >= 0
          ? filtered.slice(finishedIdx + 1).find((m: any) => m.status === 'PENDING')
          : undefined

        if (target) {
          teamAId = target.team_a_id
          teamBId = target.team_b_id
          teamAName = target.team_a_name
          teamBName = target.team_b_name
          divisionName = target.division_name
          targetId = target.id
        }
      }
    } else if (match_id) {
      // 기존: 특정 경기 팀에게 직접 발송 (드래그 배정 등)
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
        // ✅ 날짜 필터: 외부에서 안 넘겨도 IN_PROGRESS 경기의 match_date로 자동 결정
        // 1단계: 날짜 없이 전체 조회
        const { data: allCourtMatches } = await supabaseAdmin
          .from('v_matches_with_teams')
          .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status, score, match_date')
          .eq('event_id', event_id)
          .eq('court', court)
          .order('court_order')

        const allFiltered = (allCourtMatches || []).filter((m: any) => m.score !== 'BYE')

        // 2단계: 현재 IN_PROGRESS 경기의 match_date 추출 → 같은 날짜만 필터
        const liveMatch = allFiltered.find((m: any) => m.status === 'IN_PROGRESS')
        const todayDate = liveMatch?.match_date || match_date || null
        const courtMatches = todayDate
          ? allFiltered.filter((m: any) => m.match_date === todayDate)
          : allFiltered

        // ✅ BYE 제외는 위에서 처리됨
        const filteredMatches = courtMatches

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
