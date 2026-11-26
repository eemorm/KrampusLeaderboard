-- 12 Days of Krampus · run in the Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  team_name text not null unique check (length(trim(team_name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  member_name text not null check (length(trim(member_name)) between 1 and 80),
  member_number smallint not null check (member_number between 1 and 5),
  unique(team_id, member_number)
);
create table if not exists public.essays (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  essay_number smallint not null check (essay_number >= 1),
  raw_score smallint check (raw_score between 0 and 5),
  competition_points smallint generated always as (
    (case raw_score when 0 then 0 when 1 then 0 when 2 then 9 when 3 then 13 when 4 then 15 when 5 then 18 else null end)::smallint
  ) stored,
  is_locked boolean not null default false,
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(member_id, essay_number),
  check ((not is_locked) or (raw_score is not null and submitted_at is not null))
);
-- Also upgrades projects that already ran an earlier version of this schema.
alter table public.essays drop constraint if exists essays_essay_number_check;
alter table public.essays add constraint essays_essay_number_check check (essay_number >= 1);
alter table public.essays add column if not exists is_dropped boolean not null default false;
create table if not exists public.competition_settings (
  singleton boolean primary key default true check (singleton),
  essay_count integer not null check (essay_count between 1 and 32767)
);
insert into public.competition_settings(singleton,essay_count)
select true,coalesce((select max(essay_number) from public.essays),15)
on conflict(singleton) do nothing;
create table if not exists public.team_extra_points (
  team_id uuid primary key references public.teams(id) on delete cascade,
  points integer,
  is_locked boolean not null default false,
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((not is_locked) or (points is not null and submitted_at is not null))
);
create table if not exists public.team_credentials (
  team_id uuid primary key references public.teams(id) on delete cascade,
  pin_salt text not null,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.admin_credentials (
  singleton boolean primary key default true check (singleton),
  admin_id uuid not null default gen_random_uuid(),
  pin_salt text not null,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.login_attempts (
  attempt_key text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz
);
create table if not exists public.credential_setup (
  singleton boolean primary key default true check (singleton),
  completed boolean not null default false
);
insert into public.credential_setup(singleton,completed) values(true,false) on conflict(singleton) do nothing;
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  administrator_id uuid not null,
  action text not null,
  team_id uuid references public.teams(id) on delete set null,
  essay_id uuid references public.essays(id) on delete set null,
  member_id uuid references public.members(id) on delete set null,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index if not exists members_team_idx on public.members(team_id);
create index if not exists essays_member_idx on public.essays(member_id);
create index if not exists audit_created_idx on public.audit_log(created_at desc);

-- Deterministic placeholder structure: Team 1–7, with Team 7 holding five members.
insert into public.teams(id,team_name) values
('00000000-0000-4000-8000-000000000001','Team 1'),('00000000-0000-4000-8000-000000000002','Team 2'),
('00000000-0000-4000-8000-000000000003','Team 3'),('00000000-0000-4000-8000-000000000004','Team 4'),
('00000000-0000-4000-8000-000000000005','Team 5'),('00000000-0000-4000-8000-000000000006','Team 6'),
('00000000-0000-4000-8000-000000000007','Team 7') on conflict (id) do nothing;
insert into public.members(team_id,member_name,member_number)
select t.id, 'Member '||m.n, m.n from public.teams t
cross join lateral generate_series(1,case when t.team_name='Team 7' then 5 else 4 end) m(n)
on conflict(team_id,member_number) do nothing;
insert into public.essays(member_id,essay_number)
select m.id,n from public.members m cross join public.competition_settings c
cross join lateral generate_series(1,c.essay_count) n
where not exists(select 1 from public.essays e where e.member_id=m.id)
on conflict(member_id,essay_number) do nothing;
insert into public.team_extra_points(team_id) select id from public.teams on conflict(team_id) do nothing;

-- Exact public projection: private tables are not readable with the anon key.
create or replace view public.public_leaderboard as
select t.team_name,
  case when count(e.id) filter (where e.is_locked)>0 or x.is_locked
    then coalesce(sum(e.competition_points) filter (where not e.is_dropped),0)::bigint + case when x.is_locked then coalesce(x.points,0)::bigint else 0 end
    else null end as overall_score
from public.teams t
left join public.members m on m.team_id=t.id
left join public.essays e on e.member_id=m.id and e.is_locked
left join public.team_extra_points x on x.team_id=t.id
group by t.id,t.team_name,x.points,x.is_locked;

create or replace function public.current_team_id() returns uuid language sql stable as $$
  select nullif(auth.jwt()->'app_metadata'->>'team_id','')::uuid
$$;
create or replace function public.is_competition_admin() returns boolean language sql stable as $$
  select coalesce(auth.jwt()->'app_metadata'->>'competition_role'='admin',false)
$$;

create or replace function public.team_dashboard() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team uuid; result jsonb;
begin
  v_team:=public.current_team_id();
  if v_team is null or public.is_competition_admin() then raise exception 'Team session required'; end if;
  select jsonb_build_object('team_name',t.team_name,'essay_count',(select essay_count from public.competition_settings where singleton),
    'overall_score',coalesce((select sum(e.competition_points) from public.members m join public.essays e on e.member_id=m.id where m.team_id=t.id and e.is_locked and not e.is_dropped),0)
      +case when x.is_locked then coalesce(x.points,0) else 0 end,
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'member_name',m.member_name,'member_number',m.member_number,
      'essays',(select jsonb_agg(jsonb_build_object('id',e.id,'essay_number',e.essay_number,'raw_score',e.raw_score,'competition_points',e.competition_points,'is_locked',e.is_locked,'is_dropped',e.is_dropped) order by e.essay_number) from public.essays e where e.member_id=m.id)) order by m.member_number) from public.members m where m.team_id=t.id),'[]'::jsonb))
  into result from public.teams t join public.team_extra_points x on x.team_id=t.id where t.id=v_team;
  if result is null then raise exception 'Team not found'; end if;
  return result;
end $$;

create or replace function public.submit_essay(p_essay_id uuid,p_raw_score integer) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team uuid; v_owner uuid;
begin
  v_team:=public.current_team_id();
  if v_team is null or public.is_competition_admin() then raise exception 'Team session required'; end if;
  if p_raw_score is null or p_raw_score not between 0 and 5 then raise exception 'Raw score must be 0 through 5'; end if;
  select m.team_id into v_owner from public.essays e join public.members m on m.id=e.member_id where e.id=p_essay_id for update of e;
  if v_owner is null or v_owner<>v_team then raise exception 'Essay is not part of this team'; end if;
  update public.essays set raw_score=p_raw_score,is_locked=true,submitted_at=now(),updated_at=now()
    where id=p_essay_id and is_locked=false and raw_score is null;
  if not found then raise exception 'Essay is already submitted or unavailable'; end if;
end $$;

-- Team submissions are atomic per essay number: all member scores lock together.
create or replace function public.submit_team_essay(p_essay_number integer,p_raw_scores integer[]) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team uuid; v_member_count integer; v_updated integer:=0; item record; v_score integer;
begin
  v_team:=public.current_team_id();
  if v_team is null or public.is_competition_admin() then raise exception 'Team session required'; end if;
  if p_essay_number is null or p_essay_number < 1 then raise exception 'Essay number must be positive'; end if;
  select count(*) into v_member_count from public.members where team_id=v_team;
  if v_member_count not in (4,5) or p_raw_scores is null or cardinality(p_raw_scores)<>v_member_count then raise exception 'Submit one score for every team member'; end if;
  if (select count(*) from public.members m join public.essays e on e.member_id=m.id where m.team_id=v_team and e.essay_number=p_essay_number)<>v_member_count then raise exception 'Essay records are incomplete'; end if;
  for item in
    select m.member_number,e.id,e.raw_score,e.is_locked
    from public.members m join public.essays e on e.member_id=m.id
    where m.team_id=v_team and e.essay_number=p_essay_number
    order by m.member_number for update of e
  loop
    v_score:=p_raw_scores[item.member_number];
    if v_score is null or v_score not between 0 and 5 then raise exception 'Every member score must be 0 through 5'; end if;
    if item.is_locked then
      if item.raw_score is distinct from v_score then raise exception 'A locked member score cannot be changed'; end if;
    else
      if item.raw_score is not null then raise exception 'An administrator correction is pending'; end if;
      update public.essays set raw_score=v_score,is_locked=true,submitted_at=now(),updated_at=now() where id=item.id;
      v_updated:=v_updated+1;
    end if;
  end loop;
  if v_updated=0 then raise exception 'This essay is already submitted and locked'; end if;
end $$;

drop function if exists public.submit_extra_points(integer);

create or replace function public.admin_overview() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'team_name',t.team_name,'essay_count',(select essay_count from public.competition_settings where singleton),'overall_score',
    coalesce((select sum(e.competition_points) from public.members m join public.essays e on e.member_id=m.id where m.team_id=t.id and e.is_locked and not e.is_dropped),0)+case when x.is_locked then coalesce(x.points,0) else 0 end,
    'submitted_essays',(select count(*) from public.members m join public.essays e on e.member_id=m.id where m.team_id=t.id and e.is_locked),
    'maximum_essays',(select count(*) from public.members m where m.team_id=t.id)*(select essay_count from public.competition_settings where singleton),'extra_points',x.points,'extra_locked',x.is_locked,
    'members',(select jsonb_agg(jsonb_build_object('id',m.id,'member_name',m.member_name,'member_number',m.member_number,
      'member_total',(select coalesce(sum(e.competition_points),0) from public.essays e where e.member_id=m.id and e.is_locked),
      'essays',(select jsonb_agg(jsonb_build_object('id',e.id,'essay_number',e.essay_number,'raw_score',e.raw_score,'competition_points',e.competition_points,'is_locked',e.is_locked,'is_dropped',e.is_dropped) order by e.essay_number) from public.essays e where e.member_id=m.id)) order by m.member_number) from public.members m where m.team_id=t.id)) order by t.team_name),'[]'::jsonb)
  into result from public.teams t join public.team_extra_points x on x.team_id=t.id;
  return result;
end $$;

create or replace function public.admin_write_audit(p_action text,p_team uuid,p_essay uuid,p_member uuid,p_previous jsonb,p_new jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  insert into public.audit_log(administrator_id,action,team_id,essay_id,member_id,previous_value,new_value)
    values(auth.uid(),p_action,p_team,p_essay,p_member,p_previous,p_new);
end $$;

create or replace function public.admin_add_essay() returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_previous integer; v_next integer; v_members integer; v_inserted integer;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select essay_count into v_previous from public.competition_settings where singleton for update;
  if v_previous is null then raise exception 'Competition essay count is unavailable'; end if;
  if (select max(essay_number) from public.essays) is distinct from v_previous then
    raise exception 'Essay records do not match the saved count';
  end if;
  if v_previous >= 32767 then raise exception 'Essay number limit reached'; end if;
  select count(*) into v_members from public.members;
  if v_members=0 then raise exception 'No team members found'; end if;
  if exists (
    select 1 from public.members m
    where (select count(*) from public.essays e where e.member_id=m.id)<>v_previous
      or not exists(select 1 from public.essays e where e.member_id=m.id and e.essay_number=v_previous)
  ) then raise exception 'Essay records are incomplete; repair them before adding another essay'; end if;
  v_next:=v_previous+1;
  insert into public.essays(member_id,essay_number)
    select id,v_next from public.members;
  get diagnostics v_inserted=row_count;
  if v_inserted<>v_members then raise exception 'Essay creation was incomplete'; end if;
  update public.competition_settings set essay_count=v_next where singleton;
  perform public.admin_write_audit('essay_added',null,null,null,
    jsonb_build_object('essay_count',v_previous),
    jsonb_build_object('essay_count',v_next,'member_rows',v_inserted));
  return v_next;
end $$;

create or replace function public.admin_remove_essay() returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_previous integer; v_members integer; v_deleted integer;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select essay_count into v_previous from public.competition_settings where singleton for update;
  if v_previous is null then raise exception 'Competition essay count is unavailable'; end if;
  if (select max(essay_number) from public.essays) is distinct from v_previous then
    raise exception 'Essay records do not match the saved count';
  end if;
  if v_previous<=1 then raise exception 'At least one essay is required'; end if;
  perform 1 from public.members m join public.essays e on e.member_id=m.id
    where e.essay_number=v_previous order by m.team_id,m.member_number for update of e;
  select count(*) into v_members from public.members;
  if (select count(*) from public.essays where essay_number=v_previous)<>v_members then
    raise exception 'Essay records are incomplete; repair them before removing an essay';
  end if;
  if exists(select 1 from public.essays where essay_number=v_previous and (raw_score is not null or is_locked or is_dropped or submitted_at is not null)) then
    raise exception 'Essay % has scores or selections and cannot be removed',v_previous;
  end if;
  delete from public.essays where essay_number=v_previous;
  get diagnostics v_deleted=row_count;
  if v_deleted<>v_members then raise exception 'Essay removal was incomplete'; end if;
  update public.competition_settings set essay_count=v_previous-1 where singleton;
  perform public.admin_write_audit('essay_removed',null,null,null,
    jsonb_build_object('essay_count',v_previous,'member_rows',v_deleted),
    jsonb_build_object('essay_count',v_previous-1));
  return v_previous-1;
end $$;

create or replace function public.admin_set_team_essay_lock(p_team_id uuid,p_essay_number integer,p_locked boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_member_count integer; item record; old_row jsonb; new_row jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  if p_locked is null or p_essay_number is null or p_essay_number < 1 then raise exception 'Essay lock selection is invalid'; end if;
  perform 1 from public.teams where id=p_team_id for update;
  select count(*) into v_member_count from public.members where team_id=p_team_id;
  if v_member_count not in (4,5) then raise exception 'Team not found'; end if;
  if (select count(*) from public.members m join public.essays e on e.member_id=m.id where m.team_id=p_team_id and e.essay_number=p_essay_number)<>v_member_count then raise exception 'Essay records are incomplete'; end if;
  if p_locked and exists(select 1 from public.members m join public.essays e on e.member_id=m.id where m.team_id=p_team_id and e.essay_number=p_essay_number and e.raw_score is null) then raise exception 'Enter every member score before locking this essay'; end if;
  for item in
    select m.id as member_id,e.id,e.raw_score,e.competition_points,e.is_locked
    from public.members m join public.essays e on e.member_id=m.id
    where m.team_id=p_team_id and e.essay_number=p_essay_number
    order by m.member_number for update of e
  loop
    if item.is_locked is distinct from p_locked then
      old_row:=jsonb_build_object('raw_score',item.raw_score,'competition_points',item.competition_points,'is_locked',item.is_locked);
      update public.essays set is_locked=p_locked,submitted_at=case when p_locked then coalesce(submitted_at,now()) else null end,updated_at=now() where id=item.id;
      new_row:=jsonb_build_object('raw_score',item.raw_score,'competition_points',item.competition_points,'is_locked',p_locked);
      perform public.admin_write_audit(case when p_locked then 'essay_locked' else 'essay_unlocked' end,p_team_id,item.id,item.member_id,old_row,new_row);
    end if;
  end loop;
end $$;

-- Keep the older RPC signature safe for cached clients while applying group locking.
create or replace function public.admin_set_essay_lock(p_essay_id uuid,p_locked boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team uuid; v_essay_number integer;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select m.team_id,e.essay_number into v_team,v_essay_number from public.essays e join public.members m on m.id=e.member_id where e.id=p_essay_id;
  if v_team is null then raise exception 'Essay not found'; end if;
  perform public.admin_set_team_essay_lock(v_team,v_essay_number,p_locked);
end $$;

create or replace function public.admin_set_team_essay_scores(p_team_id uuid,p_essay_number integer,p_raw_scores integer[]) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_member_count integer; item record; v_score integer; old_row jsonb; new_row jsonb; v_changes integer:=0; v_cleared boolean:=false;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  if p_essay_number is null or p_essay_number < 1 then raise exception 'Essay number must be positive'; end if;
  perform 1 from public.teams where id=p_team_id for update;
  select count(*) into v_member_count from public.members where team_id=p_team_id;
  if v_member_count not in (4,5) or p_raw_scores is null or cardinality(p_raw_scores)<>v_member_count then raise exception 'Submit one score for every team member'; end if;
  if (select count(*) from public.members m join public.essays e on e.member_id=m.id where m.team_id=p_team_id and e.essay_number=p_essay_number)<>v_member_count then raise exception 'Essay records are incomplete'; end if;
  for item in
    select m.member_number,m.id as member_id,e.id,e.raw_score,e.competition_points,e.is_locked,e.is_dropped
    from public.members m join public.essays e on e.member_id=m.id
    where m.team_id=p_team_id and e.essay_number=p_essay_number
    order by m.member_number for update of e
  loop
    v_score:=p_raw_scores[item.member_number];
    if v_score is not null and v_score not between 0 and 5 then raise exception 'Every selected score must be 0 through 5'; end if;
    if item.raw_score is distinct from v_score then
      old_row:=jsonb_build_object('raw_score',item.raw_score,'competition_points',item.competition_points,'is_locked',item.is_locked,'is_dropped',item.is_dropped);
      -- An admin can clear an erroneous score by choosing the blank option.
      -- That score becomes available for team resubmission; other cells retain
      -- their own lock state and are still protected by submit_team_essay.
      update public.essays set raw_score=v_score,
        is_locked=case when v_score is null then false else is_locked end,
        submitted_at=case when v_score is null then null else submitted_at end,
        updated_at=now() where id=item.id;
      if v_score is null then v_cleared:=true; end if;
      select jsonb_build_object('raw_score',raw_score,'competition_points',competition_points,'is_locked',is_locked,'is_dropped',is_dropped)
        into new_row from public.essays where id=item.id;
      perform public.admin_write_audit(case when v_score is null then 'essay_score_cleared_for_resubmission' else 'essay_score_corrected' end,p_team_id,item.id,item.member_id,old_row,new_row);
      v_changes:=v_changes+1;
    end if;
  end loop;
  if v_changes=0 then raise exception 'No score changes to save'; end if;
  -- Clearing a cell is an explicit admin decision to return this essay row to
  -- the team. Lock any other previously unlocked, populated cells so only the
  -- cleared/missing scores need team submission and the row cannot deadlock.
  if v_cleared then
    for item in
      select m.id as member_id,e.id,e.raw_score,e.competition_points,e.is_locked,e.is_dropped
      from public.members m join public.essays e on e.member_id=m.id
      where m.team_id=p_team_id and e.essay_number=p_essay_number and e.raw_score is not null and not e.is_locked
      order by m.member_number for update of e
    loop
      old_row:=jsonb_build_object('raw_score',item.raw_score,'competition_points',item.competition_points,'is_locked',false,'is_dropped',item.is_dropped);
      update public.essays set is_locked=true,submitted_at=coalesce(submitted_at,now()),updated_at=now() where id=item.id;
      new_row:=jsonb_build_object('raw_score',item.raw_score,'competition_points',item.competition_points,'is_locked',true,'is_dropped',item.is_dropped);
      perform public.admin_write_audit('essay_locked',p_team_id,item.id,item.member_id,old_row,new_row);
    end loop;
  end if;
end $$;

create or replace function public.admin_set_essay_score(p_essay_id uuid,p_raw_score integer) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team uuid; v_member uuid; old_row jsonb; new_row jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  if p_raw_score is null or p_raw_score not between 0 and 5 then raise exception 'Raw score must be 0 through 5'; end if;
  select m.team_id,e.member_id,jsonb_build_object('raw_score',e.raw_score,'competition_points',e.competition_points,'is_locked',e.is_locked,'is_dropped',e.is_dropped)
    into v_team,v_member,old_row from public.essays e join public.members m on m.id=e.member_id where e.id=p_essay_id for update of e;
  if v_team is null then raise exception 'Essay not found'; end if;
  -- Admins can correct a locked score directly; updating raw_score preserves its lock state.
  update public.essays set raw_score=p_raw_score,updated_at=now() where id=p_essay_id;
  select jsonb_build_object('raw_score',raw_score,'competition_points',competition_points,'is_locked',is_locked,'is_dropped',is_dropped) into new_row from public.essays where id=p_essay_id;
  perform public.admin_write_audit('essay_score_corrected',v_team,p_essay_id,v_member,old_row,new_row);
end $$;

create or replace function public.admin_set_essay_dropped(p_essay_id uuid,p_dropped boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team uuid; v_member uuid; v_previous_member uuid; v_essay_number smallint; v_locked boolean; v_score smallint; v_dropped boolean; v_previous_essay uuid; old_row jsonb; new_row jsonb; previous_row jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  if p_dropped is null then raise exception 'Drop status is required'; end if;
  select m.team_id into v_team from public.essays e join public.members m on m.id=e.member_id where e.id=p_essay_id;
  if v_team is null then raise exception 'Essay not found'; end if;
  -- Serialize selections per team so concurrent requests cannot choose two members for one essay.
  perform 1 from public.teams where id=v_team for update;
  select m.team_id,e.member_id,e.essay_number,e.is_locked,e.raw_score,e.is_dropped,
    jsonb_build_object('raw_score',e.raw_score,'competition_points',e.competition_points,'is_locked',e.is_locked,'is_dropped',e.is_dropped)
    into v_team,v_member,v_essay_number,v_locked,v_score,v_dropped,old_row
    from public.essays e join public.members m on m.id=e.member_id where e.id=p_essay_id for update of e;
  if v_team is null then raise exception 'Essay not found'; end if;
  if p_dropped and not v_dropped then
    if (select count(*) from public.members where team_id=v_team)<>5 then raise exception 'Only the five-person team can exclude an essay'; end if;
    if not v_locked or v_score is null then raise exception 'Lock the essay before excluding it'; end if;
    select e.id,e.member_id,jsonb_build_object('raw_score',e.raw_score,'competition_points',e.competition_points,'is_locked',e.is_locked,'is_dropped',e.is_dropped)
      into v_previous_essay,v_previous_member,previous_row
      from public.members m join public.essays e on e.member_id=m.id
      where m.team_id=v_team and e.essay_number=v_essay_number and e.is_dropped and e.id<>p_essay_id
      for update of e;
    if v_previous_essay is not null then
      update public.essays set is_dropped=false,updated_at=now() where id=v_previous_essay;
      select jsonb_build_object('raw_score',raw_score,'competition_points',competition_points,'is_locked',is_locked,'is_dropped',is_dropped)
        into new_row from public.essays where id=v_previous_essay;
      perform public.admin_write_audit('essay_exclusion_reassigned',v_team,v_previous_essay,v_previous_member,previous_row,new_row);
    end if;
  end if;
  if v_dropped=p_dropped then return; end if;
  update public.essays set is_dropped=p_dropped,updated_at=now() where id=p_essay_id;
  select jsonb_build_object('raw_score',raw_score,'competition_points',competition_points,'is_locked',is_locked,'is_dropped',is_dropped)
    into new_row from public.essays where id=p_essay_id;
  perform public.admin_write_audit(case when p_dropped then 'essay_excluded_from_team_total' else 'essay_restored_to_team_total' end,v_team,p_essay_id,v_member,old_row,new_row);
end $$;

create or replace function public.admin_set_extra_lock(p_team_id uuid,p_locked boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare old_row jsonb; new_row jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select jsonb_build_object('points',points,'is_locked',is_locked) into old_row from public.team_extra_points where team_id=p_team_id for update;
  if old_row is null then raise exception 'Team extra points not found'; end if;
  if p_locked and (old_row->>'points') is null then raise exception 'Set extra points before locking'; end if;
  update public.team_extra_points set
    points=case when p_locked then points else null end,
    is_locked=p_locked,
    submitted_at=case when p_locked then coalesce(submitted_at,now()) else null end,
    updated_at=now()
    where team_id=p_team_id;
  select jsonb_build_object('points',points,'is_locked',is_locked) into new_row from public.team_extra_points where team_id=p_team_id;
  perform public.admin_write_audit(case when p_locked then 'extra_points_locked' else 'extra_points_unlocked' end,p_team_id,null,null,old_row,new_row);
end $$;

create or replace function public.admin_set_extra_points(p_team_id uuid,p_points integer) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare old_row jsonb; new_row jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select jsonb_build_object('points',points,'is_locked',is_locked) into old_row from public.team_extra_points where team_id=p_team_id for update;
  if old_row is null then raise exception 'Team extra points not found'; end if;
  if (old_row->>'is_locked')::boolean then raise exception 'Unlock extra points before editing'; end if;
  update public.team_extra_points set points=p_points,updated_at=now() where team_id=p_team_id;
  select jsonb_build_object('points',points,'is_locked',is_locked) into new_row from public.team_extra_points where team_id=p_team_id;
  perform public.admin_write_audit('extra_points_corrected',p_team_id,null,null,old_row,new_row);
end $$;

create or replace function public.admin_audit_log(p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if not public.is_competition_admin() then raise exception 'Administrator session required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('action',a.action,'team_name',t.team_name,'previous_value',a.previous_value,'new_value',a.new_value,'created_at',a.created_at) order by a.created_at desc),'[]'::jsonb)
  into result from (select * from public.audit_log order by created_at desc limit least(greatest(coalesce(p_limit,30),1),100)) a left join public.teams t on t.id=a.team_id;
  return result;
end $$;

-- Rate-limit RPCs are called only by the Edge Function using the service key.
create or replace function public.auth_attempt_allowed(p_key text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.login_attempts;
begin
  insert into public.login_attempts(attempt_key,attempts,window_started_at) values(p_key,0,now()) on conflict(attempt_key) do nothing;
  select * into item from public.login_attempts where attempt_key=p_key for update;
  if item.window_started_at < now()-interval '15 minutes' then
    update public.login_attempts set attempts=1,window_started_at=now(),blocked_until=null where attempt_key=p_key;
    return true;
  end if;
  if item.blocked_until is not null and item.blocked_until>now() then return false; end if;
  if item.attempts>=8 then
    update public.login_attempts set blocked_until=now()+interval '15 minutes' where attempt_key=p_key;
    return false;
  end if;
  update public.login_attempts set attempts=attempts+1 where attempt_key=p_key;
  return true;
end $$;
create or replace function public.auth_clear_attempt(p_key text) returns void
language sql security definer set search_path=public,pg_temp as $$ delete from public.login_attempts where attempt_key=p_key $$;
create or replace function public.claim_credential_setup() returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  update public.credential_setup set completed=true where singleton=true and completed=false;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.essays enable row level security;
alter table public.competition_settings enable row level security;
alter table public.team_extra_points enable row level security;
alter table public.team_credentials enable row level security;
alter table public.admin_credentials enable row level security;
alter table public.login_attempts enable row level security;
alter table public.credential_setup enable row level security;
alter table public.audit_log enable row level security;
drop policy if exists teams_scoped_read on public.teams;
create policy teams_scoped_read on public.teams for select to authenticated
  using (public.is_competition_admin() or id=public.current_team_id());
drop policy if exists members_scoped_read on public.members;
create policy members_scoped_read on public.members for select to authenticated
  using (public.is_competition_admin() or team_id=public.current_team_id());
drop policy if exists essays_scoped_read on public.essays;
create policy essays_scoped_read on public.essays for select to authenticated
  using (public.is_competition_admin() or exists(select 1 from public.members m where m.id=essays.member_id and m.team_id=public.current_team_id()));
drop policy if exists extras_scoped_read on public.team_extra_points;
create policy extras_scoped_read on public.team_extra_points for select to authenticated
  using (public.is_competition_admin());
drop policy if exists audit_admin_read on public.audit_log;
create policy audit_admin_read on public.audit_log for select to authenticated
  using (public.is_competition_admin());
revoke all on all tables in schema public from anon,authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
grant select on public.public_leaderboard to anon,authenticated;
grant select on public.teams,public.members,public.essays,public.team_extra_points,public.audit_log to authenticated;
revoke all on function public.current_team_id(),public.is_competition_admin(),public.team_dashboard(),public.submit_essay(uuid,integer),public.submit_team_essay(integer,integer[]),public.admin_add_essay(),public.admin_remove_essay(),public.admin_overview(),public.admin_set_essay_lock(uuid,boolean),public.admin_set_team_essay_lock(uuid,integer,boolean),public.admin_set_team_essay_scores(uuid,integer,integer[]),public.admin_set_essay_score(uuid,integer),public.admin_set_essay_dropped(uuid,boolean),public.admin_set_extra_lock(uuid,boolean),public.admin_set_extra_points(uuid,integer),public.admin_audit_log(integer) from public,anon,authenticated;
grant execute on function public.current_team_id(),public.is_competition_admin() to authenticated;
grant execute on function public.team_dashboard() to authenticated;
grant execute on function public.submit_team_essay(integer,integer[]) to authenticated;
grant execute on function public.admin_add_essay() to authenticated;
grant execute on function public.admin_remove_essay() to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_set_essay_lock(uuid,boolean) to authenticated;
grant execute on function public.admin_set_team_essay_lock(uuid,integer,boolean) to authenticated;
grant execute on function public.admin_set_team_essay_scores(uuid,integer,integer[]) to authenticated;
grant execute on function public.admin_set_essay_score(uuid,integer) to authenticated;
grant execute on function public.admin_set_essay_dropped(uuid,boolean) to authenticated;
grant execute on function public.admin_set_extra_lock(uuid,boolean) to authenticated;
grant execute on function public.admin_set_extra_points(uuid,integer) to authenticated;
grant execute on function public.admin_audit_log(integer) to authenticated;
revoke all on function public.admin_write_audit(text,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.auth_attempt_allowed(text),public.auth_clear_attempt(text),public.claim_credential_setup() from public,anon,authenticated;
grant execute on function public.auth_attempt_allowed(text),public.auth_clear_attempt(text),public.claim_credential_setup() to service_role;
notify pgrst, 'reload schema';
