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

    // 대상 ID 리스트 (다중 부서 captain_pin 케이스에서 여러 club이 매칭됨)
    const targetIds: string[] = []
    let teamName: string | null = null

    // 1. 개인전: teams.pin_plain 조회 (단일)
    const { data: team } = await supabase
      .from('teams')
      .select('id, team_name')
      .eq('pin_plain', pin)
      .maybeSingle()

    if (team) {
      targetIds.push(team.id)
      teamName = team.team_name
    }

    // 2. 단체전: clubs.captain_pin 조회 (여러 부서 가능성 → .maybeSingle() X)
    if (targetIds.length === 0) {
      const { data: clubs } = await supabase
        .from('clubs')
        .select('id, name')
        .eq('captain_pin', pin)

      if (clubs && clubs.length > 0) {
        for (const c of clubs) targetIds.push(c.id)
        // 팀명: 이름이 동일하면 하나만, 다르면 '팀명1, 팀명2' 로
        const names = [...new Set(clubs.map(c => c.name))]
        teamName = names.join(' / ')
      }
    }

    if (targetIds.length === 0) {
      return NextResponse.json({ error: 'PIN이 올바르지 않습니다.' }, { status: 404 })
    }

    // push_subscriptions에 저장 (다중 부서면 각 club_id별로 row 생성)
    const rows = targetIds.map(id => ({
      team_id:  id,
      endpoint: subscription.endpoint,
      p256dh:   subscription.keys.p256dh,
      auth:     subscription.keys.auth,
    }))

    const { error: upsertErr } = await supabase
      .from('push_subscriptions')
      .upsert(rows, { onConflict: 'team_id,endpoint' })

    if (upsertErr) {
      console.error('[push/subscribe] upsert error:', upsertErr)
      return NextResponse.json({ error: '저장 실패' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, team_name: teamName, subscribed_count: targetIds.length })

  } catch (err) {
    console.error('[push/subscribe] error:', err)
    return NextResponse.json({ error: '서버 오류' }, { status: 500 })
  }
}