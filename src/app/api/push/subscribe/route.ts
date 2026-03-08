// src/app/api/push/subscribe/route.ts
// 선수가 PIN 입력 → 구독 정보 저장 API
// 기존 코드와 충돌 없음 (새 파일)

import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const { pin, subscription } = await req.json()

    if (!pin || !subscription?.endpoint) {
      return NextResponse.json({ error: 'PIN과 구독 정보가 필요합니다.' }, { status: 400 })
    }

    const supabase = getServiceClient()

    // PIN으로 팀 조회 (기존 teams 테이블의 pin_plain 필드 사용)
    const { data: team, error: teamErr } = await supabase
      .from('teams')
      .select('id, team_name')
      .eq('pin_plain', pin)
      .single()

    if (teamErr || !team) {
      return NextResponse.json({ error: 'PIN이 올바르지 않습니다.' }, { status: 404 })
    }

    // push_subscriptions 테이블에 저장 (중복이면 업데이트)
    const { error: upsertErr } = await supabase
      .from('push_subscriptions')
      .upsert({
        team_id:  team.id,
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

    return NextResponse.json({ ok: true, team_name: team.team_name })

  } catch (err) {
    console.error('[push/subscribe] error:', err)
    return NextResponse.json({ error: '서버 오류' }, { status: 500 })
  }
}
