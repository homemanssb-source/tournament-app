// src/app/api/notify/lineup/route.ts
// 단체전 오더 미제출 → 주장에게 푸시 (039)
//   mode 'manual': 운영자가 현황판 🔔 버튼 — 지정한 쪽(side) 클럽 주장에게
//   mode 'turn'  : 차례가 된 대전 — 현황판이 자동 호출. ties.lineup_alerted_at 을 먼저 찍은(선점) 1곳만 발송,
//                  아직 안 낸 쪽 주장 모두에게. 코트가 바뀌면 DB 트리거가 표시를 지워 다시 보낼 수 있음
// 호출자: 운영자 로그인(Authorization) 또는 그 대회 관리자 PIN 세션(admin_pin_token)
// 주장 구독은 push_subscriptions.team_id = club_id (/api/push/subscribe 단체전 모드)
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'
import { callerForEvent } from '@/lib/api-auth'

type SubRow = { endpoint: string; p256dh: string; auth: string; team_id: string }

export async function POST(req: NextRequest) {
  try {
    const svc = getServiceClient()
    const body = await req.json()
    const { event_id, tie_id, side, mode, court, deadline_at } = body as {
      event_id?: string; tie_id?: string; side?: 'a' | 'b'; mode?: 'manual' | 'turn'; court?: string; deadline_at?: string | null
    }
    if (!event_id || !tie_id || (mode !== 'manual' && mode !== 'turn') || (mode === 'manual' && side !== 'a' && side !== 'b')) {
      return NextResponse.json({ error: 'event_id, tie_id, mode(manual|turn), side(manual) 필수' }, { status: 400 })
    }
    const caller = await callerForEvent(req, body, event_id, svc)
    if (caller !== 'operator' && caller !== 'admin_pin') {
      return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })
    }

    const { data: tie } = await svc.from('ties')
      .select('id, event_id, division_id, tie_order, club_a_id, club_b_id, club_a_lineup_submitted, club_b_lineup_submitted, lineup_revealed, status')
      .eq('id', tie_id).eq('event_id', event_id).maybeSingle()
    if (!tie) return NextResponse.json({ error: '대전을 찾을 수 없습니다.' }, { status: 404 })
    const t = tie as any
    if (t.lineup_revealed || t.status === 'completed') {
      return NextResponse.json({ sent: 0, skipped: true, message: '이미 오더가 공개된 대전입니다.' })
    }

    let sides: ('a' | 'b')[]
    if (mode === 'turn') {
      // 선점: 아직 안 보낸 경우에만 찍힘 → 동시에 들어온 다른 화면은 빈 결과
      const { data: claimed, error } = await svc.from('ties')
        .update({ lineup_alerted_at: new Date().toISOString() })
        .eq('id', tie_id).is('lineup_alerted_at', null).select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!claimed?.length) return NextResponse.json({ sent: 0, skipped: true, message: '이미 자동 알림을 보냈습니다.' })
      sides = (['a', 'b'] as const).filter(s => !t[`club_${s}_lineup_submitted`])
    } else {
      sides = [side!]
    }

    const clubIds = sides.map(s => t[`club_${s}_id`]).filter(Boolean) as string[]
    const [{ data: clubs }, { data: div }, { data: subs }] = await Promise.all([
      svc.from('clubs').select('id, name').in('id', [t.club_a_id, t.club_b_id].filter(Boolean)),
      t.division_id ? svc.from('divisions').select('name').eq('id', t.division_id).maybeSingle() : Promise.resolve({ data: null }),
      clubIds.length
        ? svc.from('push_subscriptions').select('endpoint, p256dh, auth, team_id').in('team_id', clubIds)
        : Promise.resolve({ data: [] as SubRow[] }),
    ])
    const nameOf = (id: string | null) => (clubs || []).find((c: any) => c.id === id)?.name || ''
    const divisionName = (div as any)?.name || '단체전'
    const until = deadline_at
      ? new Date(deadline_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }) + '까지 '
      : ''

    const logRow = {
      event_id, court: court || null, trigger: 'lineup',
      team_a_name: nameOf(t.club_a_id), team_b_name: nameOf(t.club_b_id), division_name: divisionName,
    }
    // push_logs.trigger 값 제한이 있을 수 있어 거부되면 'manual' 로 다시 저장 (notify/court 와 같은 방식)
    const saveLog = async (row: Record<string, any>) => {
      const { error } = await svc.from('push_logs').insert(row)
      if (error) await svc.from('push_logs').insert({ ...row, trigger: 'manual', error_msg: ['lineup', row.error_msg].filter(Boolean).join(' | ') })
    }

    const noSub = clubIds.filter(id => !(subs || []).some((s: any) => s.team_id === id)).map(nameOf)
    if (!subs?.length) {
      await saveLog({ ...logRow, sent: 0, failed: 0, no_sub: true, error_msg: `${mode}` })
      return NextResponse.json({ sent: 0, no_sub: noSub, message: '알림을 구독한 주장이 없습니다.' })
    }
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ sent: 0, message: 'VAPID not configured' })
    }
    const webpush = (await import('web-push')).default
    webpush.setVapidDetails('mailto:admin@jeju-tournament.com', process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)

    let sent = 0, failed = 0
    const expired: string[] = []
    const reasons: string[] = []
    await Promise.all((subs as SubRow[]).map(async sub => {
      const mine = sub.team_id
      const opponent = mine === t.club_a_id ? t.club_b_id : t.club_a_id
      const payload = JSON.stringify({
        title: `📋 ${court ? court + ' - ' : ''}오더를 제출해 주세요`,
        body: `${nameOf(mine)} vs ${nameOf(opponent)} (${divisionName} #${t.tie_order ?? ''}) · ${until}주장 오더 제출`,
        icon: '/icon-192x192.png',
        tag: `lineup-${tie_id}-${Date.now()}`,
        url: `/lineup/${tie_id}`,
        data: { tie_id },
      })
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { urgency: 'high', TTL: 600 })
        sent++
      } catch (err: any) {
        failed++
        const code = err.statusCode || err.status || 0
        reasons.push(`status=${code} ${(err.body || err.message || '').toString().slice(0, 100)}`)
        if (code === 410 || code === 404) expired.push(sub.endpoint)
      }
    }))
    if (expired.length) await svc.from('push_subscriptions').delete().in('endpoint', expired)
    await saveLog({ ...logRow, sent, failed, no_sub: false, error_msg: [mode, ...reasons.slice(0, 5)].join(' | ').slice(0, 500) })

    return NextResponse.json({ sent, failed, no_sub: noSub })
  } catch (err: any) {
    console.error('[notify/lineup]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
