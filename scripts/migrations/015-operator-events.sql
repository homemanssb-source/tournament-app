-- ============================================================
-- 015: 운영자 계정 계층 (같은 날 대회 2개+ 지원 3단계)
-- 메인 관리자(user_profiles.role='admin')는 전체 대회, 운영자('operator')는
-- operator_events에 배정된 대회만 대시보드에 보인다 (화면 격리).
--
-- 적용: Supabase SQL Editor에서 그대로 실행 (멱등 — 여러 번 실행해도 안전)
-- ============================================================

-- 운영자 ↔ 대회 배정
create table if not exists operator_events (
  user_id    uuid not null references auth.users(id) on delete cascade,
  event_id   uuid not null references events(id)     on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, event_id)
);

alter table operator_events enable row level security;

-- 본인 배정만 조회 가능 (메인 관리자는 전체). 쓰기는 service_role API 라우트에서만.
drop policy if exists own_or_admin_select on operator_events;
create policy own_or_admin_select on operator_events
  for select using (user_id = auth.uid() or is_admin());

-- 내 권한 조회: { role, event_ids[] } — 클라이언트(대시보드 레이아웃)가 호출.
-- SECURITY DEFINER라 user_profiles RLS와 무관하게 auth.uid() 기준으로만 답함(스푸핑 불가).
create or replace function rpc_my_access()
returns jsonb
language sql stable security definer
as $$
  select jsonb_build_object(
    'role',      (select role::text from user_profiles where id = auth.uid()),
    'event_ids', coalesce((select jsonb_agg(event_id) from operator_events where user_id = auth.uid()), '[]'::jsonb)
  );
$$;

grant execute on function rpc_my_access() to authenticated, anon;

-- 확인
select 'policy'        as obj, count(*)::text as n from pg_policies where tablename = 'operator_events'
union all
select 'rpc_my_access',        count(*)::text     from pg_proc     where proname   = 'rpc_my_access'
union all
select 'table',                count(*)::text     from information_schema.tables where table_name = 'operator_events';
