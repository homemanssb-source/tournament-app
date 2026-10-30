// src/app/api/notify/court/route.ts
// ✅ urgency: 'high' + TTL: 60
// ✅ tag에 timestamp → 연속 알림 덮어쓰기 방지
// ✅ push_logs 테이블에 발송 결과 저장 (fire-and-forget)
// ✅ 일시적 실패 시 3초 후 1회 자동 재시도
//    [FIX] setTimeout 대신 await sleep → Vercel 서버리스에서 실행 보장
import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase'
import { callerForEvent } from '@/lib/api-auth'
import { findFilledSlotTargets, type SlotMatch, type SlotLog } from '@/lib/slot-filled-notify'
import { pickNextTie, courtNameOf, type NextTieRow } from '@/lib/tie-next'
import { LINEUP_DEADLINE_MIN } from '@/lib/lineup-deadline'

type SubRow = { endpoint: string; p256dh: string; auth: string; team_id: string }

// push_logs에 fire-and-forget으로 저장
function savePushLog(
  supabaseAdmin: ReturnType<typeof getServiceClient>,
  data: Record<string, any>
) {
  Promise.resolve(supabaseAdmin.from('push_logs').insert(data)).catch(() => {})
}

// 단건 발송 헬퍼 — 에러 세부 정보도 함께 반환
type SendResult =
  | { kind: 'ok' }
  | { kind: 'expired'; reason: string }
  | { kind: 'retry'; reason: string }

async function sendOne(
  webpush: any,
  sub: SubRow,
  payload: string,
  pushOptions: object
): Promise<SendResult> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      pushOptions
    )
    return { kind: 'ok' }
  } catch (err: any) {
    const code = err.statusCode || err.status || 0
    const body = (err.body || err.message || '').toString().slice(0, 200)
    const reason = `status=${code} ${body}`
    // 410 Gone, 404 Not Found, 또는 permanently-removed endpoint는 영구 만료
    if (code === 410 || code === 404 || /permanently-removed/.test(sub.endpoint)) {
      return { kind: 'expired', reason }
    }
    return { kind: 'retry', reason }
  }
}

// 대기 헬퍼
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ✅ 본선 빈자리가 채워진 팀에게 알림 (경기 완료 알림 때마다 같은 대회 전체를 확인)
//    규칙은 src/lib/slot-filled-notify.ts 참고. 실패해도 원래 알림 응답에는 영향 없음
async function notifyFilledSlots(
  supabaseAdmin: ReturnType<typeof getServiceClient>,
  webpush: any,
  eventId: string
) {
  const { data: finals } = await supabaseAdmin
    .from('v_matches_with_teams')
    .select('id, court, status, stage, round, match_date, division_name, team_a_id, team_b_id, team_a_name, team_b_name')
    .eq('event_id', eventId).eq('stage', 'FINALS').eq('status', 'PENDING').not('court', 'is', null)
  if (!finals?.length) return

  const { data: logs } = await supabaseAdmin
    .from('push_logs')
    .select('court, division_name, team_a_name, team_b_name')
    .eq('event_id', eventId)
    .in('court', [...new Set((finals as any[]).map(m => m.court))])

  const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const targets = findFilledSlotTargets(finals as SlotMatch[], (logs || []) as SlotLog[], kstToday)

  // 로그가 곧 '이미 보냄' 표시라 반드시 남겨야 함 — trigger 값이 거부되면 'finished' 로 다시 저장
  const insertLog = async (row: Record<string, any>) => {
    const { error } = await supabaseAdmin.from('push_logs').insert(row)
    if (error) await supabaseAdmin.from('push_logs').insert({ ...row, trigger: 'finished' })
  }

  for (const { match: m, teamId } of targets) {
    const logRow = {
      event_id: eventId, court: m.court, trigger: 'slot_filled',
      team_a_name: m.team_a_name, team_b_name: m.team_b_name, division_name: m.division_name,
    }
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions').select('endpoint, p256dh, auth, team_id').eq('team_id', teamId)
    if (!subs?.length) {
      // 구독이 없어도 로그는 남김 — 다음 경기 완료 때 다시 찾지 않도록
      await insertLog({ ...logRow, sent: 0, failed: 0, no_sub: true })
      continue
    }
    const payload = JSON.stringify({
      title: `🎾 ${m.court} - 본선 대진이 확정되었습니다!`,
      body: `${m.team_a_name} vs ${m.team_b_name} (${m.division_name || ''}${m.round ? ' ' + m.round : ''})`,
      icon: '/icon-192x192.png',
      tag: `slot-${m.id}-${Date.now()}`,
      url: '/pin/matches',
      data: { court: m.court, match_id: m.id },
    })
    let sent = 0, failed = 0
    const expired: string[] = []
    const reasons: string[] = []
    await Promise.all((subs as SubRow[]).map(async (sub) => {
      const r = await sendOne(webpush, sub, payload, { urgency: 'high' as const, TTL: 300 })
      if (r.kind === 'ok') sent++
      else { failed++; reasons.push(r.kind + ': ' + r.reason); if (r.kind === 'expired') expired.push(sub.endpoint) }
    }))
    if (expired.length) await supabaseAdmin.from('push_subscriptions').delete().in('endpoint', expired)
    await insertLog({
      ...logRow, sent, failed, no_sub: false,
      error_msg: reasons.length ? reasons.slice(0, 5).join(' | ').slice(0, 500) : null,
    })
  }
}

// ✅ ④ 빈 코트 자동 이어 배정(DB 트리거 026)으로 막 시작된 경기의 두 팀에게 1회 알림
//    matches.auto_notified_at 을 먼저 찍어(선점) 동시에 들어온 요청이 두 번 보내지 않게 함.
//    026 이전 DB(컬럼 없음)면 조회 오류 → 조용히 건너뜀
async function notifyAutoAssigned(
  supabaseAdmin: ReturnType<typeof getServiceClient>,
  webpush: any,
  eventId: string
) {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data: claimed, error } = await supabaseAdmin
    .from('matches')
    .update({ auto_notified_at: new Date().toISOString() })
    .eq('event_id', eventId).eq('status', 'IN_PROGRESS')
    .not('auto_assigned_at', 'is', null).gte('auto_assigned_at', since)
    .is('auto_notified_at', null)
    .select('id')
  if (error || !claimed?.length) return

  const { data: rows } = await supabaseAdmin
    .from('v_matches_with_teams')
    .select('id, court, team_a_id, team_b_id, team_a_name, team_b_name, division_name')
    .in('id', (claimed as any[]).map(r => r.id))

  for (const m of (rows || []) as any[]) {
    const teamIds = [m.team_a_id, m.team_b_id].filter(Boolean)
    const logRow = {
      event_id: eventId, court: m.court, trigger: 'court_changed',
      team_a_name: m.team_a_name, team_b_name: m.team_b_name, division_name: m.division_name,
    }
    const { data: subs } = teamIds.length
      ? await supabaseAdmin.from('push_subscriptions').select('endpoint, p256dh, auth, team_id').in('team_id', teamIds)
      : { data: [] as SubRow[] }
    if (!subs?.length) { savePushLog(supabaseAdmin, { ...logRow, sent: 0, failed: 0, no_sub: true }); continue }
    const payload = JSON.stringify({
      title: `🎾 ${m.court} - 지금 바로 경기하세요!`,
      body: `${m.team_a_name} vs ${m.team_b_name} (${m.division_name || ''}) · 빈 코트 자동 배정`,
      icon: '/icon-192x192.png',
      tag: `auto-${m.id}-${Date.now()}`,
      url: '/pin/matches',
      data: { court: m.court, match_id: m.id },
    })
    let sent = 0, failed = 0
    const expired: string[] = []
    const reasons: string[] = []
    await Promise.all((subs as SubRow[]).map(async (sub) => {
      const r = await sendOne(webpush, sub, payload, { urgency: 'high' as const, TTL: 300 })
      if (r.kind === 'ok') sent++
      else { failed++; reasons.push(r.kind + ': ' + r.reason); if (r.kind === 'expired') expired.push(sub.endpoint) }
    }))
    if (expired.length) await supabaseAdmin.from('push_subscriptions').delete().in('endpoint', expired)
    savePushLog(supabaseAdmin, {
      ...logRow, sent, failed, no_sub: false,
      error_msg: ['auto_assigned', ...reasons.slice(0, 5)].join(' | ').slice(0, 500),
    })
  }
}

// ✅ 단체전 대전 종료 → 같은 코트·같은 날 다음 대전 두 클럽 주장에게 '다음 대전 준비' 1회
//    주장 화면(클럽 PIN — 세션 없음)도 부르므로 인증 대신: 끝난 대전만, 대전마다 1번(push_logs 'after_tie:<id>'),
//    ended_at 이 찍혀 있으면 30분 안만 (지금 점수 RPC 는 ended_at 을 안 찍음)
//    다음 대전 오더가 아직이면 같은 알림에 마감 시각을 넣고 lineup_alerted_at 을 찍어 현황판 자동 오더 알림과 겹치지 않게
async function handleTieFinished(body: any) {
  const svc = getServiceClient()
  const { event_id, finished_tie_id } = body
  if (!event_id || typeof finished_tie_id !== 'string') {
    return NextResponse.json({ error: 'event_id, finished_tie_id 필수' }, { status: 400 })
  }
  const cols = 'id, status, is_bye, court_number, court_order, tie_order, division_id, club_a_id, club_b_id, ended_at, ' +
    'club_a_lineup_submitted, club_b_lineup_submitted, lineup_revealed, lineup_alerted_at, court_assigned_at'
  const { data: fin } = await svc.from('ties').select(cols).eq('id', finished_tie_id).eq('event_id', event_id).maybeSingle()
  const f = fin as any
  if (!f || f.status !== 'completed') return NextResponse.json({ sent: 0, skipped: true, message: '끝난 대전이 아닙니다' })
  if (f.court_number == null) return NextResponse.json({ sent: 0, skipped: true, message: '코트 없는 대전' })
  if (f.ended_at && Date.now() - Date.parse(f.ended_at) > 30 * 60 * 1000) {
    return NextResponse.json({ sent: 0, skipped: true, message: '30분 넘게 지난 대전' })
  }
  const mark = `after_tie:${f.id}`
  const { data: done } = await svc.from('push_logs').select('id').eq('event_id', event_id).like('error_msg', mark + '%').limit(1)
  if (done?.length) return NextResponse.json({ sent: 0, skipped: true, message: '이미 보냈습니다' })

  const [{ data: ties }, { data: divs }, { data: venues }] = await Promise.all([
    svc.from('ties').select(cols).eq('event_id', event_id).eq('court_number', f.court_number),
    svc.from('divisions').select('id, name, match_date').eq('event_id', event_id),
    svc.from('venues').select('name, short_name, court_count, courts').eq('event_id', event_id).order('created_at'),
  ])
  const divDates: Record<string, string | null> = {}, divNames: Record<string, string> = {}
  for (const d of (divs || []) as any[]) { divDates[d.id] = d.match_date; divNames[d.id] = d.name }
  const court = courtNameOf(f.court_number, (venues || []) as any[])
  const next = pickNextTie((ties || []) as unknown as NextTieRow[], f as NextTieRow, divDates) as any
  const logRow: Record<string, any> = { event_id, court, trigger: 'finished' }
  if (!next) {
    await svc.from('push_logs').insert({ ...logRow, sent: 0, failed: 0, no_sub: true, error_msg: `${mark} | 다음 대전 없음` })
    return NextResponse.json({ sent: 0, message: '대기 중인 대전이 없습니다' })
  }

  const clubIds = [next.club_a_id, next.club_b_id].filter(Boolean) as string[]
  const [{ data: clubs }, { data: subs }] = await Promise.all([
    svc.from('clubs').select('id, name').in('id', clubIds),
    svc.from('push_subscriptions').select('endpoint, p256dh, auth, team_id').in('team_id', clubIds),
  ])
  const nameOf = (id: string | null) => (clubs || []).find((c: any) => c.id === id)?.name || 'TBD'
  const divisionName = (next.division_id && divNames[next.division_id]) || '단체전'
  Object.assign(logRow, { team_a_name: nameOf(next.club_a_id), team_b_name: nameOf(next.club_b_id), division_name: divisionName })

  // 오더 미제출 쪽 → 마감(끝난 시각·배정 시각 중 늦은 쪽 + 10분) 안내, 현황판 자동 알림 선점
  const missing = new Set((['a', 'b'] as const).filter(s => !next.lineup_revealed && !next[`club_${s}_lineup_submitted`])
    .map(s => next[`club_${s}_id`]).filter(Boolean))
  let until = ''
  if (missing.size > 0) {
    const base = Math.max(f.ended_at ? Date.parse(f.ended_at) : Date.now(), next.court_assigned_at ? Date.parse(next.court_assigned_at) : 0)
    until = new Date(base + LINEUP_DEADLINE_MIN * 60000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })
    await svc.from('ties').update({ lineup_alerted_at: new Date().toISOString() }).eq('id', next.id).is('lineup_alerted_at', null)
  }

  if (!subs?.length) {
    await svc.from('push_logs').insert({ ...logRow, sent: 0, failed: 0, no_sub: true, error_msg: mark })
    return NextResponse.json({ sent: 0, message: '구독자가 없습니다', next_tie_id: next.id })
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return NextResponse.json({ sent: 0, message: 'VAPID not configured' })
  }
  const webpush = (await import('web-push')).default
  webpush.setVapidDetails('mailto:admin@jeju-tournament.com', process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)

  let sent = 0, failed = 0
  const expired: string[] = []
  const reasons: string[] = []
  await Promise.all((subs as SubRow[]).map(async (sub) => {
    const payload = JSON.stringify({
      title: `🎾 ${court} - 다음 대전 준비하세요!`,
      body: `${nameOf(next.club_a_id)} vs ${nameOf(next.club_b_id)} (${divisionName} #${next.tie_order ?? ''})`
        + (missing.has(sub.team_id) ? ` · ${until}까지 오더 제출` : ''),
      icon: '/icon-192x192.png',
      tag: `tie-next-${next.id}-${Date.now()}`,
      url: `/lineup/${next.id}`,
      data: { court, tie_id: next.id },
    })
    const r = await sendOne(webpush, sub, payload, { urgency: 'high' as const, TTL: 300 })
    if (r.kind === 'ok') sent++
    else { failed++; reasons.push(r.kind + ': ' + r.reason); if (r.kind === 'expired') expired.push(sub.endpoint) }
  }))
  if (expired.length) await svc.from('push_subscriptions').delete().in('endpoint', expired)
  await svc.from('push_logs').insert({ ...logRow, sent, failed, no_sub: false, error_msg: [mark, ...reasons.slice(0, 5)].join(' | ').slice(0, 500) })
  return NextResponse.json({ sent, failed, next_tie_id: next.id })
}

export async function POST(req: NextRequest) {
  const peek = await req.clone().json().catch(() => null)
  if (peek?.finished_tie_id) {
    try { return await handleTieFinished(peek) }
    catch (e: any) { console.error('[notify/court] tie_finished', e); return NextResponse.json({ error: e.message }, { status: 500 }) }
  }
  const after: { eventId?: string; webpush?: any } = {}
  const res = await handleCourtNotify(req, after)
  if (after.eventId && after.webpush) {
    try { await notifyFilledSlots(getServiceClient(), after.webpush, after.eventId) }
    catch (e) { console.error('[notify/court] slot_filled', e) }
    try { await notifyAutoAssigned(getServiceClient(), after.webpush, after.eventId) }
    catch (e) { console.error('[notify/court] auto_assigned', e) }
  }
  return res
}

async function handleCourtNotify(req: NextRequest, after: { eventId?: string; webpush?: any }) {
  let logData: Record<string, any> = {}
  let supabaseAdmin: ReturnType<typeof getServiceClient> | null = null

  try {
    supabaseAdmin = getServiceClient()

    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ sent: 0, message: 'VAPID not configured' })
    }

    const webpush = (await import('web-push')).default
    webpush.setVapidDetails(
      'mailto:admin@jeju-tournament.com',
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )

    const body = await req.json()
    const { event_id, court, match_id, finished_match_id, match_date, trigger } = body

    // slot_check: 결과 수정·수동 순위 확정처럼 "다음 경기 준비" 알림은 필요 없고
    //             본선 빈자리 채움 알림만 확인할 때 (코트 없이 호출 가능)
    if (!event_id || (!court && trigger !== 'slot_check')) {
      return NextResponse.json({ error: 'event_id, court 필수' }, { status: 400 })
    }

    // 호출자 확인: 운영자 로그인 / 그 대회 경기장 세션(venue_token) / 선수 세션(pin_token) / 관리자 PIN(admin_pin_token)
    // (그동안 인증 없이 누구나 구독자 전원에게 알림을 보낼 수 있었음)
    if (!(await callerForEvent(req, body, event_id, supabaseAdmin))) {
      return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })
    }

    if (trigger === 'slot_check') {
      after.eventId = event_id; after.webpush = webpush
      return NextResponse.json({ ok: true })
    }

    logData = { event_id, court, trigger: trigger || 'manual' }
    if (trigger === 'finished') { after.eventId = event_id; after.webpush = webpush }

    const lastPart = court.split('-').pop() || ''
    const courtNum = /^\d+$/.test(lastPart)
      ? parseInt(lastPart, 10)
      : parseInt(court.replace(/[^0-9]/g, ''), 10) || 0

    let teamAId: string | null = null
    let teamBId: string | null = null
    let teamAName = ''
    let teamBName = ''
    let divisionName = ''
    let targetId = ''
    let targetDate: string | null = null   // 대상 경기의 경기일 (대회 전 보류 판단용)

    if (finished_match_id) {
      const { data: finishedMatch } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('court, court_order, match_date')
        .eq('id', finished_match_id)
        .single()

      if (finishedMatch) {
        let q = supabaseAdmin
          .from('v_matches_with_teams')
          .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status, score, court_order, match_date')
          .eq('event_id', event_id)
          .eq('court', finishedMatch.court || court)
          .order('court_order')

        if (finishedMatch.match_date) q = q.eq('match_date', finishedMatch.match_date)

        const { data: courtMatches } = await q
        const filtered = (courtMatches || []).filter((m: any) => m.score !== 'BYE')
        const finishedIdx = filtered.findIndex((m: any) => m.id === finished_match_id)
        const target = finishedIdx >= 0
          ? filtered.slice(finishedIdx + 1).find((m: any) => m.status === 'PENDING')
          : undefined

        if (target) {
          teamAId = target.team_a_id; teamBId = target.team_b_id
          teamAName = target.team_a_name; teamBName = target.team_b_name
          divisionName = target.division_name; targetId = target.id
          targetDate = target.match_date ?? null
        }
      }
    } else if (match_id) {
      const { data } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, match_date')
        .eq('id', match_id).single()
      if (data) {
        teamAId = data.team_a_id; teamBId = data.team_b_id
        teamAName = data.team_a_name; teamBName = data.team_b_name
        divisionName = data.division_name; targetId = data.id
        targetDate = data.match_date ?? null
      }
    } else {
      // ✅ 단체전 ties: 코트 + 날짜 필터링 (어제 못 끝낸 tie를 잘못 잡지 않게)
      // FK 조인이 PostgREST 캐시에서 못 찾아서 divisions 별도 조회로 우회
      const { data: tieList } = await supabaseAdmin
        .from('ties')
        .select('id, club_a_id, club_b_id, status, tie_order, court_order, division_id')
        .eq('event_id', event_id).eq('court_number', courtNum)
        .neq('status', 'completed').order('court_order').order('tie_order')

      if (tieList && tieList.length > 0) {
        // divisions 별도 조회 → division_id → {name, match_date} 매핑
        const divIds = [...new Set((tieList as any[]).map((t: any) => t.division_id).filter(Boolean))]
        const divMap: Record<string, { name: string; match_date: string | null }> = {}
        if (divIds.length > 0) {
          const { data: divs } = await supabaseAdmin
            .from('divisions').select('id, name, match_date').in('id', divIds)
          for (const d of (divs || [])) divMap[(d as any).id] = { name: (d as any).name, match_date: (d as any).match_date }
        }

        // "오늘 날짜" 결정: 입력 match_date > in_progress tie의 match_date > KST 오늘
        const liveTie = (tieList as any[]).find((t: any) => t.status === 'in_progress')
        const liveMatchDate = liveTie ? divMap[liveTie.division_id]?.match_date : null
        const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
        const todayDate = match_date || liveMatchDate || kstToday

        // 날짜 필터: 같은 match_date의 ties 우선. 비어있으면 전체 사용
        const sameDateTies = (tieList as any[]).filter((t: any) => {
          const d = divMap[t.division_id]
          return d?.match_date === todayDate || !d?.match_date
        })
        const candidates = sameDateTies.length > 0 ? sameDateTies : tieList

        // 다음 진행 대상: 진행 중이 아닌 첫 대전 (진행 중인 팀은 이미 코트에 있음 —
        //   예전엔 진행 중 대전을 골라, 그 뒤에 새로 배정된 대전 팀은 알림을 못 받았음)
        const activeTie: any = (candidates as any[]).find((t: any) => t.status !== 'in_progress')
        if (activeTie) {
          teamAId = activeTie.club_a_id; teamBId = activeTie.club_b_id
          targetId = activeTie.id
          divisionName = divMap[activeTie.division_id]?.name || '단체전'
          targetDate = divMap[activeTie.division_id]?.match_date ?? null
          const [{ data: clubA }, { data: clubB }] = await Promise.all([
            supabaseAdmin.from('clubs').select('name').eq('id', activeTie.club_a_id).single(),
            supabaseAdmin.from('clubs').select('name').eq('id', activeTie.club_b_id).single(),
          ])
          teamAName = clubA?.name || ''; teamBName = clubB?.name || ''
        }
      }
    }

    // ✅ 공통 폴백: 위 브랜치에서 대상을 못 찾았으면 코트 큐에서 직접 탐색
    //    (기존에는 ties 브랜치 전용이라 finished_match_id 조회가 꼬이면
    //     대기팀이 있어도 알림이 조용히 누락됐음)
    //    단, match_id를 명시한 운영자 수동 발송은 폴백하지 않음 — 다른 경기에 오발송 방지
    if (!teamAId && !teamBId && !match_id) {
      const { data: allCourtMatches } = await supabaseAdmin
        .from('v_matches_with_teams')
        .select('id, team_a_id, team_b_id, team_a_name, team_b_name, division_name, status, score, match_date')
        .eq('event_id', event_id).eq('court', court).order('court_order')

      const allFiltered = (allCourtMatches || []).filter((m: any) => m.score !== 'BYE')
      const liveMatch = allFiltered.find((m: any) => m.status === 'IN_PROGRESS')
      const todayDate = liveMatch?.match_date || match_date || null
      const courtMatches = todayDate
        ? allFiltered.filter((m: any) => m.match_date === todayDate)
        : allFiltered

      if (courtMatches.length > 0) {
        const activeIdx = courtMatches.findIndex((m: any) => m.status === 'IN_PROGRESS')
        const searchFrom = activeIdx >= 0 ? activeIdx + 1 : 0
        const target = courtMatches.slice(searchFrom).find((m: any) => m.status === 'PENDING')
          ?? courtMatches.find((m: any) => m.status === 'PENDING')
        if (target) {
          teamAId = target.team_a_id; teamBId = target.team_b_id
          teamAName = target.team_a_name; teamBName = target.team_b_name
          divisionName = target.division_name; targetId = target.id
          targetDate = target.match_date ?? null
        }
      }
    }

    logData = { ...logData, team_a_name: teamAName, team_b_name: teamBName, division_name: divisionName }

    // ✅ 대회 전 코트 변경은 선수에게 보내지 않음 (H.B컵: 9/17·18 코트 배정 중 실제 알림이 나감)
    //    기준일 = 대상 경기의 경기일, 없으면 대회일. 운영자가 누르는 '수동' 알림은 그대로 발송
    if (trigger === 'court_changed' && (teamAId || teamBId)) {
      let playDate = targetDate
      if (!playDate) {
        const { data: ev } = await supabaseAdmin.from('events').select('date').eq('id', event_id).single()
        playDate = (ev as any)?.date ?? null
      }
      const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (playDate && playDate > kstToday) {
        savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: false, error_msg: `skipped: 경기일(${playDate}) 전 코트 변경 — 발송 안 함` })
        return NextResponse.json({ sent: 0, skipped: true, message: `경기일(${playDate}) 전이라 알림을 보내지 않았습니다` })
      }
    }

    if (!teamAId && !teamBId) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: true })
      return NextResponse.json({ sent: 0, message: '대기 중인 경기가 없습니다' })
    }

    const teamIds = [teamAId, teamBId].filter(Boolean) as string[]
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth, team_id')
      .in('team_id', teamIds)

    if (subError) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: false, error_msg: subError.message })
      return NextResponse.json({ error: subError.message }, { status: 500 })
    }

    if (!subscriptions?.length) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: true })
      return NextResponse.json({ sent: 0, message: '구독자가 없습니다', teams: { a: teamAName, b: teamBName } })
    }

    const triggerLabel = trigger === 'court_changed' ? '코트가 변경되었습니다!' : '경기 준비하세요!'
    const payload = JSON.stringify({
      title: `🎾 ${court} - ${triggerLabel}`,
      body: `${teamAName} vs ${teamBName} (${divisionName})`,
      icon: '/icon-192x192.png',
      tag: `court-${court}-${Date.now()}`,
      url: '/pin/matches',
      data: { court, match_id: targetId },
    })

    // ✅ TTL 60 → 300초: 잠깐 전파가 끊긴 기기(코트 주변 수신 불량 등)도
    //    5분 안에 복구되면 알림을 받을 수 있게. '코트 이동' 알림은 5분간 유효함
    const pushOptions = { urgency: 'high' as const, TTL: 300 }

    let sent = 0
    let failed = 0
    const expiredEndpoints: string[] = []
    const retryTargets: SubRow[] = []
    const failReasons: string[] = []

    // ── 1차 발송 ──────────────────────────────────────────────
    await Promise.all(
      (subscriptions as SubRow[]).map(async (sub) => {
        const result = await sendOne(webpush, sub, payload, pushOptions)
        if (result.kind === 'ok')            { sent++ }
        else if (result.kind === 'expired')  { failed++; expiredEndpoints.push(sub.endpoint); failReasons.push('expired: ' + result.reason) }
        else                                  { retryTargets.push(sub) }
      })
    )

    // 만료 구독 삭제 (fire-and-forget)
    if (expiredEndpoints.length > 0) {
      Promise.resolve(
        supabaseAdmin.from('push_subscriptions').delete().in('endpoint', expiredEndpoints)
      ).catch(() => {})
    }

    // ── 2차 발송: 재시도 대상 있으면 3초 대기 후 재시도 ────────
    if (retryTargets.length > 0) {
      await sleep(3000)
      await Promise.all(
        retryTargets.map(async (sub) => {
          const result = await sendOne(webpush, sub, payload, pushOptions)
          if (result.kind === 'ok')            { sent++ }
          else if (result.kind === 'expired')  { failed++; expiredEndpoints.push(sub.endpoint); failReasons.push('expired-retry: ' + result.reason) }
          else                                  { failed++; failReasons.push('retry-failed: ' + result.reason) }
        })
      )
    }

    // 최종 결과 로그 저장 (fire-and-forget) — 실패 원인도 포함
    const errorMsg = failReasons.length > 0 ? failReasons.slice(0, 5).join(' | ').slice(0, 500) : null
    savePushLog(supabaseAdmin, { ...logData, sent, failed, no_sub: false, error_msg: errorMsg })

    return NextResponse.json({
      sent,
      retried: retryTargets.length,
      failed,
      match: { court, team_a: teamAName, team_b: teamBName },
    })

  } catch (err: any) {
    console.error('[notify/court]', err)
    if (supabaseAdmin) {
      savePushLog(supabaseAdmin, { ...logData, sent: 0, failed: 0, no_sub: false, error_msg: err.message })
    }
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
