-- =============================================================================
--  Rules content for a division that plays home and away
--  Run in the Supabase SQL editor. Safe to re-run.
-- =============================================================================
--
--  Content only. No tables or functions change, so nobody has to reload the
--  site for this one. You can do the same thing by hand in Admin > Rules.
--
--  Deliberately carries no pair counts or match totals. An earlier draft said
--  "seven pairs, 12 matches each" and was out of date within a day, because two
--  more pairs joined. The Rules page already prints those figures live under
--  "Your season", and so does the player guide, both straight from this
--  database. Prose explains the shape; the numbers come from the data.
-- =============================================================================

begin;

insert into public.rule_sections (league_id, sort_order, heading, kind, body, visible)
values ('sherwood', 25, 'Beginner: home and away', 'prose',
E'Beginner plays every other pair twice instead of once. "Your season" at the top of this page shows exactly how many matches that is for you.\n'
'\n'
'- The two meetings are separate matches. Each one is scored and counted on its own, and nothing is added together across the pair of them.\n'
'- Who makes first contact swaps between them, so against every pair you start the chat once and they start it once.\n'
'- They do not have to be played in order, and they do not have to be far apart. Arrange each one whenever it suits both pairs.\n'
'- On the grid your row holds the matches you start and your column holds the ones they start, so each pairing appears twice.',
  true)
on conflict do nothing;

-- "at least four played" was written for a nine match season. Beginner plays
-- considerably more, so make the target proportional rather than a fixed count.
update public.rule_sections
   set body = E'All your matches must be finished by the end of the season. Aim to have about half of them played by 15 November, because leaving them to the end means fighting everyone else for the same courts.',
       updated_at = now()
 where league_id = 'sherwood'
   and heading = 'Pace'
   and body like '%at least four%';

commit;

-- Check it landed:
--   select sort_order, heading, kind from rule_sections
--    where league_id = 'sherwood' order by sort_order;
