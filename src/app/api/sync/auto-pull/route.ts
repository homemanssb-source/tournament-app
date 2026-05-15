// ============================================================
// Vercel Cron 자동 동기화 엔드포인트
// vercel.json schedule로 10분 주기 호출됨
// app_a_connected=true 활성 이벤트 모두 pull-individual + pull-team 호출
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAppBServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return createClient(url, key)
}

export async function GET(request: NextRequest) {
  // Vercel Cron 인증 (CRON_SECRET 설정 시)
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const appB = getAppBServiceClient()

    // 연동된 이벤트 + 종료 안 된 것만
    const { data: events } = await appB
      .from('events')
      .select('id, name, event_type, app_a_event_id, status')
      .eq('app_a_connected', true)
      .not('app_a_event_id', 'is', null)
      .neq('status', 'completed')

    if (!events || events.length === 0) {
      return NextResponse.json({ success: true, message: '연동 이벤트 없음', events: 0 })
    }

    const origin = new URL(request.url).origin
    const results: any[] = []

    for (const ev of events) {
      const isTeam = ev.event_type === 'team'
      const path = isTeam ? '/api/sync/pull-team' : '/api/sync/pull-individual'
      try {
        const r = await fetch(origin + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_id: ev.id, app_a_event_id: ev.app_a_event_id }),
        })
        const data = await r.json()
        results.push({
          event_id: ev.id, name: ev.name, type: ev.event_type,
          ok: data.success !== false,
          synced: data.synced || 0,
          updated: data.updated || 0,
          cancelled: data.cancelled || 0,
          error: data.error,
        })
      } catch (e: any) {
        results.push({ event_id: ev.id, name: ev.name, ok: false, error: e.message })
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      events: events.length,
      results,
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}
