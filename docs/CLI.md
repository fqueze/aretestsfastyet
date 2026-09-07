# `fx-tests` — command-line access to the test-health data

The dashboards at <https://tests.firefox.dev/> answer questions about Firefox
test health by drawing charts. `fx-tests` answers the same questions in plain
text or Markdown, so that an agent debugging a test failure — or anyone in a
terminal — can get the data without a browser.

It reads exactly the same pre-aggregated JSON files from the Firefox CI index
that the dashboards do, through the same shared library
(see [`PLAN.md`](PLAN.md)). There is no separate data path and no server.

> **Status: design document.** Nothing here is implemented yet. This file
> specifies the intended surface so it can be reviewed before code is written.

## Design goals

**Output is for reading, not parsing.** The default output is compact plain
text sized for a terminal or an agent's context window: no ASCII-art tables
that wrap at 80 columns, no colour required to understand the content. Every
command also takes `--json` for programmatic use, so the human-readable format
never has to double as an API.

**Context-window frugality.** An agent pasting output into a prompt pays for
every token. Commands default to a small number of rows and a truncated
message column, and say what they truncated (`… 47 more (--limit 0 for all)`)
rather than silently cutting off. This is why the default is not `--json`:
the table-encoded JSON for one test is far larger than its prose summary.

That frugality is about **row counts and message columns**, never about the
identifiers a reader has to copy — see below.

**Identifiers stay copyable; prose gets truncated.** A test path, a manifest
path and a configuration name are things you paste into the next command. A
failure message is prose to skim. They therefore get opposite treatment, and
the table renderer enforces it rather than each command remembering:

- A **path or identifier column sizes itself to the longest value in the rows
  being printed**, so in normal use nothing is cut at all. Measured over real
  `issues` output, the widest test path at the default limit is 97 characters
  and the whole-file worst case is 125; the hardcoded 56- and 62-column limits
  this replaced were narrower than the p90 of 81, discarding information for no
  benefit.
- A generous cap (128) exists only so one pathological value cannot push the
  numeric columns off a terminal. When it bites, the cut comes off the
  **front** (`…/test/browser/browser_ml_heuristics.js`) so the filename
  survives, and the full values are reprinted below the table as
  `full paths (n shortened above):`. That block is a rare fallback, not
  something every table carries.
- A **message column** still truncates from the right, with a trailing `…`.

`--json` never truncates anything, in any command.

**A ranked list says what it is ranked by.** Every table marks its ordering
column in the header with `▼` (descending) or `▲` (ascending), the same arrows
the dashboards put on their sort buttons. `fx-tests issues` was correctly sorted
and still read as "a few random tests, without sorting", because nothing in the
output said so — a reader who does not already know cannot tell an ordered list
from an arbitrary one. The marker follows `--sort`, so it always names the order
actually produced.

**Answers, not dumps.** `fx-tests test <path>` leads with a verdict — is this
test failing, is it perma-failing on one config, has it been failing for
three days or three weeks — because that is the question being asked. The
supporting numbers follow.

**Every number traceable.** Any command that reports a failure can print the
task IDs behind it (`--task-ids`), so a claim can always be checked against
the actual CI job.

## Invocation

```
fx-tests <command> [options]
```

Installed as a `bin` entry in `package.json`; run without installing via
`npx fx-tests` or `./bin/fx-tests.js` from a checkout. Requires Node ≥ 20
(for built-in `fetch`; see the prerequisite note in `PLAN.md`).

## Global options

| Option | Default | Meaning |
| --- | --- | --- |
| `--harness <xpcshell\|mochitest>` | inferred from the test path, else `xpcshell` — but `mochitest` for `errors`, and **both** for a directory path on `failures` and `flaky` (see below) | Which harness's data files to read. |
| `--json` | off | Emit JSON instead of text. Stable shape, documented per command. |
| `--markdown` | off | Emit Markdown (tables, fenced blocks). For pasting into a bug or PR. |
| `--limit <n>` | varies per command | Max rows. `0` means no limit. |
| `--config <list>` | all configs | Comma-separated job-name substrings; an entry matches if it is contained in the job name. `--config linux,windows11` is the union. |
| `--exclude-config <list>` | none | Comma-separated substrings to exclude. Applied after `--config`, so `--config linux --exclude-config debug` means "linux, but not debug". |

`--json` and `--markdown` are mutually exclusive; passing both is a usage error
(exit 1) rather than one silently winning.

### `--config` either filters or refuses, on every command

A configuration filter needs job names in the data, and only the bucket files and
`manifests.json` have them. So `--config` and `--exclude-config` filter on `test`
and `manifests`, and every command that reports per-test or per-push numbers and
*cannot* honour them **refuses with a usage error** naming the file and why it
cannot answer: `issues`, `flaky`, `errors` and `summary` because their files
record no job names, and `try` because its sections are cross-configuration
verdicts, so filtering the job set would change what each one means rather than
narrow it. Silently ignoring the flag returned the unfiltered answer under a
heading that claimed otherwise, which is the worst of the three options.

`dates`, `cache`, `guide` and `crash` accept it and ignore it, because none of
them reports a population a configuration could narrow — `dates` lists which
dates exist, `crash` takes one task and one dump. Item 13's rule (do not list a
global flag in a subcommand's `--help` when it does not apply) is what covers
those.

Where it does filter, **every number in the report comes from the filtered
population**: the header totals, the per-config table, the message and skip
lists, `--coverage`, `--task-ids` and `--profiles`, and the width of the recent
window (which is sized from the sparsest config *in the filtered set*). The text
and Markdown reports open with a `Filtered:` line naming the filter, and `--json`
carries it as `configFilter`, because a filtered `0 fail` is otherwise
indistinguishable from a healthy test.

Attribution is **per task, not per entry**. A `FAIL`/`TIMEOUT`/`CRASH` group
records one task per run and those tasks routinely span configurations, so a
filter that keeps or drops a whole group on its first task's job both loses runs
on the requested config and keeps runs on every other one.

### Harness detection is a heuristic, and it fails quietly

`--harness` is inferred with the existing `detectHarness()` (`common-test-data.js:9`),
which the CLI should reuse rather than reimplement. Its rules: `browser_*.js` and
`test_*.html` are mochitest, everything else — including `test_*.js` — is xpcshell.

That misclassifies a mochitest-plain `test_foo.js`, and the symptom is
indistinguishable from a typo: the CLI reads xpcshell data and does not find the
test. Telling the caller to retry with the other harness is not enough — the tool
knows which harness holds it and should just look.

A **directory** has no filename at all, so the same fallthrough sent
`failures --path <dir>` and `flaky <dir>` to xpcshell with the same misleading
"check your path for typos". Nothing in the aggregates says which harness runs a
folder — that is in its manifests, and the CLI has no mozilla-central checkout —
so with no `--harness` both aggregates are read and the data decides: the harness
with rows is printed, both are when both have rows (each under its own header,
and `--json` wraps them as `{ "harnesses": [...] }`), and the not-found message
appears only when neither has any, and it names both files it searched. The rule
is `harnessesForPathFilter()` (`lib/model/harness.ts`), shared by both commands.
An explicit `--harness`, and a query with no path at all, are never widened.

Two limits worth stating, because both are deliberate. **`failures` and `flaky`
only**: `issues`, `crashes` and `skips` take the same `--path` and still read
xpcshell alone. And a path naming a test **file** is not widened either — these
commands do not call `detectHarness()` at all, so `--path <some>/browser_x.js`
reads xpcshell like any other path. `fx-tests test <path>` is the per-file view,
and it resolves a file across both harnesses through
`lib/query/test-lookup.ts`.

### A test path is resolved, not required

`test <path>` walks the same ladder `test.html` does, from `resolveTest()`
(`lib/query/test-lookup.ts`), which both front-ends call:

1. the bucket file for the inferred or given harness;
2. **the other harness at the same bucket index**, unless `--harness` was given —
   which is what covers the `test_*.js` hole above;
3. a **unique** substring match over every test path in both 21-day aggregates,
   which is resolved and reported on;
4. **several matches** → the candidates are listed and nothing is measured;
5. nothing matched → exit 2.

A basename or a fragment is therefore a valid argument. `browser_tab_preview.js`
resolves, and stderr says what it resolved to so the answer can never be about a
test the caller did not name:

```
Resolved "browser_tab_preview.js" to the one test matching it: browser/components/tabbrowser/test/browser/tabs/browser_tab_preview.js
```

That line, and the `Found in mochitest data, not the xpcshell the filename
suggests.` one, go to **stderr** and print under `--quiet`: they change the
meaning of the output rather than reporting progress. `result.path` in `--json`
always carries the resolved path.

**A miss says what was searched, never what is true.** `No such test in mochitest
data` is a sentence about a file that reads as a verdict on the test, and it was
read that way — a reviewer checked four tests by basename, believed all four
clean, and one was a perma-fail on every configuration it ran. What is emitted
instead names the harnesses read and scopes the claim to the lookup:

```
No test path in the mochitest and xpcshell 21-day data contains "browser_zzz.js",
so this reports nothing about the test itself.
```

with three separate cases kept apart, because they need different next steps: the
test list could not be read (so no search happened), the path exists tree-wide but
the harness file does not hold it, and nothing matches at all.
| `--day <date>` | the whole window | Restrict to one day (`YYYY-MM-DD`), or `--day today`/`yesterday`. A filter on the same file the command already reads. Outside the 21-day window: exit 2. |
| `--since <n>` | | Restrict to the last `n` days of the window. Mutually exclusive with `--day`. |
| `--data-source <central\|try\|local>` | `central` | Where to read data from. `local` reads `./data/`, mirroring the dashboards' `?data-source=` parameter. |
| `--cache-dir <path>` | `~/.cache/fx-tests` | On-disk cache for downloaded data files. |
| `--no-cache` | off | Ignore and do not write the cache. |
| `--quiet` | off | Suppress progress output on stderr. |
| `--progress` | off | Write progress even when a coding agent is the caller. See below. |
| `--full-messages` | off | Do not cut messages, signatures or paths to the terminal width. Implied by `--markdown`. |
| `--help`, `--version` | | |

### Progress is off for agent callers

Progress goes to stderr, which is not enough on its own: an agent harness merges
the two streams into a transcript, so `Reading mochitest bucket…` and
`…10/64 profiles` land in the model's context anyway. `--quiet` fixes it only for
a caller who already knows to pass it, which an agent does not on its first call.

So progress is **off by default** when any of `CLAUDECODE`, `CODEX_SANDBOX`,
`GEMINI_CLI` or `OPENCODE` is set — the same set Firefox's Python code checks.
`0` and the empty string mean "not an agent", which the presence-based Python
snippet would treat as one; `0` is how a variable gets turned off, and reading it
as "on" would take progress away with no way to guess which variable did it.

`--progress` turns the lines back on for a caller under an agent harness that
wants them. **`--quiet` wins over `--progress`**, and the combination is not a
usage error the way `--json --markdown` is: both flags ask about the same axis,
so the outcome is unambiguous, and a wrapper passing `--progress` for every call
while one call site adds `--quiet` is a legitimate shape.

**Warnings are not progress and are never suppressed.** The cache-directory
permission notice and `2 of 5 jobs were killed for exceeding their maximum
duration` are the reasons a result is a subset, so an agent needs them more than
a human does, not less. Only progress is affected.

### How wide the output may be

Text truncates a message to fit the columns beside it, and the cut lands on
exactly the discriminator — the property name, the `null`, a diagnostic marker's
`uri=` payload. Three rules keep that from losing the answer:

- **`--markdown` never truncates.** It is a file format, not a terminal view. The
  documented use is pasting into a bug, so a truncated paste is unusable.
- **`--full-messages` never truncates**, in text too.
- **Otherwise the width follows the terminal**: `COLUMNS` if set, then
  `process.stdout.columns`, then 90. `COLUMNS` is read first because
  `process.stdout.columns` is `undefined` whenever stdout is a pipe, which is
  every agent invocation and every `> file`.
- **Two things stay untruncated even so**, because cutting them destroys their
  only use: the full-path recovery block a table prints under itself, which
  exists so a shortened path can still be pasted into `fx-tests test`; and
  identifier columns such as a task ID or a push timestamp, which cannot be
  looked up once shortened. A table shrinks its prose columns until the line
  fits and then stops, so a very narrow terminal wraps rather than rendering a
  grid of ellipses.

### `--day` and the window

Most commands read the 21-day aggregate by default, because the questions worth
asking ("is this flaky?", "is this new?") need history.

**Within the 21-day window, `--day` and `--since` are both just filters.** Every
status group in a 64-bucket file carries a delta-encoded `days` array — passes,
skips, failures, crashes and timeouts alike — so restricting to one day or to the
last *n* days happens during the single pass the command already makes. Same file,
same cost, no extra requests, and `--coverage` keeps working because the per-day
entries carry `jobNameIds` directly.

For `fx-tests test`, then, `--day 2026-07-30` and `--since 1` are the same kind of
operation. What either loses is only history: trend and recent-window columns are
omitted for a single day rather than shown as zero.

**Out of scope: dates older than the window.** The `latest` index task publishes
bucket files and daily files for exactly the same 21 dates (currently 2026-07-14 →
2026-08-03). Older data is not *gone* — Taskcluster keeps artifacts for about a
year, so an older run's files can be reached through that run's own index — but no
dashboard does this today, and adding it would mean resolving historical index
tasks, a concern the CLI does not otherwise have. So `--day` outside the window is
exit 2 with a message saying which window is available.

Worth noting the shape of that future feature, since it affects nothing now: an
older index task carries its own 64 bucket files, so history would be read the
same cheap way, not by falling back to daily files. There is no version of this
where "older date" implies "scan a daily file".

That leaves the daily `{harness}-{date}.json` files needed for only two things the
aggregates drop:

| | 64-bucket file | daily file |
| --- | --- | --- |
| per-day, per-job pass/fail counts | yes | yes |
| individual run durations | yes | yes |
| task IDs for failures | yes | yes |
| **per-run timestamps** | no — day granularity only | yes |
| **task IDs for _passing_ runs** | no — `jobNameIds` only | yes |
| size | ~3.5 MB | ~37 MB |

So `fx-tests test` reads the bucket file, full stop, unless asked for one of those
two — exact run times, or task IDs of passing runs. Both are narrow enough that
the fallback should be triggered by the flag that needs it rather than by `--day`,
which keeps the common path on one small file.

**Weekends are not representative.** Push volume drops several-fold at weekends,
so any absolute count from a Saturday or Sunday is a fraction of a weekday's and
should not be compared against one. Commands print the weekday alongside the
date for this reason, and `--day` resolves to the most recent day with data
rather than literally yesterday. This is the same effect that makes
`computeConfigStats()` size its recent window by run count instead of by days.

### Task IDs and profile URLs

`--task-ids` prints the raw task IDs, grouped under a date subheading, with the
**real** Taskcluster job name — chunk suffix included, `…-browser-chrome-8`, so
it can be pasted into a Treeherder search. There is no status column: the kind
of failure belongs to the signature, so `Issues` shows it and `--issue <n>`
narrows to one, naming it in the heading. The aggregate records a job's failure
once per attempt, so the same `(taskId, retryId)` can appear more than once —
usually under a *different* message, which stays a separate row. Only entries
identical in every printed field collapse, into one row with an `×n` marker.

So the printed row count is **not** the job count, and the heading states the
job count outright — `Task IDs (6409 jobs)` — which is the number the verdict
quotes. Summing `occurrences` gives the failure total instead.

`--issue <n>` narrows the list to one signature, by the `Issues` row's printed
number. The `Issues` block is numbered for this; `--limit` hides rows but does
not renumber them.

`--profiles` prints **raw profile JSON URLs** — Taskcluster artifact URLs, not
`profiler.firefox.com/from-url/...` links. The consumer is
[`profiler-cli`](https://github.com/mozilla/profiler-cli), which downloads and
queries a profile directly; wrapping the URL in the web profiler's front end
would only make it unusable for that. (The dashboards wrap them because their
consumer is a human with a browser — same underlying artifact, different
presentation, which is precisely the split `lib/links.js` should express.)

Two kinds of profile, with different availability:

- **Resource-usage profile**, one per job: reconstructible from the task ID and
  retry alone —
  `…/task/<taskId>/runs/<retryId>/artifacts/public/test_info/profile_resource-usage.json`.
  Shows whether a timeout was the test being slow or the machine saturated.
  Available for any job, so any command with a task ID can emit it. It also
  holds the job's per-test outcomes, which is what `fx-tests task` reads.
- **Per-test failure profile**, uploaded only when a test fails: the filename is
  *not* derivable from the task ID. It appears in the failure message as
  `"profile uploaded in profile_<name>.json"`, so getting it means reading that
  message (`old/try.html:2900`). This is why profile URLs matter most for
  `fx-tests try`, which already has the push's failure messages in hand.

For commands working from aggregated data the failure message is in the data
file, so the same extraction applies. In practice few tests keep a
`profile uploaded in …` message there, so `fx-tests test --profiles` is
resource-usage profiles plus the occasional per-test URL. Where no name is found
no URL is emitted — the command does not guess a filename.

When it extracted none it points at
`fx-tests intermittent --test <path> --profiles`, which needs only the path —
unlike `fx-tests try <rev> --profiles`, which it used to name and which is no use
on a trunk intermittent with no try push.

Progress and diagnostics go to **stderr**; only the requested data goes to
**stdout**, so `fx-tests ... > out.md` and piping into `jq` both behave.

### Caching

The 21-day aggregate files are tens of megabytes and change once a night, so
the CLI caches them on disk keyed by URL plus the file's `metadata.generatedAt`.
A warm run of `fx-tests test <path>` should need no network at all. `fx-tests
cache` inspects and clears it.

## Commands

### `fx-tests test <path>` — everything about one test

The workhorse. Answers "why is this test failing, and is it my fault?"

> **Illustrative output.** The numbers in this section's examples are made up to
> show layout and which facts appear where — they are not measurements, and the
> percentages are not necessarily self-consistent. Only the `errors` ranking
> example further down uses real data, and it says so. Do not treat column widths
> or derived values here as goldens.

```
$ fx-tests test toolkit/components/places/tests/unit/test_frecency.js

test_frecency.js — toolkit/components/places/tests/unit
Component: Toolkit :: Places
Data: xpcshell, 21 days (2026-07-13 … 2026-08-02), mozilla-central + autoland

  4812 runs   4788 pass (99.50%)   21 fail   3 timeout   0 crash   672 skip

Verdict: intermittent. Fails on 3 of 34 configs; no config fails
         more than 8% of the time.

Runs on 34 configs across linux, windows, macos (not android — see --coverage)

Failing configurations                     fail rate    recent (7d)     runs
  test-linux1804-64/debug-xpcshell           8.1% (13)    9.4%           160
  test-macosx1470-64/debug-xpcshell          2.4% (5)     1.9%           208
  test-windows11-64-24h2/debug-xpcshell      1.6% (3)     0.0%           187

Failure messages
  17x  Assertion failed: frecency of 100 != 120
   4x  Test timed out after 300 seconds

Skips
  672x  skip-if: os == 'android'      (4 android configs × 168 runs)
```

The `Issues` section is headed `Issues (first failure per run)`, and that is
what the counts are. A failing browser-chrome run logs every `TEST-UNEXPECTED`
line — five distinct messages is ordinary — and the aggregate keeps only the
first, so a row means "runs whose first failure was this" and the rows sum to
the failure total. There is no flag to show the rest; the aggregate does not
retain them.

Messages are **wrapped, never truncated**: they run to 350 characters, so no
one line holds both the message and what distinguishes it from its neighbours.
Rows sharing a long prefix group together — the first prints in full, the rest
print `↑ same as 1, but line 10651"…` — so the failure is legible without a
second `--json` call.

Options:

- `--coverage` — **every** config the test ran on, passing ones included, with
  run counts (see below).
- `--executions` — break failures down by initial run vs harness rerun, and by
  parallel vs sequential (see below).
- `--config <list>` — comma-separated substrings, e.g.
  `--config 'linux1804-64/debug,windows11'`.
- `--day <date>` / `--since <n>` — one day, or the last *n* days.
- `--recent-days <n>` — override the automatically-sized recent window
  (see "recent window" below).
- `--task-ids`, `--links` — provenance for each failure (see above).
- `--issue <n>` — with `--task-ids`, only the tasks whose failure was row *n* of
  the `Issues` block, which is numbered on screen for this.
- `--durations` — per-config run-time distribution (min/median/p95/max) from
  the pass durations, for "is this test slow?" rather than "is it failing?".
- `--history` — a per-day sparkline of pass/fail counts, which distinguishes
  "broken since Tuesday" from "flaky for a month". The default output points at
  it when a day's fail+timeout+crash count is more than an order of magnitude
  from the window median, counting days with no runs.
- `--bugs` — the sheriff-annotated bugs naming this test, as a block under the
  verdict. The only flag here that queries a live API (Treeherder and Bugzilla)
  rather than the published aggregate, so it is off by default; see the
  `annotatedBugs` shape below.

#### `--bugs`: the `annotatedBugs` JSON shape

`--help` describes the flag. What it cannot carry is the `--json` contract, which
has four spellings meaning three different things — a caller that collapses any
two of them reports a confidently wrong answer:

| `annotatedBugs` | meaning |
| --- | --- |
| *key absent* | `--bugs` was not passed. No request was made. |
| `[]` | Asked: no annotated bug names this test. |
| `[{bugId, bugSummary, count, days, tree}, …]` | Asked, count-descending. |
| `{"error": "…"}` | Asked, and the lookup failed. Also warned on stderr. |

The unasked state is an **absent key** (`'annotatedBugs' in result`), not
`null` — `null` reads as "no bugs", the opposite of what it would mean.
`{error}` is a warning rather than a non-zero exit, because everything else the
command prints came from a published file and a live-API outage must not take
that answer with it; keeping it distinct from `[]` stops a consumer reading an
outage as "this test has no bugs". `bugSummary` is the Bugzilla summary minus
the triage prefix and the test path.

`days` is `intermittent`'s 7-day window, not `test`'s 21: the count has to agree
with the `fx-tests intermittent --bug <id>` command printed beside it.

#### `--coverage`: where does this test actually run?

The default output lists only *failing* configs, which cannot answer "is this
test running on Android at all?" — a question that matters before concluding a
platform is unaffected. `--coverage` lists every config, including the ones
that only ever passed:

```
$ fx-tests test dom/media/test/test_playback.html --coverage

Configuration                                        runs  pass  fail  skip  status
  test-macosx1015-64-qr/debug-mochitest-media-nogpu   232   232     0     0  ok
  test-linux2404-64/debug-mochitest-media-spi         228   228     0     0  ok
  test-windows11-32-25h2/debug-mochitest-media-spi    215   215     0     0  ok
  test-android-em-14-x86_64/debug-geckoview-…           0     0     0   191  skipped
                                                                     (skip-if: os == 'android')
  … 69 more (--limit 0 for all)

79 configs, 3 platforms: mac (16), linux (15), windows (28)
States: 59 ran, 20 only ever skipped

Scheduled on:
  windows  28/28 ran
  android  0/20 ran — scheduled here, but skipped on every config
  mac      16/16 ran
  linux    15/15 ran
```

This is available because the 64-bucket per-test files attribute passing runs to
a job name (`jobNameIds` on PASS status groups), and `test.html` already builds
this matrix — it simply has no CLI equivalent today.

**`--coverage` lists what the test *was* scheduled on, and absence is the
answer.** A reader asking "does this run on Android?" looks for an `android`
row. In the example above there is one, and it says the test is scheduled on 20
Android configs and skipped on all of them. On a desktop-only test there is no
Android row, and that is the answer: nothing in the data says CI schedules it
there.

Nothing is listed that the data does not record. There is deliberately **no
"never scheduled" list**, and an earlier version that had one is why the point
is worth stating. It subtracted the test's configs from a universe of every
config in the bucket file, and reported 453 "never scheduled" configs out of 495
for a `mochitest-browser-chrome` test — led by `geckoview-mochitest-media`
variants it could never have run under, because buckets shard on a hash of the
test path and hold tests from every suite. Narrowing that universe to the test's
own suites cut it to 3, but the boundary was still arbitrary: widen it and iOS
belongs on the list, narrow it and real gaps disappear. There is no principled
place to stop enumerating things that do not exist, so the command does not
start. `test.html`'s `calculateJobNameBreakdown()` has always worked this way —
it iterates the test's own status groups and has no universe at all.

**What is *not* dropped is ran-vs-skipped.** These are two recorded facts, and
they are the two states that look identical in a failure-only view: a config
where the test ran and passed, and a config where it was scheduled and a
`skip-if` disabled it. The second is someone's work to fix and the first is not,
which is why the `status` column and the platform rollup both carry it. A third
state, `not-applicable`, marks a config that appears only because a `run-if`
scopes the test elsewhere — the annotation working, not something disabled. It
comes from the skip messages on real runs, so it survives too; it only ever
appears on a daily file, since the 21-day aggregates drop `run-if` skips
upstream.

**The rollup is per platform, and only for platforms with something scheduled.**
"Scheduled on 20 mac configs, ran on none" is the answer; twenty config strings
all beginning `test-macosx` are the same answer at a length nobody reads. A
platform with nothing scheduled gets no row at all — a `mac 0/0` line would be a
claim about a config set the data does not contain.

#### `--executions`: a failure is not just a failure

Two distinctions change what a failure means, and a bare count hides both.

**Initial run vs harness rerun.** When a test fails, the harness reruns it within
the same job. Failed-then-passed-on-rerun is an intermittent; failed in both is
much closer to real breakage. (This is a *within-job* rerun — distinct from a
job-level retry, which is the `.<retryId>` on a task ID. Both get called "retry";
they are different things.)

**Parallel vs sequential.** Statuses carry the execution mode
(`FAIL-PARALLEL`, `PASS-SEQUENTIAL`, …). A test that fails only in parallel is
likely racing with its neighbours rather than broken on its own — a different bug,
with a different fix.

```
$ fx-tests test dom/base/test/test_selection.html --executions

  21 tests failed on their initial run
    passed when the harness reran it      18   (86%)  -> intermittent
    failed again on rerun                  3   (14%)  -> candidate breakage

  By execution mode
    parallel      20 failures / 833 runs    2.4%
    sequential     1 failure  / 1000 runs   0.1%

  Reads as: intermittent, and strongly parallel-biased — 20 of 21 failures
  happened under parallel load, at ~24× the sequential rate.
```

The two blocks partition the same 21 failures two different ways — by what
happened on rerun, and by execution mode — rather than being additive.

The default output mentions these only when they change the interpretation
("passed on rerun", "fails almost only in parallel"), to keep it short; the full
breakdown is behind the flag. `try.html` already tracks reruns (`:1408`) and
`issues.html` surfaces parallel failures in a tooltip (`:1216`), but neither
exposes it usefully, and the CLI should not inherit that limitation.

The **recent window** is not a fixed number of days. Push volume varies
several-fold across a week, so a fixed window measured after a weekend rests
on very few runs. The window is instead widened until the sparsest config has
enough runs to support a percentage, and all configs then share that one
window so their rates are comparable. The output always states the window it
used. This is existing `computeConfigStats()` behaviour, surfaced verbatim.

`--json` shape: `{ test, component, harness, metadata, totals, verdict,
configs[], messages[], skips[] }`.

`--coverage` adds `coverage: { attributedPasses, configs[], platforms[],
scheduledPlatforms[] }`. `configs[]` is one entry per config the test was
scheduled on, with a `state` of `ok`, `intermittent`, `perma-fail`, `skipped`
or `not-applicable`; `platforms[]` counts the configs it *ran* on, and
`scheduledPlatforms[]` is `{ platform, ranCount, skippedCount }` for every
platform it is scheduled on. There is no list of configs it was not scheduled
on, and no platform entry with both counts zero — see `--coverage` above for
why absence is the answer rather than something to enumerate.

### `fx-tests try <revision|treeherder-url|landoCommitID>` — triage a Try push

The command most useful to an agent that just pushed to Try. Aggregates the
push's test failures, leads with the ones that failed **every run of some
configuration**, and says for each what central shows on that same
configuration — which is what separates a regression from a pre-existing
breakage you happened to run into.

```
$ fx-tests try 4f2c1a9e8b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a

Try push 4f2c1a9e (try) — 1284 jobs, 37 failed
Compared against 21 days of mozilla-central history.
Read 31 failed test job profiles. The 1103 test jobs that passed were not read,
so a test that failed and then passed on retry is not here; --all-jobs reads
them too.
https://treeherder.mozilla.org/jobs?repo=try&revision=4f2c1a9e…

PERMA-FAILS (3) — failed in every run of at least one configuration here.
                  Each row says what central shows on that same configuration.

  browser/base/content/test/browser_tabs.js
    9 failures on 4 configs (7/7 runs)
    Never failed on central in 21 days (0/1608 runs)
    uncaught exception: TypeError: tab is null

  browser/base/content/test/sync/browser_sync.js
    8 failures on test-linux2404-64/opt-mochitest-browser-chrome-swr-a11y-checks-2 (4/4 runs)
    central 31.4% on test-linux2404-64/opt-mochitest-browser-chrome-swr-a11y-checks (287 runs)
      This failure already happens without your changes.

      It fails this way 31.4% of the time over the last 9 days on
      test-linux2404-64/opt-mochitest-browser-chrome-swr-a11y-checks

      Same failure over the last 9 days, by configuration:
        31.4% of 287 runs — …-swr-a11y-checks
        2.1% of 480 runs — …-swr

      Any failure, all platforms, 21 days: 4.7% of 5493 runs.
    4.7% on central (259/5493), 4.6% with the same message (250)
    Pre-existing: central already fails the same way on
      test-linux2404-64/opt-mochitest-browser-chrome-swr-a11y-checks-2
      (145 times in 21 days) — probably not yours.
    handleEvent() was unable to perform a11y checks on hidden node: …

  dom/base/test/test_selection.html
    3 failures on test-linux1804-64/debug-mochitest-plain (3/3 runs)
    Never failed on central in 21 days (0/412 runs)
    Assertion failed: selection.rangeCount == 1

KNOWN INTERMITTENTS (14) — also fail on central; likely not yours.
   #  test                        here  central  same msg
  12  test_frecency.js            6/12     8.1%      8.1%
   4  browser_download_panel.js    4/9     3.2%      3.2%
  … 12 more (--limit 0 for all)

NEW INTERMITTENTS (1) — failed once here, never on central. Worth a look.
   #  test                        here  central  same msg
   1  toolkit/xre/test/…start.js   1/3      n/a       n/a
```

**Ordering: most failures first.** Every section is sorted by the leading `#`
— the number of failing *executions* of the test across the push, descending.
That is the dashboard's default sort (`old/try.html:744`, on
`test.instances.length`), so the same push produces the same order in both.

It is executions, not the job runs they happened in: the harness reruns a test
that fails, so one job run can hold several failing executions, and a test that
failed twice in a job is a worse failure than one that failed once. The `here`
column still reports job runs (`6/12` above), which is a different and also
useful number — that is why both are shown.

Ties break on the test path, which the dashboard does not do. It leaves equal
counts in arrival order, and its arrival order is the order eight web workers
finished parsing profiles fetched 64 at a time, so its ties reshuffle on
reload. Output that gets diffed and pasted into bugs cannot do that, so ties
here are alphabetical and the output is reproducible.

**Perma-fail is a fact about the push, not a verdict.** A test is in the first
section when it failed in every run of at least one configuration and the
harness's in-job rerun never turned it green there — nothing else. Central
history annotates the row; it does not filter the section.

That is deliberate, and it is a change: the section used to require "and was
not failing on central", which meant a push with three tests that failed every
single run reported *zero* perma-fails, because all three already failed the
same way on the very configs they broke on. Whether central fails there too is
context that changes how a row reads, not grounds for hiding it. The
`Pre-existing:` line carries that context, and the section header deliberately
does not claim the rows are "almost certainly yours".

The comparison is **per configuration**. A test can be intermittent on one
config and permanently broken on another, and the second is the one worth
acting on; asking the question of the test as a whole hides it. So a test that
failed 7 of 13 runs overall still leads the section if one of its configs
failed 4 of 4. The row names that configuration, because it is the one to
reproduce on.

This matches what `try.html` puts in its "Permanent failures" table. Measured
against it: 3, 51 and 241 perma-fails on try push `7d16bff8`, autoland push
`7c06165a` and try push `717fc67f` — the same counts the dashboard reports.
Large counts are usually one bug: 240 of the 241 are a single shutdown-hang
crash signature taking out every test in the affected jobs.

Options: `--project <try|autoland|…>` (default `try`), `--perma-only` (just
the first section — the highest-signal output for an agent), `--all-jobs`
(read the passing test jobs too — see below), `--other-jobs` (list the non-test
job failures), `--task-ids`, `--profiles`, `--config <list>`,
`--concurrency <n>` (default 8).

**The argument does not have to be a revision.** `try --help` has the details;
the rule is:

| Argument | Read as |
| --- | --- |
| `4f2c1a9e8b3d` | a revision |
| all digits, fewer than 8 characters | a `landoCommitID` |
| a Treeherder URL with `revision=` | that revision, directly |
| a Treeherder URL with `landoCommitID=` | that landing job |

A short all-digit argument is too short to be a revision anyone would paste, so
it goes to Lando; 8 characters or more, or any hex letter, is a revision. A
`landoCommitID` is resolved through Lando's `/landing_jobs/<id>/` before
anything else — a URL's own `landoInstance` picks the host, a bare ID uses
`lando.moz.tools` — and a URL's `repo=` becomes the default `--project`. Only
`treeherder.mozilla.org` and `treeherder.allizom.org` count as Treeherder URLs.

**Not** through Treeherder's push API: it accepts `lando_instance` and
`lando_commit_id`, echoes them back under `filter_params` and ignores them, so a
lookup built on it returns whatever landed most recently and triages the wrong
push while looking correct.

A job Lando has not landed yet has no push to triage, so its status goes to
stderr and the command stops, exiting 0:

```
$ fx-tests try <id-of-a-queued-landing>
Lando job 87341 is SUBMITTED and has no revision yet, so there is no push to triage.
```

An unknown ID is exit 2; a URL naming two landing jobs is exit 1.

**`--all-jobs` changes which jobs are read, not which rows are printed.** By
default the command reads one profile per **failed** test job, which is what
`try.html` does with its "All jobs" box unchecked. That misses a whole class of
failure: a test that failed and then **passed when the harness reran it** leaves
the job green on Treeherder, so nothing in the default universe references it at
all. Such a failure is not ranked low — it is absent. `--all-jobs` adds the
profiles of the test jobs that succeeded, which is the only way those surface,
and is exactly what checking the page's box does (`site/try.ts:944`).

Measured on try push `7d16bff81bb1`: 26 failing tests by default, 116 with the
flag. All 90 of the added ones passed on the harness's rerun, and none of the
26 was lost.

It is opt-in on both sides because of what it costs. That same push reads 46
profiles by default and 1,584 with the flag — every completed test job, at tens
of megabytes each. Raise `--concurrency` for it; the header line states which
set was read either way, so a report cannot be mistaken for the other one.

`--other-jobs` is the unrelated flag it is easy to confuse with this: builds and
lint that failed are counted in the header and summarised in one line by
default, and `--other-jobs` prints the list. That is a display filter over data
already fetched, and it changes no fetch. `--json` always carries them as
`otherFailedJobs[]`, along with `profilesRead`, `readPassingJobs` and
`passingTestJobCount` — the last three so a script can tell "no intermittents
found" from "none looked for".

The perma-fail/intermittent split above rests on the harness-rerun distinction:
a test that failed and then **passed when the harness reran it** in the same job
is intermittent almost by definition, while one that failed in every run
including reruns is a perma-fail candidate. `try.html` computes this already
(`isRetry` at `:1022`, `passedOnRetry` at `:1408`); the CLI reports it per failure
rather than only using it for sorting, since "it passed on rerun" is often the
single most useful fact about a Try failure.

That report is **scoped to the configurations it applies to**, for the same
reason the perma-fail question is. A row can legitimately say both:

```
    Failed every run on test-windows11-64-25h2/opt-xpcshell
    Passed when the harness reran it in the same job on
      test-windows11-32-25h2/opt-xpcshell — intermittent there.
```

Those are two facts about two configurations, not a contradiction, and naming
each is what lets them be read together. Unscoped — "passed when the harness
reran it — intermittent", with no config named — the sentence looks like it
refutes the section the row is in. The `--json` shape carries the same split as
`passedOnRerunConfigs[]`, disjoint from `permaFailingConfigs[]`.

Failures are also labelled when they occur only in parallel execution, which
points at a race with concurrently-running tests rather than a defect in the test
itself.

**The `central` column is measured on the configurations the push ran, not
across the tree.** It is `try.html`'s flakiness column, from the same code
(`lib/query/flakiness-rate.ts`), so the same push and test produce the same
percentage on the page and here. That code picks per configuration among the ones
this push failed on, prefers each configuration's recent window, falls back to
its full history, ranks on a lower confidence bound rather than on the raw rate,
and falls back to the whole-test rate when no configuration shows this failure at
all.

Those are four different measurements yielding four different numbers from the
same counts, so the rate is always printed with the lines that say which one it
is — and which configuration, over what window, on how many runs. A bare
percentage here is what the previous version of this column was: it divided every
failure on every configuration the test runs on anywhere by every run on all of
them, and sat next to a `here` cell measured on the one configuration the push
used. On push `46c757b692be` a row read `20/41 · central 5.8%` where central's
rate on the configuration that ran was 42.0% — two populations, one comparison,
and an apparent 8x elevation that was arithmetic.

When central has no history for **any** configuration the push used — a test that
runs on windows and mac on central and was pushed to linux — the rate is the
whole-test one and the output says so, because the per-configuration comparison
had nothing to compare and the verdict sentence above it is then about an empty
population.

The same-message distinction matters and is what the `Pre-existing:` line rests
on: a test that already fails on central 8% of the time, but with a *different*
message than the one in your push, is not pre-existing in any useful sense.
Sections report same-message rates alongside overall rates.

A push failure's message comes from the `TestStatus` markers logged inside the
test's execution, not from the `Test` marker, which carries no `message` field
at all for a plain assertion failure (`old/try.html:936`). Reading only the latter
leaves most `FAIL`s message-less, and a failure with no message cannot be
compared against central at all — the output says so rather than printing a
`0.0%` that reads as "a different failure".

**Jobs killed for running too long are reported as such.** A job that exceeds
its `maxRunTime` is killed before the profiler writes its profile, so what its
artifact holds is whatever had been *streamed* out so far — newline-delimited
JSON, one document per thread and per chunk, rather than the single object a
finished job uploads. Reading that format is out of scope; the command detects
it by shape and says what happened:

```
warning: 66 of 160 jobs were killed for exceeding their maximum duration, so
only a streamed profile exists for them and this tool does not read that
format; failures in those jobs are not in this report
```

Kept separate from the count of profiles that genuinely could not be read,
because they are two different things to go and do about: one sends you to the
job's duration, the other to a broken download. Neither is a data-generation
bug.

`--json` shape: `{ revision, pushId, jobCount, failedJobCount, profilesRead,
readPassingJobs, passingTestJobCount, unblamedJobCount, otherFailedJobs[],
permaFails[], knownIntermittents[], newIntermittents[] }`. Each failure carries
`failureCount` — the failing executions the sections are ordered by —
`permaFailingConfigs[]` — the configurations it failed every run of — and
`central.sameMessageFailCountOnPermaConfigs`, the same-message count restricted
to those, which is `null` when central attributed no runs to them.

`central` also carries `headline` — `{rate, runs, scope, jobName?, recent?,
days?, lowConfidence?}`, the value `try.html`'s flakiness column shows —
`explanation`, the text lines that say which measurement produced it, and
`configsInHistory`, how many of the push's configurations central has any history
for. `central.failRate` is retained beside them as the whole-test, all-platform
rate; read `headline.rate` for the comparison against this push.

### `fx-tests task <taskId>` — what happened in one job

`fx-tests try` narrowed to a single task: same per-test outcomes, same row
shape, without the perma-fail verdict, the central comparison or the
per-configuration aggregation, each of which is a claim about several
configurations. It reports every outcome the profile recorded — the failures by
default, and `--passed` adds the rest. Run `fx-tests task --help` for the flags.

Its source is the job's `public/test_info/profile_resource-usage.json`, parsed by
the same `parseTestMarkers()` (`lib/model/test-markers.ts`) that `try` uses —
the URL `try --profiles` and `test --profiles` have printed all along.
`<taskId>.<retryId>` is accepted with `.0` implied, as `crash` accepts it.

**The header's three counts are independent; none is derivable from another.**

| Count | Is | Is **not** |
| --- | --- | --- |
| `tests` | distinct test paths | — |
| `executions` | `Test` markers, after path normalization | `tests` + reruns |
| `rerunCount` | markers inside the harness's retry phase | `executions - tests` |

A test listed in two manifests executes twice under one path, since
`normalizeTestPath` strips the `manifest.toml:` prefix that told them apart, so
`executions - tests` overstates the reruns — 325 against 7 on one measured job.
`Outcomes, counted per test` likewise does not partition `tests`: a test that
failed and was then rescued on rerun counts under both `FAIL` and `PASS`.

**Exit codes**, beyond the table at the end of this file:

| | |
| --- | --- |
| missing profile (expired, or never uploaded) | **4**, permanent |
| 5xx | **3** |
| task ID Taskcluster will not parse (HTTP 400) | **1** |

The 400 rule is `task`'s alone — a retry loop over a typo never terminates —
and `crash` still reports the same 400 as 3, so the same typo yields different
codes from the two commands. A job killed for exceeding `maxRunTime` uploaded a
partial stream rather than a profile, and is reported as that rather than as an
unreadable download.

`--json` shape: `{ taskId, retryId, jobName, project, revision, treeherderUrl,
profileUrl, testCount, executionCount, rerunCount, statusCounts, failures[],
passed[] }`. The four identity fields are `null` when the task definition could
not be read; they are header presentation and cost no rows. Each failure carries
`path`, `failureCount` (what rows are ranked on), `executionCount`, `statuses[]`
(failing only), `passedOnRerun`, `parallelOnly`, `messages[]`, `allMessages[]`,
`testProfiles[]` — absolute URLs, which the text output shortens to filenames.

### `fx-tests issues` — what is failing right now, across the tree

The triage view, and **it leads with components rather than tests** — the same
question `issues.html` answers, which hardcodes the components view
(`old/issues.html:888`) and ranks it by issue count (`:663`). Triage starts by
finding the area worth looking at; a flat per-test list makes the reader do
that aggregation themselves.

```
$ fx-tests issues --limit 5

xpcshell issues by component — 21 days (2026-07-14 (Tue) … 2026-08-03 (Mon)), 4,838 tests in the file
  Counting fail, timeout, crash, skip as issues (all four, as issues.html does; --type narrows it).

  Component                              issues ▼    tests       runs    fail  timeout  crash     skip   rate
  WebExtensions :: General                584,427  393/396  6,131,520  10,158   16,460  5,273  552,536   8.7%
  Core :: Networking                      465,363  628/677  7,560,251  16,705   14,697    283  433,678   5.8%
  Firefox :: Search                       161,929  111/120    590,210      62    1,041    531  160,295  21.6%
  …
```

The `tests` column is "with issues / in the component", as the page's "(393
tests with issues, out of 402)" — 393 of 396 is a component in trouble, 3 of
396 is three bad tests, and one number cannot tell them apart.

**An "issue" is a union of four outcomes, all counted by default.** The page has
four "Count as issues" checkboxes — failures, timeouts, crashes and skips — and
every one of them is checked on load (`:626-638`). `--type` narrows that union,
and because it feeds the count rather than merely filtering rows, narrowing it
reorders the ranking. Skips dominate this data, so `--type fail,timeout,crash`
is a substantially different view.

Options: `--component <substring>`, `--path <prefix>` (directory subtree),
`--type <fail|timeout|crash|skip>` (repeatable, default all four),
`--min-rate <pct>`, `--sort <issues|rate|count|name>` (default `issues`),
`--group-by <component|test|directory|message>` (default `component`).

`--group-by test` is the per-test list, ranked by the same issue count.
`--group-by message` is the "one bug, many tests" view: a single harness
change or infra fault often shows up as the same message across dozens of
tests, and grouping by message makes that one line instead of thirty.

`fx-tests intermittent` ranks the bugs sheriffs annotated failing jobs with
rather than the issues counted here — see §`fx-tests guide`'s
`annotations-are-not-failures`, which `issues --help` also points at.

`--sort count` ranks on fail+timeout+crash+skip — every outcome, not just the
`--type` union, which is what makes it different from `--sort issues`. It means
the same thing at both levels; a version that counted skips per test and not per
component ranked by a different quantity depending on `--group-by`. Because that
sum is not one of the displayed columns, the sorted-column marker is omitted for
it rather than pointed at a column the rows are not ordered by.

### `fx-tests failures` / `fx-tests crashes` — group by message / signature

`failures` groups failing runs by message; `crashes` groups by crash signature
and can print minidump IDs (`--minidumps`), which `fx-tests crash` then reads.
Both accept `--limit`, `--path`, `--component`, `--config`, `--day`.

#### Which tests, not just how many

`failures --message <substring>` answers "which tests emit this message", and the
`tests` column alone does not: knowing 204 tests share a message does not say
*which*, and whether they are contiguous in one manifest — the shape of a
contamination chain — is not decidable from the count.

So the tests are listed under the table, automatically once the table is three
rows or fewer and on `--tests` above that. Three is the threshold `errors` uses
and for the same reason: at twenty rows the per-row list is noise, and
`--message` normally narrows to one row anyway, so a caller who has never heard
of `--tests` still gets the answer. Paths print whole — the block exists because
the table could not carry them.

The failure is named by a **substring of its message**, not by a row index. That
is how `--message` already works, and it survives the 21-day window moving
between the query that ranked a message and the one that drills into it — an
index is only meaningful against the rendering that printed it.

**`--json` never truncates the list.** Text caps at 50 with a `… n more` line;
JSON emits every test and reports `testsTruncated: false` beside `testCount`, so
the array is never silently shorter than the count next to it. It used to stop at
50 while reporting `testCount: 204`, with no marker and no way to lift it, which
cost one investigation six tests — two of them inside the block that was the
point of the query. Lifting the cap was measured first: tree-wide and uncapped is
3,377 test rows over 2,409 mochitest groups against 3,070 capped, with 4 groups
affected at all, so the cap was buying about 10% of one payload against being
wrong. `testsTruncated` is always present, never absent-when-false, on the same
reasoning that keeps `taskIds` unconditional.

**Measured caveat, and it changes where `--minidumps` works.** Both commands
read `{harness}-issues.json`, whose `CRASH` groups carry `counts`, `days` and
`crashSignatureIds` and **no `minidumps` field at all** — 0 of 676 groups in one
file. So `--minidumps` cannot be answered there and is a usage error rather than
an empty section, and the same file's inability to name a job makes `--config` a
usage error too. The bucket files *do* carry structured `minidumps` arrays, so
the dump IDs come from `fx-tests test <path> --task-ids`, which prints each one
as the `fx-tests crash` invocation that reads it.

### `fx-tests crash <task-id> <minidump-id>` — read a processed crash dump

Prints a symbolized report from a job's minidump-stackwalk JSON: signature,
crash reason, faulting address, and thread stacks.

The point is token cost. The raw stackwalk JSON is large and deeply nested; an
agent that fetches and interprets it inline spends a great deal of context
re-deriving what `crash-viewer.html` already knows how to do.

```
$ fx-tests crash YJJe4a0CRIqbAmcCo8n63w 12345678-abcd-1234-abcd-1234567890ab

Crash @ mozilla::dom::Selection::AddRangeAndSelectFramesAndNotifyListeners
  Type:    EXCEPTION_ACCESS_VIOLATION_READ
  Address: 0x0000000000000018  ** null pointer with offset 0x18
  Instruction: mov rax, qword [rcx+0x18]

Crashing thread #12 (Main Thread)
   0  xul.dll!mozilla::dom::Selection::AddRangeAndSelectFrames…  selection.cpp:1284
   1  xul.dll!mozilla::dom::Selection::AddRangeJS                selection.cpp:1150
   2  xul.dll!mozilla::dom::Selection_Binding::addRange          SelectionBinding.cpp:412
   …

7 other threads (--all-threads to show, --thread <n> for one)
```

The signature is computed the way `old/crash-viewer.html:520` computes it —
skipping abort/assertion frames to find the first meaningful one, and stripping
parameter lists. Reimplementing that heuristic in a prompt would get it subtly
wrong.

#### Hangs, not just crashes

A minidump is also how a **hung** process is diagnosed, and that inverts the
default output. For a crash, one thread matters and deep frames help. For a
deadlock, the question is which threads are blocked on each other, so breadth
beats depth: `--all-threads` with a shallower default.

`--all-threads` therefore uses `--frames 8`, not 20. Twenty frames × 40 threads
is thousands of lines of mostly-irrelevant stack, which is the opposite of this
command's purpose. The single-thread default stays deeper (20), since there the
frames are the answer. Both are overridable.

```
$ fx-tests crash <task-id> <minidump-id> --all-threads

41 threads. Blocked on a lock: #0, #7, #12  (see ** markers)

 #0  Main Thread                                          ** blocked
   0  ntdll.dll!NtWaitForAlertByThreadId
   1  mozilla::detail::MutexImpl::lock                     mutex.cpp:82
   …
```

Options: `--all-threads`, `--thread <n>`, `--frames <n>` (default 20, or 8 with
`--all-threads`), `--raw` (unprocessed JSON).

The retry is part of the task ID, not a separate flag: pass
`<taskId>.<retryId>`, with `.0` implied when omitted. That is already the
convention in the data files — the `taskIds` table stores `"<id>.<retry>"`, and
the resource-usage files omit `.0` exactly this way (`JSON_FORMAT.md`) — so a
task ID copied from any other command or file works unchanged.

Both arguments are required. A minidump ID comes from wherever the crash was
found — in practice `fx-tests test <path> --task-ids`, which reads a bucket file
and emits the whole invocation ready to paste; `fx-tests crashes --minidumps`
serves the same purpose on a file family that records them. Making the argument
optional would mean fetching the task's artifact listing to guess — a round trip
to solve a problem the caller does not have.

Not every crash has a dump: a crash whose minidump was never uploaded is still a
crash, and those rows carry no ID rather than a placeholder that looks
fetchable.

### `fx-tests manifests` — which manifests run where, and for how long

Reads `manifests.json` from the `manifest-timings` index. The question this
answers: a job is timing out — **which manifest is eating the budget**, and on
which configs is it worst?

It does *not* say why a manifest is slow: the file has per-manifest durations,
not per-test ones, so "one slow test or a thousand cheap ones" is a follow-up
question for `fx-tests test --durations` on the tests in that manifest. The
division of labour is worth stating because it is easy to expect more from this
data than it holds — the manifest view narrows the search to a manifest and a
config, and the per-test view explains it.

```
$ fx-tests manifests --job linux1804-64/debug-xpcshell --limit 5

Manifest                                            runs  median    p95    max
  toolkit/components/extensions/test/xpcshell/…      164   8m 12s  11m 4s  14m 2s
  dom/indexedDB/test/unit/xpcshell.toml              164   4m 30s   5m 1s   6m 12s
  netwerk/test/unit/xpcshell.toml                    164   3m 58s   4m 20s  5m 3s
  …

$ fx-tests manifests dom/indexedDB/test/unit/xpcshell.toml

dom/indexedDB/test/unit/xpcshell.toml
  Runs on 18 configs, 3 platforms: linux (10), windows (5), macos (3)
  Skipped on: test-android-em-7-0-x86_64/debug-xpcshell (4 configs)

Configuration                              runs   median      p95      max
  test-linux1804-64/debug-xpcshell          164   4m 30s    5m 1s   6m 12s
  test-windows11-64-24h2/debug-xpcshell      82   6m 12s    7m 8s   9m 30s
  …
```

A manifest whose durations are all zero on a config was skipped there rather
than run instantly (`old/manifests.html:415`), which is how the platform and
"skipped on" lines are derived — and a distinction easy to get wrong when
reading the raw file.

Options: `--job <list>` / `--config <list>`, `--platform <list>`,
`--sort <median|p95|max|runs|name>`, `--slower-than <duration>`, `--limit`.

### `fx-tests errors` — errors and warnings in test logs

Reads `{harness}-{date}-errors.json`. **These files are per-date only**; there
is no multi-day errors aggregate, so every invocation is scoped to one day
(`--day`, defaulting to the most recent available).

This command defaults to **`--harness mochitest`**, unlike the rest of the CLI,
which defaults to xpcshell — and the reason is a property of the data, not just
its size.

xpcshell runs its tests in parallel, so their stdout cannot be emitted as it is
produced; it is replayed only when a test fails. The xpcshell errors file is
therefore effectively **limited to the output of failing tests**, which defeats
the purpose of asking "what is noisy in CI": it is not a smaller sample of the
same population, it is a biased one, missing everything the passing majority
prints. Mochitest has no such restriction, so its file is the one that answers
the question.

The volume difference follows from this: on Thursday 2026-07-30, mochitest
recorded 103.2M markers across 31,047 jobs against xpcshell's 339K across 1,434.

Pick a weekday when quoting or comparing these numbers. Push volume drops
several-fold at weekends — the same two files for Sunday 2026-08-02 show 38.2M
and 134K, about a third of the Thursday figures — so a weekend day understates
everything and is a poor baseline for "is this normal?".

`--harness xpcshell` still works, and is meaningful for the narrower question
"what did this failing xpcshell test print?" — just not for measuring overall
noise.

One practical consequence: the mochitest errors file is large — ~97 MB for that
Thursday, vs ~570 KB for xpcshell. It is worth caching, and worth having
`--limit` default to something small.

Marker kinds come from the file itself (`tables.markerNames`) and vary by
harness and build: `C++ warning`, `C++ assertion`, `JavaScript error`,
`JavaScript warning`, `console.error`, `console.warn`, and — on instrumented
builds — `TSan Error`. Do not hardcode the list; read it from the file.

#### Ranking noise (the dominant use case)

The main reason to run this: an agent tasked with reducing CI log noise needs to
know what the loudest offenders are, since a handful of messages account for
most of the volume.

```
$ fx-tests errors --kind "C++ warning" --limit 3

mochitest, 2026-07-30 — 31,047 jobs, 103,186,014 markers
  C++ warning 75,901,067 · JS error 13,218,657 · console.error 7,441,599
  JS warning 3,537,720 · console.warn 3,060,974 · C++ assertion 25,948 · TSan 49

 occurrences  tests  message
  16,944,808  4,827  'NS_FAILED(rv)'
                     xpcom/threads/nsThreadUtils.cpp:237
   5,590,810  7,894  Frames were in different child lists???
                     layout/base/nsLayoutUtils.cpp:1300
   5,183,224  9,367  NS_ENSURE_TRUE(entry && entry->mInfo->mSharedState.Get()…
                     docshell/shistory/SessionHistoryEntry.cpp:1106
```

Real numbers from that date's file. The shape of the problem is visible in the
first row: one warning accounts for 16.9M of 103.2M markers, and the top three
for over a quarter — which is why ranking is the useful default view.

The per-kind totals on the second line come from `metadata.markerCounts`, so
"how noisy is this harness today, and in which category" costs one file read.

#### Is this error specific to one test, or everywhere?

The `tests` column is the discriminator, and it is available because marker
groups are keyed by (test, message). A message in 119 tests is background noise;
one in a single test is a candidate cause.

```
$ fx-tests errors --message "NS_ERROR_MALFORMED_URI"

"NS_ERROR_MALFORMED_URI: Couldn't build a valid uri"
  JavaScript error · resource://gre/modules/URIFixup.sys.mjs:450
  6,504 occurrences in 1 test  — specific to this test, not ambient noise
    6,504  netwerk/test/unit/test_URIFixup.js
```

#### Was the error there when the test was passing?

Answer this by **comparing days**, not within a day: run the command for a date
when the test was passing and for one when it was failing, and compare. Use
`fx-tests test <path> --history` to find those dates.

```
$ fx-tests errors --test netwerk/test/unit/test_bug1195415.js --day 2026-07-28
$ fx-tests errors --test netwerk/test/unit/test_bug1195415.js --day 2026-07-30
```

Compare like with like: two weekdays, as above. Pairing a weekday against a
weekend day makes the occurrence counts differ for reasons that have nothing to
do with the test.

A single-day errors file cannot answer it directly: it has no day axis, and it
records which *task* each occurrence came from but not whether that task's run
of the test passed. Correlating error-to-outcome within one file would mean
joining against the timing data for the same date — possible, but it is not
what the errors file gives you, so the CLI does not pretend otherwise.

Options: `--message <substring>`, `--kind <name>`, `--test <path>`,
`--component <substring>`, `--file <substring>`, `--day <date>`,
`--group-by <message|location|test|component|kind>`,
`--sort <occurrences|tests>`, `--task-ids`, `--limit` (default 20).

Grouping is by source location (file + line) as well as message text, following
`errors.html`'s change to group by location rather than message alone — the same
message from two different files is two different problems.

### `fx-tests intermittent` — the sheriff-annotated top offenders

Queries Treeherder's intermittent-failures endpoints live — the data behind
<https://treeherder.mozilla.org/intermittent-failures/> — and answers a question
no other view can: *give me the top N most annoying mochitest (or xpcshell)
intermittents, tree-wide.* Every other command is scoped by path, component or
push, and reads a nightly aggregate rather than these live annotations.

A row is one bug a **sheriff** attached to failing jobs. That is a human
judgement rather than a computed rate, which is what makes it assignable — the
bug number is right there — and what makes it a poor proxy for "what fails most":
a failure nobody triaged has no row at all. Use `issues` and `flaky` for the
aggregates' view.

```
$ fx-tests intermittent --harness mochitest --limit 5

Sheriff-annotated mochitest intermittents on trunk, 2026-08-12 to 2026-08-18

All 731 annotated bugs, ranked by count: 277 name a mochitest test, 46 an xpcshell test, and 408 name no test this tool knows.
A bug is placed by the test path in its summary, checked against the published test lists. --harness mochitest, xpcshell or unknown ranks one group.
Excluded: 1,319 annotations with no bug attached, which carry no summary to read a test path from.

count = jobs sheriffs annotated with this bug.

  count ▼      bug  test                                                                        failure
      435  1980036  browser/components/tabbrowser/test/browser/tabs/browser_tab_preview.js      single tracking bug
      354  2063231  browser/base/content/test/performance/browser_startup_flicker.js            unexpected changed rect: ({x1:0, x2:1279, y1:86, y2:89, w:1…
      302  2062444  browser/components/sidebar/tests/browser/browser_opentabs_hover_preview.js  single tracking bug
      165  2019094  toolkit/content/tests/browser/browser_findbar_marks.js                      single tracking bug
      156  2038933  browser/components/sidebar/tests/browser/browser_syncedtabs_sidebar.js      single tracking bug
  … 272 more (--limit 0 for all)
  (a further 46 named an xpcshell test; --harness xpcshell ranks those)
```

Options: `--tree <name>` (a repository, a repo group — `trunk`,
`firefox-releases`, `comm-releases` — or `all`; default `trunk`), `--bug <id>`,
`--harness <mochitest|xpcshell|unknown>`, `--test <path>`, `--history`,
`--profiles`. Omit `--harness` for every bug; `--since <n>` / `--day <date>` set the window, default 7 days.

The test path is a real path, so it pastes straight into `fx-tests test <path>`,
which is where you dig into one of these failures.

#### A bug is classified by the test its summary names

`/api/failures/` has **no harness parameter** — `startday`, `endday`, `tree` and
`bug` are the whole vocabulary — so `--harness mochitest` cannot be a query
parameter, and it is not derived from the job either. A bug counts as a mochitest
bug when **its summary names a test path that the mochitest data holds**: the
same published test lists `fx-tests test` resolves a name against.

That is a fact about a published list rather than an inference. The alternative —
reading Treeherder's `test_suite` — describes the *job* that ran, not the test
that failed, and it presents an infrastructure bug that fires across every job as
a mochitest intermittent. It also misreads the string: `test_suite` is computed
by subtracting the platform and build type out of the job name, so an ASAN
mochitest arrives as `opt-mochitest-chrome-1proc-4` and an Android one as
`geckoview-mochitest-plain-3`.

Extraction alone is not enough either, which is why the path is checked rather
than trusted: summaries name the xpcshell harness script, wpt tests, reftest
files and crash source locations, and none of those is a test this tool holds.

**A bug naming no verifiable test is `unknown`** — an infrastructure failure, a
suite this tool does not read, or a summary that never named a path. That is a
third value of the classification, not an error, so it sits on the same axis as
the two harnesses:

| | ranks |
| --- | --- |
| no `--harness` | every annotated bug, the three groups interleaved by count |
| `--harness mochitest` | bugs naming a verified mochitest test |
| `--harness xpcshell` | bugs naming a verified xpcshell test |
| `--harness unknown` | bugs naming no test this tool knows |

The unfiltered list is the honest default: the tool ranks what sheriffs
annotated, and the harness is an attribute of a row rather than a precondition
for appearing. An `[taskcluster:error]` bug outranking every real test failure is
a fact about the window, so it appears — with an empty `test` cell, since it has
no path to show, and its message under `failure` where the other rows' messages
are.

#### What it costs, and why the ranking is complete

**Every annotated bug in the window is classified.** There is no depth flag,
because there is nothing per-bug to economise on: the whole ranked list is one
`/api/failures/` request, a batch of Bugzilla summaries per hundred bugs, and two
`{harness}-issues.json` reads — the same files `issues`, `failures`, `crashes`,
`skips` and `flaky` already read. Measured on a live `trunk` week, the default is
**11 requests and under 7 s cold**, and effectively instant warm.

Per-test bucket files are deliberately not read: they are 3.5 MB each and would
make the cost scale with the number of bugs examined, when the question here is
only "is this path a test of this harness". Drilling into one test is what
`fx-tests test <path>` is for.

The header states how many bugs matched, how many named the other harness's test,
and how many named no test this tool knows. That last group is **counted but not
listed** — it is a diagnostic about classification rather than an answer about
this harness, and it is larger than the ranking. `--harness unknown` ranks it.

`--limit` is display only. It does **not** bound the scan — tying the two
together would make `--limit 1` classify one candidate, leaving `--json --limit 1`
a prefix with no fuller answer to ask for — and `--json` always carries every
row of the selection.

#### `--bug <id>` — one bug's occurrences

```
$ fx-tests intermittent --bug 1829935 --since 14

Bug #: 1829935
Summary: Frequent netwerk/test/browser/browser_103_cleanup.js | single tracking bug
106 sheriff annotations on trunk, 2026-08-25 to 2026-09-07

Failure messages, per annotated job
    106x  finished in <n>ms
    106x  test_103_cancel_parent_connect - "" == "parent-connect-timeout"
      4x  test_xpcom_graph_wait - AfterRunBackgroundTaskNamed: should have no unexpected …
  … 4 more (--limit 0 for all)

Job names, chunk numbers merged
     87x  mochitest-browser-chrome
     19x  mochitest-browser-chrome-no-nv

Platforms
     88x  macosx1500-aarch64
     18x  macosx1500-aarch64-shippable

Build types
     99x  opt
      7x  debug
```

Failure messages first — what the annotated jobs printed, where the four axes
below are guessable — then job names, platforms, build types, trees and tests,
then the occurrence rows with their task IDs.

`Summary:` is keyed on its own line because it is the Bugzilla summary, which is
regularly **not** the failure annotated today: on bug 2036743 it named service
CIDs from another repository while every annotated job carried a different one.
What is failing now is in `Failure messages`.

**Chunk numbers are merged.** `mochitest-browser-chrome-1` through `-12` are one
configuration run twelve ways, so grouping the raw values answers "where does
this bug fail" with twelve rows of noise. Variant suffixes are not chunks and
survive, because `-no-nv` really is a different configuration. The raw
per-occurrence values are in `--json`.

**Every tally is per annotated job, not per log line**: a job emits
`TEST-UNEXPECTED-FAIL` once per failing assertion, so counting lines reported one
test path 2,486 times against 140 occurrences.

##### Filtering one bug

`--harness` and `--config` both narrow the drill-down, and compose:

```
$ fx-tests intermittent --bug 1829935 --since 14 --config debug

Bug #: 1829935
Summary: Frequent netwerk/test/browser/browser_103_cleanup.js | single tracking bug
7 of 106 sheriff annotations match the filter on trunk, 2026-08-25 to 2026-09-07

Failure messages, per annotated job
      7x  finished in <n>ms
      7x  test_103_cancel_parent_connect - "" == "parent-connect-timeout"

Job names, chunk numbers merged
      7x  mochitest-browser-chrome

Platforms
      7x  macosx1500-aarch64

Build types
      7x  debug
```

`--config` matches a substring of `<platform>/<buildType>`, the same way
`fx-tests test --config` matches a job name — so `macosx1500-aarch64`, `debug`
and `macosx1500-aarch64/debug` all work.

Two properties worth relying on. **The header states the filter's effect** —
`7 of 106`, not a bare `7` — because a smaller number on its own is
indistinguishable from the bug having got quieter. And **every section comes from
the same filtered population**: the counts in Job names, Platforms, Build types
and Trees all sum to the header's figure, so no table disagrees with the total
above it. A filter that matches nothing is exit 2 saying so, rather than an empty
report.

`--harness` here reads each occurrence's own job name, which is a different
question from the ranked list's: there, a bug is classified by the test its
summary names, because a bug spans many jobs; here the row itself says what ran.

`--config` is **refused on the ranked list**, where the rows are bugs and a bug
spans every configuration it was annotated on. The refusal points at `--bug`.

##### `--bug`/`--test` provenance, and what the fields mean

`--help` describes the flags; this is only what it cannot carry.

| field | meaning |
| --- | --- |
| task id column | `<taskId>.<runId>`, as `test --task-ids` prints it. The run is **not** always 0: a task retried after an `exception` has its annotated failure in a later run, so a URL built from `runs/0` 404s. Resolved from `job_id` via `/api/jobs/`, batched at `JOB_BATCH_SIZE` (so `ceil(occurrences / 200)` extra requests, not one); if that fails the report still prints, warned, with bare task IDs. |
| `Profiles` row | `<taskId>.<runId>  <platform>/<buildType> <suite>`. The three fields as Treeherder sends them, **not** spliced into a `job_type_name`: it mis-splits sanitizer builds (`build_type: "asan"`, `test_suite: "opt-mochitest-…"` for a job really named `…-asan/opt-mochitest-…`), so a splice would be a string that does not exist for ~5% of occurrences. |
| `Profiles` entries | Only filenames a log line named — never a synthesised one. A test that failed twice uploads a `-2`-suffixed rerun profile *and* a first-run one, but Treeherder keeps the retry's log messages only, so usually just the `-2` name is available; the first is left unlisted rather than guessed by stripping the suffix. A named `-2` file is labelled `rerun`. |
| omitted rows | A profile whose URL cannot be built — run index unresolved, or `task_id` is the sentinel `unknown` — is **not printed**, and a row it empties goes with it. No `runs/0` is ever guessed. If that empties the section, one line names the cause. |
| `--json` `profiles[]` | `{run, taskId, runId, configuration, profiles: [{filename, url, isRerun}]}`. Present without `--profiles`, since it costs no request. `url` is `null` where the text renderer omits the entry; `runId` is `null` when unresolved. |

The `profile uploaded in …` notices are partitioned out of **every** tally, so
they appear neither under `Failure messages` nor under `Tests named`. They are
not failures and not tests; they are the input to `Profiles`. Note that a path
field is not always a test name — `leakcheck` is a real failure whose message is
a leak report, and it keeps its row.

#### `--test <path>` — the bug for a failing test

Someone starting from a red test does not have a bug number. `--test` takes the
exact test path and drills into the bug whose summary names it, using the same
ranking `intermittent` already builds:

```
$ fx-tests intermittent --test browser/components/sidebar/tests/browser/browser_resize_sidebar.js

Bug #: 2063582
Summary: Intermittent browser/…/browser_resize_sidebar.js | single tracking bug
221 sheriff annotations on trunk, 2026-08-21 to 2026-09-03
…
```

**An exact path only** — not a directory prefix, unlike `errors --test`: a prefix
matching several tests has no single bug to drill into. When several bugs name
one test, all of them are listed with their counts rather than one being chosen
for you. When none does, exit 2 says so.

It is `--test` and not `--path` for the reason the rest of the CLI splits them:
`--path <prefix>` filters many tests on `issues`, `failures`, `crashes`, `skips`
and `flaky`, while `--test <path>` selects one test on `try` and `errors`. This
selects one, so it is `--test`.

#### `--profiles` — the Gecko profile of each failing job

Every occurrence's log lines carry the artifact name of the per-test profile the
harness uploaded, and the occurrence carries the task ID and run, so the URL is a
composition of data already in hand — **no extra request**:

```
$ fx-tests intermittent --bug 2063582 --profiles

…
Profiles (raw artifact URLs, for profiler-cli)
  c68SpT41QyiHK2XwZUcNtg.0  mochitest-browser-chrome-no-nv-5
    first run: https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/c68SpT41QyiHK2XwZUcNtg/runs/0/artifacts/public/test_info/profile_browser_resize_sidebar.js.json
    rerun:     https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/c68SpT41QyiHK2XwZUcNtg/runs/0/artifacts/public/test_info/profile_browser_resize_sidebar-2.js.json
  (first run: not named in the log — Treeherder keeps the retry’s messages only — but uploaded alongside the rerun)
```

Raw artifact URLs, for `profiler-cli`, in the shape `fx-tests test --profiles`
uses. **Both uploads of a task that failed twice are emitted.** The harness
reruns a failing test and uploads a second, `-2`-suffixed profile, but
Treeherder's log parser keeps the messages of the retry only — on bug 2063582,
198 of 221 occurrences named only the `-2` profile — so the first run's URL is
derived from the `-2` name and labelled `first run`. Comparing the two is what
the pair is for: dropping either loses the evidence that the test passed on the
rerun, or did not.

`--profiles` is refused on the ranked list, where a row is a bug rather than a
job. `--json` carries the same `profiles` array unconditionally, since it costs
no request and a machine-readable shape should not change with a flag.

##### The profile notice is not a failure message

The `profile uploaded in …` lines are partitioned out before the failure tally,
by the same `partitionMarkerMessages()` `fx-tests try` runs its markers through.
Before that, four of the top eight "failure messages" on bug 2063582 were
artifact metadata. There is no flag to bring them back: the notice is not a
failure, and it is reported in `Profiles` instead.

#### `--json`: the two row shapes

Neither shape is in `--help`, so both are specified here; `--json` always
carries every row of the selection, never a prefix.

**A ranking row** (the default list):

| field | type | what it holds |
| --- | --- | --- |
| `bugId` | number | the Bugzilla number |
| `count` | number | jobs sheriffs annotated with this bug in the window |
| `harness` | `mochitest`\|`xpcshell`\|`unknown` | from the test the summary names |
| `test` | string\|null | the verified test path; `null` on an `unknown` row |
| `failure` | string | the summary with its triage prefix and test path cut out |
| `bugSummary` | string\|null | the whole Bugzilla summary, uncut |

`failure` is what the text table's `failure` column prints; `bugSummary` keeps
the triage prefix and path it strips, which a caller reconstructing a bug
reference needs and would otherwise cost one Bugzilla request per bug.

**An occurrence row** (`--bug`/`--test`, in `occurrenceRows`), one per annotated
job, all of them whatever `--limit` says:

| field | what it holds |
| --- | --- |
| `bugId`, `tree`, `revision`, `pushTime` | which push, on which repository |
| `testSuite` | the raw job suite, **chunk number kept** (the `jobNames` tally merges it) |
| `platform`, `buildType` | `--config` matches `<platform>/<buildType>` |
| `machineName` | the worker that ran the job — `macmini-m4-76` |
| `jobId`, `taskId`, `runId` | `runId` is `null` when unresolved, never a guessed `0` |
| `lines` | the job's `TEST-UNEXPECTED-FAIL` lines, verbatim |

Worker identity is regularly the decisive variable in an intermittent, so
`machineName` is there; there is no `--by-worker` tally, since one field the
caller groups itself is the right weight for an occasional analysis.

```
$ fx-tests intermittent --bug 2036743 --json | jq -r '.occurrenceRows[].machineName' | sort | uniq -c | sort -rn | head
```

The `--bug` response also carries `bugSummary` (**not** the observed failure,
which is in `lines`), plus `history` and `profiles` — both unconditional, since
a machine-readable shape whose fields depend on a flag is what `--json` exists
to avoid.

### `fx-tests summary` — the landing-page numbers

The 7-day topline: flaky test-failure rate, flaky job-failure rate, skip
rate, invalid-job rate, per harness, with the trend against the prior period.
Cheap: reads only the small `*-stats.json`.

```
$ fx-tests summary

xpcshell   (7d ending 2026-08-02)          vs prior 7d
  test failure rate      0.42%                 -0.08
  job failure rate       3.10%                 +0.20
  skip rate              2.41%                 =
  invalid job rate       0.71%                 -0.05
```

### `fx-tests skips` — what is disabled and where

Skipped tests with their `skip-if` conditions — for "what is turned off on
Windows?". `run-if` annotations mean "not applicable on this platform" rather
than "disabled because broken", and are excluded by default;
`--include-run-if` keeps them.

Options: `--component <substring>`, `--path <prefix>`, `--include-run-if`,
`--group-by <test|component|directory>` (default `test`).

`--group-by component` answers "which component disables the most tests". Its
rows carry the group's skipped runs, then `N/M tests` — how many of the group's
tests are skipped at all, out of how many exist — because a component that
disables three tests heavily and one that is switched off wholesale have similar
run totals and want opposite responses. That is the same convention
`issues --group-by component` uses, and the M likewise counts the group's whole
population rather than only the rows shown.

### `fx-tests flaky` — which folder to book a burndown session on

`flaky.html` leads with two charts, because "is the tree getting better?" is a
shape and a page can draw one. This command leads with the other question a
terminal actually gets asked — *where do I spend the afternoon* — and answers it
with a ranked list of directories carrying enough on each row to weigh the work
against the payoff. Naming a folder drills into it:
`fx-tests flaky <folder>` lists that folder's tests, flaky ones first, on the
same classification and window.

```
$ fx-tests flaky --limit 5

xpcshell flaky tests by folder — 21 days (2026-07-15 (Wed) … 2026-08-04 (Tue)), 4,838 tests in the file
  Window: mean per day over the 7 days 2026-07-29 … 2026-08-04.
  Noise filter neutralised 186 tests failing 1 time or fewer in 21 days (--noise 0 disables).

  Folder                                       flaky ▼  flaky%  skip  tests  +subtree
  toolkit/components/extensions/test/xpcshell      187   48.1%   131    389     192.6
  netwerk/test/unit                              126.7   21.8%    77    582
  dom/indexedDB/test/unit                         38.4   29.3%    91    131
  toolkit/mozapps/extensions/test/xpcshell        32.1   21.0%    20    153      37.7
  toolkit/components/telemetry/tests/unit         26.7   62.1%    20     43
  … 245 more (--limit 0 for all)

  Next, for the folder you pick:
    fx-tests flaky toolkit/components/extensions/test/xpcshell     # which tests, flaky ones first
    fx-tests skips --path toolkit/components/extensions/test/xpcshell      # what is already disabled there, and why
```

Options: `--path <prefix>`, `--group-by <list|folder|days|tests>` (default
`list`), `--sort <flaky|share|skips|tests|name>` (default `flaky`), `--noise <n>`
(default 1), `--average-days <n>` (default 7), `--all-days`, `--day <date>`,
`--here-only` (with `--group-by tests`), `--limit` (default 20). A positional
path — `fx-tests flaky <folder>` — is shorthand for `--path <folder> --group-by
tests`.

**The output carries only what varies between two runs.** The header names the
window that produced the table and reports the noise filter when it moved the
numbers; everything else a reader needs once — what "flaky" and "skipped" mean,
why the window is a whole number of weeks, that the flaky and skip columns
overlap — is in `fx-tests flaky --help` and in this section. That preamble was
measured at 13 of the command's 24 lines (955 characters, ~238 tokens) against 4
for the comparable `fx-tests issues`, and the primary consumer here is an agent
paying it on every invocation while needing the explanation at most once.

**Flaky means fail *or* timeout *or* crash.** All three, because timeouts are the
largest of the three in this data — counting only `FAIL` would miss more than
half of it and produce a table that still looks plausible. **Skipped** means
disabled somewhere, with `run-if` exclusions not counted — those mean "not
applicable here" rather than "switched off".

**The columns are chosen for the decision, not for completeness.** `flaky` is the
work (how many test files are flaky *directly in this folder*), `flaky%` is what
separates a rotten folder from two bad files in a healthy one, `skip` is ground
already given up — often the same underlying problem and the cheapest win — and
`tests` gives `flaky%` a visible denominator. `+subtree` appears only on rows
whose subtree holds more than the folder itself, which is 4 rows in 250 on real
data; it is what stops the roll-up needing to be a second table.

Two of those were called `share` and `in tree` and were renamed, because the
names did not carry their meanings and the header block was already eight lines
long — so the fix had to be in the names rather than in a legend. `share` was
read as a share of the *issues* on the row, `flaky/(flaky+skip)`; `flaky%` sits
directly under `flaky` and next to `tests`, which is the ratio it actually is.
`in tree` was read as "is this folder in the tree"; `+subtree` leads with the `+`
that says it is an addition to the number on its left. `--sort share` is
unchanged, because a sort key is an input a script may already have written down
and only the header was unclear.

#### The window is a 7-day average, and neither obvious choice would do

This is the one decision in the command worth reading before trusting a number,
because both of the readings the page offers are wrong for a *ranking*, in
opposite directions.

**Not the whole 21 days.** Over the window, 84% of xpcshell tests have failed at
least once — a test runs on dozens of configurations dozens of times a day, so
that is a fact about the denominator rather than about Firefox. Ranked that way
the top folders read 75%, 92%, 99% and nothing discriminates.

**Not one day either.** Weekend push volume is 2.6× lower, so a single day's
counts are partly a fact about the weekday: measured on the same window,
`netwerk/test/unit` reads 137 flaky on a Tuesday and **76 on a Sunday**, and
`dom/indexedDB/test/unit` moves from 4th to 3rd at more than double the count
between Sunday and Monday. Run on a Monday, a one-day ranking is ranking
Sunday's fraction of the runs.

So the default averages **per-day verdicts over 7 days** — a whole number of
weeks, so the weekday mix cancels, and still a per-day denominator rather than
the window's inflated one. It is the same 7 days `flaky.html`'s headline tiles
average, so the tiles and this ranking agree by construction. The counts are
therefore means and are printed with a decimal where they are fractional
(`126.7`), because "on a typical day, 127 of this folder's tests were flaky" is
what the number means and a bare integer would overstate it.

`--day <date>` and `--all-days` reach the two other readings explicitly, and the
header always names which of the three produced the table. That last part is not
decoration: the same folder reads 48%, 53% and 75% under the three, and
`flaky.html` shipped exactly this bug — tiles showing one day directly above a
table showing 21, with nothing saying so.

`--group-by folder` is the subtree roll-up (the page's tree, flattened — a
terminal cannot be drilled) and `--group-by days` is the trend as a table of
numbers, one row per day with a centred 7-day mean. There is no ASCII chart: see
Non-goals.

`fx-tests intermittent` ranks the bugs sheriffs annotated failing jobs with
rather than the tests counted flaky here — see §`fx-tests guide`'s
`annotations-are-not-failures`, which `flaky --help` also points at.

#### `fx-tests flaky <path>` — the flaky tests in a folder

A ranking's answer is a folder, and the next question is always *which files*.
This is that view, on the same classification **and the same window** as the
ranking above it — so it is a refinement of the row you picked rather than a
second question about the same folder. `fx-tests flaky <path>` is the shorthand;
`--group-by tests --path <path>` is the long form and they emit byte-identical
output.

```
$ fx-tests flaky toolkit/components/telemetry/tests/unit --limit 8

xpcshell flaky tests, by test file — 21 days (2026-07-15 (Wed) … 2026-08-04 (Tue)), 4,838 tests in the file
  Test files under toolkit/components/telemetry/tests/unit and its subfolders.
  Window: the ranking's 7 days 2026-07-29 … 2026-08-04, one verdict per test, flaky if flaky on
  ANY of them — so more tests than the ranking's mean per day (--day, --all-days).

  Test                                                                                   flaky ▼  skipped  failures 21d
  toolkit/components/telemetry/tests/unit/test_TelemetryEnvironment.js                         1        1         2,543
  toolkit/components/telemetry/tests/unit/test_TelemetryEnvironment_search.js                  1        1         2,145
  toolkit/components/telemetry/tests/unit/test_UserInteraction_annotations.js                  1        1            97
  toolkit/components/telemetry/tests/unit/test_SyncPingIntegration.js                          1        1            81
  toolkit/components/telemetry/tests/unit/test_TelemetryClientID_reset.js                      1        1            79
  toolkit/components/telemetry/tests/unit/test_TelemetryControllerShutdown.js                  1        1            78
  toolkit/components/telemetry/tests/unit/test_TelemetrySession_abortedSessionQueued.js        1        1            74
  toolkit/components/telemetry/tests/unit/test_MainPingDisablement.js                          1        1            73
  … 27 more (--limit 0 for all)

  8 of 43 tests here passed everywhere they ran and are not listed. They are still in every count above.

  Next, for a test you pick:
    fx-tests test toolkit/components/telemetry/tests/unit/test_TelemetryEnvironment.js     # every config it ran on, and what it failed with
```

**This is not `fx-tests issues --path <folder> --group-by test`, and the
difference is the reason it exists.** `issues` ranks by issue *runs*, and skips
are runs. On this same folder and window it puts
`test_UserInteraction_annotations.js` at #1 with **6,879 issues, of which 6,782
are skips** — a test this classification calls skipped, not flaky. Ranked that
way a disabled file outranks everything that actually fails, which is the exact
mistake a burndown listing must not make. `issues` is still the right command for
"what does this test fail *with*"; it is the wrong one for "what is flaky here".

**The verdicts are 0 or 1, over the same 7 days the ranking scores.** This is the
derivation `flaky.html` renders its own test rows from
(`flakinessByFolder`): one verdict per test over the window, whose leaves take
exactly two values — measured on the pinned file, 4,807 leaves, two distinct
values in each of `flaky`, `skipped` and `stable`, with `total` always 1. The CLI
reads the same function so the two cannot disagree about whether a test is flaky,
and the header names the window it used. A test is flaky here if it was flaky on
**any** of those days. `--all-days` widens that to the whole 21-day file and
`--day` narrows it to one named day.

**The window used to be one day, and that was a bug rather than a choice.** The
listing passed no window option at all, so it inherited `flakinessByFolder`'s own
default — the most recent day, a default written for the folder table, where a
single day is the right unit. Drilling into a ranked row therefore crossed a
window boundary with nothing saying so: measured on the pinned window for
`toolkit/components/telemetry/tests/unit`, the ranking scores the folder over 7
days and the listing showed **29** flaky tests where **32** were flaky across
those days. Three tests the reader had just been given a count of were absent from
the list of them. The listing now takes the ranking's window, so drilling in is a
refinement of the row rather than a different question.

**The two numbers still differ, and both are correct.** The ranking says `26.7`
for that folder and the listing shows 32 rows, because they are different
quantities over the same 7 days: a *mean per day* of the folder's flaky tests
against a *count of distinct tests* flaky at least once. The listing's number is
always the larger of the two and must not be read as a correction of the ranking's;
the header says so on every run.

The *averaging* stays on the **folder ranking**, where "126.7 of this folder's
tests were flaky on a typical day" is a real quantity over a real population.
Pushing it down onto a single test was a separate mistake: a single test's mean
can only be `{0, 1/7, … 1}`, so it was multiplied back out into day counts and the
table read `7  100.0%  7  7` to say "always fails, always skipped".

**Three columns, because the other three carried nothing.** Measured over every
listed row on the pinned window (2,582 rows): `ran d` had **2 distinct values, 7
on 2,581 of them**; `flaky%` was exactly `100*flaky/ran` on every row, so over a
constant denominator it and `flaky d` were the same column in different units, 8
values each; and `verdict` was `f(flaky>0, skip>0)` on every row. A percentage
needs a population to be a proportion of, and one test is not one — it can only
be 0% or 100%. `flaky%` therefore stays on the folder ranking, where it is a share
of the folder's tests, and is deliberately absent here.

What survives is the path, the two 0/1 verdicts — both, because flaky-versus-
skipped is the whole reason this view exists rather than `issues` — and
`failures`, the failing *run* count over the file's whole window. That last is the
only column with real resolution (272 distinct values, up to 5,200, against 2 for
each verdict), it is what separates "failed twice" from "failed 2,543 times", and
it is what the noise filter is compared against. It is a different unit and window
from the verdicts, so its header names the window.

**The subtree is the default**; `--here-only` restricts to the files directly in
the path. That way round because the folder ranking hands you a directory and its
subdirectories are the same afternoon's work — and because the ranking's
`+subtree` column exists precisely to say "there is more below here", so the
command it points at must be the one that shows it. On real data the two
coincide on 246 of 250 folders; the default is chosen for the 4 where they do
not. `--here-only` needs a path and is refused without one, since with no path
there is nothing for it to exclude.

**Tests that passed everywhere are counted and not listed**, and the footer says
how many. This is the page's rule (`site/flaky-view.ts`'s `isWorthListing`) and it
hides the same rows: measured tree-wide on the pinned window, **2,224 of 4,806**
under the 7-day default, **3,122 of 4,805** under `--day` — two rows in three —
and **707 of 4,807** under `--all-days`, which is the loosest bar and therefore
hides least. Hiding a row never moves a number; the folder row's `tests` counts
the whole population.

`--sort`, `--noise`, `--day` and `--all-days` mean the same thing here as on the
folder ranking. `--average-days` does not apply: this view covers the same days
the ranking averages but does not average them, so a reader who ranks folders on
a 7-day mean and drills in gets one verdict per test over those same 7 days.
`--json` carries the rows, the header — with `scope` reported as `window` rather
than `average`, since nothing here is a mean — `cleanTests` and `consideredTests`.

**The suggested follow-up commands carry the flags needed to reproduce the
context**, which they did not: under `--harness mochitest` the footer offered
`fx-tests flaky <directory>` and `fx-tests skips --path <directory>`, and because
`detectHarness()` classifies on a *filename* a directory falls through to the
xpcshell default — so both silently answered about the wrong harness. `--harness`
is now propagated when it is not the default, along with `--day` and, for
`fx-tests flaky` itself, `--all-days`, `--average-days` and `--noise`. Flags the
target command does not accept are not appended, since `fx-tests` rejects unknown
flags rather than ignoring them.

### `fx-tests guide` — orientation for an agent

Prints the whole tool's model of the data in one go: what each command answers,
what the data cannot tell you, and worked investigation patterns ("a test failed
on Try", "a job is timing out", "reduce log noise"). Modelled on `profiler-cli
guide`, which the `profiler-analysis` skill has agents read in full before
touching a profile.

The reason to have it is that the traps here are not discoverable from `--help`:
that a manifest's all-zero durations mean skipped rather than instant, that
per-test profile URLs require the failure message, that a test's overall failure
rate understates a single-config perma-fail, that the xpcshell errors file only
contains failing tests' output. An agent that reads `guide` first stops
re-deriving those; one that does not will confidently get them wrong.

**It states properties, not snapshots.** This is the constraint that keeps it
worth reading. A first version ran to 242 lines and documented the state of the
deployment on the day it was written — "the errors files exist for only about 5
of the 21 dates", a measured day's zero-duration census, one day's `run-if`
percentage. Those drift, nobody updates them, and a guide whose facts rot is
worse than a shorter one because its whole claim on the reader is to be trusted
first. So:

- State the shape of a fact, not a reading of it. "Errors data covers fewer days
  than the timing data" survives; "about five of twenty-one" does not.
- Where a number must be current, get it at runtime. `fx-tests errors` discovers
  and prints its own window, so the guide points at the command.
- Keep implementation detail only where it changes what the reader does. Which
  JSON file a command opens is internal and is not printed — that fact stays in
  the tables and under `--json`, where it is still asserted.

A test enforces this: the rendered guide may not contain a raw measured count, a
one-day percentage, a file size, or a date census.

The budget is **200 lines**, not `profiler-cli guide`'s ~400. 400 did not bind —
a 242-line version passed it and was still judged too long in review. If a
companion skill is added later, its instruction is one line: run `fx-tests guide`
and read all of it.

**Its factual claims should be test assertions, not prose to remember to update.**
"Review it when caveats change" is the mitigation that always fails. Anything
`guide` asserts that is mechanically checkable — which file a command reads,
`errors` defaults to mochitest, these exit codes mean these things — is covered
by a test that fails when the behaviour and the text diverge. The prose that
remains unverifiable (why a trap matters, how to approach an investigation) is
the part worth writing by hand, and the part the rewrite kept.

### `fx-tests dates` / `fx-tests cache`

`dates` lists the dates for which data exists (from `index.json`) — useful
for checking whether last night's job actually ran. `cache [--clear] [--size]`
inspects the local cache.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | Usage error (bad flag, missing argument, `--json` with `--markdown`). |
| 2 | Not found (no such test, no data for that revision, no such minidump). |
| 3 | Upstream **temporarily** unavailable — CI index unreachable, network failure, 5xx. Retrying may work. |
| 4 | Data **permanently** gone — a Taskcluster artifact that has expired. Retrying will not help. |

The 3/4 split exists so a script can tell "try again in a minute" from "this crash
dump is never coming back". Taskcluster artifacts expire (typically after a year,
sooner for some), so `fx-tests crash` or `fx-tests task` on an old task exits 4 —
the job ran, its artifact is gone — while the same command during a Taskcluster
outage exits 3.

`fx-tests try` exits 0 whether or not it found failures: the failures are the
answer, not an error. Scripts should branch on `--json` output, not the exit
code.

## Non-goals

- **No writes.** The CLI never mutates CI, Bugzilla, or Treeherder.
- **No data generation.** Producing the JSON files is `fetch-test-data.js`'s
  job, in mozilla-central. The CLI is strictly a reader.
- **No chart rendering.** Distributions are reported as summary statistics
  (median/p95/max) rather than plotted.
- **No symbolication.** `fx-tests crash` reads the *already* symbolized
  stackwalk JSON that CI uploads; it does not run minidump-stackwalk.
- **No history beyond 21 days.** Taskcluster retains artifacts for roughly a
  year, so deeper history is *possible* by resolving older index tasks — but no
  dashboard does it, and the CLI matches them. Deliberately deferred, not
  precluded.
- **Not a dashboard replacement.** Visual exploration across thousands of
  tests is what the web pages are good at; this is for targeted questions.

## Command summary

| Command | Reads | Answers |
| --- | --- | --- |
| `test <path>` | 64-bucket file, or daily with `--day` | Is this test failing, where, since when, and where does it run at all? |
| `try <rev>` | Treeherder + 21-day aggregate | Which failures in my push are mine? |
| `task <taskId>` | that job's `profile_resource-usage.json` | What happened in one job: every test outcome its profile recorded. |
| `issues` | `-issues.json` | What is failing across the tree? |
| `failures` / `crashes` | `-issues.json` | Grouped by message / signature. |
| `crash <task-id> <minidump>` | task artifact | What crashed or deadlocked, and where? |
| `manifests [name]` | `manifests.json` | Which manifest is eating a job's time budget? |
| `errors` | `{harness}-{date}-errors.json` | What is loudest in the logs? Is this message ambient or specific? |
| `intermittent` | Treeherder `/failures/` + `/failuresbybug/` + Bugzilla | Which annotated intermittents cost sheriffs the most, tree-wide, and with which bug? |
| `summary` | `-stats.json` | The 7-day topline. |
| `skips` | `-issues.json` | What is disabled, and where? |
| `flaky` | `-issues.json` | Which folder should I book a flakiness-burndown session on? |
| `guide` | — | How do I use this, and what can the data not tell me? |
| `dates` / `cache` | `index.json` / local | Is the data fresh? What is cached? |
