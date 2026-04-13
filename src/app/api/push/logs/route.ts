// src/app/api/push/logs/route.ts
// 대시보드용 push_logs 조회 API
// push_logs INSERT는 service_role(notify/court)에서 수행
// 조회는 이 API route를 통해 대시보드에서 호출
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const event_id = searchParams.get('event_id')
    const limit    = Math.min(parseInt(searchParams.get('limit') || '200'), 500) // 최대 500건 제한

    if (!event_id) {
      return NextResponse.json({ error: 'event_id 필수' }, { status: 400 })
    }

    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('push_logs')
      .select('*')
      .eq('event_id', event_id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ logs: data || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
