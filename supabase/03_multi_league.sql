-- =============================================================================
--  Migration 03: multiple leagues, per-division format, editable rules
--  Run once in the Supabase SQL editor, after 01_schema.sql and 02_seed.sql.
-- =============================================================================
--
--  Purely additive. It creates tables and columns, backfills the existing
--  Sherwood league into them, and replaces the admin functions with
--  league-aware versions. It never deletes a team, a fixture or a result.
--
--  What changes
--    * leagues          a league per venue. Sherwood is backfilled from
--                       league_settings; Scottburgh is later just a row.
--    * divisions        gain league_id, slug and meetings. meetings is how
--                       many times each pair plays each other, so a five-pair
--                       division can run a double round robin.
--    * matches          gain meeting, so a fixture knows which time round it is.
--    * rule_sections    the rules text, editable in the admin screen.
--    * league_admin     one PIN per league.
--
--  league_settings and admin_credential are left in place, unused. Their
--  contents are copied first, and keeping them means the old PIN hash is still
--  recoverable if anything about the copy turns out wrong.
-- =============================================================================

begin;

-- ------------------------------------------------------------------ leagues

create table if not exists public.leagues (
  id                  text primary key,
  name                text not null,
  venue               text not null,
  season_start        date not null default '2026-10-15',
  season_end          date not null default '2026-12-15',
  pace_target_date    date,
  pace_target_matches int default 4,
  promo_discount      text,
  booking_url         text,
  whatsapp_url        text,
  results_locked      boolean not null default false,
  is_owner            boolean not null default false,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  constraint leagues_id_slug check (id ~ '^[a-z0-9][a-z0-9-]{1,30}$')
);

comment on column public.leagues.is_owner is
  'This league''s admin may create further leagues. Set on the first league only.';

-- Backfill Sherwood from the single settings row it used to live in.
insert into public.leagues (id, name, venue, season_start, season_end,
                            pace_target_date, pace_target_matches, promo_discount,
                            booking_url, whatsapp_url, results_locked, is_owner, sort_order)
select 'sherwood',
       coalesce(nullif(btrim(s.league_name), ''), 'Wi Padel Sherwood Pairs League'),
       coalesce(nullif(btrim(s.venue), ''), 'Wi Padel Sherwood'),
       s.season_start, s.season_end, s.pace_target_date, s.pace_target_matches,
       s.promo_discount, s.booking_url, s.whatsapp_url, s.results_locked,
       true, 1
from public.league_settings s
where s.id = 1
on conflict (id) do nothing;

-- Fallback if league_settings was somehow empty.
insert into public.leagues (id, name, venue, is_owner, sort_order)
values ('sherwood', 'Wi Padel Sherwood Pairs League', 'Wi Padel Sherwood', true, 1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- divisions

alter table public.divisions add column if not exists league_id text;
alter table public.divisions add column if not exists slug text;
alter table public.divisions add column if not exists meetings int not null default 1;

update public.divisions set league_id = 'sherwood' where league_id is null;
update public.divisions set slug = id where slug is null;

alter table public.divisions alter column league_id set not null;
alter table public.divisions alter column slug set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'divisions_league_fk') then
    alter table public.divisions
      add constraint divisions_league_fk foreign key (league_id)
      references public.leagues(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'divisions_meetings_sane') then
    alter table public.divisions
      add constraint divisions_meetings_sane check (meetings between 1 and 4);
  end if;
end $$;

create unique index if not exists divisions_league_slug_idx
  on public.divisions (league_id, slug);

comment on column public.divisions.meetings is
  'Times each pair plays each other. 1 = single round robin, 2 = home and away.';
comment on column public.divisions.id is
  'Opaque key. New divisions are created as <league_id>-<slug>; the originals predate leagues.';

-- ------------------------------------------------------------------ matches

alter table public.matches add column if not exists meeting int not null default 1;

comment on column public.matches.meeting is
  'Which time round this fixture is, for divisions that play each pair more than once.';

-- -------------------------------------------------------------- rule text

create table if not exists public.rule_sections (
  id          uuid primary key default gen_random_uuid(),
  league_id   text not null references public.leagues(id) on delete cascade,
  sort_order  int  not null default 0,
  heading     text not null,
  body        text not null default '',
  kind        text not null default 'prose'
              check (kind in ('prose', 'steps', 'scoring')),
  visible     boolean not null default true,
  updated_at  timestamptz not null default now(),
  constraint rule_heading_not_blank check (btrim(heading) <> '')
);

comment on table public.rule_sections is
  'Editable rules copy. kind=prose renders paragraphs and "- " bullets; '
  'kind=steps renders numbered cards from "Title :: body" lines; '
  'kind=scoring renders the points table generated from the scoring engine, so '
  'the published rules can never contradict how the table is actually worked out.';

create index if not exists rule_sections_league_idx
  on public.rule_sections (league_id, sort_order);

-- ------------------------------------------------------------ admin per league

create table if not exists public.league_admin (
  league_id  text primary key references public.leagues(id) on delete cascade,
  pin_hash   text not null,
  updated_at timestamptz not null default now()
);

-- Carry the existing PIN across. admin_credential is left untouched as a fallback.
insert into public.league_admin (league_id, pin_hash)
select 'sherwood', c.pin_hash from public.admin_credential c where c.id = 1
on conflict (league_id) do nothing;

-- =============================================================================
--  Row level security
-- =============================================================================

alter table public.leagues       enable row level security;
alter table public.rule_sections enable row level security;
alter table public.league_admin  enable row level security;

drop policy if exists leagues_read on public.leagues;
create policy leagues_read on public.leagues for select using (true);

drop policy if exists rules_read on public.rule_sections;
create policy rules_read on public.rule_sections for select using (true);

-- No policy on league_admin, and no grants: reachable only through the
-- SECURITY DEFINER functions below.
revoke all on public.league_admin from anon, authenticated;

-- =============================================================================
--  Seed the Sherwood rules from what the site had hard coded
-- =============================================================================

insert into public.rule_sections (league_id, sort_order, heading, kind, body)
select 'sherwood', v.sort_order, v.heading, v.kind, v.body
from (values
  (10, 'Getting a match played', 'steps',
E'Find who you still have to play :: Your own page lists every fixture and who is still outstanding, with their numbers.\n'
'The pair marked "messages first" reaches out :: They propose two or three date and time options. Either pair can start the chat. The rule is only there to stop both sides waiting for the other.\n'
'Book a 90-minute court :: Either pair books at Wi Padel Sherwood on Playtomic. All league bookings are 20% off automatically. There is no code to enter.\n'
'Submit the score, then post it in the group :: One player enters it here straight after the match, and also posts the score in the WhatsApp group with the date and time you played. The table updates the moment it is submitted.'),

  (20, 'Match format', 'prose',
E'- Two regular sets. If the sets finish 1-1, a 10-point super tie-break decides the match (first to 10, win by 2).\n'
'- Star point at deuce (sudden death) to keep matches inside 60 to 90 minutes.\n'
'- A set is won at 6 games with two clear, or 7-5, or 7-6 on a tie-break.\n'
'- There is never a third full set.'),

  (30, 'Points', 'scoring', ''),

  (40, 'Pace', 'prose',
E'All your matches must be finished by the end of the season. We recommend getting at least four played early on, because leaving them to the end means fighting everyone else for the same courts.'),

  (50, 'Substitutes', 'prose',
E'A pair may use one substitute per match if a partner is injured or away, provided the substitute''s Playtomic rating is at or below the division cap (Beginner 1.5, Intermediate 3.0).'),

  (60, 'Balls', 'prose',
E'Balls are not provided and are not included in your court booking. If you want a new tin for your match, the pairs buy it themselves. Split the cost between the two pairs, or make your own arrangement, as long as you sort it out before you play.'),

  (70, 'Scores', 'prose',
E'- Either player from the winning pair submits the result here.\n'
'- Post the score in the WhatsApp group as well, with the date and time the match was played.\n'
'- A match can only be submitted once. If something is wrong, ask the organiser to correct it.\n'
'- A photo of the scorecard in the group is welcome. The record that counts is the one here.'),

  (80, 'A few pointers', 'prose',
E'- Book the court as soon as you agree a time. Slots get scarce towards the end of the season.\n'
'- Get there a few minutes early. Your warm up comes out of the 90 minutes.\n'
'- If you have to call a match off, tell your opponents as early as you can and offer another time.\n'
'- Message the other pair directly instead of asking in the group. Their numbers are on the Contacts page.\n'
'- Check the grid now and then to see who you still owe a match.')
) as v(sort_order, heading, kind, body)
where not exists (select 1 from public.rule_sections where league_id = 'sherwood');

commit;
