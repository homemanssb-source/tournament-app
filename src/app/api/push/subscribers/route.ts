// src/app/api/push/subscribers/route.ts
// 운영자용: 현재 이벤트의 구독자 현황
// - 개인전: teams + subscription 여부
// - 단체전: clubs(+부서) + subscription 여부
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const eventId = req.nextUrl.searchParams.get('event_id')
    if (!eventId) return NextResponse.json({ error: 'event_id 필수' }, { status: 400 })

    const supabase = getServiceClient()

    // 해당 event의 모든 teams + clubs + subscriptions 조회
    const [teamsRes, clubsRes, divsRes] = await Promise.all([
      supabase.from('teams').select('id, team_name, team_num, division_name, pin_plain, checked_in')
        .eq('event_id', eventId).order('division_name').order('team_num'),
      supabase.from('clubs').select('id, name, captain_name, captain_pin, division_id')
        .eq('event_id', eventId).order('name'),
      supabase.from('divisions').select('id, name').eq('event_id', eventId),
    ])

    const divMap: Record<string, string> = {}
    for (const d of (divsRes.data || []) as any[]) divMap[d.id] = d.name

    const teamIds = (teamsRes.data || []).map((t: any) => t.id)
    const clubIds = (clubsRes.data || []).map((c: any) => c.id)
    const allIds = [...teamIds, ...clubIds]

    const { data: subs } = allIds.length > 0
      ? await supabase.from('push_subscriptions').select('team_id, endpoint, created_at').in('team_id', allIds)
      : { data: [] as any[] }

    const subMap = new Map<string, { count: number; firstAt: string; lastAt: string }>()
    for (const s of (subs || []) as any[]) {
      const cur = subMap.get(s.team_id)
      if (!cur) subMap.set(s.team_id, { count: 1, firstAt: s.created_at, lastAt: s.created_at })
      else {
        cur.count += 1
        if (s.created_at < cur.firstAt) cur.firstAt = s.created_at
        if (s.created_at > cur.lastAt) cur.lastAt = s.created_at
      }
    }

    const teams = (teamsRes.data || []).map((t: any) => ({
      kind: 'individual' as const,
      id: t.id,
      label: t.team_name,
      sub_label: `#${t.team_num} · ${t.division_name || ''}`,
      pin: t.pin_plain,
      checked_in: t.checked_in || false,
      subscribed: subMap.has(t.id),
      sub_count: subMap.get(t.id)?.count || 0,
      last_subscribed_at: subMap.get(t.id)?.lastAt || null,
    }))

    const clubs = (clubsRes.data || []).map((c: any) => ({
      kind: 'team' as const,
      id: c.id,
      label: c.name,
      sub_label: `${divMap[c.division_id] || '부서 미지정'} · 캡틴 ${c.captain_name || '-'}`,
      pin: c.captain_pin,
      checked_in: false,
      subscribed: subMap.has(c.id),
      sub_count: subMap.get(c.id)?.count || 0,
      last_subscribed_at: subMap.get(c.id)?.lastAt || null,
    }))

    const allRows = [...teams, ...clubs]
    const stats = {
      total: allRows.length,
      subscribed: allRows.filter(r => r.subscribed).length,
      unsubscribed: allRows.filter(r => !r.subscribed).length,
      individual_total: teams.length,
      individual_subscribed: teams.filter(r => r.subscribed).length,
      team_total: clubs.length,
      team_subscribed: clubs.filter(r => r.subscribed).length,
    }

    return NextResponse.json({ rows: allRows, stats })
  } catch (e: any) {
    console.error('[push/subscribers]', e)
    return NextResponse.json({ error: e.message || '서버 오류' }, { status: 500 })
  }
}
