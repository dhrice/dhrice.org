-- r/DIYaesthetics coding platform: database schema
-- Paste this whole file into Supabase > SQL Editor > New query, and click Run.
-- It is safe to run more than once.

-- People allowed to use the app. Add one row per coder (lowercase email).
create table if not exists public.coders (
  email     text primary key,
  name      text,
  is_admin  boolean not null default false
);

-- Things that get coded. Posts now; comments can be added later with unit_type = 'comment'.
create table if not exists public.units (
  id            text primary key,          -- Reddit fullname, e.g. t3_18lqoap
  unit_type     text not null default 'post',
  post_id       text,                      -- for comments: the parent post's t3_ id
  parent_id     text,                      -- for comments: the t1_/t3_ id replied to
  subreddit     text,
  author        text,
  created_utc   bigint,
  title         text,
  body          text,
  permalink     text,
  url           text,
  domain        text,
  flair         text,
  score         integer,
  num_comments  integer,
  media         jsonb not null default '[]'::jsonb,  -- [{path, src, kind}]
  media_kind    text,                      -- none | image | gallery | video | link
  removed       boolean not null default false
);

-- Which units belong to which coding sample, and in what order coders see them.
create table if not exists public.samples (
  sample_name text not null,
  unit_id     text not null references public.units(id) on delete cascade,
  position    integer not null,
  primary key (sample_name, unit_id)
);

-- One row per unit x coder x code. value is the 0/1 decision.
create table if not exists public.codes (
  unit_id     text not null references public.units(id) on delete cascade,
  coder_email text not null default lower(auth.jwt() ->> 'email'),
  code_key    text not null,
  value       boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (unit_id, coder_email, code_key)
);

-- One row per unit x coder: whether the coder marked the unit complete, plus a free-text note.
create table if not exists public.unit_status (
  unit_id     text not null references public.units(id) on delete cascade,
  coder_email text not null default lower(auth.jwt() ->> 'email'),
  done        boolean not null default false,
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (unit_id, coder_email)
);

-- Helper functions used by the security rules.
create or replace function public.is_coder() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.coders where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.coders where lower(email) = lower(auth.jwt() ->> 'email') and is_admin);
$$;

-- Row level security: coders read posts and edit only their own codes; admins read everyone's codes.
alter table public.coders      enable row level security;
alter table public.units       enable row level security;
alter table public.samples     enable row level security;
alter table public.codes       enable row level security;
alter table public.unit_status enable row level security;

drop policy if exists coders_read on public.coders;
create policy coders_read on public.coders for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists units_read on public.units;
create policy units_read on public.units for select to authenticated using (public.is_coder());

drop policy if exists samples_read on public.samples;
create policy samples_read on public.samples for select to authenticated using (public.is_coder());

drop policy if exists codes_read on public.codes;
create policy codes_read on public.codes for select to authenticated
  using (coder_email = lower(auth.jwt() ->> 'email') or public.is_admin());
drop policy if exists codes_insert on public.codes;
create policy codes_insert on public.codes for insert to authenticated
  with check (public.is_coder() and coder_email = lower(auth.jwt() ->> 'email'));
drop policy if exists codes_update on public.codes;
create policy codes_update on public.codes for update to authenticated
  using (coder_email = lower(auth.jwt() ->> 'email'))
  with check (coder_email = lower(auth.jwt() ->> 'email'));
drop policy if exists codes_delete on public.codes;
create policy codes_delete on public.codes for delete to authenticated
  using (coder_email = lower(auth.jwt() ->> 'email'));

drop policy if exists status_read on public.unit_status;
create policy status_read on public.unit_status for select to authenticated
  using (coder_email = lower(auth.jwt() ->> 'email') or public.is_admin());
drop policy if exists status_insert on public.unit_status;
create policy status_insert on public.unit_status for insert to authenticated
  with check (public.is_coder() and coder_email = lower(auth.jwt() ->> 'email'));
drop policy if exists status_update on public.unit_status;
create policy status_update on public.unit_status for update to authenticated
  using (coder_email = lower(auth.jwt() ->> 'email'))
  with check (coder_email = lower(auth.jwt() ->> 'email'));

-- Private image bucket: only logged-in coders can view images.
insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', false)
on conflict (id) do nothing;

drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select to authenticated
  using (bucket_id = 'post-images' and public.is_coder());
