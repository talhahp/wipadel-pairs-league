-- =============================================================================
--  Wi Padel Scottburgh Pairs League
--  Run once in the Supabase SQL editor.
-- =============================================================================
--
--  Creates the league, its admin PIN, three divisions and its own rules.
--  Touches nothing belonging to Sherwood.
--
--    Season      1 November to 31 December 2026
--    Divisions   Intermediate, Beginner, Ladies
--    Format      10 pairs each, every pair plays every other pair once
--                (45 matches per division, 9 each)
--    Discount    10% (Sherwood's 20% is unchanged)
--
--  >>> SET THE PIN ON THE FIRST LINE OF THE BLOCK BELOW BEFORE RUNNING. <<<
--  It is Scottburgh's own PIN, separate from Sherwood's, and the script
--  refuses to run while it is still the placeholder.
--
--  Teams are not created here because the pair names are not known yet. After
--  this runs: open the site, switch to Wi Padel Scottburgh with the picker,
--  unlock Admin with this PIN, add the 10 pairs to each division under Pairs,
--  then press Generate fixtures for each division under Fixtures.
-- =============================================================================

do $$
declare
  v_pin text := 'CHANGE-ME';          -- <<< the Scottburgh admin PIN, 6+ characters
  v_league text := 'scottburgh';
  v_venue  text := 'Wi Padel Scottburgh';
  v_start  date := '2026-11-01';
  v_end    date := '2026-12-31';
  v_discount text := '10%';
begin
  if v_pin = 'CHANGE-ME' or length(v_pin) < 6 then
    raise exception
      'Set v_pin to the Scottburgh admin PIN (at least 6 characters) before running this.';
  end if;

  if exists (select 1 from public.leagues where id = v_league) then
    raise exception 'The % league already exists. Delete it first, or edit it in Admin.', v_league;
  end if;

  ---------------------------------------------------------------- the league
  insert into public.leagues (id, name, venue, season_start, season_end,
                              pace_target_date, pace_target_matches,
                              promo_discount, booking_url, results_locked,
                              is_owner, sort_order)
  values (v_league, 'Wi Padel Scottburgh Pairs League', v_venue, v_start, v_end,
          '2026-11-30', 4, v_discount, 'https://playtomic.io', false,
          false, 2);

  insert into public.league_admin (league_id, pin_hash)
  values (v_league, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));

  ------------------------------------------------------------- the divisions
  -- All three play a single round robin: 10 pairs, 45 matches, 9 each.
  insert into public.divisions (id, league_id, slug, name, rating_label, meetings, sort_order)
  values
    (v_league || '-intermediate', v_league, 'intermediate', 'Intermediate', '1.5 - 3.0', 1, 1),
    (v_league || '-beginner',     v_league, 'beginner',     'Beginner',     '0 - 1.5',   1, 2),
    (v_league || '-ladies',       v_league, 'ladies',       'Ladies',       null,        1, 3);

  ----------------------------------------------------------------- the rules
  -- Same rules as Sherwood, with three deliberate differences:
  --   * the venue and the 10% discount
  --   * the pace date suits a 1 Nov to 31 Dec season
  --   * no "home and away" section, since no division here plays twice
  -- The Points section is kind 'scoring', which renders from the scoring engine
  -- rather than from text, so it cannot drift from the standings.
  insert into public.rule_sections (league_id, sort_order, heading, kind, body, visible)
  values
    -- format() rather than ||: adjacent string literals concatenate across
    -- lines, but an expression followed by a literal does not, so mixing the
    -- two inside one body would be a syntax error.
    (v_league, 10, 'Getting a match played', 'steps',
     format(
E'Find who you still have to play :: Your own page lists every fixture and who is still outstanding, with their numbers.\n'
'The pair marked "messages first" reaches out :: They propose two or three date and time options. Either pair can start the chat. The rule is only there to stop both sides waiting for the other.\n'
'Book a 90-minute court :: Either pair books at %s on Playtomic. All league bookings are %s off automatically. There is no code to enter.\n'
'Submit the score, then post it in the group :: One player enters it here straight after the match, and also posts the score in the WhatsApp group with the date and time you played. The table updates the moment it is submitted.',
       v_venue, v_discount),
     true),

    (v_league, 20, 'Match format', 'prose',
E'- Two regular sets. If the sets finish 1-1, a 10-point super tie-break decides the match (first to 10, win by 2).\n'
'- Star point at deuce (sudden death) to keep matches inside 60 to 90 minutes.\n'
'- A set is won at 6 games with two clear, or 7-5, or 7-6 on a tie-break.\n'
'- There is never a third full set.',
     true),

    (v_league, 30, 'Points', 'scoring', '', true),

    (v_league, 40, 'Pace', 'prose',
E'All your matches must be finished by 31 December. Aim to have about half of them played by 30 November, because leaving them to the end means fighting everyone else for the same courts.',
     true),

    (v_league, 50, 'Substitutes', 'prose',
E'A pair may use one substitute per match if a partner is injured or away, provided the substitute''s Playtomic rating is at or below the cap for that division.',
     true),

    (v_league, 60, 'Balls', 'prose',
E'Balls are not provided and are not included in your court booking. If you want a new tin for your match, the pairs buy it themselves. Split the cost between the two pairs, or make your own arrangement, as long as you sort it out before you play.',
     true),

    (v_league, 70, 'Scores', 'prose',
E'- Either player from the winning pair submits the result here.\n'
'- Post the score in the WhatsApp group as well, with the date and time the match was played.\n'
'- A match can only be submitted once. If something is wrong, ask the organiser to correct it.\n'
'- A photo of the scorecard in the group is welcome. The record that counts is the one here.',
     true),

    (v_league, 80, 'A few pointers', 'prose',
E'- Book the court as soon as you agree a time. Slots get scarce towards the end of the season.\n'
'- Get there a few minutes early. Your warm up comes out of the 90 minutes.\n'
'- If you have to call a match off, tell your opponents as early as you can and offer another time.\n'
'- Message the other pair directly instead of asking in the group. Their numbers are on the Contacts page.\n'
'- Check the grid now and then to see who you still owe a match.',
     true);

  raise notice 'Scottburgh created: 3 divisions, 8 rule sections. Add the pairs, then generate fixtures.';
end $$;

-- Check it landed:
--   select id, name, venue, season_start, season_end, promo_discount from leagues;
--   select id, name, meetings from divisions where league_id = 'scottburgh' order by sort_order;
--   select sort_order, heading, kind from rule_sections where league_id = 'scottburgh' order by sort_order;
