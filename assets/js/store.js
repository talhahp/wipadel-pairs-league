/**
 * Data layer.
 *
 * Two interchangeable backends behind one API:
 *
 *   live  - Supabase. Reads go straight at the tables (which are public to
 *           read); every write goes through the SECURITY DEFINER functions in
 *           supabase/04_functions.sql.
 *   demo  - a sample league kept in this browser's localStorage, used when
 *           config.js has no credentials. Lets the whole site be clicked
 *           through before the database exists.
 *
 * The database holds more than one league, one per venue. Everything the views
 * read is already narrowed to the league in `state.leagueId`, so a view never
 * has to filter by league itself. Admin screens use the `all*` collections.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { buildFixtures, scoreMatch } from './core.js';

const DEMO_KEY = 'wipadel.demo.v2';
const LEAGUE_KEY = 'wipadel.league';
const MY_TEAM_KEY = 'wipadel.myTeam';
const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';

export const state = {
  mode: 'demo',          // 'live' | 'demo'
  leagues: [],
  leagueId: null,
  league: null,
  divisions: [],         // current league only
  teams: [],             // current league only
  matches: [],           // current league only
  rules: [],             // current league only
  allDivisions: [],
  allTeams: [],
  allMatches: [],
  loadedAt: null,
};

let client = null;

export function isLive() {
  return state.mode === 'live';
}

export function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/* ------------------------------------------------------------------ bootstrap */

export async function init(preferredLeague) {
  if (configured()) {
    const { createClient } = await import(SUPABASE_ESM);
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    state.mode = 'live';
  } else {
    state.mode = 'demo';
  }
  await refresh(preferredLeague);
}

export async function refresh(preferredLeague) {
  if (isLive()) {
    const [leagues, divisions, teams, matches, rules] = await Promise.all([
      sel('leagues', 'sort_order'),
      sel('divisions', 'sort_order'),
      sel('teams', 'seed'),
      sel('matches', 'match_no'),
      sel('rule_sections', 'sort_order'),
    ]);
    state.leagues = leagues;
    state.allDivisions = divisions;
    state.allTeams = teams;
    state.allMatches = matches;
    state._rules = rules;
  } else {
    const snap = loadDemo();
    state.leagues = snap.leagues;
    state.allDivisions = snap.divisions;
    state.allTeams = snap.teams;
    state.allMatches = snap.matches;
    state._rules = snap.rules;
  }

  selectLeague(preferredLeague || state.leagueId || rememberedLeague());
  state.loadedAt = new Date();
  return state;
}

async function sel(table, order) {
  const { data, error } = await client.from(table).select('*').order(order, { ascending: true });
  if (error) throw describe(error, `Could not load ${table}`);
  return data || [];
}

/** Supabase errors are objects, not Errors - turn them into something throwable. */
function describe(error, fallback) {
  // PGRST202 means the database has no function with that signature. In practice
  // that is a browser running JavaScript from before a migration, since GitHub
  // Pages serves assets with a ten minute cache. Say so, rather than letting it
  // surface as "wrong PIN" or "could not save".
  if (error?.code === 'PGRST202') {
    const e = new Error(
      'This page is running an older version of the site, from before the last update. ' +
      'Reload it and try again.');
    e.cause = error;
    e.stale = true;        // the screen offers a reload button for these
    return e;
  }
  const msg = error?.message || error?.hint || fallback;
  const e = new Error(msg);
  e.cause = error;
  return e;
}

/* --------------------------------------------------------------- league scope */

function rememberedLeague() {
  try {
    return localStorage.getItem(LEAGUE_KEY) || null;
  } catch {
    return null;
  }
}

export function knowsLeague(id) {
  return state.leagues.some((l) => l.id === id);
}

/** Narrow every collection to one league. Falls back to the first league. */
export function selectLeague(id) {
  const league = state.leagues.find((l) => l.id === id) || state.leagues[0] || null;
  state.league = league;
  state.leagueId = league ? league.id : null;

  const divisions = state.allDivisions.filter((d) => d.league_id === state.leagueId);
  const divisionIds = new Set(divisions.map((d) => d.id));

  state.divisions = divisions;
  state.teams = state.allTeams.filter((t) => divisionIds.has(t.division_id));
  state.matches = state.allMatches.filter((m) => divisionIds.has(m.division_id));
  state.rules = (state._rules || []).filter((r) => r.league_id === state.leagueId);

  try {
    if (state.leagueId) localStorage.setItem(LEAGUE_KEY, state.leagueId);
  } catch { /* ignore */ }

  return league;
}

/* --------------------------------------------------------------- derived reads */

export function divisionTeams(divisionId) {
  return state.allTeams
    .filter((t) => t.division_id === divisionId)
    .sort((a, b) => a.seed - b.seed);
}

export function divisionMatches(divisionId) {
  return state.allMatches
    .filter((m) => m.division_id === divisionId)
    .sort((a, b) => a.match_no - b.match_no);
}

export function findDivision(id) {
  return state.allDivisions.find((d) => d.id === id) || null;
}

export function teamsById() {
  return new Map(state.allTeams.map((t) => [t.id, t]));
}

export function findTeam(id) {
  return state.allTeams.find((t) => t.id === id) || null;
}

/** Which league a team belongs to, used when a remembered team is from elsewhere. */
export function leagueOfTeam(teamId) {
  const team = findTeam(teamId);
  if (!team) return null;
  const division = findDivision(team.division_id);
  return division ? division.league_id : null;
}

/* ------------------------------------------------------------- player writes */

export async function submitResult(payload) {
  const row = {
    s1_home: toInt(payload.s1_home), s1_away: toInt(payload.s1_away),
    s2_home: toInt(payload.s2_home), s2_away: toInt(payload.s2_away),
    stb_home: toInt(payload.stb_home), stb_away: toInt(payload.stb_away),
  };

  // Validated here for a fast, specific error message; validated again in the
  // database, which is the copy that actually enforces the rules.
  const check = scoreMatch(row);
  if (!check.ok) throw new Error(check.errors.join('\n'));

  if (isLive()) {
    const { error } = await client.rpc('submit_result', {
      p_match_id: payload.matchId,
      p_s1_home: row.s1_home, p_s1_away: row.s1_away,
      p_s2_home: row.s2_home, p_s2_away: row.s2_away,
      p_stb_home: row.stb_home, p_stb_away: row.stb_away,
      p_played_on: payload.played_on || null,
      p_submitted_by: payload.submitted_by || null,
    });
    if (error) throw describe(error, 'Could not save that result');
  } else {
    const snap = loadDemo();
    const m = snap.matches.find((x) => x.id === payload.matchId);
    if (!m) throw new Error('That fixture does not exist.');
    if (m.status === 'completed') {
      throw new Error(`Match ${m.match_no} already has a result. Ask the organiser to correct it.`);
    }
    Object.assign(m, row, {
      status: 'completed',
      played_on: payload.played_on || today(),
      submitted_by: payload.submitted_by || null,
      submitted_at: new Date().toISOString(),
    });
    saveDemo(snap);
  }

  await refresh();
}

function toInt(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* -------------------------------------------------------------- admin writes */

function rpc(name, args) {
  return client.rpc(name, Object.assign({ p_league_id: state.leagueId }, args));
}

export async function adminCheck(pin) {
  if (isLive()) {
    const { data, error } = await client.rpc('admin_ok', {
      p_league_id: state.leagueId, p_pin: pin,
    });
    if (error) throw describe(error, 'Could not check that PIN');
    return data === true;
  }
  return pin === 'padel2026'; // demo only
}

export async function adminSaveTeam(pin, team) {
  if (isLive()) {
    const { error } = await rpc('admin_save_team', {
      p_pin: pin,
      p_division_id: team.division_id,
      p_name: team.name,
      p_player1: team.player1 || '',
      p_player2: team.player2 || '',
      p_phone1: team.phone1 || null,
      p_phone2: team.phone2 || null,
      p_rating: team.rating === '' || team.rating == null ? null : Number(team.rating),
      p_seed: team.seed ?? null,
      p_team_id: team.id ?? null,
    });
    if (error) throw describe(error, 'Could not save that team');
  } else {
    const snap = loadDemo();
    const fields = {
      name: team.name,
      player1: team.player1 || '', player2: team.player2 || '',
      phone1: team.phone1 || null, phone2: team.phone2 || null,
      rating: team.rating === '' || team.rating == null ? null : Number(team.rating),
    };
    if (team.id) {
      const t = snap.teams.find((x) => x.id === team.id);
      if (!t) throw new Error('That team does not exist.');
      Object.assign(t, fields);
    } else {
      const peers = snap.teams.filter((x) => x.division_id === team.division_id);
      snap.teams.push(Object.assign({
        id: crypto.randomUUID(),
        division_id: team.division_id,
        seed: peers.reduce((max, t) => Math.max(max, t.seed), 0) + 1,
      }, fields));
    }
    saveDemo(snap);
  }
  await refresh();
}

export async function adminDeleteTeam(pin, teamId) {
  if (isLive()) {
    const { error } = await rpc('admin_delete_team', { p_pin: pin, p_team_id: teamId });
    if (error) throw describe(error, 'Could not remove that team');
  } else {
    const snap = loadDemo();
    const played = snap.matches.filter(
      (m) => (m.home_team === teamId || m.away_team === teamId) && m.status === 'completed');
    if (played.length) {
      throw new Error(`That team already has ${played.length} completed result(s). Clear them first.`);
    }
    snap.teams = snap.teams.filter((t) => t.id !== teamId);
    snap.matches = snap.matches.filter((m) => m.home_team !== teamId && m.away_team !== teamId);
    saveDemo(snap);
  }
  await refresh();
}

/* ------------------------------------------------------------- divisions */

export async function adminSaveDivision(pin, division) {
  if (isLive()) {
    const { error } = await rpc('admin_save_division', {
      p_pin: pin,
      p_slug: division.slug,
      p_name: division.name,
      p_rating_label: division.rating_label || null,
      p_meetings: Number(division.meetings) || 1,
      p_sort_order: Number(division.sort_order) || 0,
      p_division_id: division.id || null,
    });
    if (error) throw describe(error, 'Could not save that division');
  } else {
    const snap = loadDemo();
    const fields = {
      name: division.name,
      slug: division.slug,
      rating_label: division.rating_label || null,
      meetings: Number(division.meetings) || 1,
      sort_order: Number(division.sort_order) || 0,
    };
    if (division.id) {
      const d = snap.divisions.find((x) => x.id === division.id);
      if (!d) throw new Error('That division does not exist.');
      Object.assign(d, fields);
    } else {
      snap.divisions.push(Object.assign({
        id: `${state.leagueId}-${division.slug}`,
        league_id: state.leagueId,
      }, fields));
    }
    saveDemo(snap);
  }
  await refresh();
}

export async function adminDeleteDivision(pin, divisionId) {
  if (isLive()) {
    const { error } = await rpc('admin_delete_division', { p_pin: pin, p_division_id: divisionId });
    if (error) throw describe(error, 'Could not remove that division');
  } else {
    const snap = loadDemo();
    const played = snap.matches.filter((m) => m.division_id === divisionId && m.status === 'completed');
    if (played.length) {
      throw new Error(`That division has ${played.length} completed result(s). Clear them first.`);
    }
    snap.divisions = snap.divisions.filter((d) => d.id !== divisionId);
    const gone = new Set(snap.teams.filter((t) => t.division_id === divisionId).map((t) => t.id));
    snap.teams = snap.teams.filter((t) => t.division_id !== divisionId);
    snap.matches = snap.matches.filter(
      (m) => m.division_id !== divisionId && !gone.has(m.home_team) && !gone.has(m.away_team));
    saveDemo(snap);
  }
  await refresh();
}

/** Build (or rebuild) a division's fixtures, honouring how often pairs meet. */
export async function adminGenerateFixtures(pin, divisionId, force = false) {
  const division = findDivision(divisionId);
  if (!division) throw new Error('That division does not exist.');
  const ids = divisionTeams(divisionId).map((t) => t.id);
  if (ids.length < 2) throw new Error('Add at least two teams to this division first.');

  const fixtures = buildFixtures(divisionId, ids, division.meetings || 1);

  if (isLive()) {
    const { data, error } = await rpc('admin_replace_fixtures', {
      p_pin: pin, p_division_id: divisionId, p_fixtures: fixtures, p_force: force,
    });
    if (error) throw describe(error, 'Could not generate fixtures');
    await refresh();
    return data;
  }

  const snap = loadDemo();
  const played = snap.matches.filter((m) => m.division_id === divisionId && m.status === 'completed');
  if (played.length && !force) {
    throw new Error(
      `${played.length} result(s) have already been played in this division. ` +
      'Regenerating fixtures would erase them.');
  }
  snap.matches = snap.matches
    .filter((m) => m.division_id !== divisionId)
    .concat(fixtures.map((f) => Object.assign({ id: crypto.randomUUID() }, f, blankScores())));
  saveDemo(snap);
  await refresh();
  return fixtures.length;
}

/* --------------------------------------------------------------- results */

export async function adminSetResult(pin, matchId, row, note) {
  const check = scoreMatch(row);
  if (!check.ok) throw new Error(check.errors.join('\n'));

  if (isLive()) {
    const { error } = await rpc('admin_set_result', {
      p_pin: pin, p_match_id: matchId,
      p_s1_home: toInt(row.s1_home), p_s1_away: toInt(row.s1_away),
      p_s2_home: toInt(row.s2_home), p_s2_away: toInt(row.s2_away),
      p_stb_home: toInt(row.stb_home), p_stb_away: toInt(row.stb_away),
      p_played_on: row.played_on || null, p_note: note || null,
    });
    if (error) throw describe(error, 'Could not save that result');
  } else {
    const snap = loadDemo();
    const m = snap.matches.find((x) => x.id === matchId);
    if (!m) throw new Error('That fixture does not exist.');
    Object.assign(m, {
      s1_home: toInt(row.s1_home), s1_away: toInt(row.s1_away),
      s2_home: toInt(row.s2_home), s2_away: toInt(row.s2_away),
      stb_home: toInt(row.stb_home), stb_away: toInt(row.stb_away),
      status: 'completed',
      played_on: row.played_on || m.played_on || today(),
      note: note || null,
      submitted_by: m.submitted_by || 'organiser',
      submitted_at: new Date().toISOString(),
    });
    saveDemo(snap);
  }
  await refresh();
}

export async function adminClearResult(pin, matchId) {
  if (isLive()) {
    const { error } = await rpc('admin_clear_result', { p_pin: pin, p_match_id: matchId });
    if (error) throw describe(error, 'Could not clear that result');
  } else {
    const snap = loadDemo();
    const m = snap.matches.find((x) => x.id === matchId);
    if (!m) throw new Error('That fixture does not exist.');
    Object.assign(m, blankScores(), { status: 'pending' });
    saveDemo(snap);
  }
  await refresh();
}

/* -------------------------------------------------------------- settings */

export async function adminUpdateLeague(pin, patch) {
  if (isLive()) {
    const { error } = await rpc('admin_update_league', { p_pin: pin, p_patch: patch });
    if (error) throw describe(error, 'Could not save those settings');
  } else {
    const snap = loadDemo();
    const l = snap.leagues.find((x) => x.id === state.leagueId);
    if (l) Object.assign(l, patch);
    saveDemo(snap);
  }
  await refresh();
}

/* ----------------------------------------------------------- rules text */

export async function adminSaveRule(pin, rule) {
  if (isLive()) {
    const { error } = await rpc('admin_save_rule', {
      p_pin: pin,
      p_heading: rule.heading,
      p_body: rule.body || '',
      p_kind: rule.kind || 'prose',
      p_sort_order: rule.sort_order ?? null,
      p_visible: rule.visible !== false,
      p_rule_id: rule.id || null,
    });
    if (error) throw describe(error, 'Could not save that section');
  } else {
    const snap = loadDemo();
    const fields = {
      heading: rule.heading, body: rule.body || '',
      kind: rule.kind || 'prose', visible: rule.visible !== false,
    };
    if (rule.id) {
      const r = snap.rules.find((x) => x.id === rule.id);
      if (!r) throw new Error('That section does not exist.');
      Object.assign(r, fields);
    } else {
      const mine = snap.rules.filter((r) => r.league_id === state.leagueId);
      snap.rules.push(Object.assign({
        id: crypto.randomUUID(),
        league_id: state.leagueId,
        sort_order: mine.reduce((m, r) => Math.max(m, r.sort_order), 0) + 10,
      }, fields));
    }
    saveDemo(snap);
  }
  await refresh();
}

export async function adminDeleteRule(pin, ruleId) {
  if (isLive()) {
    const { error } = await rpc('admin_delete_rule', { p_pin: pin, p_rule_id: ruleId });
    if (error) throw describe(error, 'Could not remove that section');
  } else {
    const snap = loadDemo();
    snap.rules = snap.rules.filter((r) => r.id !== ruleId);
    saveDemo(snap);
  }
  await refresh();
}

/** Move one section up or down among the league's sections. */
export async function adminMoveRule(pin, ruleId, direction) {
  const ordered = [...state.rules].sort((a, b) => a.sort_order - b.sort_order);
  const i = ordered.findIndex((r) => r.id === ruleId);
  const j = i + (direction === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= ordered.length) return;
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  const ids = ordered.map((r) => r.id);

  if (isLive()) {
    const { error } = await rpc('admin_reorder_rules', { p_pin: pin, p_ids: ids });
    if (error) throw describe(error, 'Could not reorder the sections');
  } else {
    const snap = loadDemo();
    ids.forEach((id, idx) => {
      const r = snap.rules.find((x) => x.id === id);
      if (r) r.sort_order = (idx + 1) * 10;
    });
    saveDemo(snap);
  }
  await refresh();
}

/* ------------------------------------------------------------ new leagues */

export async function adminCreateLeague(pin, league) {
  if (isLive()) {
    const { error } = await client.rpc('admin_create_league', {
      p_from_league: state.leagueId,
      p_pin: pin,
      p_new_id: league.id,
      p_name: league.name,
      p_venue: league.venue,
      p_season_start: league.season_start || null,
      p_season_end: league.season_end || null,
      p_new_pin: league.pin,
    });
    if (error) throw describe(error, 'Could not create that league');
  } else {
    const snap = loadDemo();
    if (snap.leagues.some((l) => l.id === league.id)) {
      throw new Error('A league with that key already exists.');
    }
    const from = snap.leagues.find((l) => l.id === state.leagueId);
    snap.leagues.push({
      id: league.id, name: league.name, venue: league.venue,
      season_start: league.season_start || from?.season_start,
      season_end: league.season_end || from?.season_end,
      promo_discount: from?.promo_discount, booking_url: from?.booking_url,
      results_locked: false, is_owner: false,
      sort_order: snap.leagues.length + 1,
    });
    for (const r of snap.rules.filter((r) => r.league_id === state.leagueId)) {
      snap.rules.push(Object.assign({}, r, { id: crypto.randomUUID(), league_id: league.id }));
    }
    saveDemo(snap);
  }
  await refresh();
}

function blankScores() {
  return {
    s1_home: null, s1_away: null, s2_home: null, s2_away: null,
    stb_home: null, stb_away: null,
    played_on: null, submitted_by: null, submitted_at: null, note: null,
  };
}

/* ------------------------------------------------------------------ demo data */

const DEMO_INTERMEDIATE = [
  ['Aktar / Ozayr', 'Aktar', 'Ozayr', 2.67, '+27 82 000 0001'],
  ['ILY.R / Muzakkir', 'ILY.R', 'Muzakkir', 2.65, '+27 82 000 0002'],
  ['Iqsaan / Ikram K.', 'Iqsaan', 'Ikram K.', 2.63, '+27 82 000 0003'],
  ['Kyle / Wesley', 'Kyle', 'Wesley', 2.55, '+27 82 000 0004'],
  ['Ryan / Nikhil', 'Ryan', 'Nikhil', 2.46, '+27 82 000 0005'],
  ['Ismail / Muhammad', 'Ismail', 'Muhammad', 2.39, '+27 82 000 0006'],
  ['JT / Rajiv', 'JT', 'Rajiv', 2.18, '+27 82 000 0007'],
  ['Mohamed / Tash', 'Mohamed', 'Tash', 2.01, '+27 82 000 0008'],
  ['Mohamed / Mohamed', 'Mohamed', 'Mohamed', 1.95, '+27 82 000 0009'],
  ['Hamza / Yahya', 'Hamza', 'Yahya', 1.80, '+27 82 000 0010'],
];

/** Five pairs playing each other twice, the small-division case. */
const DEMO_BEGINNER = [
  ['Sara / Nadia', 'Sara', 'Nadia', 1.30, '+27 82 000 0011'],
  ['Tom / Dev', 'Tom', 'Dev', 1.25, '+27 82 000 0012'],
  ['Zee / Kai', 'Zee', 'Kai', 1.10, '+27 82 000 0013'],
  ['Amy / Priya', 'Amy', 'Priya', 1.05, '+27 82 000 0014'],
  ['Luke / Sam', 'Luke', 'Sam', 0.95, '+27 82 000 0015'],
];

const DEMO_RESULTS = [
  [1, 6, 3, 6, 4, null, null],
  [2, 6, 4, 3, 6, 10, 8],
  [3, 7, 5, 6, 7, 9, 11],
  [4, 6, 0, 6, 2, null, null],
  [6, 6, 7, 4, 6, null, null],
  [7, 6, 4, 6, 4, null, null],
  [9, 7, 6, 6, 3, null, null],
  [11, 3, 6, 6, 4, 10, 6],
  [12, 6, 1, 6, 0, null, null],
  [14, 4, 6, 6, 7, null, null],
];

const DEMO_RULES = [
  [10, 'Getting a match played', 'steps',
    'Find who you still have to play :: Your own page lists every fixture and who is still outstanding, with their numbers.\n' +
    'The pair marked "messages first" reaches out :: They propose two or three date and time options. Either pair can start the chat.\n' +
    'Book a 90-minute court :: Either pair books on Playtomic. All league bookings are 20% off automatically. There is no code to enter.\n' +
    'Submit the score, then post it in the group :: One player enters it here, and also posts the score in the WhatsApp group with the date and time you played.'],
  [20, 'Match format', 'prose',
    '- Two regular sets. If the sets finish 1-1, a 10-point super tie-break decides the match (first to 10, win by 2).\n' +
    '- Star point at deuce (sudden death) to keep matches inside 60 to 90 minutes.\n' +
    '- A set is won at 6 games with two clear, or 7-5, or 7-6 on a tie-break.'],
  [30, 'Points', 'scoring', ''],
  [40, 'Balls', 'prose',
    'Balls are not provided and are not included in your court booking. If you want a new tin for your match, the pairs buy it themselves.'],
  [50, 'Scores', 'prose',
    '- Either player from the winning pair submits the result here.\n' +
    '- Post the score in the WhatsApp group as well, with the date and time the match was played.'],
];

function demoLeague(id, name, venue, order, owner) {
  return {
    id, name, venue,
    season_start: '2026-10-15', season_end: '2026-12-15',
    pace_target_date: '2026-11-15', pace_target_matches: 4,
    promo_discount: '20%', booking_url: 'https://playtomic.io', whatsapp_url: '',
    results_locked: false, is_owner: owner, sort_order: order,
  };
}

function buildDemo() {
  const leagues = [
    demoLeague('sherwood', 'Wi Padel Sherwood Pairs League', 'Wi Padel Sherwood', 1, true),
    demoLeague('scottburgh', 'Wi Padel Scottburgh Pairs League', 'Wi Padel Scottburgh', 2, false),
  ];

  const divisions = [
    { id: 'intermediate', league_id: 'sherwood', slug: 'intermediate', name: 'Intermediate', rating_label: '1.5 - 3.0', meetings: 1, sort_order: 1 },
    { id: 'beginner', league_id: 'sherwood', slug: 'beginner', name: 'Beginner', rating_label: '0 - 1.5', meetings: 2, sort_order: 2 },
    { id: 'scottburgh-open', league_id: 'scottburgh', slug: 'open', name: 'Open', rating_label: 'all ratings', meetings: 1, sort_order: 1 },
  ];

  const mk = (rows, divisionId, prefix) => rows.map((row, i) => ({
    id: `${prefix}-${i + 1}`,
    division_id: divisionId,
    seed: i + 1,
    name: row[0], player1: row[1], player2: row[2], rating: row[3],
    phone1: row[4], phone2: null,
  }));

  const teams = [
    ...mk(DEMO_INTERMEDIATE, 'intermediate', 'demo-int'),
    ...mk(DEMO_BEGINNER, 'beginner', 'demo-beg'),
  ];

  const matches = [];
  for (const d of divisions) {
    const ids = teams.filter((t) => t.division_id === d.id).map((t) => t.id);
    buildFixtures(d.id, ids, d.meetings).forEach((f) => {
      matches.push(Object.assign({ id: `demo-${d.id}-${f.match_no}` }, f, blankScores()));
    });
  }

  for (const [no, a, b, c, dd, e, f] of DEMO_RESULTS) {
    const m = matches.find((x) => x.division_id === 'intermediate' && x.match_no === no);
    if (!m) continue;
    Object.assign(m, {
      s1_home: a, s1_away: b, s2_home: c, s2_away: dd, stb_home: e, stb_away: f,
      status: 'completed', played_on: '2026-10-20', submitted_by: 'Demo',
    });
  }

  const rules = [];
  for (const league of leagues) {
    for (const [sort_order, heading, kind, body] of DEMO_RULES) {
      rules.push({
        id: `demo-rule-${league.id}-${sort_order}`,
        league_id: league.id, sort_order, heading, kind, body, visible: true,
      });
    }
  }

  return { leagues, divisions, teams, matches, rules };
}

function loadDemo() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap && Array.isArray(snap.leagues) && Array.isArray(snap.teams)) return snap;
    }
  } catch {
    // Private mode, blocked storage, or corrupt JSON - fall through to a fresh demo.
  }
  const fresh = buildDemo();
  saveDemo(fresh);
  return fresh;
}

function saveDemo(snap) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(snap));
  } catch {
    // Nothing to do: the demo just will not persist across reloads.
  }
}

export async function resetDemo() {
  try {
    localStorage.removeItem(DEMO_KEY);
  } catch { /* ignore */ }
  await refresh();
}

/* -------------------------------------------------------- remembered identity */

export function getMyTeamId() {
  try {
    return localStorage.getItem(MY_TEAM_KEY) || null;
  } catch {
    return null;
  }
}

export function setMyTeamId(id) {
  try {
    if (id) localStorage.setItem(MY_TEAM_KEY, id);
    else localStorage.removeItem(MY_TEAM_KEY);
  } catch { /* ignore */ }
}
