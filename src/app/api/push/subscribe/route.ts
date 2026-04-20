// src/app/api/push/subscribe/route.ts
// 선수가 PIN 입력 → 구독 정보 저장 API
// ★ 수정: 개인전(teams.pin_plain) + 단체전(clubs.captain_pin) 둘 다 지원

import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    // mode: 'individual' | 'team' | undefined (자동 폴백)
    // event_id: 현재 대회 스코프 (과거 대회 PIN 중복 매칭 방지)
    const { pin, subscription, mode, event_id } = await req.json()

    if (!pin || !subscription?.endpoint) {
      return NextResponse.json({ error: 'PIN과 구독 정보가 필요합니다.' }, { status: 400 })
    }

    const supabase = getServiceClient()

    const targetIds: string[] = []
    let teamName: string | null = null

    // ✅ event_id + mode로 정확한 row만 조회 (과거 대회 PIN 충돌 방지)
    //    - mode 없으면 두 테이블 순차 폴백
    //    - event_id 없으면 전체 매칭 (구버전 호환)

    const wantTeam = mode === 'team' || !mode
    const wantIndividual = mode === 'individual' || !mode

    if (wantIndividual) {
      let q = supabase.from('teams').select('id, team_name, event_id').eq('pin_plain', pin)
      if (event_id) q = q.eq('event_id', event_id)
      const { data } = await q
      const teams = data || []
      if (teams.length > 0) {
        for (const t of teams) targetIds.push(t.id)
        teamName = [...new Set(teams.map((t: any) => t.team_name))].join(' / ')
      }
    }

    if (targetIds.length === 0 && wantTeam) {
      let q = supabase.from('clubs').select('id, name, event_id').eq('captain_pin', pin)
      if (event_id) q = q.eq('event_id', event_id)
      const { data } = await q
      const clubs = data || []
      if (clubs.length > 0) {
        for (const c of clubs) targetIds.push(c.id)
        teamName = [...new Set(clubs.map((c: any) => c.name))].join(' / ')
      }
    }

    if (targetIds.length === 0) {
      return NextResponse.json({ error: 'PIN이 올바르지 않습니다.' }, { status: 404 })
    }

    // ✅ 같은 endpoint의 과거 구독 정리 (다른 대회/다른 team_id 지우기)
    //    동일 기기는 endpoint가 고유하므로, 사용자가 새로 구독하면 이전 context는 폐기
    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint)
      .not('team_id', 'in', `(${targetIds.map(id => `"${id}"`).join(',')})`)

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