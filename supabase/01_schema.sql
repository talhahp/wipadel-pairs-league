-- =============================================================================
--  Wi Padel Sherwood Pairs League - database schema
--  Run this once in the Supabase SQL editor, then run 02_seed.sql.
-- =============================================================================
--
--  Trust model
--  -----------
--  The website ships with the Supabase *anon* key, which anyone can read out of
--  the page source. So the anon role is given READ access to the league and no
--  direct write access at all. Every write goes through a SECURITY DEFINER
--  function in this file:
--
--    submit_result(...)  - players, once per fixture, validated scorelines only
--    admin_*(pin, ...)   - organiser only, gated on the admin PIN
--
--  That means the scoreline rules are enforced twice: once in core.js for
--  instant feedback in the form, and once here, where it actually counts.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------- divisions

create table if not exists public.divisions (
  id            text primary key,
  name          text not null,
  rating_label  text,
  sort_order    int  not null default 0
);

comment on table public.divisions is 'Beginner / Intermediate etc. Keyed by a short slug used in the URL.';

-- --------------------------------------------------------------------- teams

create table if not exists public.teams (
  id           uuid primary key default gen_random_uuid(),
  division_id  text not null references public.divisions(id) on delete cascade,
  seed         int  not null,
  name         text not null,
  player1      text not null default '',
  player2      text not null default '',
  phone1       text,
  phone2       text,
  rating       numeric(4,2),
  created_at   timestamptz not null default now(),
  constraint teams_seed_unique unique (division_id, seed),
  constraint teams_name_not_blank check (btrim(name) <> '')
);

comment on column public.teams.seed is
  'Display order and the seat used when fixtures are generated. Unique per division.';
comment on column public.teams.rating is
  'Average Playtomic rating of the pair, used only to show the division cap is respected.';

-- ------------------------------------------------------------------- matches

create table if not exists public.matches (
  id            uuid primary key default gen_random_uuid(),
  division_id   text not null references public.divisions(id) on delete cascade,
  round         int  not null,
  match_no      int  not null,
  home_team     uuid not null references public.teams(id) on delete cascade,
  away_team     uuid not null references public.teams(id) on delete cascade,

  status        text not null default 'pending'
                check (status in ('pending', 'completed')),

  -- Raw scoreline only. Sets, points and the table are derived in core.js, so
  -- there is exactly one scoring implementation to keep correct.
  s1_home       smallint, s1_away  smallint,
  s2_home       smallint, s2_away  smallint,
  stb_home      smallint, stb_away smallint,

  played_on     date,
  submitted_by  text,
  submitted_at  timestamptz,
  note          text,

  constraint matches_distinct_teams check (home_team <> away_team),
  constraint matches_no_unique      unique (division_id, match_no),
  constraint matches_completed_has_sets check (
    status = 'pending'
    or (s1_home is not null and s1_away is not null
        and s2_home is not null and s2_away is not null)
  ),
  constraint matches_scores_sane check (
    coalesce(s1_home, 0)  between 0 and 30 and coalesce(s1_away, 0)  between 0 and 30 and
    coalesce(s2_home, 0)  between 0 and 30 and coalesce(s2_away, 0)  between 0 and 30 and
    coalesce(stb_home, 0) between 0 and 30 and coalesce(stb_away, 0) between 0 and 30
  )
);

comment on column public.matches.home_team is
  'The team responsible for making first contact to arrange the match. Nothing more.';

create index if not exists matches_division_idx on public.matches (division_id, match_no);
create index if not exists matches_home_idx     on public.matches (home_team);
create index if not exists matches_away_idx     on public.matches (away_team);

-- ------------------------------------------------------------------ settings

create table if not exists public.league_settings (
  id                 int primary key default 1 check (id = 1),
  league_name        text not null default 'Wi Padel Sherwood Pairs League',
  venue              text not null default 'Wi Padel Sherwood',
  season_start       date not null default '2026-10-15',
  season_end         date not null default '2026-12-15',
  pace_target_date   date default '2026-11-15',
  pace_target_matches int default 4,
  -- promo_code is unused: the club's discount is permanent and applies with no
  -- code. Kept rather than dropped so existing databases need no migration.
  promo_code         text,
  promo_discount     text default '20%',
  booking_url        text default 'https://playtomic.io',
  whatsapp_url       text,
  results_locked     boolean not null default false,
  updated_at         timestamptz not null default now()
);

-- Organiser PIN. Deliberately a separate table so it can never be selected by
-- the anon role even accidentally - the public settings live above.
create table if not exists public.admin_credential (
  id         int primary key default 1 check (id = 1),
  pin_hash   text not null,
  updated_at timestamptz not null default now()
);

-- =============================================================================
--  Row level security
-- =============================================================================

alter table public.divisions        enable row level security;
alter table public.teams            enable row level security;
alter table public.matches          enable row level security;
alter table public.league_settings  enable row level security;
alter table public.admin_credential enable row level security;

-- Everything about the league is public to read: that is the whole point of
-- replacing a view-only spreadsheet.
drop policy if exists divisions_read on public.divisions;
create policy divisions_read on public.divisions for select using (true);

drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams for select using (true);

drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select using (true);

drop policy if exists settings_read on public.league_settings;
create policy settings_read on public.league_settings for select using (true);

-- No policy at all on admin_credential => unreachable except via SECURITY
-- DEFINER functions below. Revoke the table grants too, so a future policy
-- added by mistake still cannot expose the hash.
revoke all on public.admin_credential from anon, authenticated;

-- There are no INSERT / UPDATE / DELETE policies anywhere. All writes go
-- through the functions below.

-- =============================================================================
--  Scoreline validation (server side copy of the rules in core.js)
-- =============================================================================

create or replace function public.assert_valid_set(
  p_a int, p_b int, p_label text
) returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_hi int; v_lo int;
begin
  if p_a is null or p_b is null then
    raise exception '%: both game scores are required.', p_label using errcode = '22023';
  end if;
  v_hi := greatest(p_a, p_b);
  v_lo := least(p_a, p_b);
  if v_hi = v_lo then
    raise exception '%: a set cannot be drawn (%-%).', p_label, p_a, p_b using errcode = '22023';
  end if;
  -- Legal completed padel sets: 6-0..6-4, 7-5, 7-6.
  if not ((v_hi = 6 and v_lo <= 4) or (v_hi = 7 and v_lo in (5, 6))) then
    raise exception '%: %-% is not a completed padel set (6-0 to 6-4, 7-5 or 7-6).',
      p_label, p_a, p_b using errcode = '22023';
  end if;
end $$;

create or replace function public.assert_valid_scoreline(
  p_s1_home int, p_s1_away int,
  p_s2_home int, p_s2_away int,
  p_stb_home int, p_stb_away int
) returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sets_home int;
  v_has_tb    boolean := p_stb_home is not null and p_stb_away is not null;
begin
  perform public.assert_valid_set(p_s1_home, p_s1_away, 'Set 1');
  perform public.assert_valid_set(p_s2_home, p_s2_away, 'Set 2');

  v_sets_home := (case when p_s1_home > p_s1_away then 1 else 0 end)
               + (case when p_s2_home > p_s2_away then 1 else 0 end);

  if v_sets_home = 1 then
    -- One set each: the match must have been decided on the super tie-break.
    if not v_has_tb then
      raise exception 'Sets are 1-1, so the super tie-break score is required.'
        using errcode = '22023';
    end if;
    if greatest(p_stb_home, p_stb_away) < 10 then
      raise exception 'Super tie-break: the winner needs at least 10 points (got %-%).',
        p_stb_home, p_stb_away using errcode = '22023';
    end if;
    if abs(p_stb_home - p_stb_away) < 2 then
      raise exception 'Super tie-break: must be won by 2 clear points (got %-%).',
        p_stb_home, p_stb_away using errcode = '22023';
    end if;
    if greatest(p_stb_home, p_stb_away) > 10
       and abs(p_stb_home - p_stb_away) > 2 then
      raise exception 'Super tie-break: %-% cannot happen - play stops at 2 clear points.',
        p_stb_home, p_stb_away using errcode = '22023';
    end if;
  elsif v_has_tb then
    raise exception 'The match was won in straight sets, so there is no super tie-break score.'
      using errcode = '22023';
  end if;
end $$;

-- =============================================================================
--  Player-facing write: submit a result
-- =============================================================================

-- Formats a scoreline for the error message in submit_result below.
create or replace function public.scoreline(p_match public.matches)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_match.s1_home is null then '-'
    else concat_ws(', ',
      p_match.s1_home || '-' || p_match.s1_away,
      p_match.s2_home || '-' || p_match.s2_away,
      case when p_match.stb_home is not null
        then p_match.stb_home || '-' || p_match.stb_away end)
  end;
$$;

create or replace function public.submit_result(
  p_match_id     uuid,
  p_s1_home      int,
  p_s1_away      int,
  p_s2_home      int,
  p_s2_away      int,
  p_stb_home     int  default null,
  p_stb_away     int  default null,
  p_played_on    date default null,
  p_submitted_by text default null
) returns public.matches
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_match  public.matches;
  v_locked boolean;
begin
  select results_locked into v_locked from public.league_settings where id = 1;
  if coalesce(v_locked, false) then
    raise exception 'Result entry is closed. Please send the score to the league organiser.'
      using errcode = '42501';
  end if;

  select * into v_match from public.matches where id = p_match_id for update;
  if not found then
    raise exception 'That fixture does not exist.' using errcode = 'P0002';
  end if;

  if v_match.status = 'completed' then
    raise exception 'Match %  already has a result (%). Ask the organiser to correct it.',
      v_match.match_no, public.scoreline(v_match) using errcode = '42501';
  end if;

  perform public.assert_valid_scoreline(
    p_s1_home, p_s1_away, p_s2_home, p_s2_away, p_stb_home, p_stb_away);

  if p_played_on is not null and p_played_on > current_date then
    raise exception 'The date played cannot be in the future.' using errcode = '22023';
  end if;

  update public.matches set
    s1_home      = p_s1_home,
    s1_away      = p_s1_away,
    s2_home      = p_s2_home,
    s2_away      = p_s2_away,
    stb_home     = p_stb_home,
    stb_away     = p_stb_away,
    status       = 'completed',
    played_on    = coalesce(p_played_on, current_date),
    submitted_by = nullif(btrim(coalesce(p_submitted_by, '')), ''),
    submitted_at = now()
  where id = p_match_id
  returning * into v_match;

  return v_match;
end $$;

-- =============================================================================
--  Organiser writes, gated on the admin PIN
-- =============================================================================

create or replace function public.admin_ok(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_hash text;
begin
  select pin_hash into v_hash from public.admin_credential where id = 1;
  if v_hash is null then
    return false;
  end if;
  return v_hash = extensions.crypt(coalesce(p_pin, ''), v_hash);
end $$;

create or replace function public.admin_require(p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_ok(p_pin) then
    raise exception 'Wrong admin PIN.' using errcode = '42501';
  end if;
end $$;

-- Insert or update one team. Pass p_team_id to edit, omit it to create.
create or replace function public.admin_save_team(
  p_pin         text,
  p_division_id text,
  p_name        text,
  p_player1     text default '',
  p_player2     text default '',
  p_phone1      text default null,
  p_phone2      text default null,
  p_rating      numeric default null,
  p_seed        int default null,
  p_team_id     uuid default null
) returns public.teams
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_team public.teams;
  v_seed int;
begin
  perform public.admin_require(p_pin);

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'A team needs a name.' using errcode = '22023';
  end if;

  if p_team_id is null then
    select coalesce(max(seed), 0) + 1 into v_seed
      from public.teams where division_id = p_division_id;

    insert into public.teams
      (division_id, seed, name, player1, player2, phone1, phone2, rating)
    values
      (p_division_id, coalesce(p_seed, v_seed), btrim(p_name),
       coalesce(btrim(p_player1), ''), coalesce(btrim(p_player2), ''),
       nullif(btrim(coalesce(p_phone1, '')), ''),
       nullif(btrim(coalesce(p_phone2, '')), ''),
       p_rating)
    returning * into v_team;
  else
    update public.teams set
      name    = btrim(p_name),
      player1 = coalesce(btrim(p_player1), ''),
      player2 = coalesce(btrim(p_player2), ''),
      phone1  = nullif(btrim(coalesce(p_phone1, '')), ''),
      phone2  = nullif(btrim(coalesce(p_phone2, '')), ''),
      rating  = p_rating,
      seed    = coalesce(p_seed, seed)
    where id = p_team_id
    returning * into v_team;

    if not found then
      raise exception 'That team does not exist.' using errcode = 'P0002';
    end if;
  end if;

  return v_team;
end $$;

create or replace function public.admin_delete_team(p_pin text, p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_played int;
begin
  perform public.admin_require(p_pin);

  select count(*) into v_played
    from public.matches
   where (home_team = p_team_id or away_team = p_team_id)
     and status = 'completed';

  if v_played > 0 then
    raise exception 'That team already has % completed result(s). Clear them first.', v_played
      using errcode = '42501';
  end if;

  delete from public.teams where id = p_team_id;
end $$;

-- Replace a division's whole fixture list. Fixtures are generated in core.js so
-- there is one round-robin implementation, and handed over as JSON.
create or replace function public.admin_replace_fixtures(
  p_pin         text,
  p_division_id text,
  p_fixtures    jsonb,
  p_force       boolean default false
) returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_played int;
  v_count  int;
begin
  perform public.admin_require(p_pin);

  select count(*) into v_played
    from public.matches
   where division_id = p_division_id and status = 'completed';

  if v_played > 0 and not p_force then
    raise exception
      '% result(s) have already been played in this division. Regenerating fixtures would erase them.',
      v_played using errcode = '42501';
  end if;

  delete from public.matches where division_id = p_division_id;

  insert into public.matches (division_id, round, match_no, home_team, away_team, status)
  select p_division_id,
         (f ->> 'round')::int,
         (f ->> 'match_no')::int,
         (f ->> 'home_team')::uuid,
         (f ->> 'away_team')::uuid,
         'pending'
    from jsonb_array_elements(p_fixtures) as f;

  select count(*) into v_count from public.matches where division_id = p_division_id;
  return v_count;
end $$;

-- Organiser override: set or correct any result, valid scoreline still required.
create or replace function public.admin_set_result(
  p_pin       text,
  p_match_id  uuid,
  p_s1_home   int,
  p_s1_away   int,
  p_s2_home   int,
  p_s2_away   int,
  p_stb_home  int  default null,
  p_stb_away  int  default null,
  p_played_on date default null,
  p_note      text default null
) returns public.matches
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_match public.matches;
begin
  perform public.admin_require(p_pin);
  perform public.assert_valid_scoreline(
    p_s1_home, p_s1_away, p_s2_home, p_s2_away, p_stb_home, p_stb_away);

  update public.matches set
    s1_home      = p_s1_home,
    s1_away      = p_s1_away,
    s2_home      = p_s2_home,
    s2_away      = p_s2_away,
    stb_home     = p_stb_home,
    stb_away     = p_stb_away,
    status       = 'completed',
    played_on    = coalesce(p_played_on, played_on, current_date),
    note         = nullif(btrim(coalesce(p_note, '')), ''),
    submitted_by = coalesce(submitted_by, 'organiser'),
    submitted_at = now()
  where id = p_match_id
  returning * into v_match;

  if not found then
    raise exception 'That fixture does not exist.' using errcode = 'P0002';
  end if;

  return v_match;
end $$;

-- Put a fixture back to unplayed, e.g. a result entered against the wrong pair.
create or replace function public.admin_clear_result(p_pin text, p_match_id uuid)
returns public.matches
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_match public.matches;
begin
  perform public.admin_require(p_pin);

  update public.matches set
    status = 'pending',
    s1_home = null, s1_away = null,
    s2_home = null, s2_away = null,
    stb_home = null, stb_away = null,
    played_on = null, submitted_by = null, submitted_at = null, note = null
  where id = p_match_id
  returning * into v_match;

  if not found then
    raise exception 'That fixture does not exist.' using errcode = 'P0002';
  end if;

  return v_match;
end $$;

create or replace function public.admin_update_settings(p_pin text, p_patch jsonb)
returns public.league_settings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_row public.league_settings;
begin
  perform public.admin_require(p_pin);

  update public.league_settings set
    league_name         = coalesce(p_patch ->> 'league_name', league_name),
    venue               = coalesce(p_patch ->> 'venue', venue),
    season_start        = coalesce((p_patch ->> 'season_start')::date, season_start),
    season_end          = coalesce((p_patch ->> 'season_end')::date, season_end),
    pace_target_date    = coalesce((p_patch ->> 'pace_target_date')::date, pace_target_date),
    pace_target_matches = coalesce((p_patch ->> 'pace_target_matches')::int, pace_target_matches),
    promo_code          = coalesce(p_patch ->> 'promo_code', promo_code),
    promo_discount      = coalesce(p_patch ->> 'promo_discount', promo_discount),
    booking_url         = coalesce(p_patch ->> 'booking_url', booking_url),
    whatsapp_url        = coalesce(p_patch ->> 'whatsapp_url', whatsapp_url),
    results_locked      = coalesce((p_patch ->> 'results_locked')::boolean, results_locked),
    updated_at          = now()
  where id = 1
  returning * into v_row;

  return v_row;
end $$;

create or replace function public.admin_set_pin(p_pin text, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.admin_require(p_pin);

  if length(coalesce(p_new_pin, '')) < 6 then
    raise exception 'Choose a PIN of at least 6 characters.' using errcode = '22023';
  end if;

  update public.admin_credential
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = 1;
end $$;

-- =============================================================================
--  Grants - only these functions are callable from the website
-- =============================================================================

revoke all on function public.admin_require(text) from public;
revoke all on function public.scoreline(public.matches) from public;
revoke all on function public.assert_valid_set(int, int, text) from public;
revoke all on function public.assert_valid_scoreline(int, int, int, int, int, int) from public;
revoke all on function public.submit_result(uuid, int, int, int, int, int, int, date, text) from public;
revoke all on function public.admin_ok(text) from public;
revoke all on function public.admin_save_team(text, text, text, text, text, text, text, numeric, int, uuid) from public;
revoke all on function public.admin_delete_team(text, uuid) from public;
revoke all on function public.admin_replace_fixtures(text, text, jsonb, boolean) from public;
revoke all on function public.admin_set_result(text, uuid, int, int, int, int, int, int, date, text) from public;
revoke all on function public.admin_clear_result(text, uuid) from public;
revoke all on function public.admin_update_settings(text, jsonb) from public;
revoke all on function public.admin_set_pin(text, text) from public;

-- Only these are reachable from the website. admin_require and the two
-- assert_* helpers stay internal: they are called by the functions above,
-- which run as the owner.
grant execute on function public.submit_result(uuid, int, int, int, int, int, int, date, text)
  to anon, authenticated;
grant execute on function public.admin_ok(text) to anon, authenticated;
grant execute on function public.admin_save_team(text, text, text, text, text, text, text, numeric, int, uuid)
  to anon, authenticated;
grant execute on function public.admin_delete_team(text, uuid) to anon, authenticated;
grant execute on function public.admin_replace_fixtures(text, text, jsonb, boolean)
  to anon, authenticated;
grant execute on function public.admin_set_result(text, uuid, int, int, int, int, int, int, date, text)
  to anon, authenticated;
grant execute on function public.admin_clear_result(text, uuid) to anon, authenticated;
grant execute on function public.admin_update_settings(text, jsonb) to anon, authenticated;
grant execute on function public.admin_set_pin(text, text) to anon, authenticated;
