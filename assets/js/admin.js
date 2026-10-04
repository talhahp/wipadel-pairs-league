/**
 * Organiser screen: pairs, fixtures, result corrections and league settings.
 *
 * The PIN is held in memory for the life of the page only - never written to
 * localStorage - and is sent with each call so the database can check it.
 */

import { html, raw, mount, empty, notice, flash, errorText,
         formData, shortDate, longDate } from './ui.js';
import * as store from './store.js';
import { scoreMatch, formatScoreline, divisionProgress } from './core.js';

let pin = null;            // in-memory only
let panel = 'teams';
let banner = null;         // survives the re-render that follows a write

/** Report an outcome and redraw. Set before rerendering, shown once, then cleared. */
function say(ctx, kind, title, body) {
  banner = { kind, title, body };
  ctx.rerender();
}

export const adminView = {
  id: 'admin',
  label: 'Admin',

  render(ctx) {
    if (!pin) return lockScreen();

    const shown = banner;
    banner = null;

    const tabs = [
      ['teams', 'Pairs'],
      ['fixtures', 'Fixtures'],
      ['results', 'Results'],
      ['settings', 'Settings'],
    ];

    return html`
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Organiser</p>
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
        ${panel === 'fixtures' ? fixturesPanel(ctx) : ''}
        ${panel === 'results' ? resultsPanel(ctx) : ''}
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
          if (!ok) throw new Error('That PIN was not recognised.');
          pin = value;
          ctx.rerender();
        } catch (err) {
          flash(root.querySelector('#unlock-msg'), 'err', 'Not unlocked.', errorText(err));
          btn.disabled = false;
        }
      });
      return;
    }

    root.querySelector('[data-act="lock"]')?.addEventListener('click', () => {
      pin = null;
      ctx.rerender();
    });

    root.querySelectorAll('[data-panel]').forEach((b) => {
      b.addEventListener('click', () => { panel = b.dataset.panel; ctx.rerender(); });
    });

    root.querySelectorAll('[data-division]').forEach((b) => {
      b.addEventListener('click', () => ctx.setDivision(b.dataset.division));
    });

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
            id: d.id || null,
            division_id: d.division_id,
            name: d.name,
            player1: d.player1,
            player2: d.player2,
            phone1: d.phone1,
            phone2: d.phone2,
            rating: d.rating,
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
      b.addEventListener('click', async () => {
        const t = store.findTeam(b.dataset.delTeam);
        if (!t) return;
        if (!confirm(`Remove ${t.name}? Their fixtures will be removed too.`)) return;
        try {
          await store.adminDeleteTeam(pin, t.id);
          say(ctx, 'ok', `${t.name} removed.`);
        } catch (err) {
          flash(msg, 'err', 'Not removed.', errorText(err));
        }
      });
    });

    /* ---- fixtures ---- */

    root.querySelectorAll('[data-gen]').forEach((b) => {
      b.addEventListener('click', async () => {
        const divisionId = b.dataset.gen;
        const force = b.dataset.force === '1';
        const division = store.state.divisions.find((d) => d.id === divisionId);
        const teams = store.divisionTeams(divisionId);

        const warning = force
          ? `This ERASES every result already played in ${division.name} and rebuilds all fixtures. Continue?`
          : `Generate the full round robin for ${division.name} (${teams.length} pairs)?`;
        if (!confirm(warning)) return;

        b.disabled = true;
        try {
          const n = await store.adminGenerateFixtures(pin, divisionId, force);
          say(ctx, 'ok', `${n} fixtures created for ${division.name}.`);
        } catch (err) {
          flash(msg, 'err', 'Fixtures not generated.', errorText(err));
          b.disabled = false;
        }
      });
    });

    /* ---- results ---- */

    root.querySelectorAll('[data-clear]').forEach((b) => {
      b.addEventListener('click', async () => {
        const m = store.state.matches.find((x) => x.id === b.dataset.clear);
        if (!m || !confirm(`Clear the result for match ${m.match_no}?`)) return;
        try {
          await store.adminClearResult(pin, m.id);
          say(ctx, 'ok', `Match ${m.match_no} is back to unplayed.`);
        } catch (err) {
          flash(msg, 'err', 'Not cleared.', errorText(err));
        }
      });
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

    /* ---- settings ---- */

    const setForm = root.querySelector('#settings-form');
    if (setForm) {
      setForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(setForm);
        const btn = setForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await store.adminUpdateSettings(pin, {
            venue: d.venue,
            season_start: d.season_start,
            season_end: d.season_end,
            pace_target_date: d.pace_target_date,
            pace_target_matches: Number(d.pace_target_matches) || 4,
            booking_url: d.booking_url,
            whatsapp_url: d.whatsapp_url,
            results_locked: setForm.elements.results_locked.checked,
          });
          say(ctx, 'ok', 'Settings saved.');
        } catch (err) {
          flash(msg, 'err', 'Not saved.', errorText(err));
          btn.disabled = false;
        }
      });
    }

    root.querySelector('[data-act="reset-demo"]')?.addEventListener('click', async () => {
      if (!confirm('Throw away the demo league and start again from the sample data?')) return;
      await store.resetDemo();
      say(ctx, 'ok', 'Demo league reset.');
    });
  },
};

/* ------------------------------------------------------------------ panels */

function lockScreen() {
  return html`
    <section class="view">
      <div class="section-head">
        <div>
          <p class="eyebrow">Organiser only</p>
          <h2>League admin</h2>
          <p>Add pairs and their numbers, generate fixtures, and correct results.</p>
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
  const division = store.state.divisions.find((d) => d.id === ctx.division);

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
          <input id="tf-ph1" name="phone1" inputmode="tel" placeholder="+27 82 123 4567">
        </div>
      </div>

      <div class="inline-form">
        <div class="field">
          <label for="tf-p2">Player 2</label>
          <input id="tf-p2" name="player2" maxlength="60">
        </div>
        <div class="field">
          <label for="tf-ph2">Player 2 WhatsApp</label>
          <input id="tf-ph2" name="phone2" inputmode="tel" placeholder="+27 82 123 4567">
        </div>
      </div>

      <div class="field" style="max-width:220px">
        <label for="tf-rating">Pair rating (optional)</label>
        <input id="tf-rating" name="rating" type="number" step="0.01" min="0" max="7" placeholder="2.45">
        <span class="field__hint">Average Playtomic rating of the two players.</span>
      </div>

      <div class="btn-row">
        <button class="btn btn--primary" type="submit">Save pair</button>
      </div>
    </form>`;
}

function fixturesPanel(ctx) {
  return html`
    <div class="section-head" style="margin-top:18px">
      <div>
        <h2 style="font-size:20px">Fixtures</h2>
        <p>A full round robin: every pair plays every other pair once, with the
           duty of messaging first shared out evenly.</p>
      </div>
    </div>

    ${store.state.divisions.map((d) => {
      const teams = store.divisionTeams(d.id);
      const matches = store.divisionMatches(d.id);
      const p = divisionProgress(teams, matches);
      const expected = teams.length >= 2 ? (teams.length * (teams.length - 1)) / 2 : 0;

      return html`
        <div class="card card--pad" style="margin-bottom:12px">
          <div class="section-head" style="margin-bottom:8px">
            <div>
              <h3 style="font-size:17px">${d.name}</h3>
              <p>${teams.length} pairs &middot; ${matches.length} fixtures &middot;
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
                    ? notice('warn', `The pair list has changed.`,
                        `There are ${matches.length} fixtures but ${teams.length} pairs now need ${expected}. Rebuild to fix this.`)
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

function resultsPanel(ctx) {
  const byId = store.teamsById();
  const done = store.state.matches
    .filter((m) => m.status === 'completed')
    .sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || '') || b.match_no - a.match_no);

  const pending = store.state.matches.filter((m) => m.status !== 'completed');

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
            ${pending.map((m) => html`<option value="${m.id}">#${m.match_no} ${
              byId.get(m.home_team)?.name || '?'} v ${byId.get(m.away_team)?.name || '?'}</option>`)}
          </optgroup>` : ''}
          ${done.length ? html`<optgroup label="Already played (will be overwritten)">
            ${done.map((m) => html`<option value="${m.id}">#${m.match_no} ${
              byId.get(m.home_team)?.name || '?'} v ${byId.get(m.away_team)?.name || '?'} (${formatScoreline(m)})</option>`)}
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

function settingsPanel() {
  const s = store.state.settings || {};
  return html`
    <div class="section-head" style="margin-top:18px">
      <div><h2 style="font-size:20px">League settings</h2></div>
    </div>

    <form class="card card--pad stack" id="settings-form">
      <div class="field">
        <label for="st-venue">Venue</label>
        <input id="st-venue" name="venue" value="${s.venue || ''}">
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
          <input id="st-pacen" name="pace_target_matches" type="number" min="0" max="20"
                 value="${s.pace_target_matches ?? 4}">
        </div>
      </div>

      <div class="field">
        <label for="st-booking">Booking link</label>
        <input id="st-booking" name="booking_url" type="url" value="${s.booking_url || ''}">
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

    ${store.isLive() ? html`
      <div class="notice" style="margin-top:18px">
        <strong>Changing the admin PIN.</strong>
        <p>Run this in the Supabase SQL editor, with your current PIN and the new one:</p>
        <p class="mono" style="font-size:12.5px">select admin_set_pin('current-pin', 'new-pin');</p>
      </div>`
    : html`
      <div class="notice notice--warn" style="margin-top:18px">
        <strong>Demo mode.</strong>
        <p>Nothing here is shared - it is stored in this browser only. Add your Supabase
           keys to <span class="mono">assets/js/config.js</span> to go live.</p>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn--sm btn--danger" type="button" data-act="reset-demo">Reset demo data</button>
        </div>
      </div>`}`;
}
