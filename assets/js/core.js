/**
 * Pure league logic: set validation, match scoring, standings, round-robin fixtures.
 *
 * No DOM, no network - so it runs identically in the browser and under `node --test`.
 *
 * Scoring (Wi Padel Sherwood Pairs League):
 *   - 1 point for every FULL set won.
 *   - 1 extra point to the team that wins the match.
 *   - The 10-point super tie-break is NOT a set; it only decides the match.
 *   => 2-0 win: 3 pts / 0 pts.   1-1 + super tie-break: 2 pts / 1 pt.
 *   Every match therefore distributes exactly 3 points.
 */

export const SCORING = {
  pointPerSet: 1,
  pointForMatchWin: 1,
  pointsPerMatch: 3,
};

/** Sort keys used to break ties, in order of application. */
export const TIEBREAKERS = [
  'Total points',
  'Head-to-head points',
  'Sets won',
  'Game difference',
  'Team name',
];

/* ---------------------------------------------------------------- validation */

function isCount(n) {
  return Number.isInteger(n) && n >= 0 && n <= 30;
}

/**
 * A padel set runs to 6, win by 2, with a tie-break at 6-6.
 * Legal finished sets: 6-0 to 6-4, 7-5, 7-6.
 */
export function validateSet(a, b, label = 'Set') {
  if (!isCount(a) || !isCount(b)) return label + ': enter both game scores.';
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi === lo) return label + ': a set cannot be drawn (' + a + '-' + b + ').';
  const legal = (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6));
  if (!legal) {
    return label + ': ' + a + '-' + b + ' is not a completed padel set (6-0 to 6-4, 7-5 or 7-6).';
  }
  return null;
}

/** The super tie-break is first to 10, win by 2 (so 10-8, 11-9, 13-11 ...). */
export function validateTieBreak(a, b) {
  if (!isCount(a) || !isCount(b)) return 'Super tie-break: enter both scores.';
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi < 10) return 'Super tie-break: the winner needs at least 10 points (got ' + a + '-' + b + ').';
  if (hi - lo < 2) return 'Super tie-break: must be won by 2 clear points (got ' + a + '-' + b + ').';
  if (hi > 10 && hi - lo > 2) {
    return 'Super tie-break: ' + a + '-' + b + ' cannot happen - play stops at 2 clear points.';
  }
  return null;
}

/* ------------------------------------------------------------------- scoring */

function num(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Turn a raw scoreline into sets, games, winner and league points.
 *
 * @param {object} raw - { s1_home, s1_away, s2_home, s2_away, stb_home, stb_away }
 * @returns {{ok: boolean, errors: string[], needsTieBreak: boolean}} plus the
 *          derived figures when `ok` is true.
 */
export function scoreMatch(raw) {
  const s1h = num(raw.s1_home), s1a = num(raw.s1_away);
  const s2h = num(raw.s2_home), s2a = num(raw.s2_away);
  const tbh = num(raw.stb_home), tba = num(raw.stb_away);

  const errors = [];
  const e1 = validateSet(s1h, s1a, 'Set 1');
  const e2 = validateSet(s2h, s2a, 'Set 2');
  if (e1) errors.push(e1);
  if (e2) errors.push(e2);

  if (errors.length) return { ok: false, errors, needsTieBreak: false };

  const setsHome = (s1h > s1a ? 1 : 0) + (s2h > s2a ? 1 : 0);
  const setsAway = 2 - setsHome;
  const needsTieBreak = setsHome === 1;

  const hasTieBreak = isCount(tbh) && isCount(tba);
  if (needsTieBreak) {
    const eTb = validateTieBreak(tbh, tba);
    if (eTb) errors.push(eTb);
  } else if (hasTieBreak) {
    errors.push('Super tie-break: not played - the match was won in straight sets.');
  }

  if (errors.length) return { ok: false, errors, needsTieBreak };

  const homeWon = needsTieBreak ? tbh > tba : setsHome === 2;

  // Game difference counts the two full sets only; the tie-break is not games.
  const gamesHome = s1h + s2h;
  const gamesAway = s1a + s2a;

  return {
    ok: true,
    errors: [],
    needsTieBreak,
    setsHome,
    setsAway,
    gamesHome,
    gamesAway,
    homeWon,
    pointsHome: setsHome * SCORING.pointPerSet + (homeWon ? SCORING.pointForMatchWin : 0),
    pointsAway: setsAway * SCORING.pointPerSet + (homeWon ? 0 : SCORING.pointForMatchWin),
  };
}

/** Short human scoreline, e.g. "6-4, 3-6, 10-7". */
export function formatScoreline(raw) {
  const parts = [
    raw.s1_home + '-' + raw.s1_away,
    raw.s2_home + '-' + raw.s2_away,
  ];
  if (raw.stb_home !== null && raw.stb_home !== undefined && raw.stb_home !== '') {
    parts.push(raw.stb_home + '-' + raw.stb_away);
  }
  return parts.join(', ');
}

/* ----------------------------------------------------------------- standings */

function blankRow() {
  return {
    played: 0, won: 0, lost: 0,
    setsWon: 0, setsLost: 0,
    gamesFor: 0, gamesAgainst: 0,
    points: 0,
  };
}

/**
 * Build a sorted league table.
 *
 * @param {Array} teams   - [{ id, name }]
 * @param {Array} matches - [{ home_team, away_team, status, s1_home, ... }]
 * @returns {Array} rows in rank order, each carrying `rank`, `h2hPoints`, `tiedWith`
 */
export function buildStandings(teams, matches) {
  const rows = new Map();
  for (const t of teams) rows.set(t.id, Object.assign({ team: t }, blankRow()));

  // head-to-head: h2h[a][b] = points `a` took from `b`
  const h2h = new Map();
  const addH2h = (a, b, pts) => {
    if (!h2h.has(a)) h2h.set(a, new Map());
    const inner = h2h.get(a);
    inner.set(b, (inner.get(b) || 0) + pts);
  };

  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const home = rows.get(m.home_team);
    const away = rows.get(m.away_team);
    if (!home || !away) continue; // result for a team that has since been removed

    const s = scoreMatch(m);
    if (!s.ok) continue; // never let one bad row poison the whole table

    home.played++; away.played++;
    home.setsWon += s.setsHome; home.setsLost += s.setsAway;
    away.setsWon += s.setsAway; away.setsLost += s.setsHome;
    home.gamesFor += s.gamesHome; home.gamesAgainst += s.gamesAway;
    away.gamesFor += s.gamesAway; away.gamesAgainst += s.gamesHome;
    home.points += s.pointsHome; away.points += s.pointsAway;
    if (s.homeWon) { home.won++; away.lost++; } else { away.won++; home.lost++; }

    addH2h(m.home_team, m.away_team, s.pointsHome);
    addH2h(m.away_team, m.home_team, s.pointsAway);
  }

  const table = [...rows.values()].map((r) => Object.assign({}, r, {
    gamesDiff: r.gamesFor - r.gamesAgainst,
  }));

  // Points first, then resolve each equal-points block on its own merits.
  table.sort((a, b) => b.points - a.points || a.team.name.localeCompare(b.team.name));

  const ordered = [];
  let i = 0;
  while (i < table.length) {
    let j = i;
    while (j + 1 < table.length && table[j + 1].points === table[i].points) j++;
    const block = table.slice(i, j + 1);

    if (block.length > 1) {
      const ids = new Set(block.map((r) => r.team.id));
      for (const r of block) {
        const inner = h2h.get(r.team.id);
        r.h2hPoints = inner
          ? [...inner].reduce((sum, entry) => (ids.has(entry[0]) ? sum + entry[1] : sum), 0)
          : 0;
        r.tiedWith = block.length - 1;
      }
      block.sort((a, b) =>
        b.h2hPoints - a.h2hPoints ||
        b.setsWon - a.setsWon ||
        b.gamesDiff - a.gamesDiff ||
        a.team.name.localeCompare(b.team.name));
    } else {
      block[0].h2hPoints = 0;
      block[0].tiedWith = 0;
    }

    ordered.push(...block);
    i = j + 1;
  }

  ordered.forEach((r, idx) => { r.rank = idx + 1; });
  return ordered;
}

/* ------------------------------------------------------------------ fixtures */

/**
 * Round-robin schedule by the circle method.
 * 10 teams -> 9 rounds of 5 matches = 45 fixtures, every pair exactly once.
 *
 * "Home" here only means which team is asked to make first contact, so it must
 * be shared out evenly. The circle method decides WHO plays whom; orientation
 * is then decided by `hostsFirst` below, which is regular by construction.
 * (Alternating on round parity leaves the wheel's fixed seat hosting almost
 * never, and greedy balancing still drifts to a spread of three.)
 *
 * @param {Array<string>} teamIds
 * @returns {Array<Array<Array<string>>>} rounds of [homeId, awayId]
 */
export function roundRobin(teamIds) {
  const real = [...teamIds];
  if (real.length < 2) return [];

  const seat = new Map(real.map((id, i) => [id, i]));
  const ids = [...real];
  if (ids.length % 2 === 1) ids.push(null); // odd count -> one bye per round

  const n = ids.length;
  let wheel = ids;
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = wheel[i];
      const b = wheel[n - 1 - i];
      if (a === null || b === null) continue; // bye
      pairs.push(hostsFirst(a, b, seat, real.length) ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    wheel = [wheel[0], wheel[n - 1], ...wheel.slice(1, n - 1)]; // rotate, first seat fixed
  }

  return rounds;
}

/**
 * Does `a` host `b`? Decided by the gap between their seats around a circle of
 * `n` teams: a hosts when b sits within the next half-turn clockwise.
 *
 * Because every pair meets exactly once, this makes hosting counts regular -
 * with 10 teams the first five host 5 and the rest host 4. The `d === half`
 * case is the one genuinely symmetric gap (team i vs i+5), so it needs an
 * explicit tiebreak or both sides would claim it.
 */
function hostsFirst(a, b, seat, n) {
  const i = seat.get(a);
  const j = seat.get(b);
  const d = ((j - i) % n + n) % n;
  const half = n / 2;
  if (n % 2 === 0 && d === half) return i < half;
  return d < half;
}

/**
 * Flatten a round-robin into numbered fixture rows ready for the database.
 * The designated home team is the one responsible for reaching out first.
 */
export function buildFixtures(divisionId, teamIds) {
  const rounds = roundRobin(teamIds);
  const out = [];
  let no = 1;
  rounds.forEach((pairs, idx) => {
    for (const pair of pairs) {
      out.push({
        division_id: divisionId,
        round: idx + 1,
        match_no: no++,
        home_team: pair[0],
        away_team: pair[1],
        status: 'pending',
      });
    }
  });
  return out;
}

/* -------------------------------------------------------------------- extras */

/** Progress summary for a division. */
export function divisionProgress(teams, matches) {
  const total = matches.length;
  const played = matches.filter((m) => m.status === 'completed').length;
  return {
    teams: teams.length,
    total,
    played,
    remaining: total - played,
    percent: total ? Math.round((played / total) * 100) : 0,
  };
}

/** Whole-number days from today until `isoDate` (negative once it has passed). */
export function daysUntil(isoDate, today = new Date()) {
  const end = new Date(isoDate + 'T00:00:00');
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((end - start) / 86400000);
}

/** One team's own fixture list: still to play first, then completed. */
export function teamSchedule(teamId, matches, teamsById) {
  return matches
    .filter((m) => m.home_team === teamId || m.away_team === teamId)
    .map((m) => {
      const isHome = m.home_team === teamId;
      const oppId = isHome ? m.away_team : m.home_team;
      const s = m.status === 'completed' ? scoreMatch(m) : null;
      let result = null;
      if (s && s.ok) result = (isHome ? s.homeWon : !s.homeWon) ? 'won' : 'lost';
      return {
        match: m,
        isHome,
        hosting: isHome,
        opponent: teamsById.get(oppId) || null,
        result,
        points: s && s.ok ? (isHome ? s.pointsHome : s.pointsAway) : null,
      };
    })
    .sort((a, b) => {
      const ap = a.match.status === 'completed' ? 1 : 0;
      const bp = b.match.status === 'completed' ? 1 : 0;
      return ap - bp || a.match.match_no - b.match.match_no;
    });
}
