import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSet,
  validateTieBreak,
  scoreMatch,
  buildStandings,
  roundRobin,
  buildFixtures,
  divisionProgress,
  daysUntil,
  teamSchedule,
  SCORING,
} from '../assets/js/core.js';

/* ---------------------------------------------------------------- validation */

test('legal padel sets are accepted', () => {
  for (const [a, b] of [[6, 0], [6, 4], [7, 5], [7, 6], [0, 6], [5, 7], [6, 7]]) {
    assert.equal(validateSet(a, b), null, `${a}-${b} should be legal`);
  }
});

test('illegal padel sets are rejected', () => {
  for (const [a, b] of [[6, 5], [6, 6], [8, 6], [5, 4], [7, 4], [3, 3], [10, 8]]) {
    assert.ok(validateSet(a, b), `${a}-${b} should be rejected`);
  }
});

test('missing or non-integer game scores are rejected', () => {
  assert.ok(validateSet(NaN, 4));
  assert.ok(validateSet(6, NaN));
  assert.ok(validateSet(6.5, 4));
  assert.ok(validateSet(-1, 6));
});

test('super tie-break needs 10+ and two clear points', () => {
  assert.equal(validateTieBreak(10, 8), null);
  assert.equal(validateTieBreak(11, 9), null);
  assert.equal(validateTieBreak(13, 11), null);
  assert.equal(validateTieBreak(8, 10), null);
  assert.ok(validateTieBreak(9, 7), 'winner under 10');
  assert.ok(validateTieBreak(10, 9), 'only one clear point');
  assert.ok(validateTieBreak(12, 8), 'play stops at two clear points');
});

/* ------------------------------------------------------------------- scoring */

test('straight-sets win is 3 points to nil', () => {
  const s = scoreMatch({ s1_home: 6, s1_away: 3, s2_home: 6, s2_away: 4 });
  assert.equal(s.ok, true);
  assert.equal(s.needsTieBreak, false);
  assert.equal(s.setsHome, 2);
  assert.equal(s.setsAway, 0);
  assert.equal(s.homeWon, true);
  assert.equal(s.pointsHome, 3);
  assert.equal(s.pointsAway, 0);
  assert.equal(s.gamesHome, 12);
  assert.equal(s.gamesAway, 7);
});

test('straight-sets loss away from home is scored the same way round', () => {
  const s = scoreMatch({ s1_home: 2, s1_away: 6, s2_home: 4, s2_away: 6 });
  assert.equal(s.homeWon, false);
  assert.equal(s.pointsHome, 0);
  assert.equal(s.pointsAway, 3);
});

test('tie-break win is 2 points, loser keeps 1 for their set', () => {
  const s = scoreMatch({
    s1_home: 6, s1_away: 4,
    s2_home: 3, s2_away: 6,
    stb_home: 10, stb_away: 7,
  });
  assert.equal(s.ok, true);
  assert.equal(s.needsTieBreak, true);
  assert.equal(s.setsHome, 1);
  assert.equal(s.setsAway, 1);
  assert.equal(s.homeWon, true);
  assert.equal(s.pointsHome, 2);
  assert.equal(s.pointsAway, 1);
});

test('losing the tie-break still earns the point for the set won', () => {
  const s = scoreMatch({
    s1_home: 6, s1_away: 4,
    s2_home: 3, s2_away: 6,
    stb_home: 8, stb_away: 10,
  });
  assert.equal(s.homeWon, false);
  assert.equal(s.pointsHome, 1);
  assert.equal(s.pointsAway, 2);
});

test('the super tie-break is not counted as a set or as games', () => {
  const s = scoreMatch({
    s1_home: 6, s1_away: 0,
    s2_home: 0, s2_away: 6,
    stb_home: 10, stb_away: 0,
  });
  assert.equal(s.setsHome, 1, 'tie-break must not become a third set');
  assert.equal(s.setsAway, 1);
  assert.equal(s.gamesHome, 6, 'tie-break points must not become games');
  assert.equal(s.gamesAway, 6);
});

test('every valid match distributes exactly 3 points', () => {
  const lines = [
    { s1_home: 6, s1_away: 0, s2_home: 6, s2_away: 0 },
    { s1_home: 7, s1_away: 6, s2_home: 7, s2_away: 5 },
    { s1_home: 6, s1_away: 4, s2_home: 4, s2_away: 6, stb_home: 10, stb_away: 8 },
    { s1_home: 3, s1_away: 6, s2_home: 6, s2_away: 2, stb_home: 9, stb_away: 11 },
  ];
  for (const raw of lines) {
    const s = scoreMatch(raw);
    assert.equal(s.ok, true, JSON.stringify(raw));
    assert.equal(s.pointsHome + s.pointsAway, SCORING.pointsPerMatch);
  }
});

test('a 1-1 scoreline without a tie-break is incomplete', () => {
  const s = scoreMatch({ s1_home: 6, s1_away: 4, s2_home: 3, s2_away: 6 });
  assert.equal(s.ok, false);
  assert.equal(s.needsTieBreak, true);
  assert.match(s.errors.join(' '), /tie-break/i);
});

test('a tie-break entered after a 2-0 scoreline is rejected', () => {
  const s = scoreMatch({
    s1_home: 6, s1_away: 4, s2_home: 6, s2_away: 2,
    stb_home: 10, stb_away: 5,
  });
  assert.equal(s.ok, false);
  assert.match(s.errors.join(' '), /straight sets/i);
});

test('an illegal set score fails before the tie-break is considered', () => {
  const s = scoreMatch({ s1_home: 6, s1_away: 5, s2_home: 6, s2_away: 2 });
  assert.equal(s.ok, false);
  assert.match(s.errors.join(' '), /Set 1/);
});

/* ----------------------------------------------------------------- standings */

const T = (id, name) => ({ id, name });
const teams4 = [T('a', 'Aktar / Ozayr'), T('b', 'Kyle / Wesley'), T('c', 'Ryan / Nikhil'), T('d', 'Hamza / Yahya')];

const done = (home, away, raw) => Object.assign({ home_team: home, away_team: away, status: 'completed' }, raw);

test('an empty division ranks everyone on zero', () => {
  const rows = buildStandings(teams4, []);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.points === 0 && r.played === 0));
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4]);
});

test('standings aggregate points, sets and game difference', () => {
  const matches = [
    done('a', 'b', { s1_home: 6, s1_away: 2, s2_home: 6, s2_away: 3 }),           // a 3-0
    done('a', 'c', { s1_home: 6, s1_away: 4, s2_home: 3, s2_away: 6, stb_home: 10, stb_away: 8 }), // a 2-1
  ];
  const rows = buildStandings(teams4, matches);
  const byId = new Map(rows.map((r) => [r.team.id, r]));

  const a = byId.get('a');
  assert.equal(a.played, 2);
  assert.equal(a.won, 2);
  assert.equal(a.points, 5);
  assert.equal(a.setsWon, 3);
  assert.equal(a.setsLost, 1);
  assert.equal(a.gamesFor, 12 + 9);
  assert.equal(a.gamesAgainst, 5 + 10);
  assert.equal(a.gamesDiff, 6);
  assert.equal(a.rank, 1);

  assert.equal(byId.get('b').points, 0);
  assert.equal(byId.get('c').points, 1);
  assert.equal(byId.get('c').setsWon, 1);
});

test('pending matches are ignored by the table', () => {
  const matches = [
    { home_team: 'a', away_team: 'b', status: 'pending' },
    { home_team: 'c', away_team: 'd', status: 'pending', s1_home: 6, s1_away: 0, s2_home: 6, s2_away: 0 },
  ];
  const rows = buildStandings(teams4, matches);
  assert.ok(rows.every((r) => r.played === 0 && r.points === 0));
});

test('a corrupt completed row is skipped rather than poisoning the table', () => {
  const matches = [
    done('a', 'b', { s1_home: 6, s1_away: 5, s2_home: 6, s2_away: 2 }), // illegal set
    done('c', 'd', { s1_home: 6, s1_away: 1, s2_home: 6, s2_away: 1 }),
  ];
  const rows = buildStandings(teams4, matches);
  const byId = new Map(rows.map((r) => [r.team.id, r]));
  assert.equal(byId.get('a').played, 0);
  assert.equal(byId.get('b').played, 0);
  assert.equal(byId.get('c').points, 3);
});

test('a result for a removed team does not crash the table', () => {
  const matches = [done('a', 'ghost', { s1_home: 6, s1_away: 0, s2_home: 6, s2_away: 0 })];
  const rows = buildStandings(teams4, matches);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.played === 0));
});

test('level teams are separated by head-to-head before sets won', () => {
  // a and b both finish on 3 points; b beat a head-to-head, but a won more sets overall.
  const matches = [
    done('b', 'a', { s1_home: 6, s1_away: 3, s2_home: 6, s2_away: 3 }),  // b 3, a 0
    done('a', 'c', { s1_home: 6, s1_away: 2, s2_home: 6, s2_away: 2 }),  // a 3, c 0
    done('b', 'd', { s1_home: 6, s1_away: 4, s2_home: 4, s2_away: 6, stb_home: 10, stb_away: 3 }), // b 2, d 1
    done('b', 'c', { s1_home: 4, s1_away: 6, s2_home: 6, s2_away: 4, stb_home: 5, stb_away: 10 }), // b 1, c 2
  ];
  const rows = buildStandings(teams4, matches);
  const order = rows.map((r) => r.team.id);
  const a = rows.find((r) => r.team.id === 'a');
  const b = rows.find((r) => r.team.id === 'b');

  assert.equal(a.points, 3);
  assert.equal(b.points, 6);
  assert.equal(order[0], 'b', 'b leads on points');

  // Now force a true tie on points between a and c and check head-to-head decides.
  const tie = [
    done('a', 'c', { s1_home: 6, s1_away: 2, s2_home: 6, s2_away: 2 }), // a 3, c 0
    done('a', 'b', { s1_home: 1, s1_away: 6, s2_home: 1, s2_away: 6 }), // a 0, b 3
    done('c', 'd', { s1_home: 6, s1_away: 1, s2_home: 6, s2_away: 1 }), // c 3, d 0
  ];
  const rows2 = buildStandings(teams4, tie);
  const ranked = rows2.filter((r) => r.points === 3).map((r) => r.team.id);
  assert.equal(ranked.length, 3, 'a, b and c all on 3 points');
  assert.ok(ranked.indexOf('a') < ranked.indexOf('c'), 'a beat c head-to-head so places above');
});

test('teams level on points and head-to-head fall back to sets then games', () => {
  const two = [T('x', 'X pair'), T('y', 'Y pair'), T('z', 'Z pair')];
  const matches = [
    // x and y never meet; both beat z 3-0, so points and h2h are level.
    done('x', 'z', { s1_home: 6, s1_away: 0, s2_home: 6, s2_away: 0 }), // gd +12
    done('y', 'z', { s1_home: 7, s1_away: 5, s2_home: 7, s2_away: 6 }), // gd +3
  ];
  const rows = buildStandings(two, matches);
  assert.equal(rows[0].team.id, 'x', 'equal sets, better game difference wins');
  assert.equal(rows[1].team.id, 'y');
  assert.equal(rows[0].tiedWith, 1);
});

/* ------------------------------------------------------------------ fixtures */

test('ten teams produce a complete 45-match round robin', () => {
  const ids = Array.from({ length: 10 }, (_, i) => 't' + i);
  const rounds = roundRobin(ids);

  assert.equal(rounds.length, 9, '9 rounds');
  assert.ok(rounds.every((r) => r.length === 5), '5 matches per round');

  const seen = new Set();
  const perTeam = new Map(ids.map((id) => [id, 0]));
  const hostCount = new Map(ids.map((id) => [id, 0]));

  for (const round of rounds) {
    const inRound = new Set();
    for (const [home, away] of round) {
      const key = [home, away].sort().join('|');
      assert.ok(!seen.has(key), 'pair ' + key + ' scheduled twice');
      seen.add(key);
      assert.notEqual(home, away, 'a team cannot play itself');
      assert.ok(!inRound.has(home) && !inRound.has(away), 'team plays twice in one round');
      inRound.add(home); inRound.add(away);
      perTeam.set(home, perTeam.get(home) + 1);
      perTeam.set(away, perTeam.get(away) + 1);
      hostCount.set(home, hostCount.get(home) + 1);
    }
  }

  assert.equal(seen.size, 45, 'every pair exactly once');
  assert.ok([...perTeam.values()].every((n) => n === 9), 'each team plays 9 matches');
  const hosts = [...hostCount.values()];
  assert.ok(Math.max(...hosts) - Math.min(...hosts) <= 1, 'hosting is balanced: ' + hosts.join(','));
});

test('an odd number of teams gives everyone a bye and no self-matches', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const rounds = roundRobin(ids);
  assert.equal(rounds.length, 5);
  assert.ok(rounds.every((r) => r.length === 2));
  const counts = new Map(ids.map((id) => [id, 0]));
  for (const round of rounds) {
    for (const [home, away] of round) {
      assert.ok(home && away, 'no null placeholder should reach a fixture');
      counts.set(home, counts.get(home) + 1);
      counts.set(away, counts.get(away) + 1);
    }
  }
  assert.ok([...counts.values()].every((n) => n === 4), 'each of 5 teams plays 4');
});

test('fewer than two teams yields no fixtures', () => {
  assert.deepEqual(roundRobin([]), []);
  assert.deepEqual(roundRobin(['solo']), []);
  assert.deepEqual(buildFixtures('beginner', ['solo']), []);
});

test('buildFixtures numbers matches 1..45 and tags the division and round', () => {
  const ids = Array.from({ length: 10 }, (_, i) => 't' + i);
  const rows = buildFixtures('intermediate', ids);
  assert.equal(rows.length, 45);
  assert.deepEqual(rows.map((r) => r.match_no), Array.from({ length: 45 }, (_, i) => i + 1));
  assert.ok(rows.every((r) => r.division_id === 'intermediate'));
  assert.ok(rows.every((r) => r.status === 'pending'));
  assert.equal(rows[0].round, 1);
  assert.equal(rows[44].round, 9);
  assert.equal(rows.filter((r) => r.round === 3).length, 5);
});

/* -------------------------------------------------------------------- extras */

test('divisionProgress counts played, remaining and percentage', () => {
  const matches = [
    { status: 'completed' }, { status: 'completed' }, { status: 'pending' }, { status: 'pending' },
  ];
  const p = divisionProgress(teams4, matches);
  assert.equal(p.teams, 4);
  assert.equal(p.total, 4);
  assert.equal(p.played, 2);
  assert.equal(p.remaining, 2);
  assert.equal(p.percent, 50);
});

test('divisionProgress handles a division with no fixtures yet', () => {
  const p = divisionProgress([], []);
  assert.equal(p.percent, 0);
  assert.equal(p.total, 0);
});

test('daysUntil counts forward and goes negative after the date', () => {
  const today = new Date(2026, 9, 4); // 4 Oct 2026
  assert.equal(daysUntil('2026-10-04', today), 0);
  assert.equal(daysUntil('2026-10-05', today), 1);
  assert.equal(daysUntil('2026-12-15', today), 72);
  assert.equal(daysUntil('2026-10-01', today), -3);
});

test('teamSchedule lists every fixture, unplayed first, with the opponent resolved', () => {
  const teamsById = new Map(teams4.map((t) => [t.id, t]));
  const matches = [
    { match_no: 1, home_team: 'a', away_team: 'b', status: 'pending' },
    Object.assign({ match_no: 2 }, done('c', 'a', { s1_home: 6, s1_away: 4, s2_home: 6, s2_away: 4 })),
    { match_no: 3, home_team: 'a', away_team: 'd', status: 'pending' },
    { match_no: 4, home_team: 'b', away_team: 'c', status: 'pending' },
  ];

  const mine = teamSchedule('a', matches, teamsById);
  assert.equal(mine.length, 3, 'only a\'s own matches');
  assert.deepEqual(mine.map((r) => r.match.match_no), [1, 3, 2], 'pending before completed');

  assert.equal(mine[0].hosting, true);
  assert.equal(mine[0].opponent.name, 'Kyle / Wesley');
  assert.equal(mine[0].result, null);

  const played = mine[2];
  assert.equal(played.hosting, false, 'a was away in match 2');
  assert.equal(played.opponent.id, 'c');
  assert.equal(played.result, 'lost');
  assert.equal(played.points, 0);
});

test('teamSchedule survives an opponent that no longer exists', () => {
  const teamsById = new Map(teams4.map((t) => [t.id, t]));
  const mine = teamSchedule('a', [{ match_no: 1, home_team: 'a', away_team: 'gone', status: 'pending' }], teamsById);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].opponent, null);
});
