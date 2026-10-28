# Plan: deploying the migrated pages

Nine of the site's twenty-six pages have been rewritten onto the shared `lib/`
library and live in `site/`. They are built, tested and reviewed, and nothing
deploys them: `dist-site/` is gitignored and there is no CI. This plan is what
a fresh session needs to change that.

Read `docs/PARITY.md` first for why the migration exists, and the header of
`site/errors.ts` for what a migrated page looks like.

> **`old/` has since been deleted.** The superseded pages served their purpose
> as an escape hatch and are no longer published. This document still describes
> them as they were; the `old/<page>.html:NNN` citations throughout the code
> refer to the last commit that has them, `fb27887`
> (`git show fb27887:old/test.html`).

---

## 0. Do this first: the rename

The migrated pages lived in `next/` during the migration, building into
`dist-pages/`. Both names describe a phase that ends when this deploy lands —
after it, "next" is simply the site. **Rename before writing the workflow**, so
the workflow's paths are written once against their final names:

| was | is | |
| --- | --- | --- |
| `next/` | `site/` | done |
| `dist-pages/` | `dist-site/` | done |
| `tsconfig.next.json` | `tsconfig.site.json` | done |
| the nine superseded root `*.html` | `old/*.html` (see §1) | done |

The first three landed together as one commit; the `old/` move landed as its
own, for the reason given at the end of this section.

`dist/` was considered for the output and rejected: it already holds
`dist/fx-tests.js`, the CLI bundle, which is **committed on purpose** (the `bin`
and `files` entries in `package.json` point at it, and `check-bundle-fresh.ts`
fails the suite when it is stale). Putting gitignored output in the same
directory would mean "is `dist/` committed?" no longer has one answer.

Scope, measured: **368 references across 56 files** — `tsconfig.next.json`, the
`pages` npm script, `tools/build-pages.ts`, every file in the directory itself,
and 24 files under `test/`. Most are import paths, but many are prose in
comments and in `docs/`, so a blind search-and-replace over `next/` will also
rewrite unrelated English. Do it as `git mv` plus a reviewed sweep, in **its own
commit**, with `npm test` and `npm run typecheck` green before and after.

Nothing outside the repository depends on the two build names: neither is
published, and `dist-site/` is gitignored. **The `old/` move is different** —
those files are served today at `tests.firefox.dev`, so moving them in the
repository is only safe because the deploy republishes them at the root. The
`old/` move landed in a **separate commit** from the `next/` → `site/` rename:
one is pure refactoring, the other changes what a reader of the repository is
served, and bisecting a broken deploy is much easier when the two are not
entangled.

## 1. What is actually being deployed

**Not a version swap.** Seventeen of the twenty-six pages have no migrated
twin, including `help.html` — the index of the whole site — and `green.html`.
Deleting the old pages would delete two thirds of the site. The deploy is a
**merge**: build the nine, copy the seventeen, publish the union.

| | count | where it comes from |
| --- | --- | --- |
| migrated | 9 | `site/*.html`, built by `npm run pages` |
| unmigrated | 17 | root `*.html`, copied verbatim |
| shared assets | — | `shared.js`, `shared.css`, `common-*.js`, `dashboards.js`, favicons |
| committed data | 1 | `mochitest-stats-backfill.json` (see below) |

The nine: `crash-viewer`, `crashes`, `errors`, `failures`, `index`, `issues`,
`manifests`, `test`, `try`.

**Decided:** the migrated page takes the canonical URL, and the previous
implementation is published under `old/`. So `test.html` is the new one and
`old/test.html` is the current one, kept for comparison and as an escape hatch
that is not a revert. `old/` is deleted once the new pages have been trusted
for long enough — that removal is a follow-up commit, not part of this work.

**Done: the nine superseded pages live in a real `old/` directory in the
repository**, moved as part of the rename in §0. Only those nine. The seventeen
unmigrated pages stay at the root: they are not old, they are the only version
there is, and filing them under `old/` would say "superseded" about pages
nothing supersedes.

This gives `old/` a single unambiguous meaning — *replaced, pending deletion* —
and makes the cleanup `git rm -r old/` with nothing to sort through. It also
means the repository root stops mixing nine dead pages with seventeen live ones,
where today you cannot tell by looking which `index.html` is served.

The parity harnesses in `test/` compare against reference logic reimplemented in
the test files themselves, over fixtures, so they do not read the old pages.
**Two other tests did, and this paragraph previously claimed none did.**
`test/errors-view.test.ts` reads `errors.html`'s markup with `readFileSync` in
two tests — one counting the seven `id="kind-…"` checkboxes, one reading the
`viewSelect` options — and both failed on the move until the path was updated to
`../old/errors.html`. They failed loudly, which is why the move was safe.

`test/index-parity.test.ts:94` and `test/index-page.test.ts:101` read
`mochitest-stats-backfill.json` from the root, but that is a data file, not a
page: it stays at the root and still resolves.

The lesson generalises past this one paragraph: a claim that "nothing reads
these files" is a `grep` for `readFileSync`, not a memory. Anything else in
`test/` and `site/` naming one of the nine is a comment citation.

**Done:** the workflow landed on the **fork** first
(`origin` → `fqueze.github.io/aretestsfastyet`), the staging instance, and has
deployed successfully. The nine pages were then read in a browser there.

Pointing it at `upstream` → `tests.firefox.dev` needs no change to the
workflow, which names no repository and publishes whichever one it runs in. It
needs the commits pushed to `upstream/main` — a clean fast-forward — and the
Pages source on that repository set to GitHub Actions, which is done.

### Why `old/` works without rewriting any link

Every inter-page link is built by the shared scripts (`dashboards.js`,
`common-links.js`) as a **relative** URL — `test.html?test=…`, not
`/test.html?test=…`. A page served from `old/` therefore links to `old/`, and
a page served from the root links to the root. Each set is self-consistent with
no rewriting.

This was checked rather than assumed: `grep` for `.html` in `site/*.ts` and
`lib/` returns only comment citations, never a constructed link.

One consequence, and it is the reason the repository layout and the published
layout are **not** the same: an `old/` page linking to an **unmigrated** page
resolves inside `old/`. `dashboards.js` is a flat list of bare filenames —
`workers.html`, `xpcshell-timings.html` — and every page carries a
"Dashboards ▾" menu listing all twenty-six. So from `old/issues.html`, the link
to `workers.html` resolves to `old/workers.html`, which does not exist in the
repository and would 404.

**Decided: the deploy copies the seventeen unmigrated pages and the shared
assets into `dist-site/old/` as well**, so the published `old/` is a complete,
self-consistent snapshot even though the repository's `old/` holds only nine
files. The two layouts differ only by files that are copies.

| | repository | published |
| --- | --- | --- |
| root | 17 unmigrated | 9 built + 17 unmigrated |
| `old/` | 9 superseded | all 26 + assets |
| `site/` | 9 sources | — |

Measured before choosing:

| | size |
| --- | --- |
| `dist-site/` — nine built pages plus assets | 724 kB |
| all twenty-six old pages | 1.5 MB |
| shared assets (`shared.*`, `common-*.js`, `dashboards.js`, favicons) | 128 kB |

About 1.6 MB extra on a static site, which is not worth trading a working
fallback for. The alternative — publishing only the nine in `old/` — needs the
old pages' links rewritten to climb out of the directory, which means modifying
the very artifact being kept as an untouched escape hatch.

### Committed data files are part of the deploy

`mochitest-stats-backfill.json` sits in the repo root and is fetched by the
index page at runtime, by relative path. It is not an optional extra: around
2026-06-10 a mozilla-central aggregation job failed without being marked failed,
and later runs rebuilt history from scratch, so the live artifact now starts at
2026-05-29. The committed backfill is what restores the months before that.

**This has already caused one bug.** The page was built into `dist-pages/`
without it, the `fetch` 404'd, and the failure is swallowed by design — a
missing backfill is meant to degrade to live-only data, not to throw. The result
was a chart showing 68 days instead of 200, with no error anywhere. It was found
by a human looking at the page; 1,333 passing tests did not see it.

So: **the assembly must copy committed data files, and a missing one must fail
the build.** Two properties, and the second matters more than the first. Any
page that fetches a committed sibling by relative path has this failure mode,
and it is silent at runtime in every case.

Check for new ones rather than trusting this list — grep the built bundles for
relative `fetch('./…')` literals. Note that files fetched through `fetchData()`
are a different thing entirely: those come from CI artifacts over the network
and must *not* be copied.

## 2. The workflow

One workflow, on push to `main`: `.github/workflows/deploy.yml`. It names no
repository and publishes whichever one it runs in.

Both repositories previously served the branch root directly. Publishing a
built artifact needs the Pages source set to **GitHub Actions**, which a
workflow cannot set for itself; both have it now. If one is ever switched back
to a branch source, `deploy-pages` fails outright, because the
create-deployment call is rejected — see the header of the workflow for the
symptom that is *not* this, and was a GitHub incident rather than a
configuration problem.

**Gates before publishing, all of them (decided):**

```
npm ci
npm run typecheck     # both projects: root and tsconfig.site.json
npm test              # 1,344 tests, and check-bundle for a stale dist/fx-tests.js
npm run pages         # builds site/ into dist-site/
```

A failure must **not** publish. The failure mode to avoid is the one
`tools/build-pages.ts` already guards against internally: a build that fails
after overwriting a good artifact, so the deploy ships the broken one.

**Assembly step**, after the gates:

The repository holds the seventeen unmigrated pages at the root and the nine
superseded ones in `old/` (§0). So:

1. `dist-site/` already holds the nine built pages, the assets they reference
   in markup, and the committed data files they fetch by relative path
   (`tools/build-pages.ts` copies all three, and fails if one is missing).
2. Copy the seventeen unmigrated root `*.html` into it.
3. Build `dist-site/old/` as a complete snapshot (§1): the nine from `old/`,
   **plus** the same seventeen unmigrated pages, the shared assets, and the
   committed data files. The seventeen are deliberately published twice — once
   at the root and once inside `old/` — because `old/` links resolve inside
   `old/`. The old pages fetch the backfill by the same relative path, so it
   has to be there too or `old/index.html` shows the same truncated chart.
4. Publish `dist-site/` as the Pages artifact.

Step 3 is the one to get right: it is the only place the repository layout and
the published layout deliberately diverge, and a reader who assumes they match
will produce an `old/` whose every cross-page link 404s.

Assemble into a **fresh** directory rather than into a `dist-site/` left over
from a previous run. A stale file from an earlier build that no longer exists
in the sources would otherwise be published indefinitely, and nothing would
report it.

Add a `.nojekyll` file to the published artifact. Without it Pages runs Jekyll,
which ignores files beginning with `_` — the project has none today, but the
failure is silent and confusing when it happens.

## 3. What to verify, and in what order

**Before writing the workflow**, run the assembly locally and serve it:

```sh
npm run pages
# assemble into a scratch dir exactly as the workflow will
python3 -m http.server 8080 --directory <scratch>
```

Then check, in a browser, that:

- each of the nine loads and renders real data,
- each of the seventeen still loads,
- `old/test.html` loads and its links stay within `old/`,
- **from `old/index.html`, open the "Dashboards ▾" menu and follow a link to an
  unmigrated page** — e.g. Worker Pools. It must land on `old/workers.html` and
  render, not 404. This is the check for assembly step 3, and it is the failure
  the repository layout invites,
- the "Dashboards ▾" menu works from a migrated page and from an unmigrated
  one,
- **no request 404s** — open the network panel, on `index.html` and on
  `old/index.html`. This is the check that would have caught the backfill bug,
  and it costs one glance per page,
- **`index.html`'s mochitest chart starts in January, not on 2026-05-29.** If it
  starts at the end of May, the backfill did not load. Compare against the
  xpcshell chart beside it, which has no backfill and always starts in January,
- no page logs a console error that the same page does not log today.

**Do not skip the browser pass.** Three defects in this migration were invisible
to every automated check and visible immediately on loading the page: a button
that rendered enabled and did nothing, a page that never fetched the file its
charts needed, and a chart silently missing four months of history because a
data file was not copied into the output. `docs/PARITY.md` §7 says it directly —
the harness makes reading the output cheap, it does not replace doing it.

**After the first successful deploy**, load the fork's live pages and compare
against `old/` on the same site. That is the first time the two have been
compared on the same data at the same moment, which is worth more than any
pinned-snapshot run.

## 4. Rollback

Reverting the deploy commit and pushing re-runs the workflow and republishes.
While `old/` exists a reader also has an immediate fallback that needs no
deploy at all, which is most of the reason for shipping it.

State the rollback procedure in the workflow file itself, as a comment. The
person who needs it will be reading that file, not this document.

## 5. Not in scope

- **Deploying to `upstream` / `tests.firefox.dev`.** No longer out of scope —
  the fork works and the browser pass is done, so this is the next step. It is
  `git push upstream main`, a clean fast-forward; the workflow needs no edit.
- **Deleting the nine superseded pages.** Done: `old/` is gone, and so is the
  assembly step that republished it.
- **Migrating the remaining seventeen pages.** No CLI command corresponds to
  them, so the argument that justified this programme — that the page and the
  command must agree — does not reach them.
- **The two known open items**, both recorded in the migrated pages' divergence
  lists: the Flaky Job Failures *chart* still plots `failedJobs − invalidJobs`
  although the table beside it has been corrected, and `failedJobs` counts
  Treeherder job state, so it includes infra failures with no failing test.

## 6. A caution for whoever picks this up

The pages were migrated by nine agents working largely independently, and the
defects that mattered were found by a human running the thing, not by the test
suite — which was green throughout. Specifically: a formatter duplicated
thirteen times, a control that rendered enabled and did nothing, a page whose
charts silently never loaded their data, two rate formulas that were wrong on
both sides at once in different ways, and a chart missing four months of history
because a committed data file was never copied into the build output.

That last one is worth dwelling on, because it is the one this document did not
predict. A test in `test/index-page.test.ts` *asserted* the truncated result as
correct — and it was correct, as a unit test of what the page should do when the
backfill is genuinely absent. What nothing asked was whether the file is
reachable in the layout the deploy actually produces. The bug lived in the gap
between "the page handles a missing file gracefully" and "the file should not be
missing."

Expect more of that shape here. The suite tests the pages; the deploy tests the
*arrangement* of them, and almost nothing covers arrangement.

So when the site is deployed, the highest-value next action is not more
automation. It is opening the nine pages and reading them, with the network
panel open.
