// ============================================================
// 운영자 계정 관리 API (메인 관리자 전용)
// src/app/api/admin/operators/route.ts
//
// 같은 날 대회 2개+ 지원 3단계: 메인 관리자 1명이 대회별 운영자 계정을 만들고
// 담당 대회를 배정한다. 운영자는 대시보드에서 배정된 대회만 보인다(화면 격리).
//
// 보안: 호출자의 Supabase JWT(Authorization: Bearer)를 검증해 user_profiles.role='admin'
//       인 경우에만 처리. 계정 생성/삭제는 service_role의 auth.admin API 사용.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

type AdminCtx = { svc: ReturnType<typeof getServiceClient>; adminId: string }

async function requireAdmin(req: NextRequest): Promise<AdminCtx | { error: NextResponse }> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return { error: NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 }) }
  const svc = getServiceClient()
  const { data, error } = await svc.auth.getUser(token)
  const user = data?.user
  if (error || !user) return { error: NextResponse.json({ error: '세션이 유효하지 않습니다. 다시 로그인하세요.' }, { status: 401 }) }
  const { data: profile } = await svc.from('user_profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') {
    return { error: NextResponse.json({ error: '메인 관리자만 사용할 수 있습니다.' }, { status: 403 }) }
  }
  return { svc, adminId: user.id }
}

// 운영자 목록 (이메일 + 이름 + 배정 대회)
export async function GET(req: NextRequest) {
  try {
    const a = await requireAdmin(req); if ('error' in a) return a.error
    const { svc } = a
    const [profRes, linkRes, usersRes] = await Promise.all([
      svc.from('user_profiles').select('id, role, display_name, created_at').eq('role', 'operator').order('created_at'),
      svc.from('operator_events').select('user_id, event_id'),
      svc.auth.admin.listUsers({ perPage: 1000 }),
    ])
    if (profRes.error) return NextResponse.json({ error: profRes.error.message }, { status: 500 })
    const emailById = new Map((usersRes.data?.users || []).map(u => [u.id, u.email || '']))
    const evByUser = new Map<string, string[]>()
    for (const l of linkRes.data || []) {
      const arr = evByUser.get(l.user_id) || []; arr.push(l.event_id); evByUser.set(l.user_id, arr)
    }
    const operators = (profRes.data || []).map(p => ({
      id: p.id,
      email: emailById.get(p.id) || '',
      display_name: p.display_name || '',
      event_ids: evByUser.get(p.id) || [],
      created_at: p.created_at,
    }))
    return NextResponse.json({ operators })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// 운영자 생성: { email, password, display_name, event_ids[] }
export async function POST(req: NextRequest) {
  try {
    const a = await requireAdmin(req); if ('error' in a) return a.error
    const { svc } = a
    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const display_name = String(body.display_name || '').trim()
    const event_ids: string[] = Array.isArray(body.event_ids) ? body.event_ids.filter(Boolean) : []
    if (!email || !email.includes('@')) return NextResponse.json({ error: '올바른 이메일을 입력하세요.' }, { status: 400 })
    if (password.length < 6) return NextResponse.json({ error: '비밀번호는 6자 이상이어야 합니다.' }, { status: 400 })
    if (!display_name) return NextResponse.json({ error: '운영자 이름을 입력하세요.' }, { status: 400 })

    const { data: created, error: cErr } = await svc.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { display_name },
    })
    if (cErr || !created?.user) {
      return NextResponse.json({ error: '계정 생성 실패: ' + (cErr?.message || '알 수 없는 오류') }, { status: 500 })
    }
    const uid = created.user.id

    // 프로필(역할=operator) — 실패 시 방금 만든 계정 롤백
    const { error: pErr } = await svc.from('user_profiles').insert({ id: uid, role: 'operator', display_name })
    if (pErr) {
      await svc.auth.admin.deleteUser(uid)
      return NextResponse.json({ error: '프로필 생성 실패: ' + pErr.message }, { status: 500 })
    }
    if (event_ids.length) {
      const { error: eErr } = await svc.from('operator_events')
        .insert(event_ids.map(event_id => ({ user_id: uid, event_id })))
      if (eErr) return NextResponse.json({ error: '계정은 생성됐으나 대회 배정 실패: ' + eErr.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, id: uid })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// 운영자 수정: { id, event_ids?, display_name?, password? }
export async function PATCH(req: NextRequest) {
  try {
    const a = await requireAdmin(req); if ('error' in a) return a.error
    const { svc } = a
    const body = await req.json().catch(() => ({}))
    const id = String(body.id || '')
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 })
    const { data: target } = await svc.from('user_profiles').select('role').eq('id', id).single()
    if (!target || target.role !== 'operator') {
      return NextResponse.json({ error: '운영자 계정이 아닙니다.' }, { status: 400 })
    }
    if (typeof body.display_name === 'string' && body.display_name.trim()) {
      const { error } = await svc.from('user_profiles').update({ display_name: body.display_name.trim() }).eq('id', id)
      if (error) return NextResponse.json({ error: '이름 변경 실패: ' + error.message }, { status: 500 })
    }
    if (Array.isArray(body.event_ids)) {
      const ids: string[] = body.event_ids.filter(Boolean)
      const { error: dErr } = await svc.from('operator_events').delete().eq('user_id', id)
      if (dErr) return NextResponse.json({ error: '대회 배정 초기화 실패: ' + dErr.message }, { status: 500 })
      if (ids.length) {
        const { error } = await svc.from('operator_events').insert(ids.map(event_id => ({ user_id: id, event_id })))
        if (error) return NextResponse.json({ error: '대회 배정 실패: ' + error.message }, { status: 500 })
      }
    }
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < 6) return NextResponse.json({ error: '비밀번호는 6자 이상이어야 합니다.' }, { status: 400 })
      const { error } = await svc.auth.admin.updateUserById(id, { password: body.password })
      if (error) return NextResponse.json({ error: '비밀번호 변경 실패: ' + error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// 운영자 삭제: ?id=
export async function DELETE(req: NextRequest) {
  try {
    const a = await requireAdmin(req); if ('error' in a) return a.error
    const { svc, adminId } = a
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 })
    if (id === adminId) return NextResponse.json({ error: '본인 계정은 삭제할 수 없습니다.' }, { status: 400 })
    const { data: target } = await svc.from('user_profiles').select('role').eq('id', id).single()
    if (!target || target.role !== 'operator') {
      return NextResponse.json({ error: '운영자 계정만 삭제할 수 있습니다.' }, { status: 400 })
    }
    await svc.from('operator_events').delete().eq('user_id', id)
    await svc.from('user_profiles').delete().eq('id', id)
    const { error } = await svc.auth.admin.deleteUser(id)
    if (error) return NextResponse.json({ error: '계정 삭제 실패: ' + error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
