// ============================================================
// src/app/api/push/check/route.ts
// endpoint가 서버 DB에 존재하는지 확인
// autoResubscribe에서 사용
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const { endpoint } = await req.json()
    if (!endpoint) {
      return NextResponse.json({ exists: false })
    }

    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', endpoint)
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('[Push Check]', error.message)
      return NextResponse.json({ exists: false })
    }

    return NextResponse.json({ exists: !!data })
  } catch (err) {
    return NextResponse.json({ exists: false })
  }
}