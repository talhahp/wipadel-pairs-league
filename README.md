# Wi Padel Sherwood Pairs League

**Live: <https://talhahp.github.io/wipadel-pairs-league/>**

A self-service league site that replaces the Google Sheet. Players find their own
fixtures, message their opponents, and submit scores; the table updates itself.

Plain static files — no build step, no framework. Hosted free on GitHub Pages.

> **Status:** the site is deployed and running in **demo mode** — it shows a sample
> league stored in each visitor's own browser. It becomes the real shared league as
> soon as the Supabase keys are added (step 1–2 below). Don't share the link with
> players until then.

---

## What it does

| Screen | For |
|---|---|
| **My team** | The main one. A pair picks themselves once, then sees all 9 fixtures split into *still to play* and *played*, with each opponent's WhatsApp number inline. No fixed order. |
| **Standings** | Live table with the league's scoring and its full tie-break chain. |
| **Fixtures** | All 45 matches, searchable, filterable by played / outstanding. |
| **Grid** | The 10×10 cross grid — who has played whom at a glance. |
| **Contacts** | The contact directory. |
| **Enter score** | Validated result submission. One submission per match. |
| **Rules** | The format, the points, the deadlines. |
| **Admin** | PIN-gated: pairs, numbers, fixtures, result corrections, settings. |

### Scoring

Three points are shared in every match:

* **1 point per full set won**
* **1 point for winning the match**
* The 10-point super tie-break is **not** a set — it only decides the match point.

So a 2–0 win is **3–0**, and a win on the super tie-break is **2–1**.

Ties are broken by: total points → head-to-head → sets won → game difference → name.

---

## Running it locally

```bash
npm run serve
```

Then open <http://localhost:4178>. (A server is only needed because ES modules
will not load over `file://` — the deployed site is static.)

With no Supabase keys configured it runs in **demo mode**: a sample league stored
in your own browser, so you can click through everything before setting up a
database. The demo admin PIN is `padel2026`.

Run the tests for the scoring, standings and fixture generation:

```bash
npm test
```

---

## Going live

### 1. Create the database (free)

1. Make a project at [supabase.com](https://supabase.com) (free tier is plenty — this
   league is a few hundred rows).
2. Open **SQL Editor** and run `supabase/01_schema.sql`, then `supabase/02_seed.sql`.
   That creates the tables, the security rules, both divisions, the 10 Intermediate
   pairs and their full 45-match round robin.
3. **Change the admin PIN** — the seed sets it to `padel2026`:

   ```sql
   select admin_set_pin('padel2026', 'your-new-pin');
   ```

### 2. Point the site at it

In `assets/js/config.js`, fill in the two values from
**Project Settings → API**:

```js
export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

Both are public by design — see *Security* below.

### 3. Publishing

Already done — this repo is live on GitHub Pages at
<https://talhahp.github.io/wipadel-pairs-league/>, built from `main` at the repo root.

Every push to `main` redeploys it, usually within a minute:

```bash
git add -A
git commit -m "Update the league site"
git push
```

(`.nojekyll` is here so the `assets` folder is served untouched. `netlify.toml` is
kept for the alternative of dragging this folder onto
[app.netlify.com/drop](https://app.netlify.com/drop) if you ever want a nicer domain.)

### 4. Finish the setup

1. Open the live site, go to **Admin**, unlock with your PIN.
2. Add each pair's **WhatsApp numbers** — without them players cannot reach each other,
   which is the one thing the site is for.
3. Add the **Beginner** pairs, then press **Generate fixtures** for that division.
4. Put the link in the WhatsApp group description.

---

## Security

The Supabase anon key ships inside the page — that is normal and expected. The
database is protected by what the key is *allowed to do*, not by hiding it:

* Row level security is on for every table, and the only policies are `SELECT`.
  The league is public to read, which is the point.
* There are **no** insert/update/delete policies. Every write goes through a
  `SECURITY DEFINER` function.
* `submit_result` accepts a score only for a fixture that has no result yet, and
  only if the scoreline is a legal padel result. It cannot overwrite anything.
* Everything else requires the admin PIN, checked against a bcrypt hash in a table
  the anon role has no grants on at all.

Scoreline rules live in two places on purpose: `core.js` for instant feedback while
typing, and `01_schema.sql` as the copy that is actually enforced.

**Worth knowing:** the PIN is the only thing guarding admin, and there is no rate
limiting on guessing it. Use something long, and don't reuse a password.

---

## Project layout

```
index.html              Shell: header, nav, footer
assets/css/app.css      All styling, on the Wi Padel logo palette
assets/js/
  config.js             Supabase URL + anon key          <- edit this
  core.js               Scoring, standings, round robin   (pure, tested)
  store.js              Supabase or demo backend
  ui.js                 Escaping + small render helpers
  views.js              Player screens
  admin.js              Organiser screen
  app.js                Boot + hash routing
supabase/
  01_schema.sql         Tables, RLS, functions            <- run first
  02_seed.sql           Divisions, pairs, 45 fixtures     <- run second
  generate-seed.mjs     Regenerates 02_seed.sql
tests/core.test.mjs     29 tests over the league logic
server.mjs              Local preview server only
```

### Changing the seeded pairs

Edit the list in `supabase/generate-seed.mjs`, then:

```bash
node supabase/generate-seed.mjs
```

This rewrites `02_seed.sql` with a fresh fixture list from the same round-robin code
the site uses. For a league that is already running, use the Admin screen instead —
it will not let you wipe played results by accident.

---

## Notes

* Hash routing (`#/standings`) so it works on any static host with no redirect rules.
* Dark theme only, built around the logo's navy / azure / orange / lime.
* The page reloads the league when the tab regains focus, so a table left open
  catches up on results other people submitted.
