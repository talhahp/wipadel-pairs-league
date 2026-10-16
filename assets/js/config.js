/**
 * Connection settings.
 *
 * Fill these in with your Supabase project URL and the *anon* (public) key from
 *   Supabase dashboard -> Project Settings -> API
 *
 * Both values are meant to be public - they ship inside the page. The database
 * is protected by row level security and the PIN-gated functions in
 * supabase/01_schema.sql, not by hiding this key.
 *
 * Leave them blank to run the site in DEMO mode: it loads a sample league into
 * your own browser so you can click everything before wiring up the database.
 * Nothing in demo mode is shared with anyone else.
 */
export const SUPABASE_URL = 'https://kgeoxlkuiarsxeyjswxq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_UNir-PFZhtRWC8zwXG_Xig_6_PR92eB';

/**
 * The site, not any one league. Venue, season and dates come from whichever
 * league is being viewed, so nothing here names a club.
 */
export const BRAND = {
  site: 'Wi Padel Leagues and Events',
  short: 'Leagues & Events',
};
