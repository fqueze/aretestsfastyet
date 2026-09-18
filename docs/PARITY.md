# Plan: migrate the pages onto the library, then compare

Goal: stop finding CLI bugs by having a human run a command. Every defect
reported so far — the `?` message column, 453 never-scheduled configs,
uncached profiles, the sort key, `issues` leading with the wrong question — was
found that way. None was found by the test suite, the adversarial reviews, or
the mutation campaigns, all of which were green throughout.

Naming that failure precisely determines the design: **the tests verified the
code against itself and never against the thing the user already trusts.** A
harness checking only internal consistency would have confirmed every one of
those bugs as correct.

---

## 1. What the bugs have in common

Six user-reported defects, grouped by what would have caught them:

| Defect | Numbers agreed? | Would a value diff catch it? |
| --- | --- | --- |
| `same msg` column all `?` | no | yes |
| perma-fails 0 vs 3 | no | yes |
| sort key: executions vs job runs | **yes** | **no** — same set, wrong order |
| `issues` flat test list | **yes** | **no** — right numbers, wrong question |
| 453 never-scheduled configs | **yes** | **no** — correct data, useless framing |
| paths truncated unusably | **yes** | **no** — presentation only |

**Four of six produced correct numbers.** A harness that diffs values alone
catches a third of what has actually gone wrong. Three classes need three
checks:

1. **Value parity** — same inputs, same numbers and sets.
2. **Order parity** — ranked output ranked by the same key, same direction.
3. **Framing parity** — the default view answers the same question, at the same
   level of aggregation.

Class 3 has never been tested here, and it is where the two worst reports landed
(`issues`, `--coverage`).

### A seventh defect, and the fourth class it names

`fx-tests try --all-jobs` printed the push's non-test job failures — builds and
lint — from data it had already fetched. `try.html`'s "Load all jobs" button
fetches the *successful test jobs' profiles*, so that tests which failed and
then passed on the harness's rerun appear at all: those jobs are green on
Treeherder, so nothing in the default set references them. Measured on try push
`7d16bff81bb1`, that is 90 tests — every one of them a `passedOnRerun` — out of
116, against 26 by default. Not a ranking difference and not a rounding
difference: 90 rows that were **absent**.

Two controls on two different axes, sharing a name. Someone reaching for the
page's behaviour got plausible output and no indication they had asked a
different question.

| Defect | Numbers agreed? | Would a value diff catch it? |
| --- | --- | --- |
| `--all-jobs` on the wrong axis | **no** — 26 rows vs 116 | **no** — nothing ran the flag on both sides |

**Why `framing.test.ts` did not catch it, which is the more useful finding.**
The table had a `filters` field and both sides said, in nearly the same words,
"test jobs only, non-test jobs opt-in". Both statements were **true**. The
field conflated two questions — which rows are shown, and which data the rows
are computed from — and a single field cannot disagree with itself. The
cross-side check compares the two prose strings, so matching prose about
different mechanisms passes; and `filters` for `try` was never asserted against
behaviour at all, only against the other column.

So the fix was a fourth dimension, `universe`, and a behavioural assertion for
it. What makes it real rather than more prose is the quantity it is checked
against: **the number of profiles read**, which the command now reports as
`profilesRead`. A display filter cannot change that number, so a flag that
claims to widen the universe and does not fails, whatever the table says.

Three mutations confirm it: the flag not widening, the flag ignored and always
widening, and the widening losing its `isTestJob` guard each fail the new
tests. A fourth — the progress line reporting the failed-job count while
reading the wider set — survived until a test was added for it, which is the
same "Reading vs Fetching" defect the command already carries a comment about.

The general lesson for the table: **a field whose two sides are prose can only
detect a difference someone wrote down.** Every dimension needs a quantity the
CLI emits, or it is documentation rather than a check.

**And the fix was not the end of it.** `cde2ebd` made the two sides agree by
writing the rule a second time: `isTestJob` was then defined twice, character
for character, in `cli/commands/try.ts` and `site/try-view.ts`, with the
"which jobs get their profiles read" rule written independently on each side.
Agreement restored, and the room for the next divergence left exactly as it was
— which is what the table below promises does not happen. The classification and
selection now live in `lib/model/try-jobs.ts` and both sides call it; only the
*fetching* stayed separate, since a Web Worker pool and a disk cache with a
`--concurrency` bound are not one implementation written twice.

That extraction found a third copy nobody had counted: `test/try-view.test.ts`'s
own helper reproduced the page's filters rather than calling them, so the page's
tests could have passed while the page selected something else. It is the same
shape of hole one level down, and it is why the check that mattered was a
mutation — break the shared function, confirm **both** sides go red — rather
than another assertion that the two agree. After the extraction they agree by
construction, and a test of that is a test of `===`.

## 2. Why migrate first, then compare

An earlier draft compared the CLI directly against today's pages. That is worse,
for a reason worth stating: **a CLI-vs-page diff has two unknowns.** When they
disagree, the cause is either a CLI bug or a difference between the page's
inline logic and `lib/` — and telling which required porting page logic into
throwaway scripts, which agents on this project had to do three separate times.

Migrating first gives every comparison **one variable**:

| Comparison | Held constant | Tests |
| --- | --- | --- |
| old page vs new page | the question being asked | the port onto `lib/` |
| new page vs CLI | the data logic (both on `lib/`) | presentation and framing |

It also dissolves the seam problem. Comparing against today's pages needs
`window.__parity` getters retrofitted onto files that gate everything behind
`DOMContentLoaded` (`old/try.html:3759`) with logic inline across seven `<script>`
blocks. A page being rewritten onto `lib/` can expose its view model as a design
property instead.

And it strengthens the target. Comparing the CLI to `issues.html` today means
reverse-engineering intent from 3,822 lines; comparing it to a rewritten page
means comparing against something with tests.

**The risk this introduces, and the mitigation.** Once both sides are built on
`lib/`, a shared misconception agrees with itself — new-page-vs-CLI will not
catch it, so old-vs-new carries weight the earlier plan spread across two
checks. The mitigation is that old-vs-new must capture **framing**, not just
values: that `issues.html` leads with components ranked by issue count is a fact
about the *old* page, and once it is gone from both sides nothing else will
notice. Framing assertions are therefore written **before** each migration,
against the old page, and become the migration's acceptance criteria.

## 3. Which pages, in what order

The criterion is what a debugging agent needs, not what is cheapest.

1. **`crash-viewer.html`** (1,093 lines, 6 interactions, one artifact fetch).
   Smallest by far, and its core logic — the signature heuristic — is *already*
   ported and tested as `lib/model/crash-signature.ts`, verified byte-identical
   on 7 real dumps. So it sets the pattern (build wiring, `lib/` integration,
   parity harness, interaction testing) at low risk while still being a page
   worth having. `PLAN.md` §3 already flagged dropping its inline signature
   logic as worth doing opportunistically.
2. **`test.html`** (3,237 lines). The per-test deep dive; the page behind
   `fx-tests test`, the command that most needs to be trustworthy.
3. **`try.html`** (3,803 lines). Last, because it is the most complicated and
   because the two before it will have settled the pattern. It already exposes
   `window.failures`/`permaFails` seams (`:3725`, `:3731`), and its logic is the
   most-debugged in the repo.

The remaining ~22 pages are out of scope here and get sequenced once these three
have shown what migration actually costs.

## 4. Old page vs new page

The expensive comparison, and the one that must be rigorous.

- **Mechanism: a real browser** — headless, or the Firefox devtools MCP. Both
  pages loaded against identical data, driven through the same steps.
- **Data must be pinned.** The 21-day window rolls, so the two pages must read
  the *same* files or the diff is meaningless. Serve a frozen snapshot to both
  (the `--data-source` mechanism already exists for this) rather than comparing
  two live loads.
- **Initial render** — compare the rendered view model where the new page
  exposes one, falling back to text content. Not pixels: layout may legitimately
  change, and pixel diffs would drown real defects in noise.
- **Interactions are the point, not an extra.** These pages are useful because
  of filtering, sorting, grouping and drilling in; a comparison that stops at
  first paint tests the least useful third of them. For each page enumerate its
  controls and drive both sides through the same sequence, comparing after each
  step. `issues.html` alone has four issue-type checkboxes (`:626-638`) and
  sortable columns, and their *combinations* are where behaviour diverges.
- **State in the URL** — these pages encode state in the hash/query
  (`?rev=`, `#date=21days`). Round-tripping that is part of parity: a shared
  link must produce the same view on both.

**Byte-identical is the default; exceptions are declared.** Unifying onto `lib/`
forces choices — `PLAN.md` §1 documents pass/fail classification differing
across eight sites — so some page's numbers must change to be unified. Each such
change gets an allow-list entry **with its reason**, reviewed as a deliberate
behaviour change. An allow-list entry that stops matching is itself a failure,
or the list becomes where regressions hide.

## 5. New page vs CLI

Cheap once §4 exists, because both sides share `lib/` and the page exposes a
view model.

- **Value and order parity** on the shared queries, asserted field by field and
  as a full ranked sequence — not a spot check. The sort-key bug
  (`instances.length` vs distinct job runs) produced the same set in a different
  order and would pass any set comparison.
- **Framing parity** as a small table: command → (grouping, sort key,
  direction), derived from the page and asserted against the CLI. This is the
  check that was missing, and it is cheap enough to write today.
- **Flags map to controls.** Every checkbox or sortable column has a CLI
  analogue — `issues.html`'s four issue-type checkboxes are repeatable `--type`,
  its column headers are `--sort`. Driving both through the same matrix verifies
  that each documented flag exists and does what the page's control does.

**Declared divergences.** Some differences are correct and stay: the CLI drops
manifest-path pseudo-tests the page lists as tests; ties break on path because
the page's tie order depends on worker completion and reshuffles between
reloads; the CLI annotates central history per row where the page uses a
tooltip. Same allow-list discipline as §4.

## 6. Sequencing

1. **Framing table now**, against the current pages. Days of work, no browser
   dependency, and it is what would have caught the `issues` bug. Landing it
   first means the next migration has its acceptance criteria already written.
2. **`crash-viewer.html`** — migrate, and build the browser harness (§4) around
   it. Small enough that the harness, not the page, is the hard part.
3. **`test.html`**, then **`try.html`**.
4. **New-page-vs-CLI parity** (§5) per page, as each lands.
5. **Corpus in CI**, expanded as pathologies are found.

The corpus is checked in, small, and chosen for pathology: the shutdown-hang
push (`717fc67feaa071`, 240 synthetic crashes from one signature), a push whose
reruns reorder the ranking (`09028ab93fe1…`, 12 of 71 tests), a push whose
perma-fails are all pre-existing on central (`7d16bff81bb1…`), one with
unparseable streamed profiles, one with no failures; a test skipped on a whole
platform (`dom/media/test/test_playback.html`, 20 Android configs), a
desktop-only test, a single-config perma-fail, a `run-if`-scoped test, and one
that does not exist. Each entry records **why** it is there, and the window it
was captured against — a stale entry must fail loudly rather than silently
compare different windows.

## 7. What this does not fix

It compares the CLI to the dashboards, so where both are wrong both stay wrong.
Acceptable: the dashboards are trusted and in daily use, and the CLI's stated
goal is to answer the same questions in a terminal. But it means "parity
achieved" is not "correct".

It does not cover commands with no page — `guide`, `dates`, `cache`, the hang
mode of `crash`. Those keep needing ordinary tests and human review.

And it does not remove the need to **read the output as a user**. Every bug in
§1 was visible in a few lines of terminal output to someone who ran the command
and looked. The harness makes that habit cheap and repeatable; it does not
replace it.
