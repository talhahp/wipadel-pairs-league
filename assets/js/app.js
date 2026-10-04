/**
 * Boot and routing.
 *
 * Hash routes (#/standings) rather than real paths, so the site works on any
 * static host - GitHub Pages, Netlify, Cloudflare Pages - with no redirect rules.
 */

import { html, mount, notice, errorText, longDate } from './ui.js';
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
  rerender() { render(); },
};

/* ------------------------------------------------------------------ routing */

function parse(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { path: path || 'my', query: new URLSearchParams(qs || '') };
}

function onRoute() {
  const { path } = parse(location.hash);
  current = VIEWS.some((v) => v.id === path) ? path : 'my';
  render();
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' in document.body.style ? 'instant' : 'auto' });
}

/* ------------------------------------------------------------------ chrome */

function renderNav() {
  mount(nav, html`
    ${VIEWS.map((v) => html`
      <button type="button" data-view="${v.id}" aria-current="${v.id === current ? 'true' : 'false'}">
        ${v.label}
      </button>`)}`);

  nav.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => { location.hash = `#/${b.dataset.view}`; });
  });
}

function renderChrome() {
  const s = store.state.settings;
  const meta = document.getElementById('masthead-meta');
  const bits = [BRAND.season];
  if (s?.promo_discount) bits.push(`${s.promo_discount} off court bookings`);
  if (!store.isLive()) bits.push('Demo mode');
  mount(meta, html`${bits.map((b) => html`<span>${b}</span>`)}`);

  const foot = document.getElementById('foot-right');
  mount(foot, html`${s?.season_end ? `Season ends ${longDate(s.season_end)}` : ''}`);
  document.getElementById('foot-left').textContent =
    `${BRAND.club} ${BRAND.league}`;
}

/* ------------------------------------------------------------------- render */

function render() {
  const view = VIEWS.find((v) => v.id === current) || myTeamView;

  // Keep the division sensible: fall back to the first one that exists.
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
  try {
    await store.init();
  } catch (err) {
    console.error(err);
    mount(main, notice('err', 'Could not load the league.', errorText(err)));
    return;
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
