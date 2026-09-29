// 대시보드 운영자용 venues CRUD
// venues 테이블 RLS에 INSERT/UPDATE/DELETE 정책이 없어 anon key로 막힘 → service_role 우회
//
// 보안: 운영자 로그인(Authorization: Bearer <Supabase JWT>) 필요 — 그동안 인증 없이 열려 있었음
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'
import { operatorFromRequest } from '@/lib/api-auth'

const unauthorized = () => NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })

export async function POST(req: NextRequest) {
  try {
    if (!(await operatorFromRequest(req))) return unauthorized()
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
    if (!(await operatorFromRequest(req))) return unauthorized()
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
    if (!(await operatorFromRequest(req))) return unauthorized()
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
