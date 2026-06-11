# Are Tests Fast Yet?

A collection of dashboards for visualizing the health and performance of
Firefox's automated tests, built from data generated in Firefox CI.

Live site: <https://tests.firefox.dev/>, where the data is refreshed every
night. There is also a staging instance at
<https://fqueze.github.io/aretestsfastyet/> used to develop the dashboards
themselves; its data is regenerated whenever work-in-progress patches to the
data generator are pushed to Try.

## Dashboards

Every page is listed on [`help.html`](help.html); the most useful ones are
also reachable from the "Dashboards ▾" menu in the top-right corner of each
page. The main ones:

- **Test Health** (`index.html`) — the landing page. Trend charts and a 7-day
  summary of flaky test-failure, flaky job-failure, skip and invalid-job rates
  for XPCShell and Mochitest.
- **Test Issues** (`issues.html`) — every non-passing test outcome (failures,
  timeouts, crashes, skips) over the last 21 days, grouped by Bugzilla
  component and by directory tree. The best place to start triaging
  intermittents.
- **Test Info** (`test.html`) — a deep dive on a single test
  (`?test=path/to/test`): failure/skip/crash history, per-run timings, and a
  pass/fail breakdown across job configurations.
- **Try Push Results** (`try.html`) — aggregates the failed tests from a single
  Try push, perma-fails first, matched against historical data.
- **Failures** (`failures.html`) / **Crashes** (`crashes.html`) — failures
  grouped by message, and crashes grouped by signature.
- **Test Timings** (`xpcshell-timings.html`) — per-test run times with a tree
  view and scatter charts.
- **Build Times** (`builds.html`), **Mochitest Jobs** (`mochitest-jobs.html`),
  **XPCShell Jobs** (`xpcshell-jobs.html`), **Manifest Runtimes**
  (`manifests.html`), **Worker Pools** (`workers.html`) — job- and
  infrastructure-level timing views.

A number of older or more specialized dashboards (Perma-Fails, Variant Impact,
Errors & Warnings, Resource Usage, and others) are listed under "Less
frequently used dashboards" on `help.html`.

## How it works

The site is a set of static HTML pages with inline CSS and JavaScript, sharing
a few scripts (`fetch-utils.js`, `shared.js`, `common-ui.js`, `dashboards.js`,
…). There is no build step.

Each page fetches pre-aggregated JSON data from the Firefox CI (Taskcluster)
index at runtime — there is no server. The data is produced by
[`fetch-test-data.js`](https://searchfox.org/mozilla-central/source/testing/timings/fetch-test-data.js)
in mozilla-central, which queries Firefox CI and writes the compact,
table-encoded JSON files the dashboards consume.

## Data format

The JSON file formats are documented in
[`JSON_FORMAT.md`](https://searchfox.org/mozilla-central/source/testing/timings/JSON_FORMAT.md),
which lives next to the generator in mozilla-central.
