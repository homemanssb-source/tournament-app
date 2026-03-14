// src/app/api/push/subscribe/route.ts
// 선수가 PIN 입력 → 구독 정보 저장 API
// ★ 수정: 개인전(teams.pin_plain) + 단체전(clubs.captain_pin) 둘 다 지원

import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const { pin, subscription } = await req.json()

    if (!pin || !subscription?.endpoint) {
      return NextResponse.json({ error: 'PIN과 구독 정보가 필요합니다.' }, { status: 400 })
    }

    const supabase = getServiceClient()

    let teamId: string | null = null
    let teamName: string | null = null

    // 1. 개인전: teams.pin_plain 조회
    const { data: team } = await supabase
      .from('teams')
      .select('id, team_name')
      .eq('pin_plain', pin)
      .maybeSingle()

    if (team) {
      teamId = team.id
      teamName = team.team_name
    }

    // 2. 단체전: clubs.captain_pin 조회 (개인전에서 못 찾은 경우)
    if (!teamId) {
      const { data: club } = await supabase
        .from('clubs')
        .select('id, name')
        .eq('captain_pin', pin)
        .maybeSingle()

      if (club) {
        teamId = club.id
        teamName = club.name
      }
    }

    if (!teamId) {
      return NextResponse.json({ error: 'PIN이 올바르지 않습니다.' }, { status: 404 })
    }

    // push_subscriptions 테이블에 저장 (중복이면 업데이트)
    const { error: upsertErr } = await supabase
      .from('push_subscriptions')
      .upsert({
        team_id:  teamId,
        endpoint: subscription.endpoint,
        p256dh:   subscription.keys.p256dh,
        auth:     subscription.keys.auth,
      }, {
        onConflict: 'team_id,endpoint'
      })

    if (upsertErr) {
      console.error('[push/subscribe] upsert error:', upsertErr)
      return NextResponse.json({ error: '저장 실패' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, team_name: teamName })

  } catch (err) {
    console.error('[push/subscribe] error:', err)
    return NextResponse.json({ error: '서버 오류' }, { status: 500 })
  }
}