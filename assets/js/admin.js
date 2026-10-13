/**
 * Organiser screen: pairs, divisions, fixtures, results, rules and settings.
 *
 * Everything here applies to the league currently being viewed, and the PIN is
 * checked against that league, so one club's organiser cannot edit another's.
 *
 * The PIN is held in memory for the life of the page only, never written to
 * localStorage, and is sent with each call.
 */

import { html, raw, empty, notice, flash, errorText, isStale, mount,
         formData, shortDate, longDate } from './ui.js';
import * as store from './store.js';
import { scoreMatch, formatScoreline, divisionProgress,
         fixtureCount, matchesPerTeam } from './core.js';

let pin = null;            // in-memory only
let pinLeague = null;      // which league that PIN unlocked
let panel = 'teams';
let banner = null;

function say(ctx, kind, title, body) {
  banner = { kind, title, body };
  ctx.rerender();
}

export const adminView = {
  id: 'admin',
  label: 'Admin',

  render(ctx) {
    // Switching league locks the screen again: a PIN is per league.
    if (pin && pinLeague !== store.state.leagueId) {
      pin = null;
      pinLeague = null;
    }
    if (!pin) return lockScreen();

    const shown = banner;
    banner = null;

    const tabs = [
      ['teams', 'Pairs'],
      ['divisions', 'Divisions'],
      ['fixtures', 'Fixtures'],
      ['results', 'Results'],
      ['rules', 'Rules'],
      ['settings', 'Settings'],
    ];

    return html`
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Organiser &middot; ${store.state.league?.venue || ''}</p>
            <h2>League admin</h2>
            <p>Changes here are live for everyone immediately.</p>
          </div>
          <button class="btn btn--ghost btn--sm" type="button" data-act="lock">Lock</button>
        </div>

        <div id="admin-msg">${shown ? notice(shown.kind, shown.title, shown.body) : ''}</div>

        <div class="divisions" role="tablist" aria-label="Admin section">
          ${tabs.map(([id, label]) => html`
            <button role="tab" type="button" data-panel="${id}"
                    aria-current="${panel === id ? 'true' : 'false'}">${label}</button>`)}
        </div>

        ${panel === 'teams' ? teamsPanel(ctx) : ''}
        ${panel === 'divisions' ? divisionsPanel(ctx) : ''}
        ${panel === 'fixtures' ? fixturesPanel(ctx) : ''}
        ${panel === 'results' ? resultsPanel(ctx) : ''}
        ${panel === 'rules' ? rulesPanel(ctx) : ''}
        ${panel === 'settings' ? settingsPanel() : ''}
      </section>`;
  },

  wire(root, ctx) {
    const msg = root.querySelector('#admin-msg');

    const unlock = root.querySelector('#unlock-form');
    if (unlock) {
      unlock.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = formData(unlock).pin;
        const btn = unlock.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const ok = await store.adminCheck(value);
          if (!ok) throw new Error('That PIN was not recognised for this league.');
          pin = value;
          pinLeague = store.state.leagueId;
          ctx.rerender();
        } catch (err) {
          const box = root.querySelector('#unlock-msg');
          if (isStale(err)) {
            // Nothing is wrong with the PIN: this tab is just out of date.
            mount(box, html`
              <div class="notice notice--warn">
                <strong>This page is out of date.</strong>
                <p>${errorText(err)}</p>
                <div class="btn-row" style="margin-top:10px">
                  <button class="btn btn--sm btn--primary" type="button" data-act="reload">Reload now</button>
                </div>
              </div>`);
            box.querySelector('[data-act="reload"]')
               ?.addEventListener('click', () => location.reload());
          } else {
            flash(box, 'err', 'Not unlocked.', errorText(err));
          }
          btn.disabled = false;
        }
      });
      return;
    }

    root.querySelector('[data-act="lock"]')?.addEventListener('click', () => {
      pin = null; pinLeague = null;
      ctx.rerender();
    });

    root.querySelectorAll('[data-panel]').forEach((b) => {
      b.addEventListener('click', () => { panel = b.dataset.panel; ctx.rerender(); });
    });

    root.querySelectorAll('[data-division]').forEach((b) => {
      b.addEventListener('click', () => ctx.setDivision(b.dataset.division));
    });

    const guard = async (fn, failTitle) => {
      try {
        await fn();
      } catch (err) {
        flash(msg, 'err', failTitle, errorText(err));
      }
    };

    /* ---- pairs ---- */

    const teamForm = root.querySelector('#team-form');
    if (teamForm) {
      teamForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(teamForm);
        const btn = teamForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminSaveTeam(pin, {
            id: d.id || null, division_id: d.division_id, name: d.name,
            player1: d.player1, player2: d.player2,
            phone1: d.phone1, phone2: d.phone2, rating: d.rating,
          });
          say(ctx, 'ok', d.id ? 'Pair updated.' : `${d.name} added.`);
        } catch (err) {
          flash(msg, 'err', 'Not saved.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    root.querySelectorAll('[data-edit-team]').forEach((b) => {
      b.addEventListener('click', () => {
        const t = store.findTeam(b.dataset.editTeam);
        if (!t || !teamForm) return;
        teamForm.elements.id.value = t.id;
        teamForm.elements.name.value = t.name;
        teamForm.elements.player1.value = t.player1 || '';
        teamForm.elements.player2.value = t.player2 || '';
        teamForm.elements.phone1.value = t.phone1 || '';
        teamForm.elements.phone2.value = t.phone2 || '';
        teamForm.elements.rating.value = t.rating ?? '';
        root.querySelector('#team-form-title').textContent = `Editing ${t.name}`;
        teamForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    root.querySelector('[data-act="new-team"]')?.addEventListener('click', () => {
      teamForm.reset();
      teamForm.elements.id.value = '';
      root.querySelector('#team-form-title').textContent = 'Add a pair';
      teamForm.elements.name.focus();
    });

    root.querySelectorAll('[data-del-team]').forEach((b) => {
      b.addEventListener('click', () => guard(async () => {
        const t = store.findTeam(b.dataset.delTeam);
        if (!t || !confirm(`Remove ${t.name}? Their fixtures will be removed too.`)) return;
        await store.adminDeleteTeam(pin, t.id);
        say(ctx, 'ok', `${t.name} removed.`);
      }, 'Not removed.'));
    });

    /* ---- divisions ---- */

    const divForm = root.querySelector('#division-form');
    if (divForm) {
      divForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(divForm);
        const btn = divForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminSaveDivision(pin, {
            id: d.id || null, slug: d.slug, name: d.name,
            rating_label: d.rating_label, meetings: d.meetings, sort_order: d.sort_order,
          });
          say(ctx, 'ok', d.id ? 'Division updated.' : `${d.name} added.`,
            d.id ? 'If you changed how often pairs meet, rebuild its fixtures.' : null);
        } catch (err) {
          flash(msg, 'err', 'Not saved.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    root.querySelectorAll('[data-edit-div]').forEach((b) => {
      b.addEventListener('click', () => {
        const d = store.findDivision(b.dataset.editDiv);
        if (!d || !divForm) return;
        divForm.elements.id.value = d.id;
        divForm.elements.slug.value = d.slug || '';
        divForm.elements.name.value = d.name;
        divForm.elements.rating_label.value = d.rating_label || '';
        divForm.elements.meetings.value = d.meetings || 1;
        divForm.elements.sort_order.value = d.sort_order ?? 0;
        root.querySelector('#division-form-title').textContent = `Editing ${d.name}`;
        divForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    root.querySelector('[data-act="new-division"]')?.addEventListener('click', () => {
      divForm.reset();
      divForm.elements.id.value = '';
      divForm.elements.meetings.value = 1;
      root.querySelector('#division-form-title').textContent = 'Add a division';
      divForm.elements.name.focus();
    });

    root.querySelectorAll('[data-del-div]').forEach((b) => {
      b.addEventListener('click', () => guard(async () => {
        const d = store.findDivision(b.dataset.delDiv);
        if (!d) return;
        const n = store.divisionTeams(d.id).length;
        if (!confirm(`Remove ${d.name}? Its ${n} pair(s) and all its fixtures go with it.`)) return;
        await store.adminDeleteDivision(pin, d.id);
        say(ctx, 'ok', `${d.name} removed.`);
      }, 'Not removed.'));
    });

    /* ---- fixtures ---- */

    root.querySelectorAll('[data-gen]').forEach((b) => {
      b.addEventListener('click', () => guard(async () => {
        const divisionId = b.dataset.gen;
        const force = b.dataset.force === '1';
        const d = store.findDivision(divisionId);
        const teams = store.divisionTeams(divisionId).length;
        const total = fixtureCount(teams, d.meetings || 1);

        const warning = force
          ? `This ERASES every result already played in ${d.name} and rebuilds all fixtures. Continue?`
          : `Generate ${total} fixtures for ${d.name}? ${teams} pairs, each playing the others ` +
            `${d.meetings === 1 ? 'once' : d.meetings + ' times'}.`;
        if (!confirm(warning)) return;

        b.disabled = true;
        const n = await store.adminGenerateFixtures(pin, divisionId, force);
        say(ctx, 'ok', `${n} fixtures created for ${d.name}.`);
      }, 'Fixtures not generated.'));
    });

    /* ---- results ---- */

    root.querySelectorAll('[data-clear]').forEach((b) => {
      b.addEventListener('click', () => guard(async () => {
        const m = store.state.matches.find((x) => x.id === b.dataset.clear);
        if (!m || !confirm(`Clear the result for match ${m.match_no}?`)) return;
        await store.adminClearResult(pin, m.id);
        say(ctx, 'ok', `Match ${m.match_no} is back to unplayed.`);
      }, 'Not cleared.'));
    });

    const fixForm = root.querySelector('#fix-form');
    if (fixForm) {
      fixForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(fixForm);
        const btn = fixForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminSetResult(pin, d.matchId, {
            s1_home: d.s1_home, s1_away: d.s1_away,
            s2_home: d.s2_home, s2_away: d.s2_away,
            stb_home: d.stb_home, stb_away: d.stb_away,
            played_on: d.played_on || null,
          }, d.note);
          say(ctx, 'ok', 'Result saved.');
        } catch (err) {
          flash(msg, 'err', 'Not saved.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    /* ---- rules ---- */

    const ruleForm = root.querySelector('#rule-form');
    if (ruleForm) {
      ruleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(ruleForm);
        const btn = ruleForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminSaveRule(pin, {
            id: d.id || null, heading: d.heading, body: d.body,
            kind: d.kind, visible: ruleForm.elements.visible.checked,
          });
          say(ctx, 'ok', d.id ? 'Section updated.' : `"${d.heading}" added.`);
        } catch (err) {
          flash(msg, 'err', 'Not saved.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    root.querySelectorAll('[data-edit-rule]').forEach((b) => {
      b.addEventListener('click', () => {
        const r = store.state.rules.find((x) => x.id === b.dataset.editRule);
        if (!r || !ruleForm) return;
        ruleForm.elements.id.value = r.id;
        ruleForm.elements.heading.value = r.heading;
        ruleForm.elements.body.value = r.body || '';
        ruleForm.elements.kind.value = r.kind;
        ruleForm.elements.visible.checked = r.visible !== false;
        root.querySelector('#rule-form-title').textContent = `Editing "${r.heading}"`;
        ruleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    root.querySelector('[data-act="new-rule"]')?.addEventListener('click', () => {
      ruleForm.reset();
      ruleForm.elements.id.value = '';
      ruleForm.elements.visible.checked = true;
      root.querySelector('#rule-form-title').textContent = 'Add a section';
      ruleForm.elements.heading.focus();
    });

    root.querySelectorAll('[data-del-rule]').forEach((b) => {
      b.addEventListener('click', () => guard(async () => {
        const r = store.state.rules.find((x) => x.id === b.dataset.delRule);
        if (!r || !confirm(`Delete the "${r.heading}" section?`)) return;
        await store.adminDeleteRule(pin, r.id);
        say(ctx, 'ok', 'Section deleted.');
      }, 'Not deleted.'));
    });

    root.querySelectorAll('[data-move-rule]').forEach((b) => {
      b.addEventListener('click', () => guard(async () => {
        await store.adminMoveRule(pin, b.dataset.moveRule, b.dataset.dir);
        ctx.rerender();
      }, 'Could not reorder.'));
    });

    /* ---- settings ---- */

    const setForm = root.querySelector('#settings-form');
    if (setForm) {
      setForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(setForm);
        const btn = setForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminUpdateLeague(pin, {
            name: d.name, venue: d.venue,
            season_start: d.season_start, season_end: d.season_end,
            pace_target_date: d.pace_target_date,
            pace_target_matches: Number(d.pace_target_matches) || 4,
            promo_discount: d.promo_discount,
            booking_url: d.booking_url, whatsapp_url: d.whatsapp_url,
            results_locked: setForm.elements.results_locked.checked,
          });
          say(ctx, 'ok', 'Settings saved.');
        } catch (err) {
          flash(msg, 'err', 'Not saved.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    const newLeague = root.querySelector('#league-form');
    if (newLeague) {
      newLeague.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(newLeague);
        const btn = newLeague.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminCreateLeague(pin, {
            id: d.id, name: d.name, venue: d.venue,
            season_start: d.season_start || null, season_end: d.season_end || null,
            pin: d.new_pin,
          });
          say(ctx, 'ok', `${d.name} created.`,
            'Switch to it with the picker at the top, using its own PIN. It starts with a copy of these rules.');
        } catch (err) {
          flash(msg, 'err', 'League not created.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    root.querySelector('[data-act="reset-demo"]')?.addEventListener('click', () => guard(async () => {
      if (!confirm('Throw away the demo data and start again from the sample leagues?')) return;
      await store.resetDemo();
      say(ctx, 'ok', 'Demo data reset.');
    }, 'Could not reset.'));
  },
};

/* ------------------------------------------------------------------ panels */

function lockScreen() {
  const league = store.state.league;
  return html`
    <section class="view">
      <div class="section-head">
        <div>
          <p class="eyebrow">Organiser only</p>
          <h2>League admin</h2>
          <p>Add pairs and their numbers, set how each division runs, edit the rules,
             and correct results for <strong>${league ? league.venue : 'this league'}</strong>.</p>
        </div>
      </div>

      <div id="unlock-msg"></div>

      <form class="card card--pad pick" id="unlock-form">
        <div class="field">
          <label for="pin">Admin PIN</label>
          <input id="pin" name="pin" type="password" autocomplete="current-password" required>
        </div>
        <div class="btn-row">
          <button class="btn btn--primary" type="submit">Unlock</button>
        </div>
        ${store.isLive() ? '' : html`
          <p class="field__hint">Demo mode: the PIN is <strong>padel2026</strong>.</p>`}
      </form>
    </section>`;
}

function adminDivisionSwitch(ctx) {
  return html`
    <div class="divisions" style="margin:18px 0 14px">
      ${store.state.divisions.map((d) => html`
        <button type="button" data-division="${d.id}"
                aria-current="${d.id === ctx.division ? 'true' : 'false'}">${d.name}</button>`)}
    </div>`;
}

function teamsPanel(ctx) {
  const teams = store.divisionTeams(ctx.division);
  const division = store.findDivision(ctx.division);

  return html`
    ${adminDivisionSwitch(ctx)}

    <div class="section-head">
      <div><h2 style="font-size:20px">${division ? division.name : ''} pairs (${teams.length})</h2></div>
      <button class="btn btn--sm" type="button" data-act="new-team">Add a pair</button>
    </div>

    ${teams.length ? html`
      <div class="table-scroll" style="margin-bottom:22px">
        <table>
          <thead>
            <tr><th class="l">#</th><th class="l">Pair</th><th class="l hide-sm">Numbers</th><th></th></tr>
          </thead>
          <tbody>
            ${teams.map((t) => html`
              <tr>
                <td class="rank">${t.seed}</td>
                <td class="l">
                  <span class="team-name">${t.name}</span>
                  <span class="team-sub">${[t.player1, t.player2].filter(Boolean).join(' & ')}${
                    t.rating ? `  ·  avg ${Number(t.rating).toFixed(2)}` : ''}</span>
                </td>
                <td class="l hide-sm mono" style="font-size:12.5px">
                  ${t.phone1 || html`<span class="muted">-</span>`}<br>
                  ${t.phone2 || html`<span class="muted">-</span>`}
                </td>
                <td>
                  <div class="btn-row" style="justify-content:flex-end">
                    <button class="btn btn--sm btn--ghost" type="button" data-edit-team="${t.id}">Edit</button>
                    <button class="btn btn--sm btn--danger" type="button" data-del-team="${t.id}">Remove</button>
                  </div>
                </td>
              </tr>`)}
          </tbody>
        </table>
      </div>` : empty('No pairs yet', 'Add them below, then generate the fixtures.')}

    <form class="card card--pad stack" id="team-form">
      <h3 id="team-form-title" style="font-size:16px">Add a pair</h3>
      <input type="hidden" name="id" value="">
      <input type="hidden" name="division_id" value="${ctx.division}">

      <div class="field">
        <label for="tf-name">Pair name</label>
        <input id="tf-name" name="name" required maxlength="80" placeholder="e.g. Aktar / Ozayr">
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="tf-p1">Player 1</label>
          <input id="tf-p1" name="player1" maxlength="60">
        </div>
        <div class="field">
          <label for="tf-ph1">Player 1 WhatsApp</label>
          <input id="tf-ph1" name="phone1" inputmode="tel" placeholder="082 123 4567">
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="tf-p2">Player 2</label>
          <input id="tf-p2" name="player2" maxlength="60">
        </div>
        <div class="field">
          <label for="tf-ph2">Player 2 WhatsApp</label>
          <input id="tf-ph2" name="phone2" inputmode="tel" placeholder="082 123 4567">
        </div>
      </div>

      <div class="field" style="max-width:220px">
        <label for="tf-rating">Pair rating (optional)</label>
        <input id="tf-rating" name="rating" type="number" step="0.01" min="0" max="7" placeholder="2.45">
      </div>

      <div class="btn-row">
        <button class="btn btn--primary" type="submit">Save pair</button>
      </div>
    </form>`;
}

function divisionsPanel(ctx) {
  const divisions = store.state.divisions;

  return html`
    <div class="section-head" style="margin-top:18px">
      <div>
        <h2 style="font-size:20px">Divisions</h2>
        <p>How often pairs meet is set per division, so a small division can play
           everyone twice while a bigger one plays once.</p>
      </div>
      <button class="btn btn--sm" type="button" data-act="new-division">Add a division</button>
    </div>

    ${divisions.length ? html`
      <div class="table-scroll" style="margin-bottom:22px">
        <table>
          <thead>
            <tr><th class="l">Division</th><th>Pairs</th><th>Meet</th><th>Matches each</th>
                <th>Total</th><th></th></tr>
          </thead>
          <tbody>
            ${divisions.map((d) => {
              const n = store.divisionTeams(d.id).length;
              const built = store.divisionMatches(d.id).length;
              const want = fixtureCount(n, d.meetings || 1);
              return html`
                <tr>
                  <td class="l">
                    <span class="team-name">${d.name}</span>
                    <span class="team-sub">${d.rating_label || 'no rating cap'}</span>
                  </td>
                  <td>${n}</td>
                  <td>${d.meetings === 1 ? 'once' : `${d.meetings}x`}</td>
                  <td>${matchesPerTeam(n, d.meetings || 1)}</td>
                  <td>${built}${built !== want ? html` <span class="chip chip--orange">needs ${want}</span>` : ''}</td>
                  <td>
                    <div class="btn-row" style="justify-content:flex-end">
                      <button class="btn btn--sm btn--ghost" type="button" data-edit-div="${d.id}">Edit</button>
                      <button class="btn btn--sm btn--danger" type="button" data-del-div="${d.id}">Remove</button>
                    </div>
                  </td>
                </tr>`;
            })}
          </tbody>
        </table>
      </div>` : empty('No divisions yet', 'Add one below.')}

    <form class="card card--pad stack" id="division-form">
      <h3 id="division-form-title" style="font-size:16px">Add a division</h3>
      <input type="hidden" name="id" value="">

      <div class="inline-form">
        <div class="field">
          <label for="df-name">Name</label>
          <input id="df-name" name="name" required maxlength="40" placeholder="Beginner">
        </div>
        <div class="field">
          <label for="df-slug">Key</label>
          <input id="df-slug" name="slug" required maxlength="30" placeholder="beginner"
                 pattern="[a-z0-9][a-z0-9-]{1,30}">
          <span class="field__hint">Lower case, no spaces. Used internally.</span>
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="df-rating">Rating cap shown</label>
          <input id="df-rating" name="rating_label" maxlength="30" placeholder="0 - 1.5">
        </div>
        <div class="field">
          <label for="df-meetings">Each pair plays each other</label>
          <select id="df-meetings" name="meetings">
            <option value="1">Once</option>
            <option value="2">Twice (home and away)</option>
            <option value="3">Three times</option>
            <option value="4">Four times</option>
          </select>
          <span class="field__hint">Changing this needs the fixtures rebuilt.</span>
        </div>
        <div class="field">
          <label for="df-sort">Order</label>
          <input id="df-sort" name="sort_order" type="number" min="0" max="99" value="0">
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn--primary" type="submit">Save division</button>
      </div>
    </form>`;
}

function fixturesPanel(ctx) {
  return html`
    <div class="section-head" style="margin-top:18px">
      <div>
        <h2 style="font-size:20px">Fixtures</h2>
        <p>Every pair plays every other pair, as many times as the division is set to,
           with the duty of messaging first shared out evenly.</p>
      </div>
    </div>

    ${store.state.divisions.map((d) => {
      const teams = store.divisionTeams(d.id);
      const matches = store.divisionMatches(d.id);
      const p = divisionProgress(teams, matches);
      const expected = fixtureCount(teams.length, d.meetings || 1);

      return html`
        <div class="card card--pad" style="margin-bottom:12px">
          <div class="section-head" style="margin-bottom:8px">
            <div>
              <h3 style="font-size:17px">${d.name}</h3>
              <p>${teams.length} pairs, meeting ${d.meetings === 1 ? 'once' : `${d.meetings} times`}
                 &middot; ${matches.length} fixtures &middot;
                 ${p.played} played, ${p.remaining} outstanding</p>
            </div>
          </div>

          ${teams.length < 2
            ? notice('warn', 'Add at least two pairs first.')
            : matches.length === 0
              ? html`<div class="btn-row">
                  <button class="btn btn--primary" type="button" data-gen="${d.id}">
                    Generate ${expected} fixtures
                  </button>
                </div>`
              : html`
                  ${matches.length !== expected
                    ? notice('warn', 'The fixture list is out of date.',
                        `There are ${matches.length} fixtures but ${teams.length} pairs meeting ` +
                        `${d.meetings} time(s) needs ${expected}. Rebuild to fix this.`)
                    : ''}
                  ${p.played
                    ? notice('warn', `${p.played} result(s) already played.`,
                        'Rebuilding fixtures will erase them, so it has to be confirmed twice.')
                    : ''}
                  <div class="btn-row">
                    <button class="btn ${p.played ? 'btn--danger' : ''}" type="button"
                            data-gen="${d.id}" data-force="${p.played ? '1' : '0'}">
                      Rebuild all fixtures
                    </button>
                  </div>`}
        </div>`;
    })}`;
}

function resultsPanel() {
  const byId = store.teamsById();
  const done = store.state.matches
    .filter((m) => m.status === 'completed')
    .sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || '') || b.match_no - a.match_no);
  const pending = store.state.matches.filter((m) => m.status !== 'completed');

  const label = (m) => `#${m.match_no} ${byId.get(m.home_team)?.name || '?'} v ` +
                       `${byId.get(m.away_team)?.name || '?'}`;

  return html`
    <div class="section-head" style="margin-top:18px">
      <div>
        <h2 style="font-size:20px">Results</h2>
        <p>Correct a score that was entered wrongly, or record one that came in over WhatsApp.</p>
      </div>
    </div>

    <form class="card card--pad stack" id="fix-form" style="margin-bottom:22px">
      <h3 style="font-size:16px">Record or overwrite a result</h3>
      <div class="field">
        <label for="ff-match">Match</label>
        <select id="ff-match" name="matchId" required>
          <option value="">Choose...</option>
          ${pending.length ? html`<optgroup label="Not yet played">
            ${pending.map((m) => html`<option value="${m.id}">${label(m)}</option>`)}
          </optgroup>` : ''}
          ${done.length ? html`<optgroup label="Already played (will be overwritten)">
            ${done.map((m) => html`<option value="${m.id}">${label(m)} (${formatScoreline(m)})</option>`)}
          </optgroup>` : ''}
        </select>
      </div>

      <div class="score-grid">
        <div class="field">
          <label>Set 1</label>
          <div class="setline">
            <input name="s1_home" type="number" min="0" max="7" required>
            <span>&ndash;</span>
            <input name="s1_away" type="number" min="0" max="7" required>
          </div>
        </div>
        <div class="field">
          <label>Set 2</label>
          <div class="setline">
            <input name="s2_home" type="number" min="0" max="7" required>
            <span>&ndash;</span>
            <input name="s2_away" type="number" min="0" max="7" required>
          </div>
        </div>
        <div class="field">
          <label>Super tie-break</label>
          <div class="setline">
            <input name="stb_home" type="number" min="0" max="30">
            <span>&ndash;</span>
            <input name="stb_away" type="number" min="0" max="30">
          </div>
          <span class="field__hint">Only if the sets finished 1-1.</span>
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="ff-date">Date played</label>
          <input id="ff-date" name="played_on" type="date">
        </div>
        <div class="field">
          <label for="ff-note">Note (optional)</label>
          <input id="ff-note" name="note" maxlength="140" placeholder="e.g. corrected from WhatsApp">
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn--primary" type="submit">Save result</button>
      </div>
      <p class="field__hint">Scores are entered left-to-right in the order shown in the dropdown.</p>
    </form>

    ${done.length ? html`
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th class="l">#</th><th class="l">Match</th><th class="l">Score</th>
                <th class="l hide-sm">Entered by</th><th></th></tr>
          </thead>
          <tbody>
            ${done.map((m) => {
              const s = scoreMatch(m);
              return html`
                <tr>
                  <td class="rank">${m.match_no}</td>
                  <td class="l">
                    <span class="team-name">${byId.get(m.home_team)?.name || '?'} v ${byId.get(m.away_team)?.name || '?'}</span>
                    <span class="team-sub">${m.played_on ? shortDate(m.played_on) : 'no date'}${
                      m.note ? `  ·  ${m.note}` : ''}</span>
                  </td>
                  <td class="l mono">${formatScoreline(m)}
                    ${s.ok ? html`<span class="team-sub">${s.pointsHome}&ndash;${s.pointsAway} pts</span>`
                           : html`<span class="chip chip--orange">invalid</span>`}</td>
                  <td class="l hide-sm muted">${m.submitted_by || '-'}</td>
                  <td><button class="btn btn--sm btn--danger" type="button" data-clear="${m.id}">Clear</button></td>
                </tr>`;
            })}
          </tbody>
        </table>
      </div>` : empty('No results yet', 'Nothing has been submitted so far.')}`;
}

function rulesPanel() {
  const rules = [...store.state.rules].sort((a, b) => a.sort_order - b.sort_order);

  return html`
    <div class="section-head" style="margin-top:18px">
      <div>
        <h2 style="font-size:20px">Rules</h2>
        <p>What players read on the Rules page. The points table is generated from the
           scoring engine, so it always matches how the standings are worked out.</p>
      </div>
      <button class="btn btn--sm" type="button" data-act="new-rule">Add a section</button>
    </div>

    ${rules.length ? html`
      <div class="table-scroll" style="margin-bottom:22px">
        <table>
          <thead>
            <tr><th class="l">Section</th><th class="l hide-sm">Type</th><th></th></tr>
          </thead>
          <tbody>
            ${rules.map((r, i) => html`
              <tr>
                <td class="l">
                  <span class="team-name">${r.heading}</span>
                  ${r.visible === false ? html` <span class="chip chip--orange">hidden</span>` : ''}
                  <span class="team-sub">${(r.body || '').slice(0, 90) || (r.kind === 'scoring' ? 'generated from the scoring engine' : 'empty')}</span>
                </td>
                <td class="l hide-sm muted">${r.kind}</td>
                <td>
                  <div class="btn-row" style="justify-content:flex-end">
                    <button class="btn btn--sm btn--ghost" type="button"
                            data-move-rule="${r.id}" data-dir="up" ${i === 0 ? raw('disabled') : ''}>Up</button>
                    <button class="btn btn--sm btn--ghost" type="button"
                            data-move-rule="${r.id}" data-dir="down" ${i === rules.length - 1 ? raw('disabled') : ''}>Down</button>
                    <button class="btn btn--sm btn--ghost" type="button" data-edit-rule="${r.id}">Edit</button>
                    <button class="btn btn--sm btn--danger" type="button" data-del-rule="${r.id}">Delete</button>
                  </div>
                </td>
              </tr>`)}
          </tbody>
        </table>
      </div>` : empty('No sections yet', 'Add one below and it appears on the Rules page.')}

    <form class="card card--pad stack" id="rule-form">
      <h3 id="rule-form-title" style="font-size:16px">Add a section</h3>
      <input type="hidden" name="id" value="">

      <div class="inline-form">
        <div class="field">
          <label for="rf-heading">Heading</label>
          <input id="rf-heading" name="heading" required maxlength="60" placeholder="Balls">
        </div>
        <div class="field">
          <label for="rf-kind">Type</label>
          <select id="rf-kind" name="kind">
            <option value="prose">Text and bullets</option>
            <option value="steps">Numbered steps</option>
            <option value="scoring">Points table (generated)</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label for="rf-body">Body</label>
        <textarea id="rf-body" name="body" rows="7"
                  placeholder="One paragraph per line.&#10;Start a line with &quot;- &quot; for a bullet.&#10;For numbered steps use: Title :: the explanation"></textarea>
        <span class="field__hint">
          Plain text. A line starting with <strong>-</strong> becomes a bullet. For the
          numbered-steps type, write each step as <strong>Title :: explanation</strong>.
          The points table type ignores the body.
        </span>
      </div>

      <label class="contact" style="cursor:pointer">
        <span>Show this section to players</span>
        <input type="checkbox" name="visible" style="width:auto" checked>
      </label>

      <div class="btn-row">
        <button class="btn btn--primary" type="submit">Save section</button>
      </div>
    </form>`;
}

function settingsPanel() {
  const s = store.state.league || {};

  return html`
    <div class="section-head" style="margin-top:18px">
      <div><h2 style="font-size:20px">${s.venue || 'League'} settings</h2></div>
    </div>

    <form class="card card--pad stack" id="settings-form">
      <div class="inline-form">
        <div class="field">
          <label for="st-name">League name</label>
          <input id="st-name" name="name" value="${s.name || ''}">
        </div>
        <div class="field">
          <label for="st-venue">Venue</label>
          <input id="st-venue" name="venue" value="${s.venue || ''}">
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="st-start">Season starts</label>
          <input id="st-start" name="season_start" type="date" value="${s.season_start || ''}">
        </div>
        <div class="field">
          <label for="st-end">Season ends</label>
          <input id="st-end" name="season_end" type="date" value="${s.season_end || ''}">
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="st-pace">Recommended pace by</label>
          <input id="st-pace" name="pace_target_date" type="date" value="${s.pace_target_date || ''}">
        </div>
        <div class="field">
          <label for="st-pacen">Matches by then</label>
          <input id="st-pacen" name="pace_target_matches" type="number" min="0" max="40"
                 value="${s.pace_target_matches ?? 4}">
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="st-discount">League discount</label>
          <input id="st-discount" name="promo_discount" value="${s.promo_discount || ''}" placeholder="20%">
          <span class="field__hint">Applied automatically on Playtomic, no code needed.</span>
        </div>
        <div class="field">
          <label for="st-booking">Booking link</label>
          <input id="st-booking" name="booking_url" type="url" value="${s.booking_url || ''}">
        </div>
      </div>

      <div class="field">
        <label for="st-wa">WhatsApp group link (optional)</label>
        <input id="st-wa" name="whatsapp_url" type="url" value="${s.whatsapp_url || ''}"
               placeholder="https://chat.whatsapp.com/...">
      </div>

      <label class="contact" style="cursor:pointer">
        <span>Close result entry${s.season_end ? ` (season ends ${longDate(s.season_end)})` : ''}</span>
        <input type="checkbox" name="results_locked" style="width:auto"
               ${s.results_locked ? raw('checked') : ''}>
      </label>

      <div class="btn-row">
        <button class="btn btn--primary" type="submit">Save settings</button>
      </div>
    </form>

    ${s.is_owner ? html`
      <div class="section-head" style="margin-top:26px">
        <div>
          <h2 style="font-size:20px">Another venue</h2>
          <p>Start a second league, for example Scottburgh. It gets its own divisions,
             pairs, fixtures, settings and PIN, and begins with a copy of these rules.
             Nothing here is shared with it.</p>
        </div>
      </div>

      <form class="card card--pad stack" id="league-form">
        <div class="inline-form">
          <div class="field">
            <label for="lf-name">League name</label>
            <input id="lf-name" name="name" required maxlength="60"
                   placeholder="Wi Padel Scottburgh Pairs League">
          </div>
          <div class="field">
            <label for="lf-venue">Venue</label>
            <input id="lf-venue" name="venue" required maxlength="40" placeholder="Wi Padel Scottburgh">
          </div>
        </div>

        <div class="inline-form">
          <div class="field">
            <label for="lf-id">Link key</label>
            <input id="lf-id" name="id" required maxlength="30" placeholder="scottburgh"
                   pattern="[a-z0-9][a-z0-9-]{1,30}">
            <span class="field__hint">Appears in its link, e.g. <span class="mono">#/scottburgh/standings</span></span>
          </div>
          <div class="field">
            <label for="lf-pin">Its admin PIN</label>
            <input id="lf-pin" name="new_pin" type="password" required minlength="6"
                   autocomplete="new-password">
            <span class="field__hint">At least 6 characters. Separate from this league's PIN.</span>
          </div>
        </div>

        <div class="inline-form">
          <div class="field">
            <label for="lf-start">Season starts</label>
            <input id="lf-start" name="season_start" type="date">
          </div>
          <div class="field">
            <label for="lf-end">Season ends</label>
            <input id="lf-end" name="season_end" type="date">
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn--primary" type="submit">Create league</button>
        </div>
      </form>` : ''}

    ${store.isLive() ? html`
      <div class="notice" style="margin-top:18px">
        <strong>Changing this league's PIN.</strong>
        <p>Run this in the Supabase SQL editor, with the current PIN and the new one:</p>
        <p class="mono" style="font-size:12.5px">select admin_set_pin('${s.id}', 'current-pin', 'new-pin');</p>
      </div>`
    : html`
      <div class="notice notice--warn" style="margin-top:18px">
        <strong>Demo mode.</strong>
        <p>Nothing here is shared. It is stored in this browser only.</p>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn--sm btn--danger" type="button" data-act="reset-demo">Reset demo data</button>
        </div>
      </div>`}`;
}
