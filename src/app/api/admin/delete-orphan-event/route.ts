// ============================================================
// 앱A에서 삭제된 대회(앱B에만 남은 대회) 삭제 API (메인 관리자 전용)
// src/app/api/admin/delete-orphan-event/route.ts
//
// 앱A에서 대회를 지우고 다시 만들면 앱B에 예전 대회가 남아 회원 화면에 계속 보인다.
// 안전장치:
//   1) user_profiles.role = 'admin' 만
//   2) 앱A에 그 대회가 정말 없을 때만 (조회 오류·빈 결과면 거부 — 잘못 판단해 지우지 않도록)
//   3) 참가·경기·설정 기록이 하나라도 있으면 거부 — 빈 부서만 있는 대회만 지운다
//   4) 화면에서 대회 이름을 그대로 입력해야 함 (confirm_name)
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'
import { operatorFromRequest } from '@/lib/api-auth'
import { getAppAClient } from '@/lib/app-a-server'

// 이 표에 대회 기록이 있으면 삭제하지 않는다
const BLOCKING_TABLES: [string, string][] = [
  ['teams', '팀'], ['clubs', '클럽'], ['groups', '조'], ['matches', '경기'],
  ['ties', '대전'], ['bracket_nodes', '대진표'], ['team_standings', '순위'],
  ['venues', '경기장'], ['operator_events', '운영자 배정'], ['sync_log', '동기화 기록'],
]

export async function POST(req: NextRequest) {
  try {
    const svc = getServiceClient()
    const op = await operatorFromRequest(req, svc)
    if (!op) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })
    if (op.role !== 'admin') return NextResponse.json({ error: '메인 관리자만 사용할 수 있습니다.' }, { status: 403 })

    const body = await req.json().catch(() => ({}))
    const eventId = typeof body?.event_id === 'string' ? body.event_id : ''
    const confirmName = typeof body?.confirm_name === 'string' ? body.confirm_name : ''
    if (!eventId) return NextResponse.json({ error: 'event_id 가 필요합니다.' }, { status: 400 })

    const { data: ev, error: evErr } = await svc.from('events').select('id, name, app_a_event_id').eq('id', eventId).maybeSingle()
    if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 })
    if (!ev) return NextResponse.json({ error: '대회를 찾을 수 없습니다.' }, { status: 404 })
    if (confirmName !== ev.name) return NextResponse.json({ error: '대회 이름이 일치하지 않습니다.' }, { status: 400 })
    if (!ev.app_a_event_id) return NextResponse.json({ error: '앱A와 연결된 대회가 아니라 삭제할 수 없습니다.' }, { status: 400 })

    // 앱A에 정말 없는지 — 조회가 실패하거나 앱A 대회가 하나도 안 보이면(키 권한 문제 등) 판단 보류
    const appA = getAppAClient()
    const [{ data: still, error: aErr }, { count: aTotal, error: aCntErr }] = await Promise.all([
      appA.from('events').select('event_id').eq('event_id', ev.app_a_event_id).maybeSingle(),
      appA.from('events').select('event_id', { count: 'exact', head: true }),
    ])
    if (aErr || aCntErr) return NextResponse.json({ error: '앱A 조회 실패: ' + (aErr || aCntErr)!.message }, { status: 502 })
    if (still) return NextResponse.json({ error: '앱A에 아직 있는 대회입니다. 삭제하지 않았습니다.' }, { status: 409 })
    if (!aTotal) return NextResponse.json({ error: '앱A 대회 목록이 비어 있어 확인할 수 없습니다. 삭제하지 않았습니다.' }, { status: 409 })

    // 기록이 남아 있으면 거부
    const counts = await Promise.all(BLOCKING_TABLES.map(async ([t, label]) => {
      const { count, error } = await svc.from(t).select('*', { count: 'exact', head: true }).eq('event_id', eventId)
      if (error) throw new Error(`${label} 확인 실패: ${error.message}`)
      return [label, count ?? 0] as const
    }))
    const blocking = counts.filter(([, c]) => c > 0).map(([label, c]) => `${label} ${c}건`)
    if (blocking.length > 0) {
      return NextResponse.json({ error: `기록이 있어 삭제할 수 없습니다: ${blocking.join(', ')}` }, { status: 409 })
    }

    const { data: delDivs, error: dErr } = await svc.from('divisions').delete().eq('event_id', eventId).select('id')
    if (dErr) return NextResponse.json({ error: '부서 삭제 실패: ' + dErr.message }, { status: 500 })
    const { error: eErr } = await svc.from('events').delete().eq('id', eventId)
    if (eErr) return NextResponse.json({ error: '대회 삭제 실패: ' + eErr.message }, { status: 500 })

    return NextResponse.json({ success: true, name: ev.name, divisions: delDivs?.length ?? 0 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
