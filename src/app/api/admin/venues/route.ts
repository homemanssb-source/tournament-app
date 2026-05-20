// 대시보드 운영자용 venues CRUD
// venues 테이블 RLS에 INSERT/UPDATE/DELETE 정책이 없어 anon key로 막힘 → service_role 우회
//
// 보안: dashboard는 자체 인증 페이지에서 보호되며 외부 노출 안 됨.
//       추가 검증이 필요하면 user JWT 검증 미들웨어 추가 가능.
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { event_id, name, short_name, courts, court_count, pin_plain, manager_name, division_ids } = body
    if (!event_id || !name || !short_name) {
      return NextResponse.json({ error: 'event_id, name, short_name 필수' }, { status: 400 })
    }
    const supabase = getServiceClient()
    const { data, error } = await supabase.from('venues').insert({
      event_id, name, short_name, courts, court_count, pin_plain, manager_name,
      division_ids: division_ids?.length > 0 ? division_ids : null,
    }).select('*').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ venue: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...updates } = body
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 })
    const supabase = getServiceClient()
    const { data, error } = await supabase.from('venues').update(updates).eq('id', id).select('*').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ venue: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 })
    const supabase = getServiceClient()
    const { error } = await supabase.from('venues').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
