/**
 * Data layer.
 *
 * Two interchangeable backends behind one API:
 *
 *   live  - Supabase. Reads go straight at the tables (which are public to
 *           read); every write goes through the SECURITY DEFINER functions in
 *           supabase/01_schema.sql.
 *   demo  - a sample league kept in this browser's localStorage, used when
 *           config.js has no credentials. Lets the whole site be clicked
 *           through before the database exists.
 *
 * Views never branch on which backend is active.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { buildFixtures, scoreMatch } from './core.js';

const DEMO_KEY = 'wipadel.demo.v1';
// Pinned to the v2 major rather than an exact patch: Supabase's newer
// "publishable" keys (sb_publishable_...) are only understood by recent 2.x
// releases, and an exact pin here would reject them.
const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';

export const state = {
  mode: 'demo',          // 'live' | 'demo'
  divisions: [],
  teams: [],
  matches: [],
  settings: null,
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

export async function init() {
  if (configured()) {
    const { createClient } = await import(SUPABASE_ESM);
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    state.mode = 'live';
  } else {
    state.mode = 'demo';
  }
  await refresh();
}

export async function refresh() {
  if (isLive()) {
    const [divisions, teams, matches, settings] = await Promise.all([
      sel('divisions', 'sort_order'),
      sel('teams', 'seed'),
      sel('matches', 'match_no'),
      sel('league_settings', 'id'),
    ]);
    state.divisions = divisions;
    state.teams = teams;
    state.matches = matches;
    state.settings = settings[0] || demoSettings();
  } else {
    const snap = loadDemo();
    state.divisions = snap.divisions;
    state.teams = snap.teams;
    state.matches = snap.matches;
    state.settings = snap.settings;
  }
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
  const msg = error?.message || error?.hint || fallback;
  const e = new Error(msg);
  e.cause = error;
  return e;
}

/* --------------------------------------------------------------- derived reads */

export function divisionTeams(divisionId) {
  return state.teams
    .filter((t) => t.division_id === divisionId)
    .sort((a, b) => a.seed - b.seed);
}

export function divisionMatches(divisionId) {
  return state.matches
    .filter((m) => m.division_id === divisionId)
    .sort((a, b) => a.match_no - b.match_no);
}

export function teamsById() {
  return new Map(state.teams.map((t) => [t.id, t]));
}

export function findTeam(id) {
  return state.teams.find((t) => t.id === id) || null;
}

/* ------------------------------------------------------------- player writes */

/**
 * Submit a result for a fixture that has not been played yet.
 * @param {object} payload { matchId, s1_home, s1_away, s2_home, s2_away, stb_home, stb_away, played_on, submitted_by }
 */
export async function submitResult(payload) {
  const row = {
    s1_home: toInt(payload.s1_home),
    s1_away: toInt(payload.s1_away),
    s2_home: toInt(payload.s2_home),
    s2_away: toInt(payload.s2_away),
    stb_home: toInt(payload.stb_home),
    stb_away: toInt(payload.stb_away),
  };

  // Validated here for a fast, specific error message; validated again in the
  // database, which is the copy that actually enforces the rules.
  const check = scoreMatch(row);
  if (!check.ok) throw new Error(check.errors.join('\n'));

  if (isLive()) {
    const { error } = await client.rpc('submit_result', {
      p_match_id: payload.matchId,
      p_s1_home: row.s1_home,
      p_s1_away: row.s1_away,
      p_s2_home: row.s2_home,
      p_s2_away: row.s2_away,
      p_stb_home: row.stb_home,
      p_stb_away: row.stb_away,
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

export async function adminCheck(pin) {
  if (isLive()) {
    const { data, error } = await client.rpc('admin_ok', { p_pin: pin });
    if (error) throw describe(error, 'Could not check that PIN');
    return data === true;
  }
  return pin === 'padel2026'; // demo only
}

export async function adminSaveTeam(pin, team) {
  if (isLive()) {
    const { error } = await client.rpc('admin_save_team', {
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
    if (team.id) {
      const t = snap.teams.find((x) => x.id === team.id);
      if (!t) throw new Error('That team does not exist.');
      Object.assign(t, {
        name: team.name,
        player1: team.player1 || '',
        player2: team.player2 || '',
        phone1: team.phone1 || null,
        phone2: team.phone2 || null,
        rating: team.rating === '' || team.rating == null ? null : Number(team.rating),
      });
    } else {
      const peers = snap.teams.filter((x) => x.division_id === team.division_id);
      snap.teams.push({
        id: crypto.randomUUID(),
        division_id: team.division_id,
        seed: peers.reduce((max, t) => Math.max(max, t.seed), 0) + 1,
        name: team.name,
        player1: team.player1 || '',
        player2: team.player2 || '',
        phone1: team.phone1 || null,
        phone2: team.phone2 || null,
        rating: team.rating === '' || team.rating == null ? null : Number(team.rating),
      });
    }
    saveDemo(snap);
  }
  await refresh();
}

export async function adminDeleteTeam(pin, teamId) {
  if (isLive()) {
    const { error } = await client.rpc('admin_delete_team', { p_pin: pin, p_team_id: teamId });
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

/** Build (or rebuild) a division's full round robin. */
export async function adminGenerateFixtures(pin, divisionId, force = false) {
  const ids = divisionTeams(divisionId).map((t) => t.id);
  if (ids.length < 2) throw new Error('Add at least two teams to this division first.');

  const fixtures = buildFixtures(divisionId, ids);

  if (isLive()) {
    const { data, error } = await client.rpc('admin_replace_fixtures', {
      p_pin: pin,
      p_division_id: divisionId,
      p_fixtures: fixtures,
      p_force: force,
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

export async function adminSetResult(pin, matchId, row, note) {
  const check = scoreMatch(row);
  if (!check.ok) throw new Error(check.errors.join('\n'));

  if (isLive()) {
    const { error } = await client.rpc('admin_set_result', {
      p_pin: pin,
      p_match_id: matchId,
      p_s1_home: toInt(row.s1_home),
      p_s1_away: toInt(row.s1_away),
      p_s2_home: toInt(row.s2_home),
      p_s2_away: toInt(row.s2_away),
      p_stb_home: toInt(row.stb_home),
      p_stb_away: toInt(row.stb_away),
      p_played_on: row.played_on || null,
      p_note: note || null,
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
    const { error } = await client.rpc('admin_clear_result', { p_pin: pin, p_match_id: matchId });
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

export async function adminUpdateSettings(pin, patch) {
  if (isLive()) {
    const { error } = await client.rpc('admin_update_settings', { p_pin: pin, p_patch: patch });
    if (error) throw describe(error, 'Could not save those settings');
  } else {
    const snap = loadDemo();
    Object.assign(snap.settings, patch);
    saveDemo(snap);
  }
  await refresh();
}

function blankScores() {
  return {
    s1_home: null, s1_away: null,
    s2_home: null, s2_away: null,
    stb_home: null, stb_away: null,
    played_on: null, submitted_by: null, submitted_at: null, note: null,
  };
}

/* ------------------------------------------------------------------ demo data */

function demoSettings() {
  return {
    id: 1,
    league_name: 'Wi Padel Sherwood Pairs League',
    venue: 'Wi Padel Sherwood',
    season_start: '2026-10-15',
    season_end: '2026-12-15',
    pace_target_date: '2026-11-15',
    pace_target_matches: 4,
    promo_discount: '20%',
    booking_url: 'https://playtomic.io',
    whatsapp_url: '',
    results_locked: false,
  };
}

/** The 10 Intermediate pairs from the league sheet, with sample phone numbers. */
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

/** A handful of plausible results so the demo table is not all zeroes. */
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

function buildDemo() {
  const teams = DEMO_INTERMEDIATE.map((row, i) => ({
    id: `demo-int-${i + 1}`,
    division_id: 'intermediate',
    seed: i + 1,
    name: row[0],
    player1: row[1],
    player2: row[2],
    rating: row[3],
    phone1: row[4],
    phone2: null,
  }));

  const matches = buildFixtures('intermediate', teams.map((t) => t.id))
    .map((f) => Object.assign({ id: `demo-m-${f.match_no}` }, f, blankScores()));

  for (const [no, a, b, c, d, e, f] of DEMO_RESULTS) {
    const m = matches.find((x) => x.match_no === no);
    if (!m) continue;
    Object.assign(m, {
      s1_home: a, s1_away: b, s2_home: c, s2_away: d, stb_home: e, stb_away: f,
      status: 'completed',
      played_on: '2026-10-20',
      submitted_by: 'Demo',
    });
  }

  return {
    divisions: [
      { id: 'intermediate', name: 'Intermediate', rating_label: '1.5 - 3.0', sort_order: 1 },
      { id: 'beginner', name: 'Beginner', rating_label: '0 - 1.5', sort_order: 2 },
    ],
    teams,
    matches,
    settings: demoSettings(),
  };
}

function loadDemo() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap && Array.isArray(snap.teams) && Array.isArray(snap.matches)) return snap;
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

/** Throw the demo league away and start again from the sample data. */
export async function resetDemo() {
  try {
    localStorage.removeItem(DEMO_KEY);
  } catch { /* ignore */ }
  await refresh();
}

/* -------------------------------------------------------- remembered identity */

const MY_TEAM_KEY = 'wipadel.myTeam';

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
