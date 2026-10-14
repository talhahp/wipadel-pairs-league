-- =============================================================================
--  Rules content for the Beginner division (7 pairs, home and away)
--  Run in the Supabase SQL editor. Safe to re-run.
-- =============================================================================
--
--  Content only. No tables or functions change, so nobody needs to reload the
--  site for this one.
--
--  You can do the same thing by hand in Admin > Rules; this is just faster and
--  gets the wording in exactly.
-- =============================================================================

begin;

-- The home and away explanation, placed between "Match format" and "Points".
insert into public.rule_sections (league_id, sort_order, heading, kind, body, visible)
values ('sherwood', 25, 'Beginner: home and away', 'prose',
E'- Seven pairs, and you play every other pair twice. That is 12 matches each, and 42 in the division.\n'
'- The two meetings are separate matches. Each one is scored and counted on its own, and nothing is added together across the pair of them.\n'
'- Who makes first contact swaps between them, so against every pair you start the chat once and they start it once.\n'
'- They do not have to be played in order, and they do not have to be far apart. Arrange each one whenever it suits both pairs.\n'
'- Twelve matches between 15 October and 15 December is about three a fortnight. Aim to have six done by 15 November.',
  true)
on conflict do nothing;

-- "at least four played" was written for a nine match season. Beginner plays
-- twelve, so make the target proportional instead of a fixed number.
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
