# Are Tests Fast Yet?

Dashboards, and a command-line tool, for inspecting the health and performance
of Firefox's automated tests, built from data generated in Firefox CI.

Live site: <https://tests.firefox.dev/>, where the data is refreshed every
night. There is also a staging instance at
<https://fqueze.github.io/aretestsfastyet/> used to develop the dashboards
themselves; its data is regenerated whenever work-in-progress patches to the
data generator are pushed to Try.

## Install the `fx-tests` CLI

```sh
npm install -g github:mozilla/aretestsfastyet
fx-tests guide          # start here: what the data can and cannot tell you
```

Requires Node ≥ 20. That is the whole install — it builds on install, and there
is no npm package to publish or registry to configure. To update, run the same
command again.

```sh
fx-tests test netwerk/test/unit/test_bug1195415.js   # one test's history
fx-tests try <revision>                              # triage a Try push
fx-tests issues                                      # worst components, ranked
fx-tests --help                                      # all 13 commands
```

> **Early preview.** The CLI is new and still finding its edges; several
> defects have been found by running it rather than by its tests. Please report
> anything that looks wrong. The dashboards are unaffected by it.

## Dashboards

Every page is listed on [`help.html`](help.html); the most useful ones are
also reachable from the "Dashboards ▾" menu in the top-right corner of each
page. The filenames below are the URLs on the site; where a page's source lives
in the repository is described under [How it works](#how-it-works). The main
ones:

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
…). Each page fetches pre-aggregated JSON data from the Firefox CI (Taskcluster)
index at runtime — there is no server. The data is produced by
[`fetch-test-data.js`](https://searchfox.org/mozilla-central/source/testing/timings/fetch-test-data.js)
in mozilla-central, which queries Firefox CI and writes the compact,
table-encoded JSON files the dashboards consume.

The repository holds the pages in three places:

- **the root** — the 17 pages that have not been migrated, plus `docs.html`.
  **These have no build step**: they are served exactly as they appear in the
  tree, and editing a page and reloading it is the whole loop.
- **[`site/`](site/)** — the 9 pages that have been migrated onto the shared
  library in `lib/`, so that they can `import` typed and tested code instead of
  carrying another copy of it inline. `npm run pages` builds them into
  self-contained HTML in `dist-site/` (gitignored), one file per page with its
  script inlined. That is the only thing the build buys, and it touches nothing
  in the root — see the header comment in
  [`tools/build-pages.ts`](tools/build-pages.ts) for why the output is a single
  file. Unlike a root page, a page in `site/` cannot be opened straight from
  the tree: its entry point is a `.ts` file, which a server labels
  `video/mp2t`, so the browser refuses the module outright. Editing one means
  re-running `npm run pages` and loading the built copy from `dist-site/`.
- **`old/`** — the 9 superseded root pages the migrated ones replace, kept for
  comparison until the new ones have been trusted.

The command-line tool below shares that toolchain — TypeScript, a bundler and a
test suite — across `cli/`, `lib/`, `test/` and `tools/`. See
[`docs/PARITY.md`](docs/PARITY.md) for why the pages are being migrated onto
the shared library and how the two versions are compared, and
[`docs/DEPLOY.md`](docs/DEPLOY.md) for how the built pages are meant to ship.

## `fx-tests`, the command-line tool

`fx-tests` answers the same questions as the dashboards in plain text, for
people and agents working in a terminal rather than a browser. It reads exactly
the same published JSON files, through a shared, typed and tested library in
`lib/` — there is no second data path and no server.

See the top of this file to install it. To work on it from a checkout instead:

```sh
npm install
./bin/fx-tests guide                       # runs the TypeScript sources directly
```

Node ≥ 20 is required, for built-in `fetch`; `.node-version` pins the major
version for `fnm`. `./bin/fx-tests` needs no build step. `npm run bundle`
produces `dist/fx-tests.js`, the bundle the `bin` entry in `package.json` points
at; unlike `bin/`, it is committed, because an installed package cannot build
itself — Node refuses to strip types under `node_modules`. Re-run it and commit
the result whenever the sources change; `npm test` fails on a stale bundle.
There is deliberately no `build` script: pacote prepares a git dependency
whenever the manifest has one, and that preparation breaks `npm install -g`
from a git URL. `npm test` and `npm run typecheck` are the other two gates.

**`fx-tests guide` is the intended entry point.** It prints what each command
answers, which file family it reads, and — the reason it exists — the traps in
this data that are not discoverable from `--help`: that the errors files exist
for only a few of the published dates, that a manifest with all-zero durations
was skipped rather than instant, that a test's overall failure rate hides a
single-config perma-fail. Its factual claims are covered by tests, so it fails
the suite rather than going quietly stale.

[`docs/CLI.md`](docs/CLI.md) is the full command reference and
[`docs/PLAN.md`](docs/PLAN.md) describes how the library was extracted.
[`docs.html`](docs.html) renders every markdown doc in this repository in the
browser, with the links between them resolved.

## Data format

The JSON file formats are documented in
[`JSON_FORMAT.md`](https://searchfox.org/mozilla-central/source/testing/timings/JSON_FORMAT.md),
which lives next to the generator in mozilla-central, and in
[`lib/formats/FORMATS.md`](lib/formats/FORMATS.md) in this repository.

The two differ in kind. `JSON_FORMAT.md` describes what the generator was
written to emit; `FORMATS.md` records what the index was actually serving, from
validating every file the index publishes. It lags less, and where the two
disagree it is the one to trust — it exists because several documented claims
turned out not to hold.
