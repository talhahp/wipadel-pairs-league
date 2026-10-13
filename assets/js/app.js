/**
 * Boot and routing.
 *
 * Hash routes rather than real paths, so the site works on any static host with
 * no redirect rules. A route carries its league:
 *
 *   #/sherwood/standings      a specific league
 *   #/standings               the first league, so older links still work
 *
 * Each club can therefore put its own link in its own WhatsApp group.
 */

import { html, raw, mount, notice, errorText, longDate } from './ui.js';
import { BRAND } from './config.js';
import * as store from './store.js';
import { myTeamView, standingsView, fixturesView, gridView,
         teamsView, submitView, rulesView } from './views.js';
import { adminView } from './admin.js';

const VIEWS = [
  myTeamView, standingsView, fixturesView, gridView,
  teamsView, submitView, rulesView, adminView,
];

const main = document.getElementById('main');
const nav = document.getElementById('nav');

let current = 'my';
let division = null;

const ctx = {
  get division() { return division; },
  get query() { return parse(location.hash).query; },
  setDivision(id) { division = id; render(); },
  go(hash) { location.hash = hash; },
  /** Build a link that stays inside the league being viewed. */
  href(view, query) {
    const league = store.state.leagueId;
    const qs = query ? `?${query}` : '';
    return league ? `#/${league}/${view}${qs}` : `#/${view}${qs}`;
  },
  rerender() { render(); },
};

/* ------------------------------------------------------------------ routing */

function parse(hash) {
  const trimmed = (hash || '').replace(/^#\/?/, '');
  const [path, qs] = trimmed.split('?');
  const parts = path.split('/').filter(Boolean);

  // A leading segment that names a league is the league; otherwise it is the view.
  let league = null;
  if (parts.length && store.knowsLeague(parts[0])) league = parts.shift();

  return { league, path: parts[0] || 'my', query: new URLSearchParams(qs || '') };
}

function onRoute() {
  const { league, path } = parse(location.hash);

  if (league && league !== store.state.leagueId) {
    store.selectLeague(league);
    division = null;
  }

  current = VIEWS.some((v) => v.id === path) ? path : 'my';
  render();
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ------------------------------------------------------------------ chrome */

function renderNav() {
  mount(nav, html`
    ${VIEWS.map((v) => html`
      <button type="button" data-view="${v.id}" aria-current="${v.id === current ? 'true' : 'false'}">
        ${v.label}
      </button>`)}`);

  nav.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => { location.hash = ctx.href(b.dataset.view); });
  });
}

function renderChrome() {
  const league = store.state.league;
  const meta = document.getElementById('masthead-meta');

  const bits = [];
  if (league?.season_start && league?.season_end) {
    bits.push(`${shortSeason(league.season_start)} - ${shortSeason(league.season_end)}`);
  } else {
    bits.push(BRAND.season);
  }
  if (league?.promo_discount) bits.push(`${league.promo_discount} off court bookings`);
  if (!store.isLive()) bits.push('Demo mode');

  const others = store.state.leagues.length > 1;
  mount(meta, html`
    ${others ? html`
      <select id="league-switch" aria-label="League">
        ${store.state.leagues.map((l) => html`
          <option value="${l.id}" ${l.id === store.state.leagueId ? raw('selected') : ''}>${l.venue}</option>`)}
      </select>` : ''}
    ${bits.map((b) => html`<span>${b}</span>`)}`);

  const picker = document.getElementById('league-switch');
  if (picker) {
    picker.addEventListener('change', () => {
      store.setMyTeamId(null);          // a team from another league means nothing here
      location.hash = `#/${picker.value}/${current}`;
    });
  }

  const foot = document.getElementById('foot-right');
  mount(foot, html`${league?.season_end ? `Season ends ${longDate(league.season_end)}` : ''}`);
  document.getElementById('foot-left').textContent =
    league ? league.name : `${BRAND.club} ${BRAND.league}`;
}

function shortSeason(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------------- render */

function render() {
  const view = VIEWS.find((v) => v.id === current) || myTeamView;

  // Keep the division sensible: fall back to the first one in this league.
  const ids = store.state.divisions.map((d) => d.id);
  if (!ids.includes(division)) {
    const myTeam = store.getMyTeamId() ? store.findTeam(store.getMyTeamId()) : null;
    division = (myTeam && ids.includes(myTeam.division_id)) ? myTeam.division_id : ids[0] || null;
  }

  renderNav();
  renderChrome();

  try {
    mount(main, view.render(ctx));
    if (view.wire) view.wire(main, ctx);
  } catch (err) {
    console.error(err);
    mount(main, notice('err', 'Something went wrong drawing this page.', errorText(err)));
  }
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  const wanted = (location.hash || '').replace(/^#\/?/, '').split('/')[0] || null;

  try {
    await store.init(wanted);
  } catch (err) {
    console.error(err);
    mount(main, notice('err', 'Could not load the league.', errorText(err)));
    return;
  }

  // A remembered team from another league would otherwise show the wrong page.
  const mine = store.getMyTeamId();
  if (mine) {
    const owner = store.leagueOfTeam(mine);
    if (owner && owner !== store.state.leagueId) store.setMyTeamId(null);
  }

  window.addEventListener('hashchange', onRoute);
  onRoute();

  // Pick up results other people submit while the page is left open.
  window.addEventListener('focus', async () => {
    if (!store.isLive()) return;
    try {
      await store.refresh();
      render();
    } catch {
      // A failed background refresh should never blank the page.
    }
  });
}

boot();
