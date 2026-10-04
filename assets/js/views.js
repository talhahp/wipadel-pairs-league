/**
 * The player-facing views. Each one returns HTML and may attach its own
 * listeners afterwards in `wire`.
 */

import { html, raw, mount, stat, empty, notice, flash, errorText,
         shortDate, longDate, signed, plural, waLink, dialable, formData } from './ui.js';
import * as store from './store.js';
import { buildStandings, teamSchedule, divisionProgress, daysUntil,
         scoreMatch, formatScoreline, TIEBREAKERS } from './core.js';

/* ------------------------------------------------------------ shared pieces */

function divisionSwitch(ctx) {
  const divs = store.state.divisions;
  if (divs.length < 2) return '';
  return html`
    <div class="divisions" role="tablist" aria-label="Division">
      ${divs.map((d) => html`
        <button role="tab" type="button" data-division="${d.id}"
                aria-current="${d.id === ctx.division ? 'true' : 'false'}">
          ${d.name}
        </button>`)}
    </div>`;
}

function wireDivisionSwitch(root, ctx) {
  root.querySelectorAll('[data-division]').forEach((b) => {
    b.addEventListener('click', () => ctx.setDivision(b.dataset.division));
  });
}

/** One line of a team's identity: the two players, and the pair rating. */
function teamSub(team) {
  if (!team) return '';
  const names = [team.player1, team.player2].filter(Boolean).join(' & ');
  const rating = team.rating ? `avg ${Number(team.rating).toFixed(2)}` : '';
  return [names, rating].filter(Boolean).join('  ·  ');
}

function contactRow(label, phone, message) {
  const link = waLink(phone, message);
  const tel = dialable(phone);
  if (!link && !tel) {
    return html`<div class="contact contact--empty"><span>${label}</span><span>no number yet</span></div>`;
  }
  return html`
    <div class="contact">
      <span>${label}</span>
      <span>
        ${link ? html`<a href="${link}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        ${link && tel ? raw(' &middot; ') : ''}
        ${tel ? html`<a href="tel:${tel}">${phone}</a>` : ''}
      </span>
    </div>`;
}

/** The message a player sends to arrange a match. */
function inviteText(me, opponent, settings) {
  const venue = settings?.venue || 'Wi Padel Sherwood';
  const promo = settings?.promo_code ? ` (promo code ${settings.promo_code})` : '';
  return `Hi! ${opponent?.name || 'there'} vs ${me?.name || 'us'} in the ${venue} Pairs League. ` +
         `Which of these suits you for a 90-minute court${promo}? `;
}

/**
 * One fixture row. Used by both "My team" and the full fixture list.
 * `perspective` is the team the result should be read from, or null for neutral.
 */
function fixtureCard(match, teamsById, perspective, opts = {}) {
  const home = teamsById.get(match.home_team);
  const away = teamsById.get(match.away_team);
  const done = match.status === 'completed';

  let tone = 'todo';
  let badge = '';
  if (done) {
    const s = scoreMatch(match);
    if (s.ok) {
      if (perspective) {
        const iAmHome = match.home_team === perspective;
        const iWon = iAmHome ? s.homeWon : !s.homeWon;
        tone = iWon ? 'won' : 'lost';
        const pts = iAmHome ? s.pointsHome : s.pointsAway;
        badge = html`<span class="fx__badge">${iWon ? 'Won' : 'Lost'} ${pts} pt${pts === 1 ? '' : 's'}</span>`;
      } else {
        tone = 'done';
        const winner = s.homeWon ? home : away;
        badge = html`<span class="chip chip--lime">${winner ? winner.name : 'Winner'}</span>`;
      }
    } else {
      tone = 'done';
      badge = html`<span class="chip chip--orange">Score needs fixing</span>`;
    }
  }

  const opponent = perspective
    ? (match.home_team === perspective ? away : home)
    : null;

  const title = perspective
    ? html`<span class="fx__opp">${opponent ? opponent.name : 'Unknown pair'}</span>`
    : html`<span class="fx__opp">${home ? home.name : '?'} <span class="muted">v</span> ${away ? away.name : '?'}</span>`;

  const hosting = perspective ? match.home_team === perspective : null;

  const meta = [];
  meta.push(html`<span class="chip">Round ${match.round}</span>`);
  if (perspective) {
    meta.push(hosting
      ? html`<span class="chip chip--azure">You message first</span>`
      : html`<span class="chip">They message first</span>`);
  } else if (home) {
    meta.push(html`<span class="chip">${home.name} messages first</span>`);
  }
  if (done && match.played_on) meta.push(html`<span>${shortDate(match.played_on)}</span>`);
  if (!done && opponent) meta.push(html`<span>${teamSub(opponent)}</span>`);

  const right = done
    ? html`<span class="fx__score mono">${formatScoreline(match)}</span>${badge}`
    : (opts.actions === false ? '' : html`
        <a class="btn btn--sm btn--primary" href="#/submit?m=${match.id}">Enter score</a>`);

  return html`
    <article class="fx fx--${tone} ${done ? 'fx--done' : ''}">
      <span class="fx__no">${match.match_no}</span>
      <div class="fx__who">
        ${title}
        <div class="fx__note">${meta}</div>
      </div>
      <div class="fx__right">${right}</div>
    </article>`;
}

/* ================================================================== MY TEAM */

export const myTeamView = {
  id: 'my',
  label: 'My team',

  render(ctx) {
    const myId = store.getMyTeamId();
    const me = myId ? store.findTeam(myId) : null;

    if (!me) return pickTeam(ctx);

    const teams = store.divisionTeams(me.division_id);
    const matches = store.divisionMatches(me.division_id);
    const byId = store.teamsById();
    const table = buildStandings(teams, matches);
    const row = table.find((r) => r.team.id === me.id);
    const schedule = teamSchedule(me.id, matches, byId);

    const todo = schedule.filter((s) => s.match.status !== 'completed');
    const played = schedule.filter((s) => s.match.status === 'completed');
    const settings = store.state.settings;
    const left = daysUntil(settings?.season_end || '2026-12-15');

    const division = store.state.divisions.find((d) => d.id === me.division_id);

    return html`
      <section class="view">
        <div class="myteam-head">
          <div>
            <p class="eyebrow">${division ? division.name : ''} division</p>
            <h2>${me.name}</h2>
            <span class="team-sub">${teamSub(me)}</span>
          </div>
          <div class="myteam-rank">
            <span class="stat__k">Position</span>
            <b>${row ? row.rank : '-'}</b>
            <span class="muted">${row ? plural(row.points, 'point') : ''}</span>
          </div>
        </div>

        <div class="stats stagger">
          ${stat('Played', row ? row.played : 0, { sub: `of ${schedule.length}`, percent: schedule.length ? (row.played / schedule.length) * 100 : 0 })}
          ${stat('Still to play', todo.length)}
          ${stat('Sets', row ? `${row.setsWon}-${row.setsLost}` : '0-0')}
          ${stat('Game diff', row ? signed(row.gamesDiff) : '0')}
          ${stat('Days left', left > 0 ? left : 0, { sub: 'to 15 Dec', tone: left <= 14 ? 'orange' : '' })}
        </div>

        <div class="btn-row" style="margin-bottom:22px">
          <a class="btn btn--primary" href="#/submit">Enter a score</a>
          <button class="btn btn--ghost" type="button" data-act="change">Not your team?</button>
        </div>

        <div class="split-head"><h3>Still to play (${todo.length})</h3></div>
        ${todo.length
          ? html`<div class="fixtures">${todo.map((s) => matchWithContacts(s, me, settings))}</div>`
          : empty('All nine done', 'Every fixture is in. Check the standings to see where you finished.')}

        <div class="split-head"><h3>Played (${played.length})</h3></div>
        ${played.length
          ? html`<div class="fixtures">${played.map((s) => fixtureCard(s.match, byId, me.id))}</div>`
          : empty('Nothing played yet', 'Message one of the pairs above and get your first match booked.')}
      </section>`;
  },

  wire(root, ctx) {
    const change = root.querySelector('[data-act="change"]');
    if (change) {
      change.addEventListener('click', () => {
        store.setMyTeamId(null);
        ctx.go('#/my');
      });
    }

    const form = root.querySelector('#pick-form');
    if (form) {
      const divSel = form.querySelector('[name="division"]');
      const teamSel = form.querySelector('[name="team"]');

      const fill = () => {
        const teams = store.divisionTeams(divSel.value);
        teamSel.innerHTML = teams.length
          ? teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')
          : '<option value="">No teams in this division yet</option>';
        teamSel.disabled = !teams.length;
      };
      divSel.addEventListener('change', fill);
      fill();

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!teamSel.value) return;
        store.setMyTeamId(teamSel.value);
        ctx.go('#/my');
      });
    }
  },
};

function pickTeam(ctx) {
  const divs = store.state.divisions;
  return html`
    <section class="view">
      <div class="section-head">
        <div>
          <p class="eyebrow">Start here</p>
          <h2>Which pair are you?</h2>
          <p>Pick your team once and this device remembers it. You then get your own
             page with all nine fixtures, who you still have to play, and their numbers.</p>
        </div>
      </div>

      <form class="card card--pad pick" id="pick-form">
        <div class="field">
          <label for="pick-div">Division</label>
          <select id="pick-div" name="division">
            ${divs.map((d) => html`<option value="${d.id}">${d.name} (${d.rating_label || ''})</option>`)}
          </select>
        </div>
        <div class="field">
          <label for="pick-team">Your pair</label>
          <select id="pick-team" name="team"></select>
        </div>
        <div class="btn-row">
          <button class="btn btn--primary" type="submit">That's us</button>
        </div>
        <p class="field__hint">Not in the list? Ask the organiser to add your pair.</p>
      </form>
    </section>`;
}

/** A still-to-play fixture, expanded with the opponent's contact details. */
function matchWithContacts(entry, me, settings) {
  const opp = entry.opponent;
  const msg = inviteText(me, opp, settings);
  return html`
    <article class="fx fx--todo">
      <span class="fx__no">${entry.match.match_no}</span>
      <div class="fx__who">
        <span class="fx__opp">${opp ? opp.name : 'Unknown pair'}</span>
        <div class="fx__note">
          <span class="chip">Round ${entry.match.round}</span>
          ${entry.hosting
            ? html`<span class="chip chip--azure">You message first</span>`
            : html`<span class="chip">They message first</span>`}
          ${opp ? html`<span>${teamSub(opp)}</span>` : ''}
        </div>
        ${opp ? html`
          <div class="contacts">
            ${contactRow(opp.player1 || 'Player 1', opp.phone1, msg)}
            ${contactRow(opp.player2 || 'Player 2', opp.phone2, msg)}
          </div>` : ''}
      </div>
      <div class="fx__right">
        <a class="btn btn--sm btn--primary" href="#/submit?m=${entry.match.id}">Enter score</a>
      </div>
    </article>`;
}

/* =============================================================== STANDINGS */

export const standingsView = {
  id: 'standings',
  label: 'Standings',

  render(ctx) {
    const teams = store.divisionTeams(ctx.division);
    const matches = store.divisionMatches(ctx.division);
    const table = buildStandings(teams, matches);
    const progress = divisionProgress(teams, matches);
    const myId = store.getMyTeamId();
    const settings = store.state.settings;
    const left = daysUntil(settings?.season_end || '2026-12-15');

    if (!teams.length) {
      return html`
        <section class="view">
          ${divisionSwitch(ctx)}
          ${empty('No teams yet', 'This division has not been filled in. The organiser can add pairs from the Admin tab.')}
        </section>`;
    }

    return html`
      <section class="view">
        ${divisionSwitch(ctx)}

        <div class="stats stagger">
          ${stat('Matches played', progress.played, { sub: `of ${progress.total}`, percent: progress.percent })}
          ${stat('Still to play', progress.remaining)}
          ${stat('Pairs', progress.teams)}
          ${stat('Days left', left > 0 ? left : 0, { sub: longDate(settings?.season_end), tone: left <= 14 ? 'orange' : '' })}
        </div>

        <div class="section-head">
          <div>
            <h2>Standings</h2>
            <p>3 points per match: one for each full set won, one for winning the match.</p>
          </div>
        </div>

        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th class="l">#</th>
                <th class="l">Pair</th>
                <th>P</th>
                <th>W</th>
                <th class="hide-sm">L</th>
                <th>Sets</th>
                <th class="hide-sm">Games</th>
                <th>Pts</th>
              </tr>
            </thead>
            <tbody>
              ${table.map((r) => html`
                <tr class="${r.rank === 1 && r.played ? 'is-leader' : ''} ${r.team.id === myId ? 'is-me' : ''}">
                  <td class="rank">${r.rank}</td>
                  <td class="l">
                    <span class="team-name">${r.team.name}</span>
                    ${r.team.id === myId ? html` <span class="chip chip--me">You</span>` : ''}
                    <span class="team-sub">${teamSub(r.team)}</span>
                  </td>
                  <td>${r.played}</td>
                  <td>${r.won}</td>
                  <td class="hide-sm">${r.lost}</td>
                  <td>${r.setsWon}<span class="muted">-${r.setsLost}</span></td>
                  <td class="hide-sm">${signed(r.gamesDiff)}</td>
                  <td class="pts">${r.points}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>

        <p class="muted" style="margin-top:14px;font-size:13px">
          Ties are broken by ${TIEBREAKERS.join(', then ').toLowerCase()}.
        </p>
      </section>`;
  },

  wire(root, ctx) { wireDivisionSwitch(root, ctx); },
};

/* ================================================================ FIXTURES */

export const fixturesView = {
  id: 'fixtures',
  label: 'Fixtures',

  render(ctx) {
    const matches = store.divisionMatches(ctx.division);
    const byId = store.teamsById();

    if (!matches.length) {
      return html`
        <section class="view">
          ${divisionSwitch(ctx)}
          ${empty('No fixtures yet', 'Once the pairs are in, the organiser can generate the full round robin from the Admin tab.')}
        </section>`;
    }

    return html`
      <section class="view">
        ${divisionSwitch(ctx)}

        <div class="section-head">
          <div>
            <h2>All fixtures</h2>
            <p>Every pair plays every other pair once. Play them in whatever order suits you -
               the round number is only there to keep the list tidy.</p>
          </div>
        </div>

        <div class="inline-form" style="margin-bottom:16px">
          <div class="field">
            <label for="fx-search">Find a pair</label>
            <input id="fx-search" type="search" placeholder="Type a name..." autocomplete="off">
          </div>
          <div class="field">
            <label for="fx-filter">Show</label>
            <select id="fx-filter">
              <option value="all">All ${matches.length} matches</option>
              <option value="todo">Still to play</option>
              <option value="done">Played</option>
            </select>
          </div>
        </div>

        <div class="fixtures" id="fx-list">
          ${matches.map((m) => html`
            <div data-fx
                 data-status="${m.status}"
                 data-names="${[byId.get(m.home_team)?.name, byId.get(m.away_team)?.name,
                                byId.get(m.home_team)?.player1, byId.get(m.home_team)?.player2,
                                byId.get(m.away_team)?.player1, byId.get(m.away_team)?.player2]
                                .filter(Boolean).join(' ').toLowerCase()}">
              ${fixtureCard(m, byId, null)}
            </div>`)}
        </div>
        <p class="muted" id="fx-none" style="display:none;padding:28px 0;text-align:center">
          No fixtures match that.
        </p>
      </section>`;
  },

  wire(root, ctx) {
    wireDivisionSwitch(root, ctx);
    const search = root.querySelector('#fx-search');
    const filter = root.querySelector('#fx-filter');
    const none = root.querySelector('#fx-none');
    const rows = [...root.querySelectorAll('[data-fx]')];
    if (!rows.length) return;

    const apply = () => {
      const q = search.value.trim().toLowerCase();
      const want = filter.value;
      let shown = 0;
      for (const row of rows) {
        const okText = !q || row.dataset.names.includes(q);
        const okStatus = want === 'all'
          || (want === 'todo' && row.dataset.status !== 'completed')
          || (want === 'done' && row.dataset.status === 'completed');
        const show = okText && okStatus;
        row.style.display = show ? '' : 'none';
        if (show) shown++;
      }
      none.style.display = shown ? 'none' : '';
    };

    search.addEventListener('input', apply);
    filter.addEventListener('change', apply);
  },
};

/* ============================================================== CROSS GRID */

export const gridView = {
  id: 'grid',
  label: 'Grid',

  render(ctx) {
    const teams = store.divisionTeams(ctx.division);
    const matches = store.divisionMatches(ctx.division);
    const myId = store.getMyTeamId();

    if (teams.length < 2) {
      return html`
        <section class="view">
          ${divisionSwitch(ctx)}
          ${empty('Nothing to plot yet', 'The grid appears once this division has its pairs and fixtures.')}
        </section>`;
    }

    // Look up a match by the unordered pair.
    const key = (a, b) => [a, b].sort().join('|');
    const map = new Map(matches.map((m) => [key(m.home_team, m.away_team), m]));

    const cell = (rowTeam, colTeam) => {
      if (rowTeam.id === colTeam.id) return html`<td><div class="cell cell--self">&mdash;</div></td>`;
      const m = map.get(key(rowTeam.id, colTeam.id));
      if (!m) return html`<td><div class="cell cell--todo" title="Not scheduled"></div></td>`;

      const mine = myId && (rowTeam.id === myId || colTeam.id === myId) ? ' cell--mine' : '';
      if (m.status !== 'completed') {
        return html`<td><div class="cell cell--todo${raw(mine)}"
          title="${rowTeam.name} v ${colTeam.name} - still to play"></div></td>`;
      }

      const s = scoreMatch(m);
      if (!s.ok) {
        return html`<td><div class="cell cell--todo${raw(mine)}" title="Score needs fixing">!</div></td>`;
      }
      const rowIsHome = m.home_team === rowTeam.id;
      const rowWon = rowIsHome ? s.homeWon : !s.homeWon;
      // Points, not sets: a tie-break match is 1-1 on sets for both pairs, which
      // would read the same whether you won it or lost it.
      const pts = rowIsHome ? s.pointsHome : s.pointsAway;
      return html`<td><div class="cell ${rowWon ? 'cell--won' : 'cell--lost'}${raw(mine)}"
        title="${rowTeam.name} v ${colTeam.name}: ${formatScoreline(m)} (${pts} pts)">${pts}</div></td>`;
    };

    return html`
      <section class="view">
        ${divisionSwitch(ctx)}

        <div class="section-head">
          <div>
            <h2>Who has played who</h2>
            <p>Read across your own row. A filled box means it is done; an empty one is still to arrange.
               The figure is the points that row's pair took from the match - hover for the full score.</p>
          </div>
        </div>

        <div class="grid-wrap card card--pad">
          <table class="grid">
            <thead>
              <tr>
                <th></th>
                ${teams.map((t) => html`<th><span>${t.name}</span></th>`)}
              </tr>
            </thead>
            <tbody>
              ${teams.map((rowTeam) => html`
                <tr>
                  <th title="${rowTeam.name}">${rowTeam.name}</th>
                  ${teams.map((colTeam) => cell(rowTeam, colTeam))}
                </tr>`)}
            </tbody>
          </table>
        </div>

        <div class="legend">
          <span><i style="background:rgba(120,247,0,.35)"></i>Won</span>
          <span><i style="background:rgba(255,120,0,.35)"></i>Lost</span>
          <span><i style="background:rgba(237,242,250,.14)"></i>Still to play</span>
          ${myId ? html`<span><i style="box-shadow:inset 0 0 0 1px #3D94FF"></i>Involves your pair</span>` : ''}
        </div>
      </section>`;
  },

  wire(root, ctx) { wireDivisionSwitch(root, ctx); },
};

/* =================================================================== TEAMS */

export const teamsView = {
  id: 'teams',
  label: 'Contacts',

  render(ctx) {
    const teams = store.divisionTeams(ctx.division);
    const myId = store.getMyTeamId();
    const settings = store.state.settings;
    const me = myId ? store.findTeam(myId) : null;

    if (!teams.length) {
      return html`
        <section class="view">
          ${divisionSwitch(ctx)}
          ${empty('No pairs yet', 'The organiser can add them from the Admin tab.')}
        </section>`;
    }

    const missing = teams.filter((t) => !t.phone1 && !t.phone2).length;

    return html`
      <section class="view">
        ${divisionSwitch(ctx)}

        <div class="section-head">
          <div>
            <h2>Contact directory</h2>
            <p>Message your opponents directly. Tap WhatsApp to open a chat with the match already mentioned.</p>
          </div>
        </div>

        ${missing ? notice('warn', `${missing} of ${teams.length} pairs have no number yet.`,
            'The organiser can add them under Admin so everyone can be reached.') : ''}

        <div class="team-cards stagger">
          ${teams.map((t) => html`
            <div class="team-card ${t.id === myId ? 'team-card--mine' : ''}">
              <span class="team-card__seed">${t.seed}</span>
              <h3>${t.name} ${t.id === myId ? html`<span class="chip chip--me">You</span>` : ''}</h3>
              <span class="team-sub">${teamSub(t)}</span>
              <div class="contacts">
                ${contactRow(t.player1 || 'Player 1', t.phone1, inviteText(me, t, settings))}
                ${contactRow(t.player2 || 'Player 2', t.phone2, inviteText(me, t, settings))}
              </div>
            </div>`)}
        </div>
      </section>`;
  },

  wire(root, ctx) { wireDivisionSwitch(root, ctx); },
};

/* ================================================================== SUBMIT */

export const submitView = {
  id: 'submit',
  label: 'Enter score',

  render(ctx) {
    const preset = ctx.query.get('m');
    const myId = store.getMyTeamId();
    const byId = store.teamsById();

    const pending = store.state.matches
      .filter((m) => m.status !== 'completed')
      .sort((a, b) => {
        const am = myId && (a.home_team === myId || a.away_team === myId) ? 0 : 1;
        const bm = myId && (b.home_team === myId || b.away_team === myId) ? 0 : 1;
        return am - bm || a.match_no - b.match_no;
      });

    if (store.state.settings?.results_locked) {
      return html`
        <section class="view">
          ${notice('warn', 'Result entry is closed.', 'Send your score to the league organiser instead.')}
        </section>`;
    }

    if (!pending.length) {
      return html`
        <section class="view">
          ${empty('Every match is in', 'There are no outstanding fixtures left to record.')}
        </section>`;
    }

    const chosen = pending.find((m) => m.id === preset) || null;

    const label = (m) => {
      const h = byId.get(m.home_team);
      const a = byId.get(m.away_team);
      const mine = myId && (m.home_team === myId || m.away_team === myId) ? '★ ' : '';
      return `${mine}#${m.match_no}  ${h ? h.name : '?'} v ${a ? a.name : '?'}`;
    };

    return html`
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">After the match</p>
            <h2>Enter a score</h2>
            <p>Two full sets, then a 10-point super tie-break only if the sets finish 1-1.
               One submission per match - it cannot be overwritten, so check before you send.</p>
          </div>
        </div>

        <div id="submit-msg"></div>

        <form class="card card--pad stack" id="score-form">
          <div class="field">
            <label for="sf-match">Which match</label>
            <select id="sf-match" name="matchId" required>
              <option value="">Choose a fixture...</option>
              ${pending.map((m) => html`
                <option value="${m.id}" ${m.id === (chosen && chosen.id) ? raw('selected') : ''}>${label(m)}</option>`)}
            </select>
            ${myId ? html`<span class="field__hint">Your own fixtures are marked &#9733; and listed first.</span>` : ''}
          </div>

          <div id="sf-sides"></div>

          <div class="score-grid">
            <div class="field">
              <label for="s1h">Set 1</label>
              <div class="setline">
                <input id="s1h" name="s1_home" type="number" min="0" max="7" inputmode="numeric" required>
                <span>&ndash;</span>
                <input name="s1_away" type="number" min="0" max="7" inputmode="numeric" required>
              </div>
            </div>
            <div class="field">
              <label for="s2h">Set 2</label>
              <div class="setline">
                <input id="s2h" name="s2_home" type="number" min="0" max="7" inputmode="numeric" required>
                <span>&ndash;</span>
                <input name="s2_away" type="number" min="0" max="7" inputmode="numeric" required>
              </div>
            </div>
            <div class="field" id="sf-tb" hidden>
              <label for="tbh">Super tie-break</label>
              <div class="setline">
                <input id="tbh" name="stb_home" type="number" min="0" max="30" inputmode="numeric">
                <span>&ndash;</span>
                <input name="stb_away" type="number" min="0" max="30" inputmode="numeric">
              </div>
              <span class="field__hint">First to 10, win by 2.</span>
            </div>
          </div>

          <div class="inline-form">
            <div class="field">
              <label for="sf-date">Date played</label>
              <input id="sf-date" name="played_on" type="date">
            </div>
            <div class="field">
              <label for="sf-by">Your name</label>
              <input id="sf-by" name="submitted_by" type="text" placeholder="Who is sending this?" maxlength="60">
            </div>
          </div>

          <div id="sf-preview" class="muted" style="font-size:13.5px"></div>

          <div class="btn-row">
            <button class="btn btn--primary" type="submit">Submit result</button>
            <a class="btn btn--ghost" href="#/my">Cancel</a>
          </div>
        </form>
      </section>`;
  },

  wire(root, ctx) {
    const form = root.querySelector('#score-form');
    if (!form) return;

    const byId = store.teamsById();
    const sel = form.querySelector('[name="matchId"]');
    const sides = root.querySelector('#sf-sides');
    const tb = root.querySelector('#sf-tb');
    const preview = root.querySelector('#sf-preview');
    const msg = root.querySelector('#submit-msg');
    const dateInput = form.querySelector('[name="played_on"]');

    dateInput.max = new Date().toISOString().slice(0, 10);

    const current = () => store.state.matches.find((m) => m.id === sel.value) || null;

    const drawSides = () => {
      const m = current();
      if (!m) { sides.innerHTML = ''; return; }
      const h = byId.get(m.home_team);
      const a = byId.get(m.away_team);
      mount(sides, html`
        <div class="sides">
          <div><small>Left of every score</small><b>${h ? h.name : '?'}</b></div>
          <span class="vs">v</span>
          <div><small>Right of every score</small><b>${a ? a.name : '?'}</b></div>
        </div>`);
    };

    const readRow = () => {
      const d = formData(form);
      return {
        s1_home: d.s1_home, s1_away: d.s1_away,
        s2_home: d.s2_home, s2_away: d.s2_away,
        stb_home: d.stb_home, stb_away: d.stb_away,
      };
    };

    // Show the tie-break inputs only when the two sets are split, and preview
    // the points as they are typed so there are no surprises on submit.
    const update = () => {
      const m = current();
      const d = formData(form);
      const bothSets = ['s1_home', 's1_away', 's2_home', 's2_away'].every((k) => d[k] !== '');

      let split = false;
      if (bothSets) {
        const a = Number(d.s1_home) > Number(d.s1_away);
        const b = Number(d.s2_home) > Number(d.s2_away);
        split = a !== b;
      }
      tb.hidden = !split;
      if (!split) {
        tb.querySelectorAll('input').forEach((i) => { i.value = ''; });
      }

      if (!m || !bothSets) { preview.textContent = ''; return; }
      const s = scoreMatch(readRow());
      if (!s.ok) {
        preview.textContent = s.errors[0];
        preview.style.color = 'var(--orange)';
        return;
      }
      const h = byId.get(m.home_team);
      const a = byId.get(m.away_team);
      preview.style.color = '';
      preview.textContent =
        `${h ? h.name : 'Home'} ${s.pointsHome} pt${s.pointsHome === 1 ? '' : 's'}  ·  ` +
        `${a ? a.name : 'Away'} ${s.pointsAway} pt${s.pointsAway === 1 ? '' : 's'}  ·  ` +
        `winner: ${(s.homeWon ? h : a)?.name || '-'}`;
    };

    sel.addEventListener('change', () => { drawSides(); update(); });
    form.addEventListener('input', update);
    drawSides();
    update();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const m = current();
      if (!m) { flash(msg, 'err', 'Pick a fixture first.'); return; }

      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const d = formData(form);
        await store.submitResult(Object.assign({ matchId: m.id }, readRow(), {
          played_on: d.played_on || null,
          submitted_by: d.submitted_by || null,
        }));

        const h = byId.get(m.home_team);
        const a = byId.get(m.away_team);
        flash(msg, 'ok', `Match ${m.match_no} recorded.`,
          `${h ? h.name : '?'} v ${a ? a.name : '?'} - ${formatScoreline(readRow())}. The standings are updated.`);
        ctx.go('#/standings');
      } catch (err) {
        flash(msg, 'err', 'That result was not saved.', errorText(err));
        btn.disabled = false;
        btn.textContent = 'Submit result';
      }
    });
  },
};

/* =================================================================== RULES */

export const rulesView = {
  id: 'rules',
  label: 'Rules',

  render() {
    const s = store.state.settings || {};
    const promo = s.promo_code;

    return html`
      <section class="view prose">
        <div class="section-head">
          <div>
            <p class="eyebrow">${longDate(s.season_start)} &ndash; ${longDate(s.season_end)}</p>
            <h2>How the league works</h2>
            <p>Play when you want, compete when you can. Every pair plays every other pair
               once, in whatever order the two of you agree on.</p>
          </div>
        </div>

        <h3>Getting a match played</h3>
        <div class="steps">
          <div class="step">
            <div>
              <h4>Find your next opponent</h4>
              <p>Your own page lists all nine fixtures and who is still outstanding, with numbers.</p>
            </div>
          </div>
          <div class="step">
            <div>
              <h4>The pair marked "messages first" reaches out</h4>
              <p>They propose two or three date and time options. Either pair may start the chat -
                 this rule just stops both sides waiting for the other.</p>
            </div>
          </div>
          <div class="step">
            <div>
              <h4>Book a 90-minute court</h4>
              <p>Either pair books at ${s.venue || 'Wi Padel Sherwood'}${promo
                 ? html` on Playtomic using code <strong>${promo}</strong> for the ${s.promo_discount || '20%'} league discount`
                 : ' on Playtomic'}.</p>
            </div>
          </div>
          <div class="step">
            <div>
              <h4>Submit the score</h4>
              <p>One player enters it here straight after the match. The table updates immediately.</p>
            </div>
          </div>
        </div>

        <h3>Match format</h3>
        <ul>
          <li>Two regular sets. If the sets finish <strong>1&ndash;1</strong>, a <strong>10-point super tie-break</strong>
              decides the match (first to 10, win by 2).</li>
          <li><strong>Golden point</strong> at deuce (sudden death) to keep matches inside 60&ndash;90 minutes.</li>
          <li>A set is won at 6 games with two clear, or 7&ndash;5, or 7&ndash;6 on a tie-break.</li>
        </ul>

        <h3>Points</h3>
        <p>Three points are shared out in every match: one for each full set won, and one more for winning the match.
           The super tie-break is not a set - it only decides who takes the match point.</p>

        <div class="table-scroll points-table">
          <table>
            <thead>
              <tr><th class="l">Result</th><th>Winner</th><th>Loser</th><th class="l hide-sm">Why</th></tr>
            </thead>
            <tbody>
              <tr>
                <td class="l"><b>Won 2&ndash;0</b></td>
                <td class="pts">3</td><td>0</td>
                <td class="l hide-sm muted">2 sets + the match</td>
              </tr>
              <tr>
                <td class="l"><b>Won on the super tie-break</b></td>
                <td class="pts">2</td><td>1</td>
                <td class="l hide-sm muted">1 set each; the winner adds the match point</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>Ties in the table</h3>
        <p>Pairs level on points are separated by, in order:
           ${TIEBREAKERS.slice(1).map((t, i, arr) =>
             html`<strong>${t.toLowerCase()}</strong>${i < arr.length - 1 ? ', then ' : '.'}`)}</p>

        <h3>Pace</h3>
        <p>All nine matches must be finished by <strong>${longDate(s.season_end)}</strong>.
           ${s.pace_target_date ? html`We recommend completing at least
           ${plural(s.pace_target_matches || 4, 'match', 'matches')} by
           <strong>${longDate(s.pace_target_date)}</strong> so courts are not scarce at the end.` : ''}</p>

        <h3>Substitutes</h3>
        <p>A pair may use <strong>one substitute per match</strong> if a partner is injured or away,
           provided the substitute's Playtomic rating is at or below the division cap
           (Beginner 1.5, Intermediate 3.0).</p>

        <h3>Scores</h3>
        <ul>
          <li>Either player from the winning pair submits the result.</li>
          <li>A match can only be submitted once. If something is wrong, ask the organiser to correct it.</li>
          <li>Drop a photo of the scorecard in the WhatsApp group if you like - the official record is here.</li>
        </ul>
      </section>`;
  },
};
