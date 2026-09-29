// ============================================================
// 앱A → 앱B 단체전 참가팀 동기화 (pull-team 본체)
// src/lib/team-sync.ts
//
// 10분마다 자동으로도 돌기 때문에 "여러 번 돌아도 안전"이 원칙:
// - 선수는 앱A 선수 ID(member_id)로 맞춰 갱신/추가. 지웠다 다시 넣지 않는다 (선수 ID 보존)
// - 앱A 명단에서 빠진 선수는 라인업·경기에 쓰인 적 없을 때만 삭제
// - 경기방식(3/5복식)은 앱A 조회 성공 시에만 반영, 대전이 이미 있으면 바꾸지 않고 경고
// - 클럽은 신청서 ID(sync_log) → 이름+부서 순으로 찾는다 (같은 이름 신청 2건을 합치지 않음)
// - 부서 매핑 실패는 오류로 보고 (부서 없는 클럽을 만들지 않음)
// - 앱A에서 취소된 신청은 보고만 (삭제는 운영자가)
// - 주장 PIN 은 앱A 기준
// - sync_log 는 신규/변경 때만 기록
//
// 앱A 접근은 AppATeamSource 로 추상화 → 테스트에서 가짜 데이터로 대체 가능
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AppAEntry {
  id: string;
  club_name: string;
  captain_name: string | null;
  captain_pin: string | null;
  captain_member_id?: string | null;
  division_id: string | null;
  division_name: string | null;
  status: string | null;
}

export interface AppAMember {
  member_id: string | null;
  member_name: string;
  gender: string | null;
  grade: string | null;
  member_order: number | null;
}

export interface AppADivision {
  division_id: string;
  division_name: string;
  team_match_type: string | null;
}

type Res<T> = { data: T | null; error?: string | null };

export interface AppATeamSource {
  getEventMatchType(): Promise<Res<{ team_match_type: string | null }>>;
  getDivisions(): Promise<Res<AppADivision[]>>;
  getEntries(): Promise<Res<AppAEntry[]>>;
  getMembers(entryId: string): Promise<Res<AppAMember[]>>;
}

export interface TeamSyncResult {
  success: boolean;
  error?: string;
  synced: number;
  updated: number;
  unchanged: number;
  total: number;
  team_match_type?: string | null;
  rubber_count?: number;
  created_divisions?: string[];
  cancelled?: string[];
  warnings?: string[];
  errors?: string[];
}

const ACTIVE_STATUSES = ['pending', 'confirmed'];

export function rubberCountOf(matchType: string | null | undefined): number {
  return matchType === '5_doubles' ? 5 : 3;
}

function toGender(g: string | null | undefined): 'M' | 'F' | null {
  if (!g) return null;
  if (g === '남' || g.toUpperCase() === 'M' || g.toLowerCase() === 'male') return 'M';
  if (g === '여' || g.toUpperCase() === 'F' || g.toLowerCase() === 'female') return 'F';
  return null;
}

// 앱A 실제 클라이언트 → AppATeamSource
export function appATeamSource(appA: SupabaseClient, appAEventId: string): AppATeamSource {
  return {
    async getEventMatchType() {
      const { data, error } = await appA.from('events').select('team_match_type').eq('event_id', appAEventId).single();
      return { data, error: error?.message };
    },
    async getDivisions() {
      const { data, error } = await appA.from('event_divisions')
        .select('division_id, division_name, team_match_type').eq('event_id', appAEventId);
      return { data, error: error?.message };
    },
    async getEntries() {
      const { data, error } = await appA.from('team_event_entries').select('*').eq('event_id', appAEventId);
      return { data, error: error?.message };
    },
    async getMembers(entryId: string) {
      const { data, error } = await appA.from('team_event_members')
        .select('member_id, member_name, gender, grade, member_order').eq('entry_id', entryId).order('member_order');
      return { data, error: error?.message };
    },
  };
}

// 이 부서(또는 대회)에 대전이 이미 있나 — 경기방식 변경 차단용
async function hasTies(appB: SupabaseClient, eventId: string, divisionId?: string | null): Promise<boolean> {
  let q = appB.from('ties').select('id', { count: 'exact', head: true }).eq('event_id', eventId);
  if (divisionId !== undefined) q = divisionId ? q.eq('division_id', divisionId) : q.is('division_id', null);
  const { count } = await q;
  return (count ?? 0) > 0;
}

export async function syncTeamEntries(
  appB: SupabaseClient,
  src: AppATeamSource,
  eventId: string,
  opts: { autoCreateDivisions?: boolean } = {},
): Promise<TeamSyncResult> {
  const autoCreate = opts.autoCreateDivisions ?? true;
  const warnings: string[] = [];
  const errors: string[] = [];
  const cancelled: string[] = [];
  const createdDivisions: string[] = [];
  let synced = 0, updated = 0, unchanged = 0;

  // ── 1. 대회 기본 경기방식 (조회 성공 시에만) ──
  const { data: ev } = await appB.from('events').select('team_match_type, team_rubber_count').eq('id', eventId).single();
  let eventMatchType: string | null = ev?.team_match_type ?? null;
  const mt = await src.getEventMatchType();
  if (mt.error || !mt.data) {
    warnings.push(`앱A 대회 경기방식 조회 실패 — 기존 값 유지 (${mt.error || '데이터 없음'})`);
  } else if ((mt.data.team_match_type ?? null) !== eventMatchType && mt.data.team_match_type) {
    if (await hasTies(appB, eventId)) {
      warnings.push(`앱A 대회 경기방식이 ${mt.data.team_match_type}(으)로 바뀌었지만 이미 대전이 있어 반영하지 않았습니다.`);
    } else {
      const { error } = await appB.from('events').update({
        team_match_type: mt.data.team_match_type,
        team_rubber_count: rubberCountOf(mt.data.team_match_type),
      }).eq('id', eventId);
      if (error) errors.push(`대회 경기방식 저장 실패: ${error.message}`);
      else eventMatchType = mt.data.team_match_type;
    }
  }

  // ── 2. 부서 (실패하면 매핑이 틀어지므로 중단) ──
  const divRes = await src.getDivisions();
  if (divRes.error) {
    return { success: false, error: '앱A 부서 조회 실패: ' + divRes.error, synced, updated, unchanged, total: 0 };
  }
  const appADivs = divRes.data || [];
  const appADivNameById = new Map(appADivs.map(d => [d.division_id, d.division_name]));

  const { data: bDivsRaw, error: bDivErr } = await appB.from('divisions')
    .select('id, name, team_match_type, sort_order').eq('event_id', eventId);
  if (bDivErr) return { success: false, error: '앱B 부서 조회 실패: ' + bDivErr.message, synced, updated, unchanged, total: 0 };
  const bDivs = (bDivsRaw || []) as { id: string; name: string; team_match_type: string | null; sort_order: number | null }[];
  const bDivByName = new Map(bDivs.map(d => [d.name, d]));

  let nextOrder = bDivs.reduce((m, d) => Math.max(m, d.sort_order ?? 0), 0) + 1;
  for (const ad of appADivs) {
    if (!ad.division_name) continue;
    const existing = bDivByName.get(ad.division_name);
    if (!existing) {
      if (!autoCreate) continue;
      const { data: nd, error } = await appB.from('divisions')
        .insert({ event_id: eventId, name: ad.division_name, sort_order: nextOrder++, team_match_type: ad.team_match_type ?? null })
        .select('id, name, team_match_type, sort_order').single();
      if (error || !nd) { errors.push(`부서 ${ad.division_name} 생성 실패: ${error?.message}`); continue; }
      bDivByName.set(nd.name, nd);
      createdDivisions.push(nd.name);
    } else if ((existing.team_match_type ?? null) !== (ad.team_match_type ?? null)) {
      if (await hasTies(appB, eventId, existing.id)) {
        warnings.push(`${ad.division_name}: 앱A 경기방식이 바뀌었지만 이미 대전이 있어 반영하지 않았습니다.`);
      } else {
        const { error } = await appB.from('divisions').update({ team_match_type: ad.team_match_type ?? null }).eq('id', existing.id);
        if (error) errors.push(`부서 ${ad.division_name} 경기방식 저장 실패: ${error.message}`);
        else existing.team_match_type = ad.team_match_type ?? null;
      }
    }
  }

  // ── 3. 신청서 ──
  const entRes = await src.getEntries();
  if (entRes.error) {
    return { success: false, error: '앱A 데이터 조회 실패: ' + entRes.error, synced, updated, unchanged, total: 0 };
  }
  const entries = entRes.data || [];
  const active = entries.filter(e => ACTIVE_STATUSES.includes(e.status ?? ''));
  const inactive = entries.filter(e => !ACTIVE_STATUSES.includes(e.status ?? ''));

  const { data: clubsRaw } = await appB.from('clubs')
    .select('id, name, division_id, captain_name, captain_pin').eq('event_id', eventId);
  const clubs = (clubsRaw || []) as { id: string; name: string; division_id: string | null; captain_name: string | null; captain_pin: string | null }[];
  // 주장 PIN 은 club_pins 에 보관 (022) — clubs.captain_pin 은 비어 있으므로 비교는 club_pins 기준.
  // 쓰기는 clubs.captain_pin 으로 하면 트리거가 club_pins 로 옮긴다.
  if (clubs.length) {
    const { data: pins } = await appB.from('club_pins').select('club_id, captain_pin').in('club_id', clubs.map(c => c.id));
    const pinMap = new Map((pins || []).map((p: any) => [p.club_id, p.captain_pin]));
    for (const c of clubs) c.captain_pin = pinMap.get(c.id) ?? c.captain_pin ?? null;
  }
  const clubById = new Map(clubs.map(c => [c.id, c]));

  const { data: logs } = await appB.from('sync_log').select('app_a_record_id, app_b_record_id, created_at')
    .eq('event_id', eventId).eq('sync_type', 'team').order('created_at');
  const clubByEntry = new Map<string, string>();
  for (const l of (logs || []) as any[]) {
    if (l.app_b_record_id && clubById.has(l.app_b_record_id)) clubByEntry.set(l.app_a_record_id, l.app_b_record_id);
  }
  const claimed = new Set(clubByEntry.values());

  const divOf = (e: AppAEntry) => {
    const name = e.division_name || (e.division_id ? appADivNameById.get(e.division_id) : null) || null;
    return { name, bId: name ? bDivByName.get(name)?.id ?? null : null };
  };
  const findClub = (e: AppAEntry, bDivId: string | null) => {
    const mapped = clubByEntry.get(e.id);
    if (mapped) return clubById.get(mapped) || null;
    return clubs.find(c => !claimed.has(c.id) && c.name === e.club_name && (c.division_id ?? null) === bDivId) || null;
  };

  for (const entry of active) {
    try {
      const div = divOf(entry);
      if (div.name && !div.bId) {
        errors.push(`${entry.club_name}: 부서 '${div.name}' 매핑 실패 — 앱B에 부서가 없습니다.`);
        continue;
      }

      let club = findClub(entry, div.bId);
      const isNew = !club;
      let changed = false;

      if (!club) {
        // 같은 부서에 같은 이름 클럽은 하나만 가능(DB 제약) — 다른 신청의 클럽과 합치지 않고 보고
        if (clubs.some(c => c.name === entry.club_name && (c.division_id ?? null) === div.bId)) {
          errors.push(`${entry.club_name}${div.name ? ' (' + div.name + ')' : ''}: 같은 부서에 같은 이름의 신청이 2건 이상입니다 — 앱A에서 팀 이름을 구분해 주세요 (예: ○○클럽 1팀/2팀)`);
          continue;
        }
        const { data: nc, error } = await appB.from('clubs').insert({
          event_id: eventId, name: entry.club_name, division_id: div.bId,
          captain_name: entry.captain_name, captain_pin: entry.captain_pin,
        }).select('id, name, division_id, captain_name, captain_pin').single();
        if (error || !nc) { errors.push(`${entry.club_name}: 클럽 생성 실패 — ${error?.message}`); continue; }
        club = { ...nc, captain_pin: entry.captain_pin };
        clubs.push(club); clubById.set(club.id, club);
      } else {
        const patch: Record<string, any> = {};
        if (club.name !== entry.club_name) patch.name = entry.club_name;
        if ((club.division_id ?? null) !== div.bId) patch.division_id = div.bId;
        if ((club.captain_name ?? null) !== (entry.captain_name ?? null)) patch.captain_name = entry.captain_name;
        if ((club.captain_pin ?? null) !== (entry.captain_pin ?? null)) patch.captain_pin = entry.captain_pin; // 앱A 기준
        if (Object.keys(patch).length) {
          const { error } = await appB.from('clubs').update(patch).eq('id', club.id);
          if (error) { errors.push(`${entry.club_name}: 클럽 갱신 실패 — ${error.message}`); continue; }
          Object.assign(club, patch);
          changed = true;
        }
      }
      claimed.add(club!.id);
      clubByEntry.set(entry.id, club!.id);

      const m = await syncMembers(appB, src, entry, club!.id);
      if (m.error) errors.push(`${entry.club_name}: ${m.error}`);
      warnings.push(...m.warnings.map(w => `${entry.club_name}: ${w}`));
      changed = changed || m.changed;

      if (isNew || changed) {
        await appB.from('sync_log').insert({
          event_id: eventId, sync_type: 'team', app_a_record_id: entry.id,
          app_b_record_id: club!.id, app_b_table: 'clubs', status: isNew ? 'synced' : 'updated',
        });
      }
      if (isNew) synced++; else if (changed) updated++; else unchanged++;
    } catch (err: any) {
      errors.push(`${entry.club_name}: ${err.message}`);
    }
  }

  // ── 4. 앱A에서 취소된 신청 — 앱B에 클럽이 남아 있으면 보고만 ──
  for (const entry of inactive) {
    const div = divOf(entry);
    const club = clubByEntry.has(entry.id)
      ? clubById.get(clubByEntry.get(entry.id)!)
      : clubs.find(c => !claimed.has(c.id) && c.name === entry.club_name && (c.division_id ?? null) === div.bId);
    if (club) cancelled.push(`${entry.club_name}${div.name ? ' (' + div.name + ')' : ''}`);
  }

  return {
    success: true,
    synced, updated, unchanged,
    total: active.length,
    team_match_type: eventMatchType,
    rubber_count: rubberCountOf(eventMatchType),
    created_divisions: createdDivisions.length ? createdDivisions : undefined,
    cancelled: cancelled.length ? cancelled : undefined,
    warnings: warnings.length ? warnings : undefined,
    errors: errors.length ? errors : undefined,
  };
}

// 선수 동기화: 앱A 선수 ID → 이름 순으로 기존 행과 맞춰 갱신/추가, 빠진 선수는 안 쓰였을 때만 삭제
async function syncMembers(
  appB: SupabaseClient, src: AppATeamSource, entry: AppAEntry, clubId: string,
): Promise<{ changed: boolean; warnings: string[]; error?: string }> {
  const warnings: string[] = [];
  const res = await src.getMembers(entry.id);
  if (res.error || !res.data) {
    return { changed: false, warnings, error: `선수 명단 조회 실패 — 기존 명단 유지 (${res.error || '데이터 없음'})` };
  }
  const { data: existingRaw, error: exErr } = await appB.from('club_members')
    .select('id, name, gender, grade, is_captain, member_order, app_a_member_id').eq('club_id', clubId);
  if (exErr) return { changed: false, warnings, error: `선수 조회 실패 — ${exErr.message}` };
  const existing = (existingRaw || []) as any[];
  // 앱A가 빈 명단을 돌려주면(권한·일시 오류일 수 있음) 기존 명단을 지우지 않는다
  if (res.data.length === 0 && existing.length > 0) {
    return { changed: false, warnings: ['앱A 명단이 비어 있어 기존 명단을 유지했습니다.'] };
  }
  const matched = new Set<string>();
  const inserts: any[] = [];
  let changed = false;

  for (let i = 0; i < res.data.length; i++) {
    const m = res.data[i];
    const want = {
      name: m.member_name,
      gender: toGender(m.gender),
      grade: m.grade || null,
      is_captain: (!!entry.captain_member_id && m.member_id === entry.captain_member_id) || m.member_name === entry.captain_name,
      member_order: m.member_order || i + 1,
      app_a_member_id: m.member_id || null,
    };
    const row =
      (m.member_id && existing.find(e => !matched.has(e.id) && e.app_a_member_id === m.member_id)) ||
      existing.find(e => !matched.has(e.id) && !e.app_a_member_id && e.name === m.member_name);
    if (!row) { inserts.push({ club_id: clubId, ...want }); continue; }
    matched.add(row.id);
    const patch: Record<string, any> = {};
    for (const k of Object.keys(want) as (keyof typeof want)[]) {
      if ((row[k] ?? null) !== (want[k] ?? null)) patch[k] = want[k];
    }
    if (Object.keys(patch).length) {
      const { error } = await appB.from('club_members').update(patch).eq('id', row.id);
      if (error) return { changed, warnings, error: `선수 ${m.member_name} 갱신 실패 — ${error.message}` };
      changed = true;
    }
  }

  if (inserts.length) {
    const { error } = await appB.from('club_members').insert(inserts);
    if (error) return { changed, warnings, error: `선수 추가 실패 — ${error.message}` };
    changed = true;
  }

  const leftovers = existing.filter(e => !matched.has(e.id));
  if (leftovers.length) {
    const ids = leftovers.map(e => e.id);
    const idList = ids.join(',');
    const [{ data: lu }, { data: ru }] = await Promise.all([
      appB.from('team_lineups').select('player1_id, player2_id').or(`player1_id.in.(${idList}),player2_id.in.(${idList})`),
      appB.from('tie_rubbers').select('club_a_player1_id, club_a_player2_id, club_b_player1_id, club_b_player2_id')
        .or(`club_a_player1_id.in.(${idList}),club_a_player2_id.in.(${idList}),club_b_player1_id.in.(${idList}),club_b_player2_id.in.(${idList})`),
    ]);
    const used = new Set<string>();
    for (const r of [...(lu || []), ...(ru || [])] as any[]) for (const v of Object.values(r)) if (v) used.add(v as string);
    const removable = ids.filter(id => !used.has(id));
    const kept = leftovers.filter(e => used.has(e.id));
    if (removable.length) {
      const { error } = await appB.from('club_members').delete().in('id', removable);
      if (error) return { changed, warnings, error: `빠진 선수 삭제 실패 — ${error.message}` };
      changed = true;
    }
    for (const k of kept) warnings.push(`${k.name} — 앱A 명단에서 빠졌지만 라인업/경기에 쓰여 유지`);
  }

  return { changed, warnings };
}
