-- =============================================================================
--  Migration 04: league-aware write functions
--  Run once, after 03_multi_league.sql.
-- =============================================================================
--
--  Every admin call now carries the league it applies to, and the PIN is
--  checked against that league. Without this, one club's organiser could edit
--  another club's league with their own PIN.
--
--  The old single-league functions are dropped rather than left in place,
--  because they would be exactly that hole.
-- =============================================================================

begin;

drop function if exists public.admin_ok(text);
drop function if exists public.admin_require(text);
drop function if exists public.admin_save_team(text, text, text, text, text, text, text, numeric, int, uuid);
drop function if exists public.admin_delete_team(text, uuid);
drop function if exists public.admin_replace_fixtures(text, text, jsonb, boolean);
drop function if exists public.admin_set_result(text, uuid, int, int, int, int, int, int, date, text);
drop function if exists public.admin_clear_result(text, uuid);
drop function if exists public.admin_update_settings(text, jsonb);
drop function if exists public.admin_set_pin(text, text);
drop function if exists public.submit_result(uuid, int, int, int, int, int, int, date, text);

-- ----------------------------------------------------------------- helpers

create or replace function public.league_of_division(p_division_id text)
returns text language sql stable security definer set search_path = public as $$
  select league_id from public.divisions where id = p_division_id;
$$;

create or replace function public.league_of_match(p_match_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select d.league_id
    from public.matches m
    join public.divisions d on d.id = m.division_id
   where m.id = p_match_id;
$$;

create or replace function public.admin_ok(p_league_id text, p_pin text)
returns boolean language plpgsql security definer
set search_path = public, extensions as $$
declare v_hash text;
begin
  select pin_hash into v_hash from public.league_admin where league_id = p_league_id;
  if v_hash is null then return false; end if;
  return v_hash = extensions.crypt(coalesce(p_pin, ''), v_hash);
end $$;

create or replace function public.admin_require(p_league_id text, p_pin text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not public.admin_ok(p_league_id, p_pin) then
    raise exception 'Wrong admin PIN for this league.' using errcode = '42501';
  end if;
end $$;

/* Confirms a division really belongs to the league whose PIN was given. */
create or replace function public.admin_require_division(p_league_id text, p_pin text, p_division_id text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform public.admin_require(p_league_id, p_pin);
  if public.league_of_division(p_division_id) is distinct from p_league_id then
    raise exception 'That division is not part of this league.' using errcode = '42501';
  end if;
end $$;

create or replace function public.admin_require_match(p_league_id text, p_pin text, p_match_id uuid)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform public.admin_require(p_league_id, p_pin);
  if public.league_of_match(p_match_id) is distinct from p_league_id then
    raise exception 'That fixture is not part of this league.' using errcode = '42501';
  end if;
end $$;

-- ------------------------------------------------------- players: submit a result

create or replace function public.submit_result(
  p_match_id uuid, p_s1_home int, p_s1_away int, p_s2_home int, p_s2_away int,
  p_stb_home int default null, p_stb_away int default null,
  p_played_on date default null, p_submitted_by text default null
) returns public.matches
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_match  public.matches;
  v_locked boolean;
begin
  select l.results_locked into v_locked
    from public.matches m
    join public.divisions d on d.id = m.division_id
    join public.leagues  l on l.id = d.league_id
   where m.id = p_match_id;

  if v_locked is null then
    raise exception 'That fixture does not exist.' using errcode = 'P0002';
  end if;
  if v_locked then
    raise exception 'Result entry is closed. Please send the score to the league organiser.'
      using errcode = '42501';
  end if;

  select * into v_match from public.matches where id = p_match_id for update;

  if v_match.status = 'completed' then
    raise exception 'Match % already has a result (%). Ask the organiser to correct it.',
      v_match.match_no, public.scoreline(v_match) using errcode = '42501';
  end if;

  perform public.assert_valid_scoreline(
    p_s1_home, p_s1_away, p_s2_home, p_s2_away, p_stb_home, p_stb_away);

  if p_played_on is not null and p_played_on > current_date then
    raise exception 'The date played cannot be in the future.' using errcode = '22023';
  end if;

  update public.matches set
    s1_home = p_s1_home, s1_away = p_s1_away,
    s2_home = p_s2_home, s2_away = p_s2_away,
    stb_home = p_stb_home, stb_away = p_stb_away,
    status = 'completed',
    played_on = coalesce(p_played_on, current_date),
    submitted_by = nullif(btrim(coalesce(p_submitted_by, '')), ''),
    submitted_at = now()
  where id = p_match_id
  returning * into v_match;

  return v_match;
end $$;

-- ------------------------------------------------------------------- teams

create or replace function public.admin_save_team(
  p_league_id text, p_pin text, p_division_id text, p_name text,
  p_player1 text default '', p_player2 text default '',
  p_phone1 text default null, p_phone2 text default null,
  p_rating numeric default null, p_seed int default null, p_team_id uuid default null
) returns public.teams
language plpgsql security definer set search_path = public, extensions as $$
declare v_team public.teams; v_seed int;
begin
  perform public.admin_require_division(p_league_id, p_pin, p_division_id);

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'A team needs a name.' using errcode = '22023';
  end if;

  if p_team_id is null then
    select coalesce(max(seed), 0) + 1 into v_seed
      from public.teams where division_id = p_division_id;
    insert into public.teams (division_id, seed, name, player1, player2, phone1, phone2, rating)
    values (p_division_id, coalesce(p_seed, v_seed), btrim(p_name),
            coalesce(btrim(p_player1), ''), coalesce(btrim(p_player2), ''),
            nullif(btrim(coalesce(p_phone1, '')), ''),
            nullif(btrim(coalesce(p_phone2, '')), ''), p_rating)
    returning * into v_team;
  else
    if public.league_of_division((select division_id from public.teams where id = p_team_id))
       is distinct from p_league_id then
      raise exception 'That team is not part of this league.' using errcode = '42501';
    end if;
    update public.teams set
      name = btrim(p_name),
      player1 = coalesce(btrim(p_player1), ''), player2 = coalesce(btrim(p_player2), ''),
      phone1 = nullif(btrim(coalesce(p_phone1, '')), ''),
      phone2 = nullif(btrim(coalesce(p_phone2, '')), ''),
      rating = p_rating, seed = coalesce(p_seed, seed)
    where id = p_team_id
    returning * into v_team;
    if not found then
      raise exception 'That team does not exist.' using errcode = 'P0002';
    end if;
  end if;

  return v_team;
end $$;

create or replace function public.admin_delete_team(p_league_id text, p_pin text, p_team_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_played int;
begin
  perform public.admin_require(p_league_id, p_pin);
  if public.league_of_division((select division_id from public.teams where id = p_team_id))
     is distinct from p_league_id then
    raise exception 'That team is not part of this league.' using errcode = '42501';
  end if;

  select count(*) into v_played from public.matches
   where (home_team = p_team_id or away_team = p_team_id) and status = 'completed';
  if v_played > 0 then
    raise exception 'That team already has % completed result(s). Clear them first.', v_played
      using errcode = '42501';
  end if;

  delete from public.teams where id = p_team_id;
end $$;

-- --------------------------------------------------------------- divisions

create or replace function public.admin_save_division(
  p_league_id text, p_pin text, p_slug text, p_name text,
  p_rating_label text default null, p_meetings int default 1,
  p_sort_order int default 0, p_division_id text default null
) returns public.divisions
language plpgsql security definer set search_path = public, extensions as $$
declare v_div public.divisions; v_slug text; v_id text;
begin
  perform public.admin_require(p_league_id, p_pin);

  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,30}$' then
    raise exception 'Division key must be lower case letters, numbers and dashes.'
      using errcode = '22023';
  end if;
  if coalesce(p_meetings, 1) not between 1 and 4 then
    raise exception 'Each pair can meet between 1 and 4 times.' using errcode = '22023';
  end if;

  if p_division_id is null then
    v_id := p_league_id || '-' || v_slug;
    insert into public.divisions (id, league_id, slug, name, rating_label, meetings, sort_order)
    values (v_id, p_league_id, v_slug, btrim(p_name), nullif(btrim(coalesce(p_rating_label, '')), ''),
            coalesce(p_meetings, 1), coalesce(p_sort_order, 0))
    returning * into v_div;
  else
    perform public.admin_require_division(p_league_id, p_pin, p_division_id);
    update public.divisions set
      slug = v_slug, name = btrim(p_name),
      rating_label = nullif(btrim(coalesce(p_rating_label, '')), ''),
      meetings = coalesce(p_meetings, meetings),
      sort_order = coalesce(p_sort_order, sort_order)
    where id = p_division_id
    returning * into v_div;
  end if;

  return v_div;
end $$;

create or replace function public.admin_delete_division(p_league_id text, p_pin text, p_division_id text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_played int;
begin
  perform public.admin_require_division(p_league_id, p_pin, p_division_id);
  select count(*) into v_played from public.matches
   where division_id = p_division_id and status = 'completed';
  if v_played > 0 then
    raise exception 'That division has % completed result(s). Clear them first.', v_played
      using errcode = '42501';
  end if;
  delete from public.divisions where id = p_division_id;
end $$;

-- ---------------------------------------------------------------- fixtures

create or replace function public.admin_replace_fixtures(
  p_league_id text, p_pin text, p_division_id text, p_fixtures jsonb, p_force boolean default false
) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_played int; v_count int;
begin
  perform public.admin_require_division(p_league_id, p_pin, p_division_id);

  select count(*) into v_played from public.matches
   where division_id = p_division_id and status = 'completed';
  if v_played > 0 and not p_force then
    raise exception
      '% result(s) have already been played in this division. Regenerating fixtures would erase them.',
      v_played using errcode = '42501';
  end if;

  delete from public.matches where division_id = p_division_id;

  insert into public.matches (division_id, round, match_no, meeting, home_team, away_team, status)
  select p_division_id, (f ->> 'round')::int, (f ->> 'match_no')::int,
         coalesce((f ->> 'meeting')::int, 1),
         (f ->> 'home_team')::uuid, (f ->> 'away_team')::uuid, 'pending'
    from jsonb_array_elements(p_fixtures) as f;

  select count(*) into v_count from public.matches where division_id = p_division_id;
  return v_count;
end $$;

-- ----------------------------------------------------------------- results

create or replace function public.admin_set_result(
  p_league_id text, p_pin text, p_match_id uuid,
  p_s1_home int, p_s1_away int, p_s2_home int, p_s2_away int,
  p_stb_home int default null, p_stb_away int default null,
  p_played_on date default null, p_note text default null
) returns public.matches
language plpgsql security definer set search_path = public, extensions as $$
declare v_match public.matches;
begin
  perform public.admin_require_match(p_league_id, p_pin, p_match_id);
  perform public.assert_valid_scoreline(
    p_s1_home, p_s1_away, p_s2_home, p_s2_away, p_stb_home, p_stb_away);

  update public.matches set
    s1_home = p_s1_home, s1_away = p_s1_away,
    s2_home = p_s2_home, s2_away = p_s2_away,
    stb_home = p_stb_home, stb_away = p_stb_away,
    status = 'completed',
    played_on = coalesce(p_played_on, played_on, current_date),
    note = nullif(btrim(coalesce(p_note, '')), ''),
    submitted_by = coalesce(submitted_by, 'organiser'),
    submitted_at = now()
  where id = p_match_id
  returning * into v_match;

  return v_match;
end $$;

create or replace function public.admin_clear_result(p_league_id text, p_pin text, p_match_id uuid)
returns public.matches
language plpgsql security definer set search_path = public, extensions as $$
declare v_match public.matches;
begin
  perform public.admin_require_match(p_league_id, p_pin, p_match_id);
  update public.matches set
    status = 'pending',
    s1_home = null, s1_away = null, s2_home = null, s2_away = null,
    stb_home = null, stb_away = null,
    played_on = null, submitted_by = null, submitted_at = null, note = null
  where id = p_match_id
  returning * into v_match;
  return v_match;
end $$;

-- ---------------------------------------------------------------- settings

create or replace function public.admin_update_league(p_league_id text, p_pin text, p_patch jsonb)
returns public.leagues
language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.leagues;
begin
  perform public.admin_require(p_league_id, p_pin);
  update public.leagues set
    name                = coalesce(p_patch ->> 'name', name),
    venue               = coalesce(p_patch ->> 'venue', venue),
    season_start        = coalesce((p_patch ->> 'season_start')::date, season_start),
    season_end          = coalesce((p_patch ->> 'season_end')::date, season_end),
    pace_target_date    = coalesce((p_patch ->> 'pace_target_date')::date, pace_target_date),
    pace_target_matches = coalesce((p_patch ->> 'pace_target_matches')::int, pace_target_matches),
    promo_discount      = coalesce(p_patch ->> 'promo_discount', promo_discount),
    booking_url         = coalesce(p_patch ->> 'booking_url', booking_url),
    whatsapp_url        = coalesce(p_patch ->> 'whatsapp_url', whatsapp_url),
    results_locked      = coalesce((p_patch ->> 'results_locked')::boolean, results_locked)
  where id = p_league_id
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.admin_set_pin(p_league_id text, p_pin text, p_new_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.admin_require(p_league_id, p_pin);
  if length(coalesce(p_new_pin, '')) < 6 then
    raise exception 'Choose a PIN of at least 6 characters.' using errcode = '22023';
  end if;
  update public.league_admin
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)), updated_at = now()
   where league_id = p_league_id;
end $$;

-- -------------------------------------------------------------- rules text

create or replace function public.admin_save_rule(
  p_league_id text, p_pin text, p_heading text, p_body text default '',
  p_kind text default 'prose', p_sort_order int default null,
  p_visible boolean default true, p_rule_id uuid default null
) returns public.rule_sections
language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.rule_sections; v_order int;
begin
  perform public.admin_require(p_league_id, p_pin);
  if p_kind not in ('prose', 'steps', 'scoring') then
    raise exception 'Unknown section type.' using errcode = '22023';
  end if;

  if p_rule_id is null then
    select coalesce(max(sort_order), 0) + 10 into v_order
      from public.rule_sections where league_id = p_league_id;
    insert into public.rule_sections (league_id, sort_order, heading, body, kind, visible)
    values (p_league_id, coalesce(p_sort_order, v_order), btrim(p_heading),
            coalesce(p_body, ''), p_kind, coalesce(p_visible, true))
    returning * into v_row;
  else
    update public.rule_sections set
      heading = btrim(p_heading), body = coalesce(p_body, ''), kind = p_kind,
      sort_order = coalesce(p_sort_order, sort_order),
      visible = coalesce(p_visible, visible), updated_at = now()
    where id = p_rule_id and league_id = p_league_id
    returning * into v_row;
    if not found then
      raise exception 'That rule section is not part of this league.' using errcode = '42501';
    end if;
  end if;

  return v_row;
end $$;

create or replace function public.admin_delete_rule(p_league_id text, p_pin text, p_rule_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.admin_require(p_league_id, p_pin);
  delete from public.rule_sections where id = p_rule_id and league_id = p_league_id;
  if not found then
    raise exception 'That rule section is not part of this league.' using errcode = '42501';
  end if;
end $$;

/* Reorder by handing back the ids in the order they should appear. */
create or replace function public.admin_reorder_rules(p_league_id text, p_pin text, p_ids uuid[])
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.admin_require(p_league_id, p_pin);
  update public.rule_sections r
     set sort_order = o.pos * 10, updated_at = now()
    from (select unnest(p_ids) as id, generate_subscripts(p_ids, 1) as pos) o
   where r.id = o.id and r.league_id = p_league_id;
end $$;

-- ------------------------------------------------------------ new leagues

/* Create another league, copying the rules of the one you administer.
   Only an owner league's admin may do this. */
create or replace function public.admin_create_league(
  p_from_league text, p_pin text, p_new_id text, p_name text, p_venue text,
  p_season_start date default null, p_season_end date default null,
  p_new_pin text default null
) returns public.leagues
language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.leagues; v_owner boolean;
begin
  perform public.admin_require(p_from_league, p_pin);

  select is_owner into v_owner from public.leagues where id = p_from_league;
  if not coalesce(v_owner, false) then
    raise exception 'Only the main league''s organiser can create another league.'
      using errcode = '42501';
  end if;
  if length(coalesce(p_new_pin, '')) < 6 then
    raise exception 'Give the new league a PIN of at least 6 characters.' using errcode = '22023';
  end if;

  insert into public.leagues (id, name, venue, season_start, season_end, promo_discount,
                              booking_url, sort_order)
  select lower(btrim(p_new_id)), btrim(p_name), btrim(p_venue),
         coalesce(p_season_start, l.season_start), coalesce(p_season_end, l.season_end),
         l.promo_discount, l.booking_url,
         (select coalesce(max(sort_order), 0) + 1 from public.leagues)
    from public.leagues l where l.id = p_from_league
  returning * into v_row;

  insert into public.league_admin (league_id, pin_hash)
  values (v_row.id, extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)));

  -- Start it with a copy of the rules rather than a blank page.
  insert into public.rule_sections (league_id, sort_order, heading, body, kind, visible)
  select v_row.id, sort_order, heading, body, kind, visible
    from public.rule_sections where league_id = p_from_league;

  return v_row;
end $$;

-- =============================================================================
--  Grants
-- =============================================================================

revoke all on function public.league_of_division(text) from public;
revoke all on function public.league_of_match(uuid) from public;
revoke all on function public.admin_require(text, text) from public;
revoke all on function public.admin_require_division(text, text, text) from public;
revoke all on function public.admin_require_match(text, text, uuid) from public;

revoke all on function public.submit_result(uuid, int, int, int, int, int, int, date, text) from public;
revoke all on function public.admin_ok(text, text) from public;
revoke all on function public.admin_save_team(text, text, text, text, text, text, text, text, numeric, int, uuid) from public;
revoke all on function public.admin_delete_team(text, text, uuid) from public;
revoke all on function public.admin_save_division(text, text, text, text, text, int, int, text) from public;
revoke all on function public.admin_delete_division(text, text, text) from public;
revoke all on function public.admin_replace_fixtures(text, text, text, jsonb, boolean) from public;
revoke all on function public.admin_set_result(text, text, uuid, int, int, int, int, int, int, date, text) from public;
revoke all on function public.admin_clear_result(text, text, uuid) from public;
revoke all on function public.admin_update_league(text, text, jsonb) from public;
revoke all on function public.admin_set_pin(text, text, text) from public;
revoke all on function public.admin_save_rule(text, text, text, text, text, int, boolean, uuid) from public;
revoke all on function public.admin_delete_rule(text, text, uuid) from public;
revoke all on function public.admin_reorder_rules(text, text, uuid[]) from public;
revoke all on function public.admin_create_league(text, text, text, text, text, date, date, text) from public;

grant execute on function public.submit_result(uuid, int, int, int, int, int, int, date, text) to anon, authenticated;
grant execute on function public.admin_ok(text, text) to anon, authenticated;
grant execute on function public.admin_save_team(text, text, text, text, text, text, text, text, numeric, int, uuid) to anon, authenticated;
grant execute on function public.admin_delete_team(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_save_division(text, text, text, text, text, int, int, text) to anon, authenticated;
grant execute on function public.admin_delete_division(text, text, text) to anon, authenticated;
grant execute on function public.admin_replace_fixtures(text, text, text, jsonb, boolean) to anon, authenticated;
grant execute on function public.admin_set_result(text, text, uuid, int, int, int, int, int, int, date, text) to anon, authenticated;
grant execute on function public.admin_clear_result(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_update_league(text, text, jsonb) to anon, authenticated;
grant execute on function public.admin_set_pin(text, text, text) to anon, authenticated;
grant execute on function public.admin_save_rule(text, text, text, text, text, int, boolean, uuid) to anon, authenticated;
grant execute on function public.admin_delete_rule(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_reorder_rules(text, text, uuid[]) to anon, authenticated;
grant execute on function public.admin_create_league(text, text, text, text, text, date, date, text) to anon, authenticated;

commit;
