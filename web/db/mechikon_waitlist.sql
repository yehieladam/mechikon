-- Mechikon Chrome-extension early-access waitlist.
-- Lives in the BAI Portal Supabase project but is FULLY self-contained: it creates one new table and
-- two functions, and touches no existing portal table (tenants/profiles/apps/user_app_access/…).
--
-- Privacy model:
--   * anon has NO direct read on the table (RLS + no select policy) -> no email can be enumerated.
--   * All access is via two SECURITY DEFINER RPCs that return only the caller's own ref code and their
--     own referral COUNT. No position, no totals, no PII of any other signup is ever returned.

create extension if not exists pgcrypto;

create table if not exists public.mechikon_waitlist (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null check (char_length(name) between 1 and 120),
  email       text not null check (char_length(email) between 3 and 200),
  profession  text check (char_length(profession) <= 120),
  ref_code    text not null unique default encode(gen_random_bytes(5), 'hex'),
  referred_by text references public.mechikon_waitlist (ref_code) on delete set null
);

-- One signup per email (case-insensitive).
create unique index if not exists mechikon_waitlist_email_uidx
  on public.mechikon_waitlist (lower(email));

-- Fast referral-count lookups.
create index if not exists mechikon_waitlist_referred_by_idx
  on public.mechikon_waitlist (referred_by);

alter table public.mechikon_waitlist enable row level security;
-- No policies for anon => no direct select/insert/update/delete. All writes go through the RPC below.

-- Join (idempotent): inserts a new signup or returns the existing one for that email.
-- Returns only the caller's own ref_code + their referral count.
create or replace function public.mechikon_join(
  p_name       text,
  p_email      text,
  p_profession text default null,
  p_ref        text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_code text;
begin
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_email), '') = '' then
    raise exception 'name and email are required';
  end if;

  select ref_code into v_code
  from public.mechikon_waitlist
  where lower(email) = lower(btrim(p_email));

  if v_code is null then
    insert into public.mechikon_waitlist (name, email, profession, referred_by)
    values (
      btrim(p_name),
      lower(btrim(p_email)),
      nullif(btrim(p_profession), ''),
      (select ref_code from public.mechikon_waitlist where ref_code = p_ref)  -- validated FK; null if unknown
    )
    returning ref_code into v_code;
  end if;

  return jsonb_build_object(
    'ref_code',  v_code,
    'referrals', (select count(*) from public.mechikon_waitlist where referred_by = v_code)
  );
end;
$$;

-- Status: returns only the referral count for a given code (used to refresh a returning visitor).
create or replace function public.mechikon_status(p_code text)
returns jsonb
  language sql
  security definer
  set search_path = public
as $$
  select jsonb_build_object(
    'referrals', (select count(*) from public.mechikon_waitlist where referred_by = p_code)
  );
$$;

-- Expose only the two RPCs to the anon role. The table itself stays unreadable.
revoke all on function public.mechikon_join(text, text, text, text) from public;
revoke all on function public.mechikon_status(text) from public;
grant execute on function public.mechikon_join(text, text, text, text) to anon;
grant execute on function public.mechikon_status(text) to anon;
